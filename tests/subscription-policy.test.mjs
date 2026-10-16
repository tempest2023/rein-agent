import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRouterConfig, buildOpenClawFragment, selectRoute, describeRoute } from '../plugins/rein-router/policy.mjs';

const example = () => JSON.parse(readFileSync(new URL('../config/subscription-router.example.json', import.meta.url), 'utf8'));

const route = (id, provider, gatewayModel, overrides = {}) => ({
  id, provider, gatewayModel, billingSource: `${provider} synthetic subscription`,
  billingMode: 'subscription', billingVerified: true,
  purpose: 'General questions requiring little context', effort: 'low',
  contextWindow: 128000, maxTokens: 8192, ...overrides,
});
const fixture = overrides => ({
  enabled: true,
  gateway: { baseUrl: 'http://127.0.0.1:20000/v1', apiKeyEnvVar: 'REIN_MAGPIE_API_KEY' },
  routes: [
    route('flash', 'Google Gemini', 'gemini/gemini-flash', { effort: 'off', maxTokens: 4096 }),
    route('capable', 'OpenAI', 'codex/gpt-capable', { effort: 'high', purpose: 'Complex research and administrator development tasks' }),
    route('claude', 'Anthropic', 'claude-code/claude-capable', { effort: 'medium' }),
    route('bailian', 'Alibaba Cloud Bailian', 'bailian/qwen-coder', { billingMode: 'coding-plan', billingSource: 'Synthetic Bailian Coding Plan dedicated endpoint' }),
  ],
  defaultRoute: 'capable', ...overrides,
});
const decision = (id, probability = 0.95) => ({ status: 'ok', result: { answers: {
  route: { type: 'choice', choice: id, probabilities: { [id]: probability } },
} } });

function refuses(raw, field, code = 'router_config_invalid') {
  assert.throws(() => validateRouterConfig(raw), error => {
    assert.equal(error.code, code);
    assert.equal(error.field, field);
    assert.equal(error.message, `${code}: ${field}`);
    return true;
  });
}

test('empty configuration stays disabled; normalized defaults are idempotent', () => {
  const empty = validateRouterConfig();
  assert.equal(empty.enabled, false);
  assert.deepEqual(empty.routes, []);
  assert.deepEqual(empty.fallbackRoutes, []);
  assert.deepEqual(empty.channels, ['discord', 'slack']);
  assert.deepEqual(empty.adminSenders, []);
  assert.equal(empty.allowPaidUsage, false);
  assert.deepEqual(empty.decision, { timeoutMs: 3000, minProbability: 0.8, maxPromptChars: 4000, allowPaidJev: false });
  assert.deepEqual(validateRouterConfig(empty), empty);
  assert.throws(() => buildOpenClawFragment(empty, '/tmp/rein-router'), { code: 'router_disabled' });
  assert.throws(() => selectRoute(empty, decision('capable')), { code: 'router_disabled' });
});

test('all four provider routes normalize without mutating caller input', () => {
  const raw = fixture();
  const original = structuredClone(raw);
  const config = validateRouterConfig(raw);
  assert.deepEqual(raw, original);
  assert.equal(config.gateway.subscriptionOnly, true);
  assert.equal(config.decision.allowPaidJev, false);
  assert.equal(config.routes.length, 4);
  assert.deepEqual(validateRouterConfig(config), config);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.routes[0]));
  raw.routes[0].gatewayModel = 'group/unauthorized';
  assert.equal(config.routes[0].gatewayModel, 'gemini/gemini-flash');
});

test('checked-in example uses native gateway namespaces and stays disabled with unverified billing', () => {
  const raw = example();
  const config = validateRouterConfig(raw);
  const openai = config.routes.find(candidate => candidate.id === 'openai-general');
  const bailian = config.routes.find(candidate => candidate.id === 'bailian-quick');
  assert.equal(openai.gatewayModel, 'chatgpt-api/example-subscription-model');
  assert.equal(openai.billingMode, 'subscription');
  assert.equal(bailian.gatewayModel, 'bailian-token-plan/example-subscription-model');
  assert.equal(bailian.billingSource, 'bailian-token-plan-china-allowance');
  assert.equal(bailian.billingMode, 'subscription');
  assert.equal(bailian.effort, 'off');
  assert.match(bailian.purpose, /self-contained general questions/);
  assert.deepEqual(config.routes.filter(candidate => candidate.effort === 'high').map(candidate => candidate.id), ['claude-coding']);
  assert.ok(config.routes.every(candidate => !candidate.billingVerified && /\/example-/.test(candidate.gatewayModel)));
  assert.equal(config.enabled, false);
  assert.equal(config.gateway.managed.allowSubscriptionAccounts, false);
  assert.equal(config.gateway.subscriptionOnly, true);
  assert.equal(config.allowPaidUsage, false);
  assert.equal(config.decision.allowPaidJev, false);
  assert.deepEqual(config.fallbackRoutes, []);
  assert.throws(() => buildOpenClawFragment(raw, '/tmp/rein-router'), { code: 'router_disabled' });
  refuses({ ...raw, enabled: true }, 'routes[0].billingVerified', 'router_billing_unverified');
});

