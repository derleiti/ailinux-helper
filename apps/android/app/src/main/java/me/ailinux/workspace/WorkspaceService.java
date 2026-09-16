package me.ailinux.workspace;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.SystemClock;
import android.os.*;
import androidx.core.app.NotificationCompat;

public class WorkspaceService extends Service implements ProtocolClient.Listener {
    public static final String ACTION_START="me.ailinux.workspace.START",ACTION_RECONNECT="me.ailinux.workspace.RECONNECT",ACTION_NEW_PAIR="me.ailinux.workspace.NEW_PAIR",ACTION_ENABLE_SCREEN="me.ailinux.workspace.ENABLE_SCREEN",ACTION_DISABLE_SCREEN="me.ailinux.workspace.DISABLE_SCREEN",ACTION_STOP="me.ailinux.workspace.STOP",EXTRA_HANDOFF="handoff_code",EXTRA_CAPTURE_RESULT="capture_result",EXTRA_CAPTURE_DATA="capture_data";
    private static final String CHANNEL="workspace_executor";
    private static final int RECOVERY_REQUEST=8607;
    private static final long RECOVERY_INTERVAL_MS=10*60*1000L;
    private static volatile boolean active=false;
    private ProtocolClient client;
    private ScreenCapture screenCapture;
    private StateStore state;
    private PowerManager.WakeLock wakeLock;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;

    @Override public void onCreate(){
        super.onCreate();
        active=true;
        createChannel();
        state=new StateStore(this);
        screenCapture=new ScreenCapture(this,()->new Handler(Looper.getMainLooper()).post(()->{
            state.setScreenObserve(false);
            if(client!=null){client.stop(false);client.start();}
            onState("Display observation stopped by Android");
            updateForeground("Workspace executor active",false);
        }));
        client=new ProtocolClient(this,this,screenCapture);
        connectivityManager=getSystemService(ConnectivityManager.class);
        if(connectivityManager!=null){
            networkCallback=new ConnectivityManager.NetworkCallback(){
                @Override public void onAvailable(Network network){if(client!=null)client.onNetworkAvailable();}
                @Override public void onLost(Network network){if(client!=null)client.onNetworkLost();}
            };
            try{connectivityManager.registerDefaultNetworkCallback(networkCallback);}catch(Exception ignored){}
        }
    }

