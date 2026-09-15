## 2026-09-15 — AILinux Helper 2.90.30 security + WebMCP release

- Version: 2.90.30, Android versionCode 36.
- P0: Android pairing/resume credentials stay out of URLs/notifications and are protected with AndroidKeyStore AES-GCM.
- WebMCP runtime/handoff/style assets are externalized for strict CSP and self-hosted Pyodide is release-pinned.
- CI preserves vendored Pyodide bytes across platforms.

# AI Change Log

## 2026-09-14 — AILinux Helper 2.90.29 Android reconnect hardening

- Scope: Android workspace transport, durable resume credential storage, network lifecycle, Accessibility capability advertisement, and release metadata.
- Changes: 10-second application heartbeat with a 45-second inbound-silence watchdog; immediate reconnect on network loss; automatic share refresh when Android computer-control readiness changes; atomic persisted resume credential update that removes the bootstrap pair code in the same synchronous write; device share profile reports requested/accessibility-ready/control separately.
- Version: 2.90.29, Android versionCode 35.
- Security: Android and desktop static audit reported no warning/error findings; device control remains explicit-grant + Accessibility gated and fail-closed.
- Verification: desktop source/runtime tests 69/69 passed; npm audit reported 0 vulnerabilities; Android debug compile/package succeeded; asset checks and `git diff --check` passed.
- Recovery: `/home/zombie/workspace/.workspacebackup/retry-20260914-183651/`.
