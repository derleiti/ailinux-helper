'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bridge = require('../kwin_window_runtime');

test('KWin adapter is only available on KDE Wayland with required tools', () => {
  const noTools={ XDG_SESSION_TYPE:'wayland', XDG_CURRENT_DESKTOP:'KDE', PATH:'/missing/path' };
  assert.equal(bridge.available({env:noTools,platform:'linux'}),false);
  assert.equal(bridge.available({env:noTools,platform:'win32'}),false);
  assert.equal(bridge.available({env:{...noTools,XDG_SESSION_TYPE:'x11'},platform:'linux'}),false);
});

test('fixed KWin script quotes hostile title as data, never code', () => {
  const marker='AILINUX_KWIN_test:';
  const title='hello"); globalThis.pwned = true; //\n world';
  const script=bridge.buildScript({action:'list',title,limit:3},marker);
  assert.ok(script.includes(JSON.stringify(title)));
  assert.ok(script.includes(JSON.stringify(marker)));
  assert.ok(!script.includes('eval('));
  assert.ok(!script.includes('new Function('));
  assert.ok(script.includes('workspace.windowList()'));
  assert.ok(script.includes('ambiguous window'));
  assert.ok(script.includes('window_id'));
});

test('bounded KWin script accepts only documented window operations', () => {
  for (const action of ['list','focus','close','minimize','maximize']) {
    const script=bridge.buildScript({action},'MARKER:');
    assert.ok(script.includes(JSON.stringify(action)));
  }
  assert.ok(!bridge.buildScript({action:'list',limit:20000},'M:').includes('"limit":20000'));
});

test('legacy result parsing ignores unrelated text', () => {
  const marker='AILINUX_KWIN_n0nce:';
  const result=bridge.parseOutput('prefix\njs: '+marker+'{"ok":true,"windows":[{"id":"abc","title":"KDE"}]}\n',marker);
  assert.equal(result.ok,true);
  assert.equal(result.windows[0].id,'abc');
  assert.equal(bridge.parseOutput('unrelated entry','M:'),null);
  assert.equal(bridge.parseOutput('M:{malformed','M:'),null);
});

test('KWin bridge replies over a nonce-bound DBus endpoint, without relying on journald', () => {
  const script=bridge.buildScript({action:'list'},'M:','0123456789abcdef01234567');
  assert.match(script,/callDBus/);
  assert.match(script,/me\.ailinux\.KWinHelper\.n0123456789abcdef01234567/);
  assert.match(script,/JSON\.stringify\(result\)/);
  assert.doesNotMatch(script,/print\(marker/);
});