test('example fragment preserves exact route declarations without inferring paid permission', () => {
  const raw = example();
  raw.enabled = true;
  for (const candidate of raw.routes) candidate.billingVerified = true;
  const original = structuredClone(raw);
  const fragment = buildOpenClawFragment(raw, '/tmp/rein-router');
  assert.deepEqual(raw, original);
  const config = fragment.plugins.entries['rein-router'].config;
  assert.deepEqual(config.routes.filter(candidate => ['openai-general', 'bailian-quick'].includes(candidate.id))
    .map(candidate => [candidate.gatewayModel, candidate.billingMode]), [
    ['chatgpt-api/example-subscription-model', 'subscription'],
    ['bailian-token-plan/example-subscription-model', 'subscription'],
  ]);
  assert.ok(fragment.models.providers['rein-magpie'].models.some(model =>
    model.id === 'bailian-quick' && model.name.includes('bailian-token-plan/example-subscription-model') && !model.reasoning));
  assert.deepEqual(fragment.agents.defaults.model, { primary: 'rein-magpie/auto', fallbacks: [] });
  assert.equal(config.gateway.subscriptionOnly, true);
  assert.equal(config.allowPaidUsage, false);
  assert.equal(config.decision.allowPaidJev, false);
  const bailianIndex = raw.routes.findIndex(candidate => candidate.id === 'bailian-quick');
  raw.routes[bailianIndex].billingMode = 'pay-as-you-go';
  refuses(raw, `routes[${bailianIndex}].billingMode`, 'router_paid_usage_not_authorized');
});

test('arbitrary future provider families retain the same routing and fragment policy', () => {
  const raw = fixture();
  raw.routes = raw.routes.map((candidate, index) => ({ ...candidate,
    provider: `Future Provider ${index}`, gatewayModel: `future-provider-${index}/example-model` }));
  const config = validateRouterConfig(raw);
  for (const candidate of config.routes) {
    const selected = selectRoute(config, decision(candidate.id));
    assert.equal(selected.route.gatewayModel, candidate.gatewayModel);
    assert.equal(selected.reason, 'jev');
  }
  assert.equal(selectRoute(config, decision('flash', .79)).route.id, config.defaultRoute);
  const fragment = buildOpenClawFragment(raw, '/tmp/rein-router');
  assert.deepEqual(Object.keys(fragment.models.providers), ['rein-magpie']);
  assert.deepEqual(fragment.plugins.entries['rein-router'].config.routes, config.routes);
  assert.equal(fragment.plugins.entries['rein-router'].config.allowPaidUsage, false);
  assert.deepEqual(fragment.agents.defaults.model.fallbacks, []);
});

test('enabled configuration requires gateway, routes and a configured capable default', () => {
  refuses({ enabled: true }, 'gateway');
  refuses({ ...fixture(), routes: [], defaultRoute: undefined }, 'routes');
  refuses({ ...fixture(), defaultRoute: undefined }, 'defaultRoute');
  refuses({ ...fixture(), defaultRoute: 'missing' }, 'defaultRoute', 'router_config_unknown_route');
  refuses({ ...fixture(), defaultRoute: 'auto' }, 'defaultRoute');
  refuses({ ...fixture(), channels: [] }, 'channels');
});

