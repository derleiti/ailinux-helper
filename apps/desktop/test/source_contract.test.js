'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('renderer is isolated from Node and keeps background timers active', () => {
  assert.match(source, /nodeIntegration:\s*false/);
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /sandbox:\s*true/);
  assert.match(source, /backgroundThrottling:\s*false/);
});

test('workspace browser uses a persistent profile and app suspension blocker', () => {
  assert.match(source, /persist:ailinux-workspace/);
  assert.match(source, /prevent-app-suspension/);
});

test('filesystem permission is restricted to the trusted origin', () => {
  assert.match(source, /'fileSystem'/);
  assert.match(source, /https:\/\/api\.ailinux\.me\/v1\/mcp/);
  assert.match(source, /isTrustedDocument/);
});

test('external navigation and popups are denied', () => {
  assert.match(source, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(source, /will-navigate/);
  assert.match(source, /will-redirect/);
});

test('closing the window hides it instead of stopping the executor', () => {
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /window\.hide\(\)/);
  assert.match(source, /Quit AILinux Helper/);
});


test('desktop helper identifies platform and keeps a clean tray lifecycle', () => {
  assert.match(source, /PLATFORM_LABEL/);
  assert.match(source, /Open AILinux Helper/);
  assert.match(source, /Reconnect workspace/);
  assert.match(source, /Quit AILinux Helper/);
});


test('trusted MCP origin can write clipboard and request wake lock', () => {
  assert.match(source, /clipboard-sanitized-write/);
  assert.match(source, /screen-wake-lock/);
  assert.match(source, /trustedPermissions\.has\(permission\) && isTrustedDocument/);
});


test('desktop tray exposes connection status and notifications', () => {
  assert.match(source, /Status: \${connectionState}/);
  assert.match(source, /pollConnectionState/);
  assert.match(source, /new Notification/);
  assert.match(source, /setInterval\(pollConnectionState, 4000\)/);
});

test('desktop helper ships and loads the branded tray icon', () => {
  assert.match(source, /nativeImage\.createFromPath/);
  assert.match(source, /assets\/desktop\/icon\.png/);
});


test('desktop helper exposes device MCP capabilities through an isolated preload bridge', () => {
  assert.match(source, /preload:\s*path\.join\(__dirname, 'preload\.js'\)/);
  assert.match(source, /ailinux-helper:get-capabilities/);
  assert.match(source, /Share clipboard read/);
  assert.match(source, /Share clipboard write/);
  assert.match(source, /Share screen observation/);
  assert.match(source, /computer_click:\s*false/);
  assert.match(source, /computer_type:\s*false/);
});

test('native helper IPC rejects untrusted renderer origins', () => {
  assert.match(source, /assertTrustedIpc/);
  assert.match(source, /isTrustedDocument\(senderUrl\)/);
});

test('android helper discards expired pair credentials without deleting durable resume state', () => {
  const protocol = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'me', 'ailinux', 'workspace', 'ProtocolClient.java'), 'utf8');
  const stateStore = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'me', 'ailinux', 'workspace', 'StateStore.java'), 'utf8');
  assert.match(protocol, /code==4003/);
  assert.match(protocol, /workspace credential/);
  assert.match(protocol, /state\.clearPairCode\(\)/);
  assert.match(stateStore, /void clearPairCode\(\).*remove\("pair_code"\)/s);
  assert.doesNotMatch(stateStore.match(/void clearPairCode\(\).*?\}/s)?.[0] || '', /resume_token/);
});


