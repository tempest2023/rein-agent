import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayRequestHeaders, readGatewayHeaderEvidence, readGatewayRouteEvidence, readGatewayAuthenticationScope } from '../plugins/rein-router/provenance.mjs';
import { createRouter } from '../plugins/rein-router/runtime.mjs';

const key = 'sk-magpie-key-synthetic-provenance-00000000';
const baseUrl = 'http://127.0.0.1:3425/v1';
const expectedModel = 'fixture/configured-model';
const session = '11111111-1111-4111-8111-111111111111';
const headers = { 'X-Magpie-Provider': 'fixture', 'X-Magpie-Model': expectedModel };
const headerEvidence = () => readGatewayHeaderEvidence({ status: 200, headers });
const body = (overrides = {}) => ({ session, route: { asked: expectedModel, model: expectedModel,
  served: 'vendor-actual-snapshot', effort: 'medium', done: true, status: 200 }, ...overrides });
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const read = (fetchImpl, extra = {}) => readGatewayRouteEvidence({ baseUrl, gatewayKey: key,
  session, expectedModel, headerEvidence: headerEvidence(), fetchImpl, ...extra });

test('opaque request headers replace caller correlation and force the vendor reply name', () => {
  const one = createGatewayRequestHeaders({ 'x-magpie-session': 'PRIVATE_SESSION_CANARY',
    'X-Magpie-Response-Model': 'member', 'Origin': 'http://localhost:9999', 'X-Existing': 'preserved' });
  const two = createGatewayRequestHeaders();
  assert.match(one.session, /^[0-9a-f-]{36}$/);
  assert.notEqual(one.session, two.session);
  assert.equal(one.headers['x-magpie-session'], one.session);
  assert.equal(one.headers['x-magpie-response-model'], 'vendor');
  assert.equal(one.headers.origin, 'null');
  assert.equal(one.headers['x-existing'], 'preserved');
  assert.ok(!JSON.stringify(one).includes('CANARY'));
});

test('headers describe only the gateway member and never assert vendor identity or effort', () => {
  assert.deepEqual(headerEvidence(), { provider: 'fixture', gatewayMember: expectedModel,
    vendorServedModel: null, effort: null, evidence: 'gateway-response-headers' });
  assert.equal(readGatewayHeaderEvidence({ status: 401, headers }), null);
  assert.equal(readGatewayHeaderEvidence({ status: 200, headers: { ...headers, 'X-Magpie-Provider': 'other' } }), null);
  assert.equal(readGatewayHeaderEvidence({ status: 200, headers: { authorization: 'SECRET_CANARY' } }), null);
});

test('completed session route separates configured member, vendor-served model and actual effort', async () => {
  const result = await read(async (url, options) => {
    const endpoint = new URL(url);
    assert.equal(endpoint.origin, new URL(baseUrl).origin);
    assert.equal(endpoint.pathname, '/v1/magpie/route');
    assert.equal(endpoint.searchParams.get('session'), session);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    assert.equal(options.headers.Origin, 'null');
    return response({ ...body(), prompt: 'PRIVATE_PROMPT_CANARY', accounts: ['PRIVATE_ACCOUNT_CANARY'] });
  });
  assert.deepEqual(result, { provider: 'fixture', gatewayMember: expectedModel,
    vendorServedModel: 'vendor-actual-snapshot', effort: 'medium', evidence: 'gateway-session-route' });
  assert.ok(!JSON.stringify(result).includes('CANARY'));
  assert.ok(!JSON.stringify(result).includes(key));
});

for (const [name, mutate] of [
  ['another session', value => { value.session = '22222222-2222-4222-8222-222222222222'; }],
  ['unfinished route', value => { value.route.done = false; }],
  ['failed route', value => { value.route.status = 503; }],
  ['stale requested model', value => { value.route.asked = 'fixture/old-model'; }],
  ['unstripped effort suffix', value => { value.route.asked = `${expectedModel}:high`; }],
  ['header-conflicting member', value => { value.route.model = 'fixture/other-model'; }],
  ['header-conflicting provider', value => { value.route.model = 'other/configured-model'; }],
]) test(`rejects ${name} without replacing header-only evidence`, async () => {
  const value = body(); mutate(value);
  assert.deepEqual(await read(async () => response(value)), headerEvidence());
});

