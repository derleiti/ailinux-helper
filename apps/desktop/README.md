# AILinux Workspace Desktop Helper

> Current Helper release: **2.90.30**. The desktop component is now branded **AILinux Helper**. `ailinux-helper://` is the primary deep-link scheme; `ailinux-workspace://` remains a compatibility alias.

Cross-platform Electron shell for `https://api.ailinux.me/v1/mcp`. It keeps the trusted MCP workspace page in a persistent Chromium profile and remains available from the system tray when the window is closed.

## Platforms

- Linux: AppImage and Debian package
- Windows: NSIS installer and portable executable
- macOS: DMG and ZIP

The same `ailinux-workspace://` deep-link contract is used by Android and desktop. Only `https://api.ailinux.me/v1/mcp` is allowed inside the application; popups and external navigation are denied. Node integration is disabled and the renderer is sandboxed.

## Development

```bash
npm ci
npm run check
npm start
```

## Build

```bash
npm run dist:linux
npm run dist:win
npm run dist:mac
```

Cross-platform release builds are produced by `.github/workflows/workspace-desktop-helper.yml`. Closing the window hides it to the tray; use **Quit AILinux Workspace** from the tray to terminate it.


## Linux packaging validation (2.90.41)

Run `npm run dist:linux -- --publish never`. The wrapper sets a reproducible
umask and stages the public desktop icon. An afterAllArtifactBuild hook validates each actual DEB produced by the current build, including output directory overrides.
The Linux-only afterPack hook restores ordinary-user read/traverse/execute
access to the packaged application without following symlinks.
The validator checks the actual DEB payload, not just the staging directory:

```sh
python3 ../../scripts/verify-linux-deb.py dist/AILinux-Helper-2.90.41-linux-amd64.deb --version 2.90.41
```

Do not publish an existing version with a changed hash. Keep release.json at
the last verified public release until the candidate has passed ordinary-user
installation, upgrade, native startup and pairing tests and the artifacts
are available through their distribution channels.
