'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, Notification, powerSaveBlocker, session, shell, clipboard, desktopCapturer, ipcMain, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const shellBackends = require('./shell_backends');
const dockerRuntime = require('./docker_runtime');
const serviceRuntime = require('./service_runtime');

const APP_NAME = 'AILinux Helper';
const START_URL = 'https://api.ailinux.me/v1/mcp';
const ALLOWED_ORIGIN = new URL(START_URL).origin;
const SESSION_PARTITION = 'persist:ailinux-workspace';
const PROTOCOLS = ['ailinux-helper', 'ailinux-workspace'];
const startHidden = process.argv.includes('--background');
const PLATFORM_LABEL = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
let designTokens = {};
try { designTokens = JSON.parse(fs.readFileSync(path.join(__dirname, 'design-tokens.json'), 'utf8')); } catch {}
const DARK_TOKENS = designTokens?.modes?.dark || {};
const NATIVE_BACKGROUND = DARK_TOKENS.background || '#071018';

let window = null;
let tray = null;
let quitting = false;
let powerBlockerId = null;
let pendingDeepLink = null;
let connectionState = 'Starting';
let lastNotifiedState = '';
let statusTimer = null;

let deviceShare = {
  clipboardRead: false,
  clipboardWrite: false,
  screenObserve: false,
  resourceAdvertise: false,
  computeAdvertise: false,
  mcpAdvertise: false,
};

function deviceSharePath() {
  return path.join(app.getPath('userData'), 'mcp-device-share.json');
}

function loadDeviceShare() {
  try {
    const raw = JSON.parse(fs.readFileSync(deviceSharePath(), 'utf8'));
    deviceShare = {
      clipboardRead: raw.clipboardRead === true,
      clipboardWrite: raw.clipboardWrite === true,
      screenObserve: raw.screenObserve === true,
      resourceAdvertise: raw.resourceAdvertise === true,
      computeAdvertise: raw.computeAdvertise === true,
      mcpAdvertise: raw.mcpAdvertise === true,
    };
  } catch {}
}

