'use strict';

/** Typed cross-platform host adapters used by the MCP capability broker.
 * No operation falls back to an unrestricted shell. Mutating calls are expected
 * to be confirmed by main.js before reaching this module.
 */
const { execFile, execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVICE_RE = /^[A-Za-z0-9_.@:-]{1,256}$/;
const MAX_OUTPUT = 128 * 1024;

function which(...names) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const name of names) {
    if (!name) continue;
    if (path.isAbsolute(name)) {
      try { fs.accessSync(name, fs.constants.X_OK); return name; } catch { continue; }
    }
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      for (const ext of extensions) {
        const candidate = path.join(dir, name + ext);
        try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
      }
    }
  }
  return '';
}

function run(file, args = [], options = {}) {
  return new Promise((resolve) => {
    execFile(file, args.map((v) => String(v)), {
      timeout: Math.max(1000, Math.min(Number(options.timeout) || 15000, 120000)),
      windowsHide: true,
      maxBuffer: MAX_OUTPUT,
      cwd: options.cwd,
      env: options.env || process.env,
    }, (error, stdout, stderr) => {
      const code = error && typeof error.code === 'number' ? error.code : (error ? 1 : 0);
      resolve({ ok: code === 0, exit_code: code, stdout: String(stdout || '').slice(0, MAX_OUTPUT), stderr: String(stderr || '').slice(0, 32768), error: error ? String(error.message || error) : '' });
    });
  });
}

function powershell() { return which('pwsh', 'powershell'); }

function systemPython() {
  for (const candidate of ['/usr/bin/python3', '/bin/python3']) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return which('python3');
}

function portalBridgePath() {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'linux_portal_input.py') : '';
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, 'linux_portal_input.py');
}


let portalProbe = null;
let portalChild = null;
let portalSeq = 0;
let portalBuffer = '';
const portalPending = new Map();

function linuxSessionType(env = process.env, argv = process.argv) {
  if (process.platform !== 'linux') return '';
  const declared = String(env.XDG_SESSION_TYPE || '').trim().toLowerCase();
  if (declared === 'wayland' || declared === 'x11') return declared;
  if (env.WAYLAND_DISPLAY || argv.some((arg) => String(arg).includes('ozone-platform=wayland'))) return 'wayland';
  if (env.DISPLAY) return 'x11';
  return 'unknown';
}

function linuxWaylandSession() { return linuxSessionType() === 'wayland'; }

function portalInputAvailable() {
  if (process.platform !== 'linux') return false;
  if (portalProbe !== null) return portalProbe;
  const python = systemPython();
  const bridge = portalBridgePath();
  if (!python || !fs.existsSync(bridge)) return (portalProbe = false);
  try {
    execFileSync(python, ['-c', 'import dbus,gi; b=dbus.SessionBus(); o=b.get_object("org.freedesktop.portal.Desktop","/org/freedesktop/portal/desktop"); p=dbus.Interface(o,"org.freedesktop.DBus.Properties"); assert int(p.Get("org.freedesktop.portal.RemoteDesktop","AvailableDeviceTypes")) & 3'], { timeout: 3000, stdio: 'ignore', env: process.env });
    portalProbe = true;
  } catch {
    portalProbe = false;
  }
  return portalProbe;
}

function linuxInputAdapter() {
  if (!linuxWaylandSession() && which('xdotool')) return 'xdotool';
  if (portalInputAvailable()) return 'xdg-remote-desktop-portal';
  return which('xdotool') ? 'xdotool' : '';
}

function rejectPortalPending(error) {
  for (const { reject, timer } of portalPending.values()) { clearTimeout(timer); reject(error); }
  portalPending.clear();
}

