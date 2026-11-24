'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hook = require('../linux-package-permissions');

test('linux packaging repairs public access without following symlinks', {skip: process.platform === 'win32'}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-permissions-'));
  try {
    const root = path.join(dir, 'app');
    fs.mkdirSync(root, {mode: 0o750});
    fs.mkdirSync(path.join(root, 'resources'), {mode: 0o750});
    fs.writeFileSync(path.join(root, 'resources/app.asar'), 'payload', {mode: 0o640});
    fs.writeFileSync(path.join(root, 'ailinux-helper'), 'executable', {mode: 0o750});
    const outside = path.join(dir, 'private');
    fs.writeFileSync(outside, 'private', {mode: 0o600});
    fs.symlinkSync(outside, path.join(root, 'link'));
    await hook({electronPlatformName: 'linux', appOutDir: root});
    const mode = p => fs.statSync(p).mode & 0o777;
    assert.equal(mode(root), 0o755);
    assert.equal(mode(path.join(root, 'resources')), 0o755);
    assert.equal(mode(path.join(root, 'resources/app.asar')), 0o644);
    assert.equal(mode(path.join(root, 'ailinux-helper')), 0o755);
    assert.equal(mode(outside), 0o600);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