test('missing or unsafe served model and unknown effort remain unknown', async () => {
  const value = body(); value.route.served = 'PRIVATE UNSAFE CANARY'; value.route.effort = 'PRIVATE_CANARY';
  const result = await read(async () => response(value));
  assert.equal(result.vendorServedModel, null); assert.equal(result.effort, null);
  assert.ok(!JSON.stringify(result).includes('CANARY'));
  const absent = body(); delete absent.route.served;
  assert.equal((await read(async () => response(absent))).vendorServedModel, null);
});

test('trace can supply completed evidence when attribution headers are unavailable', async () => {
  const result = await read(async () => response(body()), { headerEvidence: null });
  assert.equal(result.vendorServedModel, 'vendor-actual-snapshot');
  assert.equal(result.evidence, 'gateway-session-route');
});

test('successful response waits for its matching unfinished route to be finalized', async () => {
  let calls = 0;
  const result = await read(async url => {
    const endpoint = new URL(url);
    calls++;
    if (calls === 1) {
      assert.equal(endpoint.searchParams.has('after'), false);
      return response(body({ seq: 7, route: { ...body().route, done: false } }));
    }
    assert.equal(endpoint.searchParams.get('after'), '7');
    assert.equal(endpoint.searchParams.get('wait'), '0.5');
    return response(body({ seq: 8 }));
  });
  assert.equal(calls, 2);
  assert.equal(result.vendorServedModel, 'vendor-actual-snapshot');
  assert.equal(result.evidence, 'gateway-session-route');
});

test('an unfinished trace for another model does not wait or attribute evidence', async () => {
  let calls = 0;
  const result = await read(async () => {
    calls++;
    return response(body({ seq: 7, route: { ...body().route, asked: 'fixture/other-model', done: false } }));
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, headerEvidence());
});

test('metadata lookup never leaves the loopback route endpoint or uses an arbitrary key', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return response(body()); };
  for (const extra of [{ baseUrl: 'https://external.example/v1' }, { baseUrl: `${baseUrl}?credential=CANARY` },
    { session: 'PRIVATE_RAW_SESSION' }, { gatewayKey: 'magpie' }])
    assert.deepEqual(await read(fetchImpl, extra), headerEvidence());
  assert.equal(calls, 0);
});

test('HTTP errors, redirects, malformed JSON and reflected diagnostics preserve safe fallback', async () => {
  for (const fetchImpl of [
    async () => new Response('PRIVATE_ERROR_CANARY', { status: 404 }),
    async () => { throw new Error('PRIVATE_REDIRECT_CANARY'); },
    async () => new Response('PRIVATE_INVALID_JSON_CANARY'),
    async () => { const value = response(body()); Object.defineProperty(value, 'redirected', { value: true }); return value; },
    async () => { const value = response(body()); Object.defineProperty(value, 'url', { value: 'https://external.example/' }); return value; },
  ]) {
    const result = await read(fetchImpl);
    assert.deepEqual(result, headerEvidence());
    assert.ok(!JSON.stringify(result).includes('CANARY'));
  }
});

test('body cap applies to declared and streamed bytes', async () => {
  const declared = new Response('{}', { headers: { 'content-length': String(64 * 1024 + 1) } });
  assert.deepEqual(await read(async () => declared), headerEvidence());
  const streamed = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(64 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close();
  } }));
  assert.deepEqual(await read(async () => streamed), headerEvidence());
});

test('timeout bounds both a stalled fetch and a stalled body independently of signal handling', async () => {
  let signal;
  assert.deepEqual(await read(async (_url, options) => { signal = options.signal; return new Promise(() => {}); },
    { timeoutMs: 15 }), headerEvidence());
  assert.equal(signal.aborted, true);
  const stalled = new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }));
  assert.deepEqual(await read(async () => stalled, { timeoutMs: 15 }), headerEvidence());
});

const config = () => ({ enabled: true, gateway: { baseUrl, apiKeyEnvVar: 'REIN_PROVENANCE_KEY' },
  routes: [{ id: 'capable', provider: 'Synthetic provider', gatewayModel: expectedModel,
    billingSource: 'Synthetic included allowance', billingMode: 'subscription', billingVerified: true,
    purpose: 'Synthetic general work', effort: 'high', contextWindow: 32768, maxTokens: 1024 }], defaultRoute: 'capable' });
const ctx = { agentId: 'agent-canary', sessionKey: 'PRIVATE_CHANNEL_SESSION_CANARY', runId: 'synthetic-run' };
const output = { provider: 'rein-magpie', model: 'capable', sessionId: 'PRIVATE_NATIVE_SESSION_CANARY',
  lastAssistant: { role: 'assistant', stopReason: 'stop' } };