function ensurePortalChild() {
  if (portalChild && !portalChild.killed) return portalChild;
  const python = systemPython();
  if (!python || !portalInputAvailable()) throw new Error('XDG RemoteDesktop input bridge unavailable');
  const child = spawn(python, [portalBridgePath()], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  portalChild = child;
  portalBuffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    portalBuffer += chunk;
    while (portalBuffer.includes('\n')) {
      const idx = portalBuffer.indexOf('\n');
      const line = portalBuffer.slice(0, idx).trim();
      portalBuffer = portalBuffer.slice(idx + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === undefined || msg.id === null) continue;
      const pending = portalPending.get(String(msg.id));
      if (!pending) continue;
      portalPending.delete(String(msg.id));
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(String(msg.error)));
      else pending.resolve(msg.result || msg);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => {});
  child.on('exit', (code, signal) => {
    if (portalChild === child) portalChild = null;
    rejectPortalPending(new Error(`XDG RemoteDesktop bridge exited (${code ?? signal ?? 'unknown'})`));
  });
  child.on('error', (error) => {
    if (portalChild === child) portalChild = null;
    rejectPortalPending(error);
  });
  return child;
}

function portalComputerInput(args = {}) {
  const child = ensurePortalChild();
  const id = String(++portalSeq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      portalPending.delete(id);
      reject(new Error('XDG RemoteDesktop input request timed out'));
    }, 130000);
    portalPending.set(id, { resolve, reject, timer });
    try { child.stdin.write(JSON.stringify({ id, args }) + '\n'); }
    catch (error) { clearTimeout(timer); portalPending.delete(id); reject(error); }
  });
}

function windowAdapter() {
  if (process.platform === 'darwin') return which('osascript') ? 'osascript' : '';
  if (process.platform === 'win32') return powershell() ? 'powershell' : '';
  return which('xdotool') ? 'xdotool' : (which('wmctrl') ? 'wmctrl' : '');
}
function inputAdapter() {
  if (process.platform === 'darwin') return which('osascript') ? 'osascript' : '';
  if (process.platform === 'win32') return powershell() ? 'powershell' : '';
  return linuxInputAdapter();
}

function capabilities() {
  return {
    platform: process.platform,
    process: true,
    services: process.platform === 'win32' ? Boolean(powershell()) : Boolean(which(process.platform === 'darwin' ? 'launchctl' : 'systemctl')),
    apps: true,
    windows: Boolean(windowAdapter()),
    input: Boolean(inputAdapter()),
    window_adapter: windowAdapter() || 'unavailable',
    input_adapter: inputAdapter() || 'unavailable',
    linux_session: process.platform === 'linux' ? linuxSessionType() : '',
  };
}

function parseLimit(value, fallback = 100) { return Math.max(1, Math.min(Number(value) || fallback, 500)); }
function cleanQuery(value) { return String(value || '').trim().toLowerCase().slice(0, 256); }

