using System.Collections.Concurrent;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Storage.Streams;

namespace Chax;

/// <summary>
/// BLE link layer for Windows, wire-compatible with BleEngine.java on Android. This side is a GATT server only:
/// it advertises the ChaX service and the phones, which always connect to an advertiser whose id they cannot read,
/// come to it. Same chunk layout: [header][data...], header 0x01 START, 0x02 END, 0x40 PING, 0x80 HELLO (4-byte node id).
/// Windows cannot put manufacturer data in a connectable advertisement, hence no node id on the air.
/// </summary>
public sealed class BleEngine
{
    public static readonly Guid Service = Guid.Parse("7c4a0001-5a1e-4b6f-9d3c-c4a8a0e5c4a1");
    public static readonly Guid FrameChar = Guid.Parse("7c4a0002-5a1e-4b6f-9d3c-c4a8a0e5c4a1");

    const int WantMtu = 247;
    const int MaxQueue = 4000;
    const byte HStart = 0x01, HEnd = 0x02, HPing = 0x40, HHello = 0x80;
    static readonly TimeSpan PingEvery = TimeSpan.FromSeconds(8);
    static readonly TimeSpan DeadAfter = TimeSpan.FromSeconds(30);

    public event Action<string>? LinkUp;
    public event Action<string>? LinkDown;
    public event Action<string, byte[]>? Frame;
    /// <summary>Empty string when everything is fine.</summary>
    public event Action<string>? State;

    sealed class Conn
    {
        public required string Id; // the Windows session id of the remote device
        public GattSubscribedClient? Client;
        public string? Link;
        public DateTime LastRx = DateTime.UtcNow;
        public readonly object Gate = new();
        public readonly LinkedList<byte[]> Queue = new();
        public readonly MemoryStream Rx = new();
        public bool Pumping;
    }

    readonly ConcurrentDictionary<string, Conn> _byId = new();
    readonly ConcurrentDictionary<string, Conn> _byLink = new();
    GattServiceProvider? _provider;
    GattLocalCharacteristic? _char;
    byte[] _myId = Array.Empty<byte>();
    System.Threading.Timer? _watchdog;
    bool _running;

    public bool Running => _running;

    static readonly string LogPath = Path.Combine(Path.GetTempPath(), "chax-ble.log");
    static void Log(string m) { try { File.AppendAllText(LogPath, $"{DateTime.Now:HH:mm:ss.fff} {m}{Environment.NewLine}"); } catch { /* diagnostics only */ } }

    /// <summary>What this adapter can do, for the log: peripheral role is what the mesh needs on this side.</summary>
    public static async Task<string> ProbeAsync()
    {
        var a = await BluetoothAdapter.GetDefaultAsync();
        if (a == null) return "aucun adaptateur Bluetooth";
        var radio = await a.GetRadioAsync();
        return $"adaptateur ok, LE={a.IsLowEnergySupported}, rôle périphérique={a.IsPeripheralRoleSupported}, rôle central={a.IsCentralRoleSupported}, radio={radio?.State}";
    }

