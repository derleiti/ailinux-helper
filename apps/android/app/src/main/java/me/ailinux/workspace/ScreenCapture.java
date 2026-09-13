package me.ailinux.workspace;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** User-consented Android display capture for the local MCP vision capability. */
final class ScreenCapture {
    private final Context context;
    private final Runnable onProjectionStopped;
    private final HandlerThread thread;
    private final Handler handler;
    private MediaProjection projection;
    private VirtualDisplay virtualDisplay;
    private ImageReader reader;
    private int width;
    private int height;
    private int densityDpi;

    ScreenCapture(Context context, Runnable onProjectionStopped) {
        this.context = context.getApplicationContext();
        this.onProjectionStopped = onProjectionStopped;
        thread = new HandlerThread("ailinux-screen-capture");
        thread.start();
        handler = new Handler(thread.getLooper());
    }

    synchronized boolean isReady() {
        return projection != null && virtualDisplay != null && reader != null;
    }

    synchronized void start(int resultCode, Intent data) throws Exception {
        stopLocked(true);
        MediaProjectionManager manager = (MediaProjectionManager) context.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (manager == null) throw new IllegalStateException("MediaProjection service unavailable");
        MediaProjection next = manager.getMediaProjection(resultCode, data);
        if (next == null) throw new IllegalStateException("screen capture permission was not granted");

        DisplayMetrics metrics = new DisplayMetrics();
        WindowManager windowManager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        if (windowManager == null) throw new IllegalStateException("WindowManager unavailable");
        windowManager.getDefaultDisplay().getRealMetrics(metrics);
        width = Math.max(1, metrics.widthPixels);
        height = Math.max(1, metrics.heightPixels);
        densityDpi = Math.max(1, metrics.densityDpi);

        projection = next;
        final MediaProjection ownedProjection = next;
        projection.registerCallback(new MediaProjection.Callback() {
            @Override public void onStop() {
                synchronized (ScreenCapture.this) {
                    if (projection != ownedProjection) return;
                    releaseDisplayLocked();
                    projection = null;
                }
                if (onProjectionStopped != null) onProjectionStopped.run();
            }
        }, handler);
        reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        virtualDisplay = projection.createVirtualDisplay(
                "AILinuxHelperDisplay",
                width,
                height,
                densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                reader.getSurface(),
                null,
                handler);
        if (virtualDisplay == null) {
            stopLocked(true);
            throw new IllegalStateException("could not create screen capture display");
        }
    }

    synchronized void stop() {
        stopLocked(true);
    }

    synchronized void shutdown() {
        stopLocked(true);
        thread.quitSafely();
    }

    private void stopLocked(boolean intentional) {
        MediaProjection old = projection;
        projection = null;
        releaseDisplayLocked();
        if (old != null) {
            try { old.stop(); } catch (Exception ignored) { }
        }
    }

    private void releaseDisplayLocked() {
        if (virtualDisplay != null) {
            try { virtualDisplay.release(); } catch (Exception ignored) { }
            virtualDisplay = null;
        }
        if (reader != null) {
            try { reader.close(); } catch (Exception ignored) { }
            reader = null;
        }
    }

    JSONObject screenshot() throws Exception {
        final ImageReader current;
        synchronized (this) {
            if (!isReady()) throw new IllegalStateException("display observation is not active");
            current = reader;
        }

        Image image = current.acquireLatestImage();
        if (image == null) {
            CountDownLatch ready = new CountDownLatch(1);
            AtomicReference<Image> captured = new AtomicReference<>();
            current.setOnImageAvailableListener(r -> {
                Image candidate = null;
                try { candidate = r.acquireLatestImage(); } catch (Exception ignored) { }
                if (candidate == null) return;
                if (captured.compareAndSet(null, candidate)) ready.countDown();
                else candidate.close();
            }, handler);
            try {
                if (!ready.await(2500, TimeUnit.MILLISECONDS)) {
                    throw new IllegalStateException("screen capture timed out waiting for a frame");
                }
                image = captured.get();
            } finally {
                current.setOnImageAvailableListener(null, null);
            }
        }
        if (image == null) throw new IllegalStateException("screen capture returned no frame");

        try {
            Image.Plane plane = image.getPlanes()[0];
            ByteBuffer buffer = plane.getBuffer();
            int pixelStride = plane.getPixelStride();
            int rowStride = plane.getRowStride();
            int rowPadding = Math.max(0, rowStride - pixelStride * width);
            int paddedWidth = width + rowPadding / Math.max(1, pixelStride);
            Bitmap padded = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888);
            try {
                padded.copyPixelsFromBuffer(buffer);
                Bitmap cropped = paddedWidth == width ? padded : Bitmap.createBitmap(padded, 0, 0, width, height);
                try {
                    ByteArrayOutputStream output = new ByteArrayOutputStream();
                    if (!cropped.compress(Bitmap.CompressFormat.PNG, 100, output)) {
                        throw new IllegalStateException("screen capture PNG encoding failed");
                    }
                    byte[] png = output.toByteArray();
                    if (png.length == 0 || png.length > 32 * 1024 * 1024) {
                        throw new IllegalStateException("screen capture image is empty or too large");
                    }
                    return new JSONObject()
                            .put("mime", "image/png")
                            .put("data", Base64.encodeToString(png, Base64.NO_WRAP))
                            .put("width", width)
                            .put("height", height)
                            .put("source", "android-mediaprojection");
                } finally {
                    if (cropped != padded) cropped.recycle();
                }
            } finally {
                padded.recycle();
            }
        } finally {
            image.close();
        }
    }
}