async function processOps(args = {}) {
  const action = String(args.action || 'list').toLowerCase();
  const pid = Number(args.pid || 0);
  if (!['list', 'get', 'signal'].includes(action)) throw new Error('unsupported process action');
  if (action !== 'list' && (!Number.isInteger(pid) || pid < 1)) throw new Error('pid is required');

  if (process.platform === 'win32') {
    const ps = powershell(); if (!ps) throw new Error('PowerShell unavailable');
    if (action === 'signal') {
      const force = String(args.signal || 'terminate') === 'kill';
      return run(which('taskkill') || 'taskkill.exe', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]);
    }
    const script = action === 'get'
      ? '$p=Get-Process -Id ([int]$args[0]) -ErrorAction Stop; $p|Select-Object Id,ProcessName,Path,CPU,WorkingSet64,StartTime|ConvertTo-Json -Compress'
      : '$q=$args[0].ToLowerInvariant();$n=[int]$args[1];Get-Process|Where-Object{$q -eq "" -or $_.ProcessName.ToLowerInvariant().Contains($q)}|Select-Object -First $n Id,ProcessName,Path,CPU,WorkingSet64,StartTime|ConvertTo-Json -Compress';
    return run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script, action === 'get' ? String(pid) : cleanQuery(args.query), String(parseLimit(args.limit))]);
  }

  if (action === 'signal') {
    const sig = { terminate: 'SIGTERM', kill: 'SIGKILL', interrupt: 'SIGINT' }[String(args.signal || 'terminate')];
    if (!sig) throw new Error('unsupported signal');
    try { process.kill(pid, sig); return { ok: true, pid, signal: sig }; }
    catch (error) { return { ok: false, pid, signal: sig, error: String(error.message || error) }; }
  }
  const ps = which('ps'); if (!ps) throw new Error('ps unavailable');
  const listArgs = process.platform === 'darwin'
    ? ['-axo', 'pid=,ppid=,user=,%cpu=,%mem=,stat=,comm=,args=']
    : ['-eo', 'pid=,ppid=,user=,pcpu=,pmem=,stat=,comm=,args=', '--sort=-pcpu'];
  const result = await run(ps, action === 'get'
    ? ['-p', String(pid), '-o', 'pid=,ppid=,user=,pcpu=,pmem=,stat=,comm=,args=']
    : listArgs);
  if (action === 'list' && result.ok) {
    const q = cleanQuery(args.query), limit = parseLimit(args.limit);
    let lines = result.stdout.split(/\r?\n/).filter(Boolean);
    if (q) lines = lines.filter((line) => line.toLowerCase().includes(q));
    result.stdout = lines.slice(0, limit).join('\n') + (lines.length ? '\n' : '');
    result.truncated = lines.length > limit;
  }
  return result;
}

async function serviceOps(args = {}) {
  const action = String(args.action || 'list').toLowerCase();
  const service = String(args.service || '').trim();
  const query = cleanQuery(args.query), limit = parseLimit(args.limit);
  if (!['list', 'get', 'start', 'stop', 'restart'].includes(action)) throw new Error('unsupported service action');
  if (action !== 'list' && !SERVICE_RE.test(service)) throw new Error('invalid service name');

  if (process.platform === 'win32') {
    const ps = powershell(); if (!ps) throw new Error('PowerShell unavailable');
    const scripts = {
      list: '$q=$args[0].ToLowerInvariant();$n=[int]$args[1];Get-Service|Where-Object{$q -eq "" -or $_.Name.ToLowerInvariant().Contains($q) -or $_.DisplayName.ToLowerInvariant().Contains($q)}|Select-Object -First $n Name,DisplayName,Status,StartType|ConvertTo-Json -Compress',
      get: 'Get-Service -Name $args[0] -ErrorAction Stop|Select-Object Name,DisplayName,Status,StartType|ConvertTo-Json -Compress',
      start: 'Start-Service -Name $args[0] -ErrorAction Stop; Get-Service -Name $args[0]|Select-Object Name,Status|ConvertTo-Json -Compress',
      stop: 'Stop-Service -Name $args[0] -ErrorAction Stop; Get-Service -Name $args[0]|Select-Object Name,Status|ConvertTo-Json -Compress',
      restart: 'Restart-Service -Name $args[0] -ErrorAction Stop; Get-Service -Name $args[0]|Select-Object Name,Status|ConvertTo-Json -Compress',
    };
    return run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', scripts[action], ...(action === 'list' ? [query, String(limit)] : [service])], { timeout: action === 'list' || action === 'get' ? 15000 : 60000 });
  }

  if (process.platform === 'darwin') {
    const ctl = which('launchctl'); if (!ctl) throw new Error('launchctl unavailable');
    if (action === 'list') {
      const r = await run(ctl, ['list']); if (!r.ok) return r;
      const lines = r.stdout.split(/\r?\n/).filter((line) => !query || line.toLowerCase().includes(query));
      r.stdout = lines.slice(0, limit + 1).join('\n') + '\n'; r.truncated = lines.length > limit + 1; return r;
    }
    if (action === 'get') return run(ctl, ['print', `system/${service}`]);
    return run(ctl, [action === 'restart' ? 'kickstart' : action, ...(action === 'restart' ? ['-k'] : []), `system/${service}`], { timeout: 60000 });
  }

  const systemctl = which('systemctl'); if (!systemctl) throw new Error('systemctl unavailable');
  if (action === 'list') {
    const r = await run(systemctl, ['list-units', '--type=service', '--all', '--no-pager', '--no-legend', '--plain']);
    if (!r.ok) return r;
    const lines = r.stdout.split(/\r?\n/).filter((line) => line && (!query || line.toLowerCase().includes(query)));
    r.stdout = lines.slice(0, limit).join('\n') + (lines.length ? '\n' : ''); r.truncated = lines.length > limit; return r;
  }
  if (action === 'get') return run(systemctl, ['show', service, '--no-pager', '--property=Id,Description,LoadState,ActiveState,SubState,UnitFileState,MainPID']);
  const pkexec = which('pkexec');
  return pkexec ? run(pkexec, [systemctl, action, service], { timeout: 60000 }) : run(systemctl, [action, service], { timeout: 60000 });
}

