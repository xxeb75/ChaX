package app.chax.mesh;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ChaxBlePlugin.class);
        MeshService.uiCreated(); // before the page loads, so the headless node has already written its state
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (!isChangingConfigurations()) {
            BleEngine.get(this).setSink(null);
            MeshService.uiDestroyed();
        }
    }
}
