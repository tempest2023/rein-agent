import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBailianSubscription } from '../scripts/verify-bailian-subscription.mjs';
import { magpiePaths } from '../scripts/magpie-dependency.mjs';
import { profileDigest, registerOwnerProbe } from './fixtures/bailian-owner-runtime.mjs';

const member = 'bailian-token-plan/qwen3.8-flash';
const key = 'sk-sp-synthetic-private-plan-credential';
const gatewayKey = `sk-magpie-key-${'a'.repeat(48)}`;
const chat = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const anthropic = 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic';

function profile(t) {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'rein-bailian-probe-test-')));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const paths = magpiePaths(projectRoot), dir = join(projectRoot, 'runtime/magpie/config/magpie');
  for (const path of [dir, paths.homeDir, join(projectRoot, 'runtime/openclaw')]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const router = { enabled: false, gateway: { baseUrl: 'http://127.0.0.1:18744/v1', apiKeyEnvVar: 'REIN_MAGPIE_GATEWAY_KEY',
    managed: { binaryPath: paths.binary, homeDir: paths.homeDir, allowSubscriptionAccounts: false } },
    routes: [{ id: 'bailian-flash', provider: 'Bailian', gatewayModel: member, billingMode: 'subscription',
      billingSource: 'Operator declaration pending', billingVerified: false, purpose: 'Local integration probe',
      effort: 'off', contextWindow: 32768, maxTokens: 256 }], defaultRoute: 'bailian-flash' };
  const provider = { id: 'bailian-token-plan', preset: 'bailian-token-plan', name: 'Bailian Token Plan',
    key, chat, anthropic, models: ['auto', 'qwen3.8-flash'] };
  const keys = [{ id: 'synthetic', name: 'Synthetic scope', secret: gatewayKey, models: [member] }];
  const routerPath = join(projectRoot, 'runtime/magpie/router.local.json'), providerPath = join(dir, 'providers.json');
  const keyPath = join(dir, 'caller-keys.json'), envPath = join(projectRoot, 'runtime/magpie/gateway.env');
  const save = (path, value) => writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  const source = { models: { providers: { 'bailian-token-plan': { api: 'anthropic-messages', baseUrl: anthropic,
    apiKey: { source: 'env', provider: 'default', id: 'BAILIAN_TOKEN_PLAN_API_KEY' }, models: [{ id: 'qwen3.8-flash' }] } } } };
  save(routerPath, router); save(providerPath, { providers: [provider] }); save(keyPath, keys);
  save(envPath, `REIN_MAGPIE_GATEWAY_KEY=${gatewayKey}\n`);
  save(join(projectRoot, 'runtime/openclaw/openclaw.json'), source);
  save(join(projectRoot, 'runtime/openclaw/.env'), `BAILIAN_TOKEN_PLAN_API_KEY=${key}\n`);
  return { projectRoot, paths, router, provider, keys, source, routerPath, providerPath, keyPath, envPath, save,
    run: options => verifyBailianSubscription({ projectRoot, environment: {}, ...options }) };
}

async function rejectsSafely(run, expected) {
  await assert.rejects(run, error => {
    assert.equal(error.code, expected); assert.equal(error.message, expected);
    assert.ok(!JSON.stringify(error).includes(key)); assert.ok(!JSON.stringify(error).includes(gatewayKey)); return true;
  });
}

test('default dry-run accepts disabled/unverified prepared metadata and never invokes inference', async t => {
  const f = profile(t), files = [f.routerPath, f.providerPath, f.keyPath, f.envPath], before = files.map(path => readFileSync(path));
  const result = await f.run({ nativeRunner: () => { throw new Error('Native host must not start in dry-run'); } });
  assert.equal(result.mode, 'dry-run'); assert.equal(result.inferenceRequests, 0);
  assert.equal(result.configuredRouterEnabled, false); assert.equal(result.configuredBillingAttestation, false);
  assert.equal(result.prepaidAddonDeclarationRequired, true); assert.equal(result.maxTokens, 256);
  assert.ok(!['entitlement', 'entitlementEvidence', 'publicDeploymentEligibility', 'monthlyEntitlementVerified']
    .some(field => Object.hasOwn(result, field)));
  assert.deepEqual(result.configuredEndpoints, [chat, anthropic]);
  assert.ok(!JSON.stringify(result).includes(key)); assert.ok(!JSON.stringify(result).includes(gatewayKey));
  files.forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]));
  assert.equal(existsSync(join(f.projectRoot, 'runtime/magpie/.rein-magpie.lock')), false);
});

test('live requires an explicit prepaid add-on declaration before profile work', async () => {
  await rejectsSafely(() => verifyBailianSubscription({ live: true, projectRoot: '/does-not-exist' }),
    'bailian_probe_prepaid_addon_declaration_required');
  await rejectsSafely(() => verifyBailianSubscription({ live: true, prepaidAddons: 'absent', projectRoot: '/does-not-exist' }),
    'bailian_probe_profile_unavailable');
});

