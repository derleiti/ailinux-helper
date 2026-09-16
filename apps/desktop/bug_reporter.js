'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ENDPOINT = new URL('https://api.ailinux.me/v1/bugs/report');
const MAX_LOG_LINES = 250;
const MAX_LOG_BYTES = 768 * 1024;
const MAX_PENDING = 20;

let config = { app: 'AILinux Helper', repo: 'ailinux-helper', version: 'unknown', userData: '', channel: 'release' };
const ring = [];
let installed = false;

function redact(value) {
  let text = String(value ?? '');
  text = text.replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, '$1[REDACTED]');
  text = text.replace(/((?:api[_-]?key|token|secret|password|passwd|resume[_-]?token|pair[_-]?code)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
  text = text.replace(/\b[A-F0-9]{4}(?:-[A-F0-9]{4}){5}\b/gi, '[REDACTED]');
  text = text.replace(/([?&](?:token|key|secret|password|code)=)[^&#\s]+/gi, '$1[REDACTED]');
  return text.length > 48000 ? `${text.slice(0, 48000)}…[truncated]` : text;
}

function scrub(value, depth = 0) {
  if (depth > 8) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 250).map((item) => scrub(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      out[key.slice(0, 128)] = /^(authorization|api_key|apikey|token|access_token|refresh_token|secret|password|passwd|resume_token|workspace_token|pair_code)$/.test(normalized)
        ? '[REDACTED]' : scrub(item, depth + 1);
    }
    return out;
  }
  return typeof value === 'string' ? redact(value) : value;
}

function diagnosticsDir() {
  const base = config.userData || path.join(os.homedir(), '.ailinux');
  return path.join(base, 'diagnostics');
}
function runtimeLogPath() { return path.join(diagnosticsDir(), 'helper-runtime.jsonl'); }
function pendingPath() { return path.join(diagnosticsDir(), 'pending-reports.json'); }
function installIdPath() { return path.join(diagnosticsDir(), 'install-id'); }

function ensureDir() { fs.mkdirSync(diagnosticsDir(), { recursive: true, mode: 0o700 }); }

function rotateLog() {
  try {
    const file = runtimeLogPath();
    if (!fs.existsSync(file) || fs.statSync(file).size <= MAX_LOG_BYTES) return;
    const previous = `${file}.previous`;
    try { fs.unlinkSync(previous); } catch {}
    fs.renameSync(file, previous);
  } catch {}
}

function log(event, detail = {}) {
  const record = scrub({ ts: new Date().toISOString(), event: String(event || 'event'), detail });
  const line = JSON.stringify(record);
  ring.push(line);
  while (ring.length > MAX_LOG_LINES) ring.shift();
  try {
    ensureDir(); rotateLog(); fs.appendFileSync(runtimeLogPath(), `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {}
}

function collectLogs() {
  const lines = [];
  try {
    const fileLines = fs.readFileSync(runtimeLogPath(), 'utf8').split(/\r?\n/).filter(Boolean);
    lines.push(...fileLines.slice(-MAX_LOG_LINES));
  } catch {}
  lines.push(...ring);
  return lines.slice(-MAX_LOG_LINES).map(redact);
}

function installId() {
  try {
    ensureDir();
    const file = installIdPath();
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim().slice(0, 128);
    const id = crypto.randomUUID();
    fs.writeFileSync(file, `${id}\n`, { encoding: 'utf8', mode: 0o600 });
    return id;
  } catch { return ''; }
}

function basePayload(eventType, delivery) {
  return {
    app: config.app,
    repo: config.repo,
    version: config.version,
    platform: process.platform,
    os_version: `${os.type()} ${os.release()}`,
    arch: process.arch,
    channel: config.channel,
    event_type: eventType,
    delivery,
    install_id: installId(),
    logs: collectLogs(),
    metadata: scrub({ node: process.version, electron: process.versions.electron || '', locale: Intl.DateTimeFormat().resolvedOptions().locale }),
  };
}

function readPending() {
  try { const parsed = JSON.parse(fs.readFileSync(pendingPath(), 'utf8')); return Array.isArray(parsed) ? parsed.slice(-MAX_PENDING) : []; }
  catch { return []; }
}
function writePending(queue) {
  ensureDir();
  const file = pendingPath(), tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(queue.slice(-MAX_PENDING)), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}
function queue(payload) {
  const item = { ...payload, _local_id: crypto.randomUUID() };
  const pending = readPending(); pending.push(item); writePending(pending);
  return item._local_id;
}

function post(payload) {
  const clean = { ...payload }; delete clean._local_id;
  const body = Buffer.from(JSON.stringify(scrub(clean)), 'utf8');
  return new Promise((resolve) => {
    const req = https.request({
      protocol: ENDPOINT.protocol, hostname: ENDPOINT.hostname, port: ENDPOINT.port || 443,
      path: ENDPOINT.pathname, method: 'POST', timeout: 5000,
      headers: { 'content-type': 'application/json', 'content-length': body.length, 'user-agent': `AILinux-Helper-Desktop/${config.version}` },
    }, (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end(body);
  });
}

async function flushPending() {
  const pending = readPending();
  if (!pending.length) return { sent: 0, remaining: 0 };
  const keep = []; let sent = 0;
  for (const item of pending) {
    if (await post(item)) sent += 1; else keep.push(item);
  }
  try { writePending(keep); } catch {}
  return { sent, remaining: keep.length };
}

function captureCrash(error, origin = 'uncaughtException') {
  const payload = basePayload('crash', 'automatic');
  payload.exception_type = error?.name || 'Error';
  payload.exception_message = redact(error?.message || String(error || 'unknown error'));
  payload.stack = redact(error?.stack || '');
  payload.metadata.origin = redact(origin);
  const localId = queue(payload);
  log('crash_queued', { local_id: localId, type: payload.exception_type });
  post(payload).then((ok) => {
    if (!ok) return;
    try { writePending(readPending().filter((item) => item._local_id !== localId)); } catch {}
  }).catch(() => {});
}

async function submitManual(message = '') {
  const payload = basePayload('manual', 'manual');
  payload.user_message = redact(message).slice(0, 8000);
  const ok = await post(payload);
  if (!ok) queue(payload);
  log('manual_report', { submitted: ok, queued: !ok });
  return { ok, queued: !ok };
}

async function startupSelfTest() {
  const checks = {};
  let ok = true;
  try {
    ensureDir();
    const probe = path.join(diagnosticsDir(), '.selftest');
    fs.writeFileSync(probe, 'ok', { encoding: 'utf8', mode: 0o600 }); fs.unlinkSync(probe);
    checks.private_storage_writable = true;
  } catch (error) { ok = false; checks.private_storage_writable = false; checks.private_storage_error = redact(error?.message); }
  checks.runtime = process.version;
  checks.electron = process.versions.electron || '';
  log('startup_selftest', { ok, checks });
  if (!ok) {
    const payload = basePayload('selftest', 'selftest'); payload.selftest = checks; payload.exception_message = 'Startup self-test failed';
    if (!(await post(payload))) queue(payload);
  }
  return { ok, checks };
}

function configure(options = {}) {
  config = { ...config, ...options };
  if (installed) return;
  installed = true;
  process.on('uncaughtExceptionMonitor', (error, origin) => captureCrash(error, origin));
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const payload = basePayload('error', 'automatic');
    payload.exception_type = error.name; payload.exception_message = redact(error.message); payload.stack = redact(error.stack || '');
    post(payload).then((ok) => { if (!ok) queue(payload); }).catch(() => queue(payload));
  });
  log('reporter_configured', { version: config.version, channel: config.channel });
  flushPending().catch(() => {});
  startupSelfTest().catch(() => {});
}

module.exports = { configure, log, captureCrash, submitManual, flushPending, startupSelfTest, redact, scrub };
