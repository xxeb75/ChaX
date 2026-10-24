package app.chax.mesh;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.Manifest;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;

import androidx.core.content.ContextCompat;


import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * BLE link layer for ChaX, owned by the process rather than by an Activity so that it keeps running
 * when the app is swiped away (MeshService keeps the process alive). Every phone is both a GATT server
 * (peripheral) and a GATT client (central): it advertises the ChaX service with a short node id, scans
 * for others, and keeps one connection per pair (the node with the smaller id initiates). Complete frames
 * go to a Sink (the UI plugin or the headless WebView); chunking and reassembly are done here.
 *
 * Chunk layout: [header][data...]. header: 0x01 START, 0x02 END, 0x40 PING, 0x80 HELLO (data = 4-byte node id).
 */
@SuppressLint("MissingPermission")
public class BleEngine {
    /** Receives what happens on the radio. Calls always come on the main thread. */
    public interface Sink {
        void linkUp(String link);
        void linkDown(String link);
        void frame(String link, byte[] data);
        void state(String message);
    }

    private static BleEngine instance;

    public static synchronized BleEngine get(Context ctx) {
        if (instance == null) instance = new BleEngine(ctx.getApplicationContext());
        return instance;
    }

    private final Context ctx;
    private Sink sink;
    private String lastState = "";

    private BleEngine(Context ctx) {
        this.ctx = ctx;
    }

    private static final UUID SERVICE = UUID.fromString("7c4a0001-5a1e-4b6f-9d3c-c4a8a0e5c4a1");
    private static final UUID FRAME_CHAR = UUID.fromString("7c4a0002-5a1e-4b6f-9d3c-c4a8a0e5c4a1");
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final int COMPANY_ID = 0xFFFF;
    private static final int WANT_MTU = 247;
    private static final int MAX_QUEUE = 4000;
    private static final long CONNECT_TIMEOUT_MS = 15000;
    private static final byte H_START = 0x01, H_END = 0x02, H_PING = 0x40, H_HELLO = (byte) 0x80;
    private static final long PING_EVERY_MS = 8000;
    private static final long DEAD_AFTER_MS = 30000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, Conn> byAddress = new HashMap<>();
    private final Map<String, Conn> byLink = new HashMap<>();
    private final Set<String> connecting = new HashSet<>();

    private BluetoothManager manager;
    private BluetoothAdapter adapter;
    private BluetoothGattServer server;
    private BluetoothGattCharacteristic serverChar;
    private BluetoothLeAdvertiser advertiser;
    private BluetoothLeScanner scanner;
    private byte[] myId;
    private boolean running;
    private boolean wanted; // the app asked for the mesh; survives a Bluetooth off/on cycle
    private boolean background;
    private BroadcastReceiver stateReceiver;

    private static class Conn {
        BluetoothDevice device;
        BluetoothGatt gatt; // non-null when we are the central
        BluetoothGattCharacteristic ch; // client-side characteristic
        int mtu = 23;
        boolean ready;
        boolean busy;
        String link;
        long lastRx = System.currentTimeMillis();
        int token; // identifies the write in flight, so a lost callback cannot stall the queue
        final ArrayDeque<byte[]> queue = new ArrayDeque<>();
        final ByteArrayOutputStream rx = new ByteArrayOutputStream();
        boolean central() { return gatt != null; }
    }

    // ---- API ----------------------------------------------------------------------

    /** Routes radio events to `s`, first replaying the links that are already up so it starts in sync. */
    public void setSink(Sink s) {
        main.post(() -> {
            sink = s;
            if (s == null) return;
            for (String link : new ArrayList<>(byLink.keySet())) s.linkUp(link);
            if (!lastState.isEmpty()) s.state(lastState);
        });
    }

    public boolean isRunning() {
        return running;
    }