function saveDeviceShare() {
  try {
    fs.mkdirSync(path.dirname(deviceSharePath()), { recursive: true });
    const tmp = `${deviceSharePath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(deviceShare, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, deviceSharePath());
  } catch {}
}


function dockerMemoryMb(value) {
  const text = String(value || '2g').trim().toLowerCase();
  const match = text.match(/^([0-9]+(?:\.[0-9]+)?)([kmgt]?)b?$/);
  if (!match) return 2048;
  const amount = Number(match[1]);
  const scale = { '': 1 / (1024 * 1024), k: 1 / 1024, m: 1, g: 1024, t: 1024 * 1024 }[match[2]];
  return Math.max(1, Math.round(amount * scale));
}

function computeResourceDescriptor(available, released) {
  const cores = Math.max(1, os.cpus().length);
  const cpuLimit = Math.max(0.1, Number(process.env.AILINUX_SHELL_DOCKER_CPUS || 2) || 2);
  const load = process.platform === 'win32' ? 0 : Math.min(1, Math.max(0, (os.loadavg()[0] || 0) / cores));
  const id = ('docker-' + os.hostname()).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 96);
  return {
    resource_id: id || 'docker-local',
    node_id: os.hostname(),
    runtime: 'docker',
    cpu_cores: cpuLimit,
    memory_mb: dockerMemoryMb(process.env.AILINUX_SHELL_DOCKER_MEMORY || '2g'),
    gpu: '',
    vram_mb: 0,
    models: [],
    capabilities: ['container'],
    max_concurrent: 1,
    healthy: available,
    load,
    available: available && released,
  };
}


function publicShareProfile() {
  const docker = shellBackends.backendAvailable('docker');
  const shellState = shellBackends.status();
  // A docker binary on PATH is not a running engine. If the last detection saw
  // the daemon down, compute must not be advertised even when it was released.
  const engineState = dockerRuntime.cachedEngine();
  const engineDown = Boolean(engineState) && engineState.engine !== dockerRuntime.ENGINE_RUNNING;
  const dockerReleased = docker[0] === true && shellState.released === true && shellState.backend === 'docker' && !engineDown;
  return {
    visibility: 'private',
    workspace: { enabled: true, mode: 'selected-in-webapp' },
    clipboard: { read: deviceShare.clipboardRead, write: deviceShare.clipboardWrite },
    display: { observe: deviceShare.screenObserve, control: false },
    resources: { advertise: deviceShare.resourceAdvertise },
    compute: { advertise: deviceShare.computeAdvertise && dockerReleased, ...computeResourceDescriptor(docker[0] === true && !engineDown, dockerReleased), engine: engineState ? engineState.engine : 'unknown', released: dockerReleased, workspaceMode: shellState.workspaceMode || 'read_only', detail: dockerReleased ? shellState.workspace : (engineDown ? engineState.detail : docker[1]) },
    mcp: { advertise: deviceShare.mcpAdvertise },
  };
}

async function publicResourceInventory() {
  const profile = publicShareProfile();
  if (!deviceShare.resourceAdvertise) return { shared: false };
  let gpu = {};
  try { gpu = await app.getGPUInfo('basic'); } catch {}
  return {
    shared: true,
    platform: process.platform,
    arch: process.arch,
    cpu: { logical_cores: os.cpus().length, model: os.cpus()[0]?.model || '' },
    memory: { total_bytes: os.totalmem(), free_bytes: os.freemem() },
    displays: screen.getAllDisplays().map((d) => ({ id: String(d.id), width: d.size.width, height: d.size.height, scale_factor: d.scaleFactor })),
    gpu,
    compute: profile.compute,
  };
}

function updateDeviceShare(patch = {}) {
  const allowed = ['clipboardRead', 'clipboardWrite', 'screenObserve', 'resourceAdvertise', 'computeAdvertise', 'mcpAdvertise'];
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(patch, key)) deviceShare[key] = patch[key] === true;
  if (deviceShare.computeAdvertise && !shellBackends.backendAvailable('docker')[0]) deviceShare.computeAdvertise = false;
  saveDeviceShare();
  rebuildTrayMenu();
  try { window?.webContents?.send('ailinux:share-profile-changed', publicShareProfile()); } catch {}
  return publicShareProfile();
}

async function confirmPrivilegedAction(action, detail) {
  try {
    const answer = await dialog.showMessageBox(window || null, {
      type: 'warning', buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0,
      title: APP_NAME, message: 'Allow the Helper to ' + action + '?', detail: String(detail || ''),
    });
    return answer.response === 1;
  } catch {
    return false;
  }
}

function trustedIpc(event) {
  const senderUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
  return isTrustedDocument(senderUrl);
}

function assertTrustedIpc(event) {
  if (!trustedIpc(event)) throw new Error('untrusted helper renderer');
}

function broadcastShellState(state) {
  try { window?.webContents?.send('ailinux:shell-changed', state); } catch {}
  rebuildTrayMenu();
}

async function releaseHostShell() {
  const state = shellBackends.status();
  if (!state.available) return state;
  const confirmed = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['Cancel', 'Choose folder and release'],
    defaultId: 0,
    cancelId: 0,
    title: 'Release terminal to the AI',
    message: 'Give the AI a terminal on this computer?',
    detail: `Backend: ${state.label}\n`
      + `${state.sandboxed ? 'Commands run inside a sandbox.' : 'Commands run with your user account, without a sandbox.'}\n\n`
      + 'Choose the shell workspace separately. Commands are confined to that folder, while the shared file workspace can remain a different folder.',
  });
  if (confirmed.response !== 1) return shellBackends.status();
  const picked = await dialog.showOpenDialog(window, {
    title: 'Folder exposed to the released terminal',
    properties: ['openDirectory'],
  });
  if (picked.canceled || !picked.filePaths.length) return shellBackends.status();
  // Read-only is the safe default; read/write must be chosen deliberately.
  const access = await dialog.showMessageBox(window, {
    type: 'question', buttons: ['Read only', 'Read/Write', 'Cancel'], defaultId: 0, cancelId: 2,
    title: APP_NAME, message: 'How may compute access this folder?',
    detail: 'Read only mounts the folder immutably inside the disposable container. Read/Write lets commands modify files on this device.',
  });
  if (access.response === 2) return shellBackends.status();
  const granted = shellBackends.grantRelease(picked.filePaths[0], { mode: access.response === 1 ? 'read_write' : 'read_only' });
  broadcastShellState(granted);
  if (Notification.isSupported()) {
    new Notification({ title: APP_NAME, body: `Terminal released: ${granted.label} (${granted.workspaceMode})\n${granted.workspace}`, silent: true }).show();
  }
  return granted;
}

function registerHelperIpc() {
  ipcMain.handle('ailinux-helper:get-capabilities', (event) => {
    assertTrustedIpc(event);
    return {
      platform: PLATFORM_LABEL,
      clipboard_read: deviceShare.clipboardRead,
      clipboard_write: deviceShare.clipboardWrite,
      computer_screenshot: deviceShare.screenObserve,
      computer_observe: deviceShare.screenObserve,
      computer_click: false,
      computer_type: false,
      compute_execute: publicShareProfile().compute.advertise,
      share_profile: publicShareProfile(),
    };
  });
  ipcMain.handle('ailinux-helper:get-share-profile', (event) => {
    assertTrustedIpc(event);
    return publicShareProfile();
  });
  ipcMain.handle('ailinux-helper:set-share-profile', (event, patch) => {
    assertTrustedIpc(event);
    return updateDeviceShare(patch && typeof patch === 'object' ? patch : {});
  });
  ipcMain.handle('ailinux-helper:get-resource-inventory', async (event) => {
    assertTrustedIpc(event);
    return publicResourceInventory();
  });
  // Docker is required for compute only. Status is read-only; every mutating
  // action needs a local confirmation dialog on top of the trusted-IPC check,
  // so a page can never start, stop or install anything on its own.
  ipcMain.handle('ailinux-helper:docker-status', async (event) => {
    assertTrustedIpc(event);
    return dockerRuntime.detect();
  });
  ipcMain.handle('ailinux-helper:docker-service', async (event, action) => {
    assertTrustedIpc(event);
    const name = String(action || '');
    if (!dockerRuntime.SERVICE_ACTIONS.includes(name)) return { ok: false, error: 'unsupported service action: ' + name };
    const allowed = await confirmPrivilegedAction(name + ' the Docker engine', 'The Docker service on this device will be changed. Running containers may be affected.');
    if (!allowed) return { ok: false, action: name, error: 'cancelled by user' };
    const result = await dockerRuntime.serviceAction(name);
    rebuildTrayMenu();
    return result;
  });
  ipcMain.handle('ailinux-helper:docker-install', async (event) => {
    assertTrustedIpc(event);
    const plan = dockerRuntime.installPlan();
    if (!plan.supported) return { ok: false, manual: true, error: plan.hint, downloadUrl: plan.downloadUrl };
    const allowed = await confirmPrivilegedAction('install Docker', plan.hint);
    if (!allowed) return { ok: false, error: 'cancelled by user' };
    const result = await dockerRuntime.install();
    rebuildTrayMenu();
    return result;
  });
  ipcMain.handle('ailinux-helper:docker-test', async (event) => {
    assertTrustedIpc(event);
    return dockerRuntime.testContainer();
  });
  ipcMain.handle('ailinux-helper:service-list', async (event) => {
    assertTrustedIpc(event);
    return serviceRuntime.list();
  });
  ipcMain.handle('ailinux-helper:service-action', async (event, id, action) => {
    assertTrustedIpc(event);
    const service = serviceRuntime.descriptor(String(id || ''));
    const name = String(action || '');
    if (!service || !serviceRuntime.ACTIONS.includes(name)) return { ok: false, error: 'unsupported typed service operation' };
    const allowed = await confirmPrivilegedAction(name + ' ' + service.label, 'Only the allowlisted service ' + service.unit + ' will be changed. No free-form shell command is executed.');
    if (!allowed) return { ok: false, id: service.id, action: name, error: 'cancelled by user' };
    return serviceRuntime.action(service.id, name);
  });
  ipcMain.handle('ailinux-helper:ui-clipboard-write', (event, text) => {
    assertTrustedIpc(event);
    const value = String(text ?? '').slice(0, 1024 * 1024);
    clipboard.writeText(value);
    return { ok: true, bytes: Buffer.byteLength(value, 'utf8') };
  });
  ipcMain.handle('ailinux-helper:clipboard-read', (event) => {
    assertTrustedIpc(event);
    if (!deviceShare.clipboardRead) throw new Error('clipboard read is not shared');
    return { text: clipboard.readText() };
  });
  ipcMain.handle('ailinux-helper:clipboard-write', (event, text) => {
    assertTrustedIpc(event);
    if (!deviceShare.clipboardWrite) throw new Error('clipboard write is not shared');
    const value = String(text ?? '').slice(0, 1024 * 1024);
    clipboard.writeText(value);
    return { ok: true, bytes: Buffer.byteLength(value, 'utf8') };
  });
  ipcMain.handle('ailinux-helper:screenshot', async (event) => {
    assertTrustedIpc(event);
    if (!deviceShare.screenObserve) throw new Error('screen observation is not shared');
    const primary = screen.getPrimaryDisplay();
    const size = primary?.size || { width: 1920, height: 1080 };
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.max(1, size.width), height: Math.max(1, size.height) },
      fetchWindowIcons: false,
    });
    if (!sources.length) throw new Error('no screen capture source available');
    const preferred = sources.find((source) => String(source.display_id || '') === String(primary?.id || '')) || sources[0];
    const image = preferred.thumbnail;
    const actual = image.getSize();
    return {
      mime: 'image/png',
      data_url: image.toDataURL(),
      width: actual.width,
      height: actual.height,
      source: 'primary-screen',
    };
  });
  ipcMain.handle('ailinux:shell-status', (event) => {
    assertTrustedIpc(event);
    return shellBackends.status();
  });
  ipcMain.handle('ailinux:shell-backend', (event, name) => {
    assertTrustedIpc(event);
    try {
      const state = shellBackends.setBackend(name);
      broadcastShellState(state);
      return state;
    } catch (error) {
      return { ...shellBackends.status(), error: String(error?.message || error) };
    }
  });
  ipcMain.handle('ailinux:shell-release', async (event) => {
    assertTrustedIpc(event);
    return releaseHostShell();
  });
  ipcMain.handle('ailinux:shell-revoke', (event) => {
    assertTrustedIpc(event);
    const state = shellBackends.revokeRelease();
    broadcastShellState(state);
    return state;
  });
  ipcMain.handle('ailinux:shell-run', async (event, payload) => {
    assertTrustedIpc(event);
    return shellBackends.runShell(payload || {});
  });

}

function safeTarget(value) {
  try {
    const url = new URL(value || START_URL);
    if (url.origin !== ALLOWED_ORIGIN) return START_URL;
    if (!url.pathname.startsWith('/v1/mcp')) return START_URL;
    return url.toString();
  } catch {
    return START_URL;
  }
}

function targetFromArgv(argv) {
  for (const arg of argv) {
    if (typeof arg !== 'string' || !PROTOCOLS.some((protocol) => arg.startsWith(`${protocol}://`))) continue;
    try {
      const deepLink = new URL(arg);
      const requested = deepLink.searchParams.get('url');
      const pairCode = deepLink.searchParams.get('pair_code') || deepLink.searchParams.get('code');
      if (requested) return safeTarget(requested);
      if (pairCode) {
        const url = new URL(START_URL);
        url.searchParams.set('pair_code', pairCode.trim().toUpperCase());
        return url.toString();
      }
    } catch {
      return START_URL;
    }
  }
  return null;
}

