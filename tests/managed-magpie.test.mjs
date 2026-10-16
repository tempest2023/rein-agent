import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { buildManagedEnvironment, ensureManagedDirectories, acquireManagedProfileLock,
  verifyManagedBinary, createManagedGateway } from '../plugins/rein-router/managed-gateway.mjs';
import { createRouter } from '../plugins/rein-router/runtime.mjs';
import { validateRouterConfig } from '../plugins/rein-router/policy.mjs';
import lock from '../plugins/rein-router/magpie.lock.json' with { type: 'json' };

const key = 'sk-magpie-key-synthetic-managed-test-00000000';
const route = { id: 'capable', provider: 'Fixture', gatewayModel: 'fixture/capable',
  billingSource: 'Synthetic included allowance', billingMode: 'subscription', billingVerified: true,
  purpose: 'Synthetic work', effort: 'medium', contextWindow: 32768, maxTokens: 1024 };
async function vacantPort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function fixture(t, mode = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'rein-managed-magpie-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binaryPath = join(root, 'bin/magpie'); await mkdir(dirname(binaryPath), { mode: 0o700 });
  const code = `#!/usr/bin/env node
const http = require('node:http');
const [host, port] = process.env.MAGPIE_ADDR.split(':');
const server = http.createServer((req,res) => {
 if(req.headers.origin !== 'null' || req.headers.authorization !== 'Bearer ${key}') {res.writeHead(403);res.end('{}');return;}
 res.setHeader('Content-Type','application/json');
 res.end(JSON.stringify(req.url === '/' ? {name:'magpie',version:'${lock.version}'} : {data:[{id:'fixture/capable'}]}));
});
server.listen(Number(port),host,()=>{${mode === 'crash' ? 'setTimeout(()=>process.exit(7),300);' : ''}});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`;
  await writeFile(binaryPath, code, { mode: 0o700 });
  await writeFile(`${binaryPath}.json`, JSON.stringify({ revision: lock.revision, version: lock.version,
    sha256: createHash('sha256').update(code).digest('hex') }), { mode: 0o600 });
  const gateway = { baseUrl: `http://127.0.0.1:${await vacantPort()}/v1`, apiKeyEnvVar: 'REIN_MANAGED_TEST_KEY',
    managed: { binaryPath, homeDir: join(root, 'profile/home'), allowSubscriptionAccounts: false } };
  const environment = { ...process.env, REIN_MANAGED_TEST_KEY: key };
  return { root, gateway, environment };
}

test('managed child environment isolates native clients and excludes parent account credentials', () => {
  const env = buildManagedEnvironment({ homeDir: '/private/rein/runtime/magpie/home',
    baseUrl: 'http://127.0.0.1:3425/v1', environment: { PATH: '/safe/bin', LANG: 'en_US.UTF-8',
      HOME: '/REAL_HOME_CANARY', XDG_CONFIG_HOME: '/REAL_CONFIG_CANARY',
      CODEX_HOME: '/REAL_CODEX_CANARY', OPENAI_API_KEY: 'SECRET_CANARY', NODE_OPTIONS: 'SECRET_CANARY' } });
  assert.equal(env.MAGPIE_ADDR, '127.0.0.1:3425');
  assert.equal(env.MAGPIE_NO_ACCOUNTS, '1');
  assert.equal(env.XDG_CONFIG_HOME, '/private/rein/runtime/magpie/config');
  assert.equal(env.CODEX_HOME, '/private/rein/runtime/magpie/home/.codex');
  assert.ok(!JSON.stringify(env).includes('CANARY'));
  assert.equal(buildManagedEnvironment({ homeDir: '/private/rein/home', baseUrl: 'http://127.0.0.1:3425/v1',
    allowSubscriptionAccounts: true }).MAGPIE_NO_ACCOUNTS, undefined);
  assert.throws(() => buildManagedEnvironment({ homeDir: '/private/rein/home', baseUrl: 'https://localhost/v1' }), /address_invalid/);
});

test('managed configuration is explicit, absolute and loopback with account discovery off by default', () => {
  const raw = { enabled: true, gateway: { baseUrl: 'http://127.0.0.1:3425/v1', apiKeyEnvVar: 'REIN_TEST',
    managed: { binaryPath: '/private/rein/bin/magpie', homeDir: '/private/rein/runtime/home' } }, routes: [route], defaultRoute: route.id };
  assert.equal(validateRouterConfig(raw).gateway.managed.allowSubscriptionAccounts, false);
  assert.throws(() => validateRouterConfig({ ...raw, gateway: { ...raw.gateway,
    managed: { ...raw.gateway.managed, binaryPath: 'relative' } } }), /gateway.managed/);
  assert.throws(() => validateRouterConfig({ ...raw, gateway: { ...raw.gateway, baseUrl: 'http://localhost:3425/v1' } }), /gateway.baseUrl/);
});

