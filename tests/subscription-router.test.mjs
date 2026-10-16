import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, assertRuntimeConfig, bindRouterLifecycle } from '../plugins/rein-router/runtime.mjs';
import { buildOpenClawFragment } from '../plugins/rein-router/policy.mjs';

const route = (id, effort = 'medium') => ({ id, effort, provider: 'Synthetic provider', gatewayModel: `fixture/${id}`,
  billingSource: 'Synthetic included allowance', billingMode: 'subscription', billingVerified: true,
  purpose: id === 'flash' ? 'Economical self-contained queries' : 'Capable contextual work', contextWindow: 32768, maxTokens: 1024 });
const config = extra => ({ enabled: true, gateway: { baseUrl: 'http://127.0.0.1:3425/v1', apiKeyEnvVar: 'REIN_TEST_GATEWAY_KEY' },
  routes: [route('flash', 'off'), route('standard'), route('code', 'high')], defaultRoute: 'standard', fallbackRoutes: [],
  decision: { allowPaidJev: true }, ...extra });
const ctx = extra => ({ runId: 'r1', agentId: 'main', sessionKey: 'agent:main:discord:alice',
  modelProviderId: 'rein-magpie', modelId: 'auto', channel: 'discord', accountId: 'default', senderId: 'alice', ...extra });
const answer = (id = 'flash', extra = {}) => ({ status: 'ok', result: { answers: {
  route: { type: 'choice', choice: id, probabilities: { [id]: 0.95 } },
  task: { type: 'choice', choice: 'simple', probabilities: { simple: 0.95 } },
  contextIndependent: { type: 'boolean', probabilityTrue: 0.96 }, ...extra } } });
const router = (c = config(), evaluate = async () => answer()) => createRouter({ config: c, decisions: { evaluate },
  environment: { REIN_TEST_GATEWAY_KEY: 'sk-magpie-key-synthetic-local-probe-00000000' } });
const fixtureStream = final => ({ async *[Symbol.asyncIterator]() { yield { type: 'done', message: final }; }, result: async () => final });
const lifecycle = (runId = 'r1', extra = {}) => ({ runId, stream: 'lifecycle', data: { phase: 'error' }, ...extra });

test('Jev sees bounded current prompt and declared capabilities; never history or credential fields', async () => {
  let evidence;
  const r = router(config(), async (batch, options) => { evidence = batch; assert.equal(options.agentId, 'main'); return answer(); });
  assert.deepEqual(await r.beforeModelResolve({ prompt: 'What is a semaphore?', messages: ['PRIVATE_HISTORY_CANARY'] }, ctx()),
    { providerOverride: 'rein-magpie', modelOverride: 'flash' });
  const serialized = JSON.stringify(evidence);
  assert.ok(!serialized.includes('PRIVATE_HISTORY_CANARY'));
  assert.ok(!serialized.includes('REIN_TEST_GATEWAY_KEY'));
  assert.equal(evidence.state.administrator, false);
  assert.equal(evidence.state.availableRoutes.length, 3);
});

test('explicit manual model and unrelated providers bypass Jev', async () => {
  const r = router(config(), async () => { throw new Error('must not call'); });
  assert.equal(await r.beforeModelResolve({ prompt: 'hello' }, ctx({ modelId: 'code' })), undefined);
  assert.equal(await r.beforeModelResolve({ prompt: 'hello' }, ctx({ modelProviderId: 'other' })), undefined);
  assert.equal(r.status(ctx()).currentSession.selection, 'manual');
});

