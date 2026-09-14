'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../portable_runtime');

test('portable runtime exposes typed capability adapters without shell fallback', () => {
  const caps = runtime.capabilities();
  assert.equal(caps.process, true);
  assert.equal(typeof caps.services, 'boolean');
  assert.equal(typeof caps.apps, 'boolean');
  assert.equal(typeof caps.windows, 'boolean');
  assert.equal(typeof caps.input, 'boolean');
});

test('process list is bounded and read-only', async () => {
  const result = await runtime.processOps({ action: 'list', limit: 2 });
  assert.equal(result.ok, true);
  assert.ok(String(result.stdout || '').split(/\r?\n/).filter(Boolean).length <= 2);
});

test('service list uses a typed platform adapter', async () => {
  const caps = runtime.capabilities();
  if (!caps.services) return;
  const result = await runtime.serviceOps({ action: 'list', limit: 2 });
  assert.equal(typeof result.ok, 'boolean');
});


test('linux session detection prefers XDG_SESSION_TYPE and distinguishes X11/Wayland', () => {
  if (process.platform !== 'linux') return;
  assert.equal(runtime.linuxSessionType({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' }, []), 'wayland');
  assert.equal(runtime.linuxSessionType({ XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0' }, []), 'x11');
  assert.equal(runtime.linuxSessionType({ WAYLAND_DISPLAY: 'wayland-0' }, []), 'wayland');
  assert.equal(runtime.linuxSessionType({ DISPLAY: ':0' }, []), 'x11');
  assert.equal(runtime.linuxSessionType({}, []), 'unknown');
});