function detachedLaunch(file, args = []) {
  try {
    const child = spawn(file, args.map((v) => String(v)), { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref(); return { ok: true, pid: child.pid || null, app: file };
  } catch (error) { return { ok: false, error: String(error.message || error), app: file }; }
}

function escapeApple(value) { return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

async function appOps(args = {}) {
  const action = String(args.action || 'list').toLowerCase();
  const appName = String(args.app || '').trim();
  if (!['list', 'launch', 'focus', 'close'].includes(action)) throw new Error('unsupported app action');
  if (action === 'list') return processOps({ action: 'list', query: args.query || '', limit: args.limit || 100 });
  if (!appName || appName.length > 512 || /[\r\n\0]/.test(appName)) throw new Error('invalid app');
  if (action === 'launch') {
    if (process.platform === 'darwin') return run(which('open') || 'open', ['-a', appName, ...(Array.isArray(args.args) && args.args.length ? ['--args', ...args.args.slice(0, 64)] : [])]);
    return detachedLaunch(appName, Array.isArray(args.args) ? args.args.slice(0, 64) : []);
  }
  if (process.platform === 'darwin') {
    const osascript = which('osascript'); if (!osascript) throw new Error('osascript unavailable');
    const verb = action === 'focus' ? 'activate' : 'quit';
    return run(osascript, ['-e', `tell application "${escapeApple(appName)}" to ${verb}`]);
  }
  if (process.platform === 'win32') {
    const ps = powershell(); if (!ps) throw new Error('PowerShell unavailable');
    const script = action === 'focus'
      ? '$w=New-Object -ComObject WScript.Shell; if(-not $w.AppActivate($args[0])){exit 2}'
      : 'Get-Process -Name $args[0] -ErrorAction Stop|ForEach-Object{$_.CloseMainWindow()|Out-Null}';
    return run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script, appName]);
  }
  const xdotool = which('xdotool');
  if (action === 'focus' && xdotool) return run(xdotool, ['search', '--onlyvisible', '--name', appName, 'windowactivate']);
  if (action === 'close' && xdotool) return run(xdotool, ['search', '--onlyvisible', '--name', appName, 'windowclose']);
  throw new Error('desktop app focus/close adapter unavailable on this Linux session');
}

async function linuxWindowIds(title) {
  const xdotool = which('xdotool'); if (!xdotool) throw new Error('xdotool unavailable');
  const search = await run(xdotool, ['search', '--onlyvisible', '--name', title || '.']);
  if (!search.ok && !search.stdout.trim()) return [];
  return search.stdout.split(/\r?\n/).map((v) => v.trim()).filter(Boolean).slice(0, 200);
}

async function windowOps(args = {}) {
  const action = String(args.action || 'list').toLowerCase();
  const id = String(args.window_id || '').trim(), title = String(args.title || '').trim();
  if (!['list', 'focus', 'close', 'minimize', 'maximize'].includes(action)) throw new Error('unsupported window action');
  if (process.platform === 'linux') {
    const xdotool = which('xdotool'); if (!xdotool) throw new Error('window control unavailable: install/enable a compatible xdotool adapter for this session');
    if (action === 'list') {
      const ids = await linuxWindowIds(title || '.'); const windows = [];
      for (const wid of ids.slice(0, parseLimit(args.limit))) {
        const name = await run(xdotool, ['getwindowname', wid]); const pid = await run(xdotool, ['getwindowpid', wid]);
        windows.push({ id: wid, title: name.stdout.trim(), pid: Number(pid.stdout.trim()) || null });
      }
      return { ok: true, windows };
    }
    const ids = id ? [id] : await linuxWindowIds(title);
    if (!ids.length) throw new Error('window not found');
    const verb = { focus: 'windowactivate', close: 'windowclose', minimize: 'windowminimize', maximize: 'windowsize' }[action];
    if (action === 'maximize') return run(xdotool, [verb, ids[0], '100%', '100%']);
    return run(xdotool, [verb, ids[0]]);
  }
  if (process.platform === 'darwin') {
    const osascript = which('osascript'); if (!osascript) throw new Error('osascript unavailable');
    if (action === 'list') return run(osascript, ['-e', 'tell application "System Events" to get {name, unix id} of every application process whose background only is false']);
    if (!title) throw new Error('title/app name required on macOS');
    const target = escapeApple(title);
    if (action === 'focus') return run(osascript, ['-e', `tell application "${target}" to activate`]);
    if (action === 'close') return run(osascript, ['-e', `tell application "${target}" to quit`]);
    const attr = action === 'minimize' ? 'value of attribute "AXMinimized" to true' : 'value of attribute "AXFullScreen" to true';
    return run(osascript, ['-e', `tell application "System Events" to tell process "${target}" to set ${attr} of front window`]);
  }
  const ps = powershell(); if (!ps) throw new Error('PowerShell unavailable');
  if (action === 'list') {
    const script = 'Get-Process|Where-Object{$_.MainWindowHandle -ne 0}|Select-Object Id,ProcessName,MainWindowTitle,MainWindowHandle|ConvertTo-Json -Compress';
    return run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
  }
  const script = action === 'focus'
    ? '$w=New-Object -ComObject WScript.Shell;if(-not $w.AppActivate($args[0])){exit 2}'
    : action === 'close'
      ? 'Get-Process|Where-Object{$_.MainWindowTitle -like ("*"+$args[0]+"*")}|ForEach-Object{$_.CloseMainWindow()|Out-Null}'
      : '$src="using System;using System.Runtime.InteropServices;public class W{[DllImport(\"user32.dll\")]public static extern bool ShowWindowAsync(IntPtr h,int c);}";Add-Type $src;$code=if($args[1]-eq "minimize"){6}else{3};Get-Process|Where-Object{$_.MainWindowTitle -like ("*"+$args[0]+"*")}|ForEach-Object{[W]::ShowWindowAsync($_.MainWindowHandle,$code)|Out-Null}';
  return run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script, title || id, action]);
}

