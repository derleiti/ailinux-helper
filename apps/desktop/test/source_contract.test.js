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

test('android helper keeps rejected pair code visible and never silently rotates it', () => {
  const protocol = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'me', 'ailinux', 'workspace', 'ProtocolClient.java'), 'utf8');
  const stateStore = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'me', 'ailinux', 'workspace', 'StateStore.java'), 'utf8');
  assert.match(protocol, /pairingCredentialRejected\(int code\).*code==4003\|\|code==4403/s);
  assert.match(protocol, /Pair code invalid or expired · tap Generate new pair code/);
  const closing = protocol.match(/onClosing\(WebSocket socket,int code,String reason\)[\s\S]*?@Override public void onClosed/)?.[0] || '';
  assert.doesNotMatch(closing, /clearPairCode/);
  assert.doesNotMatch(closing, /createPairTicket/);
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
  assert.match(protocol, /if\(state\.remoteCompute\(\)\)out\.put\("compute_execute"\)/);
  assert.match(protocol, /put\("runtime","triforce_docker"\)/);
  assert.match(protocol, /put\("internet","public_only"\)/);
  assert.match(protocol, /put\("workspace_path","~\/workspace"\)/);
  assert.match(activity, /Request isolated TriForce Docker sandbox/);
  assert.match(protocol, /state\.tree\(\)==null\?"off":state\.mode\(\)/);
  assert.match(stateStore, /resource_advertise/);
  assert.match(stateStore, /remote_compute/);
  assert.match(stateStore, /visibility/);
  assert.match(activity, /Advertise device CPU \/ RAM metadata/);
  assert.match(activity, /Request isolated TriForce Docker sandbox/);
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

  for (const cap of ['computer_observe', 'computer_screenshot', 'vision_start', 'vision_status', 'vision_observe', 'vision_stop', 'clipboard_read', 'clipboard_write']) {
    assert.ok(protocol.includes(`out.put("${cap}")`) || protocol.includes(`.put("${cap}")`), `missing Android native capability: ${cap}`);
  }
  assert.match(protocol, /state\.screenObserve\(\).*screenCapture\.isReady\(\)/);
  assert.match(protocol, /state\.clipboardRead\(\)/);
  assert.match(protocol, /state\.clipboardWrite\(\)/);
  assert.match(protocol, /case"computer_observe"/);
  assert.match(protocol, /case"computer_screenshot"/);
  assert.match(protocol, /case"vision_observe"/);
  assert.match(protocol, /screenCapture\.observe\(args\)/);
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
  assert.match(capture, /Bitmap\.CompressFormat\.JPEG/);
  assert.match(capture, /DEFAULT_IDLE_FPS = 2\.0/);
  assert.match(capture, /DEFAULT_ACTIVE_FPS = 10\.0/);
  assert.match(capture, /frameId/);
  assert.match(capture, /sceneId/);
  assert.match(capture, /Base64\.NO_WRAP/);
});

test('android display projection callbacks cannot revoke a replacement projection', () => {
  const capture = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'me', 'ailinux', 'workspace', 'ScreenCapture.java'), 'utf8');
  assert.match(capture, /final MediaProjection ownedProjection = next/);
  assert.match(capture, /if \(projection != ownedProjection\) return/);
  assert.match(capture, /thread\.quitSafely\(\)/);
});


test('desktop compute is advertised through explicit compute_execute and never shell', () => {
  const capabilityHandler = (source.split("ipcMain.handle('ailinux-helper:get-capabilities'")[1] || '').split("ipcMain.handle('ailinux-helper:get-share-profile'")[0] || '';
  assert.match(capabilityHandler, /compute_execute:\s*publicShareProfile\(\)\.compute\.advertise/);
  assert.doesNotMatch(capabilityHandler, /\bshell:\s*publicShareProfile\(\)\.compute\.advertise/);
  assert.match(source, /deviceShare\.computeAdvertise && dockerReleased/);
});


test('desktop compute advertises bounded docker capacity without claiming host GPU access', () => {
  assert.match(source, /function computeResourceDescriptor/);
  assert.match(source, /AILINUX_SHELL_DOCKER_CPUS/);
  assert.match(source, /AILINUX_SHELL_DOCKER_MEMORY/);
  assert.match(source, /max_concurrent:\s*1/);
  assert.match(source, /capabilities:\s*\['container'\]/);
  assert.match(source, /gpu:\s*''/);
  assert.match(source, /vram_mb:\s*0/);
});

test('android SAF preserves requested filenames without text/plain suffix rewriting', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../android/app/src/main/java/me/ailinux/workspace/SafWorkspace.java'), 'utf8');
  assert.match(source, /static String mimeForName\(String name\)/);
  assert.match(source, /application\/octet-stream/);
  assert.match(source, /createFile\(mimeForName\(parts\[i\]\), parts\[i\]\)/);
  assert.doesNotMatch(source, /createFile\("text\/plain", parts\[i\]\)/);
});