test('gateway accepts only loopback HTTP(S) at the dedicated /v1 path', () => {
  for (const baseUrl of ['http://localhost:1234/v1', 'https://127.0.0.1/v1', 'http://[::1]:1234/v1']) {
    assert.equal(validateRouterConfig(fixture({ gateway: { baseUrl, apiKeyEnvVar: 'MAGPIE_KEY' } })).gateway.baseUrl, baseUrl);
  }
  for (const baseUrl of [
    'https://gateway.example/v1', 'http://localhost.example/v1', 'http://0.0.0.0/v1',
    'file:///v1', 'http://127.0.0.1/v2', 'http://127.0.0.1/v1/',
    'http://user:secret@127.0.0.1/v1', 'http://localhost/v1?key=secret',
    'http://localhost/v1#secret', 'http://localhost\\evil/v1',
    ' http://localhost/v1', 'http://localhost/v1\n', 'not-a-url',
  ]) refuses(fixture({ gateway: { baseUrl, apiKeyEnvVar: 'MAGPIE_KEY' } }), 'gateway.baseUrl');
  for (const apiKeyEnvVar of ['actual-secret-value', 'lowercase', 'KEY NAME', '', 42, 'HOME', 'PATH', 'NODE_OPTIONS', 'XDG_CONFIG_HOME']) {
    refuses(fixture({ gateway: { baseUrl: 'http://localhost/v1', apiKeyEnvVar } }), 'gateway.apiKeyEnvVar');
  }
});

test('route aliases and gateway models exclude automatic groups and embedded effort overrides', () => {
  for (const id of ['auto', 'Flash', 'two words', 'provider/model', '', '../escape']) {
    const raw = fixture(); raw.routes[0].id = id;
    refuses(raw, 'routes[0].id');
  }
  for (const gatewayModel of [
    'gemini-flash', 'group/cheap', 'GROUP/default', 'gemini/a model', 'gemini/model:high',
    'gemini/', '/model', 'gemini//model', 'gemini/../model', 'gemini/model?key=secret',
    'gemini/model\n', 'gemini/model\u202e',
  ]) {
    const raw = fixture(); raw.routes[0].gatewayModel = gatewayModel;
    refuses(raw, 'routes[0].gatewayModel');
  }
  const duplicate = fixture(); duplicate.routes[1].id = 'flash';
  refuses(duplicate, 'routes[1].id', 'router_config_duplicate_route');
});

test('unverified billing cannot be activated; source descriptions are bounded', () => {
  const raw = fixture(); raw.routes[0].billingVerified = false;
  refuses(raw, 'routes[0].billingVerified', 'router_billing_unverified');
  assert.equal(validateRouterConfig({ ...raw, enabled: false }).routes[0].billingVerified, false);
  for (const [field, value] of [
    ['provider', ''], ['provider', 'p'.repeat(129)], ['billingSource', 's'.repeat(513)],
    ['billingSource', 'source\nsecret'], ['purpose', 'p'.repeat(1025)], ['purpose', ''],
    ['billingMode', 'free'], ['billingVerified', 'true'], ['effort', 'ultra'],
  ]) {
    const candidate = fixture(); candidate.routes[0][field] = value;
    refuses(candidate, `routes[0].${field}`);
  }
});

test('paid routes require explicit paid usage and removal of the gateway subscription-only restriction', () => {
  const raw = fixture(); raw.routes[0].billingMode = 'pay-as-you-go';
  refuses(raw, 'routes[0].billingMode', 'router_paid_usage_not_authorized');
  refuses({ ...raw, allowPaidUsage: true }, 'routes[0].billingMode', 'router_paid_usage_not_authorized');
  refuses({ ...raw, gateway: { ...raw.gateway, subscriptionOnly: false } }, 'routes[0].billingMode', 'router_paid_usage_not_authorized');
  const allowed = validateRouterConfig({ ...raw, allowPaidUsage: true, gateway: { ...raw.gateway, subscriptionOnly: false } });
  assert.equal(selectRoute(allowed, decision('flash')).route.billingMode, 'pay-as-you-go');
  assert.equal(allowed.decision.allowPaidJev, false);
  assert.equal(validateRouterConfig(fixture({ decision: { allowPaidJev: true } })).allowPaidUsage, false);
});

