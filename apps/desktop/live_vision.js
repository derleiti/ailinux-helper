'use strict';

const { BrowserWindow, session } = require('electron');
const path = require('node:path');

const CAPTURE_PARTITION = 'persist:ailinux-live-vision';

/** Low-bandwidth latest-frame cache shared by Linux, Windows and macOS Electron helpers.
 *
 * A single getDisplayMedia stream is kept alive for the lifetime of the Helper.
 * This is critical on Wayland: desktopCapturer.getSources() maps to the XDG
 * ScreenCast portal there and starting it once per frame re-opens the KDE/GNOME
 * source chooser forever. Frames are pulled from the already-authorized stream.
 */
class DesktopLiveVision {
  constructor({ desktopCapturer, screen, onEvent = null }) {
    this.desktopCapturer = desktopCapturer;
    this.screen = screen;
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.active = false;
    this.timer = null;
    this.frame = null;
    this.frameId = 0;
    this.sceneId = 0;
    this.lastHash = '';
    this.boostUntil = 0;
    this.captureBusy = false;
    this.captureWindow = null;
    this.captureSessionConfigured = false;
    this.streamReady = false;
    this.lastError = '';
    this.config = { maxEdge: 960, quality: 48, idleFps: 2, activeFps: 10 };
  }

  _event(type, detail = {}) {
    try { this.onEvent?.(type, detail); } catch {}
  }

  _clamp(v, min, max, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  }

  configure(args = {}) {
    if (args.max_edge !== undefined) this.config.maxEdge = Math.round(this._clamp(args.max_edge, 240, 1920, this.config.maxEdge));
    if (args.quality !== undefined) this.config.quality = Math.round(this._clamp(args.quality, 20, 85, this.config.quality));
    if (args.idle_fps !== undefined) this.config.idleFps = this._clamp(args.idle_fps, 0.25, 8, this.config.idleFps);
    if (args.active_fps !== undefined) this.config.activeFps = this._clamp(args.active_fps, 1, 20, this.config.activeFps);
  }

  async start(args = {}) {
    this.configure(args);
    this.active = true;
    this.lastError = '';
    this.noteInteraction();
    try {
      await this._capture();
    } catch (error) {
      this.active = false;
      this.lastError = String(error?.message || error);
      this._event('capture_error', { error: this.lastError });
      throw error;
    }
    this._schedule(0);
    this._event('vision_started', { backend: 'persistent-display-media' });
    return this.status();
  }

  stop() {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Deliberately keep the authorized MediaStream alive. Restarting Live Vision
    // can then reuse the same portal grant instead of opening another picker.
    this._event('vision_stopped', { stream_retained: this.streamReady });
    return this.status();
  }

  noteInteraction() {
    this.boostUntil = Date.now() + 1600;
    if (this.active) this._schedule(0);
  }

  status() {
    const now = Date.now();
    const primary = this.screen.getPrimaryDisplay();
    return {
      ok: true,
      active: this.active,
      capture_ready: Boolean(this.frame),
      frame_id: this.frameId,
      scene_id: this.sceneId,
      frame_age_ms: this.frame ? Math.max(0, now - this.frame.timestamp_ms) : null,
      width: this.frame?.width || 0,
      height: this.frame?.height || 0,
      native_width: primary?.size?.width || 0,
      native_height: primary?.size?.height || 0,
      encoding: 'image/jpeg',
      quality: this.config.quality,
      max_edge: this.config.maxEdge,
      idle_fps: this.config.idleFps,
      active_fps: this.config.activeFps,
      burst: now < this.boostUntil,
      source: `electron-persistent-display-media-${process.platform}`,
      capture_backend: 'persistent-display-media',
      stream_ready: this.streamReady,
      last_error: this.lastError || '',
      scene: { available: false, adapter: process.platform, reason: 'native accessibility adapter not attached yet' },
    };
  }

