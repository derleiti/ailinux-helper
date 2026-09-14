package me.ailinux.workspace;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.net.Uri;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/** Explicitly granted launcher-app operations for Android remote control. */
final class AndroidAppOps {
    private AndroidAppOps() { }

    static JSONObject execute(Context context, JSONObject args) throws Exception {
        String action = args.optString("action", "list").trim().toLowerCase(Locale.ROOT);
        String app = args.optString("app", "").trim();
        switch (action) {
            case "list": return list(context, app);
            case "launch":
            case "focus": return launch(context, app, action);
            case "open_url": return openUrl(context, args.optString("url", ""));
            case "update_helper": return openUrl(context, "https://api.ailinux.me/v1/mcp/workspace/android.apk").put("action", "update_helper");
            case "close": throw new IllegalArgumentException("Android does not allow a normal app to force-stop another app; use computer_input home/back instead");
            default: throw new IllegalArgumentException("unsupported Android app action: " + action);
        }
    }

    private static JSONObject openUrl(Context context, String value) throws Exception {
        Uri uri = Uri.parse(value == null ? "" : value.trim());
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!("https".equals(scheme) || "http".equals(scheme))) throw new IllegalArgumentException("only http/https URLs are allowed");
        Intent intent = new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (intent.resolveActivity(context.getPackageManager()) == null) throw new IllegalStateException("no browser can open URL");
        context.startActivity(intent);
        return new JSONObject().put("ok", true).put("action", "open_url").put("url", uri.toString());
    }

    private static JSONObject list(Context context, String filter) throws Exception {
        PackageManager pm = context.getPackageManager();
        List<App> apps = launcherApps(pm);
        String needle = filter == null ? "" : filter.trim().toLowerCase(Locale.ROOT);
        JSONArray out = new JSONArray();
        for (App app : apps) {
            if (!needle.isEmpty() && !app.label.toLowerCase(Locale.ROOT).contains(needle)
                    && !app.packageName.toLowerCase(Locale.ROOT).contains(needle)) continue;
            out.put(new JSONObject().put("app", app.label).put("package", app.packageName));
            if (out.length() >= 200) break;
        }
        return new JSONObject().put("ok", true).put("apps", out).put("count", out.length());
    }

    private static JSONObject launch(Context context, String requested, String action) throws Exception {
        if (requested == null || requested.trim().isEmpty()) throw new IllegalArgumentException("app is required");
        PackageManager pm = context.getPackageManager();
        App match = findApp(pm, requested.trim());
        if (match == null) throw new IllegalArgumentException("launcher app not found: " + requested);
        JSONObject result;
        if (Build.VERSION.SDK_INT >= 31 && DeviceControlService.isReady()) {
            // Modern Android deliberately restricts background activity launches.
            // Use the user-enabled AccessibilityService's official All Apps system
            // action, search by launcher label and click the visible result instead.
            result = DeviceControlService.launchViaAllApps(match.label, match.packageName);
        } else {
            Intent launch = pm.getLaunchIntentForPackage(match.packageName);
            if (launch == null) {
                launch = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setPackage(match.packageName);
                ResolveInfo resolved = pm.resolveActivity(launch, PackageManager.MATCH_DEFAULT_ONLY);
                if (resolved == null || resolved.activityInfo == null) throw new IllegalStateException("app has no launchable activity: " + match.packageName);
                launch.setClassName(resolved.activityInfo.packageName, resolved.activityInfo.name);
            }
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
            context.startActivity(launch);
            result = new JSONObject().put("ok", true).put("method", "launcher_intent");
        }
        return result.put("action", action).put("app", match.label).put("package", match.packageName);
    }

    private static App findApp(PackageManager pm, String requested) {
        String needle = requested.toLowerCase(Locale.ROOT);
        List<App> apps = launcherApps(pm);
        for (App app : apps) if (app.packageName.equalsIgnoreCase(requested)) return app;
        for (App app : apps) if (app.label.equalsIgnoreCase(requested)) return app;
        for (App app : apps) if (app.label.toLowerCase(Locale.ROOT).startsWith(needle)) return app;
        for (App app : apps) if (app.label.toLowerCase(Locale.ROOT).contains(needle) || app.packageName.toLowerCase(Locale.ROOT).contains(needle)) return app;
        return null;
    }

    private static List<App> launcherApps(PackageManager pm) {
        Intent query = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> resolved = pm.queryIntentActivities(query, 0);
        List<App> apps = new ArrayList<>();
        for (ResolveInfo info : resolved) {
            ActivityInfo activity = info.activityInfo;
            if (activity == null || activity.packageName == null) continue;
            CharSequence label = info.loadLabel(pm);
            apps.add(new App(label == null ? activity.packageName : label.toString(), activity.packageName));
        }
        apps.sort(Comparator.comparing(a -> a.label.toLowerCase(Locale.ROOT)));
        return apps;
    }

    private static final class App {
        final String label;
        final String packageName;
        App(String label, String packageName) { this.label = label; this.packageName = packageName; }
    }
}