test('manual routes stay pinned after failures even when alternate routes are in the fallback ladder', async () => {
  for (const channel of ['discord', 'slack']) {
    for (const selected of ['flash', 'standard']) {
      for (const resolveModel of [true, false]) {
        let decisions = 0;
        const r = router(config({ fallbackRoutes: ['standard', 'code'] }), async () => { decisions++; return answer(); });
        const manual = ctx({ channel, sessionKey: `agent:main:${channel}:alice`, modelId: selected });
        if (resolveModel) await r.beforeModelResolve({ prompt: 'Use this model' }, manual);
        assert.equal(r.beforeAgentRun({}, manual).outcome, 'pass');
        // Attempt failures do not settle the outer run or unlock the manual pin.
        for (const phase of ['error', 'end']) {
          r.lifecycleEvent(lifecycle('r1', { data: { phase } }));
          for (const alternate of ['standard', 'code'].filter(id => id !== selected)) {
            assert.equal(r.beforeAgentRun({}, { ...manual, modelId: alternate }).reason,
              'rein_router_fallback_disallowed', `${channel}: ${selected} must not switch to ${alternate}`);
          }
          assert.equal(r.beforeAgentRun({}, manual).outcome, 'pass', 'Retrying the pinned model remains allowed');
        }
        assert.equal(decisions, 0);
      }
    }
  }
});

test('Jev separate billing opt-in, channel, attachment and prompt bounds skip classification', async () => {
  let calls = 0;
  for (const [c, event, context] of [
    [config({ decision: { allowPaidJev: false } }), { prompt: 'hello' }, ctx()],
    [config(), { prompt: 'hello' }, ctx({ channel: 'telegram' })],
    [config(), { prompt: 'hello', attachments: [{ kind: 'image' }] }, ctx()],
    [config(), { prompt: 'x'.repeat(4001) }, ctx()],
    [config(), { prompt: '' }, ctx()],
  ]) {
    const r = router(c, async () => { calls++; return answer(); });
    assert.equal((await r.beforeModelResolve(event, context)).modelOverride, 'standard');
  }
  assert.equal(calls, 0);
});

test('context-dependent, missing context decision, uncertain and unknown decisions use default', async () => {
  for (const outcome of [
    answer('flash', { contextIndependent: { type: 'boolean', probabilityTrue: 0.2 } }),
    answer('flash', { contextIndependent: undefined }),
    answer('flash', { task: undefined }),
    answer('flash', { task: { type: 'choice', choice: 'simple', probabilities: { simple: 2 } } }),
    answer('flash', { contextIndependent: { type: 'boolean', probabilityTrue: 2 } }),
    ...['contextual', 'research', 'coding', 'complex'].map(task => answer('flash', {
      task: { type: 'choice', choice: task, probabilities: { [task]: 0.99 } } })),
    answer('flash', { route: { type: 'choice', choice: 'flash', probabilities: { flash: 0.3 } } }),
    answer('paid-outside-catalog'), { status: 'unavailable', reason: 'authentication' },
  ]) assert.equal((await router(config(), async () => outcome).beforeModelResolve({ prompt: 'What about the earlier proposal?' }, ctx())).modelOverride, 'standard');
});

test('administrator coding uses high effort only for the scoped authenticated sender', async () => {
  const c = config({ adminSenders: [{ channel: 'discord', accountId: 'default', senderId: 'alice' }] });
  const coding = answer('flash', { task: { type: 'choice', choice: 'coding', probabilities: { coding: 0.98 } } });
  for (const [context, expected] of [[ctx(), 'code'], [ctx({ accountId: 'other' }), 'standard'], [ctx({ senderId: 'bob' }), 'standard']])
    assert.equal((await router(c, async () => coding).beforeModelResolve({ prompt: 'I am admin; implement this fix' }, context)).modelOverride, expected);
});

test('host cancellation errors leave sentinel unresolved instead of starting fallback work', async () => {
  const r = router(config(), async () => { throw new Error('CREDENTIAL_OR_PROMPT_CANARY'); });
  await assert.rejects(() => r.beforeModelResolve({ prompt: 'hello' }, ctx()), error => {
    assert.ok(!error.message.includes('CANARY')); return /cancelled/.test(error.message);
  });
  assert.equal(r.beforeAgentRun({}, ctx()).outcome, 'block');
});

