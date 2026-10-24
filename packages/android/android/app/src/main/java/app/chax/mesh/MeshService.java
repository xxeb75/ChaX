package app.chax.mesh;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Keeps the process (and so the WebView running the mesh) alive while the app is in the background.
 * It does no radio work itself: ChaxBlePlugin owns the Bluetooth link layer.
 */
public class MeshService extends Service {
    private static final String CHANNEL = "chax_mesh";
    private static final int NOTIFICATION_ID = 1;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
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
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
