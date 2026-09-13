# AILinux Helper feature roadmap

## Core runtime
- Connection state machine: connected, reconnecting, suspended, offline.
- Durable lease independent from physical transport.
- Native connection notifications and quick actions.
- Auto-start/launch-at-login where the platform permits it.
- Update manifest and platform-specific release channels.
- Diagnostics bundle with redacted logs, last disconnect cause and reconnect history.

## Workspace
- Local file/code executor with explicit read/write grants.
- Multiple saved workspace profiles.
- Per-workspace permission/mode indicator.
- Safe destructive-operation journal and recovery metadata.

## Future helper modules
- Local terminal executor with explicit opt-in and policy profile.
- Notification bridge between TriForce and the device.
- Local model discovery/runtime bridge.
- Desktop MCP device sharing: clipboard read/write and screen observation are explicit, independent opt-ins in the native Helper tray.
- Mouse/keyboard control remains disabled until a native accessibility/UI-automation backend can enforce per-capability consent.
- Desktop application integration (GIMP, share sheet and future app adapters).
- Device health/status telemetry with explicit opt-in.
- Secure file drop / local share handoff.
- Camera/scanner/OCR bridge on mobile.

## Platform truth
Desktop and Android can keep a visible user-authorized service active. iOS cannot guarantee an arbitrary persistent socket after suspension or force-quit, so it must preserve logical lease state and reconnect when the OS resumes the app. Web/PWA is always best-effort.
