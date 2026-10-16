import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection, createServer as createSocketServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { root, upstream, requireSource } from './runtime-env.mjs';
import { verifyMagpieInstallation } from './magpie-dependency.mjs';
import { buildOpenClawFragment } from '../plugins/rein-router/policy.mjs';
import { parseProcessAncestry, descendantPids } from '../plugins/rein-router/process-tree.mjs';

const fail = reason => { throw new Error(`managed_magpie_probe_${reason}`); };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function waitForClose(child, milliseconds) {
  return new Promise(resolve => {
    const done = closed => { clearTimeout(timer); child.off('close', onClose); resolve(closed); };
    const onClose = () => done(true);
    const timer = setTimeout(() => done(false), milliseconds);
    child.once('close', onClose);
  });
}

async function vacantPort() {
  const server = createSocketServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function listening(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false));
    socket.setTimeout(250, () => done(true));
  });
}

async function jsonMetadata(url, headers) {
  try {
    const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(500) });
    if (!response.ok || response.redirected) { await response.body?.cancel(); return null; }
    const text = await response.text();
    if (text.length > 64 * 1024) return null;
    return JSON.parse(text);
  } catch { return null; }
}

async function processSnapshot(args) {
  return new Promise((resolve, reject) => {
    execFile('ps', args, { encoding: 'utf8', timeout: 1000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, LC_ALL: 'C' } }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

async function captureOwnedTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return new Map();
  const ancestry = parseProcessAncestry(await processSnapshot(['-axo', 'pid=,ppid=']));
  if (ancestry.get(child.pid) !== process.pid) fail('process_owner_invalid');
  const pids = [child.pid, ...descendantPids(ancestry, child.pid)];
  const records = new Map();
  const text = await processSnapshot(['-p', pids.join(','), '-o', 'pid=,lstart=']);
  for (const line of text.trim().split('\n').filter(Boolean)) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match && pids.includes(Number(match[1]))) records.set(Number(match[1]), match[2].replace(/\s+/g, ' '));
  }
  return records;
}

async function forceOwnedCleanup(records) {
  if (!records.size) return;
  let text;
  try { text = await processSnapshot(['-p', [...records.keys()].join(','), '-o', 'pid=,lstart=']); }
  catch { return; }
  for (const line of text.trim().split('\n').filter(Boolean).reverse()) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match || records.get(Number(match[1])) !== match[2].replace(/\s+/g, ' ')) continue;
    try { process.kill(Number(match[1]), 'SIGKILL'); } catch { /* Captured child already exited. */ }
  }
}