    /// <summary>Starts advertising. Returns an error message, or null.</summary>
    public async Task<string?> StartAsync(byte[] id)
    {
        if (_running) return null;
        _myId = id;
        var adapter = await BluetoothAdapter.GetDefaultAsync();
        if (adapter == null) return "Bluetooth indisponible sur ce PC";
        if (!adapter.IsLowEnergySupported) return "ce PC n'a pas de Bluetooth basse consommation";
        if (!adapter.IsPeripheralRoleSupported) return "l'adaptateur Bluetooth de ce PC ne peut pas jouer le rôle périphérique : impossible de joindre le mesh";

        var created = await GattServiceProvider.CreateAsync(Service);
        if (created.Error != BluetoothError.Success) return $"service Bluetooth refusé : {created.Error}";
        _provider = created.ServiceProvider;

        var made = await _provider.Service.CreateCharacteristicAsync(FrameChar, new GattLocalCharacteristicParameters
        {
            CharacteristicProperties = GattCharacteristicProperties.WriteWithoutResponse | GattCharacteristicProperties.Write | GattCharacteristicProperties.Notify,
            WriteProtectionLevel = GattProtectionLevel.Plain,
            ReadProtectionLevel = GattProtectionLevel.Plain,
        });
        if (made.Error != BluetoothError.Success) return $"caractéristique Bluetooth refusée : {made.Error}";
        _char = made.Characteristic;
        _char.WriteRequested += OnWrite;
        _char.SubscribedClientsChanged += OnSubscribed;

        _provider.AdvertisementStatusChanged += (_, e) => State?.Invoke(e.Status is GattServiceProviderAdvertisementStatus.Started or GattServiceProviderAdvertisementStatus.Created
            ? "" : e.Status == GattServiceProviderAdvertisementStatus.Aborted ? $"annonce Bluetooth interrompue ({e.Error})" : "");
        _provider.StartAdvertising(new GattServiceProviderAdvertisingParameters { IsConnectable = true, IsDiscoverable = true });

        _running = true;
        _watchdog = new System.Threading.Timer(_ => Watchdog(), null, PingEvery, PingEvery);
        State?.Invoke("");
        return null;
    }

    public void Stop()
    {
        _running = false;
        _watchdog?.Dispose();
        foreach (var c in _byId.Values.ToList()) Drop(c);
        try { _provider?.StopAdvertising(); } catch { /* already stopped */ }
        _provider = null;
        _char = null;
    }

    // ---- server side -------------------------------------------------------------------

    void OnSubscribed(GattLocalCharacteristic sender, object args)
    {
        var now = sender.SubscribedClients.ToDictionary(c => c.Session.DeviceId.Id);
        foreach (var (id, client) in now)
        {
            if (_byId.ContainsKey(id)) continue;
            var c = new Conn { Id = id, Client = client };
            _byId[id] = c;
            SendHello(c);
        }
        foreach (var c in _byId.Values.ToList()) if (!now.ContainsKey(c.Id)) Drop(c);
    }

    async void OnWrite(GattLocalCharacteristic sender, GattWriteRequestedEventArgs args)
    {
        var deferral = args.GetDeferral();
        try
        {
            var req = await args.GetRequestAsync();
            if (req == null) return;
            var data = new byte[req.Value.Length];
            DataReader.FromBuffer(req.Value).ReadBytes(data);
            if (req.Option == GattWriteOption.WriteWithResponse) req.Respond();
            var id = args.Session.DeviceId.Id;
            if (!_byId.TryGetValue(id, out var c))
            {
                // the phone is still connected after we forgot it: take it back, it is subscribed
                // (the subscription can show up a moment after the first write, or not fire an event at all when Windows remembered it)
                GattSubscribedClient? client = null;
                for (int i = 0; i < 6 && client == null; i++)
                {
                    client = sender.SubscribedClients.FirstOrDefault(x => x.Session.DeviceId.Id == id);
                    if (client == null) await Task.Delay(250);
                }
                if (client == null) { Log($"write from a client that is not subscribed {id}"); return; }
                if (_byId.TryGetValue(id, out c)) { ChunkIn(c, data); return; }
                c = new Conn { Id = id, Client = client };
                _byId[id] = c;
                SendHello(c);
            }
            ChunkIn(c, data);
        }
        catch (Exception e)
        {
            State?.Invoke($"écriture Bluetooth : {e.Message}");
        }
        finally
        {
            deferral.Complete();
        }
    }

    // ---- shared plumbing ----------------------------------------------------------------

    void SendHello(Conn c)
    {
        var chunk = new byte[1 + _myId.Length];
        chunk[0] = HHello;
        Array.Copy(_myId, 0, chunk, 1, _myId.Length);
        lock (c.Gate) c.Queue.AddFirst(chunk);
        _ = PumpAsync(c);
    }

