package me.ailinux.workspace;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Privacy-bounded crash/self-test reporter shared by the Android Helper runtime.
 * It never reads logcat, workspace files, clipboard or screen contents.
 */
final class BugReporter {
    interface Callback { void complete(boolean ok, String detail); }

    private static final String TAG="AILinuxBugReporter";
    private static final String ENDPOINT="https://api.ailinux.me/v1/bugs/report";
    private static final String PREFS="ailinux_bug_reporter";
    private static final String INSTALL_ID="install_id";
    private static final int MAX_PENDING=20,MAX_LOG_LINES=200,MAX_LOG_BYTES=768*1024;
    private static final Object LOCK=new Object();
    private static final ArrayDeque<String> RING=new ArrayDeque<>();
    private static final OkHttpClient HTTP=new OkHttpClient.Builder()
            .connectTimeout(3, TimeUnit.SECONDS).readTimeout(4,TimeUnit.SECONDS).writeTimeout(4,TimeUnit.SECONDS)
            .retryOnConnectionFailure(true).build();
    private static volatile Context context;
    private static volatile boolean installed=false;

    private BugReporter(){}

    static void install(Context source){
        if(installed)return;
        synchronized(LOCK){
            if(installed)return;
            context=source.getApplicationContext();
            Thread.UncaughtExceptionHandler previous=Thread.getDefaultUncaughtExceptionHandler();
            Thread.setDefaultUncaughtExceptionHandler((thread,error)->{
                try{
                    log("uncaught_exception", error==null?"unknown":error.getClass().getName());
                    JSONObject payload=exceptionPayload("crash","automatic",error,"");
                    if(!send(payload))enqueue(payload);
                }catch(Throwable ignored){}
                if(previous!=null)previous.uncaughtException(thread,error);
            });
            installed=true;
        }
        log("reporter_installed","version="+versionName());
        flushPendingAsync();
        runStartupSelfTestAsync();
    }

    static void log(String event,String detail){
        String line;
        try{
            line=new JSONObject().put("ts",System.currentTimeMillis()).put("event",redact(event)).put("detail",redact(detail)).toString();
        }catch(Exception e){line="{\"event\":\"log_encode_failed\"}";}
        synchronized(LOCK){
            RING.addLast(line);
            while(RING.size()>MAX_LOG_LINES)RING.removeFirst();
            appendPersistentLog(line);
        }
        Log.i(TAG, redact(event)+" · "+redact(detail));
    }

    static void submitManual(String message,Callback callback){
        new Thread(()->{
            try{
                JSONObject payload=basePayload("manual","manual").put("user_message",redact(message));
                boolean ok=send(payload);
                if(!ok)enqueue(payload);
                if(callback!=null)callback.complete(ok,ok?"Report submitted":"Offline or server unavailable; report queued for retry");
            }catch(Exception e){
                if(callback!=null)callback.complete(false,"Could not create report: "+redact(e.getMessage()));
            }
        },"ailinux-bug-submit").start();
    }

    private static void runStartupSelfTestAsync(){
        new Thread(()->{
            JSONObject checks=new JSONObject(); boolean ok=true;
            try{
                File dir=context.getFilesDir(); boolean files=dir!=null&&dir.exists()&&dir.canWrite();
                checks.put("private_storage_writable",files); ok&=files;
            }catch(Exception e){ok=false;put(checks,"private_storage_writable",false);put(checks,"private_storage_error",redact(e.getMessage()));}
            try{
                String v=versionName(); boolean version=!v.isEmpty(); checks.put("package_version",v); ok&=version;
            }catch(Exception e){ok=false;put(checks,"package_version_error",redact(e.getMessage()));}
            put(checks,"accessibility_ready",DeviceControlService.isReady());
            put(checks,"workspace_service_active",WorkspaceService.isActive());
            log("startup_selftest",ok?"ok":"failed");
            if(!ok){
                try{
                    JSONObject payload=basePayload("selftest","selftest").put("selftest",checks)
                            .put("exception_message","Startup self-test failed");
                    if(!send(payload))enqueue(payload);
                }catch(Exception ignored){}
            }
        },"ailinux-selftest").start();
    }

    private static JSONObject exceptionPayload(String event,String delivery,Throwable error,String userMessage)throws Exception{
        JSONObject payload=basePayload(event,delivery);
        if(error!=null){
            payload.put("exception_type",error.getClass().getName());
            payload.put("exception_message",redact(error.getMessage()));
            StringWriter sw=new StringWriter(); error.printStackTrace(new PrintWriter(sw));
            payload.put("stack",redact(sw.toString()));
        }
        if(userMessage!=null&&!userMessage.isEmpty())payload.put("user_message",redact(userMessage));
        return payload;
    }

    private static JSONObject basePayload(String event,String delivery)throws Exception{
        JSONObject payload=new JSONObject();
        payload.put("app","AILinux Helper"); payload.put("repo","ailinux-helper"); payload.put("version",versionName());
        payload.put("platform","android"); payload.put("os_version",Build.VERSION.RELEASE+" (API "+Build.VERSION.SDK_INT+")");
        payload.put("arch",Build.SUPPORTED_ABIS.length>0?Build.SUPPORTED_ABIS[0]:""); payload.put("channel",isDebuggable()?"debug":"release");
        payload.put("event_type",event); payload.put("delivery",delivery); payload.put("install_id",installId());
        payload.put("logs",collectLogs());
        payload.put("metadata",new JSONObject().put("manufacturer",Build.MANUFACTURER).put("model",Build.MODEL)
                .put("device",Build.DEVICE).put("locale",Locale.getDefault().toLanguageTag()));
        return payload;
    }