async function runProbe() {
  if (process.argv.slice(2).filter(argument => argument !== '--').length) fail('arguments_invalid');
  requireSource();
  const prepared = await verifyMagpieInstallation({ root });
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'rein-native-managed-magpie-')));
  let child, upstreamServer, proxyServer, stopped = false, owned = new Map(), interrupted = false;
  const onInterrupt = () => { interrupted = true; };
  process.once('SIGTERM', onInterrupt); process.once('SIGINT', onInterrupt);
  let modelRequests = 0;
  const key = `sk-magpie-key-${randomBytes(24).toString('hex')}`;
  try {
    upstreamServer = createServer((request, response) => {
      if (request.method === 'POST') modelRequests++;
      request.resume();
      response.writeHead(request.method === 'GET' ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify(request.method === 'GET' ? { data: [{ id: 'capable' }] } : { error: { message: 'Synthetic lifecycle probe never requests inference' } }));
    });
    await new Promise(resolve => upstreamServer.listen(0, '127.0.0.1', resolve));
    const upstreamPort = upstreamServer.address().port;
    // Any incidental update check is refused on loopback, never forwarded.
    proxyServer = createServer((request, response) => { request.resume(); response.writeHead(403); response.end(); });
    proxyServer.on('connect', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'));
    await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
    const proxy = `http://127.0.0.1:${proxyServer.address().port}`;
    const magpiePort = await vacantPort(); const nativePort = await vacantPort();
    const magpieRoot = join(temporary, 'magpie'); const homeDir = join(magpieRoot, 'home');
    const profile = join(magpieRoot, 'config/magpie');
    const workspace = join(temporary, 'workspace'); const state = join(temporary, 'state');
    for (const path of [homeDir, profile, workspace, state]) mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(profile, 'providers.json'), JSON.stringify({ providers: [{ id: 'fixture', name: 'Synthetic lifecycle fixture',
      key: 'synthetic-upstream-key', chat: `http://127.0.0.1:${upstreamPort}/v1`, models: ['capable'] }], noAutoGroups: true }), { mode: 0o600 });
    writeFileSync(join(profile, 'caller-keys.json'), JSON.stringify([{ id: 'rein-lifecycle', name: 'Synthetic lifecycle caller',
      secret: key, models: ['fixture/capable'] }]), { mode: 0o600 });
    const baseUrl = `http://127.0.0.1:${magpiePort}/v1`;
    const cfg = buildOpenClawFragment({ enabled: true,
      gateway: { baseUrl, apiKeyEnvVar: 'REIN_MANAGED_LIFECYCLE_KEY',
        managed: { binaryPath: prepared.binaryPath, homeDir, allowSubscriptionAccounts: false } },
      routes: [{ id: 'capable', provider: 'Synthetic fixture', gatewayModel: 'fixture/capable',
        billingSource: 'Synthetic included allowance', billingMode: 'subscription', billingVerified: true,
        purpose: 'Native service lifecycle verification', effort: 'medium', contextWindow: 32768, maxTokens: 1024 }],
      defaultRoute: 'capable', fallbackRoutes: [], decision: { allowPaidJev: false },
    }, join(root, 'plugins/rein-router'));
    cfg.gateway = { mode: 'local', bind: 'loopback', port: nativePort,
      auth: { mode: 'token', token: randomBytes(24).toString('hex') } };
    Object.assign(cfg.agents.defaults, { workspace, skipBootstrap: true, compaction: { memoryFlush: { enabled: false } } });
    cfg.memory = { search: { enabled: false, rememberAcrossConversations: false } };
    cfg.channels = {};
    cfg.plugins.allow.push('openai');
    const configPath = join(temporary, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      /^(?:PATH|LANG|LC_[A-Z_]+|TZ|TERM|SYSTEMROOT|COMSPEC|PATHEXT|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/.test(name)));
    const nativeHome = join(temporary, 'native-home');
    for (const path of [nativeHome, join(nativeHome, '.codex'), join(nativeHome, '.claude'), join(nativeHome, '.gemini')])
      mkdirSync(path, { recursive: true, mode: 0o700 });
    Object.assign(env, { PATH: `${join(root, '.toolchain/node_modules/.bin')}${delimiter}${env.PATH ?? ''}`,
      HOME: nativeHome, USERPROFILE: nativeHome, XDG_CONFIG_HOME: join(temporary, 'native-config'),
      XDG_CACHE_HOME: join(temporary, 'native-cache'), XDG_STATE_HOME: join(temporary, 'native-state'),
      XDG_DATA_HOME: join(temporary, 'native-data'), TMPDIR: join(temporary, 'tmp'),
      CODEX_HOME: join(nativeHome, '.codex'), CLAUDE_CONFIG_DIR: join(nativeHome, '.claude'), GEMINI_CLI_HOME: join(nativeHome, '.gemini'),
      OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath, REIN_MANAGED_LIFECYCLE_KEY: key,
      OPENCLAW_SKIP_CRON: '1', OPENCLAW_SKIP_BUNDLED_DOCTOR: '1', NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
      NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' });
    mkdirSync(env.TMPDIR, { mode: 0o700 });
    const outputPath = join(temporary, 'native-output.log'); writeFileSync(outputPath, '', { mode: 0o600 });
    let output = '';
    const capture = bytes => {
      if (output.length < 1024 * 1024) { output += bytes.toString(); writeFileSync(outputPath, output, { mode: 0o600 }); }
    };
    child = spawn(process.execPath, [join(upstream, 'openclaw.mjs'), 'gateway', 'run', '--allow-unconfigured'],
      { cwd: temporary, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    let spawnFailed = false; child.once('error', () => { spawnFailed = true; });
    const headers = { Authorization: `Bearer ${key}`, Origin: 'null' };
    const profileLock = join(magpieRoot, '.rein-magpie.lock');
    const deadline = Date.now() + 150000;
    let nativeReady = false, magpieReady = false;
    while (Date.now() < deadline && !interrupted && !spawnFailed && child.exitCode === null && child.signalCode === null) {
      const [ready, info, models] = await Promise.all([
        jsonMetadata(`http://127.0.0.1:${nativePort}/readyz`),
        jsonMetadata(`http://127.0.0.1:${magpiePort}/`, headers),
        jsonMetadata(`${baseUrl}/models`, headers),
      ]);
      nativeReady = ready?.ready === true;
      magpieReady = info?.name === 'magpie' && info.version === prepared.lock.version &&
        Array.isArray(models?.data) && models.data.length === 1 && models.data[0].id === 'fixture/capable';
      if (nativeReady && magpieReady) break;
      await pause(250);
    }
    if (interrupted) fail('interrupted');
    if (spawnFailed || child.exitCode !== null || child.signalCode !== null) fail('native_gateway_exited');
    if (!nativeReady) fail('native_gateway_not_ready');
    if (!magpieReady) fail('managed_service_not_ready');
    if (!existsSync(profileLock)) fail('profile_lock_missing');
    owned = await captureOwnedTree(child);
    if (owned.size < 2) fail('managed_process_not_owned');
    const lockRecord = JSON.parse(readFileSync(profileLock, 'utf8'));
    if (!owned.has(lockRecord.pid)) fail('profile_lock_owner_invalid');
    if (modelRequests !== 0) fail('unexpected_model_request');
    const exited = waitForClose(child, 15000);
    child.kill('SIGTERM');
    const ended = await exited;
    if (!ended) fail('native_shutdown_timeout');
    stopped = true;
    const stopDeadline = Date.now() + 5000;
    while (Date.now() < stopDeadline && (existsSync(profileLock) || await listening(magpiePort))) await pause(50);
    if (await listening(magpiePort)) fail('managed_port_remained_open');
    if (existsSync(profileLock)) fail('profile_lock_remained');
    if (modelRequests !== 0) fail('unexpected_model_request');
    console.log('Verified native OpenClaw managed Magpie start/stop, private profile ownership, and zero model requests.');
  } finally {
    if (child && !stopped && child.exitCode === null && child.signalCode === null) {
      try { for (const [pid, started] of await captureOwnedTree(child)) owned.set(pid, started); } catch { /* Fixed failure is reported below. */ }
      const exited = waitForClose(child, 3000);
      try { child.kill('SIGTERM'); } catch { /* Root already exited. */ }
      await exited;
    }
    await forceOwnedCleanup(owned);
    for (const server of [upstreamServer, proxyServer]) if (server) {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    rmSync(temporary, { recursive: true, force: true });
    process.off('SIGTERM', onInterrupt); process.off('SIGINT', onInterrupt);
  }
}

try { await runProbe(); }
catch (error) {
  console.error(/^managed_magpie_probe_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'managed_magpie_probe_failed');
  process.exitCode = 1;
}
