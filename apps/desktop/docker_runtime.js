'use strict';

/**
 * Docker runtime adapter for the AILinux Helper.
 *
 * Docker is a hard dependency for COMPUTE only. Workspace read/write, file
 * sharing, display observation, MCP discovery and resource advertisement must
 * all keep working without it, so nothing in here sits on a startup path.
 *
 * Hard rules encoded in this module:
 *   - Never install, start or stop anything implicitly. Every mutating call is
 *     the direct result of an explicit user action in the tray or the WebApp.
 *   - Never touch existing daemon configuration or existing containers.
 *   - Elevation goes through the platform's own prompt (PolicyKit / UAC /
 *     Docker Desktop); there are no silent root actions here.
 *   - Detection is read-only and safe to call at any time.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ENGINE_NOT_INSTALLED = 'not_installed';
const ENGINE_RUNNING = 'running';
const ENGINE_STOPPED = 'stopped';
const ENGINE_PERMISSION_DENIED = 'permission_denied';
const ENGINE_UNKNOWN = 'unknown';

const ENGINE_STATES = Object.freeze([
  ENGINE_NOT_INSTALLED, ENGINE_RUNNING, ENGINE_STOPPED, ENGINE_PERMISSION_DENIED, ENGINE_UNKNOWN,
]);

const SERVICE_ACTIONS = Object.freeze(['start', 'stop', 'restart']);

/** Docker install pages; used for guidance only, never auto-opened. */
const DOWNLOAD_PAGES = Object.freeze({
  win32: 'https://docs.docker.com/desktop/install/windows-install/',
  darwin: 'https://docs.docker.com/desktop/install/mac-install/',
  linux: 'https://docs.docker.com/engine/install/',
});

function which(...names) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const name of names) {
    if (!name) continue;
    if (name.includes(path.sep)) {
      try { fs.accessSync(name, fs.constants.X_OK); return name; } catch { continue; }
    }
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
      }
    }
  }
  return '';
}

function run(file, args, { timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    if (!file) { resolve({ ok: false, code: -1, stdout: '', stderr: 'executable not found' }); return; }
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === 'number' ? error.code : (error ? 1 : 0),
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || (error && error.message) || '').trim(),
      });
    });
  });
}

/**
 * Classify a failed `docker info` into an actionable engine state.
 * Exported for tests: the message wording is the only signal Docker gives us.
 */
function classifyDaemonError(stderr) {
  const text = String(stderr || '').toLowerCase();
  if (!text) return ENGINE_UNKNOWN;
  if (text.includes('permission denied')) return ENGINE_PERMISSION_DENIED;
  if (text.includes('cannot connect to the docker daemon')) return ENGINE_STOPPED;
  if (text.includes('is the docker daemon running')) return ENGINE_STOPPED;
  if (text.includes('docker desktop is not running')) return ENGINE_STOPPED;
  if (text.includes('open //./pipe/docker_engine')) return ENGINE_STOPPED;
  if (text.includes('connect: no such file or directory')) return ENGINE_STOPPED;
  return ENGINE_UNKNOWN;
}

/** Which service manager can start/stop the engine on this platform. */
function serviceManager() {
  if (process.platform === 'linux') return which('systemctl') ? 'systemd' : '';
  if (process.platform === 'darwin') return which('open') ? 'docker-desktop' : '';
  if (process.platform === 'win32') return 'docker-desktop';
  return '';
}

/** Detect the Linux package manager for an install plan. Read-only. */
function linuxPackageManager() {
  for (const pair of [['apt-get', 'apt'], ['dnf', 'dnf'], ['pacman', 'pacman'], ['zypper', 'zypper']]) {
    if (which(pair[0])) return pair[1];
  }
  return '';
}

/**
 * Describe how Docker would be installed on this platform.
 * Returns a plan only; nothing is executed here.
 */
