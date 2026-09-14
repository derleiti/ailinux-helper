package me.ailinux.workspace;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.os.Bundle;
import android.content.Intent;
import android.os.Build;
import android.view.accessibility.AccessibilityNodeInfo;
import org.json.JSONObject;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public final class DeviceControlService extends AccessibilityService {
    private static volatile DeviceControlService active;

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
        float x = coordinate(args, "x");
        float y = coordinate(args, "y");
        dispatchLine(x, y, x, y, boundedDuration(args.optLong("duration_ms", 80), 40, 1000));
    }

    private void longPress(JSONObject args) throws Exception {
        float x = coordinate(args, "x");
        float y = coordinate(args, "y");
        dispatchLine(x, y, x, y, boundedDuration(args.optLong("duration_ms", 650), 400, 2000));
    }

    private void swipe(JSONObject args) throws Exception {
        float x1 = coordinate(args, "x");
        float y1 = coordinate(args, "y");
        float x2 = coordinate(args, "x2");
        float y2 = coordinate(args, "y2");
        dispatchLine(x1, y1, x2, y2, boundedDuration(args.optLong("duration_ms", 350), 100, 3000));
    }

    private float coordinate(JSONObject args, String name) {
        if (!args.has(name)) throw new IllegalArgumentException(name + " is required");
        double value = args.optDouble(name, Double.NaN);
        if (!Double.isFinite(value) || value < 0 || value > 20000) throw new IllegalArgumentException("invalid coordinate: " + name);
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

    private void rebindWorkspaceShare() {
        Intent intent = new Intent(this, WorkspaceService.class).setAction(WorkspaceService.ACTION_RECONNECT);
        try {
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent); else startService(intent);
        } catch (Exception ignored) { }
    }

    @Override protected void onServiceConnected() { active = this; rebindWorkspaceShare(); }
    @Override public void onAccessibilityEvent(android.view.accessibility.AccessibilityEvent event) { }
    @Override public void onInterrupt() { }
    @Override public void onDestroy() { if (active == this) active = null; rebindWorkspaceShare(); super.onDestroy(); }
}
