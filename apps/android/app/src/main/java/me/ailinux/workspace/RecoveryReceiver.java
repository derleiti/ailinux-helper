package me.ailinux.workspace;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public final class RecoveryReceiver extends BroadcastReceiver {
    static final String ACTION_RECOVER="me.ailinux.workspace.RECOVER";
    @Override public void onReceive(Context context,Intent intent){
        StateStore state=new StateStore(context);
        if(!state.executorWanted())return;
        if(WorkspaceService.isActive()){
            WorkspaceService.scheduleRecoveryAlarm(context,10*60*1000L);
            return;
        }
        Intent service=new Intent(context,WorkspaceService.class).setAction(WorkspaceService.ACTION_RECONNECT);
        if(Build.VERSION.SDK_INT>=26)context.startForegroundService(service); else context.startService(service);
    }
}
