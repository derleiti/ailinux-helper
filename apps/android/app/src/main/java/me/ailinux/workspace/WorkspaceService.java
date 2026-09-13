package me.ailinux.workspace;

import android.app.*;
import android.content.*;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.*;
import androidx.core.app.NotificationCompat;

public class WorkspaceService extends Service implements ProtocolClient.Listener {
    public static final String ACTION_START="me.ailinux.workspace.START",ACTION_RECONNECT="me.ailinux.workspace.RECONNECT",ACTION_NEW_PAIR="me.ailinux.workspace.NEW_PAIR",ACTION_STOP="me.ailinux.workspace.STOP",EXTRA_HANDOFF="handoff_code";
    private static final String CHANNEL="workspace_executor";
    private ProtocolClient client;
    private PowerManager.WakeLock wakeLock;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;

    @Override public void onCreate(){
        super.onCreate();
        createChannel();
        client=new ProtocolClient(this,this);
        connectivityManager=getSystemService(ConnectivityManager.class);
        if(connectivityManager!=null){
            networkCallback=new ConnectivityManager.NetworkCallback(){
                @Override public void onAvailable(Network network){if(client!=null)client.onNetworkAvailable();}
            };
            try{connectivityManager.registerDefaultNetworkCallback(networkCallback);}catch(Exception ignored){}
        }
    }

    @Override public int onStartCommand(Intent intent,int flags,int startId){
        if(intent!=null&&ACTION_STOP.equals(intent.getAction())){
            client.stop(true);
            releaseWakeLock();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        acquireWakeLock();
        startForeground(8606,notification("Starting workspace executor…"));
        if(intent!=null&&ACTION_RECONNECT.equals(intent.getAction())){client.stop(false);client.start();return START_STICKY;}
        if(intent!=null&&ACTION_NEW_PAIR.equals(intent.getAction())){client.stop(true);client.start();return START_STICKY;}
        String handoff=intent==null?null:intent.getStringExtra(EXTRA_HANDOFF);
        if(handoff!=null&&!handoff.isEmpty())client.setHandoffCode(handoff);
        client.start();
        return START_STICKY;
    }

    @Override public void onTaskRemoved(Intent rootIntent){
        // The executor is intentionally user-enabled and must outlive closing/swiping the UI.
        if(client!=null)client.onNetworkAvailable();
        super.onTaskRemoved(rootIntent);
    }

    @Override public void onDestroy(){
        if(connectivityManager!=null&&networkCallback!=null){try{connectivityManager.unregisterNetworkCallback(networkCallback);}catch(Exception ignored){}}
        if(client!=null)client.stop(false);
        releaseWakeLock();
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent){return null;}
    @Override public void onState(String state){getSystemService(NotificationManager.class).notify(8606,notification(state));sendBroadcast(new Intent("me.ailinux.workspace.STATE").setPackage(getPackageName()).putExtra("state",state));}
    @Override public void onResumeToken(String token){}
    @Override public void onPairCode(String code){sendBroadcast(new Intent("me.ailinux.workspace.STATE").setPackage(getPackageName()).putExtra("pair_code",code));getSystemService(NotificationManager.class).notify(8606,notification("Pair code · "+code));}

    private void acquireWakeLock(){
        if(wakeLock!=null&&wakeLock.isHeld())return;
        PowerManager pm=getSystemService(PowerManager.class);
        if(pm==null)return;
        wakeLock=pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,getPackageName()+":workspace-executor");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
    }
    private void releaseWakeLock(){if(wakeLock!=null&&wakeLock.isHeld()){try{wakeLock.release();}catch(Exception ignored){}}wakeLock=null;}

    private Notification notification(String text){Intent open=new Intent(this,MainActivity.class);PendingIntent pi=PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);Intent reconnect=new Intent(this,WorkspaceService.class).setAction(ACTION_RECONNECT);PendingIntent ri=PendingIntent.getService(this,2,reconnect,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);Intent stop=new Intent(this,WorkspaceService.class).setAction(ACTION_STOP);PendingIntent si=PendingIntent.getService(this,1,stop,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);return new NotificationCompat.Builder(this,CHANNEL).setSmallIcon(android.R.drawable.stat_sys_upload_done).setContentTitle("AILinux Helper · Workspace").setContentText(text).setStyle(new NotificationCompat.BigTextStyle().bigText(text)).setCategory(NotificationCompat.CATEGORY_SERVICE).setOnlyAlertOnce(true).setOngoing(true).setContentIntent(pi).addAction(0,"Open",pi).addAction(0,"Reconnect",ri).addAction(0,"Disconnect",si).build();}
    private void createChannel(){if(Build.VERSION.SDK_INT>=26){NotificationChannel c=new NotificationChannel(CHANNEL,"AILinux Helper Executor",NotificationManager.IMPORTANCE_LOW);c.setDescription("Persistent local MCP workspace connection");getSystemService(NotificationManager.class).createNotificationChannel(c);}}
}