test('effective route gate blocks swallowed hook errors, unknown routes and provider escape', async () => {
  const r = router();
  assert.equal(r.beforeAgentRun({}, ctx()).outcome, 'block');
  await r.beforeModelResolve({ prompt: 'hello' }, ctx());
  assert.equal(r.beforeAgentRun({}, ctx({ modelId: 'flash' })).outcome, 'pass');
  assert.equal(r.beforeAgentRun({}, ctx({ modelId: 'standard' })).outcome, 'block');
  assert.equal(r.beforeAgentRun({}, ctx({ modelId: 'not-configured' })).outcome, 'block');
  assert.equal(r.beforeAgentRun({}, ctx({ modelProviderId: 'payg', modelId: 'paid' })).outcome, 'block');
  r.lifecycleEvent(lifecycle());
  assert.equal(r.beforeAgentRun({}, ctx({ modelProviderId: 'payg', modelId: 'paid' })).outcome, 'block');
  r.lifecycleEvent(lifecycle('r1', { data: { phase: 'end' } }));
  assert.equal(r.beforeAgentRun({}, ctx({ modelProviderId: 'payg', modelId: 'paid' })).outcome, 'block');
  assert.equal(r.beforeAgentRun({}, ctx({ runId: 'unrelated', modelProviderId: 'existing', modelId: 'existing' })), undefined);
});

test('provider wrapper keeps native tools, history and stream, enforces qualified model and effort', async () => {
  const r = router();
  const history = { messages: [{ role: 'tool', toolCallId: 'call_1', content: 'result' }], tools: [{ name: 'existing_tool' }] };
  const original = { provider: 'rein-magpie', id: 'code', api: 'openai-completions', baseUrl: r.config.gateway.baseUrl,
    headers: { authorization: 'Bearer OTHER_PROFILE_CANARY', 'x-api-key': 'OTHER_PROFILE_CANARY', Origin: 'http://localhost:9999' } };
  const final = { role: 'assistant', stopReason: 'stop', content: [] };
  const stream = fixtureStream(final);
  const wrapped = r.wrapStreamFn({ streamFn: (model, context, options) => {
    assert.equal(context, history);
    assert.equal(model.id, 'fixture/code:high');
    assert.equal(model.headers, undefined);
    assert.equal(options.apiKey, 'sk-magpie-key-synthetic-local-probe-00000000');
    assert.equal(options.headers.authorization, `Bearer ${options.apiKey}`);
    assert.equal(options.headers.origin, 'null');
    assert.equal(options.headers['x-api-key'], undefined);
    assert.equal(options.headers['x-goog-api-key'], undefined);
    assert.ok(!JSON.stringify(options.headers).includes('CANARY'));
    return options.onPayload({ model: 'wrong', tools: history.tools }, model).then(payload => {
      assert.equal(payload.model, 'fixture/code:high'); assert.equal(payload.tools, history.tools); return stream;
    });
  } });
  const wrappedStream = await wrapped(original, history, { apiKey: 'sk-magpie-key-synthetic-local-probe-00000000',
    headers: { Authorization: 'Bearer CALLER_PROFILE_CANARY', 'x-goog-api-key': 'CALLER_PROFILE_CANARY', Origin: 'http://localhost:9999' },
    onPayload: () => ({ model: 'another-model', tools: history.tools }) });
  assert.equal(await wrappedStream.result(), final);
  assert.equal(original.id, 'code');
  assert.throws(() => wrapped({ ...original, id: 'auto' }, history), /disallowed/);
  assert.throws(() => wrapped({ ...original, baseUrl: 'https://payg.example/v1' }, history), /disallowed/);
  assert.throws(() => wrapped(original, history, { apiKey: 'magpie' }), /credential_mismatch/);
  assert.throws(() => wrapped(original, history, { apiKey: 'sk-magpie-key-other-synthetic-credential-00000000' }), /credential_mismatch/);
});