    private static String versionName(){
        try{String value=context.getPackageManager().getPackageInfo(context.getPackageName(),0).versionName;return value==null?"unknown":value;}
        catch(Exception e){return "unknown";}
    }

    private static boolean isDebuggable(){
        try{return context!=null&&(context.getApplicationInfo().flags&ApplicationInfo.FLAG_DEBUGGABLE)!=0;}catch(Exception e){return false;}
    }

    private static String installId(){
        SharedPreferences p=context.getSharedPreferences(PREFS,Context.MODE_PRIVATE);
        String id=p.getString(INSTALL_ID,"");
        if(id==null||id.isEmpty()){id=UUID.randomUUID().toString();p.edit().putString(INSTALL_ID,id).apply();}
        return id;
    }

    private static JSONArray collectLogs(){
        ArrayDeque<String> lines=new ArrayDeque<>();
        File file=logFile();
        if(file!=null&&file.isFile()){
            try(BufferedReader br=new BufferedReader(new FileReader(file,StandardCharsets.UTF_8))){
                String line; while((line=br.readLine())!=null){lines.addLast(redact(line));while(lines.size()>MAX_LOG_LINES)lines.removeFirst();}
            }catch(Exception ignored){}
        }
        synchronized(LOCK){for(String line:RING){lines.addLast(redact(line));while(lines.size()>MAX_LOG_LINES)lines.removeFirst();}}
        JSONArray out=new JSONArray(); for(String line:lines)out.put(line); return out;
    }

    private static File logFile(){return context==null?null:new File(context.getFilesDir(),"diagnostics/helper-runtime.jsonl");}
    private static File pendingFile(){return context==null?null:new File(context.getFilesDir(),"diagnostics/pending-reports.json");}

    private static void appendPersistentLog(String line){
        try{
            File file=logFile(); if(file==null)return; File parent=file.getParentFile(); if(parent!=null)parent.mkdirs();
            if(file.exists()&&file.length()>MAX_LOG_BYTES){File old=new File(file.getParentFile(),"helper-runtime.previous.jsonl");if(old.exists())old.delete();file.renameTo(old);}
            try(FileWriter fw=new FileWriter(file,StandardCharsets.UTF_8,true)){fw.write(line);fw.write('\n');}
        }catch(Exception ignored){}
    }

    private static void enqueue(JSONObject payload){
        synchronized(LOCK){
            try{
                JSONArray queue=readPending(); queue.put(payload);
                JSONArray bounded=new JSONArray(); int start=Math.max(0,queue.length()-MAX_PENDING);
                for(int i=start;i<queue.length();i++)bounded.put(queue.getJSONObject(i)); writePending(bounded);
            }catch(Exception e){Log.w(TAG,"Could not queue bug report",e);}
        }
    }

    private static JSONArray readPending(){
        try{
            File f=pendingFile(); if(f==null||!f.isFile())return new JSONArray();
            StringBuilder b=new StringBuilder(); try(BufferedReader br=new BufferedReader(new FileReader(f,StandardCharsets.UTF_8))){String line;while((line=br.readLine())!=null)b.append(line);}
            return new JSONArray(b.toString());
        }catch(Exception e){return new JSONArray();}
    }

    private static void writePending(JSONArray queue)throws Exception{
        File f=pendingFile(); if(f==null)return; File parent=f.getParentFile(); if(parent!=null)parent.mkdirs();
        File tmp=new File(f.getAbsolutePath()+".tmp"); try(FileWriter fw=new FileWriter(tmp,StandardCharsets.UTF_8,false)){fw.write(queue.toString());}
        if(f.exists()&&!f.delete())throw new IllegalStateException("could not replace pending report queue");
        if(!tmp.renameTo(f))throw new IllegalStateException("could not commit pending report queue");
    }

    private static void flushPendingAsync(){new Thread(BugReporter::flushPending,"ailinux-bug-flush").start();}
    private static void flushPending(){
        synchronized(LOCK){
            JSONArray queue=readPending(),keep=new JSONArray();
            for(int i=0;i<queue.length();i++){
                JSONObject payload=queue.optJSONObject(i); if(payload==null)continue;
                if(!send(payload))keep.put(payload);
            }
            try{writePending(keep);}catch(Exception ignored){}
        }
    }

    private static boolean send(JSONObject payload){
        try{
            Request request=new Request.Builder().url(ENDPOINT)
                    .post(RequestBody.create(payload.toString(),MediaType.parse("application/json; charset=utf-8")))
                    .header("User-Agent","AILinux-Helper-Android/"+versionName()).build();
            try(Response response=HTTP.newCall(request).execute()){return response.code()>=200&&response.code()<300;}
        }catch(Exception e){Log.w(TAG,"Bug report submit failed: "+redact(e.getMessage()));return false;}
    }

    private static String redact(String value){
        String s=value==null?"":value;
        s=s.replaceAll("(?i)(authorization\\s*[:=]\\s*(?:bearer\\s+)?)[^\\s,;]+","$1[REDACTED]");
        s=s.replaceAll("(?i)((?:api[_-]?key|token|secret|password|passwd|resume[_-]?token|pair[_-]?code)\\s*[:=]\\s*)[^\\s,;]+","$1[REDACTED]");
        s=s.replaceAll("(?i)\\b[A-F0-9]{4}(?:-[A-F0-9]{4}){5}\\b","[REDACTED]");
        s=s.replaceAll("(?i)([?&](?:token|key|secret|password|code)=)[^&#\\s]+","$1[REDACTED]");
        return s.length()>48000?s.substring(0,48000)+"…[truncated]":s;
    }

    private static void put(JSONObject o,String key,Object value){try{o.put(key,value);}catch(Exception ignored){}}
}
