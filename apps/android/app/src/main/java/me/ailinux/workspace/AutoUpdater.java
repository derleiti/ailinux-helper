package me.ailinux.workspace;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/** Verified self-update handoff for the Android and Android-TV Helper builds. */
final class AutoUpdater {
    private static final String BASE = "https://api.ailinux.me";
    private static final String CATALOG = BASE + "/v1/mcp/helper/releases";
    private static final String PREFS = "helper_updates";
    private static final String PENDING_PERMISSION = "pending_install_permission";
    private static final String LAST_INSTALLER_VERSION = "last_installer_version";
    private static final String LAST_INSTALLER_AT = "last_installer_at";
    private static final long INSTALLER_RETRY_MS = 60L * 60L * 1000L;
    private static final AtomicBoolean RUNNING = new AtomicBoolean(false);
    private static final OkHttpClient HTTP = new OkHttpClient();

    private AutoUpdater() { }

    static void check(Activity activity) { check(activity, false); }

    static void resume(Activity activity) {
        SharedPreferences prefs = activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
        if (!prefs.getBoolean(PENDING_PERMISSION, false)) return;
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) return;
        prefs.edit().putBoolean(PENDING_PERMISSION, false).apply();
        check(activity, true);
    }

    private static void check(Activity activity, boolean force) {
        if (!RUNNING.compareAndSet(false, true)) return;
        Request request = new Request.Builder().url(CATALOG).header("Cache-Control", "no-cache").build();
        HTTP.newCall(request).enqueue(new Callback() {
            @Override public void onFailure(Call call, IOException e) { RUNNING.set(false); }
            @Override public void onResponse(Call call, Response response) throws IOException {
                try (Response r = response) {
                    if (!r.isSuccessful() || r.body() == null) return;
                    JSONObject catalog = new JSONObject(r.body().string());
                    String platform = isTv(activity) ? "android-tv" : "android";
                    JSONObject spec = catalog.optJSONObject(platform);
                    if (spec == null || !spec.optBoolean("available", false)) return;
                    String latest = spec.optString("version", "").trim();
                    String current = currentVersion(activity);
                    if (latest.isEmpty() || compareVersions(latest, current) <= 0) return;
                    String path = spec.optString("url", "").trim();
                    String sha256 = spec.optString("sha256", "").trim().toLowerCase(Locale.ROOT);
                    if (!path.startsWith("/v1/mcp/helper/") || sha256.length() != 64) return;

                    SharedPreferences prefs = activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
                    if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
                        prefs.edit().putBoolean(PENDING_PERMISSION, true).apply();
                        activity.runOnUiThread(() -> {
                            try {
                                Intent permission = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                        Uri.parse("package:" + activity.getPackageName()));
                                activity.startActivity(permission);
                            } catch (Exception ignored) { }
                        });
                        return;
                    }

                    long now = System.currentTimeMillis();
                    if (!force && latest.equals(prefs.getString(LAST_INSTALLER_VERSION, ""))
                            && now - prefs.getLong(LAST_INSTALLER_AT, 0L) < INSTALLER_RETRY_MS) return;
                    downloadAndInstall(activity, latest, BASE + path, sha256, prefs);
                } catch (Exception ignored) {
                } finally {
                    RUNNING.set(false);
                }
            }
        });
    }

    private static void downloadAndInstall(Activity activity, String version, String url, String expectedSha,
                                           SharedPreferences prefs) {
        if (!url.startsWith(BASE + "/v1/mcp/helper/")) return;
        Request request = new Request.Builder().url(url).build();
        HTTP.newCall(request).enqueue(new Callback() {
            @Override public void onFailure(Call call, IOException e) { }
            @Override public void onResponse(Call call, Response response) throws IOException {
                try (Response r = response) {
                    ResponseBody body = r.body();
                    if (!r.isSuccessful() || body == null) return;
                    File dir = new File(activity.getCacheDir(), "updates");
                    if (!dir.isDirectory() && !dir.mkdirs()) return;
                    File apk = new File(dir, "AILinux-Helper-" + version + (isTv(activity) ? "-android-tv.apk" : "-android.apk"));
                    try (FileOutputStream out = new FileOutputStream(apk)) {
                        byte[] buffer = new byte[64 * 1024];
                        int read;
                        java.io.InputStream in = body.byteStream();
                        while ((read = in.read(buffer)) >= 0) out.write(buffer, 0, read);
                    }
                    if (!expectedSha.equals(sha256(apk))) { apk.delete(); return; }
                    prefs.edit().putString(LAST_INSTALLER_VERSION, version)
                            .putLong(LAST_INSTALLER_AT, System.currentTimeMillis()).apply();
                    activity.runOnUiThread(() -> launchInstaller(activity, apk));
                } catch (Exception ignored) { }
            }
        });
    }

    private static void launchInstaller(Activity activity, File apk) {
        try {
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".files", apk);
            Intent install = new Intent(Intent.ACTION_INSTALL_PACKAGE, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    .putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true)
                    .putExtra(Intent.EXTRA_RETURN_RESULT, false);
            activity.startActivity(install);
        } catch (Exception ignored) { }
    }

    private static boolean isTv(Activity activity) { return activity.getPackageName().endsWith(".tv"); }

    private static String currentVersion(Activity activity) {
        try {
            String value = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName;
            return value == null ? "0" : value;
        } catch (PackageManager.NameNotFoundException e) { return "0"; }
    }

    static int compareVersions(String left, String right) {
        String[] a = left.replaceFirst("^[vV]", "").split("[.-]");
        String[] b = right.replaceFirst("^[vV]", "").split("[.-]");
        int length = Math.max(a.length, b.length);
        for (int i = 0; i < length; i++) {
            int av = numericPart(i < a.length ? a[i] : "0");
            int bv = numericPart(i < b.length ? b[i] : "0");
            if (av != bv) return Integer.compare(av, bv);
        }
        return 0;
    }

    private static int numericPart(String value) {
        String digits = value == null ? "" : value.replaceAll("[^0-9].*$", "");
        try { return digits.isEmpty() ? 0 : Integer.parseInt(digits); }
        catch (NumberFormatException e) { return 0; }
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (java.io.FileInputStream in = new java.io.FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) >= 0) digest.update(buffer, 0, read);
        }
        StringBuilder out = new StringBuilder();
        for (byte value : digest.digest()) out.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return out.toString();
    }
}