function installPlan() {
  const platform = process.platform;
  const downloadUrl = DOWNLOAD_PAGES[platform] || DOWNLOAD_PAGES.linux;
  if (platform === 'linux') {
    const manager = linuxPackageManager();
    if (!manager) {
      return { supported: false, method: '', requiresElevation: false, downloadUrl, hint: 'No supported package manager found. Install Docker Engine manually.' };
    }
    const elevated = Boolean(which('pkexec'));
    return {
      supported: elevated,
      method: manager,
      requiresElevation: true,
      elevation: 'pkexec',
      downloadUrl,
      hint: elevated
        ? 'Installs the distribution Docker package via ' + manager + '; PolicyKit asks for confirmation. Existing Docker configuration and containers are left untouched.'
        : 'pkexec (PolicyKit) is missing, so the Helper cannot request elevation safely. Install Docker manually.',
    };
  }
  if (platform === 'darwin') {
    return {
      supported: false, method: which('brew') ? 'brew-cask' : '', requiresElevation: true, downloadUrl,
      hint: which('brew')
        ? 'Run `brew install --cask docker` in a terminal, then open Docker Desktop.'
        : 'Install Docker Desktop for macOS from the download page.',
    };
  }
  if (platform === 'win32') {
    return {
      supported: false, method: which('winget') ? 'winget' : '', requiresElevation: true, downloadUrl,
      hint: which('winget')
        ? 'Run `winget install Docker.DockerDesktop` in an elevated terminal, then start Docker Desktop.'
        : 'Install Docker Desktop for Windows from the download page.',
    };
  }
  return { supported: false, method: '', requiresElevation: false, downloadUrl, hint: 'Unsupported platform.' };
}

/**
 * Last detection result, so synchronous UI paths (tray menu, capability
 * advertisement) can consult the engine state without blocking on `docker info`.
 * null means "never detected yet", which is treated as unknown, not as running.
 */
let lastState = null;

function cachedEngine() {
  return lastState;
}

/** Read-only engine detection. Safe to call at any time, never mutates state. */
async function detect() {
  const cli = which('docker');
  const manager = serviceManager();
  const plan = installPlan();
  if (!cli) {
    lastState = {
      platform: process.platform, installed: false, cli: '', clientVersion: '', serverVersion: '',
      engine: ENGINE_NOT_INSTALLED, detail: 'Docker CLI not found on PATH.',
      serviceManager: manager, canControlService: false, install: plan,
    };
    return lastState;
  }

  const client = await run(cli, ['version', '--format', '{{.Client.Version}}'], { timeout: 8000 });
  const info = await run(cli, ['info', '--format', '{{.ServerVersion}}'], { timeout: 15000 });
  const engine = info.ok ? ENGINE_RUNNING : classifyDaemonError(info.stderr);

  let detail;
  if (engine === ENGINE_RUNNING) detail = 'Docker Engine ' + info.stdout + ' running.';
  else if (engine === ENGINE_STOPPED) detail = 'Docker is installed but the engine is not running.';
  else if (engine === ENGINE_PERMISSION_DENIED) detail = 'Docker is installed but this user may not access the Docker socket. Add the user to the docker group and re-login.';
  else detail = info.stderr || 'Docker engine state could not be determined.';

  lastState = {
    platform: process.platform,
    installed: true,
    cli,
    clientVersion: client.ok ? client.stdout : '',
    serverVersion: engine === ENGINE_RUNNING ? info.stdout : '',
    engine,
    detail,
    serviceManager: manager,
    canControlService: Boolean(manager) && engine !== ENGINE_NOT_INSTALLED,
    install: plan,
  };
  return lastState;
}

/**
 * Start/stop/restart the engine through the platform's service manager.
 * Always user-triggered; elevation goes through PolicyKit on Linux.
 */