    /// <summary>Queues a whole frame for a link. False if the link is unknown or its queue is full.</summary>
    public bool Send(string link, byte[] frame)
    {
        if (!_byLink.TryGetValue(link, out var c)) return false;
        int mtuPayload = c.Client?.MaxNotificationSize ?? 20;
        int payload = Math.Max(1, Math.Min(mtuPayload, WantMtu - 3) - 1);
        lock (c.Gate)
        {
            if (c.Queue.Count > MaxQueue) return false;
            for (int off = 0; off < frame.Length || off == 0; off += payload)
            {
                int n = Math.Min(payload, frame.Length - off);
                var chunk = new byte[n + 1];
                byte h = 0;
                if (off == 0) h |= HStart;
                if (off + n >= frame.Length) h |= HEnd;
                chunk[0] = h;
                Array.Copy(frame, off, chunk, 1, n);
                c.Queue.AddLast(chunk);
                if (frame.Length == 0) break;
            }
        }
        _ = PumpAsync(c);
        return true;
    }

    async Task PumpAsync(Conn c)
    {
        lock (c.Gate)
        {
            if (c.Pumping) return;
            c.Pumping = true;
        }
        try
        {
            while (_running && _byId.ContainsKey(c.Id))
            {
                byte[] chunk;
                lock (c.Gate)
                {
                    if (c.Queue.Count == 0) return;
                    chunk = c.Queue.First!.Value;
                    c.Queue.RemoveFirst();
                }
                var ok = false;
                try
                {
                    var w = new DataWriter();
                    w.WriteBytes(chunk);
                    var op = _char!.NotifyValueAsync(w.DetachBuffer(), c.Client!).AsTask();
                    if (await Task.WhenAny(op, Task.Delay(3000)) != op) { Log($"notify timeout link={c.Link} len={chunk.Length} mtu={c.Client?.MaxNotificationSize}"); }
                    else
                    {
                        var res = op.Result;
                        ok = res.Status == GattCommunicationStatus.Success;
                        if (!ok) Log($"notify status={res.Status} proto={res.ProtocolError} len={chunk.Length} mtu={c.Client?.MaxNotificationSize}");
                    }
                }
                catch (Exception e) { Log($"notify exception {e.Message}"); }
                if (!ok)
                {
                    lock (c.Gate) c.Queue.AddFirst(chunk);
                    await Task.Delay(30);
                }
            }
        }
        finally
        {
            lock (c.Gate) c.Pumping = false;
        }
    }

    void ChunkIn(Conn c, byte[] v)
    {
        if (v.Length == 0) return;
        c.LastRx = DateTime.UtcNow;
        byte h = v[0];
        if (h == HPing) return;
        if ((h & HHello) != 0)
        {
            var link = Convert.ToHexString(v, 1, v.Length - 1).ToLowerInvariant();
            if (c.Link == null && _byLink.TryAdd(link, c))
            {
                Log($"link up {link} mtu={c.Client?.MaxNotificationSize}");
                c.Link = link;
                LinkUp?.Invoke(link);
            }
            else if (c.Link == null) Drop(c); // duplicate connection to a peer we already have
            return;
        }
        if (c.Link == null) return;
        if ((h & HStart) != 0) c.Rx.SetLength(0);
        c.Rx.Write(v, 1, v.Length - 1);
        if ((h & HEnd) != 0)
        {
            var whole = c.Rx.ToArray();
            c.Rx.SetLength(0);
            Frame?.Invoke(c.Link, whole);
        }
    }

    void Watchdog()
    {
        if (!_running) return;
        var now = DateTime.UtcNow;
        foreach (var c in _byId.Values.ToList())
        {
            if (now - c.LastRx > DeadAfter)
            {
                if (c.Link != null) State?.Invoke("liaison perdue");
                Drop(c);
                continue;
            }
            if (c.Link == null) continue;
            lock (c.Gate) if (c.Queue.Count < 4) c.Queue.AddLast(new[] { HPing });
            _ = PumpAsync(c);
        }
    }

    void Drop(Conn c)
    {
        Log($"drop link={c.Link ?? "(no hello)"} idle={(DateTime.UtcNow - c.LastRx).TotalSeconds:F0}s");
        _byId.TryRemove(c.Id, out _);
        if (c.Link != null && _byLink.TryGetValue(c.Link, out var cur) && cur == c)
        {
            _byLink.TryRemove(c.Link, out _);
            LinkDown?.Invoke(c.Link);
        }
    }
}
