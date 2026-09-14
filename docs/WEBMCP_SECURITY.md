# WebMCP security boundary

`apps/web/` is the canonical browser UI for the public TriForce MCP. TriForce serves these files; it must not maintain a second embedded JavaScript copy.

The Electron Helper exposes a privileged preload bridge only to `https://api.ailinux.me`. Because that page can reach local workspace/device capabilities after an explicit user grant, **third-party JavaScript is not trusted on the WebMCP origin**. In particular, Cloudflare Browser Insights (`static.cloudflareinsights.com/beacon.min.js`), Rocket Loader rewrites, tag managers, and arbitrary CDN scripts must not execute on `/v1/mcp*`. The API CSP is the enforcement boundary and should remain `script-src 'self' 'wasm-unsafe-eval'` with no `unsafe-inline` and no third-party origins.

Pyodide is pinned to `v314.0.6` and self-hosted below `apps/web/vendor/pyodide/v314.0.6/`. `release.json` records the version, file sizes and SHA-256 digests. `wasm-unsafe-eval` is required for WebAssembly compilation; broad `unsafe-eval` is not.

`release.json` is the release/deployment source of truth. The trusted release host regenerates it with `scripts/generate-release-manifest.py --version <version> --release-dir <mirror>` only after all expected platform artifacts exist. TriForce refuses to advertise a manifest artifact as available when its mirrored size differs.

## Live edge-mutation evidence (2026-09-14)

A production comparison of the direct TriForce origin (`172.17.0.1:9000`, `Host: api.ailinux.me`) with the public Cloudflare path showed that the origin document contained only the trusted external `/v1/mcp/web/app.js` script, while the edge response contained two additional inline scripts identifying `google_tags_first_party` and `GTM-T5V3HS8B`. The sampled response did **not** contain `static.cloudflareinsights.com/beacon.min.js`, so Browser Insights injection is a threat-model case rather than a claim about that exact sample.

The `/v1/mcp*` CSP deliberately excludes `unsafe-inline` and third-party script origins, so these edge-added inline tag-manager scripts cannot execute in conforming browsers. The preferred Cloudflare configuration is still to disable HTML/script injection and tag-manager transforms for `/v1/mcp*`; CSP is the fail-closed enforcement layer, not permission for edge mutation.
