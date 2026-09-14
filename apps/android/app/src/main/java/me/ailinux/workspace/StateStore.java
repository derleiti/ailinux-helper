package me.ailinux.workspace;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import java.util.UUID;

final class StateStore {
    private static final String PREFS = "workspace_state";
    // MediaProjection consent cannot be persisted/replayed across process death.
    private static volatile boolean screenObserveSession = false;
    private final SharedPreferences prefs;
    private final SecureCredentialStore credentials;
    StateStore(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        credentials = new SecureCredentialStore(context);
        migrateLegacyCredentials();
    }
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
        credentials.put("pair_code", next);
        if (!next.isEmpty()) credentials.remove("resume_token");
    }
    String pairCode() { return credentials.get("pair_code"); }
    void clearPairCode() { credentials.remove("pair_code"); }
    void setResumeToken(String token) { credentials.put("resume_token", token == null ? "" : token); }
    void setResumeCredential(String token) {
        String value = token == null ? "" : token;
        credentials.put("resume_token", value);
        credentials.remove("pair_code");
    }
    String resumeToken() { return credentials.get("resume_token"); }
    String machineId() {
        String value = prefs.getString("machine_id", "");
        if (value != null && !value.isEmpty()) return value;
        value = "android-" + UUID.randomUUID().toString();
        prefs.edit().putString("machine_id", value).commit();
        return value;
    }
    void setShellReleased(boolean released) { prefs.edit().putBoolean("shell_released", released).apply(); }
    boolean shellReleased() { return prefs.getBoolean("shell_released", false); }
    void setResourceAdvertise(boolean enabled) { prefs.edit().putBoolean("resource_advertise", enabled).apply(); }
    boolean resourceAdvertise() { return prefs.getBoolean("resource_advertise", false); }
    void setRemoteCompute(boolean enabled) { prefs.edit().putBoolean("remote_compute", enabled).apply(); }
    boolean remoteCompute() { return prefs.getBoolean("remote_compute", false); }
    void setScreenObserve(boolean enabled) { screenObserveSession = enabled; }
    boolean screenObserve() { return screenObserveSession; }
    void setScreenObserveWanted(boolean enabled) { prefs.edit().putBoolean("screen_observe_wanted", enabled).apply(); }
    boolean screenObserveWanted() { return prefs.getBoolean("screen_observe_wanted", false); }
    void setClipboardRead(boolean enabled) { prefs.edit().putBoolean("clipboard_read", enabled).apply(); }
    boolean clipboardRead() { return prefs.getBoolean("clipboard_read", false); }
    void setClipboardWrite(boolean enabled) { prefs.edit().putBoolean("clipboard_write", enabled).apply(); }
    boolean clipboardWrite() { return prefs.getBoolean("clipboard_write", false); }
    void setComputerControl(boolean enabled) { prefs.edit().putBoolean("computer_control", enabled).apply(); }
    boolean computerControl() { return prefs.getBoolean("computer_control", false); }
    void setVisibility(String visibility) {
        String value = "public".equals(visibility) || "unlisted".equals(visibility) ? visibility : "private";
        prefs.edit().putString("visibility", value).apply();
    }
    String visibility() { return prefs.getString("visibility", "private"); }
    void clearCredentials() { credentials.clear(); }

    private void migrateLegacyCredentials() {
        String legacyPair = prefs.getString("pair_code", "");
        String legacyResume = prefs.getString("resume_token", "");
        boolean pairPresent = legacyPair != null && !legacyPair.isEmpty();
        boolean resumePresent = legacyResume != null && !legacyResume.isEmpty();
        if (!pairPresent && !resumePresent) return;
        try {
            if (resumePresent) {
                credentials.put("resume_token", legacyResume);
                credentials.remove("pair_code");
            } else {
                credentials.put("pair_code", legacyPair.trim().toUpperCase());
                credentials.remove("resume_token");
            }
            // Delete plaintext only after the encrypted write has committed.
            if (!prefs.edit().remove("pair_code").remove("resume_token").commit()) {
                throw new IllegalStateException("legacy credential cleanup failed");
            }
        } catch (RuntimeException ignored) {
            // Fail closed: legacy plaintext is never returned as a fallback. A later
            // process start can retry migration if the keystore becomes available.
        }
    }
}
