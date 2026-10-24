package app.chax.mesh;

import android.Manifest;
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
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Base64;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * BLE link layer for ChaX. Every phone is both a GATT server (peripheral) and a GATT client (central):
 * it advertises the ChaX service with a short node id, scans for others, and keeps one connection per pair
 * (the node with the smaller id initiates). Complete frames are handed to JavaScript; chunking and
 * reassembly are done here so the JS side only sees whole frames.
 *
 * Chunk layout: [header][data...]. header: 0x01 START, 0x02 END, 0x80 HELLO (data = 4-byte node id).
 */
@CapacitorPlugin(
    name = "ChaxBle",
    permissions = {
        @Permission(
            alias = "ble",
            strings = {
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT
            }
        ),
        @Permission(alias = "loc", strings = { Manifest.permission.ACCESS_FINE_LOCATION }),
        @Permission(alias = "notif", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
@SuppressLint("MissingPermission")
public class ChaxBlePlugin extends Plugin {
    private static final UUID SERVICE = UUID.fromString("7c4a0001-5a1e-4b6f-9d3c-c4a8a0e5c4a1");
    private static final UUID FRAME_CHAR = UUID.fromString("7c4a0002-5a1e-4b6f-9d3c-c4a8a0e5c4a1");
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final int COMPANY_ID = 0xFFFF;
    private static final int WANT_MTU = 247;
    private static final int MAX_QUEUE = 4000;
    private static final long CONNECT_TIMEOUT_MS = 15000;
    private static final byte H_START = 0x01, H_END = 0x02, H_HELLO = (byte) 0x80;

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
        final ArrayDeque<byte[]> queue = new ArrayDeque<>();
        final ByteArrayOutputStream rx = new ByteArrayOutputStream();
        boolean central() { return gatt != null; }
    }

    // ---- JS API ---------------------------------------------------------------

    @PluginMethod
    public void start(PluginCall call) {
        String id = call.getString("nodeId");
        if (id == null || id.length() != 8) {
            call.reject("nodeId must be 8 hex chars");
            return;
        }
        myId = hexToBytes(id);
        if (!permissionsGranted()) {
            requestPermissionForAliases(neededAliases(), call, "permsDone");
            return;
        }
        begin(call);
    }

    private String[] neededAliases() {
        return Build.VERSION.SDK_INT >= 33 ? new String[] { Build.VERSION.SDK_INT >= 31 ? "ble" : "loc", "notif" }
            : new String[] { Build.VERSION.SDK_INT >= 31 ? "ble" : "loc" };
    }

    /** Radio permission is mandatory; the notification permission is only nice to have. */
    private boolean permissionsGranted() {
        String radio = Build.VERSION.SDK_INT >= 31 ? "ble" : "loc";
        if (getPermissionState(radio) != PermissionState.GRANTED) return false;
        return Build.VERSION.SDK_INT < 33 || getPermissionState("notif") != PermissionState.PROMPT;
    }

    @PermissionCallback
    private void permsDone(PluginCall call) {
        String radio = Build.VERSION.SDK_INT >= 31 ? "ble" : "loc";
        if (getPermissionState(radio) != PermissionState.GRANTED) {
            call.reject("Bluetooth permission denied");
            return;
        }
        begin(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        shutdown();
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        Conn c = byLink.get(call.getString("link", ""));
        String data = call.getString("data");
        if (c == null || data == null) {
            call.reject("unknown link");
            return;
        }
        byte[] frame = Base64.decode(data, Base64.NO_WRAP);
        int payload = Math.max(1, c.mtu - 3 - 1);
        synchronized (c.queue) {
            if (c.queue.size() > MAX_QUEUE) {
                call.reject("queue full");
                return;
            }
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
        call.resolve();
    }

    // ---- lifecycle --------------------------------------------------------------

    private void begin(PluginCall call) {
        wanted = true;
        if (running) {
            call.resolve();
            return;
        }
        Context ctx = getContext();
        manager = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null) {
            call.reject("Bluetooth indisponible sur cet appareil");
            return;
        }
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
            call.resolve(); // we will start by ourselves when it comes back
            return;
        }
        startRadio();
        startKeepAlive();
        call.resolve();
    }

    private void startRadio() {
        if (running || adapter == null || !adapter.isEnabled()) return;
        running = true;
        openServer(getContext());
        advertise();
        scan();
        emitState("");
    }

    /** Foreground service: keeps the process and the WebView alive when the screen goes off. */
    private void startKeepAlive() {
        try {
            ContextCompat.startForegroundService(getContext(), new Intent(getContext(), MeshService.class));
        } catch (Exception e) {
            emitState("service d'arrière-plan refusé : " + e.getMessage());
        }
    }

    private void stopRadio() {
        running = false;
        try { if (scanner != null) scanner.stopScan(scanCb); } catch (Exception ignored) {}
        try { if (advertiser != null) advertiser.stopAdvertising(advCb); } catch (Exception ignored) {}
        for (Conn c : new HashSet<>(byAddress.values())) drop(c);
        connecting.clear();
        try { if (server != null) server.close(); } catch (Exception ignored) {}
        server = null;
    }

    @Override
    protected void handleOnPause() {
        background = true;
        if (running) restartScan();
    }

    @Override
    protected void handleOnResume() {
        background = false;
        if (running) restartScan();
    }

    private void restartScan() {
        try { if (scanner != null) scanner.stopScan(scanCb); } catch (Exception ignored) {}
        scan();
    }

    private void shutdown() {
        wanted = false;
        stopRadio();
        try { getContext().stopService(new Intent(getContext(), MeshService.class)); } catch (Exception ignored) {}
        if (stateReceiver != null) {
            try { getContext().unregisterReceiver(stateReceiver); } catch (Exception ignored) {}
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
        c.gatt = d.connectGatt(getContext(), false, clientCb, BluetoothDevice.TRANSPORT_LE);
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
            c.busy = false;
            synchronized (c.queue) { c.queue.addFirst(chunk); }
            main.postDelayed(() -> pump(c), 30);
        }
    }

    private void chunkIn(Conn c, byte[] v) {
        if (v.length == 0) return;
        byte h = v[0];
        if ((h & H_HELLO) != 0) {
            String link = bytesToHex(Arrays.copyOfRange(v, 1, v.length));
            if (c.link == null && !byLink.containsKey(link)) {
                c.link = link;
                byLink.put(link, c);
                JSObject o = new JSObject();
                o.put("link", link);
                notifyListeners("linkUp", o);
            } else if (c.link == null) {
                drop(c); // duplicate connection to a peer we already have
            }
            return;
        }
        if (c.link == null) return;
        if ((h & H_START) != 0) c.rx.reset();
        c.rx.write(v, 1, v.length - 1);
        if ((h & H_END) != 0) {
            JSObject o = new JSObject();
            o.put("link", c.link);
            o.put("data", Base64.encodeToString(c.rx.toByteArray(), Base64.NO_WRAP));
            c.rx.reset();
            notifyListeners("frame", o);
        }
    }

    private void drop(Conn c) {
        byAddress.remove(c.device.getAddress());
        connecting.remove(c.device.getAddress());
        if (c.link != null && byLink.get(c.link) == c) {
            byLink.remove(c.link);
            JSObject o = new JSObject();
            o.put("link", c.link);
            notifyListeners("linkDown", o);
        }
        c.ready = false;
        try {
            if (c.gatt != null) { c.gatt.disconnect(); c.gatt.close(); }
            else if (server != null) server.cancelConnection(c.device);
        } catch (Exception ignored) {}
    }

    private void emitState(String msg) {
        JSObject o = new JSObject();
        o.put("message", msg);
        notifyListeners("error", o);
    }

    private static int compare(byte[] a, byte[] b) {
        for (int i = 0; i < Math.min(a.length, b.length); i++) {
            int d = (a[i] & 0xff) - (b[i] & 0xff);
            if (d != 0) return d;
        }
        return a.length - b.length;
    }

    private static byte[] hexToBytes(String h) {
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
