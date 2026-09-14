package me.ailinux.workspace;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Bundle;
import android.content.Intent;
import android.os.Build;
import android.view.accessibility.AccessibilityNodeInfo;
import org.json.JSONObject;
import org.json.JSONArray;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public final class DeviceControlService extends AccessibilityService {
    private static volatile DeviceControlService active;
    private static volatile long accessibilityEventId = 0L;

    static boolean isReady() { return active != null; }

    static JSONObject execute(JSONObject args) throws Exception {
        DeviceControlService service = active;
        if (service == null) throw new IllegalStateException("Android accessibility control service is not enabled");
        String action = args.optString("action", "").trim().toLowerCase();
        switch (action) {
            case "tap": case "click":
                service.gesture(args, false);
                return new JSONObject().put("ok", true).put("action", "tap");
            case "long_press":
                service.longPress(args);
                return new JSONObject().put("ok", true).put("action", action);
            case "swipe":
                service.swipe(args);
                return new JSONObject().put("ok", true).put("action", action);
            case "type":
                return service.typeText(args.optString("text", ""));
            case "invoke":
                return service.invokeTarget(args.optString("target_id", ""));
            case "back":
                return service.global(GLOBAL_ACTION_BACK, action);
            case "home":
                return service.global(GLOBAL_ACTION_HOME, action);
            case "recents":
                return service.global(GLOBAL_ACTION_RECENTS, action);
            case "notifications":
                return service.global(GLOBAL_ACTION_NOTIFICATIONS, action);
            default:
                throw new IllegalArgumentException("unsupported Android input action: " + action);
        }
    }

    private JSONObject global(int action, String label) throws Exception {
        if (!performGlobalAction(action)) throw new IllegalStateException("Android rejected global action: " + label);
        return new JSONObject().put("ok", true).put("action", label);
    }

    private void gesture(JSONObject args, boolean ignored) throws Exception {
        float x = coordinate(args, "x", getResources().getDisplayMetrics().widthPixels);
        float y = coordinate(args, "y", getResources().getDisplayMetrics().heightPixels);
        dispatchLine(x, y, x, y, boundedDuration(args.optLong("duration_ms", 80), 40, 1000));
    }

    private void longPress(JSONObject args) throws Exception {
        float x = coordinate(args, "x", getResources().getDisplayMetrics().widthPixels);
        float y = coordinate(args, "y", getResources().getDisplayMetrics().heightPixels);
        dispatchLine(x, y, x, y, boundedDuration(args.optLong("duration_ms", 650), 400, 2000));
    }

    private void swipe(JSONObject args) throws Exception {
        float x1 = coordinate(args, "x", getResources().getDisplayMetrics().widthPixels);
        float y1 = coordinate(args, "y", getResources().getDisplayMetrics().heightPixels);
        float x2 = coordinate(args, "x2", getResources().getDisplayMetrics().widthPixels);
        float y2 = coordinate(args, "y2", getResources().getDisplayMetrics().heightPixels);
        dispatchLine(x1, y1, x2, y2, boundedDuration(args.optLong("duration_ms", 350), 100, 3000));
    }

    private float coordinate(JSONObject args, String name, int maxExclusive) {
        if (!args.has(name)) throw new IllegalArgumentException(name + " is required");
        double value = args.optDouble(name, Double.NaN);
        if (!Double.isFinite(value) || value < 0 || value >= Math.max(1, maxExclusive)) throw new IllegalArgumentException("coordinate outside current display: " + name);
        return (float) value;
    }

    private long boundedDuration(long value, long min, long max) { return Math.max(min, Math.min(max, value)); }

    private void dispatchLine(float x1, float y1, float x2, float y2, long duration) throws Exception {
        Path path = new Path();
        path.moveTo(x1, y1);
        path.lineTo(x2, y2);
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, duration))
                .build();
        CountDownLatch done = new CountDownLatch(1);
        final boolean[] completed = {false};
        boolean accepted = dispatchGesture(gesture, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription g) { completed[0] = true; done.countDown(); }
            @Override public void onCancelled(GestureDescription g) { done.countDown(); }
        }, null);
        if (!accepted) throw new IllegalStateException("Android rejected accessibility gesture");
        if (!done.await(Math.min(5, Math.max(2, duration / 1000 + 2)), TimeUnit.SECONDS) || !completed[0])
            throw new IllegalStateException("Android accessibility gesture did not complete");
    }

    private JSONObject typeText(String raw) throws Exception {
        String text = raw == null ? "" : raw;
        if (text.length() > 65536) text = text.substring(0, 65536);
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) throw new IllegalStateException("no active accessibility window");
        AccessibilityNodeInfo focus = null;
        try {
            focus = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (focus == null || !focus.isEditable()) throw new IllegalStateException("no editable input field is focused");
            Bundle bundle = new Bundle();
            bundle.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
            if (!focus.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle))
                throw new IllegalStateException("focused field rejected text input");
            return new JSONObject().put("ok", true).put("action", "type").put("characters", text.length());
        } finally {
            if (focus != null) focus.recycle();
            root.recycle();
        }
    }

    static JSONObject scene() throws Exception {
        DeviceControlService service = active;
        JSONObject out = new JSONObject().put("available", service != null).put("event_id", accessibilityEventId);
        if (service == null) return out;
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root == null) return out.put("active_window", false);
        try {
            CharSequence pkg = root.getPackageName();
            out.put("active_window", true).put("package", pkg == null ? "" : pkg.toString());
            JSONArray elements = new JSONArray();
            collectScene(root, "0", elements, 0, 220);
            return out.put("elements", elements).put("count", elements.length());
        } finally {
            root.recycle();
        }
    }

    private static void collectScene(AccessibilityNodeInfo node, String path, JSONArray out, int depth, int limit) throws Exception {
        if (node == null || out.length() >= limit || depth > 18) return;
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        CharSequence text = node.getText();
        CharSequence desc = node.getContentDescription();
        CharSequence cls = node.getClassName();
        String viewId = null;
        try { viewId = node.getViewIdResourceName(); } catch (Exception ignored) { }
        boolean meaningful = node.isClickable() || node.isEditable() || node.isScrollable() || node.isFocusable() ||
                (text != null && text.length() > 0) || (desc != null && desc.length() > 0);
        if (meaningful) {
            JSONObject item = new JSONObject()
                    .put("target_id", "a11y:" + path)
                    .put("text", text == null ? "" : clip(text.toString(), 500))
                    .put("description", desc == null ? "" : clip(desc.toString(), 500))
                    .put("class", cls == null ? "" : cls.toString())
                    .put("view_id", viewId == null ? "" : viewId)
                    .put("bounds", new JSONArray().put(bounds.left).put(bounds.top).put(bounds.right).put(bounds.bottom))
                    .put("clickable", node.isClickable())
                    .put("editable", node.isEditable())
                    .put("scrollable", node.isScrollable())
                    .put("focused", node.isFocused())
                    .put("enabled", node.isEnabled());
            out.put(item);
        }
        for (int i = 0; i < node.getChildCount() && out.length() < limit; i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            try { collectScene(child, path + "." + i, out, depth + 1, limit); }
            finally { child.recycle(); }
        }
    }

    private JSONObject invokeTarget(String targetId) throws Exception {
        if (targetId == null || !targetId.startsWith("a11y:")) throw new IllegalArgumentException("target_id must come from vision scene data");
        String path = targetId.substring("a11y:".length());
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) throw new IllegalStateException("no active accessibility window");
        AccessibilityNodeInfo target = null;
        try {
            target = resolvePath(root, path);
            if (target == null) throw new IllegalStateException("target is no longer present; observe the current scene again");
            if (!clickNodeOrParent(target)) throw new IllegalStateException("target does not expose an invokable click action");
            return new JSONObject().put("ok", true).put("action", "invoke").put("target_id", targetId);
        } finally {
            if (target != null && target != root) target.recycle();
            root.recycle();
        }
    }

    private static AccessibilityNodeInfo resolvePath(AccessibilityNodeInfo root, String path) {
        if ("0".equals(path)) return root;
        String[] parts = path.split("\\.");
        if (parts.length == 0 || !"0".equals(parts[0])) return null;
        AccessibilityNodeInfo current = root;
        for (int i = 1; i < parts.length; i++) {
            final int childIndex;
            try { childIndex = Integer.parseInt(parts[i]); }
            catch (NumberFormatException e) { if (current != root) current.recycle(); return null; }
            if (childIndex < 0 || childIndex >= current.getChildCount()) { if (current != root) current.recycle(); return null; }
            AccessibilityNodeInfo next = current.getChild(childIndex);
            if (next == null) { if (current != root) current.recycle(); return null; }
            if (current != root) current.recycle();
            current = next;
        }
        return current;
    }

    private static String clip(String value, int max) {
        if (value == null) return "";
        return value.length() <= max ? value : value.substring(0, max);
    }

    static boolean isForegroundPackage(String packageName) {
        DeviceControlService service = active;
        if (service == null || packageName == null || packageName.isEmpty()) return false;
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root == null) return false;
        try {
            CharSequence current = root.getPackageName();
            return current != null && packageName.contentEquals(current);
        } finally {
            root.recycle();
        }
    }

    static JSONObject launchViaAllApps(String label, String expectedPackage) throws Exception {
        DeviceControlService service = active;
        if (service == null) throw new IllegalStateException("Android accessibility control service is not enabled");
        if (Build.VERSION.SDK_INT < 31) throw new IllegalStateException("Android all-apps accessibility action requires API 31+");
        if (isForegroundPackage(expectedPackage)) {
            return new JSONObject().put("ok", true).put("foreground", true).put("method", "already_foreground");
        }
        if (!service.performGlobalAction(GLOBAL_ACTION_ACCESSIBILITY_ALL_APPS))
            throw new IllegalStateException("Android launcher rejected the all-apps accessibility action");
        Thread.sleep(450);

        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root == null) throw new IllegalStateException("launcher app drawer has no accessibility window");
        try {
            AccessibilityNodeInfo target = findClickableText(root, label);
            if (target == null) {
                AccessibilityNodeInfo search = findEditable(root);
                if (search == null) throw new IllegalStateException("launcher app drawer exposes no searchable accessibility field");
                Bundle text = new Bundle();
                text.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, label);
                if (!search.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, text))
                    throw new IllegalStateException("launcher search field rejected app name");
                Thread.sleep(450);
                AccessibilityNodeInfo filtered = service.getRootInActiveWindow();
                if (filtered == null) throw new IllegalStateException("launcher search results are unavailable");
                try { target = findClickableText(filtered, label); } finally { filtered.recycle(); }
            }
            if (target == null || !clickNodeOrParent(target))
                throw new IllegalStateException("launcher could not click app: " + label);
        } finally {
            root.recycle();
        }

        long deadline = System.currentTimeMillis() + 3000;
        do {
            Thread.sleep(120);
            if (isForegroundPackage(expectedPackage)) {
                Thread.sleep(500);
                if (isForegroundPackage(expectedPackage))
                    return new JSONObject().put("ok", true).put("foreground", true).put("method", "accessibility_all_apps");
            }
        } while (System.currentTimeMillis() < deadline);
        throw new IllegalStateException("launcher opened app but foreground verification failed: " + expectedPackage);
    }

    private static AccessibilityNodeInfo findEditable(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isEditable()) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            AccessibilityNodeInfo found = findEditable(child);
            if (found != null) return found;
        }
        return null;
    }

    private static AccessibilityNodeInfo findClickableText(AccessibilityNodeInfo root, String label) {
        List<AccessibilityNodeInfo> hits = root.findAccessibilityNodeInfosByText(label);
        if (hits == null || hits.isEmpty()) return null;
        String wanted = label == null ? "" : label.trim();
        for (AccessibilityNodeInfo hit : hits) {
            CharSequence text = hit.getText();
            CharSequence desc = hit.getContentDescription();
            if ((text != null && wanted.equalsIgnoreCase(text.toString().trim())) ||
                    (desc != null && wanted.equalsIgnoreCase(desc.toString().trim()))) return hit;
        }
        return hits.get(0);
    }

    private static boolean clickNodeOrParent(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo current = node;
        for (int depth = 0; current != null && depth < 6; depth++) {
            boolean clicked = current.isClickable() && current.performAction(AccessibilityNodeInfo.ACTION_CLICK);
            AccessibilityNodeInfo parent = clicked ? null : current.getParent();
            if (current != node) current.recycle();
            if (clicked) return true;
            current = parent;
        }
        if (current != null && current != node) current.recycle();
        return false;
    }

    private void rebindWorkspaceShare() {
        Intent intent = new Intent(this, WorkspaceService.class).setAction(WorkspaceService.ACTION_RECONNECT);
        try {
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent); else startService(intent);
        } catch (Exception ignored) { }
    }

    @Override protected void onServiceConnected() { active = this; rebindWorkspaceShare(); }
    @Override public void onAccessibilityEvent(android.view.accessibility.AccessibilityEvent event) { accessibilityEventId++; }
    @Override public void onInterrupt() { }
    @Override public void onDestroy() { if (active == this) active = null; rebindWorkspaceShare(); super.onDestroy(); }
}