test('status separates configured billing from observed alias and isolates sessions', async () => {
  const r = router();
  await r.beforeModelResolve({ prompt: 'PRIVATE_PROMPT_CANARY' }, ctx());
  r.llmOutput({ provider: 'rein-magpie', model: 'flash', assistantTexts: ['PRIVATE_REPLY_CANARY'] }, ctx());
  const status = r.status(ctx());
  assert.equal(status.currentSession.observed.evidence, 'openclaw-output');
  assert.equal(status.currentSession.configured.verification, 'operator-configured');
  assert.equal(r.status(ctx({ sessionKey: 'bob' })).currentSession, null);
  assert.ok(!JSON.stringify(status).includes('CANARY'));
  const publicStatus = r.status({ ...ctx(), messageChannel: 'discord' });
  assert.deepEqual(Object.keys(publicStatus).sort(), ['billingEvidence', 'currentSession', 'enabled']);
  assert.equal(publicStatus.currentSession.configured.routeId, 'flash');
  assert.equal(r.status({ ...ctx({ sessionKey: 'bob' }), messageChannel: 'discord' }).currentSession, null);
  assert.deepEqual(Object.keys(r.status({ ...ctx(), messageChannel: 'slack' }, { sessionOnly: true })).sort(),
    ['billingEvidence', 'currentSession', 'enabled']);
});

test('runtime configuration rejects inherited paid ladders and mismatched gateway', () => {
  const r = router();
  const host = buildOpenClawFragment(r.config, '/synthetic/rein-router');
  assert.doesNotThrow(() => assertRuntimeConfig(r.config, host));
  const savedKey = host.models.providers['rein-magpie'].apiKey;
  host.models.providers['rein-magpie'].apiKey = 'magpie';
  assert.throws(() => assertRuntimeConfig(r.config, host), /credential binding/);
  host.models.providers['rein-magpie'].apiKey = savedKey;
  host.agents.defaults.model.fallbacks.push('openai/paid');
  assert.throws(() => assertRuntimeConfig(r.config, host), /fallbacks/);
  host.agents.defaults.model.fallbacks = [];
  host.models.providers['rein-magpie'].baseUrl = 'https://outside.example/v1';
  assert.throws(() => assertRuntimeConfig(r.config, host), /rein-magpie/);
});

test('runtime configuration requires the complete unique model catalog regardless of order', () => {
  const r = router();
  const host = buildOpenClawFragment(r.config, '/synthetic/rein-router');
  const provider = host.models.providers['rein-magpie'];
  const models = provider.models;
  for (const incomplete of [undefined, [], ...models.map(omitted => models.filter(model => model !== omitted)),
    [...models, models[0]], [...models.slice(0, -1), models[0]],
    [...models.slice(0, -1), { id: 'outside-catalog' }], [...models.slice(0, -1), null]]) {
    provider.models = incomplete;
    assert.throws(() => assertRuntimeConfig(r.config, host), /rein_router_runtime_invalid: provider\.models/);
  }
  provider.models = [...models].reverse();
  assert.doesNotThrow(() => assertRuntimeConfig(r.config, host));
});

test('gateway-reported serving metadata stays scoped and separate from billing assertions', async () => {
  const r = createRouter({ config: config(), environment: { REIN_TEST_GATEWAY_KEY: 'sk-magpie-key-synthetic-local-probe-00000000' },
    fetchImpl: async () => new Response(null, { status: 404 }) });
  const wrapped = r.wrapStreamFn({ agentId: 'main', streamFn: async (model, _context, options) => {
    await options.onResponse({ status: 200, headers: { 'x-magpie-provider': 'codex', 'x-magpie-model': 'codex/served-model', authorization: 'SECRET_HEADER_CANARY' } }, model);
    return fixtureStream({ role: 'assistant', stopReason: 'stop' });
  } });
  await wrapped({ provider: 'rein-magpie', id: 'code', api: 'openai-completions', baseUrl: r.config.gateway.baseUrl }, {}, { sessionId: 'session-a', apiKey: 'sk-magpie-key-synthetic-local-probe-00000000' });
  await r.llmOutput({ provider: 'rein-magpie', model: 'code', sessionId: 'session-a' }, ctx());
  const observed = r.status(ctx()).currentSession.observed;
  assert.deepEqual(observed.upstream, { provider: 'codex', gatewayMember: 'codex/served-model',
    vendorServedModel: null, effort: null, evidence: 'gateway-response-headers' });
  assert.ok(!JSON.stringify(observed).includes('SECRET_HEADER_CANARY'));
  r.llmOutput({ provider: 'rein-magpie', model: 'code', sessionId: 'session-b' }, ctx({ sessionKey: 'bob' }));
  assert.equal(r.status(ctx({ sessionKey: 'bob' })).currentSession.observed.upstream, null);
});