test('either prepaid declaration alone permits the supplied synthetic runner without enabling persisted config', async t => {
  const f = profile(t), before = readFileSync(f.routerPath); let calls = 0;
  for (const prepaidAddons of ['absent', 'acknowledged']) {
    const result = await f.run({ live: true, prepaidAddons,
      nativeRunner: (...args) => {
        const [prepared, addons] = args;
        calls++; assert.equal(args.length, 2); assert.equal(prepared.gatewayKey, gatewayKey);
        assert.equal(prepared.router.enabled, false); assert.equal(addons, prepaidAddons);
        assert.equal(prepared.digest, profileDigest(prepared.profilePaths)); return { synthetic: true };
      } });
    assert.deepEqual(result, { synthetic: true });
  }
  assert.equal(calls, 2); assert.deepEqual(readFileSync(f.routerPath), before);
});

test('removed entitlement CLI flags are rejected before profile work', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/verify-bailian-subscription.mjs', import.meta.url)),
    '--live', '--prepaid-addons=absent', '--entitlement=personal-owner'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'bailian_probe_arguments_invalid');
});

test('live prepaid acknowledgement preserves managed profile, endpoint, key and exact scope checks', async t => {
  const f = profile(t); let calls = 0;
  const run = () => f.run({ live: true, prepaidAddons: 'acknowledged', nativeRunner: () => { calls++; } });
  const cases = [
    { path: f.routerPath, value: { ...f.router, allowPaidUsage: true }, error: 'managed_profile_required' },
    { path: f.routerPath, value: { ...f.router, gateway: { ...f.router.gateway, subscriptionOnly: false } }, error: 'managed_profile_required' },
    { path: f.providerPath, value: { providers: [{ ...f.provider, chat: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }] }, error: 'imported_provider_invalid' },
    { path: f.providerPath, value: { providers: [{ ...f.provider, key: 'sk-sp-different-private-credential' }] }, error: 'source_key_mismatch' },
    { path: f.keyPath, value: [{ ...f.keys[0], models: [member, 'bailian-token-plan/auto'] }], error: 'exact_gateway_scope_required' },
    { path: f.keyPath, value: [{ ...f.keys[0], off: true }], error: 'exact_gateway_scope_required' },
    { path: f.keyPath, value: [{ ...f.keys[0], lan: true }], error: 'exact_gateway_scope_required' },
  ];
  for (const { path, value, error } of cases) {
    const before = readFileSync(path); f.save(path, value);
    try { await rejectsSafely(run, `bailian_probe_${error}`); }
    finally { writeFileSync(path, before, { mode: 0o600 }); }
  }
  assert.equal(calls, 0);
});
test('gateway scope must contain exactly the explicit Flash model with no auto or group access', async t => {
  const f = profile(t); f.keys[0].models.push('bailian-token-plan/auto'); f.save(f.keyPath, f.keys);
  await rejectsSafely(() => f.run(), 'bailian_probe_exact_gateway_scope_required');
});

test('upstream endpoint/key overrides and hidden extra routing cannot pass preflight', async t => {
  const f = profile(t);
  for (const extra of [{ chat: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }, { key: 'sk-payg-secret' },
    { fallback: ['paid/model'] }, { headers: { Authorization: 'secret' } }, { proxy: 'https://elsewhere.invalid' }]) {
    f.save(f.providerPath, { providers: [{ ...f.provider, ...extra }] });
    await rejectsSafely(() => f.run(), 'bailian_probe_imported_provider_invalid');
  }
});

test('a stale copied plan secret or conflicting ambient gateway key fails closed', async t => {
  const f = profile(t);
  await rejectsSafely(() => f.run({ environment: { BAILIAN_TOKEN_PLAN_API_KEY: 'sk-sp-different-secret' } }), 'bailian_probe_source_key_mismatch');
  await rejectsSafely(() => f.run({ environment: { REIN_MAGPIE_GATEWAY_KEY: 'sk-magpie-key-different-secret' } }),
    'bailian_probe_gateway_environment_invalid');
});

test('native/private failures and invalid operator values expose only fixed errors', async t => {
  const f = profile(t);
  await rejectsSafely(() => f.run({ live: true, prepaidAddons: 'absent',
    nativeRunner: () => { throw new Error(`${key} ${gatewayKey} private provider response`); } }), 'bailian_probe_failed');
  await rejectsSafely(() => f.run({ prepaidAddons: 'secret invalid value' }), 'bailian_probe_arguments_invalid');
  await rejectsSafely(() => f.run({ live: 'yes' }), 'bailian_probe_arguments_invalid');
});

