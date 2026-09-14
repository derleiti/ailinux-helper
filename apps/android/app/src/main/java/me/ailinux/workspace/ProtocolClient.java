package me.ailinux.workspace;

import android.app.ActivityManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Build;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import okhttp3.*;
import java.io.IOException;
import java.net.URLEncoder;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

final class ProtocolClient extends WebSocketListener {
    interface Listener { void onState(String state); void onResumeToken(String token); void onPairCode(String code); }
    static final String VERSION="2.90.24-android";
    static final String BASE="https://api.ailinux.me";
    private static final String TAG="AILinuxWorkspace";
    private final Context context; private final StateStore state; private final Listener listener;
    private final OkHttpClient http=new OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS).retryOnConnectionFailure(true).build();
    private final ScheduledExecutorService timer=Executors.newSingleThreadScheduledExecutor(); private final ExecutorService tools=Executors.newSingleThreadExecutor();
    private volatile WebSocket ws; private volatile String handoffCode=""; private volatile int reconnectAttempt=0; private volatile ScheduledFuture<?> reconnectFuture; private final AtomicBoolean stopped=new AtomicBoolean(true); private final AtomicBoolean connecting=new AtomicBoolean(false);
    private SafWorkspace workspace;
    private final ScreenCapture screenCapture;
    private final JSONArray readCaps=new JSONArray().put("workspace_info").put("file_read").put("file_tree").put("code_read").put("code_tree").put("code_search").put("code_grep").put("file_ops");

    ProtocolClient(Context context, Listener listener, ScreenCapture screenCapture){this.context=context.getApplicationContext();this.state=new StateStore(context);this.listener=listener;this.screenCapture=screenCapture;}
    void setHandoffCode(String code){handoffCode=code==null?"":code.trim().toUpperCase();}
    void start(){stopped.set(false);cancelReconnect();WebSocket current=ws;if(current!=null)return;connect();}
    void onNetworkAvailable(){if(stopped.get()||ws!=null||connecting.get())return;reconnectAttempt=0;cancelReconnect();listener.onState("Network available · reconnecting");connect();}
    void stop(boolean revoke){stopped.set(true);cancelReconnect();connecting.set(false);WebSocket s=ws;if(s!=null){if(revoke){try{s.send(new JSONObject().put("jsonrpc","2.0").put("method","workspace/revoke").put("params",new JSONObject()).toString());}catch(Exception ignored){}}s.close(1000,"user disconnect");}ws=null;if(revoke){handoffCode="";state.clearCredentials();}listener.onState("Disconnected");}

    private JSONArray capabilities(){JSONArray out=new JSONArray();if(state.tree()!=null){for(int i=0;i<readCaps.length();i++)out.put(readCaps.optString(i));if("write".equals(state.mode()))out.put("file_edit").put("directory_create").put("workspace_clear").put("code_edit");}if(state.computerControl()&&DeviceControlService.isReady())out.put("computer_observe").put("computer_input").put("app_ops");if(state.screenObserve()&&screenCapture!=null&&screenCapture.isReady())out.put("computer_screenshot").put("vision_start").put("vision_status").put("vision_observe").put("vision_stop");if(state.clipboardRead())out.put("clipboard_read");if(state.clipboardWrite())out.put("clipboard_write");if(state.remoteCompute())out.put("compute_execute");return out;}
    private String workspaceMode(){return state.tree()==null?"off":state.mode();}
    private SafWorkspace requireWorkspace(){if(workspace==null)throw new IllegalStateException("workspace capability is not shared");return workspace;}
    private JSONObject deviceResources()throws Exception{JSONObject out=new JSONObject().put("platform","android").put("os_version",Build.VERSION.RELEASE).put("model",Build.MODEL).put("arch",Build.SUPPORTED_ABIS.length>0?Build.SUPPORTED_ABIS[0]:System.getProperty("os.arch","")).put("cpu_cores",Runtime.getRuntime().availableProcessors());ActivityManager manager=(ActivityManager)context.getSystemService(Context.ACTIVITY_SERVICE);if(manager!=null){ActivityManager.MemoryInfo info=new ActivityManager.MemoryInfo();manager.getMemoryInfo(info);out.put("ram_bytes",info.totalMem);}return out;}
    private JSONObject nativeShareProfile()throws Exception{JSONObject resources=new JSONObject().put("advertise",state.resourceAdvertise());if(state.resourceAdvertise())resources.put("inventory",deviceResources());boolean display=state.screenObserve()&&screenCapture!=null&&screenCapture.isReady();return new JSONObject().put("visibility",state.visibility()).put("clipboard",new JSONObject().put("read",state.clipboardRead()).put("write",state.clipboardWrite())).put("display",new JSONObject().put("observe",display).put("control",state.computerControl()&&DeviceControlService.isReady())).put("device",new JSONObject().put("observe",false).put("control",state.computerControl()&&DeviceControlService.isReady())).put("resources",resources).put("compute",new JSONObject().put("remote_requested",state.remoteCompute()).put("runtime","triforce_docker").put("available",state.remoteCompute()).put("ephemeral",true).put("internet","public_only").put("workspace_path","~/workspace"));}
    private void connect(){
        if(stopped.get()||!connecting.compareAndSet(false,true))return;
        boolean nativeCapability=(state.screenObserve()&&screenCapture!=null&&screenCapture.isReady())||state.clipboardRead()||state.clipboardWrite()||(state.computerControl()&&DeviceControlService.isReady());
        if(state.tree()==null&&!state.resourceAdvertise()&&!state.remoteCompute()&&!nativeCapability){connecting.set(false);listener.onState("Choose a workspace or enable a native share first");return;}
        workspace=null;
        if(state.tree()!=null){try{workspace=new SafWorkspace(context,state.tree(),"write".equals(state.mode()));}
        catch(Exception e){connecting.set(false);listener.onState("Workspace unavailable: "+e.getMessage());return;}}
        listener.onState("Connecting executor…");
        if(!handoffCode.isEmpty()){openSocket("handoff_code",handoffCode);return;}
        String pair=state.pairCode();
        if(pair!=null&&!pair.isEmpty()){listener.onPairCode(pair);openSocket("pair_code",pair);return;}
        String resume=state.resumeToken();
        if(resume!=null&&!resume.isEmpty()){
            final RequestBody body;
            try{body=RequestBody.create(new JSONObject().put("resume_token",resume).toString(),MediaType.parse("application/json"));}
            catch(Exception e){connecting.set(false);listener.onState("Could not prepare resume request");return;}
            http.newCall(new Request.Builder().url(BASE+"/v1/mcp/workspace/resume-ticket").post(body).build()).enqueue(new Callback(){
                public void onFailure(Call c,IOException e){scheduleReconnect("Resume ticket failed");}
                public void onResponse(Call c,Response r)throws IOException{
                    try(Response x=r){
                        if(x.code()==403){connecting.set(false);stopped.set(true);state.clearCredentials();listener.onState("Saved workspace lease expired · tap Generate new pair code");return;}
                        if(!x.isSuccessful()){scheduleReconnect("Resume rejected: "+x.code());return;}
                        ResponseBody responseBody=x.body();
                        if(responseBody==null){scheduleReconnect("Resume returned no body");return;}
                        String code=new JSONObject(responseBody.string()).optString("pair_code","");
                        if(code.isEmpty())scheduleReconnect("Resume returned no ticket");else openSocket("pair_code",code);
                    }catch(Exception e){scheduleReconnect("Resume error");}
                }
            });
            return;
        }
        createPairTicket();
    }
    private void createPairTicket(){
        listener.onState("Creating one-time workspace pair code…");
        http.newCall(new Request.Builder().url(BASE+"/v1/mcp/workspace/pair-ticket").post(RequestBody.create(new byte[0],null)).build()).enqueue(new Callback(){
            public void onFailure(Call c,IOException e){scheduleReconnect("Pair ticket failed");}
            public void onResponse(Call c,Response r)throws IOException{
                try(Response x=r){
                    if(!x.isSuccessful()){scheduleReconnect("Pair ticket rejected: "+x.code());return;}
                    ResponseBody responseBody=x.body();
                    if(responseBody==null){scheduleReconnect("Pair ticket returned no body");return;}
                    String code=new JSONObject(responseBody.string()).optString("pair_code","").trim().toUpperCase();
                    if(code.isEmpty()){scheduleReconnect("Pair ticket returned no code");return;}
                    state.setPairCode(code);
                    listener.onPairCode(code);
                    listener.onState("Waiting for AI pairing · "+code);
                    openSocket("pair_code",code);
                }catch(Exception e){scheduleReconnect("Pair ticket error");}
            }
        });
    }
    private static String enc(String value){try{return URLEncoder.encode(value,"UTF-8").replace("+","%20");}catch(Exception e){throw new IllegalArgumentException("URL encoding failed",e);}}
    private void openSocket(String key,String code){String url="wss://api.ailinux.me/v1/mcp/node/connect?mode=workspace&"+key+"="+enc(code)+"&machine_id=android&client_version="+enc(VERSION);WebSocket previous=ws;WebSocket next=http.newWebSocket(new Request.Builder().url(url).build(),this);ws=next;if(previous!=null&&previous!=next)previous.cancel();}
    @Override public void onOpen(WebSocket socket,Response response){if(socket!=ws){socket.cancel();return;}connecting.set(false);cancelReconnect();reconnectAttempt=0;listener.onState("Transport connected");}
    @Override public void onMessage(WebSocket socket,String text){try{JSONObject msg=new JSONObject(text);String error=msg.optString("error","");if(!error.isEmpty()){if(error.toLowerCase().contains("workspace credential")||error.toLowerCase().contains("pairing code")){connecting.set(false);stopped.set(true);handoffCode="";listener.onState("Pair code invalid or expired · tap Generate new pair code");try{socket.close(1000,"pairing credential rejected");}catch(Exception ignored){}}else listener.onState("Server error · "+error);return;}String method=msg.optString("method","");if("connected".equals(method)){sendHello(socket);return;}if("workspace/shared".equals(method)||"workspace/paired".equals(method)){JSONObject p=msg.optJSONObject("params");if(p!=null&&p.optBoolean("ok",true)){String token=p.optString("resume_token","");if(!token.isEmpty()){state.setResumeToken(token);state.setPairCode("");handoffCode="";listener.onPairCode("");listener.onResumeToken(token);}listener.onState("Workspace connected · "+state.mode());}return;}if("workspace/detached".equals(method)){listener.onState("AI detached · lease retained");return;}if("ping".equals(method)){socket.send(new JSONObject().put("jsonrpc","2.0").put("method","pong").put("params",msg.optJSONObject("params")==null?new JSONObject():msg.optJSONObject("params")).toString());return;}if("tools/call".equals(method)){tools.submit(()->handleToolCall(socket,msg));}}
        catch(Exception e){Log.e(TAG,"protocol message",e);listener.onState("Protocol error: "+e.getMessage());}}
    private void sendHello(WebSocket socket)throws Exception{JSONArray caps=capabilities();String mode=workspaceMode();String name=workspace==null?"android-device":workspace.info(caps).optString("workspace","android");socket.send(new JSONObject().put("jsonrpc","2.0").put("method","client/info").put("params",new JSONObject().put("client","ailinux-android-workspace").put("platform","Android "+Build.VERSION.RELEASE).put("hostname",Build.MODEL).put("server_version",VERSION).put("mode","workspace").put("workspace",name).put("access_mode",mode).put("remote_profile",mode)).toString());socket.send(new JSONObject().put("jsonrpc","2.0").put("method","tools/list").put("params",new JSONObject().put("tools",new JSONArray().put("client_workspace_tool"))).toString());socket.send(new JSONObject().put("jsonrpc","2.0").put("method","workspace/share").put("params",new JSONObject().put("task","").put("visibility",state.visibility()).put("access_mode",mode).put("mode",mode).put("capabilities",caps).put("resources",new JSONObject().put("workspace",new JSONObject().put("enabled",workspace!=null).put("mode",mode)).put("native",nativeShareProfile()))).toString());}
    private void handleToolCall(WebSocket socket,JSONObject msg){String id=String.valueOf(msg.opt("id"));String tool="";try{JSONObject outer=msg.getJSONObject("params").getJSONObject("arguments");tool=outer.optString("tool","");stage(socket,id,tool,"started");JSONObject args=outer.optJSONObject("arguments");if(args==null)args=new JSONObject();JSONObject data=execute(tool,args);stage(socket,id,tool,"finished");socket.send(resultMessage(msg.opt("id"),data,false).toString());}catch(Exception e){try{stage(socket,id,tool,"failed");socket.send(resultMessage(msg.opt("id"),new JSONObject().put("ok",false).put("error",String.valueOf(e.getMessage())),true).toString());}catch(Exception ignored){}}}
    private JSONObject execute(String tool,JSONObject args)throws Exception{switch(tool){case"computer_observe":if(!state.computerControl()||!DeviceControlService.isReady())throw new IllegalStateException("accessibility observation is not shared");return new JSONObject().put("ok",true).put("visual",false).put("scene",DeviceControlService.scene());case"computer_screenshot":if(!state.screenObserve()||screenCapture==null||!screenCapture.isReady())throw new IllegalStateException("display observation is not shared");return screenCapture.screenshot().put("scene",DeviceControlService.scene());case"vision_start":if(!state.screenObserve()||screenCapture==null||!screenCapture.isReady())throw new IllegalStateException("display observation is not shared");return screenCapture.visionStart(args).put("scene",DeviceControlService.scene());case"vision_status":if(!state.screenObserve()||screenCapture==null||!screenCapture.isReady())throw new IllegalStateException("display observation is not shared");return screenCapture.visionStatus().put("scene",DeviceControlService.scene());case"vision_observe":if(!state.screenObserve()||screenCapture==null||!screenCapture.isReady())throw new IllegalStateException("display observation is not shared");return screenCapture.observe(args).put("scene",DeviceControlService.scene());case"vision_stop":if(!state.screenObserve()||screenCapture==null||!screenCapture.isReady())throw new IllegalStateException("display observation is not shared");return screenCapture.visionStop();case"clipboard_read":return clipboardRead();case"clipboard_write":return clipboardWrite(args.optString("text",""));case"computer_input":if(!state.computerControl()||!DeviceControlService.isReady())throw new IllegalStateException("computer control is not shared");JSONObject input=DeviceControlService.execute(args);if(screenCapture!=null&&screenCapture.isReady())screenCapture.noteInteraction();return input;case"app_ops":if(!state.computerControl()||!DeviceControlService.isReady())throw new IllegalStateException("device app control is not shared");JSONObject app=AndroidAppOps.execute(context,args);if(screenCapture!=null&&screenCapture.isReady())screenCapture.noteInteraction();return app;default:SafWorkspace local=requireWorkspace();switch(tool){case"workspace_info":return local.info(capabilities());case"file_read":case"code_read":return local.read(args);case"file_tree":case"code_tree":return local.tree(args);case"code_search":return local.search(args,false);case"code_grep":return local.search(args,true);case"file_edit":return local.edit(args);case"directory_create":return local.createDir(args);case"workspace_clear":return local.clear(args);case"file_ops":return local.fileOps(args);case"code_edit":return local.codeEdit(args);default:throw new IllegalArgumentException("unsupported Android workspace tool: "+tool);}}}
    private JSONObject clipboardRead()throws Exception{if(!state.clipboardRead())throw new IllegalStateException("clipboard read is not shared");ClipboardManager cm=(ClipboardManager)context.getSystemService(Context.CLIPBOARD_SERVICE);if(cm==null||!cm.hasPrimaryClip()||cm.getPrimaryClip()==null||cm.getPrimaryClip().getItemCount()==0)return new JSONObject().put("text","");CharSequence value=cm.getPrimaryClip().getItemAt(0).coerceToText(context);String text=value==null?"":value.toString();if(text.length()>1024*1024)text=text.substring(0,1024*1024);return new JSONObject().put("text",text);}
    private JSONObject clipboardWrite(String text)throws Exception{if(!state.clipboardWrite())throw new IllegalStateException("clipboard write is not shared");String value=text==null?"":text;if(value.length()>1024*1024)value=value.substring(0,1024*1024);ClipboardManager cm=(ClipboardManager)context.getSystemService(Context.CLIPBOARD_SERVICE);if(cm==null)throw new IllegalStateException("clipboard service unavailable");cm.setPrimaryClip(ClipData.newPlainText("AILinux Helper",value));return new JSONObject().put("ok",true).put("bytes",value.getBytes(java.nio.charset.StandardCharsets.UTF_8).length); }
    private void stage(WebSocket socket,String id,String tool,String stage)throws Exception{socket.send(new JSONObject().put("jsonrpc","2.0").put("method","workspace/tool_stage").put("params",new JSONObject().put("request_id",id).put("tool",tool).put("stage",stage)).toString());}
    private JSONObject resultMessage(Object id,JSONObject data,boolean error)throws Exception{JSONObject structured=new JSONObject(data.toString());JSONArray content=new JSONArray();String mime=structured.optString("mime",structured.optString("mimeType",""));String encoded=structured.optString("data","");if(!error&&mime.startsWith("image/")&&!encoded.isEmpty()){content.put(new JSONObject().put("type","image").put("data",encoded).put("mimeType",mime));structured.remove("data");structured.put("mimeType",mime);}else content.put(new JSONObject().put("type","text").put("text",data.toString()));JSONObject r=new JSONObject().put("content",content).put("structuredContent",structured).put("isError",error);return new JSONObject().put("jsonrpc","2.0").put("id",id==null?JSONObject.NULL:id).put("result",r);}
    private static boolean pairingCredentialRejected(int code){return code==4003||code==4403;}
    @Override public void onClosing(WebSocket socket,int code,String reason){
        if(socket!=ws){socket.close(code,reason);return;}
        // OkHttp expects the client to acknowledge a peer-initiated close. During
        // a TriForce restart the server sends 1012; waiting only for onClosed can
        // leave the foreground executor attached to a dead socket indefinitely.
        ws=null;connecting.set(false);
        if(pairingCredentialRejected(code)){
            // Keep the rejected code visible. Never silently rotate a code the
            // user copied into an AI chat; only the explicit New Pair action may
            // mint a replacement credential.
            stopped.set(true);handoffCode="";
            try{socket.close(code,reason);}catch(Exception ignored){}
            listener.onState("Pair code invalid or expired · tap Generate new pair code");
            return;
        }
        try{socket.close(code,reason);}catch(Exception ignored){}
        if(!stopped.get())scheduleReconnect("Server disconnected ("+code+")");
    }
    @Override public void onClosed(WebSocket socket,int code,String reason){
        if(pairingCredentialRejected(code)){
            ws=null;connecting.set(false);stopped.set(true);handoffCode="";
            listener.onState("Pair code invalid or expired · tap Generate new pair code");
            return;
        }
        if(socket!=ws)return;ws=null;connecting.set(false);if(!stopped.get())scheduleReconnect("Disconnected ("+code+")");
    }
    @Override public void onFailure(WebSocket socket,Throwable t,Response response){if(socket!=ws)return;ws=null;connecting.set(false);String detail=t==null?"unknown":t.getClass().getSimpleName()+(t.getMessage()==null?"":" · "+t.getMessage());Log.w(TAG,"WebSocket failure: "+detail,t);if(!stopped.get())scheduleReconnect("Connection lost · "+detail);}
    private synchronized void cancelReconnect(){ScheduledFuture<?> f=reconnectFuture;if(f!=null)f.cancel(false);reconnectFuture=null;}
    private synchronized void scheduleReconnect(String message){if(stopped.get())return;connecting.set(false);ScheduledFuture<?> f=reconnectFuture;if(f!=null&&!f.isDone())return;listener.onState(message+" · reconnecting");long delay=Math.min(30,1L<<Math.min(5,reconnectAttempt++));reconnectFuture=timer.schedule(()->{synchronized(ProtocolClient.this){reconnectFuture=null;}connect();},delay,TimeUnit.SECONDS);}
}
