'use strict';

/**
 * Platform-aware shell backends for the AILinux Loom desktop helper.
 *
 * Node port of local_workspace_client/shell_backends.py. Same contract, same
 * gate names: a backend must be available on this machine AND released by the
 * user before the AI is given a terminal. Unsandboxed backends are never
 * released implicitly.
 */

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SANDBOXED_BACKENDS = new Set(['bubblewrap', 'docker']);
const ENV_BACKEND = 'AILINUX_SHELL_BACKEND';
const ENV_DOCKER_IMAGE = 'AILINUX_SHELL_DOCKER_IMAGE';
const ENV_DOCKER_NETWORK = 'AILINUX_SHELL_DOCKER_NETWORK';
const ENV_DOCKER_MEMORY = 'AILINUX_SHELL_DOCKER_MEMORY';
const ENV_DOCKER_CPUS = 'AILINUX_SHELL_DOCKER_CPUS';
const ENV_DOCKER_USER = 'AILINUX_SHELL_DOCKER_USER';

/** Label used to find and destroy every container this Helper started. */
const COMPUTE_LABEL = 'me.ailinux.helper.compute';

const WORKSPACE_MODES = new Set(['read_only', 'read_write']);

let selectedBackend = '';

const BACKEND_LABELS = {
  bubblewrap: 'Linux console (bubblewrap sandbox)',
  linux: 'Linux console (native)',
  powershell: 'Windows PowerShell',
  cmd: 'Windows cmd.exe',
  macos: 'macOS console',
  docker: 'Docker environment',
};

function envValue(name) {
  return String(process.env[name] || '').trim();
}

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

function backendAvailable(backend) {
  switch (backend) {
    case 'docker':
      if (!envValue(ENV_DOCKER_IMAGE)) return [false, `docker backend requires ${ENV_DOCKER_IMAGE}`];
      if (!which('docker')) return [false, 'docker executable not found'];
      return [true, `docker image ${envValue(ENV_DOCKER_IMAGE)}`];
    case 'bubblewrap':
      return which('bwrap') ? [true, 'bubblewrap sandbox'] : [false, 'bubblewrap (bwrap) not installed'];
    case 'powershell': {
      const found = which('pwsh', 'powershell');
      return found ? [true, `powershell at ${found}`] : [false, 'powershell not found'];
    }
    case 'cmd': {
      const found = envValue('COMSPEC') || which('cmd');
      return found ? [true, `cmd at ${found}`] : [false, 'cmd.exe not found'];
    }
    case 'macos': {
      const found = which('zsh', 'bash', 'sh');
      return found ? [true, `macOS shell at ${found}`] : [false, 'no zsh/bash/sh found'];
    }
    case 'linux': {
      const found = which('bash', 'sh');
      return found ? [true, `native shell at ${found}`] : [false, 'no bash/sh found'];
    }
    default:
      return [false, `unknown backend: ${backend}`];
  }
}

function availableBackends() {
  return Object.keys(BACKEND_LABELS).flatMap((name) => {
    const [ok, detail] = backendAvailable(name);
    return ok ? [{ name, label: BACKEND_LABELS[name], sandboxed: SANDBOXED_BACKENDS.has(name), detail }] : [];
  });
}

function setBackend(name) {
  const candidate = String(name || '').trim().toLowerCase();
  // An empty name clears the pin and returns to automatic detection.
  if (!candidate) { selectedBackend = ''; return status(); }
  if (!BACKEND_LABELS[candidate]) throw new Error(`unknown backend: ${candidate}`);
  const [ok, detail] = backendAvailable(candidate);
  if (!ok) throw new Error(`backend unavailable: ${detail}`);
  selectedBackend = candidate;
  return status();
}