test('binary pin, receipt digest and portable-mode isolation are verified without executing it', async t => {
  const { gateway } = await fixture(t);
  const binary = gateway.managed.binaryPath;
  await verifyManagedBinary(binary);
  await writeFile(join(dirname(binary), '.portable'), '');
  await assert.rejects(() => verifyManagedBinary(binary), /binary_verification_failed/);
  await rm(join(dirname(binary), '.portable'));
  await writeFile(binary, 'CHANGED_PRIVATE_BINARY_CANARY');
  await assert.rejects(() => verifyManagedBinary(binary), error => !error.message.includes('CANARY'));
});

test('profile ownership prevents concurrent CLI/import/service mutation and releases explicitly', async t => {
  const { gateway, environment } = await fixture(t);
  const env = buildManagedEnvironment({ ...gateway.managed, baseUrl: gateway.baseUrl, environment });
  await ensureManagedDirectories(env);
  const release = await acquireManagedProfileLock(gateway.managed.homeDir);
  await assert.rejects(() => acquireManagedProfileLock(gateway.managed.homeDir), /profile_busy/);
  await release();
  const next = await acquireManagedProfileLock(gateway.managed.homeDir); await next();
});

test('profile symlink ancestors are rejected before native client directories are created', async t => {
  const { root } = await fixture(t);
  const outside = join(root, 'outside'); await mkdir(outside, { mode: 0o700 });
  const link = join(root, 'redirected'); await symlink(outside, link, 'dir');
  const env = buildManagedEnvironment({ homeDir: join(link, 'home'), baseUrl: 'http://127.0.0.1:3425/v1' });
  await assert.rejects(() => ensureManagedDirectories(env), /private_directory_required/);
  await assert.rejects(() => access(join(outside, 'home')), { code: 'ENOENT' });
});

test('foreground lifecycle owns readiness, exact catalog, process termination and private lock', async t => {
  const data = await fixture(t);
  const manager = createManagedGateway({ ...data, routes: [route] });
  t.after(() => manager.stop());
  assert.equal(manager.isReady(), false);
  await manager.start({});
  assert.equal(manager.isReady(), true);
  data.environment.REIN_MANAGED_TEST_KEY = 'sk-magpie-key-other-synthetic-managed-test-00000000';
  assert.equal(manager.isReady(), false, 'A new key requires a fresh readiness and catalog proof');
  data.environment.REIN_MANAGED_TEST_KEY = key;
  assert.equal(manager.isReady(), true);
  await assert.rejects(() => acquireManagedProfileLock(data.gateway.managed.homeDir), /profile_busy/);
  await manager.stop();
  assert.equal(manager.isReady(), false);
  const release = await acquireManagedProfileLock(data.gateway.managed.homeDir); await release();
});