test('desktop helper provides native context-menu copy paste and select-all actions', () => {
  assert.match(source, /webContents\.on\('context-menu'/);
  assert.match(source, /role:\s*'copy'/);
  assert.match(source, /role:\s*'paste'/);
  assert.match(source, /role:\s*'selectAll'/);
});

test('desktop pair-code copy uses trusted local UI clipboard bridge without enabling MCP clipboard sharing', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(source, /ailinux-helper:ui-clipboard-write/);
  assert.match(preload, /uiClipboardWrite/);
  assert.match(source, /ailinuxNativeCopy/);
  const handler = source.match(/ipcMain\.handle\('ailinux-helper:ui-clipboard-write'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(handler, /assertTrustedIpc/);
  assert.doesNotMatch(handler, /deviceShare\.clipboardWrite/);
});

test('android helper can explicitly start a fresh pairing and folder changes cannot resurrect a stale code', () => {
  const activity = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'me', 'ailinux', 'workspace', 'MainActivity.java'), 'utf8');
  const service = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'me', 'ailinux', 'workspace', 'WorkspaceService.java'), 'utf8');
  const stateStore = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'me', 'ailinux', 'workspace', 'StateStore.java'), 'utf8');
  assert.match(activity, /Generate new pair code/);
  assert.match(activity, /beginFreshPairing/);
  assert.match(activity, /showPairCode\("",true\)/);
  assert.match(activity, /boolean changed=state\.setTree\(uri\)/);
  assert.match(service, /ACTION_NEW_PAIR/);
  assert.match(service, /startForeground\(8606.*ACTION_NEW_PAIR\.equals\(intent\.getAction\(\)\).*client\.stop\(true\);client\.start\(\)/s);
  assert.match(stateStore, /boolean setTree\(Uri uri\)/);
  assert.match(stateStore, /if \(changed\) editor\.remove\("pair_code"\)\.remove\("resume_token"\)/);
  const protocol = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'me', 'ailinux', 'workspace', 'ProtocolClient.java'), 'utf8');
  assert.match(protocol, /if\(revoke\)\{handoffCode="";state\.clearCredentials\(\);\}/);
});

test('desktop helper exposes a separately released native shell bridge', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(source, /require\('\.\/shell_backends'\)/);
  assert.match(source, /ipcMain\.handle\('ailinux:shell-status'/);
  assert.match(source, /ipcMain\.handle\('ailinux:shell-backend'/);
  assert.match(source, /ipcMain\.handle\('ailinux:shell-release'/);
  assert.match(source, /ipcMain\.handle\('ailinux:shell-revoke'/);
  assert.match(source, /ipcMain\.handle\('ailinux:shell-run'/);
  assert.match(source, /dialog\.showMessageBox/);
  assert.match(source, /dialog\.showOpenDialog/);
  assert.match(preload, /exposeInMainWorld\('ailinuxNative'/);
  assert.match(preload, /setShellBackend/);
  assert.match(preload, /releaseShell/);
  assert.match(preload, /revokeShell/);
  assert.match(preload, /runShell/);
});

test('android helper gates Termux shell capability behind explicit release', () => {
  const root = path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main');
  const protocol = fs.readFileSync(path.join(root, 'java', 'me', 'ailinux', 'workspace', 'ProtocolClient.java'), 'utf8');
  const stateStore = fs.readFileSync(path.join(root, 'java', 'me', 'ailinux', 'workspace', 'StateStore.java'), 'utf8');
  const activity = fs.readFileSync(path.join(root, 'java', 'me', 'ailinux', 'workspace', 'MainActivity.java'), 'utf8');
  const manifest = fs.readFileSync(path.join(root, 'AndroidManifest.xml'), 'utf8');
  const termux = fs.readFileSync(path.join(root, 'java', 'me', 'ailinux', 'workspace', 'TermuxShell.java'), 'utf8');
  assert.match(protocol, /if\(shell\.released\(\)\)out\.put\("shell"\)/);
  assert.match(protocol, /case"shell":return shell\.run/);
  assert.match(stateStore, /setShellReleased/);
  assert.match(activity, /Release terminal to the AI \(Termux\)/);
  assert.match(manifest, /com\.termux\.permission\.RUN_COMMAND/);
  assert.match(manifest, /<package android:name="com\.termux"/);
  assert.match(termux, /terminal not released by the user/);
  assert.match(termux, /RUN_COMMAND_WORKDIR/);
});

test('desktop package explicitly ships the shell backend module', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('shell_backends.js'));
});

test('android Termux result callback is mutable on Android 12 plus', () => {
  const termux = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'me', 'ailinux', 'workspace', 'TermuxShell.java'), 'utf8');
  assert.match(termux, /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S/);
  assert.match(termux, /pendingFlags \|= PendingIntent\.FLAG_MUTABLE/);
  assert.doesNotMatch(termux, /PendingIntent\.FLAG_IMMUTABLE/);
  assert.match(termux, /getBundleExtra\("result"\)/);
});
