# AILinux Helper architecture
One cross-platform helper for device-local AILinux capabilities. The shared visual/service surface comes from `https://api.ailinux.me/v1/mcp`; privileged operations remain native.

## Layers
1. Shared API/UI: pairing, durable lease, handoff and visual surface.
2. Desktop shell: Electron for Linux/Windows/macOS, trusted origin only, tray resident.
3. Android shell: native foreground service plus SAF filesystem grants.
4. Feature manifests: reusable capabilities independent of platform shell.
5. Compatibility: `ailinux-helper://` is canonical; `ailinux-workspace://` remains a legacy alias.

## Security
No arbitrary origins, no Node renderer integration, explicit local grants, no durable credentials in public URLs, one-shot handoffs, native local-tool execution, explicit capability declarations for new modules.
