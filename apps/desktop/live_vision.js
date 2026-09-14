'use strict';

/** Low-bandwidth latest-frame cache shared by Linux, Windows and macOS Electron helpers. */
class DesktopLiveVision {
  constructor({ desktopCapturer, screen }) {
    this.desktopCapturer = desktopCapturer;
    this.screen = screen;
    this.active = false;
    this.timer = null;
    this.frame = null;
    this.frameId = 0;
    this.sceneId = 0;
    this.lastHash = '';
    this.boostUntil = 0;
    this.captureBusy = false;
    this.config = { maxEdge: 960, quality: 48, idleFps: 2, activeFps: 10 };
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
    this.noteInteraction();
    await this._capture();
    this._schedule(0);
    return this.status();
  }

  stop() {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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
      source: `electron-desktop-live-vision-${process.platform}`,
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
    return { ...this.frame, fallback: true, source: `electron-desktop-live-vision-${process.platform}` };
  }

  _schedule(delay = null) {
    if (!this.active) return;
    if (this.timer) clearTimeout(this.timer);
    const fps = Date.now() < this.boostUntil ? this.config.activeFps : this.config.idleFps;
    const ms = delay === null ? Math.max(50, Math.round(1000 / fps)) : delay;
    this.timer = setTimeout(async () => {
      this.timer = null;
      try { await this._capture(); } catch {}
      this._schedule();
    }, ms);
    this.timer.unref?.();
  }

  async _capture() {
    if (this.captureBusy) return this.frame;
    this.captureBusy = true;
    try {
      const primary = this.screen.getPrimaryDisplay();
      const native = primary?.size || { width: 1920, height: 1080 };
      const scale = Math.min(1, this.config.maxEdge / Math.max(native.width, native.height));
      const requested = { width: Math.max(1, Math.round(native.width * scale)), height: Math.max(1, Math.round(native.height * scale)) };
      const sources = await this.desktopCapturer.getSources({ types: ['screen'], thumbnailSize: requested, fetchWindowIcons: false });
      if (!sources.length) throw new Error('no screen capture source available');
      const preferred = sources.find(source => String(source.display_id || '') === String(primary?.id || '')) || sources[0];
      const image = preferred.thumbnail;
      const size = image.getSize();
      const jpeg = image.toJPEG(this.config.quality);
      const hash = `${jpeg.length}:${jpeg.subarray(0, Math.min(jpeg.length, 64)).toString('base64')}`;
      this.frameId += 1;
      if (hash !== this.lastHash) this.sceneId += 1;
      this.lastHash = hash;
      this.frame = {
        ok: true,
        mime: 'image/jpeg',
        data: jpeg.toString('base64'),
        width: size.width,
        height: size.height,
        native_width: native.width,
        native_height: native.height,
        frame_id: this.frameId,
        scene_id: this.sceneId,
        timestamp_ms: Date.now(),
        frame_age_ms: 0,
        source: `electron-desktop-live-vision-${process.platform}`,
        scene: { available: false, adapter: process.platform, reason: 'native accessibility adapter not attached yet' },
      };
      return this.frame;
    } finally {
      this.captureBusy = false;
    }
  }
}

module.exports = { DesktopLiveVision };
