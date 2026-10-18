'use strict';

/**
 * KDE Plasma 6 Wayland window manager adapter.
 * Executes only a fixed KWin script (no caller-provided code), and returns
 * its tagged result from the user's journal. Mutations remain MCP-gated.
 */
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function executable(name, env = process.env) {
  if (!/^[a-z0-9_-]+$/i.test(name)) return '';
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try { fs.accessSync(full, fs.constants.X_OK); return full; } catch {}
  }
  return '';
}

function available({ env = process.env, platform = process.platform } = {}) {
  const kde = /(?:^|:)(?:KDE|Plasma)(?::|$)/i.test(String(env.XDG_CURRENT_DESKTOP || ''))
    || /^(true|1)$/i.test(String(env.KDE_FULL_SESSION || ''));
  const wayland = String(env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' || Boolean(env.WAYLAND_DISPLAY);
  return platform === 'linux' && kde && wayland
    && Boolean(executable('qdbus6', env) || executable('qdbus', env))
    && Boolean(executable('journalctl', env));
}

function run(file, args, timeout = 5000) {
  return new Promise(resolve => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 128 * 1024 },
      (error, stdout, stderr) => resolve({
        ok: !error,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: error ? String(error.message || error) : '',
      }));
  });
}

function buildScript(spec, marker) {
  const safe = {
    action: String(spec.action || 'list').slice(0, 20),
    id: String(spec.id || '').slice(0, 128),
    title: String(spec.title || '').slice(0, 512),
    limit: Math.max(1, Math.min(Number(spec.limit) || 100, 500)),
  };
  return [
    '(function () {',
    '  const spec = ' + JSON.stringify(safe) + ';',
    '  const marker = ' + JSON.stringify(marker) + ';',
    '  try {',
    '    const wins = workspace.windowList().filter(w => w && !w.deleted && !w.specialWindow);',
    '    const data = w => ({ id: String(w.internalId || ""), title: String(w.caption || ""),',
    '      pid: Number(w.pid || 0) || null, active: Boolean(w.active), minimized: Boolean(w.minimized) });',
    '    const matches = wins.filter(w => {',
    '      const d = data(w);',
    '      return (!spec.id || d.id === spec.id) && (!spec.title || d.title.toLowerCase().includes(spec.title.toLowerCase()));',
    '    });',
    '    if (spec.action === "list") {',
    '      print(marker + JSON.stringify({ ok:true, windows:matches.slice(0,spec.limit).map(data), truncated:matches.length > spec.limit }));',
    '      return;',
    '    }',
    '    if (!spec.id && !spec.title) throw new Error("window_id or title required");',
    '    if (!matches.length) throw new Error("window not found");',
    '    if (matches.length !== 1) throw new Error("ambiguous window: provide an exact window_id");',
    '    const win = matches[0];',
    '    if (spec.action === "focus") workspace.activeWindow = win;',
    '    else if (spec.action === "minimize") win.minimized = true;',
    '    else if (spec.action === "maximize") win.setMaximize(true, true);',
    '    else if (spec.action === "close") {',
    '      if (!win.closeable) throw new Error("window is not closeable");',
    '      win.closeWindow();',
    '    } else throw new Error("unsupported action");',
    '    print(marker + JSON.stringify({ ok:true, action:spec.action, window:data(win) }));',
    '  } catch (error) {',
    '    print(marker + JSON.stringify({ ok:false, error:String(error && error.message || error) }));',
    '  }',
    '})();',
    '',
  ].join('\n');
}

function parseOutput(stdout, marker) {
  for (const line of String(stdout || '').split(/\r?\n/).reverse()) {
    const idx = line.indexOf(marker);
    if (idx < 0) continue;
    try {
      const data = JSON.parse(line.slice(idx + marker.length).trim());
      if (data && typeof data.ok === 'boolean') return data;
    } catch {}
  }
  return null;
}

async function windowOps(args = {}) {
  if (!available()) throw new Error('KWin 6 Wayland scripting adapter unavailable');
  const action = String(args.action || 'list').toLowerCase();
  if (!['list', 'focus', 'close', 'minimize', 'maximize'].includes(action)) throw new Error('unsupported window action');
  const spec = { action, id: String(args.window_id || ''), title: String(args.title || ''), limit: args.limit };
  if (action !== 'list' && !spec.id && !spec.title) throw new Error('window_id or title required');
  const dbus = executable('qdbus6') || executable('qdbus');
  const journal = executable('journalctl');
  const nonce = crypto.randomBytes(12).toString('hex');
  const marker = 'AILINUX_KWIN_' + nonce + ':';
  const label = 'ailinux-helper-window-' + nonce;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ailinux-kwin-'));
  const scriptFile = path.join(folder, 'window.js');
  fs.writeFileSync(scriptFile, buildScript(spec, marker), { mode: 0o600 });
  let scriptId = '';
  try {
    const loaded = await run(dbus, ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.loadScript', scriptFile, label]);
    if (!loaded.ok) throw new Error('KWin loadScript failed: ' + (loaded.stderr || loaded.error).slice(0, 240));
    const ids = loaded.stdout.trim().match(/\d+/g);
    scriptId = ids && ids.length ? ids[ids.length - 1] : '';
    if (!scriptId) throw new Error('KWin returned no script ID');
    const since = new Date(Date.now() - 1000).toISOString();
    const entry = '/Scripting/Script' + scriptId;
    const started = await run(dbus, ['org.kde.KWin', entry, 'org.kde.kwin.Script.run']);
    if (!started.ok) throw new Error('KWin run failed: ' + (started.stderr || started.error).slice(0, 240));
    for (let attempt = 0; attempt < 5; attempt++) {
      const logs = await run(journal, ['--user', '--since', since, '--no-pager', '--output=cat', '--grep=' + marker]);
      const answer = parseOutput(logs.stdout, marker);
      if (answer) return answer;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('KWin script returned no visible result (check user journal)');
  } finally {
    if (scriptId) await run(dbus, ['org.kde.KWin', '/Scripting/Script' + scriptId, 'org.kde.kwin.Script.stop'], 3000);
    await run(dbus, ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.unloadScript', label], 3000);
    try { fs.rmSync(folder, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { available, buildScript, parseOutput, windowOps };
