
package me.ailinux.workspace;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.core.content.ContextCompat;

public final class TVMainActivity extends Activity {
    private static final int SCREEN_CAPTURE = 4101;

    private StateStore state;
    private TextView status;
    private TextView pair;
    private Button controlButton;
    private Button visionButton;

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            String value = intent.getStringExtra("state");
            if (value != null && status != null) status.setText(value);
            String code = intent.getStringExtra("pair_code");
            if (code != null && pair != null) pair.setText(code.isEmpty() ? "No Share ID yet" : code);
        }
    };

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            BugReporter.install(this);
            state = new StateStore(this);
            buildUi();
            handleIntent(getIntent());
            if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 4102);
            }
            refresh();
            AutoUpdater.check(this);
        } catch (Throwable error) {
            showFatal(error);
        }
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        if (intent.getBooleanExtra(MainActivity.EXTRA_REAUTHORIZE_SCREEN, false)) {
            intent.removeExtra(MainActivity.EXTRA_REAUTHORIZE_SCREEN);
            getWindow().getDecorView().post(this::enableVision);
        }
    }

    @Override protected void onResume() {
        super.onResume();
        AutoUpdater.resume(this);
        try {
            IntentFilter filter = new IntentFilter("me.ailinux.workspace.STATE");
            ContextCompat.registerReceiver(this, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
        } catch (Exception ignored) {}
        refresh();
    }

    @Override protected void onPause() {
        try { unregisterReceiver(receiver); } catch (Exception ignored) {}
        super.onPause();
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(56, 42, 56, 42);
        root.setBackgroundColor(0xff0d1117);
        scroll.addView(root);

        TextView brand = label("AILinux · TV endpoint", 18, 0xff79c0ff);
        root.addView(brand);

        TextView title = label("AILinux Helper TV", 34, Color.WHITE);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        root.addView(title);

        TextView intro = label(
                "Receiver build for Android TV. Use the remote control to enable device control, vision and pairing.",
                18, 0xffb8c1cc);
        intro.setPadding(0, 10, 0, 24);
        root.addView(intro);

        controlButton = button("1 · Enable remote device control");
        controlButton.setOnClickListener(v -> enableControl());
        root.addView(controlButton);

        visionButton = button("2 · Enable display / Live Vision");
        visionButton.setOnClickListener(v -> enableVision());
        root.addView(visionButton);

        Button pairButton = button("3 · Generate new Share ID");
        pairButton.setOnClickListener(v -> generatePair());
        root.addView(pairButton);

        pair = label("No Share ID yet", 27, Color.WHITE);
        pair.setGravity(Gravity.CENTER);
        pair.setTextIsSelectable(true);
        pair.setPadding(20, 22, 20, 22);
        pair.setBackgroundColor(0xff161b22);
        root.addView(pair);

        Button reconnect = button("Start / reconnect executor");
        reconnect.setOnClickListener(v -> startExecutor(WorkspaceService.ACTION_RECONNECT));
        root.addView(reconnect);

        Button accessibility = button("Open Android accessibility settings");
        accessibility.setOnClickListener(v -> {
            try { startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)); }
            catch (Exception e) { status.setText("Accessibility settings unavailable: " + safe(e)); }
        });
        root.addView(accessibility);

        status = label("Ready", 17, 0xff63d471);
        status.setPadding(0, 26, 0, 0);
        root.addView(status);

        setContentView(scroll);
    }

    private TextView label(String text, int size, int color) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setPadding(0, 8, 0, 8);
        return view;
    }

    private Button button(String text) {
        Button button = new Button(this);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextSize(18);
        button.setMinHeight(64);
        button.setFocusable(true);
        button.setFocusableInTouchMode(false);
        button.setOnFocusChangeListener((v, focused) -> {
            v.setScaleX(focused ? 1.03f : 1.0f);
            v.setScaleY(focused ? 1.03f : 1.0f);
        });
        button.setNextFocusDownId(View.NO_ID);
        return button;
    }

    private void enableControl() {
        state.setComputerControl(true);
        if (DeviceControlService.isReady()) {
            status.setText("Remote device control is enabled.");
            startExecutor(WorkspaceService.ACTION_RECONNECT);
            refresh();
            return;
        }
        status.setText("Enable AILinux Helper TV in Android Accessibility, then return here.");
        try { startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)); }
        catch (Exception e) { status.setText("Accessibility settings unavailable: " + safe(e)); }
    }

    private void enableVision() {
        MediaProjectionManager manager =
                (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        if (manager == null) {
            status.setText("Android MediaProjection is unavailable on this receiver.");
            return;
        }
        state.setScreenObserveWanted(true);
        status.setText("Confirm screen sharing in the Android system dialog.");
        startActivityForResult(manager.createScreenCaptureIntent(), SCREEN_CAPTURE);
    }

    private void generatePair() {
        if (!(state.computerControl() && DeviceControlService.isReady())
                && !state.screenObserve()) {
            status.setText("Enable remote control or Live Vision first.");
            return;
        }
        state.clearCredentials();
        pair.setText("Requesting Share ID…");
        startExecutor(WorkspaceService.ACTION_NEW_PAIR);
    }

    private void startExecutor(String action) {
        Intent intent = new Intent(this, WorkspaceService.class).setAction(action);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent);
        else startService(intent);
        status.setText("Executor requested…");
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != SCREEN_CAPTURE) return;
        if (resultCode != RESULT_OK || data == null) {
            state.setScreenObserveWanted(false);
            state.setScreenObserve(false);
            status.setText("Display sharing was not granted.");
            refresh();
            return;
        }
        state.setScreenObserveWanted(true);
        state.setScreenObserve(true);
        Intent intent = new Intent(this, WorkspaceService.class)
                .setAction(WorkspaceService.ACTION_ENABLE_SCREEN)
                .putExtra(WorkspaceService.EXTRA_CAPTURE_RESULT, resultCode)
                .putExtra(WorkspaceService.EXTRA_CAPTURE_DATA, data);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent);
        else startService(intent);
        status.setText("Starting Live Vision…");
        refresh();
    }

    private void refresh() {
        if (state == null) return;
        if (pair != null) {
            String code = state.pairCode();
            pair.setText(code == null || code.isEmpty() ? "No Share ID yet" : code);
        }
        if (controlButton != null) {
            controlButton.setText(DeviceControlService.isReady()
                    ? "1 · Remote device control: READY"
                    : "1 · Enable remote device control");
        }
        if (visionButton != null) {
            if (state.screenObserve()) visionButton.setText("2 · Display / Live Vision: ACTIVE");
            else if (state.screenObserveWanted()) visionButton.setText("2 · Display / Live Vision: REAUTHORIZE");
            else visionButton.setText("2 · Enable display / Live Vision");
        }
    }

    private void showFatal(Throwable error) {
        TextView view = new TextView(this);
        view.setTextColor(Color.WHITE);
        view.setBackgroundColor(0xff5b1111);
        view.setTextSize(18);
        view.setPadding(36, 36, 36, 36);
        view.setText("AILinux Helper TV startup failed\n\n"
                + error.getClass().getName() + "\n"
                + safe(error));
        setContentView(view);
    }

    private static String safe(Throwable error) {
        if (error == null || error.getMessage() == null) return "No detail";
        String value = error.getMessage();
        return value.length() > 1800 ? value.substring(0, 1800) : value;
    }
}
