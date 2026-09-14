# WebMCP security boundary

`apps/web/` is the canonical browser UI for the public TriForce MCP. TriForce serves these files; it must not maintain a second embedded JavaScript copy.

The Electron Helper exposes a privileged preload bridge only to `https://api.ailinux.me`. Because that page can reach local workspace/device capabilities after an explicit user grant, **third-party JavaScript is not trusted on the WebMCP origin**. In particular, Cloudflare Browser Insights (`static.cloudflareinsights.com/beacon.min.js`), Rocket Loader rewrites, tag managers, and arbitrary CDN scripts must not execute on `/v1/mcp*`. The API CSP is the enforcement boundary and should remain `script-src 'self' 'wasm-unsafe-eval'` with no `unsafe-inline` and no third-party origins.

Pyodide is pinned to `v314.0.6` and self-hosted below `apps/web/vendor/pyodide/v314.0.6/`. `release.json` records the version, file sizes and SHA-256 digests. `wasm-unsafe-eval` is required for WebAssembly compilation; broad `unsafe-eval` is not.

`release.json` is the release/deployment source of truth. The trusted release host regenerates it with `scripts/generate-release-manifest.py --version <version> --release-dir <mirror>` only after all expected platform artifacts exist. TriForce refuses to advertise a manifest artifact as available when its mirrored size differs.