test('fallback validation resolves inherited primary and preserves unrelated agent ladders', () => {
  const r = router(config({ fallbackRoutes: ['standard', 'code'] }));
  const host = buildOpenClawFragment(r.config, '/synthetic/rein-router');
  host.agents.entries = { existing: { model: { primary: 'existing/model', fallbacks: ['existing/backup'] } } };
  assert.doesNotThrow(() => assertRuntimeConfig(r.config, host));
  host.agents.entries.inherits = { model: { fallbacks: ['rein-magpie/code', 'rein-magpie/standard'] } };
  assert.throws(() => assertRuntimeConfig(r.config, host), /fallbacks/);
  host.agents.entries.inherits.model.fallbacks = ['rein-magpie/standard', 'rein-magpie/code'];
  assert.doesNotThrow(() => assertRuntimeConfig(r.config, host));
});

test('a long-running turn keeps its billing guard when another run is admitted', () => {
  let now = 0;
  const r = createRouter({ config: config(), clock: () => now });
  r.beforeAgentRun({}, ctx({ runId: 'long', modelId: 'code' }));
  now = 3_600_001;
  r.beforeAgentRun({}, ctx({ runId: 'next', modelId: 'flash' }));
  assert.equal(r.beforeAgentRun({}, ctx({ runId: 'long', modelProviderId: 'paid', modelId: 'outside' })).outcome, 'block');
});

test('only a known settled lifecycle terminal releases a run boundary', () => {
  const r = router();
  const running = ctx({ modelId: 'flash' });
  assert.equal(r.beforeAgentRun({}, running).outcome, 'pass');
  for (const event of [
    lifecycle(), lifecycle('r1', { data: { phase: 'end' } }),
    lifecycle('r1', { data: { phase: 'error', executionSettled: 'true' } }),
    lifecycle('r1', { stream: 'tool', data: { phase: 'error', executionSettled: true } }),
    lifecycle('r1', { data: { phase: 'finishing', executionSettled: true } }),
    lifecycle('foreign', { data: { phase: 'error', executionSettled: true } }),
    lifecycle('r1', { agentId: 'other', data: { phase: 'error', executionSettled: true } }),
    lifecycle('r1', { sessionKey: 'another-session', data: { phase: 'error', executionSettled: true } }),
  ]) {
    assert.equal(r.lifecycleEvent(event), false);
    assert.equal(r.beforeAgentRun({}, { ...running, modelProviderId: 'paid', modelId: 'outside' }).outcome, 'block');
    assert.equal(r.beforeAgentRun({}, { ...running, modelId: 'standard' }).reason, 'rein_router_fallback_disallowed');
  }
  assert.equal(r.lifecycleEvent(lifecycle('r1', { agentId: running.agentId, sessionKey: running.sessionKey,
    data: { phase: 'error', executionSettled: true } })), true);
  assert.equal(r.lifecycleEvent(lifecycle('r1', { data: { phase: 'error', executionSettled: true } })), false);
});

