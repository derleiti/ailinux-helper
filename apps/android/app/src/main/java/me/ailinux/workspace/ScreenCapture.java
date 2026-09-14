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
import java.util.concurrent.TimeUnit;
import java.util.zip.CRC32;

/**
 * User-consented Android display capture for AILinux Live Vision.
 *
 * MediaProjection stays active after authorization and feeds a small adaptive
 * latest-frame cache. AI observation therefore reads an already encoded frame
 * instead of starting a full-resolution PNG capture for every tool call.
 */
final class ScreenCapture {
    private static final int DEFAULT_MAX_EDGE = 960;
    private static final int DEFAULT_JPEG_QUALITY = 48;
    private static final double DEFAULT_IDLE_FPS = 2.0;
    private static final double DEFAULT_ACTIVE_FPS = 10.0;
    private static final long ACTIVE_BURST_MS = 1600L;

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

    private boolean liveVision = true;
    private boolean forceNextFrame = true;
    private int maxEdge = DEFAULT_MAX_EDGE;
    private int jpegQuality = DEFAULT_JPEG_QUALITY;
    private double idleFps = DEFAULT_IDLE_FPS;
    private double activeFps = DEFAULT_ACTIVE_FPS;
    private long boostUntilMs = 0L;
    private long lastEncodedMs = 0L;
    private long frameId = 0L;
    private long sceneId = 0L;
    private long latestTimestampMs = 0L;
    private long latestHash = Long.MIN_VALUE;
    private int latestWidth = 0;
    private int latestHeight = 0;
    private byte[] latestJpeg;

    ScreenCapture(Context context, Runnable onProjectionStopped) {
        this.context = context.getApplicationContext();
        this.onProjectionStopped = onProjectionStopped;
        thread = new HandlerThread("ailinux-live-vision");
        thread.start();
        handler = new Handler(thread.getLooper());
    }

    synchronized boolean isReady() {
        return projection != null && virtualDisplay != null && reader != null;
    }

