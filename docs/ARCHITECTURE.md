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

## MCP tool namespace

AILinux Helper owns the canonical `aihelper_*` MCP namespace. New model-facing
catalogues use names such as `aihelper_pair`, `aihelper_observe`,
`aihelper_vision_observe` and `aihelper_input`. Shipped Android/desktop clients
may continue advertising the historical wire capabilities (`computer_observe`,
`vision_observe`, `computer_input`, etc.); TriForce translates those names at the
share boundary. This lets Android, Linux, Windows and macOS helpers roll forward
independently without exposing duplicate schemas to an AI.

`aihelper_pair` is the single model-facing lifecycle control and supports
`status`, `pair`, `reconnect` and explicit `disconnect`/lease revocation. Device,
vision, clipboard and compute execution remain gated by the user's share manifest.


## Canonical MCP namespace

The model-facing `/v1/mcp` contract uses the `aihelper_*` namespace for Helper-owned operations. The transport executors intentionally keep accepting/advertising the established wire capabilities (`computer_observe`, `computer_input`, `vision_*`, `clipboard_*`, `compute_execute`, and device/app/process/service/window operations). TriForce translates between the two at the workspace bridge. This gives Android, Linux, Windows and macOS rolling-upgrade compatibility without exposing duplicate schemas to the AI.

`aihelper_pair` owns the share lifecycle at MCP level: `status`, one-time `pair`, durable `reconnect`, and explicit `disconnect`/revoke when the user requests it. Pair/resume secrets remain inside the normal lease protocol; Helper executors do not need a second secret path.