    @Override public int onStartCommand(Intent intent,int flags,int startId){
        String action=intent==null?ACTION_START:intent.getAction();
        if(ACTION_STOP.equals(action)){
            state.setExecutorWanted(false);
            cancelRecoveryAlarm(this);
            if(client!=null)client.stop(true);
            if(screenCapture!=null)screenCapture.stop();
            state.setScreenObserveWanted(false);
            state.setScreenObserve(false);
            releaseWakeLock();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        state.setExecutorWanted(true);
        scheduleRecoveryAlarm(this,RECOVERY_INTERVAL_MS);
        acquireWakeLock();
        updateForeground("Starting workspace executor…",false);

        if(ACTION_ENABLE_SCREEN.equals(action)){
            int result=intent==null?Activity.RESULT_CANCELED:intent.getIntExtra(EXTRA_CAPTURE_RESULT,Activity.RESULT_CANCELED);
            Intent data=Build.VERSION.SDK_INT>=33?intent.getParcelableExtra(EXTRA_CAPTURE_DATA,Intent.class):intent.getParcelableExtra(EXTRA_CAPTURE_DATA);
            try{
                updateForeground("Display observation active",true);
                screenCapture.start(result,data);
                state.setScreenObserve(true);
                client.stop(false);client.start();
                onState("Display / vision observation shared");
            }catch(Exception e){
                state.setScreenObserve(false);
                screenCapture.stop();
                updateForeground("Workspace executor active",false);
                onState("Display sharing failed · "+e.getMessage());
            }
            return START_STICKY;
        }
        if(ACTION_DISABLE_SCREEN.equals(action)){
            state.setScreenObserve(false);
            screenCapture.stop();
            updateForeground("Workspace executor active",false);
            client.stop(false);client.start();
            onState("Display / vision observation revoked");
            return START_STICKY;
        }
        if(ACTION_RECONNECT.equals(action)){client.stop(false);client.start();return START_STICKY;}
        if(ACTION_NEW_PAIR.equals(action)){client.stop(true);client.start();return START_STICKY;}
        String handoff=intent==null?null:intent.getStringExtra(EXTRA_HANDOFF);
        if(handoff!=null&&!handoff.isEmpty())client.setHandoffCode(handoff);
        client.start();
        return START_STICKY;
    }

    @Override public void onTaskRemoved(Intent rootIntent){
        if(client!=null)client.onNetworkAvailable();
        if(state!=null&&state.executorWanted())scheduleRecoveryAlarm(this,5000L);
        super.onTaskRemoved(rootIntent);
    }

    @Override public void onDestroy(){
        active=false;
        if(state!=null&&state.executorWanted())scheduleRecoveryAlarm(this,5000L);
        if(connectivityManager!=null&&networkCallback!=null){try{connectivityManager.unregisterNetworkCallback(networkCallback);}catch(Exception ignored){}}
        if(client!=null)client.stop(false);
        if(screenCapture!=null)screenCapture.shutdown();
        releaseWakeLock();
        super.onDestroy();
    }
    static boolean isActive(){return active;}
    static void scheduleRecoveryAlarm(Context context,long delayMs){
        AlarmManager alarms=(AlarmManager)context.getSystemService(Context.ALARM_SERVICE);
        if(alarms==null)return;
        Intent wake=new Intent(context,RecoveryReceiver.class).setAction(RecoveryReceiver.ACTION_RECOVER);
        PendingIntent pi=PendingIntent.getBroadcast(context,RECOVERY_REQUEST,wake,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        long at=SystemClock.elapsedRealtime()+Math.max(5000L,delayMs);
        if(Build.VERSION.SDK_INT>=23)alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP,at,pi);
        else alarms.set(AlarmManager.ELAPSED_REALTIME_WAKEUP,at,pi);
    }
    static void cancelRecoveryAlarm(Context context){
        AlarmManager alarms=(AlarmManager)context.getSystemService(Context.ALARM_SERVICE);
        if(alarms==null)return;
        Intent wake=new Intent(context,RecoveryReceiver.class).setAction(RecoveryReceiver.ACTION_RECOVER);
        PendingIntent pi=PendingIntent.getBroadcast(context,RECOVERY_REQUEST,wake,PendingIntent.FLAG_NO_CREATE|PendingIntent.FLAG_IMMUTABLE);
        if(pi!=null){alarms.cancel(pi);pi.cancel();}
    }

    @Override public IBinder onBind(Intent intent){return null;}
    @Override public void onState(String value){getSystemService(NotificationManager.class).notify(8606,notification(value));sendBroadcast(new Intent("me.ailinux.workspace.STATE").setPackage(getPackageName()).putExtra("state",value));}
    @Override public void onResumeToken(String token){}
    // P0: the pairing credential must never reach the notification shade. A
    // notification is mirrored to the lock screen, Notification History and
    // (on many OEM builds) the system log, so anyone with a glance at the
    // device could claim the workspace. The code itself travels only through
    // the package-private STATE broadcast into the app UI, where the user can
    // read and copy it deliberately.
    @Override public void onPairCode(String code){
        sendBroadcast(new Intent("me.ailinux.workspace.STATE").setPackage(getPackageName()).putExtra("pair_code",code));
        boolean ready=code!=null&&!code.trim().isEmpty();
        getSystemService(NotificationManager.class).notify(8606,notification(ready?"Pair code ready · open the app":"Waiting for pairing"));
    }

    private void updateForeground(String text,boolean mediaProjection){
        Notification n=notification(text);
        if(mediaProjection&&Build.VERSION.SDK_INT>=29){
            int types=ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
            if(Build.VERSION.SDK_INT>=34)types|=ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
            startForeground(8606,n,types);
        }else if(Build.VERSION.SDK_INT>=34){
            startForeground(8606,n,ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        }else startForeground(8606,n);
    }

    private void acquireWakeLock(){
        if(wakeLock!=null&&wakeLock.isHeld())return;
        PowerManager pm=getSystemService(PowerManager.class);
        if(pm==null)return;
        wakeLock=pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,getPackageName()+":workspace-executor");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
    }
    private void releaseWakeLock(){if(wakeLock!=null&&wakeLock.isHeld()){try{wakeLock.release();}catch(Exception ignored){}}wakeLock=null;}

    private Notification notification(String text){
        Intent open=new Intent(this,MainActivity.class);
        PendingIntent pi=PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        Intent reconnect=new Intent(this,WorkspaceService.class).setAction(ACTION_RECONNECT);
        PendingIntent ri=PendingIntent.getService(this,2,reconnect,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        Intent stop=new Intent(this,WorkspaceService.class).setAction(ACTION_STOP);
        PendingIntent si=PendingIntent.getService(this,1,stop,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder builder=new NotificationCompat.Builder(this,CHANNEL).setSmallIcon(android.R.drawable.stat_sys_upload_done).setContentTitle("AILinux Helper · Workspace").setContentText(text).setStyle(new NotificationCompat.BigTextStyle().bigText(text)).setCategory(NotificationCompat.CATEGORY_SERVICE).setOnlyAlertOnce(true).setOngoing(true).setContentIntent(pi).addAction(0,"Open",pi).addAction(0,"Reconnect",ri);
        if(state!=null&&state.screenObserveWanted()&&(screenCapture==null||!screenCapture.isReady())){
            Intent restore=new Intent(this,MainActivity.class).putExtra(MainActivity.EXTRA_REAUTHORIZE_SCREEN,true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent vi=PendingIntent.getActivity(this,3,restore,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
            builder.addAction(0,"Restore vision",vi);
        }
        return builder.addAction(0,"Disconnect",si).build();
    }
    private void createChannel(){if(Build.VERSION.SDK_INT>=26){NotificationChannel c=new NotificationChannel(CHANNEL,"AILinux Helper Executor",NotificationManager.IMPORTANCE_LOW);c.setDescription("Persistent local MCP workspace connection");getSystemService(NotificationManager.class).createNotificationChannel(c);}}
}