    public boolean send(String link, byte[] frame) {
        Conn c = byLink.get(link);
        if (c == null) return false;
        // ATT values top out at 512 bytes and a peer may grant more MTU than we asked for: stay at what we requested.
        int payload = Math.max(1, Math.min(c.mtu, WANT_MTU) - 3 - 1);
        synchronized (c.queue) {
            if (c.queue.size() > MAX_QUEUE) return false;
            for (int off = 0; off < frame.length || off == 0; off += payload) {
                int n = Math.min(payload, frame.length - off);
                byte[] chunk = new byte[n + 1];
                byte h = 0;
                if (off == 0) h |= H_START;
                if (off + n >= frame.length) h |= H_END;
                chunk[0] = h;
                System.arraycopy(frame, off, chunk, 1, n);
                c.queue.add(chunk);
                if (frame.length == 0) break;
            }
        }
        main.post(() -> pump(c));
        return true;
    }

    public void setBackground(boolean bg) {
        main.post(() -> {
            background = bg;
            if (running) restartScan();
        });
    }

    public void stop() {
        main.post(this::shutdown);
    }

    /** Starts the radio. Returns an error message, or null. Safe to call again while running. */
    public String start(byte[] id) {
        if (myId == null) myId = id;
        prefs().edit().putBoolean("wanted", true).putString("id", bytesToHex(myId)).apply();
        return begin();
    }

    /** After the process was killed and restarted by the service: bring the radio back if the user had it on. */
    public String resume() {
        if (running) return null;
        SharedPreferences p = prefs();
        String id = p.getString("id", null);
        if (!p.getBoolean("wanted", false) || id == null || !permissionsGranted(ctx)) return "not resumable";
        return start(hexToBytes(id));
    }

    private SharedPreferences prefs() {
        return ctx.getSharedPreferences("chax.engine", Context.MODE_PRIVATE);
    }

    public static boolean permissionsGranted(Context c) {
        String radio = Build.VERSION.SDK_INT >= 31 ? Manifest.permission.BLUETOOTH_SCAN : Manifest.permission.ACCESS_FINE_LOCATION;
        if (ContextCompat.checkSelfPermission(c, radio) != PackageManager.PERMISSION_GRANTED) return false;
        if (Build.VERSION.SDK_INT >= 31) {
            for (String p : new String[] { Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT }) {
                if (ContextCompat.checkSelfPermission(c, p) != PackageManager.PERMISSION_GRANTED) return false;
            }
        }
        return true;
    }

    // ---- lifecycle --------------------------------------------------------------