function detectBackend() {
  if (selectedBackend) {
    const [ok, reason] = backendAvailable(selectedBackend);
    return ok ? [selectedBackend, reason] : ['', reason];
  }
  const pinned = envValue(ENV_BACKEND).toLowerCase();
  if (pinned) {
    if (!BACKEND_LABELS[pinned]) return ['', `unknown backend pinned via ${ENV_BACKEND}: ${pinned}`];
    const [ok, reason] = backendAvailable(pinned);
    return ok ? [pinned, reason] : ['', reason];
  }
  const order = [];
  if (envValue(ENV_DOCKER_IMAGE)) order.push('docker');
  if (process.platform === 'win32') order.push('powershell', 'cmd');
  else if (process.platform === 'darwin') order.push('macos');
  else order.push('bubblewrap', 'linux');

  let last = 'no shell backend available on this platform';
  for (const candidate of order) {
    const [ok, reason] = backendAvailable(candidate);
    if (ok) return [candidate, reason];
    last = reason;
  }
  return ['', last];
}

/** Release state lives in the main process; the renderer can never set it directly. */
const release = { granted: false, root: '', at: 0, mode: 'read_write', session: '' };

function grantRelease(root, options) {
  const mode = String((options && options.mode) || 'read_write');
  release.granted = true;
  release.root = root ? path.resolve(root) : '';
  release.at = Date.now();
  release.mode = WORKSPACE_MODES.has(mode) ? mode : 'read_write';
  release.session = crypto.randomBytes(6).toString('hex');
  return status();
}

/**
 * Destroy every disposable container this Helper started for the given session.
 * Fire-and-forget on purpose: revoking must never block the UI thread, and a
 * container that is already gone is not an error.
 */
function destroyComputeContainers(session) {
  return new Promise((resolve) => {
    const docker = which('docker');
    const label = session ? `${COMPUTE_LABEL}=${session}` : COMPUTE_LABEL;
    if (!docker) { resolve({ ok: true, removed: [], detail: 'docker not installed' }); return; }
    execFile(docker, ['ps', '-aq', '--filter', `label=${label}`], { timeout: 15000, windowsHide: true }, (error, stdout) => {
      const ids = String(stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      if (error || !ids.length) { resolve({ ok: !error, removed: [], detail: error ? 'container lookup failed' : 'nothing to remove' }); return; }
      execFile(docker, ['rm', '-f', ...ids], { timeout: 60000, windowsHide: true }, (rmError) => {
        resolve({ ok: !rmError, removed: ids, detail: rmError ? 'container removal failed' : 'disposable compute destroyed' });
      });
    });
  });
}

function revokeRelease() {
  const session = release.session;
  release.granted = false;
  release.root = '';
  release.at = 0;
  release.mode = 'read_write';
  release.session = '';
  // Revoking a share must also tear down anything still running under it.
  if (session) destroyComputeContainers(session).catch(() => {});
  return status();
}

function status() {
  const [backend, detail] = detectBackend();
  const sandboxed = SANDBOXED_BACKENDS.has(backend);
  return {
    host: 'electron',
    platform: process.platform,
    backend,
    label: BACKEND_LABELS[backend] || '',
    available: Boolean(backend),
    sandboxed,
    released: Boolean(backend) && release.granted && Boolean(release.root),
    workspace: release.root,
    workspaceMode: release.granted ? release.mode : 'read_only',
    session: release.session,
    releasedAt: release.at,
    detail,
    backends: availableBackends(),
    releaseDetail: release.granted
      ? (release.root ? 'terminal released by the user' : 'released without a workspace folder')
      : 'terminal not released by the user',
  };
}

function posixArgs(shellPath, command) {
  const name = path.basename(shellPath);
  return (name === 'bash' || name === 'zsh')
    ? ['-o', 'pipefail', '-c', command]
    : ['-c', command];
}

function resolveWithin(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(base, candidate || '.');
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('path is outside the released workspace');
  }
  return { target, rel: rel.split(path.sep).filter(Boolean).join('/') };
}

