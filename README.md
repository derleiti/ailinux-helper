# AILinux Helper
Cross-platform device helper for AILinux and TriForce.

**Android · Linux · Windows · macOS · Web/PWA fallback**

`apps/desktop/` contains the tray shell, `apps/android/` the native foreground executor, `features/` reusable capability manifests, and `assets/brand/` the common artwork.

The first module is **Local MCP Workspace** for `https://api.ailinux.me/v1/mcp`. Existing Android application identity and `ailinux-workspace://` links stay compatible during migration; new integrations should use `ailinux-helper://`.