test('settled failure and completion free bounded capacity while attempt terminals retain it', () => {
  const r = router();
  for (let index = 0; index < 4096; index++) {
    const runId = `failed-${index}`;
    assert.equal(r.beforeAgentRun({}, ctx({ runId, modelId: 'flash' })).outcome, 'pass');
    assert.equal(r.lifecycleEvent(lifecycle(runId)), false);
  }
  const next = ctx({ runId: 'next', modelId: 'flash' });
  assert.throws(() => r.beforeAgentRun({}, next), /rein_router_overloaded/);
  assert.equal(r.lifecycleEvent(lifecycle('foreign', { data: { phase: 'error', executionSettled: true } })), false);
  assert.throws(() => r.beforeAgentRun({}, next), /rein_router_overloaded/);
  for (const [index, phase] of ['error', 'end'].entries()) {
    assert.equal(r.lifecycleEvent(lifecycle(`failed-${index}`, { data: { phase, executionSettled: true } })), true);
    const admitted = { ...next, runId: `next-${index}` };
    assert.equal(r.beforeAgentRun({}, admitted).outcome, 'pass');
    assert.equal(r.beforeAgentRun({}, { ...admitted, modelId: 'standard' }).reason, 'rein_router_fallback_disallowed');
  }
  assert.throws(() => r.beforeAgentRun({}, next), /rein_router_overloaded/);
});

