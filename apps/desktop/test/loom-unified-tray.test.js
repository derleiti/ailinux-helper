const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('loom unified mode suppresses the helper tray while standalone keeps it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /AILINUX_LOOM_UNIFIED/);
  assert.match(source, /--loom-unified/);
  assert.match(source, /if \(!loomUnified\) createTray\(\);/);
});
