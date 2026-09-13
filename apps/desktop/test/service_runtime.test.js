'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../service_runtime');

test('service registry is fixed to the approved local services', () => {
  assert.deepEqual(Object.keys(runtime.SERVICES).sort(), ['helper_background', 'ollama', 'triforce']);
  assert.deepEqual([...runtime.ACTIONS], ['start', 'stop', 'restart']);
  assert.equal(runtime.descriptor('docker'), null);
});

test('unsupported service ids and actions fail closed before host mutation', async () => {
  const badService = await runtime.action('not-a-service', 'start');
  assert.equal(badService.ok, false);
  assert.match(badService.error, /unsupported service id/);

  const badAction = await runtime.action('triforce', 'shell');
  assert.equal(badAction.ok, false);
  assert.match(badAction.error, /unsupported service action/);
});