test('route budgets and decision numeric bounds reject ambiguous or unsafe values', () => {
  for (const [field, value] of [['contextWindow', 0], ['contextWindow', 1.5], ['contextWindow', Infinity],
    ['maxTokens', 0], ['maxTokens', 128001], ['maxTokens', NaN]]) {
    const raw = fixture(); raw.routes[0][field] = value;
    refuses(raw, `routes[0].${field}`);
  }
  for (const [field, values] of [
    ['timeoutMs', [99, 10001, 3000.1, '3000']],
    ['maxPromptChars', [99, 32001, 4000.1, Infinity]],
    ['minProbability', [-0.01, 1.01, NaN, Infinity, '0.8']],
    ['allowPaidJev', [1, 'false']],
  ]) for (const value of values) refuses(fixture({ decision: { [field]: value } }), `decision.${field}`);
  assert.equal(validateRouterConfig(fixture({ decision: { timeoutMs: 100, maxPromptChars: 100, minProbability: 0 } })).decision.minProbability, 0);
  assert.equal(validateRouterConfig(fixture({ decision: { timeoutMs: 10000, maxPromptChars: 32000, minProbability: 1 } })).decision.timeoutMs, 10000);
});

test('fallbacks, channel scopes and administrator identities must be explicit and unambiguous', () => {
  refuses(fixture({ fallbackRoutes: ['not-listed'] }), 'fallbackRoutes[0]', 'router_config_unknown_route');
  refuses(fixture({ fallbackRoutes: ['flash', 'flash'] }), 'fallbackRoutes', 'router_config_duplicate_route');
  refuses(fixture({ fallbackRoutes: ['auto'] }), 'fallbackRoutes[0]');
  refuses(fixture({ channels: ['email'] }), 'channels[0]');
  refuses(fixture({ channels: ['slack', 'slack'] }), 'channels');
  const admin = { channel: 'discord', accountId: 'default', senderId: 'synthetic-admin' };
  assert.deepEqual(validateRouterConfig(fixture({ channels: ['discord'], adminSenders: [admin] })).adminSenders, [admin]);
  refuses(fixture({ adminSenders: [{ ...admin, accountId: '' }] }), 'adminSenders[0].accountId');
  refuses(fixture({ adminSenders: [{ ...admin, senderId: 'sender\nsecret' }] }), 'adminSenders[0].senderId');
  refuses(fixture({ adminSenders: [admin, admin] }), 'adminSenders');
});

test('unknown fields and all rejection messages hide input keys, values and secrets', () => {
  const canary = 'SYNTHETIC_SECRET_CANARY';
  for (const raw of [
    { ...fixture(), [canary]: canary },
    fixture({ gateway: { ...fixture().gateway, apiKey: canary } }),
    fixture({ decision: { apiKey: canary } }),
    fixture({ defaultRoute: canary }),
    fixture({ gateway: { baseUrl: `https://${canary}.example/v1`, apiKeyEnvVar: 'MAGPIE_KEY' } }),
  ]) assert.throws(() => validateRouterConfig(raw), error => {
    assert.ok(!JSON.stringify({ message: error.message, ...error }).includes(canary));
    return true;
  });
  for (const raw of [null, [], 'secret', 1, true]) refuses(raw, 'config');
  refuses(fixture({ enabled: 'true' }), 'enabled');
  for (const field of ['routes', 'fallbackRoutes', 'channels', 'adminSenders']) {
    refuses(fixture({ [field]: new Array(1) }), field);
  }
});

test('confident recognized Jev choices select configured models across all four providers', () => {
  const config = validateRouterConfig(fixture());
  for (const candidate of config.routes) {
    const selection = selectRoute(config, decision(candidate.id));
    assert.equal(selection.reason, 'jev');
    assert.equal(selection.probability, 0.95);
    assert.deepEqual(selection.route, candidate);
  }
  assert.equal(selectRoute(config, decision('flash', 0.8)).route.id, 'flash');
  assert.equal(selectRoute(config, decision('flash', 0.799)).route.id, 'capable');
});

test('unavailable, malformed, unknown and uncertain decisions use the capable default', () => {
  const config = fixture();
  for (const outcome of [undefined, null, { status: 'timeout' }, { status: 'error', error: 'SYNTHETIC_SECRET' }]) {
    assert.deepEqual(selectRoute(config, outcome), { route: validateRouterConfig(config).routes[1], reason: 'decision-unavailable' });
  }
  for (const outcome of [
    { status: 'ok' }, { status: 'ok', result: { answers: { route: { type: 'text', text: 'flash' } } } },
    decision('missing'), decision('auto'), decision('flash', '0.95'),
    decision('flash', NaN), decision('flash', Infinity), decision('flash', 1.1), decision('flash', -0.1),
    { status: 'ok', result: { answers: { route: { type: 'choice', choice: 'flash', probabilities: [] } } } },
  ]) {
    const selection = selectRoute(config, outcome);
    assert.equal(selection.route.id, 'capable');
    assert.equal(selection.reason, 'decision-invalid');
  }
  const absent = decision('flash'); delete absent.result.answers.route.probabilities.flash;
  assert.equal(selectRoute(config, absent).reason, 'decision-invalid');
  assert.equal(selectRoute(config, decision('flash', 0.79)).reason, 'low-probability');
  const selection = selectRoute(config, { status: 'error', error: 'SYNTHETIC_SECRET' });
  assert.ok(!JSON.stringify(selection).includes('SYNTHETIC_SECRET'));
});

