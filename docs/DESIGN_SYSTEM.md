# AILinux Helper design system — 2.90.0

The canonical experience starts at `https://api.ailinux.me/v1/mcp`. Native shells use the same visual hierarchy while keeping privileged/local execution native.

## Tokens
- Canvas: `#07111f` / web fallback `#0d1117`
- Surface: `#161b22`
- Border: `#30363d`
- Primary text: `#e6edf3`
- Secondary text: `#b8c1cc`
- Muted text: `#8b949e`
- Cyan accent: `#35d9ff`
- Blue accent: `#4d67ff`
- Purple accent: `#bd5cff`
- Success: `#63d471`
- Warning: `#e3b341`
- Corner radius: cards 16px; controls 8–10px

## Product hierarchy
1. AILinux Helper brand + connection state.
2. One adaptive install/open panel for the current platform.
3. Workspace selection and access mode.
4. Pair/handoff/reconnect state.
5. MCP endpoint and advanced compatibility information.

Do not duplicate a separate Mobile Workspace and Helper download card. The helper panel adapts to Android, iOS/PWA, Linux, Windows and macOS.
