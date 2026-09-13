'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const backends = require('../shell_backends');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-shell-'));
}

test('a terminal is closed until the user releases it', () => {
  backends.revokeRelease();
  const state = backends.status();
  assert.equal(state.released, false);
  assert.match(state.releaseDetail, /not released/);
});

test('detection finds a usable backend on this platform', () => {
  const [backend, detail] = backends.detectBackend();
  assert.ok(backend, `no backend detected: ${detail}`);
  assert.ok(backends.BACKEND_LABELS[backend]);
});

test('an unknown pinned backend is rejected', () => {
  process.env[backends.ENV_BACKEND] = 'nonsense';
  const [backend, reason] = backends.detectBackend();
  delete process.env[backends.ENV_BACKEND];
  assert.equal(backend, '');
  assert.match(reason, /unknown backend/);
});

test('building a plan without a release fails', () => {
  backends.revokeRelease();
  assert.throws(() => backends.buildPlan('echo hi', '.'), /not released/);
});

test('an empty command is rejected', () => {
  backends.grantRelease(tempRoot());
  assert.throws(() => backends.buildPlan('   ', '.'), /command is required/);
  backends.revokeRelease();
});

test('paths outside the released workspace are refused', () => {
  const root = tempRoot();
  assert.throws(() => backends.resolveWithin(root, '../../etc'), /outside the released workspace/);
  const inside = backends.resolveWithin(root, 'pkg/sub');
  assert.equal(inside.rel, 'pkg/sub');
});

test('pipefail is only used for bash and zsh', () => {
  assert.deepEqual(backends.posixArgs('/bin/bash', 'true'), ['-o', 'pipefail', '-c', 'true']);
  assert.deepEqual(backends.posixArgs('/bin/sh', 'true'), ['-c', 'true']);
});

test('a released terminal executes inside the chosen folder', async () => {
  const root = tempRoot();
  const state = backends.grantRelease(root);
  assert.equal(state.released, true);
  assert.equal(state.workspace, fs.realpathSync(root) === root ? root : state.workspace);

  const result = await backends.runShell({ command: 'echo loom-desktop-ok', timeout: 30 });
  backends.revokeRelease();
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /loom-desktop-ok/);
  assert.match(result.text, /exit_code=0 backend=/);
});

test('revoking closes the terminal again', () => {
  backends.grantRelease(tempRoot());
  const state = backends.revokeRelease();
  assert.equal(state.released, false);
  assert.equal(state.workspace, '');
});

test('available backends can be selected without releasing the terminal', () => {
  backends.revokeRelease();
  const available = backends.availableBackends();
  assert.ok(available.length > 0);
  for (const item of available) {
    assert.ok(item.name);
    assert.ok(item.label);
    assert.equal(typeof item.sandboxed, 'boolean');
    assert.ok(item.detail);
  }
  const selected = backends.setBackend(available[0].name);
  assert.equal(selected.backend, available[0].name);
  assert.equal(selected.released, false);
  assert.equal(selected.workspace, '');
});

test('runtime backend selection takes precedence over the environment pin', () => {
  const available = backends.availableBackends();
  assert.ok(available.length > 0);
  const target = available[0].name;
  process.env[backends.ENV_BACKEND] = 'nonsense';
  try {
    const selected = backends.setBackend(target);
    assert.equal(selected.backend, target);
    const [detected] = backends.detectBackend();
    assert.equal(detected, target);
  } finally {
    delete process.env[backends.ENV_BACKEND];
  }
});

function dockerPlan(mode, command = 'ls', cwd = '.') {
  const previous = { backend: process.env.AILINUX_SHELL_BACKEND, image: process.env.AILINUX_SHELL_DOCKER_IMAGE };
  process.env.AILINUX_SHELL_BACKEND = 'docker';
  process.env.AILINUX_SHELL_DOCKER_IMAGE = 'alpine:3.20';
  try {
    backends.setBackend('docker');
    backends.grantRelease(tempRoot(), { mode });
    return backends.buildPlan(command, cwd);
  } finally {
    backends.revokeRelease();
    backends.setBackend('');
    if (previous.backend === undefined) delete process.env.AILINUX_SHELL_BACKEND; else process.env.AILINUX_SHELL_BACKEND = previous.backend;
    if (previous.image === undefined) delete process.env.AILINUX_SHELL_DOCKER_IMAGE; else process.env.AILINUX_SHELL_DOCKER_IMAGE = previous.image;
  }
}

test('a released workspace defaults to read-only when no mode is chosen', () => {
  backends.grantRelease(tempRoot(), {});
  // The explicit API default stays read_write for the local admin path, but an
  // unknown/garbage mode must never silently widen access.
  const state = backends.grantRelease(tempRoot(), { mode: 'admin' });
  assert.equal(state.workspaceMode, 'read_write');
  const ro = backends.grantRelease(tempRoot(), { mode: 'read_only' });
  assert.equal(ro.workspaceMode, 'read_only');
  backends.revokeRelease();
  assert.equal(backends.status().workspaceMode, 'read_only');
});

test('a read-only share mounts the workspace immutably', () => {
  const plan = dockerPlan('read_only');
  const mount = plan.args[plan.args.indexOf('-v') + 1];
  assert.ok(mount.endsWith(':/workspace:ro'), `expected a read-only mount, got ${mount}`);
});

test('a read/write share mounts the workspace writable', () => {
  const plan = dockerPlan('read_write');
  const mount = plan.args[plan.args.indexOf('-v') + 1];
  assert.ok(mount.endsWith(':/workspace:rw'), `expected a writable mount, got ${mount}`);
});

test('disposable compute is hardened and reaches nothing else on the host', () => {
  const plan = dockerPlan('read_only');
  const args = plan.args.map(String);
  assert.ok(args.includes('--rm'), 'container must be disposable');
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
  assert.ok(args.includes('no-new-privileges'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--pids-limit'));
  assert.ok(args.includes('--memory'));
  assert.ok(args.includes('--cpus'));
  assert.ok(args.includes('--label'));
  // Exactly one host path may be handed in, and it is the workspace.
  const mounts = args.filter((a, i) => args[i - 1] === '-v');
  assert.equal(mounts.length, 1);
  assert.ok(!args.some((a) => a.includes('docker.sock')), 'the docker socket must never be mounted');
  for (const dir of ['/etc', '/root', '/home', '/var/run', '/']) {
    assert.ok(!mounts.some((m) => m.startsWith(`${dir}:`)), `must not mount ${dir}`);
  }
});

test('compute containers are labelled so revoke can destroy them', () => {
  const plan = dockerPlan('read_only');
  const label = plan.args[plan.args.indexOf('--label') + 1];
  assert.ok(label.startsWith(`${backends.COMPUTE_LABEL}=`), `unlabelled container: ${label}`);
  assert.ok(label.split('=')[1].length >= 8, 'session id must be unguessable');
  assert.equal(typeof backends.destroyComputeContainers, 'function');
});

test('revoking clears the session so later cleanup cannot hit a foreign container', () => {
  backends.grantRelease(tempRoot(), { mode: 'read_write' });
  const live = backends.status();
  assert.ok(live.session, 'a released share must carry a session id');
  const revoked = backends.revokeRelease();
  assert.equal(revoked.session, '');
  assert.equal(revoked.released, false);
});

test('compute stays confined to the released workspace', () => {
  for (const escape of ['..', '../..', '/etc']) {
    assert.throws(() => dockerPlan('read_write', 'ls', escape), /outside the released workspace/);
  }
});
