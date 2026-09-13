'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, Notification, powerSaveBlocker, session, shell, clipboard, desktopCapturer, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_NAME = 'AILinux Helper';
const START_URL = 'https://api.ailinux.me/v1/mcp';
const ALLOWED_ORIGIN = new URL(START_URL).origin;
const SESSION_PARTITION = 'persist:ailinux-workspace';
const PROTOCOLS = ['ailinux-helper', 'ailinux-workspace'];
const startHidden = process.argv.includes('--background');
const PLATFORM_LABEL = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';

let window = null;
let tray = null;
let quitting = false;
let powerBlockerId = null;
let pendingDeepLink = null;
let connectionState = 'Starting';
let lastNotifiedState = '';
let statusTimer = null;

let deviceShare = { clipboardRead: false, clipboardWrite: false, screenObserve: false };

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

function trustedIpc(event) {
  const senderUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
  return isTrustedDocument(senderUrl);
}

function assertTrustedIpc(event) {
  if (!trustedIpc(event)) throw new Error('untrusted helper renderer');
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
    };
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
    { type: 'separator' },
    {
      label: 'MCP device sharing',
      submenu: [
        { label: 'Share clipboard read', type: 'checkbox', checked: deviceShare.clipboardRead, click: (item) => { deviceShare.clipboardRead = item.checked; saveDeviceShare(); rebuildTrayMenu(); } },
        { label: 'Share clipboard write', type: 'checkbox', checked: deviceShare.clipboardWrite, click: (item) => { deviceShare.clipboardWrite = item.checked; saveDeviceShare(); rebuildTrayMenu(); } },
        { label: 'Share screen observation', type: 'checkbox', checked: deviceShare.screenObserve, click: (item) => { deviceShare.screenObserve = item.checked; saveDeviceShare(); rebuildTrayMenu(); } },
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
    backgroundColor: '#0d0f12',
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