test('an occupied port is never adopted, even if it might be a Magpie daemon', async t => {
  const data = await fixture(t);
  const url = new URL(data.gateway.baseUrl);
  const existing = createServer(); await new Promise(resolve => existing.listen(Number(url.port), '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => existing.close(resolve)));
  let spawned = false;
  const manager = createManagedGateway({ ...data, routes: [route], spawnImpl() { spawned = true; throw new Error('CANARY'); } });
  await assert.rejects(() => manager.start({}), /port_in_use/);
  assert.equal(spawned, false); assert.equal(manager.isReady(), false);
});

test('unconfigured native Codex credit controls prevent the managed child from starting', async t => {
  const data = await fixture(t); let spawned = false;
  const manager = createManagedGateway({ ...data, routes: [{ ...route, gatewayModel: 'codex/model' }],
    spawnImpl() { spawned = true; throw new Error('UNREACHABLE'); } });
  await assert.rejects(() => manager.start({}), /codex_credit_configuration_required/);
  assert.equal(spawned, false);
  const release = await acquireManagedProfileLock(data.gateway.managed.homeDir); await release();
});

test('unexpected child exit closes the route gate and reports a fixed service failure', async t => {
  const data = await fixture(t, 'crash'); const failures = [];
  const manager = createManagedGateway({ ...data, routes: [route] });
  t.after(async () => { await assert.rejects(() => manager.stop(), /process_cleanup_required/); });
  await manager.start({ serviceHealth: { reportFailure: error => failures.push(error.message) } });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(manager.isReady(), false);
  assert.ok(failures.includes('rein_magpie_process_exited'));
  await assert.rejects(() => manager.stop(), /process_cleanup_required/);
  await assert.rejects(() => acquireManagedProfileLock(data.gateway.managed.homeDir), /profile_busy/);
});

test('cancellation during binary verification never starts a late child', async t => {
  const data = await fixture(t); let finish; let spawned = false;
  const manager = createManagedGateway({ ...data, routes: [route],
    verifyInstallation: () => new Promise(resolve => { finish = resolve; }),
    spawnImpl() { spawned = true; throw new Error('UNREACHABLE'); } });
  const starting = manager.start({}); await manager.stop(); finish();
  await assert.rejects(() => starting, /startup_failed/);
  assert.equal(spawned, false); assert.equal(manager.isReady(), false);
});

test('late readiness metadata cannot mark a stopped child as successfully started', async t => {
  const data = await fixture(t); let finishModels, observeModels;
  const modelsStarted = new Promise(resolve => { observeModels = resolve; });
  const manager = createManagedGateway({ ...data, routes: [route], fetchImpl: async url => {
    if (new URL(url).pathname === '/') return Response.json({ name: 'magpie', version: lock.version });
    observeModels();
    return new Promise(resolve => { finishModels = () => resolve(Response.json({ data: [{ id: route.gatewayModel }] })); });
  } });
  const starting = manager.start({});
  // Attach a rejection observer before deliberately retiring startup authority.
  const settled = assert.rejects(() => starting, /startup_failed/);
  await modelsStarted;
  await manager.stop();
  finishModels(); await settled;
  assert.equal(manager.isReady(), false);
});

test('concurrent stop requests share cleanup after the child exits while late startup metadata is pending', async t => {
  const data = await fixture(t); let finishModels, observeModels, finishCleanup, cleanupCalls = 0;
  const modelsStarted = new Promise(resolve => { observeModels = resolve; });
  const cleanup = new Promise(resolve => { finishCleanup = resolve; });
  // This synthetic handle never starts or signals an operating-system process.
  const native = Object.assign(new EventEmitter(), { pid: 2147483647, exitCode: null, signalCode: null, killed: false });
  const failures = [];
  const manager = createManagedGateway({ ...data, routes: [route], spawnImpl: () => native,
    fetchImpl: async url => {
      if (new URL(url).pathname === '/') return Response.json({ name: 'magpie', version: lock.version });
      observeModels();
      return new Promise(resolve => { finishModels = () => resolve(Response.json({ data: [{ id: route.gatewayModel }] })); });
    }, stopImpl: async child => {
      cleanupCalls++;
      assert.equal(child, native);
      assert.equal(child.exitCode, null, 'Cleanup must begin while its child is live');
      await cleanup;
      return { complete: true };
    } });
  const starting = manager.start({ serviceHealth: { reportFailure: error => failures.push(error.message) } });
  const settled = assert.rejects(() => starting, /startup_failed/);
  await modelsStarted;
  const stopping = manager.stop();
  assert.equal(cleanupCalls, 1);
  native.exitCode = 0; native.emit('exit', 0, null);
  const concurrent = manager.stop();
  assert.equal(concurrent, stopping, 'Concurrent callers must await the same ownership verification');
  assert.equal(cleanupCalls, 1);
  assert.equal(manager.isReady(), false);
  await assert.rejects(() => acquireManagedProfileLock(data.gateway.managed.homeDir), /profile_busy/);
  finishModels(); finishCleanup();
  await Promise.all([stopping, concurrent, settled]);
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(failures, []);
  await manager.stop();
  assert.equal(cleanupCalls, 1, 'A settled stop must not clean an exited child again');
  const emptyStop = manager.stop();
  await assert.rejects(() => manager.start({}), /already_started/);
  await emptyStop;
  const release = await acquireManagedProfileLock(data.gateway.managed.homeDir); await release();
});

test('managed gateway unavailability blocks routing, Jev spending and model transport', async t => {
  const data = await fixture(t); let calls = 0;
  const router = createRouter({ config: { enabled: true, gateway: data.gateway, routes: [route], defaultRoute: route.id,
    decision: { allowPaidJev: true } }, decisions: { evaluate: async () => { calls++; } }, environment: data.environment,
    gatewayReady: () => false });
  const ctx = { runId: 'fixture-run', modelProviderId: 'rein-magpie', modelId: 'auto', channel: 'discord' };
  await router.beforeModelResolve({ prompt: 'Hello' }, ctx);
  assert.equal(calls, 0);
  assert.equal(router.beforeAgentRun({}, { ...ctx, modelId: route.id }).reason, 'rein_router_gateway_unavailable');
  const wrapped = router.wrapStreamFn({ streamFn: () => { calls++; } });
  assert.throws(() => wrapped({ id: route.id, provider: 'rein-magpie', baseUrl: data.gateway.baseUrl, api: 'openai-completions' }, {}), /gateway_unavailable/);
  assert.equal(calls, 0);
});