    synchronized boolean isVisionActive() {
        return isReady() && liveVision;
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
                    clearFrameLocked();
                }
                if (onProjectionStopped != null) onProjectionStopped.run();
            }
        }, handler);

        reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3);
        reader.setOnImageAvailableListener(this::onImageAvailable, handler);
        virtualDisplay = projection.createVirtualDisplay(
                "AILinuxLiveVision",
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
        liveVision = true;
        forceNextFrame = true;
        boostUntilMs = System.currentTimeMillis() + ACTIVE_BURST_MS;
    }

    private void onImageAvailable(ImageReader source) {
        Image image = null;
        try {
            image = source.acquireLatestImage();
            if (image == null) return;

            final long now = System.currentTimeMillis();
            synchronized (this) {
                if (source != reader || !isReady()) return;
                if (!liveVision && !forceNextFrame) return;
                long interval = frameIntervalMs(now < boostUntilMs ? activeFps : idleFps);
                if (!forceNextFrame && lastEncodedMs > 0 && now - lastEncodedMs < interval) return;
                forceNextFrame = false;
                lastEncodedMs = now;
            }

            EncodedFrame encoded = encodeJpeg(image);
            CRC32 crc = new CRC32();
            crc.update(encoded.bytes);
            long hash = crc.getValue();

            synchronized (this) {
                boolean changed = latestJpeg == null || hash != latestHash ||
                        latestWidth != encoded.width || latestHeight != encoded.height;
                frameId++;
                if (changed) sceneId++;
                latestHash = hash;
                latestJpeg = encoded.bytes;
                latestWidth = encoded.width;
                latestHeight = encoded.height;
                latestTimestampMs = now;
                notifyAll();
            }
        } catch (Exception ignored) {
            // A dropped frame must never tear down the MediaProjection session.
        } finally {
            if (image != null) image.close();
        }
    }

    private EncodedFrame encodeJpeg(Image image) throws Exception {
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
                int edge;
                int quality;
                synchronized (this) {
                    edge = maxEdge;
                    quality = jpegQuality;
                }
                double scale = Math.min(1.0, (double) edge / (double) Math.max(width, height));
                int outWidth = Math.max(1, (int) Math.round(width * scale));
                int outHeight = Math.max(1, (int) Math.round(height * scale));
                Bitmap scaled = (outWidth == width && outHeight == height)
                        ? cropped
                        : Bitmap.createScaledBitmap(cropped, outWidth, outHeight, true);
                try {
                    ByteArrayOutputStream output = new ByteArrayOutputStream();
                    if (!scaled.compress(Bitmap.CompressFormat.JPEG, quality, output))
                        throw new IllegalStateException("live vision JPEG encoding failed");
                    byte[] jpeg = output.toByteArray();
                    if (jpeg.length == 0 || jpeg.length > 8 * 1024 * 1024)
                        throw new IllegalStateException("live vision frame is empty or too large");
                    return new EncodedFrame(jpeg, outWidth, outHeight);
                } finally {
                    if (scaled != cropped) scaled.recycle();
                }
            } finally {
                if (cropped != padded) cropped.recycle();
            }
        } finally {
            padded.recycle();
        }
    }

    synchronized void noteInteraction() {
        boostUntilMs = System.currentTimeMillis() + ACTIVE_BURST_MS;
        forceNextFrame = true;
    }

    synchronized JSONObject visionStart(JSONObject args) throws Exception {
        if (!isReady()) throw new IllegalStateException("display observation is not active");
        if (args != null) {
            if (args.has("max_edge")) maxEdge = clamp(args.optInt("max_edge", maxEdge), 240, 1920);
            if (args.has("quality")) jpegQuality = clamp(args.optInt("quality", jpegQuality), 20, 85);
            if (args.has("idle_fps")) idleFps = clamp(args.optDouble("idle_fps", idleFps), 0.25, 8.0);
            if (args.has("active_fps")) activeFps = clamp(args.optDouble("active_fps", activeFps), 1.0, 20.0);
        }
        liveVision = true;
        forceNextFrame = true;
        boostUntilMs = System.currentTimeMillis() + ACTIVE_BURST_MS;
        return visionStatus();
    }

    synchronized JSONObject visionStop() throws Exception {
        liveVision = false;
        return visionStatus();
    }

    synchronized JSONObject visionStatus() throws Exception {
        long now = System.currentTimeMillis();
        return new JSONObject()
                .put("ok", true)
                .put("active", isReady() && liveVision)
                .put("capture_ready", isReady())
                .put("frame_id", frameId)
                .put("scene_id", sceneId)
                .put("frame_age_ms", latestTimestampMs == 0 ? JSONObject.NULL : Math.max(0, now - latestTimestampMs))
                .put("width", latestWidth)
                .put("height", latestHeight)
                .put("native_width", width)
                .put("native_height", height)
                .put("encoding", "image/jpeg")
                .put("quality", jpegQuality)
                .put("max_edge", maxEdge)
                .put("idle_fps", idleFps)
                .put("active_fps", activeFps)
                .put("burst", now < boostUntilMs)
                .put("source", "android-mediaprojection-live-vision");
    }

    JSONObject observe(JSONObject args) throws Exception {
        long after = args == null ? -1L : args.optLong("after_frame_id", -1L);
        int waitMs = args == null ? 0 : clamp(args.optInt("wait_ms", 0), 0, 1500);
        boolean visual = args == null || args.optBoolean("visual", true);

        synchronized (this) {
            if (!isReady()) throw new IllegalStateException("display observation is not active");
            if (!liveVision) throw new IllegalStateException("live vision is stopped; call vision_start first");
            if (latestJpeg == null) forceNextFrame = true;
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(waitMs);
            while ((latestJpeg == null || (after >= 0 && frameId <= after)) && waitMs > 0) {
                long remainingNs = deadline - System.nanoTime();
                if (remainingNs <= 0) break;
                long remainingMs = Math.max(1, TimeUnit.NANOSECONDS.toMillis(remainingNs));
                wait(remainingMs);
            }
            if (latestJpeg == null) {
                forceNextFrame = true;
                long fallbackDeadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(800);
                while (latestJpeg == null) {
                    long remainingNs = fallbackDeadline - System.nanoTime();
                    if (remainingNs <= 0) break;
                    wait(Math.max(1, TimeUnit.NANOSECONDS.toMillis(remainingNs)));
                }
            }
            if (latestJpeg == null) throw new IllegalStateException("live vision has not produced a frame yet");
            return frameJson(visual, after);
        }
    }

    JSONObject screenshot() throws Exception {
        synchronized (this) {
            if (!isReady()) throw new IllegalStateException("display observation is not active");
            long age = latestTimestampMs == 0 ? Long.MAX_VALUE : System.currentTimeMillis() - latestTimestampMs;
            if (latestJpeg == null || age > 1000) {
                forceNextFrame = true;
                long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(1200);
                while ((latestJpeg == null || System.currentTimeMillis() - latestTimestampMs > 1000)) {
                    long remainingNs = deadline - System.nanoTime();
                    if (remainingNs <= 0) break;
                    wait(Math.max(1, TimeUnit.NANOSECONDS.toMillis(remainingNs)));
                }
            }
            if (latestJpeg == null) throw new IllegalStateException("screen capture returned no frame");
            return frameJson(true, -1L).put("fallback", true);
        }
    }

    private JSONObject frameJson(boolean visual, long afterFrameId) throws Exception {
        long age = latestTimestampMs == 0 ? -1 : Math.max(0, System.currentTimeMillis() - latestTimestampMs);
        JSONObject out = new JSONObject()
                .put("ok", true)
                .put("frame_id", frameId)
                .put("scene_id", sceneId)
                .put("changed", afterFrameId < 0 || frameId > afterFrameId)
                .put("timestamp_ms", latestTimestampMs)
                .put("frame_age_ms", age)
                .put("width", latestWidth)
                .put("height", latestHeight)
                .put("native_width", width)
                .put("native_height", height)
                .put("source", "android-mediaprojection-live-vision");
        if (visual) {
            out.put("mime", "image/jpeg");
            out.put("data", Base64.encodeToString(latestJpeg, Base64.NO_WRAP));
        }
        return out;
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
        clearFrameLocked();
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
            try { reader.setOnImageAvailableListener(null, null); } catch (Exception ignored) { }
            try { reader.close(); } catch (Exception ignored) { }
            reader = null;
        }
    }

    private void clearFrameLocked() {
        latestJpeg = null;
        latestWidth = 0;
        latestHeight = 0;
        latestTimestampMs = 0L;
        latestHash = Long.MIN_VALUE;
        lastEncodedMs = 0L;
        frameId = 0L;
        sceneId = 0L;
        forceNextFrame = true;
    }

    private static long frameIntervalMs(double fps) {
        return Math.max(40L, Math.round(1000.0 / Math.max(0.1, fps)));
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private static double clamp(double value, double min, double max) {
        if (!Double.isFinite(value)) return min;
        return Math.max(min, Math.min(max, value));
    }

    private static final class EncodedFrame {
        final byte[] bytes;
        final int width;
        final int height;
        EncodedFrame(byte[] bytes, int width, int height) {
            this.bytes = bytes;
            this.width = width;
            this.height = height;
        }
    }
}