const KEY_MAP_MAC = { enter: 36, return: 36, escape: 53, esc: 53, tab: 48, space: 49, backspace: 51, delete: 117, up: 126, down: 125, left: 123, right: 124 };
async function computerInput(args = {}) {
  const action = String(args.action || '').toLowerCase();
  if (!['click', 'double_click', 'move', 'scroll', 'type', 'key'].includes(action)) throw new Error('unsupported input action');
  if (process.platform === 'linux') {
    if (linuxInputAdapter() === 'xdg-remote-desktop-portal') return portalComputerInput(args);
    const xdotool = which('xdotool'); if (!xdotool) throw new Error('computer input unavailable: no XDG RemoteDesktop portal or xdotool adapter is available');
    const x = Math.trunc(Number(args.x || 0)), y = Math.trunc(Number(args.y || 0));
    if (action === 'move') return run(xdotool, ['mousemove', String(x), String(y)]);
    if (action === 'click' || action === 'double_click') {
      const button = { left: '1', middle: '2', right: '3' }[String(args.button || 'left')] || '1';
      return run(xdotool, ['mousemove', String(x), String(y), 'click', ...(action === 'double_click' ? ['--repeat', '2', '--delay', '100'] : []), button]);
    }
    if (action === 'scroll') {
      const dy = Math.trunc(Number(args.delta_y || 0)); const button = dy < 0 ? '4' : '5'; const count = Math.min(100, Math.max(1, Math.abs(dy) || 1));
      return run(xdotool, ['click', '--repeat', String(count), button]);
    }
    if (action === 'type') return run(xdotool, ['type', '--clearmodifiers', '--delay', '1', String(args.text || '').slice(0, 65536)], { timeout: 60000 });
    return run(xdotool, ['key', '--clearmodifiers', (Array.isArray(args.keys) ? args.keys : []).slice(0, 16).join('+')]);
  }
  if (process.platform === 'darwin') {
    const osascript = which('osascript'); if (!osascript) throw new Error('osascript unavailable');
    const x = Math.trunc(Number(args.x || 0)), y = Math.trunc(Number(args.y || 0));
    if (action === 'move') throw new Error('pointer move without click is not exposed by the macOS adapter');
    if (action === 'click' || action === 'double_click') {
      const click = `tell application "System Events" to click at {${x},${y}}`;
      return run(osascript, action === 'double_click' ? ['-e', click, '-e', 'delay 0.1', '-e', click] : ['-e', click]);
    }
    if (action === 'scroll') return run(osascript, ['-e', `tell application "System Events" to key code ${Number(args.delta_y || 0) < 0 ? 126 : 125}`]);
    if (action === 'type') return run(osascript, ['-e', `tell application "System Events" to keystroke "${escapeApple(String(args.text || '').slice(0, 65536))}"`]);
    const keys = Array.isArray(args.keys) ? args.keys.slice(0, 16) : [];
    if (keys.length !== 1 || KEY_MAP_MAC[String(keys[0]).toLowerCase()] === undefined) throw new Error('macOS key adapter currently accepts one navigation/control key');
    return run(osascript, ['-e', `tell application "System Events" to key code ${KEY_MAP_MAC[String(keys[0]).toLowerCase()]}`]);
  }
  const ps = powershell(); if (!ps) throw new Error('PowerShell unavailable');
  const x = Math.trunc(Number(args.x || 0)), y = Math.trunc(Number(args.y || 0));
  if (action === 'type' || action === 'key') {
    const value = action === 'type' ? String(args.text || '').slice(0, 65536) : (Array.isArray(args.keys) ? args.keys.slice(0, 16).join('+') : '');
    const script = '$w=New-Object -ComObject WScript.Shell;$w.SendKeys($args[0])';
    return run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script, value]);
  }
  const script = '$src="using System;using System.Runtime.InteropServices;public class I{[DllImport(\"user32.dll\")]public static extern bool SetCursorPos(int x,int y);[DllImport(\"user32.dll\")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,UIntPtr e);}";Add-Type $src;[I]::SetCursorPos([int]$args[0],[int]$args[1])|Out-Null;if($args[2]-eq "click" -or $args[2]-eq "double_click"){$n=if($args[2]-eq "double_click"){2}else{1};for($i=0;$i-lt$n;$i++){[I]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[I]::mouse_event(4,0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 80)}}elseif($args[2]-eq "scroll"){[I]::mouse_event(2048,0,0,[int]$args[3],[UIntPtr]::Zero)}';
  return run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script, String(x), String(y), action, String(Math.trunc(Number(args.delta_y || 0)))]);
}

module.exports = { which, run, capabilities, processOps, serviceOps, appOps, windowOps, computerInput, windowAdapter, inputAdapter, linuxSessionType, linuxWaylandSession, portalInputAvailable };