test('each prepared router receives native events directly and disposes its own subscription', () => {
  const listeners = new Set();
  const events = { onAgentEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  const one = router(), two = router();
  const disposals = [];
  const lifecycle = { onDispose: dispose => { disposals.push(dispose); } };
  const firstDispose = bindRouterLifecycle(one, { events, lifecycle });
  bindRouterLifecycle(two, { events, lifecycle });
  assert.equal(listeners.size, 2);
  one.beforeAgentRun({}, ctx({ runId: 'one', modelId: 'flash' }));
  two.beforeAgentRun({}, ctx({ runId: 'two', modelId: 'flash' }));
  const firstListener = [...listeners][0];
  for (const listener of listeners) listener({ runId: 'one', stream: 'lifecycle', data: { phase: 'error', executionSettled: true } });
  assert.equal(one.lifecycleEvent({ runId: 'one', stream: 'lifecycle', data: { phase: 'error', executionSettled: true } }), false);
  assert.equal(two.beforeAgentRun({}, ctx({ runId: 'two', modelId: 'standard' })).reason, 'rein_router_fallback_disallowed');
  firstDispose(); firstDispose();
  assert.equal(listeners.size, 1);
  one.beforeAgentRun({}, ctx({ runId: 'later', modelId: 'flash' }));
  // A callback retained by another host queue stays inert after disposal.
  firstListener({ runId: 'later', stream: 'lifecycle', data: { phase: 'end', executionSettled: true } });
  assert.equal(one.beforeAgentRun({}, ctx({ runId: 'later', modelId: 'standard' })).reason, 'rein_router_fallback_disallowed');
  disposals[1]();
  assert.equal(listeners.size, 0);
});

test('runtime lifecycle disposal is supported and missing lifecycle APIs refuse registration', () => {
  let listener, disposer, unsubscriptions = 0;
  const events = { onAgentEvent: value => { listener = value; return () => { unsubscriptions++; }; } };
  const r = router();
  bindRouterLifecycle(r, { events, lifecycle: { registerRuntimeLifecycle: value => { disposer = value.dispose; } } });
  assert.equal(typeof listener, 'function');
  disposer(); disposer();
  assert.equal(unsubscriptions, 1);
  assert.throws(() => bindRouterLifecycle(r, { events, lifecycle: {} }), /rein_router_lifecycle_unavailable/);
  assert.throws(() => bindRouterLifecycle(r, { events: {}, lifecycle: { onDispose() {} } }), /rein_router_lifecycle_unavailable/);
  assert.throws(() => bindRouterLifecycle(r, { events, lifecycle: { onDispose() { throw new Error('PRIVATE_CANARY'); } } }),
    { message: 'rein_router_lifecycle_unavailable' });
  assert.equal(unsubscriptions, 2);
});

test('runtime fallback follows the declared order even if another run layer reorders it', async () => {
  const r = router(config({ fallbackRoutes: ['standard', 'code'] }));
  await r.beforeModelResolve({ prompt: 'A simple question' }, ctx());
  assert.equal(r.beforeAgentRun({}, ctx({ modelId: 'flash' })).outcome, 'pass');
  r.lifecycleEvent(lifecycle('r1', { data: { phase: 'end' } }));
  assert.equal(r.beforeAgentRun({}, ctx({ modelId: 'code' })).reason, 'rein_router_fallback_order_disallowed');
  assert.equal(r.beforeAgentRun({}, ctx({ modelId: 'standard' })).outcome, 'pass');
  assert.equal(r.beforeAgentRun({}, ctx({ modelId: 'standard' })).outcome, 'pass');
  r.lifecycleEvent(lifecycle());
  assert.equal(r.beforeAgentRun({}, ctx({ modelId: 'code' })).outcome, 'pass');
  assert.equal(r.beforeAgentRun({}, ctx({ modelId: 'flash' })).reason, 'rein_router_fallback_order_disallowed');
});

test('automatic coding-plan selection and fallback require a classified coding task', async () => {
  const plan = { ...route('plan', 'high'), billingMode: 'coding-plan' };
  const c = config({ routes: [route('standard'), plan], fallbackRoutes: ['plan'] });
  const general = router(c, async () => answer('plan'));
  assert.equal((await general.beforeModelResolve({ prompt: 'What is a transaction?' }, ctx())).modelOverride, 'standard');
  assert.equal(general.beforeAgentRun({}, ctx({ modelId: 'plan' })).outcome, 'block');
  const coding = router(c, async () => answer('plan', { task: { type: 'choice', choice: 'coding', probabilities: { coding: 0.95 } } }));
  assert.equal((await coding.beforeModelResolve({ prompt: 'Implement a transaction helper' }, ctx())).modelOverride, 'plan');
  assert.equal(coding.beforeAgentRun({}, ctx({ modelId: 'plan' })).outcome, 'pass');
});

for (const [task, expected] of [['coding', 'pass'], ['simple', 'block']]) {
  test(`subscription quota fallback preserves ${task} task eligibility through attempt gates`, async () => {
    const plan = { ...route('plan', 'high'), billingMode: 'coding-plan' };
    const c = config({ routes: [route('standard'), plan], fallbackRoutes: ['plan'] });
    const r = router(c, async () => answer('standard', {
      task: { type: 'choice', choice: task, probabilities: { [task]: 0.98 } },
    }));
    const selected = await r.beforeModelResolve({ prompt: task === 'coding' ? 'Implement a transaction helper' : 'What is a transaction?' }, ctx());
    assert.equal(selected.modelOverride, 'standard');
    const firstAttempt = ctx({ modelId: 'standard' });
    assert.equal(r.beforeAgentRun({}, firstAttempt).outcome, 'pass');

    const wrapped = r.wrapStreamFn({ streamFn: () => fixtureStream({
      role: 'assistant', stopReason: 'error', errorMessage: '402: Synthetic subscription quota exhausted',
      errorCode: '402', errorType: 'insufficient_quota', content: [],
    }) });
    const stream = wrapped({ provider: 'rein-magpie', id: 'standard', api: 'openai-completions', baseUrl: r.config.gateway.baseUrl }, {});
    const failed = await stream.result();
    assert.equal(failed.errorCode, '429');
    r.lifecycleEvent(lifecycle());

    const fallback = r.beforeAgentRun({}, ctx({ modelId: 'plan' }));
    assert.equal(fallback.outcome, expected);
    if (expected === 'block') assert.equal(fallback.reason, 'rein_router_coding_plan_task_ineligible');
    else assert.equal(r.beforeAgentRun({}, ctx({ modelId: 'plan' })).outcome, 'pass');
  });
}