async function serviceAction(action) {
  if (!SERVICE_ACTIONS.includes(action)) return { ok: false, error: 'unsupported service action: ' + action };
  const manager = serviceManager();
  if (!manager) return { ok: false, error: 'no supported service manager on this platform' };

  if (manager === 'systemd') {
    const pkexec = which('pkexec');
    const systemctl = which('systemctl');
    if (!pkexec) return { ok: false, action, manager, error: 'pkexec (PolicyKit) is required to control the Docker service' };
    // docker.service only; docker.socket and existing configuration stay untouched.
    const result = await run(pkexec, [systemctl, action, 'docker.service'], { timeout: 90000 });
    return { ok: result.ok, action, manager, error: result.ok ? '' : (result.stderr || 'systemctl failed') };
  }

  // Docker Desktop exposes no scriptable stop; only launching it is supported.
  if (action === 'start' || action === 'restart') {
    if (process.platform === 'darwin') {
      const result = await run(which('open'), ['-a', 'Docker'], { timeout: 30000 });
      return { ok: result.ok, action, manager, error: result.ok ? '' : (result.stderr || 'could not open Docker Desktop') };
    }
    if (process.platform === 'win32') {
      const result = await run(which('cmd'), ['/c', 'start', '', 'Docker Desktop.exe'], { timeout: 30000 });
      return { ok: result.ok, action, manager, error: result.ok ? '' : (result.stderr || 'could not start Docker Desktop') };
    }
  }
  return { ok: false, action, manager, error: 'Stop Docker Desktop from its own tray icon; the Helper will not force-quit it.' };
}

/**
 * Install Docker. Linux only, package-manager based, elevated via PolicyKit.
 * Refuses when Docker is already present so no existing setup is overwritten.
 */
async function install() {
  const current = await detect();
  if (current.installed) {
    return { ok: false, error: 'Docker is already installed; the Helper never reinstalls over an existing setup.', engine: current.engine };
  }
  const plan = installPlan();
  if (!plan.supported) return { ok: false, error: plan.hint, downloadUrl: plan.downloadUrl, manual: true };

  const pkexec = which('pkexec');
  if (!pkexec) return { ok: false, error: 'pkexec (PolicyKit) is required for an elevated install', manual: true };

  const commands = {
    apt: [which('apt-get'), 'install', '-y', 'docker.io'],
    dnf: [which('dnf'), 'install', '-y', 'docker'],
    pacman: [which('pacman'), '-S', '--noconfirm', 'docker'],
    zypper: [which('zypper'), 'install', '-y', 'docker'],
  }[plan.method];
  if (!commands || !commands[0]) return { ok: false, error: 'package manager ' + plan.method + ' unavailable', manual: true };

  const result = await run(pkexec, commands, { timeout: 600000 });
  if (!result.ok) return { ok: false, error: result.stderr || 'installation failed', method: plan.method };
  return { ok: true, method: plan.method, detail: 'Docker installed. Start the engine to enable compute.' };
}

/**
 * Disposable health probe. Runs a throwaway container with no network, no
 * capabilities and a read-only rootfs; it can neither reach the host nor persist.
 */
async function testContainer(options) {
  const image = (options && options.image) || 'alpine:3.20';
  const state = await detect();
  if (state.engine !== ENGINE_RUNNING) return { ok: false, error: state.detail, engine: state.engine };
  const args = [
    'run', '--rm', '--network', 'none', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp',
    '--pids-limit', '64', '--memory', '256m', '--cpus', '1',
    image, 'true',
  ];
  const result = await run(state.cli, args, { timeout: 120000 });
  return { ok: result.ok, image, error: result.ok ? '' : (result.stderr || 'test container failed') };
}

module.exports = {
  ENGINE_NOT_INSTALLED, ENGINE_RUNNING, ENGINE_STOPPED, ENGINE_PERMISSION_DENIED, ENGINE_UNKNOWN,
  ENGINE_STATES, SERVICE_ACTIONS, DOWNLOAD_PAGES,
  which, classifyDaemonError, serviceManager, linuxPackageManager, cachedEngine,
  installPlan, detect, serviceAction, install, testContainer,
};
