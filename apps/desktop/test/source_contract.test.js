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

test('android folder changes rebind the live share while fresh pairing stays explicit', () => {
  const activity = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'me', 'ailinux', 'workspace', 'MainActivity.java'), 'utf8');
  const service = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'me', 'ailinux', 'workspace', 'WorkspaceService.java'), 'utf8');
  const stateStore = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'me', 'ailinux', 'workspace', 'StateStore.java'), 'utf8');
  const protocol = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'me', 'ailinux', 'workspace', 'ProtocolClient.java'), 'utf8');
  assert.match(activity, /Generate new pair code/);
  assert.match(activity, /beginFreshPairing/);
  assert.match(activity, /showPairCode\("",true\)/);
  assert.match(activity, /boolean changed=state\.setTree\(uri\)/);
  assert.match(activity, /if\(changed\)rebindShare\("Workspace changed/);
  assert.match(activity, /Stop sharing workspace/);
  assert.match(activity, /ACTION_RECONNECT/);
  assert.match(service, /ACTION_NEW_PAIR/);
  assert.match(service, /ACTION_RECONNECT\.equals\(action\)\)\{client\.stop\(false\);client\.start\(\)/);
  assert.match(service, /ACTION_NEW_PAIR\.equals\(action\)\)\{client\.stop\(true\);client\.start\(\)/);
  const setTree = stateStore.match(/boolean setTree\(Uri uri\)[\s\S]*?return changed;\s*\}/)?.[0] || '';
  assert.match(setTree, /putString\("tree_uri", next\)/);
  assert.doesNotMatch(setTree, /pair_code|resume_token/);
  assert.match(protocol, /if\(revoke\)\{handoffCode="";state\.clearCredentials\(\);\}/);
  assert.match(protocol, /listener\.onPairCode\(""\)/);
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

test('android Termux remains device-local and is never advertised as a public share tool', () => {
  const root = path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main');
  const protocol = fs.readFileSync(path.join(root, 'java', 'me', 'ailinux', 'workspace', 'ProtocolClient.java'), 'utf8');
  const stateStore = fs.readFileSync(path.join(root, 'java', 'me', 'ailinux', 'workspace', 'StateStore.java'), 'utf8');
  const activity = fs.readFileSync(path.join(root, 'java', 'me', 'ailinux', 'workspace', 'MainActivity.java'), 'utf8');
  const manifest = fs.readFileSync(path.join(root, 'AndroidManifest.xml'), 'utf8');
  const termux = fs.readFileSync(path.join(root, 'java', 'me', 'ailinux', 'workspace', 'TermuxShell.java'), 'utf8');
  assert.doesNotMatch(protocol, /out\.put\("shell"\)/);
  assert.doesNotMatch(protocol, /case"shell"/);
  assert.match(stateStore, /setShellReleased/);
  assert.match(activity, /not shared to AI/);
  assert.match(manifest, /com\.termux\.permission\.RUN_COMMAND/);
  assert.match(manifest, /<package android:name="com\.termux"/);
  assert.match(termux, /terminal not released by the user/);
  assert.match(termux, /RUN_COMMAND_WORKDIR/);
});

test('android share profile supports native-only resource advertisement and remote compute preference', () => {
  const root = path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'me', 'ailinux', 'workspace');
  const protocol = fs.readFileSync(path.join(root, 'ProtocolClient.java'), 'utf8');
  const stateStore = fs.readFileSync(path.join(root, 'StateStore.java'), 'utf8');
  const activity = fs.readFileSync(path.join(root, 'MainActivity.java'), 'utf8');
  assert.match(protocol, /if\(state\.tree\(\)!=null\)\{/);
  assert.match(protocol, /boolean nativeCapability=/);
  for (const cap of ['workspace_info','file_read','file_tree','code_read','code_tree','code_search','code_grep','file_ops']) assert.ok(protocol.includes(`.put("${cap}")`), `missing Android read capability: ${cap}`);
  for (const cap of ['file_edit','directory_create','workspace_clear','code_edit']) assert.ok(protocol.includes(`.put("${cap}")`), `missing Android write capability: ${cap}`);
  assert.match(protocol, /state\.resourceAdvertise\(\)/);
  assert.match(protocol, /resources\.put\("inventory",deviceResources\(\)\)/);
  assert.match(protocol, /remote_requested/);
  assert.match(protocol, /state\.tree\(\)==null\?"off":state\.mode\(\)/);
  assert.match(stateStore, /resource_advertise/);
  assert.match(stateStore, /remote_compute/);
  assert.match(stateStore, /visibility/);
  assert.match(activity, /Advertise device CPU \/ RAM metadata/);
  assert.match(activity, /Prefer remote cluster compute/);
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

test('docker control is trusted-IPC gated and locally confirmed', () => {
  // Status is read-only and may be polled; mutating actions must additionally
  // pass a local confirmation dialog, so a page cannot act on its own.
  assert.match(source, /ipcMain\.handle\('ailinux-helper:docker-status'/);
  for (const channel of ['docker-service', 'docker-install']) {
    const handler = source.split(`ipcMain.handle('ailinux-helper:${channel}'`)[1] || '';
    const body = handler.split('});')[0];
    assert.match(body, /assertTrustedIpc\(event\)/, `${channel} must assert trusted IPC`);
    assert.match(body, /confirmPrivilegedAction/, `${channel} must ask for local confirmation`);
  }
});

test('compute is advertised only when docker is released, never by default', () => {
  assert.match(source, /computeAdvertise:\s*false/);
  assert.match(source, /deviceShare\.computeAdvertise && dockerReleased/);
  assert.match(source, /if \(deviceShare\.computeAdvertise && !shellBackends\.backendAvailable\('docker'\)\[0\]\) deviceShare\.computeAdvertise = false;/);
});

test('every device share flag defaults to off', () => {
  const block = source.split('let deviceShare = {')[1].split('};')[0];
  const flags = block.match(/(\w+):\s*(true|false)/g) || [];
  assert.ok(flags.length >= 6, 'expected at least six share flags');
  for (const flag of flags) assert.match(flag, /:\s*false$/, `share flag must default off: ${flag}`);
});


test('typed local service control exposes only allowlisted service operations', () => {
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'service_runtime.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  for (const unit of ['ailinux-workspace-browser.service', 'triforce.service', 'ollama.service']) assert.match(runtime, new RegExp(unit.replace('.', '\\.')));
  assert.match(runtime, /ACTIONS = Object\.freeze\(\['start', 'stop', 'restart'\]\)/);
  assert.match(main, /ailinux-helper:service-list/);
  assert.match(main, /ailinux-helper:service-action/);
  assert.match(main, /unsupported typed service operation/);
  assert.match(preload, /serviceList:/);
  assert.match(preload, /serviceAction:/);
});

test('android vision and clipboard shares are explicit opt-in capabilities', () => {
  const root = path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main');
  const javaRoot = path.join(root, 'java', 'me', 'ailinux', 'workspace');
  const protocol = fs.readFileSync(path.join(javaRoot, 'ProtocolClient.java'), 'utf8');
  const stateStore = fs.readFileSync(path.join(javaRoot, 'StateStore.java'), 'utf8');
  const activity = fs.readFileSync(path.join(javaRoot, 'MainActivity.java'), 'utf8');
  const manifest = fs.readFileSync(path.join(root, 'AndroidManifest.xml'), 'utf8');
  const capture = fs.readFileSync(path.join(javaRoot, 'ScreenCapture.java'), 'utf8');

  for (const cap of ['computer_observe', 'computer_screenshot', 'clipboard_read', 'clipboard_write']) {
    assert.ok(protocol.includes(`out.put("${cap}")`) || protocol.includes(`.put("${cap}")`), `missing Android native capability: ${cap}`);
  }
  assert.match(protocol, /state\.screenObserve\(\).*screenCapture\.isReady\(\)/);
  assert.match(protocol, /state\.clipboardRead\(\)/);
  assert.match(protocol, /state\.clipboardWrite\(\)/);
  assert.match(protocol, /case"computer_observe":case"computer_screenshot"/);
  assert.match(protocol, /case"clipboard_read"/);
  assert.match(protocol, /case"clipboard_write"/);
  assert.match(protocol, /new JSONObject\(\)\.put\("type","image"\).*put\("mimeType",mime\)/);
  assert.match(protocol, /structured\.remove\("data"\)/);

  assert.match(stateStore, /static volatile boolean screenObserveSession = false/);
  assert.doesNotMatch(stateStore, /putBoolean\("screen_observe"/);
  assert.match(stateStore, /clipboard_read/);
  assert.match(stateStore, /clipboard_write/);
  assert.match(activity, /Share display \/ vision observation/);
  assert.match(activity, /Share clipboard read/);
  assert.match(activity, /Share clipboard write/);
  assert.match(activity, /createScreenCaptureIntent/);
  assert.match(manifest, /FOREGROUND_SERVICE_MEDIA_PROJECTION/);
  assert.match(manifest, /specialUse\|mediaProjection/);
  assert.match(capture, /MediaProjectionManager/);
  assert.match(capture, /ImageReader\.newInstance/);
  assert.match(capture, /Bitmap\.CompressFormat\.PNG/);
  assert.match(capture, /Base64\.NO_WRAP/);
});

test('android display projection callbacks cannot revoke a replacement projection', () => {
  const capture = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'me', 'ailinux', 'workspace', 'ScreenCapture.java'), 'utf8');
  assert.match(capture, /final MediaProjection ownedProjection = next/);
  assert.match(capture, /if \(projection != ownedProjection\) return/);
  assert.match(capture, /thread\.quitSafely\(\)/);
});