  async observe(args = {}) {
    if (!this.active) throw new Error('live vision is stopped; call vision_start first');
    const after = Number.isFinite(Number(args.after_frame_id)) ? Number(args.after_frame_id) : -1;
    const waitMs = Math.round(this._clamp(args.wait_ms, 0, 1500, 0));
    if (!this.frame || (after >= 0 && this.frameId <= after)) {
      await this._capture();
      if (after >= 0 && this.frameId <= after && waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
      if (after >= 0 && this.frameId <= after) await this._capture();
    }
    if (!this.frame) throw new Error('live vision has not produced a frame yet');
    const visual = args.visual !== false;
    const out = { ...this.status(), ...this.frame, changed: after < 0 || this.frameId > after };
    if (!visual) { delete out.data; delete out.mime; }
    return out;
  }

  async screenshot() {
    if (!this.frame || Date.now() - this.frame.timestamp_ms > 1000) await this._capture();
    if (!this.frame) throw new Error('no screen capture source available');
    return { ...this.frame, fallback: true, source: `electron-persistent-display-media-${process.platform}` };
  }

  _schedule(delay = null) {
    if (!this.active) return;
    if (this.timer) clearTimeout(this.timer);
    const fps = Date.now() < this.boostUntil ? this.config.activeFps : this.config.idleFps;
    const ms = delay === null ? Math.max(50, Math.round(1000 / fps)) : delay;
    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this._capture();
      } catch (error) {
        // Never hammer the desktop portal after a revoked/cancelled capture.
        // The old implementation swallowed the error and scheduled another
        // getSources() immediately, creating the observed chooser loop.
        this.lastError = String(error?.message || error);
        this.active = false;
        this._event('capture_error', { error: this.lastError, stopped: true });
        return;
      }
      this._schedule();
    }, ms);
    this.timer.unref?.();
  }

  _configureCaptureSession() {
    if (this.captureSessionConfigured) return;
    const ses = session.fromPartition(CAPTURE_PARTITION);
    ses.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        // Fallback for platforms without a native system picker. This runs once
        // when the MediaStream is created, never in the frame loop.
        const sources = await this.desktopCapturer.getSources({
          types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false,
        });
        callback(sources.length ? { video: sources[0] } : {});
      } catch (error) {
        this._event('capture_source_error', { error: String(error?.message || error) });
        callback({});
      }
    // Electron documents useSystemPicker as a native macOS picker. On Linux,
    // Chromium's getDisplayMedia/desktopCapturer path is what reaches the XDG
    // ScreenCast portal and PipeWire under Wayland, including its user prompt.
    }, { useSystemPicker: process.platform === 'darwin' });
    this.captureSessionConfigured = true;
  }

  async _ensureCaptureStream() {
    if (this.captureWindow && !this.captureWindow.isDestroyed() && this.streamReady) return;
    this._configureCaptureSession();
    if (this.captureWindow && !this.captureWindow.isDestroyed()) {
      try { this.captureWindow.destroy(); } catch {}
    }
    this.captureWindow = new BrowserWindow({
      show: false,
      width: 32,
      height: 32,
      webPreferences: {
        partition: CAPTURE_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        devTools: false,
      },
    });
    this.captureWindow.on('closed', () => {
      this.captureWindow = null;
      this.streamReady = false;
    });
    await this.captureWindow.loadFile(path.join(__dirname, 'capture.html'));
    const meta = await this.captureWindow.webContents.executeJavaScript(`(async () => {
      if (window.__ailinuxStream && window.__ailinuxStream.getVideoTracks().some(t => t.readyState === 'live')) {
        const v = document.getElementById('v');
        return { width: v.videoWidth || 0, height: v.videoHeight || 0, reused: true };
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: true });
      const v = document.getElementById('v');
      window.__ailinuxStream = stream;
      v.srcObject = stream;
      await v.play();
      if (!v.videoWidth || !v.videoHeight) await new Promise(resolve => {
        const done = () => { v.removeEventListener('loadedmetadata', done); resolve(); };
        v.addEventListener('loadedmetadata', done, { once: true });
        setTimeout(done, 1500);
      });
      const track = stream.getVideoTracks()[0];
      track?.addEventListener('ended', () => { window.__ailinuxStreamEnded = true; });
      return { width: v.videoWidth || 0, height: v.videoHeight || 0, reused: false };
    })()`, true);
    this.streamReady = true;
    this._event('capture_stream_ready', meta || {});
  }

  async _capture() {
    if (this.captureBusy) return this.frame;
    this.captureBusy = true;
    try {
      await this._ensureCaptureStream();
      if (!this.captureWindow || this.captureWindow.isDestroyed()) throw new Error('capture renderer unavailable');
      const maxEdge = this.config.maxEdge;
      const quality = this.config.quality / 100;
      const raw = await this.captureWindow.webContents.executeJavaScript(`(() => {
        const stream = window.__ailinuxStream;
        const v = document.getElementById('v');
        if (!stream || window.__ailinuxStreamEnded || !stream.getVideoTracks().some(t => t.readyState === 'live')) {
          throw new Error('screen capture stream ended');
        }
        const nw = v.videoWidth || 0, nh = v.videoHeight || 0;
        if (!nw || !nh) throw new Error('screen capture frame is not ready');
        const scale = Math.min(1, ${maxEdge} / Math.max(nw, nh));
        const width = Math.max(1, Math.round(nw * scale));
        const height = Math.max(1, Math.round(nh * scale));
        const c = document.getElementById('c');
        c.width = width; c.height = height;
        const ctx = c.getContext('2d', { alpha: false });
        ctx.drawImage(v, 0, 0, width, height);
        return { data: c.toDataURL('image/jpeg', ${quality}), width, height, native_width: nw, native_height: nh };
      })()`, true);
      const data = String(raw?.data || '').replace(/^data:image\/jpeg;base64,/, '');
      if (!data) throw new Error('screen capture produced no JPEG data');
      const jpeg = Buffer.from(data, 'base64');
      const hash = `${jpeg.length}:${jpeg.subarray(0, Math.min(jpeg.length, 64)).toString('base64')}`;
      this.frameId += 1;
      if (hash !== this.lastHash) this.sceneId += 1;
      this.lastHash = hash;
      this.lastError = '';
      this.frame = {
        ok: true,
        mime: 'image/jpeg',
        data,
        width: Number(raw.width) || 0,
        height: Number(raw.height) || 0,
        native_width: Number(raw.native_width) || 0,
        native_height: Number(raw.native_height) || 0,
        frame_id: this.frameId,
        scene_id: this.sceneId,
        timestamp_ms: Date.now(),
        frame_age_ms: 0,
        source: `electron-persistent-display-media-${process.platform}`,
        capture_backend: 'persistent-display-media',
        scene: { available: false, adapter: process.platform, reason: 'native accessibility adapter not attached yet' },
      };
      return this.frame;
    } catch (error) {
      this.streamReady = false;
      throw error;
    } finally {
      this.captureBusy = false;
    }
  }

}

module.exports = { DesktopLiveVision };