function isTrustedDocument(urlValue) {
  try {
    return new URL(urlValue).origin === ALLOWED_ORIGIN;
  } catch {
    return false;
  }
}

function configureSession(ses) {
  const trustedPermissions = new Set(['fileSystem', 'clipboard-sanitized-write', 'screen-wake-lock']);
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const requestingUrl = requestingOrigin || details?.requestingUrl || details?.requestingOrigin || '';
    return trustedPermissions.has(permission) && isTrustedDocument(requestingUrl);
  });

  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const requestingUrl = details?.requestingUrl || details?.requestingOrigin || '';
    callback(trustedPermissions.has(permission) && isTrustedDocument(requestingUrl));
  });
}

function trayImage() {
  const candidates = [path.join(process.resourcesPath, 'icon.png'), path.join(__dirname, '../../assets/desktop/icon.png')];
  for (const candidate of candidates) {
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) return image.resize({ width: 24, height: 24 });
  }
  return nativeImage.createEmpty();
}

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function navigate(target) {
  if (!window || window.isDestroyed()) return;
  const url = safeTarget(target);
  await window.loadURL(url);
  showWindow();
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setToolTip(`${APP_NAME} · ${PLATFORM_LABEL} · ${connectionState}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open AILinux Helper', click: showWindow },
    { label: `Status: ${connectionState}`, enabled: false },
    { label: `Platform: ${PLATFORM_LABEL}`, enabled: false },
    { label: `Terminal: ${shellBackends.status().released ? shellBackends.status().label : 'not released'}`, enabled: false },
    { type: 'separator' },
    {
      label: 'MCP device sharing',
      submenu: [
        { label: 'Share clipboard read', type: 'checkbox', checked: deviceShare.clipboardRead, click: (item) => updateDeviceShare({ clipboardRead: item.checked }) },
        { label: 'Share clipboard write', type: 'checkbox', checked: deviceShare.clipboardWrite, click: (item) => updateDeviceShare({ clipboardWrite: item.checked }) },
        { label: 'Share screen observation', type: 'checkbox', checked: deviceShare.screenObserve, click: (item) => updateDeviceShare({ screenObserve: item.checked }) },
        { label: 'Share CPU/RAM/GPU metadata', type: 'checkbox', checked: deviceShare.resourceAdvertise, click: (item) => updateDeviceShare({ resourceAdvertise: item.checked }) },
        { label: 'Advertise Docker compute', type: 'checkbox', checked: deviceShare.computeAdvertise, enabled: shellBackends.backendAvailable('docker')[0], click: (item) => updateDeviceShare({ computeAdvertise: item.checked }) },
        { label: 'Advertise local MCP bridge', type: 'checkbox', checked: deviceShare.mcpAdvertise, click: (item) => updateDeviceShare({ mcpAdvertise: item.checked }) },
        { label: 'Mouse/keyboard control: unavailable', enabled: false },
      ],
    },
    { type: 'separator' },
    { label: 'Reconnect workspace', click: () => window?.webContents.reloadIgnoringCache() },
    { label: 'Open MCP URL in default browser', click: () => shell.openExternal(START_URL) },
    { type: 'separator' },
    { label: 'Quit AILinux Helper', click: () => { quitting = true; app.quit(); } },
  ]));
}

function updateConnectionState(next) {
  const normalized = String(next || 'Unknown').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!normalized || normalized === connectionState) return;
  connectionState = normalized;
  rebuildTrayMenu();
  const important = /connected|reconnected|offline|disconnected|lost|expired|reconnecting|suspended/i.test(normalized);
  if (important && normalized !== lastNotifiedState && Notification.isSupported()) {
    lastNotifiedState = normalized;
    new Notification({ title: APP_NAME, body: normalized, silent: true }).show();
  }
}

async function pollConnectionState() {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  try {
    const text = await window.webContents.executeJavaScript(`document.getElementById('status')?.textContent || ''`, true);
    if (text) updateConnectionState(text);
  } catch {}
}

function createTray() {
  tray = new Tray(trayImage());
  rebuildTrayMenu();
  tray.on('click', showWindow);
  statusTimer = setInterval(pollConnectionState, 4000);
}

function installNativeContextMenu(webContents) {
  webContents.on('context-menu', (_event, params) => {
    const template = [];
    const flags = params.editFlags || {};
    if (params.isEditable) {
      template.push(
        { role: 'undo', enabled: flags.canUndo !== false },
        { role: 'redo', enabled: flags.canRedo !== false },
        { type: 'separator' },
        { role: 'cut', enabled: flags.canCut !== false },
        { role: 'copy', enabled: Boolean(params.selectionText) || flags.canCopy !== false },
        { role: 'paste', enabled: flags.canPaste !== false },
        { type: 'separator' },
        { role: 'selectAll', enabled: flags.canSelectAll !== false },
      );
    } else if (params.selectionText) {
      template.push({ role: 'copy' });
    }
    if (template.length) Menu.buildFromTemplate(template).popup({ window });
  });
}

function createWindow() {
  const ses = session.fromPartition(SESSION_PARTITION);
  configureSession(ses);

  window = new BrowserWindow({
    width: 980,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    show: false,
    title: `${APP_NAME} · ${PLATFORM_LABEL}`,
    backgroundColor: NATIVE_BACKGROUND,
    autoHideMenuBar: true,
    webPreferences: {
      partition: SESSION_PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      devTools: false,
      spellcheck: false,
    },
  });

  installNativeContextMenu(window.webContents);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    if (!isTrustedDocument(target)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, target) => {
    if (!isTrustedDocument(target)) event.preventDefault();
  });

  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });

  window.webContents.on('did-finish-load', () => {
    window.webContents.executeJavaScript(`(() => {
      const copy = document.getElementById('copy');
      const input = document.getElementById('generated');
      const status = document.getElementById('status');
      if (!copy || !input || copy.dataset.ailinuxNativeCopy === '1' || !window.ailinuxHelper?.uiClipboardWrite) return;
      copy.dataset.ailinuxNativeCopy = '1';
      copy.addEventListener('click', async (event) => {
        if (!input.value) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        try {
          await window.ailinuxHelper.uiClipboardWrite(input.value);
          if (status) status.textContent = 'Pair code copied.';
        } catch (error) {
          input.focus(); input.select();
          if (status) status.textContent = 'Copy failed; pair code selected.';
        }
      }, true);
    })()`, true).catch(() => {});
  });
  window.once('ready-to-show', () => { if (!startHidden) window.show(); });
  window.loadURL(safeTarget(pendingDeepLink || START_URL));
  pendingDeepLink = null;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const target = targetFromArgv(argv);
    if (target) navigate(target).catch(() => {});
    else showWindow();
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    const target = targetFromArgv([url]);
    if (!target) return;
    if (window) navigate(target).catch(() => {});
    else pendingDeepLink = target;
  });

  app.whenReady().then(() => {
    app.setName(APP_NAME);
    for (const protocol of PROTOCOLS) app.setAsDefaultProtocolClient(protocol);
    pendingDeepLink = targetFromArgv(process.argv) || pendingDeepLink;
    loadDeviceShare();
    registerHelperIpc();
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    createWindow();
    createTray();
  });

  app.on('window-all-closed', (event) => {
    if (process.platform !== 'darwin' && !quitting) event?.preventDefault?.();
  });

  app.on('activate', showWindow);

  app.on('before-quit', () => {
    quitting = true;
    if (statusTimer) clearInterval(statusTimer);
    if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
      powerSaveBlocker.stop(powerBlockerId);
    }
  });
}

module.exports = { safeTarget, targetFromArgv, isTrustedDocument };
