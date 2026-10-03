package me.ailinux.workspace;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Bundle;
import android.content.Intent;
import android.os.Build;
import android.os.PowerManager;
import android.app.KeyguardManager;
import android.media.AudioManager;
import android.content.Context;
import android.view.View;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import org.json.JSONObject;
import org.json.JSONArray;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public final class DeviceControlService extends AccessibilityService {
    private static volatile DeviceControlService active;
    private static volatile long accessibilityEventId = 0L;

    static boolean isReady() { return active != null; }

    static JSONObject execute(JSONObject args) throws Exception {
        DeviceControlService service = active;
        if (service == null) throw new IllegalStateException("Android accessibility control service is not enabled");
        String action = args.optString("action", "").trim().toLowerCase(Locale.ROOT);
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
            case "wake":
            case "wake_screen":
                return service.wakeScreen();
            case "type":
                return service.typeText(args.optString("text", ""));
            case "invoke":
                return service.invokeTarget(args.optString("target_id", ""));
            case "key":
                return service.key(args.optJSONArray("keys"));
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

    private JSONObject key(JSONArray keys) throws Exception {
        if (keys == null || keys.length() == 0) throw new IllegalArgumentException("keys is required for Android key input");
        JSONObject last = null;
        for (int i = 0; i < keys.length(); i++) {
            String raw = keys.optString(i, "").trim();
            if (raw.isEmpty()) continue;
            last = keyOne(raw);
        }
        if (last == null) throw new IllegalArgumentException("keys contains no supported key names");
        return last.put("keys", keys);
    }

    private JSONObject keyOne(String raw) throws Exception {
        String key = raw.trim().toUpperCase(java.util.Locale.ROOT);
        if (key.startsWith("KEYCODE_")) key = key.substring("KEYCODE_".length());
        switch (key) {
            case "DPAD_UP": case "UP": case "ARROWUP":
                return moveFocus(View.FOCUS_UP, key);
            case "DPAD_DOWN": case "DOWN": case "ARROWDOWN":
                return moveFocus(View.FOCUS_DOWN, key);
            case "DPAD_LEFT": case "LEFT": case "ARROWLEFT":
                return moveFocus(View.FOCUS_LEFT, key);
            case "DPAD_RIGHT": case "RIGHT": case "ARROWRIGHT":
                return moveFocus(View.FOCUS_RIGHT, key);
            case "DPAD_CENTER": case "CENTER":
                return activateFocused(key);
            case "ENTER": case "RETURN": case "OK":
                return activateFocusedOrIme(key);
            case "BACK": case "ESC": case "ESCAPE":
                return global(GLOBAL_ACTION_BACK, "back").put("key", key);
            case "HOME":
                return global(GLOBAL_ACTION_HOME, "home").put("key", key);
            case "RECENTS": case "APP_SWITCH":
                return global(GLOBAL_ACTION_RECENTS, "recents").put("key", key);
            case "NOTIFICATIONS":
                return global(GLOBAL_ACTION_NOTIFICATIONS, "notifications").put("key", key);
            case "EXIT":
                return exitTv(key);
            case "TV": case "LIVE_TV":
                return openTvApp(key);
            case "MENU": case "OPTIONS":
                return semanticRemoteAction(key, new String[]{"Menü", "Menu", "Weitere Optionen", "Options"});
            case "GUIDE": case "TV_GUIDE":
                return semanticRemoteAction(key, new String[]{"TV-Guide", "Guide", "Programm"});
            case "SEARCH":
                return semanticRemoteAction(key, new String[]{"Suche", "Suchen", "Search"});
            case "VOLUME_UP": case "VOL_UP":
                return adjustVolume(AudioManager.ADJUST_RAISE, key);
            case "VOLUME_DOWN": case "VOL_DOWN":
                return adjustVolume(AudioManager.ADJUST_LOWER, key);
            case "VOLUME_MUTE": case "MUTE":
                return adjustVolume(AudioManager.ADJUST_TOGGLE_MUTE, key);
            case "CHANNEL_UP": case "CH_UP":
                return semanticRemoteAction(key, new String[]{"Kanal +", "CH+", "Channel up", "Nächster Sender"});
            case "CHANNEL_DOWN": case "CH_DOWN":
                return semanticRemoteAction(key, new String[]{"Kanal -", "CH-", "Channel down", "Vorheriger Sender"});
            case "MEDIA_PLAY_PAUSE": case "PLAY_PAUSE":
                return dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, key);
            case "MEDIA_REWIND": case "REWIND":
                return dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_REWIND, key);
            case "MEDIA_FAST_FORWARD": case "FAST_FORWARD":
                return dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, key);
            case "RECORD":
                return semanticRemoteAction(key, new String[]{"Aufnehmen", "Aufnahme", "Record"});
            case "PROG_RED": case "RED":
                return semanticRemoteAction(key, new String[]{"Rot", "Red"});
            case "PROG_GREEN": case "GREEN":
                return semanticRemoteAction(key, new String[]{"Grün", "Green"});
            case "PROG_YELLOW": case "YELLOW":
                return semanticRemoteAction(key, new String[]{"Gelb", "Yellow"});
            case "PROG_BLUE": case "BLUE":
                return semanticRemoteAction(key, new String[]{"Blau", "Blue"});
            case "TAB":
                return moveFocus(View.FOCUS_FORWARD, key);
            default:
                if (key.length() == 1 && Character.isDigit(key.charAt(0))) return digitKey(key);
                throw new IllegalArgumentException("unsupported Android key: " + raw);
        }
    }

    private JSONObject moveFocus(int direction, String key) throws Exception {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) throw new IllegalStateException("no active accessibility window");
        AccessibilityNodeInfo current = null;
        AccessibilityNodeInfo next = null;
        try {
            current = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (current == null) current = findFocusedNode(root);
            if (current == null) current = findFirstFocusable(root);
            if (current == null) throw new IllegalStateException("no focusable Android TV element is available");
            next = current.focusSearch(direction);
            String strategy = "focus_search";
            if (next == null) {
                next = spatialFocusCandidate(root, current, direction);
                strategy = "spatial_fallback";
            }
            if (next == null) throw new IllegalStateException("no focus target in requested direction: " + key);
            boolean focused = next.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            if (!focused) focused = next.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS);
            if (!focused) throw new IllegalStateException("Android rejected focus move: " + key);
            return new JSONObject().put("ok", true).put("action", "key").put("key", key)
                    .put("focus_moved", true).put("focus_strategy", strategy);
        } finally {
            if (next != null) next.recycle();
            if (current != null) current.recycle();
            root.recycle();
        }
    }

    private JSONObject activateFocusedOrIme(String key) throws Exception {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) throw new IllegalStateException("no active accessibility window");
        AccessibilityNodeInfo editable = null;
        try {
            editable = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (editable == null || !editable.isEditable()) {
                if (editable != null) { editable.recycle(); editable = null; }
                editable = findFocusedEditable(root);
            }
            if (editable != null && Build.VERSION.SDK_INT >= 30) {
                if (!editable.isFocused()) editable.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
                int actionId = AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId();
                if (editable.performAction(actionId)) {
                    return new JSONObject().put("ok", true).put("action", "key").put("key", key)
                            .put("invoked", true).put("invoke_strategy", "ime_enter");
                }
            }
        } finally {
            if (editable != null) editable.recycle();
            root.recycle();
        }
        return activateFocused(key);
    }

    private JSONObject activateFocused(String key) throws Exception {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) throw new IllegalStateException("no active accessibility window");
        AccessibilityNodeInfo current = null;
        try {
            current = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (current == null) current = findFocusedNode(root);
            if (current == null) throw new IllegalStateException("no focused Android TV element is available");
            String strategy = activateNode(current);
            if (strategy == null) throw new IllegalStateException("focused Android TV element is not invokable");
            return new JSONObject().put("ok", true).put("action", "key").put("key", key)
                    .put("invoked", true).put("invoke_strategy", strategy);
        } finally {
            if (current != null) current.recycle();
            root.recycle();
        }
    }

    private static AccessibilityNodeInfo findFocusedNode(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isFocused() || node.isAccessibilityFocused()) return AccessibilityNodeInfo.obtain(node);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            try {
                AccessibilityNodeInfo found = findFocusedNode(child);
                if (found != null) return found;
            } finally {
                child.recycle();
            }
        }
        return null;
    }

    private static AccessibilityNodeInfo findFirstFocusable(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isEnabled() && node.isFocusable()) return AccessibilityNodeInfo.obtain(node);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            try {
                AccessibilityNodeInfo found = findFirstFocusable(child);
                if (found != null) return found;
            } finally {
                child.recycle();
            }
        }
        return null;
    }

    private static AccessibilityNodeInfo spatialFocusCandidate(AccessibilityNodeInfo root, AccessibilityNodeInfo current, int direction) {
        Rect origin = new Rect();
        current.getBoundsInScreen(origin);
        if (origin.isEmpty()) return null;
        ArrayList<AccessibilityNodeInfo> candidates = new ArrayList<>();
        collectFocusCandidates(root, candidates, 0);
        AccessibilityNodeInfo best = null;
        long bestScore = Long.MAX_VALUE;
        int ox = origin.centerX(), oy = origin.centerY();
        for (AccessibilityNodeInfo candidate : candidates) {
            if (candidate.equals(current)) { candidate.recycle(); continue; }
            Rect b = new Rect(); candidate.getBoundsInScreen(b);
            if (b.isEmpty()) { candidate.recycle(); continue; }
            int dx = b.centerX() - ox, dy = b.centerY() - oy;
            int primary, secondary;
            switch (direction) {
                case View.FOCUS_UP: primary = -dy; secondary = Math.abs(dx); break;
                case View.FOCUS_DOWN: primary = dy; secondary = Math.abs(dx); break;
                case View.FOCUS_LEFT: primary = -dx; secondary = Math.abs(dy); break;
                case View.FOCUS_RIGHT: primary = dx; secondary = Math.abs(dy); break;
                default: primary = 1; secondary = Math.abs(dx) + Math.abs(dy); break;
            }
            if (primary <= 0) { candidate.recycle(); continue; }
            long score = (long) primary * 10000L + (long) secondary * 25L + Math.abs((long) dx) + Math.abs((long) dy);
            if (score < bestScore) {
                if (best != null) best.recycle();
                best = candidate; bestScore = score;
            } else candidate.recycle();
        }
        return best;
    }

    private static void collectFocusCandidates(AccessibilityNodeInfo node, List<AccessibilityNodeInfo> out, int depth) {
        if (node == null || depth > 18 || out.size() >= 220) return;
        Rect b = new Rect(); node.getBoundsInScreen(b);
        boolean candidate = node.isEnabled() && node.isVisibleToUser() && !b.isEmpty() &&
                (node.isFocusable() || node.isClickable() || node.isEditable() ||
                 (node.getText() != null && node.getText().length() > 0) ||
                 (node.getContentDescription() != null && node.getContentDescription().length() > 0));
        if (candidate) out.add(AccessibilityNodeInfo.obtain(node));
        for (int i = 0; i < node.getChildCount() && out.size() < 220; i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            try { collectFocusCandidates(child, out, depth + 1); } finally { child.recycle(); }
        }
    }

    private JSONObject openTvApp(String key) throws Exception {
        String packageName = "com.vodafone.vtv.avsb";
        Intent launch = getPackageManager().getLaunchIntentForPackage(packageName);
        if (launch == null) return global(GLOBAL_ACTION_HOME, "home").put("key", key).put("remote_strategy", "home_fallback");
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(launch);
        return new JSONObject().put("ok", true).put("action", "key").put("key", key)
                .put("remote_strategy", "launch_live_tv").put("package", packageName);
    }

    private JSONObject exitTv(String key) throws Exception {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        String pkg = "";
        if (root != null) {
            try {
                CharSequence p = root.getPackageName();
                if (p != null) pkg = p.toString();
            } finally { root.recycle(); }
        }
        if (!"com.vodafone.vtv.avsb".equals(pkg)) return openTvApp(key).put("remote_strategy", "exit_to_live_tv");
        long before = accessibilityEventId;
        if (!performGlobalAction(GLOBAL_ACTION_BACK)) throw new IllegalStateException("Android rejected EXIT back action");
        Thread.sleep(140L);
        if (accessibilityEventId == before) {
            performGlobalAction(GLOBAL_ACTION_BACK);
            Thread.sleep(140L);
        }
        return new JSONObject().put("ok", true).put("action", "key").put("key", key)
                .put("remote_strategy", "exit_back_chain");
    }

    private JSONObject adjustVolume(int direction, String key) throws Exception {
        AudioManager audio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (audio == null) throw new IllegalStateException("Android audio service unavailable");
        audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, AudioManager.FLAG_SHOW_UI);
        return new JSONObject().put("ok", true).put("action", "key").put("key", key)
                .put("remote_strategy", "audio_manager");
    }

    private JSONObject dispatchMediaKey(int keyCode, String key) throws Exception {
        AudioManager audio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (audio == null) throw new IllegalStateException("Android audio service unavailable");
        long now = android.os.SystemClock.uptimeMillis();
        audio.dispatchMediaKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, keyCode, 0));
        audio.dispatchMediaKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_UP, keyCode, 0));
        return new JSONObject().put("ok", true).put("action", "key").put("key", key)
                .put("remote_strategy", "media_key_dispatch");
    }

    private JSONObject semanticRemoteAction(String key, String[] labels) throws Exception {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) throw new IllegalStateException("no active accessibility window");
        AccessibilityNodeInfo target = null;
        try {
            for (String label : labels) {
                target = findNodeByTextOrDescription(root, label);
                if (target == null) continue;
                String strategy = activateNode(target);
                if (strategy != null) return new JSONObject().put("ok", true).put("action", "key")
                        .put("key", key).put("remote_strategy", "semantic_" + strategy).put("matched", label);
                target.recycle(); target = null;
            }
        } finally {
            if (target != null) target.recycle();
            root.recycle();
        }
        throw new IllegalStateException("remote action is not exposed by the current Android TV screen: " + key);
    }

    private JSONObject digitKey(String digit) throws Exception {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) throw new IllegalStateException("no active accessibility window");
        AccessibilityNodeInfo focus = null;
        try {
            focus = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (focus != null && focus.isEditable()) {
                CharSequence current = focus.getText();
                Bundle bundle = new Bundle();
                bundle.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                        (current == null ? "" : current.toString()) + digit);
                if (focus.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle))
                    return new JSONObject().put("ok", true).put("action", "key").put("key", digit)
                            .put("remote_strategy", "editable_digit");
            }
            AccessibilityNodeInfo target = findNodeByTextOrDescription(root, digit);
            if (target != null) {
                try {
                    String strategy = activateNode(target);
                    if (strategy != null) return new JSONObject().put("ok", true).put("action", "key")
                            .put("key", digit).put("remote_strategy", "semantic_" + strategy);
                } finally { target.recycle(); }
            }
        } finally {
            if (focus != null) focus.recycle();
            root.recycle();
        }
        throw new IllegalStateException("digit key is not exposed by the current Android TV screen: " + digit);
    }

    private static AccessibilityNodeInfo findNodeByTextOrDescription(AccessibilityNodeInfo node, String label) {
        if (node == null || label == null) return null;
        String wanted = label.trim();
        CharSequence text = node.getText();
        CharSequence desc = node.getContentDescription();
        if ((text != null && wanted.equalsIgnoreCase(text.toString().trim())) ||
                (desc != null && desc.toString().toLowerCase(Locale.ROOT).contains(wanted.toLowerCase(Locale.ROOT))))
            return AccessibilityNodeInfo.obtain(node);
        List<AccessibilityNodeInfo> hits = node.findAccessibilityNodeInfosByText(label);
        if (hits != null && !hits.isEmpty()) return AccessibilityNodeInfo.obtain(hits.get(0));
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            try {
                AccessibilityNodeInfo found = findNodeByTextOrDescription(child, label);
                if (found != null) return found;
            } finally { child.recycle(); }
        }
        return null;
    }

    private JSONObject wakeScreen() throws Exception {
        JSONObject before = screenState(this);
        if (!before.optBoolean("interactive", true)) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) throw new IllegalStateException("Android power service unavailable");
            @SuppressWarnings("deprecation")
            PowerManager.WakeLock lock = pm.newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP | PowerManager.ON_AFTER_RELEASE,
                    "ailinux-helper:remote-wake");
            lock.acquire(2000L);
            try { Thread.sleep(180L); } finally { if (lock.isHeld()) lock.release(); }
        }
        JSONObject after = screenState(this);
        return new JSONObject().put("ok", true).put("action", "wake")
                .put("was_interactive", before.optBoolean("interactive", true))
                .put("interactive", after.optBoolean("interactive", true))
                .put("keyguard_locked", after.optBoolean("keyguard_locked", false));
    }

    static JSONObject ensureScreenInteractive() throws Exception {
        DeviceControlService service = active;
        if (service == null) throw new IllegalStateException("Android accessibility control service is not enabled");
        return service.wakeScreen();
    }

    private static JSONObject screenState(Context context) throws Exception {
        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        KeyguardManager km = (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
        boolean interactive = pm == null || pm.isInteractive();
        boolean locked = km != null && km.isKeyguardLocked();
        return new JSONObject().put("interactive", interactive).put("keyguard_locked", locked);
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
        float x1 = coordinateAlias(args, "x", "x1", getResources().getDisplayMetrics().widthPixels);
        float y1 = coordinateAlias(args, "y", "y1", getResources().getDisplayMetrics().heightPixels);
        float x2 = coordinate(args, "x2", getResources().getDisplayMetrics().widthPixels);
        float y2 = coordinate(args, "y2", getResources().getDisplayMetrics().heightPixels);
        dispatchLine(x1, y1, x2, y2, boundedDuration(args.optLong("duration_ms", 350), 100, 3000));
    }

    private float coordinateAlias(JSONObject args, String primary, String alias, int maxExclusive) {
        if (args.has(primary)) return coordinate(args, primary, maxExclusive);
        if (args.has(alias)) return coordinate(args, alias, maxExclusive);
        throw new IllegalArgumentException(primary + " (or " + alias + ") is required");
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
        String focusStrategy = "findFocus";
        try {
            focus = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (focus == null || !focus.isEditable()) {
                if (focus != null) { focus.recycle(); focus = null; }
                focus = findFocusedEditable(root);
                focusStrategy = "tree_focused_editable";
            }
            if (focus == null) throw new IllegalStateException("no editable input field is focused");
            Bundle bundle = new Bundle();
            bundle.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
            if (!focus.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle)) {
                focus.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
                if (!focus.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle))
                    throw new IllegalStateException("focused field rejected text input");
                focusStrategy += "+action_focus";
            }
            return new JSONObject().put("ok", true).put("action", "type")
                    .put("characters", text.length()).put("focus_strategy", focusStrategy);
        } finally {
            if (focus != null) focus.recycle();
            root.recycle();
        }
    }

    private static AccessibilityNodeInfo findFocusedEditable(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isEditable() && node.isFocused()) return AccessibilityNodeInfo.obtain(node);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            try {
                AccessibilityNodeInfo found = findFocusedEditable(child);
                if (found != null) return found;
            } finally {
                child.recycle();
            }
        }
        return null;
    }

    static long currentEventId() { return accessibilityEventId; }

    static JSONObject sceneAfterInteraction(long previousEventId, long maxWaitMs) throws Exception {
        long wait = Math.max(0L, Math.min(500L, maxWaitMs));
        long deadline = System.currentTimeMillis() + wait;
        long lastSeen = accessibilityEventId;
        long stableSince = System.currentTimeMillis();
        while (System.currentTimeMillis() < deadline) {
            long current = accessibilityEventId;
            if (current != lastSeen) {
                lastSeen = current;
                stableSince = System.currentTimeMillis();
            }
            if (current != previousEventId && System.currentTimeMillis() - stableSince >= 35L) break;
            Thread.sleep(10L);
        }
        return scene();
    }

    static JSONObject scene() throws Exception {
        DeviceControlService service = active;
        JSONObject out = new JSONObject().put("available", service != null).put("event_id", accessibilityEventId);
        if (service == null) return out;
        JSONObject display = screenState(service);
        out.put("interactive", display.optBoolean("interactive", true));
        out.put("keyguard_locked", display.optBoolean("keyguard_locked", false));
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
                    .put("checkable", node.isCheckable())
                    .put("checked", node.isChecked())
                    .put("selected", node.isSelected())
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
            String strategy = activateNode(target);
            if (strategy == null) throw new IllegalStateException("target does not expose an invokable click action");
            return new JSONObject().put("ok", true).put("action", "invoke").put("target_id", targetId)
                    .put("invoke_strategy", strategy);
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
        return clickNodeOrParentStrategy(node) != null;
    }

    private static String clickNodeOrParentStrategy(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo current = node;
        for (int depth = 0; current != null && depth < 8; depth++) {
            // Some Leanback/Compose virtual nodes report clickable=false even though
            // ACTION_CLICK is implemented. Trust the action result, not the metadata bit.
            boolean clicked = current.performAction(AccessibilityNodeInfo.ACTION_CLICK);
            AccessibilityNodeInfo parent = clicked ? null : current.getParent();
            if (current != node) current.recycle();
            if (clicked) return depth == 0 ? "action_click" : "parent_action_click";
            current = parent;
        }
        if (current != null && current != node) current.recycle();
        return null;
    }

    private String activateNode(AccessibilityNodeInfo node) throws Exception {
        String clicked = clickNodeOrParentStrategy(node);
        if (clicked != null) return clicked;
        if (node.performAction(AccessibilityNodeInfo.ACTION_SELECT)) return "action_select";
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        if (!bounds.isEmpty()) {
            try {
                dispatchLine(bounds.exactCenterX(), bounds.exactCenterY(), bounds.exactCenterX(), bounds.exactCenterY(), 80L);
                return "center_gesture";
            } catch (IllegalStateException ignored) {
                // Preserve fail-closed behavior: only claim success when Android confirms the gesture.
            }
        }
        return null;
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