const model = { id: 'capable', provider: 'rein-magpie', api: 'openai-completions', baseUrl };
const stream = final => ({ async *[Symbol.asyncIterator]() { yield { type: 'done', message: final }; }, result: async () => final });

test('runtime looks up only opaque per-call metadata and exposes safe trace provenance', async () => {
  let outgoing; let endpoint;
  const router = createRouter({ config: config(), environment: { REIN_PROVENANCE_KEY: key },
    fetchImpl: async url => {
      endpoint = new URL(url); const id = endpoint.searchParams.get('session');
      return response(body({ session: id }));
    } });
  const wrapped = router.wrapStreamFn({ agentId: ctx.agentId, streamFn: async (_model, _context, options) => {
    outgoing = options.headers;
    await options.onResponse({ status: 200, headers }, model);
    return stream({ role: 'assistant', stopReason: 'stop' });
  } });
  await wrapped(model, {}, { sessionId: output.sessionId, headers: { 'X-Magpie-Session': ctx.sessionKey } });
  await router.llmOutput({ ...output, prompt: 'PRIVATE_PROMPT_CANARY' }, ctx);
  assert.equal(endpoint.searchParams.get('session'), outgoing['x-magpie-session']);
  assert.equal(outgoing['x-magpie-response-model'], 'vendor');
  assert.ok(!endpoint.href.includes('CANARY'));
  const observation = router.status(ctx).currentSession.observed;
  assert.equal(observation.upstream.vendorServedModel, 'vendor-actual-snapshot');
  assert.equal(observation.upstream.effort, 'medium');
  assert.equal(observation.upstreamBilling, 'requires-magpie-and-provider-records');
  assert.ok(!JSON.stringify(observation).includes('CANARY'));
});

test('a late metadata response cannot overwrite a newer model-call snapshot', async () => {
  let completeFirst; let calls = 0; const opaqueSessions = [];
  const router = createRouter({ config: config(), environment: { REIN_PROVENANCE_KEY: key }, fetchImpl: async url => {
    const id = new URL(url).searchParams.get('session'); calls++;
    if (calls === 1) return new Promise(resolve => { completeFirst = () => resolve(response(body({ session: id,
      route: { ...body().route, served: 'old-snapshot' } }))); });
    return response(body({ session: id, route: { ...body().route, served: 'new-snapshot' } }));
  } });
  const wrapped = router.wrapStreamFn({ agentId: ctx.agentId, streamFn: async (_model, _context, options) => {
    opaqueSessions.push(options.headers['x-magpie-session']);
    await options.onResponse({ status: 200, headers }, model);
    return stream({ role: 'assistant', stopReason: 'stop' });
  } });
  await wrapped(model, {}, { sessionId: output.sessionId });
  const first = router.llmOutput(output, ctx);
  await wrapped(model, {}, { sessionId: output.sessionId });
  await router.llmOutput(output, ctx);
  completeFirst(); await first;
  assert.notEqual(opaqueSessions[0], opaqueSessions[1]);
  assert.equal(router.status(ctx).currentSession.observed.upstream.vendorServedModel, 'new-snapshot');
});

test('failed HTTP/model output and a different session do not trigger provenance lookup', async () => {
  let calls = 0;
  const router = createRouter({ config: config(), environment: { REIN_PROVENANCE_KEY: key },
    fetchImpl: async () => { calls++; return response(body()); } });
  const wrapped = router.wrapStreamFn({ agentId: ctx.agentId, streamFn: async (_model, _context, options) => {
    await options.onResponse({ status: 401, headers }, model);
    return stream({ role: 'assistant', stopReason: 'error' });
  } });
  await wrapped(model, {}, { sessionId: output.sessionId });
  await router.llmOutput({ ...output, lastAssistant: { stopReason: 'error' } }, ctx);
  await router.llmOutput({ ...output, sessionId: 'another-session' }, ctx);
  assert.equal(calls, 0);
  assert.equal(router.status(ctx).currentSession.observed.upstream, null);
});

const authenticationBody = (status = 401) => ({ session, seq: 1, route: {
  asked: expectedModel, model: expectedModel, done: true, status,
  tries: [{ model: expectedModel, done: true, status }],
} });
const authenticationScope = (status = 401) => ({ status, provider: 'fixture',
  gatewayMember: expectedModel, expectedModel });
