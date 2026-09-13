'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const docker = require('../docker_runtime');

test('daemon errors map onto actionable engine states', () => {
  const cases = [
    ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock.', docker.ENGINE_STOPPED],
    ['Is the docker daemon running?', docker.ENGINE_STOPPED],
    ['error during connect: open //./pipe/docker_engine: not found', docker.ENGINE_STOPPED],
    ['Docker Desktop is not running', docker.ENGINE_STOPPED],
    ['dial unix /var/run/docker.sock: connect: no such file or directory', docker.ENGINE_STOPPED],
    ['permission denied while trying to connect to the Docker daemon socket', docker.ENGINE_PERMISSION_DENIED],
    ['', docker.ENGINE_UNKNOWN],
    ['totally unexpected output', docker.ENGINE_UNKNOWN],
    [null, docker.ENGINE_UNKNOWN],
  ];
  for (const [message, expected] of cases) {
    assert.equal(docker.classifyDaemonError(message), expected, `for: ${message}`);
  }
});

test('permission denied wins over a generic connect failure', () => {
  const message = 'Cannot connect to the Docker daemon: permission denied';
  assert.equal(docker.classifyDaemonError(message), docker.ENGINE_PERMISSION_DENIED);
});

test('an install plan always offers a manual route', () => {
  const plan = docker.installPlan();
  assert.ok(plan.downloadUrl.startsWith('https://docs.docker.com/'));
  assert.equal(typeof plan.hint, 'string');
  assert.ok(plan.hint.length > 0);
  assert.equal(typeof plan.supported, 'boolean');
  if (plan.supported) assert.equal(plan.requiresElevation, true, 'an automated install must be elevated');
});

test('only linux offers an automated install; desktop platforms stay manual', () => {
  const plan = docker.installPlan();
  if (process.platform !== 'linux') assert.equal(plan.supported, false);
});

test('detection is read-only and reports a known engine state', async () => {
  const state = await docker.detect();
  assert.ok(docker.ENGINE_STATES.includes(state.engine), `unknown state: ${state.engine}`);
  assert.equal(typeof state.installed, 'boolean');
  assert.equal(typeof state.detail, 'string');
  assert.ok(state.detail.length > 0);
  assert.equal(state.platform, process.platform);
  if (!state.installed) {
    assert.equal(state.engine, docker.ENGINE_NOT_INSTALLED);
    assert.equal(state.canControlService, false);
  }
  // Detection must never claim a server version while the engine is down.
  if (state.engine !== docker.ENGINE_RUNNING) assert.equal(state.serverVersion, '');
});

test('unsupported service actions are rejected without touching the host', async () => {
  for (const action of ['destroy', 'rm', '', 'START', null]) {
    const result = await docker.serviceAction(action);
    assert.equal(result.ok, false);
    assert.match(String(result.error), /unsupported service action|no supported service manager/);
  }
});

test('install refuses to overwrite an existing docker installation', async (t) => {
  const state = await docker.detect();
  if (!state.installed) return t.skip('docker not installed on this machine');
  const result = await docker.install();
  assert.equal(result.ok, false);
  assert.match(result.error, /already installed/);
});

test('the test container is hardened and disposable', () => {
  const source = require('node:fs').readFileSync(require.resolve('../docker_runtime'), 'utf8');
  for (const flag of ['--rm', "'--network', 'none'", "'--cap-drop', 'ALL'", 'no-new-privileges', '--read-only', '--pids-limit']) {
    assert.ok(source.includes(flag), `missing hardening flag: ${flag}`);
  }
  // The docker socket must never be handed into a container.
  assert.ok(!source.includes('/var/run/docker.sock:'), 'docker socket must never be mounted');
});
