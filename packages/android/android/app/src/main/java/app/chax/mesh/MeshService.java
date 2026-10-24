package app.chax.mesh;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Keeps the process alive so the mesh keeps running in the background. While the app is open the page owns the
 * radio; once the Activity is gone (swiped away, killed to free memory) a HeadlessHost takes over with the same
 * JavaScript node, so messages keep arriving and raise notifications.
 */
public class MeshService extends Service {
    private static final String CHANNEL = "chax_mesh";
    private static final int NOTIFICATION_ID = 1;

    private static MeshService instance;
    private static boolean uiAlive;

    private HeadlessHost headless;

    /** The Activity is being created: the page takes the mesh over from the headless node. */
    static void uiCreated() {
        uiAlive = true;
        if (instance != null) instance.stopHeadless();
    }

    /** The Activity is gone: if the mesh is on, the headless node carries on. */
    static void uiDestroyed() {
        uiAlive = false;
        if (instance != null) instance.startHeadless();
    }

    private void startHeadless() {
        if (headless != null || uiAlive) return;
        headless = new HeadlessHost(this);
        headless.start();
    }

    private void stopHeadless() {
        if (headless == null) return;
        headless.stop();
        headless = null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        instance = this;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Mesh ChaX", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Indique que ChaX relaie les messages en arrière-plan");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        Notification n = b
            .setContentTitle("ChaX")
            .setContentText("Mesh actif : les messages continuent d'arriver")
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentIntent(pi)
            .setOngoing(true)
            .build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
        if (intent == null) {
            // the system restarted us after killing the process: the radio is off until we bring it back
            String err = BleEngine.get(this).resume();
            if (err != null) {
                stopSelf();
                return START_NOT_STICKY;
            }
        }
        startHeadless();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopHeadless();
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