function registeredFixture(t) {
  const f = profile(t), hooks = new Map(); let provider, service, tool, channel, stops = 0, network = 0;
  const api = { on: (name, callback) => hooks.set(name, callback),
    registerProvider: value => { provider = value; }, registerService: value => { service = value; },
    registerTool: value => { tool = value; }, registerChannel: value => { channel = value; } };
  const wrap = ({ streamFn }) => (model, context, options) => streamFn({ ...model, id: `${member}:none`, provider: 'rein-magpie' }, context, options);
  const production = { register(target) {
    target.registerProvider({ wrapStreamFn: wrap, wrapSimpleCompletionStreamFn: wrap });
    target.registerService({ start: async () => {}, stop: async () => { stops++; } });
  } };
  const evidencePath = join(f.projectRoot, 'evidence.json'), profilePaths = [f.providerPath, f.keyPath];
  registerOwnerProbe(api, { production, evidencePath, profilePaths, expectedDigest: profileDigest(profilePaths) });
  return { ...f, hooks, evidencePath, provider, service, tool, channel,
    api, production, profilePaths, currentProvider: () => provider,
    network: () => network, stops: () => stops,
    stream: () => provider.wrapStreamFn({ streamFn: () => { network++; return 'synthetic-stream'; } }) };
}

test('fixture bounds the genuine provider transport to two calls before any third transport invocation', t => {
  const f = registeredFixture(t), stream = f.stream();
  assert.equal(stream({}, {}, {}), 'synthetic-stream'); assert.equal(stream({}, {}, {}), 'synthetic-stream');
  assert.throws(() => stream({}, {}, {}), /bailian_probe_model_budget_exceeded/); assert.equal(f.network(), 2);
});

test('independently prepared registrations share atomic two-call budget slots', t => {
  const f = registeredFixture(t), first = f.stream();
  registerOwnerProbe(f.api, { production: f.production, evidencePath: f.evidencePath,
    profilePaths: f.profilePaths, expectedDigest: profileDigest(f.profilePaths) });
  const second = f.stream();
  assert.equal(first({}, {}, {}), 'synthetic-stream'); assert.equal(second({}, {}, {}), 'synthetic-stream');
  assert.throws(() => first({}, {}, {}), /bailian_probe_model_budget_exceeded/);
  assert.throws(() => second({}, {}, {}), /bailian_probe_model_budget_exceeded/); assert.equal(f.network(), 2);
});

test('fixture rejects profile mutation after the actual managed service starts and stops that service', async t => {
  const f = registeredFixture(t); f.save(f.providerPath, { providers: [] });
  await assert.rejects(() => f.service.start({}), /bailian_probe_profile_changed/); assert.equal(f.stops(), 1);
});

test('read-only echo requires the one isolated synthetic scope and refuses repeated execution', async t => {
  const f = registeredFixture(t), args = { marker: 'REIN_BAILIAN_OWNER_CHECK' };
  const ctx = { sessionKey: 'agent:main:slack:channel:rein-bailian-owner-probe', messageChannel: 'slack',
    requesterSenderId: 'U0000000001', agentAccountId: 'default', assertInvocationCurrent() {} };
  await assert.rejects(() => f.tool.create({ ...ctx, requesterSenderId: 'U0000000002' }).execute('id', args), /bailian_probe_echo_scope_invalid/);
  const result = await f.tool.create(ctx).execute('id', args); assert.deepEqual(result.details, args);
  await assert.rejects(() => f.tool.create(ctx).execute('again', args), /bailian_probe_echo_scope_invalid/);
  assert.deepEqual(f.channel.config.listAccountIds({ channels: { slack: { enabled: true } } }), ['default']);
});

test('native terminal errors stay distinct from delivery text and usage sums only safe numeric attempt counters', async t => {
  const f = registeredFixture(t); await f.service.start({});
  const ctx = { sessionKey: 'agent:main:slack:channel:rein-bailian-owner-probe' };
  f.hooks.get('llm_output')({ provider: 'rein-magpie', model: 'bailian-flash', usage: { input: 10, output: 2, total: 12, cost: key } });
  f.hooks.get('llm_output')({ provider: 'rein-magpie', model: 'bailian-flash', usage: { input: 20, output: 3, total: 23, cacheRead: 'secret' } });
  f.hooks.get('agent_end')({ success: true, messages: [{ role: 'assistant', stopReason: 'error', errorMessage: key }] }, ctx);
  const signal = AbortSignal.abort();
  await f.channel.gateway.startAccount({ accountId: 'default', cfg: {}, abortSignal: signal,
    channelRuntime: { inbound: { ingress: { resolveStable: async () => ({ ingress: { admission: 'dispatch' } }) },
      buildContext: () => ({}), dispatch: async ({ delivery }) => {
        await delivery.deliver({ text: `Native private error ${key}` }, { kind: 'final' });
      } } } });
  const evidence = JSON.parse(readFileSync(f.evidencePath, 'utf8'));
  assert.equal(evidence.finalReply, true); assert.deepEqual(evidence.terminal, { success: true, stopReason: 'error' });
  assert.deepEqual(evidence.usage, { input: 30, output: 5, total: 35 }); assert.equal(evidence.usageEvents, 2);
  assert.ok(!readFileSync(f.evidencePath, 'utf8').includes(key));
});
