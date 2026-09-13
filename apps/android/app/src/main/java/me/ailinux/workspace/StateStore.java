package me.ailinux.workspace;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

final class StateStore {
    private static final String PREFS = "workspace_state";
    private final SharedPreferences prefs;
    StateStore(Context context) { prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    void setTree(Uri uri) {
        String next = uri == null ? "" : uri.toString();
        String previous = prefs.getString("tree_uri", "");
        SharedPreferences.Editor editor = prefs.edit().putString("tree_uri", next);
        if (!next.equals(previous)) editor.remove("pair_code").remove("resume_token");
        editor.apply();
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
    void clearCredentials() { prefs.edit().remove("pair_code").remove("resume_token").apply(); }
}