const readAuthentication = (fetchImpl, extra = {}) => readGatewayAuthenticationScope({
  baseUrl, gatewayKey: key, session, expectedModel, fetchImpl, ...extra,
});

for (const status of [401, 403]) test(`completed per-call upstream ${status} trace supplies authentication scope without private diagnostics`, async () => {
  const value = authenticationBody(status);
  Object.assign(value.route, { error: 'PRIVATE_UPSTREAM_ERROR_CANARY', prompt: 'PRIVATE_PROMPT_CANARY',
    served: 'PRIVATE_SERVED_CANARY', account: 'PRIVATE_ACCOUNT_CANARY' });
  const result = await readAuthentication(async (url, options) => {
    const endpoint = new URL(url);
    assert.equal(endpoint.pathname, '/v1/magpie/route');
    assert.equal(endpoint.searchParams.get('session'), session);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    return response(value);
  });
  assert.deepEqual(result, authenticationScope(status));
  assert.ok(!JSON.stringify(result).includes('CANARY'));
  assert.ok(!JSON.stringify(result).includes(key));
});

for (const [name, mutate] of [
  ['another opaque session', value => { value.session = '22222222-2222-4222-8222-222222222222'; }],
  ['missing route', value => { value.route = null; }],
  ['another asked model', value => { value.route.asked = 'fixture/foreign'; }],
  ['asked model carrying effort suffix', value => { value.route.asked = `${expectedModel}:high`; }],
  ['another final model', value => { value.route.model = 'fixture/foreign'; }],
  ['successful status', value => { value.route.status = 200; }],
  ['payment status', value => { value.route.status = 402; }],
  ['server error status', value => { value.route.status = 502; }],
  ['string status', value => { value.route.status = '401'; }],
  ['missing tries', value => { delete value.route.tries; }],
  ['empty tries', value => { value.route.tries = []; }],
  ['unfinished last try', value => { value.route.tries[0].done = false; }],
  ['last try with different status', value => { value.route.tries[0].status = 403; }],
  ['last try with different model', value => { value.route.tries[0].model = 'fixture/foreign'; }],
  ['foreign earlier fallback', value => { value.route.tries.unshift({ model: 'paid/hidden', done: true, status: 503 }); }],
  ['malformed earlier try', value => { value.route.tries.unshift(null); }],
]) test(`authentication scope rejects ${name}`, async () => {
  const value = authenticationBody(); mutate(value);
  assert.equal(await readAuthentication(async () => response(value)), null);
});

test('retries of the same configured member can establish authentication scope', async () => {
  const value = authenticationBody();
  value.route.tries.unshift({ model: expectedModel, done: true, status: 503 });
  assert.deepEqual(await readAuthentication(async () => response(value)), authenticationScope());
});

test('authentication scope waits for unfinished trace finalization using its sequence', async () => {
  const requests = [];
  const result = await readAuthentication(async (url, options) => {
    const endpoint = new URL(url); requests.push(endpoint);
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    if (requests.length === 1) {
      const value = authenticationBody(); value.route.done = false;
      value.route.tries[0].done = false;
      return response(value);
    }
    const value = authenticationBody(); value.seq = 2;
    return response(value);
  });
  assert.deepEqual(result, authenticationScope());
  assert.equal(requests.length, 2);
  assert.equal(requests[0].searchParams.has('after'), false);
  assert.equal(requests[1].searchParams.get('after'), '1');
  assert.equal(requests[1].searchParams.get('wait'), '0.5');
});

test('unfinished authentication trace is bounded to four changing-sequence requests', async () => {
  let calls = 0;
  assert.equal(await readAuthentication(async url => {
    calls++;
    const endpoint = new URL(url);
    if (calls > 1) {
      assert.equal(endpoint.searchParams.get('after'), String(calls - 1));
      assert.equal(endpoint.searchParams.get('wait'), '0.5');
    }
    const value = authenticationBody(); value.seq = calls; value.route.done = false;
    return response(value);
  }), null);
  assert.equal(calls, 4);
});

test('unfinished authentication trace without a valid or advancing sequence stays unknown', async () => {
  for (const seq of [undefined, 0, -1, '1', Number.MAX_SAFE_INTEGER + 1]) {
    let calls = 0;
    assert.equal(await readAuthentication(async () => {
      calls++; const value = authenticationBody(); value.seq = seq; value.route.done = false;
      return response(value);
    }), null);
    assert.equal(calls, 1);
  }
  let calls = 0;
  assert.equal(await readAuthentication(async () => {
    calls++; const value = authenticationBody(); value.route.done = false;
    return response(value);
  }), null);
  assert.equal(calls, 2);
});