function buildPlan(command, cwd) {
  const text = String(command || '').trim();
  if (!text) throw new Error('command is required');
  const state = status();
  if (!state.available) throw new Error(`no shell backend available: ${state.detail}`);
  if (!state.released) throw new Error(`shell not released: ${state.releaseDetail}`);

  const { target, rel } = resolveWithin(state.workspace, cwd);
  const workdir = '/workspace' + (rel ? `/${rel}` : '');

  if (state.backend === 'bubblewrap') {
    const argv = ['--die-with-parent', '--new-session', '--unshare-all',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib'];
    if (fs.existsSync('/lib64')) argv.push('--ro-bind', '/lib64', '/lib64');
    argv.push('--bind', state.workspace, '/workspace', '--chdir', workdir,
      '--setenv', 'HOME', '/workspace', '--setenv', 'TMPDIR', '/tmp',
      '/bin/bash', '-o', 'pipefail', '-c', text);
    return { backend: 'bubblewrap', sandboxed: true, file: which('bwrap'), args: argv, cwd: undefined };
  }

  if (state.backend === 'docker') {
    // Disposable by construction: --rm, no network, no capabilities, no new
    // privileges, read-only rootfs and hard resource limits. The workspace is
    // the ONLY host path handed in, and it is mounted read-only unless the user
    // explicitly released read/write. The docker socket is never mounted.
    const readOnlyWorkspace = state.workspaceMode !== 'read_write';
    const args = ['run', '--rm', '-i',
      '--network', envValue(ENV_DOCKER_NETWORK) || 'none',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--pids-limit', '256',
      '--memory', envValue(ENV_DOCKER_MEMORY) || '2g',
      '--cpus', envValue(ENV_DOCKER_CPUS) || '2',
      '--label', `${COMPUTE_LABEL}=${state.session}`];
    const user = envValue(ENV_DOCKER_USER) || (typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid()}` : '');
    if (user) args.push('--user', user);
    args.push('-v', `${state.workspace}:/workspace:${readOnlyWorkspace ? 'ro' : 'rw'}`, '-w', workdir,
      envValue(ENV_DOCKER_IMAGE), '/bin/sh', '-c', text);
    return { backend: 'docker', sandboxed: true, file: which('docker') || 'docker', args, cwd: undefined, workspaceMode: state.workspaceMode };
  }

  if (state.backend === 'powershell') {
    const file = which('pwsh', 'powershell');
    return {
      backend: 'powershell', sandboxed: false, file,
      args: ['-NoLogo', '-NonInteractive', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', text],
      cwd: target,
    };
  }

  if (state.backend === 'cmd') {
    const file = envValue('COMSPEC') || which('cmd');
    return { backend: 'cmd', sandboxed: false, file, args: ['/d', '/c', text], cwd: target };
  }

  const file = state.backend === 'macos' ? which('zsh', 'bash', 'sh') : which('bash', 'sh');
  return { backend: state.backend, sandboxed: false, file, args: posixArgs(file, text), cwd: target };
}

function runShell({ command, cwd, timeout } = {}) {
  return new Promise((resolve) => {
    let plan;
    try {
      plan = buildPlan(command, cwd);
    } catch (error) {
      resolve({ ok: false, text: String(error.message || error), isError: true });
      return;
    }
    const limit = Math.max(1, Math.min(Number(timeout) || 120, 300)) * 1000;
    execFile(plan.file, plan.args, {
      cwd: plan.cwd, timeout: limit, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    }, (error, stdout, stderr) => {
      const parts = [];
      if (stdout) parts.push(`stdout:\n${stdout}`);
      if (stderr) parts.push(`stderr:\n${stderr}`);
      const code = error && typeof error.code === 'number' ? error.code : (error ? 1 : 0);
      if (error && error.killed) parts.push(`command timed out after ${limit / 1000}s`);
      parts.push(`exit_code=${code} backend=${plan.backend} sandboxed=${plan.sandboxed}`);
      const text = parts.join('\n').slice(0, 12000);
      resolve({ ok: code === 0, text, isError: code !== 0 });
    });
  });
}

module.exports = {
  SANDBOXED_BACKENDS, BACKEND_LABELS, ENV_BACKEND, ENV_DOCKER_IMAGE, ENV_DOCKER_NETWORK,
  ENV_DOCKER_MEMORY, ENV_DOCKER_CPUS, ENV_DOCKER_USER, COMPUTE_LABEL, destroyComputeContainers,
  detectBackend, backendAvailable, availableBackends, setBackend, status, grantRelease, revokeRelease,
  buildPlan, runShell, resolveWithin, posixArgs, which,
};