test('android helper reconnects on server initiated websocket close', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../android/app/src/main/java/me/ailinux/workspace/ProtocolClient.java'), 'utf8');
  assert.match(source, /onClosing\(WebSocket socket,int code,String reason\)/);
  assert.match(source, /scheduleReconnect\(\"Server disconnected \(\"\+code\+\"\)\"\)/);
  assert.match(source, /socket\.close\(code,reason\)/);
});

test('android remote control is accessibility-gated and fail-closed', () => {
  const root = path.join(__dirname, '../../android/app/src/main');
  const manifest = fs.readFileSync(path.join(root, 'AndroidManifest.xml'), 'utf8');
  const protocol = fs.readFileSync(path.join(root, 'java/me/ailinux/workspace/ProtocolClient.java'), 'utf8');
  const state = fs.readFileSync(path.join(root, 'java/me/ailinux/workspace/StateStore.java'), 'utf8');
  const control = fs.readFileSync(path.join(root, 'java/me/ailinux/workspace/DeviceControlService.java'), 'utf8');
  assert.match(manifest, /\.DeviceControlService/);
  assert.match(manifest, /android\.permission\.BIND_ACCESSIBILITY_SERVICE/);
  assert.match(protocol, /state\.computerControl\(\)&&DeviceControlService\.isReady\(\)/);
  assert.match(protocol, /\.put\("computer_input"\)/);
  assert.match(protocol, /case"computer_input"/);
  assert.match(state, /prefs\.getBoolean\("computer_control", false\)/);
  for (const action of ['tap', 'long_press', 'swipe', 'wake', 'wake_screen', 'type', 'back', 'home', 'recents', 'notifications']) {
    assert.match(control, new RegExp('"' + action + '"'));
  }
  assert.match(control, /coordinateAlias\(args, "x", "x1"/);
  assert.match(control, /coordinateAlias\(args, "y", "y1"/);
  assert.match(control, /put\("interactive", display\.optBoolean\("interactive", true\)\)/);
  assert.match(control, /put\("keyguard_locked", display\.optBoolean\("keyguard_locked", false\)\)/);
  assert.doesNotMatch(control, /Runtime\.getRuntime|ProcessBuilder|Termux|\/bin\/sh/);
});

test('android display control grant mirrors actual accessibility readiness', () => {
  const protocol = fs.readFileSync(path.join(__dirname, '../../android/app/src/main/java/me/ailinux/workspace/ProtocolClient.java'), 'utf8');
  assert.match(protocol, /boolean controlRequested=state\.computerControl\(\)/);
  assert.match(protocol, /boolean accessibilityReady=DeviceControlService\.isReady\(\)/);
  assert.match(protocol, /boolean control=controlRequested&&accessibilityReady/);
  assert.match(protocol, /put\("accessibility_ready",accessibilityReady\)/);
  assert.match(protocol, /put\("control",control\)/);
});


test('desktop live vision keeps one display-media stream instead of reopening the Wayland portal per frame', () => {
  const pkg = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
  const live = fs.readFileSync(path.join(__dirname, '..', 'live_vision.js'), 'utf8');
  assert.match(pkg, /live_vision\.js/);
  assert.match(live, /class DesktopLiveVision/);
  assert.match(live, /idleFps: 2/);
  assert.match(live, /activeFps: 10/);
  assert.match(live, /getDisplayMedia/);
  assert.match(live, /setDisplayMediaRequestHandler/);
  assert.match(live, /useSystemPicker:\s*process\.platform === 'darwin'/);
  assert.match(live, /XDG[\s\S]*ScreenCast[\s\S]*PipeWire/);
  assert.match(live, /window\.__ailinuxStream/);
  assert.match(live, /toDataURL\('image\/jpeg'/);
  assert.match(live, /this\.active = false;[\s\S]*capture_error/);
  assert.match(live, /frameId/);
});

test('desktop Wayland control ships an XDG RemoteDesktop portal adapter and advertises computer_input when available', () => {
  const pkg = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'portable_runtime.js'), 'utf8');
  const portal = fs.readFileSync(path.join(__dirname, '..', 'linux_portal_input.py'), 'utf8');
  assert.match(pkg, /linux_portal_input\.py/);
  assert.match(runtime, /xdg-remote-desktop-portal/);
  assert.match(runtime, /portalComputerInput/);
  assert.match(portal, /org\.freedesktop\.portal\.RemoteDesktop/);
  assert.match(portal, /NotifyPointerMotion/);
  assert.match(portal, /NotifyPointerButton/);
  assert.match(portal, /NotifyKeyboardKeysym/);
});


test('android workspace credentials stay out of websocket URLs and device identity is persistent', () => {
  const root = path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'me', 'ailinux', 'workspace');
  const protocol = fs.readFileSync(path.join(root, 'ProtocolClient.java'), 'utf8');
  const stateStore = fs.readFileSync(path.join(root, 'StateStore.java'), 'utf8');
  const start = protocol.indexOf('private void openSocket(String key,String code)');
  const end = protocol.indexOf('@Override public void onOpen', start);
  const socket = start >= 0 && end > start ? protocol.slice(start, end) : '';
  assert.doesNotMatch(socket, /[?&](?:pair_code|handoff_code)=/);
  assert.match(socket, /X-AILinux-Pair-Code/);
  assert.match(socket, /X-AILinux-Handoff-Code/);
  assert.match(socket, /X-AILinux-Machine-Id/);
  assert.match(socket, /state\.machineId\(\)/);
  assert.match(stateStore, /String machineId\(\)/);
  assert.match(stateStore, /UUID\.randomUUID\(\)/);
  assert.match(stateStore, /putString\("machine_id", value\)/);
});


test('android executor retries a transport that never completes the protocol handshake', () => {
  const protocol = fs.readFileSync(path.join(__dirname, '../../android/app/src/main/java/me/ailinux/workspace/ProtocolClient.java'), 'utf8');
  assert.match(protocol, /startHandshakeWatchdog\(socket\)/);
  assert.match(protocol, /Protocol handshake timed out · reconnecting/);
  assert.match(protocol, /socket\.cancel\(\)/);
  assert.match(protocol, /scheduleReconnect\("Protocol handshake timeout"\)/);
});


// ---------------------------------------------------------------------------
// P0 guardrails: pairing credentials must never reach a URL or a notification.
// These are source-level guardrails, not semantic tests. main.js cannot be
// required outside Electron (its top level calls app.*), so behaviour is
// asserted on the source contract until an Electron smoke test exists.
// ---------------------------------------------------------------------------

test('deep links never promote a pair code into an HTTPS request target', () => {
  // The old shape was: url.searchParams.set('pair_code', ...) on the navigation
  // target. That leaks the credential into browser history, the Referer header
  // and every reverse-proxy access log on the way to api.ailinux.me.
  assert.doesNotMatch(source, /searchParams\.set\(\s*['"](?:pair_code|code|resume_token|workspace_token|handoff_code)['"]/);
  assert.match(source, /function deepLinkFromArgv\(argv\)/);
  // The navigation target is rebuilt with an emptied query and fragment.
  assert.match(source, /base\.search\s*=\s*''/);
  assert.match(source, /base\.hash\s*=\s*''/);
});

test('a deep-link pair code is handed over once through the preload contract', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(source, /ailinux-helper:consume-pair-code/);
  assert.match(preload, /ailinux-helper:consume-pair-code/);
  assert.match(preload, /consumePairCode/);

  // The handler must be sender-validated like every other privileged channel.
  const start = source.indexOf("ipcMain.handle('ailinux-helper:consume-pair-code'");
  assert.ok(start >= 0, 'consume-pair-code handler is missing');
  const handler = source.slice(start, start + 400);
  assert.match(handler, /assertTrustedIpc\(event\)/);

  // One-shot: the slot is cleared on read so the credential cannot be replayed.
  assert.match(source, /function consumePendingPairCode\(\)/);
  assert.match(source, /pendingPairCode\s*=\s*null;\s*\n\s*return code/);
});

test('android never renders the pairing credential into a notification', () => {
  const service = fs.readFileSync(path.join(__dirname, '../../android/app/src/main/java/me/ailinux/workspace/WorkspaceService.java'), 'utf8');
  const protocol = fs.readFileSync(path.join(__dirname, '../../android/app/src/main/java/me/ailinux/workspace/ProtocolClient.java'), 'utf8');

  // Notifications are mirrored to the lock screen and Notification History.
  assert.doesNotMatch(service, /notification\("Pair code · "\+code\)/);
  assert.match(service, /Pair code ready · open the app/);
  assert.match(service, /Waiting for pairing/);

  // onState() feeds the same notification, so it must not carry the code either.
  assert.doesNotMatch(protocol, /onState\("Waiting for AI pairing · "\+code\)/);
  assert.match(protocol, /Waiting for AI pairing · open the app for the code/);

  // The code still reaches the app UI over the package-private broadcast.
  assert.match(service, /putExtra\("pair_code",code\)/);
});


test('android workspace credentials use AndroidKeyStore AES-GCM and migrate without plaintext fallback', () => {
  const store = fs.readFileSync(path.join(__dirname, '../../android/app/src/main/java/me/ailinux/workspace/StateStore.java'), 'utf8');
  const secure = fs.readFileSync(path.join(__dirname, '../../android/app/src/main/java/me/ailinux/workspace/SecureCredentialStore.java'), 'utf8');
  assert.match(secure, /AndroidKeyStore/);
  assert.match(secure, /AES\/GCM\/NoPadding/);
  assert.match(secure, /setRandomizedEncryptionRequired\(true\)/);
  assert.match(secure, /setKeySize\(256\)/);
  assert.match(store, /migrateLegacyCredentials\(\)/);
  assert.match(store, /credentials\.put\("resume_token"/);
  assert.match(store, /credentials\.put\("pair_code"/);
  assert.doesNotMatch(store, /String pairCode\(\) \{ return prefs\.getString\("pair_code"/);
  assert.doesNotMatch(store, /String resumeToken\(\) \{ return prefs\.getString\("resume_token"/);
  assert.match(store, /legacy plaintext is never returned as a fallback/);
});
