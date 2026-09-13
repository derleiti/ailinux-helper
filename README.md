# AILinux Helper
Cross-platform device helper for AILinux and TriForce.

**Android · Linux · Windows · macOS · Web/PWA fallback**

`apps/desktop/` contains the tray shell, `apps/android/` the native foreground executor, `features/` reusable capability manifests, and `assets/brand/` the common artwork.

The first module is **Local MCP Workspace** for `https://api.ailinux.me/v1/mcp`. Existing Android application identity and `ailinux-workspace://` links stay compatible during migration; new integrations should use `ailinux-helper://`.

## Branding assets

AILinux Helper 2.89 introduces one canonical app identity for every platform. The editable base mark lives in `assets/brand/ailinux-helper-base.svg`; generated platform assets live under `assets/desktop/` and Android `mipmap-*` resources. Packaging must reference these assets explicitly rather than falling back to Electron/Android defaults.