test('attachments conservatively use default; admin input creates no untrusted identity heuristic', () => {
  const config = fixture();
  assert.equal(selectRoute(config, decision('flash'), { hasAttachments: true }).reason, 'attachments');
  assert.equal(selectRoute(config, decision('flash'), { hasAttachments: true, admin: true }).route.id, 'capable');
  assert.equal(selectRoute(config, decision('flash'), { admin: true }).route.id, 'flash');
  const forged = fixture(); forged.routes[0].billingVerified = false;
  assert.throws(() => selectRoute(forged, decision('flash')), { code: 'router_billing_unverified' });
});

test('generated OpenClaw fragment exposes automatic/manual models and only explicit fallbacks', () => {
  const raw = fixture({ fallbackRoutes: ['claude', 'bailian'] });
  const original = structuredClone(raw);
  const fragment = buildOpenClawFragment(raw, '/tmp/rein-router');
  assert.deepEqual(raw, original);
  assert.equal(fragment.models.mode, 'merge');
  const provider = fragment.models.providers['rein-magpie'];
  assert.equal(provider.api, 'openai-completions');
  assert.deepEqual(provider.apiKey, { source: 'env', provider: 'default', id: 'REIN_MAGPIE_API_KEY' });
  assert.deepEqual(provider.models.map(model => model.id), ['auto', 'flash', 'capable', 'claude', 'bailian']);
  assert.equal(provider.models[0].maxTokens, 4096);
  assert.deepEqual(fragment.agents.defaults.model, { primary: 'rein-magpie/auto', fallbacks: ['rein-magpie/claude', 'rein-magpie/bailian'] });
  assert.deepEqual(Object.keys(fragment.agents.defaults.models), ['rein-magpie/auto', 'rein-magpie/flash', 'rein-magpie/capable', 'rein-magpie/claude', 'rein-magpie/bailian']);
  assert.deepEqual(fragment.plugins.allow, ['rein-router']);
  assert.deepEqual(fragment.plugins.load.paths, ['/tmp/rein-router']);
  assert.deepEqual(Object.keys(fragment.plugins.entries), ['rein-router']);
  assert.deepEqual(fragment.plugins.entries['rein-router'].hooks, { allowConversationAccess: true });
  assert.ok(!Object.hasOwn(fragment.agents.defaults, 'thinkingDefault'));
  assert.equal(fragment.plugins.entries['rein-router'].config.decision.allowPaidJev, false);
  assert.ok(provider.models.every(model => !Object.hasOwn(model, 'cost')));
  assert.ok(!Object.hasOwn(fragment, 'channels'));
  assert.ok(!Object.hasOwn(fragment, 'tools'));
  assert.deepEqual(buildOpenClawFragment(fixture(), '/tmp/rein-router').agents.defaults.model.fallbacks, []);
  assert.throws(() => buildOpenClawFragment(fixture(), './relative'), { code: 'router_config_invalid', field: 'pluginPath' });
});

test('route descriptions identify operator-declared provenance without asserting actual billing', () => {
  const status = describeRoute(fixture(), 'bailian');
  assert.deepEqual(status, { routeId: 'bailian', provider: 'Alibaba Cloud Bailian', model: 'bailian/qwen-coder',
    billingSource: 'Synthetic Bailian Coding Plan dedicated endpoint', billingMode: 'coding-plan',
    billingVerified: true, verification: 'operator-configured', effort: 'low' });
  assert.ok(!Object.hasOwn(status, 'actualBilled'));
  assert.throws(() => describeRoute(fixture(), 'SYNTHETIC_SECRET'), error => {
    assert.equal(error.code, 'router_config_unknown_route');
    assert.equal(error.field, 'routeId');
    assert.ok(!error.message.includes('SYNTHETIC_SECRET'));
    return true;
  });
});