test('failed authentication lookup, missing trace, redirects and oversized response remain unknown', async () => {
  for (const fetchImpl of [
    async () => new Response('PRIVATE_GATEWAY_ERROR_CANARY', { status: 401 }),
    async () => new Response('PRIVATE_GATEWAY_ERROR_CANARY', { status: 403 }),
    async () => response({ session, seq: 0, route: null }),
    async () => { throw new Error('PRIVATE_REDIRECT_CANARY'); },
    async () => new Response('PRIVATE_INVALID_JSON_CANARY'),
    async () => new Response('{}', { headers: { 'content-length': String(64 * 1024 + 1) } }),
    async () => { const value = response(authenticationBody()); Object.defineProperty(value, 'redirected', { value: true }); return value; },
    async () => { const value = response(authenticationBody()); Object.defineProperty(value, 'url', { value: 'https://external.example/' }); return value; },
  ]) assert.equal(await readAuthentication(fetchImpl), null);
});

test('authentication lookup deadline aborts a stalled finalization wait and never asserts unfinished scope', async () => {
  let calls = 0; let signal;
  const result = await readAuthentication(async (_url, options) => {
    calls++; signal = options.signal;
    if (calls === 1) {
      const value = authenticationBody(); value.route.done = false;
      return response(value);
    }
    return new Promise(() => {});
  }, { timeoutMs: 15 });
  assert.equal(result, null);
  assert.equal(calls, 2);
  assert.equal(signal.aborted, true);
});

const sdkAuthenticationError = () => ({ role: 'assistant', stopReason: 'error',
  errorMessage: '401 Synthetic upstream access token expired; PRIVATE_ERROR_CANARY',
  errorCode: '401', errorType: 'authentication_error', errorBody: 'PRIVATE_BODY_CANARY',
  provider: 'rein-magpie', model: 'capable' });
const errorStream = error => ({ async *[Symbol.asyncIterator]() {
  yield { type: 'error', reason: 'error', error };
}, result: async () => error });

test('SDK-like 401 without onResponse normalizes only after matching per-call trace and shares event/result lookup', async () => {
  let outgoingSession; let lookups = 0;
  const original = sdkAuthenticationError();
  const router = createRouter({ config: config(), environment: { REIN_PROVENANCE_KEY: key }, fetchImpl: async url => {
    lookups++;
    const id = new URL(url).searchParams.get('session');
    assert.equal(id, outgoingSession);
    assert.ok(!url.includes('CANARY'));
    return response({ ...authenticationBody(), session: id });
  } });
  const wrapped = router.wrapStreamFn({ agentId: ctx.agentId, streamFn: (_model, _context, options) => {
    outgoingSession = options.headers['x-magpie-session'];
    return errorStream(original);
  } });
  const source = await wrapped(model, {}, { sessionId: output.sessionId });
  const events = [];
  for await (const event of source) events.push(event);
  const final = await source.result();
  assert.equal(events[0].error, final);
  assert.equal(final.errorCode, '502');
  assert.equal(final.errorType, 'server_error');
  assert.ok(!final.errorMessage.includes('CANARY'));
  assert.ok(!final.errorBody.includes('CANARY'));
  assert.equal(original.errorCode, '401');
  assert.equal(lookups, 1);
});

for (const [name, trace] of [
  ['genuine gateway rejection without a trace', id => ({ session: id, seq: 0, route: null })],
  ['another provider in the fallback trace', id => {
    const value = authenticationBody(); value.session = id;
    value.route.tries.unshift({ model: 'paid/hidden', done: true, status: 503 });
    return value;
  }],
]) test(`SDK-like 401 stays fail-closed for ${name}`, async () => {
  const original = sdkAuthenticationError(); let lookups = 0;
  const router = createRouter({ config: config(), environment: { REIN_PROVENANCE_KEY: key }, fetchImpl: async url => {
    lookups++;
    return response(trace(new URL(url).searchParams.get('session')));
  } });
  const wrapped = router.wrapStreamFn({ agentId: ctx.agentId, streamFn: () => errorStream(original) });
  const source = await wrapped(model, {}, { sessionId: output.sessionId });
  const final = await source.result();
  assert.equal(final, original);
  assert.equal(final.errorCode, '401');
  assert.equal(lookups, 1);
});
