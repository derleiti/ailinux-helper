package me.ailinux.workspace;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

final class StateStore {
    private static final String PREFS = "workspace_state";
    // MediaProjection consent cannot be persisted/replayed across process death.
    private static volatile boolean screenObserveSession = false;
    private final SharedPreferences prefs;
    StateStore(Context context) { prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    boolean setTree(Uri uri) {
        String next = uri == null ? "" : uri.toString();
        String previous = prefs.getString("tree_uri", "");
        boolean changed = !next.equals(previous);
        prefs.edit().putString("tree_uri", next).apply();
        return changed;
    }
    Uri tree() { String v = prefs.getString("tree_uri", ""); return v == null || v.isEmpty() ? null : Uri.parse(v); }
    void setMode(String mode) { prefs.edit().putString("mode", "write".equals(mode) ? "write" : "read_only").apply(); }
    String mode() { return prefs.getString("mode", "read_only"); }
    void setPairCode(String code) {
        String next = code == null ? "" : code.trim().toUpperCase();
        SharedPreferences.Editor editor = prefs.edit().putString("pair_code", next);
        if (!next.isEmpty()) editor.remove("resume_token");
        editor.apply();
    }
    String pairCode() { return prefs.getString("pair_code", ""); }
    void clearPairCode() { prefs.edit().remove("pair_code").apply(); }
    void setResumeToken(String token) { prefs.edit().putString("resume_token", token == null ? "" : token).apply(); }
    String resumeToken() { return prefs.getString("resume_token", ""); }
    void setShellReleased(boolean released) { prefs.edit().putBoolean("shell_released", released).apply(); }
    boolean shellReleased() { return prefs.getBoolean("shell_released", false); }
    void setResourceAdvertise(boolean enabled) { prefs.edit().putBoolean("resource_advertise", enabled).apply(); }
    boolean resourceAdvertise() { return prefs.getBoolean("resource_advertise", false); }
    void setRemoteCompute(boolean enabled) { prefs.edit().putBoolean("remote_compute", enabled).apply(); }
    boolean remoteCompute() { return prefs.getBoolean("remote_compute", false); }
    void setScreenObserve(boolean enabled) { screenObserveSession = enabled; }
    boolean screenObserve() { return screenObserveSession; }
    void setClipboardRead(boolean enabled) { prefs.edit().putBoolean("clipboard_read", enabled).apply(); }
    boolean clipboardRead() { return prefs.getBoolean("clipboard_read", false); }
    void setClipboardWrite(boolean enabled) { prefs.edit().putBoolean("clipboard_write", enabled).apply(); }
    boolean clipboardWrite() { return prefs.getBoolean("clipboard_write", false); }
    void setVisibility(String visibility) {
        String value = "public".equals(visibility) || "unlisted".equals(visibility) ? visibility : "private";
        prefs.edit().putString("visibility", value).apply();
    }
    String visibility() { return prefs.getString("visibility", "private"); }
    void clearCredentials() { prefs.edit().remove("pair_code").remove("resume_token").apply(); }
}
