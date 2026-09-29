# AILinux Helper

[![Build](https://github.com/derleiti/ailinux-helper/actions/workflows/build.yml/badge.svg?branch=master)](https://github.com/derleiti/ailinux-helper/actions/workflows/build.yml)

**Current release: 2.90.30** · Android · Linux · Windows · macOS · Browser/PWA fallback.

**Development line: 2.90.37** adds the dedicated Android TV target (`me.ailinux.workspace.tv`) while keeping the phone/tablet Android app separate.

AILinux Helper is the endpoint companion for TriForce and Loom. It exposes only the local capabilities a user explicitly shares and keeps device execution separate from the remote control plane.

## Current release artifacts

Release: https://github.com/derleiti/ailinux-helper/releases/tag/v2.90.30

- Android production-signed APK
- Linux AppImage
- Debian/Ubuntu `.deb`
- Windows `.exe`
- macOS `.dmg` and `.zip`
- browser/PWA workspace executor at https://api.ailinux.me/v1/mcp

The Android signing identity is kept outside Git. GitHub CI builds/tests every platform; trusted-host signing is used when repository signing secrets are intentionally unavailable.

## Capabilities

- local workspace read/write through user-selected directory handles
- code/file inspection and scoped edits
- clipboard and screen/device capabilities where explicitly supported
- typed desktop service control
- Docker/disposable-compute integration when installed and explicitly enabled
- reconnectable workspace leases and fresh pairing flows
- `ailinux-helper://` handoff protocol with legacy `ailinux-workspace://` compatibility

## Source layout

```text
apps/desktop/       Electron desktop helper for Linux/Windows/macOS
apps/android/app/    Native Android phone/tablet foreground executor
apps/android/tvapp/  Native Android TV / receiver helper (separate package ID)
apps/web/           Browser/PWA executor and handoff surface
apps/ios/           iOS target notes / compatibility planning
features/           Reusable capability manifests
assets/             Shared branding/platform assets
```

## Development

Desktop:

```bash
cd apps/desktop
npm ci
npm run check
npm run dist:linux   # or dist:win / dist:mac on matching runners
```

Android and Android TV share the Gradle project under `apps/android/` and the common Java/runtime sources. The targets stay installable side-by-side:

```bash
cd apps/android
./gradlew --no-daemon :app:testDebugUnitTest :app:assembleDebug :tvapp:assembleDebug :app:lintDebug :tvapp:lintDebug
```

- Android package: `me.ailinux.workspace`
- Android TV package: `me.ailinux.workspace.tv`

Production signing material must never be committed. Tagged CI builds both APK targets with the same trusted signing contract.

## Public MCP entry point

https://api.ailinux.me/v1/mcp

## License

AILinux-authored Helper source is covered by the AILinux Proprietary Source License. Gradle wrapper files, Electron/Chromium notices and all other third-party components retain their upstream licenses. See `LICENSE` and `NOTICE.md`.
