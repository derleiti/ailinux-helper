'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ACTIONS = Object.freeze(['start', 'stop', 'restart']);
const SERVICES = Object.freeze({
  helper_background: Object.freeze({ id: 'helper_background', label: 'AILinux Helper background service', unit: 'ailinux-workspace-browser.service', scope: 'user' }),
  triforce: Object.freeze({ id: 'triforce', label: 'TriForce local service', unit: 'triforce.service', scope: 'system' }),
  ollama: Object.freeze({ id: 'ollama', label: 'Ollama local model service', unit: 'ollama.service', scope: 'system' }),
});

function which(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return '';
}

function run(file, args, timeout = 15000) {
  return new Promise((resolve) => {
    if (!file) { resolve({ ok: false, code: -1, stdout: '', stderr: 'executable not found' }); return; }
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout || '').trim(), stderr: String(stderr || (error && error.message) || '').trim() });
    });
  });
}

function descriptor(id) {
  return SERVICES[String(id || '')] || null;
}

async function status(id) {
  const svc = descriptor(id);
  if (!svc) return { ok: false, id: String(id || ''), error: 'unsupported service id' };
  if (process.platform !== 'linux') return { ok: true, ...svc, available: false, active: false, state: 'unsupported', detail: 'Typed systemd service control is currently available on Linux only.' };
  const systemctl = which('systemctl');
  if (!systemctl) return { ok: true, ...svc, available: false, active: false, state: 'unavailable', detail: 'systemctl not found.' };
  const args = [];
  if (svc.scope === 'user') args.push('--user');
  args.push('show', svc.unit, '--property=LoadState', '--property=ActiveState', '--property=SubState', '--property=UnitFileState', '--no-pager');
  const result = await run(systemctl, args, 10000);
  const props = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) props[line.slice(0, at)] = line.slice(at + 1);
  }
  const loadState = props.LoadState || 'not-found';
  const activeState = props.ActiveState || 'inactive';
  return {
    ok: true, ...svc,
    available: loadState !== 'not-found',
    active: activeState === 'active',
    state: activeState,
    subState: props.SubState || '',
    enabled: props.UnitFileState || '',
    detail: loadState === 'not-found' ? `${svc.unit} is not installed.` : `${svc.unit}: ${activeState}${props.SubState ? '/' + props.SubState : ''}.`,
  };
}

async function list() {
  const out = [];
  for (const id of Object.keys(SERVICES)) out.push(await status(id));
  return out;
}

async function action(id, actionName) {
  const svc = descriptor(id);
  const action = String(actionName || '');
  if (!svc) return { ok: false, id: String(id || ''), action, error: 'unsupported service id' };
  if (!ACTIONS.includes(action)) return { ok: false, id: svc.id, action, error: 'unsupported service action' };
  if (process.platform !== 'linux') return { ok: false, id: svc.id, action, error: 'service control is supported on Linux only' };
  const current = await status(svc.id);
  if (!current.available) return { ok: false, id: svc.id, action, error: `${svc.unit} is not installed` };
  const systemctl = which('systemctl');
  if (!systemctl) return { ok: false, id: svc.id, action, error: 'systemctl not found' };
  let file = systemctl;
  const args = [];
  if (svc.scope === 'user') {
    args.push('--user', action, svc.unit);
  } else {
    const pkexec = which('pkexec');
    if (!pkexec) return { ok: false, id: svc.id, action, error: 'pkexec (PolicyKit) is required for system service control' };
    file = pkexec;
    args.push(systemctl, action, svc.unit);
  }
  const result = await run(file, args, 90000);
  const next = await status(svc.id);
  return { ok: result.ok, id: svc.id, action, service: next, error: result.ok ? '' : (result.stderr || 'service action failed') };
}

module.exports = { ACTIONS, SERVICES, descriptor, status, list, action };
