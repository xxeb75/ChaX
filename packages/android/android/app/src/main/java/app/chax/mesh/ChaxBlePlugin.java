package app.chax.mesh;

import android.Manifest;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * The visible app's door to the Bluetooth link layer. The radio itself lives in BleEngine so it survives the
 * Activity; this plugin only asks for permissions, forwards frames to the page and lets it raise notifications.
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
public class ChaxBlePlugin extends Plugin implements BleEngine.Sink {
    private BleEngine engine() {
        return BleEngine.get(getContext());
    }

    @PluginMethod
    public void start(PluginCall call) {
        String id = call.getString("nodeId");
        if (id == null || id.length() != 8) {
            call.reject("nodeId must be 8 hex chars");
            return;
        }
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

    private void begin(PluginCall call) {
        BleEngine e = engine();
        String err = e.start(BleEngine.hexToBytes(call.getString("nodeId")));
        if (err != null) {
            call.reject(err);
            return;
        }
        e.setSink(this);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        engine().setSink(null);
        engine().stop();
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        String data = call.getString("data");
        if (data == null || !engine().send(call.getString("link", ""), Base64.decode(data, Base64.NO_WRAP))) {
            call.reject("unknown link or queue full");
            return;
        }
        call.resolve();
    }

    /** A message arrived while the page is open but not in front: same notification the headless node raises. */
    @PluginMethod
    public void notify(PluginCall call) {
        Notifier.post(getContext(), call.getString("key", "chax"), call.getString("title", "ChaX"), call.getString("body", ""),
            Boolean.TRUE.equals(call.getBoolean("alert", false)));
        call.resolve();
    }

    @Override
    protected void handleOnPause() {
        engine().setBackground(true);
    }

    @Override
    protected void handleOnResume() {
        engine().setBackground(false);
    }

    // ---- BleEngine.Sink ---------------------------------------------------------

    @Override
    public void linkUp(String link) {
        JSObject o = new JSObject();
        o.put("link", link);
        notifyListeners("linkUp", o);
    }

    @Override
    public void linkDown(String link) {
        JSObject o = new JSObject();
        o.put("link", link);
        notifyListeners("linkDown", o);
    }

    @Override
    public void frame(String link, byte[] data) {
        JSObject o = new JSObject();
        o.put("link", link);
        o.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
        notifyListeners("frame", o);
    }

    @Override
    public void state(String message) {
        JSObject o = new JSObject();
        o.put("message", message);
        notifyListeners("error", o);
    }
}