    private String begin() {
        wanted = true;
        if (running) return null;
        manager = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null) return "Bluetooth indisponible sur cet appareil";
        if (stateReceiver == null) {
            stateReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context c, Intent i) {
                    int st = i.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR);
                    if (st == BluetoothAdapter.STATE_OFF) {
                        main.post(() -> { stopRadio(); emitState("Bluetooth coupé : activez-le pour rejoindre le mesh"); });
                    } else if (st == BluetoothAdapter.STATE_ON && wanted && !running) {
                        main.postDelayed(() -> { if (wanted && !running) startRadio(); }, 500);
                    }
                }
            };
            ctx.registerReceiver(stateReceiver, new IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED));
        }
        if (!adapter.isEnabled()) {
            emitState("Bluetooth coupé : activez-le pour rejoindre le mesh");
            return null; // we will start by ourselves when it comes back
        }
        startRadio();
        startKeepAlive();
        return null;
    }

    private void startRadio() {
        if (running || adapter == null || !adapter.isEnabled()) return;
        running = true;
        openServer(ctx);
        advertise();
        scan();
        emitState("");
        main.postDelayed(watchdog, PING_EVERY_MS);
    }

    /** A link can die silently (peer restarted, out of range without a disconnect callback): ping it, drop it when mute. */
    private final Runnable watchdog = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            long now = System.currentTimeMillis();
            for (Conn c : new ArrayList<>(byAddress.values())) {
                if (c.link == null) {
                    if (now - c.lastRx > DEAD_AFTER_MS) drop(c); // connected but never said hello
                    continue;
                }
                if (now - c.lastRx > DEAD_AFTER_MS) {
                    emitState("liaison perdue, reconnexion");
                    drop(c);
                    continue;
                }
                synchronized (c.queue) { if (c.queue.size() < 4) c.queue.add(new byte[] { H_PING }); }
                pump(c);
            }
            main.postDelayed(this, PING_EVERY_MS);
        }
    };

    /** Foreground service: keeps the process and the WebView alive when the screen goes off. */
    private void startKeepAlive() {
        try {
            ContextCompat.startForegroundService(ctx, new Intent(ctx, MeshService.class));
        } catch (Exception e) {
            emitState("service d'arrière-plan refusé : " + e.getMessage());
        }
    }

    private void stopRadio() {
        running = false;
        main.removeCallbacks(watchdog);
        try { if (scanner != null) scanner.stopScan(scanCb); } catch (Exception ignored) {}
        try { if (advertiser != null) advertiser.stopAdvertising(advCb); } catch (Exception ignored) {}
        for (Conn c : new HashSet<>(byAddress.values())) drop(c);
        connecting.clear();
        try { if (server != null) server.close(); } catch (Exception ignored) {}
        server = null;
    }

    private void restartScan() {
        try { if (scanner != null) scanner.stopScan(scanCb); } catch (Exception ignored) {}
        scan();
    }

    private void shutdown() {
        wanted = false;
        prefs().edit().putBoolean("wanted", false).apply();
        stopRadio();
        try { ctx.stopService(new Intent(ctx, MeshService.class)); } catch (Exception ignored) {}
        if (stateReceiver != null) {
            try { ctx.unregisterReceiver(stateReceiver); } catch (Exception ignored) {}
            stateReceiver = null;
        }
    }

    private void openServer(Context ctx) {
        server = manager.openGattServer(ctx, serverCb);
        BluetoothGattService svc = new BluetoothGattService(SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY);
        serverChar = new BluetoothGattCharacteristic(
            FRAME_CHAR,
            BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE | BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_WRITE
        );
        serverChar.addDescriptor(new BluetoothGattDescriptor(CCCD,
            BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE));
        svc.addCharacteristic(serverChar);
        server.addService(svc);
    }

    private void advertise() {
        advertiser = adapter.getBluetoothLeAdvertiser();
        if (advertiser == null) {
            emitState("advertiser unavailable");
            return;
        }
        AdvertiseSettings s = new AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true)
            .setTimeout(0)
            .build();
        AdvertiseData data = new AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceUuid(new ParcelUuid(SERVICE))
            .build();
        AdvertiseData resp = new AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addManufacturerData(COMPANY_ID, myId)
            .build();
        advertiser.startAdvertising(s, data, resp, advCb);
    }

    private void scan() {
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) {
            emitState("scanner unavailable");
            return;
        }
        ScanFilter f = new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SERVICE)).build();
        ScanSettings s = new ScanSettings.Builder()
            .setScanMode(background ? ScanSettings.SCAN_MODE_BALANCED : ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build();
        scanner.startScan(Collections.singletonList(f), s, scanCb);
    }

    private final AdvertiseCallback advCb = new AdvertiseCallback() {
        @Override public void onStartFailure(int errorCode) { emitState("advertise failed " + errorCode); }
    };

    private final ScanCallback scanCb = new ScanCallback() {
        @Override
        public void onScanResult(int type, ScanResult r) {
            if (!running) return;
            BluetoothDevice d = r.getDevice();
            String addr = d.getAddress();
            if (byAddress.containsKey(addr) || connecting.contains(addr)) return;
            byte[] remote = r.getScanRecord() == null ? null : r.getScanRecord().getManufacturerSpecificData(COMPANY_ID);
            // Smaller id initiates; if the peer id is unknown, connect anyway.
            if (remote != null && remote.length == 4 && compare(myId, remote) > 0) return;
            connectTo(d);
        }
        @Override public void onScanFailed(int errorCode) { emitState("scan failed " + errorCode); }
    };

    // ---- central side -------------------------------------------------------------

    private void connectTo(BluetoothDevice d) {
        String addr = d.getAddress();
        connecting.add(addr);
        Conn c = new Conn();
        c.device = d;
        c.gatt = d.connectGatt(ctx, false, clientCb, BluetoothDevice.TRANSPORT_LE);
        main.postDelayed(() -> {
            if (connecting.contains(addr) && !c.ready) {
                connecting.remove(addr);
                try { c.gatt.close(); } catch (Exception ignored) {}
            }
        }, CONNECT_TIMEOUT_MS);
    }

    private final BluetoothGattCallback clientCb = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            String addr = gatt.getDevice().getAddress();
            android.util.Log.i("ChaxBle", "client state " + newState + " status " + status + " " + addr);
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                main.post(() -> {
                    Conn c = new Conn();
                    c.device = gatt.getDevice();
                    c.gatt = gatt;
                    byAddress.put(addr, c);
                    gatt.requestMtu(WANT_MTU);
                });
            } else {
                connecting.remove(addr);
                main.post(() -> {
                    Conn c = byAddress.get(addr);
                    if (c != null) drop(c);
                    else try { gatt.close(); } catch (Exception ignored) {}
                });
            }
        }

        @Override
        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
            main.post(() -> {
                Conn c = byAddress.get(gatt.getDevice().getAddress());
                if (c != null && status == BluetoothGatt.GATT_SUCCESS) c.mtu = mtu;
                gatt.discoverServices();
            });
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            main.post(() -> {
                Conn c = byAddress.get(gatt.getDevice().getAddress());
                BluetoothGattService svc = gatt.getService(SERVICE);
                if (c == null || svc == null) { if (c != null) drop(c); return; }
                c.ch = svc.getCharacteristic(FRAME_CHAR);
                if (c.ch == null) { drop(c); return; }
                c.ch.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
                gatt.setCharacteristicNotification(c.ch, true);
                BluetoothGattDescriptor cccd = c.ch.getDescriptor(CCCD);
                cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                gatt.writeDescriptor(cccd);
            });
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor d, int status) {
            main.post(() -> {
                Conn c = byAddress.get(gatt.getDevice().getAddress());
                if (c == null) return;
                connecting.remove(gatt.getDevice().getAddress());
                c.ready = true;
                sendHello(c);
            });
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic ch) {
            final byte[] v = ch.getValue();
            main.post(() -> {
                Conn c = byAddress.get(gatt.getDevice().getAddress());
                if (c != null && v != null) chunkIn(c, v);
            });
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic ch, int status) {
            if (status != 0) android.util.Log.i("ChaxBle", "write status " + status);
            main.post(() -> {
                Conn c = byAddress.get(gatt.getDevice().getAddress());
                if (c != null) { c.busy = false; pump(c); }
            });
        }
    };

    // ---- peripheral side ------------------------------------------------------------

    private final BluetoothGattServerCallback serverCb = new BluetoothGattServerCallback() {
        @Override
        public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
            String addr = device.getAddress();
            android.util.Log.i("ChaxBle", "server state " + newState + " status " + status + " " + addr);
            main.post(() -> {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    if (!byAddress.containsKey(addr)) {
                        Conn c = new Conn();
                        c.device = device;
                        byAddress.put(addr, c);
                    }
                } else {
                    Conn c = byAddress.get(addr);
                    if (c != null) drop(c);
                }
            });
        }

        @Override
        public void onMtuChanged(BluetoothDevice device, int mtu) {
            main.post(() -> {
                Conn c = byAddress.get(device.getAddress());
                if (c != null) c.mtu = mtu;
            });
        }

        @Override
        public void onDescriptorWriteRequest(BluetoothDevice device, int requestId, BluetoothGattDescriptor d,
                                             boolean prepared, boolean responseNeeded, int offset, byte[] value) {
            if (responseNeeded && server != null) {
                server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value);
            }
            main.post(() -> {
                Conn c = byAddress.get(device.getAddress());
                if (c != null && !c.ready && value != null && value.length > 0 && value[0] == 1) {
                    c.ready = true;
                    sendHello(c);
                }
            });
        }

        @Override
        public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId, BluetoothGattCharacteristic ch,
                                                 boolean prepared, boolean responseNeeded, int offset, byte[] value) {
            if (responseNeeded && server != null) {
                server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value);
            }
            main.post(() -> {
                Conn c = byAddress.get(device.getAddress());
                if (c != null && value != null) chunkIn(c, value);
            });
        }

        @Override
        public void onNotificationSent(BluetoothDevice device, int status) {
            main.post(() -> {
                Conn c = byAddress.get(device.getAddress());
                if (c != null) { c.busy = false; pump(c); }
            });
        }
    };

    // ---- shared plumbing ---------------------------------------------------------------

    private void sendHello(Conn c) {
        byte[] chunk = new byte[1 + myId.length];
        chunk[0] = H_HELLO;
        System.arraycopy(myId, 0, chunk, 1, myId.length);
        synchronized (c.queue) { c.queue.addFirst(chunk); }
        pump(c);
    }

    private void pump(Conn c) {
        if (c.busy || !c.ready) return;
        byte[] chunk;
        synchronized (c.queue) { chunk = c.queue.pollFirst(); }
        if (chunk == null) return;
        c.busy = true;
        final int tok = ++c.token;
        main.postDelayed(() -> { if (c.busy && c.token == tok) { c.busy = false; pump(c); } }, 1500);
        boolean ok;
        try {
            if (c.central()) {
                c.ch.setValue(chunk);
                ok = c.gatt.writeCharacteristic(c.ch);
            } else {
                serverChar.setValue(chunk);
                ok = server != null && server.notifyCharacteristicChanged(c.device, serverChar, false);
            }
        } catch (Exception e) {
            ok = false;
        }
        if (!ok) {
            android.util.Log.i("ChaxBle", "write refused central=" + c.central() + " len=" + chunk.length + " mtu=" + c.mtu);
            c.busy = false;
            synchronized (c.queue) { c.queue.addFirst(chunk); }
            main.postDelayed(() -> pump(c), 30);
        }
    }

    private void chunkIn(Conn c, byte[] v) {
        if (v.length == 0) return;
        c.lastRx = System.currentTimeMillis();
        byte h = v[0];
        if (h == H_PING) return;
        if ((h & H_HELLO) != 0) {
            String link = bytesToHex(Arrays.copyOfRange(v, 1, v.length));
            if (c.link == null && !byLink.containsKey(link)) {
                c.link = link;
                byLink.put(link, c);
                if (sink != null) sink.linkUp(link);
            } else if (c.link == null) {
                drop(c); // duplicate connection to a peer we already have
            }
            return;
        }
        if (c.link == null) return;
        if ((h & H_START) != 0) c.rx.reset();
        c.rx.write(v, 1, v.length - 1);
        if ((h & H_END) != 0) {
            byte[] whole = c.rx.toByteArray();
            c.rx.reset();
            if (sink != null) sink.frame(c.link, whole);
        }
    }

    private void drop(Conn c) {
        android.util.Log.i("ChaxBle", "drop " + c.device.getAddress() + " link=" + c.link + " central=" + c.central() + " from line " + new Throwable().getStackTrace()[1].getLineNumber() + " idle=" + (System.currentTimeMillis() - c.lastRx) + "ms queue=" + c.queue.size());
        byAddress.remove(c.device.getAddress());
        connecting.remove(c.device.getAddress());
        if (c.link != null && byLink.get(c.link) == c) {
            byLink.remove(c.link);
            if (sink != null) sink.linkDown(c.link);
        }
        c.ready = false;
        try {
            if (c.gatt != null) { c.gatt.disconnect(); c.gatt.close(); }
            else if (server != null) server.cancelConnection(c.device);
        } catch (Exception ignored) {}
    }

    private void emitState(String msg) {
        lastState = msg;
        if (sink != null) sink.state(msg);
    }

    private static int compare(byte[] a, byte[] b) {
        for (int i = 0; i < Math.min(a.length, b.length); i++) {
            int d = (a[i] & 0xff) - (b[i] & 0xff);
            if (d != 0) return d;
        }
        return a.length - b.length;
    }

    static byte[] hexToBytes(String h) {
        byte[] out = new byte[h.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(h.substring(i * 2, i * 2 + 2), 16);
        return out;
    }

    private static String bytesToHex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }
}
