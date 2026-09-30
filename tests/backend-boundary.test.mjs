import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALLER_ID_PATTERN,
  OPERATION_PATTERN,
  createBackendProof,
  createBackendTransport,
  isBackendProof,
} from '../plugins/rein-operations/backend-transport.ts';
import { createIngressProofStore } from '../plugins/rein-operations/ingress-proof.ts';

const BASE = 'https://rein.example.org';
const SENDER = 'U0SENDER';
const CHANNEL = 'C0BOARD';

function recordingFetch(responses) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return {
      ok: next.ok,
      status: next.status,
      async json() {
        return next.raw !== undefined ? next.raw : next.body;
      },
    };
  };
  return { fetchImpl, calls };
}

const transportWith = (responses, overrides = {}) => {
  const { fetchImpl, calls } = recordingFetch(responses);
  const transport = createBackendTransport({
    baseUrl: BASE,
    callerId: 'rein-agent',
    credential: 'super-secret-credential',
    fetch: fetchImpl,
    ...overrides,
  });
  return { transport, calls };
};

const proof = () => {
  const value = createBackendProof('opaque-assertion-value');
  assert.ok(value);
  return value;
};

test('credential and proof travel only in the request, never in a result', async () => {
  const { transport, calls } = transportWith([{ ok: true, status: 200, body: { ok: true, status: 'found' } }]);
  const result = await transport.operations('get_proposal', { id: 'p1' }, proof());
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, `${BASE}/api/agent/operations`);
  assert.equal(calls[0].init.headers['x-rein-caller-id'], 'rein-agent');
  assert.equal(calls[0].init.headers.authorization, 'Bearer super-secret-credential');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ['input', 'operation', 'proof']);
  assert.deepEqual(body.proof, { kind: 'assertion', assertion: 'opaque-assertion-value' });
  assert.ok(!JSON.stringify(result).includes('super-secret-credential'));
  assert.ok(!JSON.stringify(result).includes('opaque-assertion-value'));
});

test('a rejected caller or proof is auth_error; a transport failure is transport_error', async () => {
  const denied = transportWith([{ ok: false, status: 401, body: {} }]);
  assert.deepEqual(await denied.transport.operations('get_proposal', {}, proof()), {
    ok: false,
    reason: 'auth_error',
    httpStatus: 401,
  });
  const forbidden = transportWith([{ ok: false, status: 403, body: {} }]);
  assert.equal((await forbidden.transport.resolveIdentity(proof())).reason, 'auth_error');
  const broken = transportWith([new Error('socket closed')]);
  assert.deepEqual(await broken.transport.operations('get_proposal', {}, proof()), {
    ok: false,
    reason: 'transport_error',
    httpStatus: null,
  });
  const garbage = transportWith([{ ok: true, status: 200, raw: 'not-an-object' }]);
  assert.equal((await garbage.transport.operations('get_proposal', {}, proof())).reason, 'response_malformed');
});

test('an unusable operation name or proof is refused before any request', async () => {
  const { transport, calls } = transportWith([{ ok: true, status: 200, body: {} }]);
  assert.equal((await transport.operations('Bad-Operation', {}, proof())).reason, 'invalid_request');
  assert.equal(
    (await transport.operations('get_proposal', {}, { kind: 'assertion', assertion: '' })).reason,
    'invalid_request',
  );
  assert.equal((await transport.resolveIdentity(null)).reason, 'invalid_request');
  assert.equal((await transport.linkComplete('', proof())).reason, 'invalid_request');
  assert.equal(calls.length, 0);
  assert.ok(OPERATION_PATTERN.test('get_proposal'));
  assert.ok(!OPERATION_PATTERN.test('Get-Proposal'));
});

test('the relay body carries the exact snake_case tuple the backend expects', async () => {
  const { transport, calls } = transportWith([{ ok: true, status: 200, body: { assertion: 'a', expires_at: 'x' } }]);
  await transport.relayIngress({
    platform: 'slack',
    workspace_id: 'T0TEAM',
    platform_user_id: SENDER,
    channel_id: CHANNEL,
    event_id: 'Ev123',
    event_ts: '2026-09-30T17:00:00Z',
  });
  assert.equal(calls[0].url, `${BASE}/api/ingress/relay`);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    platform: 'slack',
    workspace_id: 'T0TEAM',
    platform_user_id: SENDER,
    channel_id: CHANNEL,
    event_id: 'Ev123',
    event_ts: '2026-09-30T17:00:00Z',
  });
});

test('transport configuration rejects a non-https origin, a bad caller id and no credential', () => {
  const base = {
    callerId: 'rein-agent',
    credential: 'c',
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  };
  assert.throws(() => createBackendTransport({ ...base, baseUrl: 'http://evil.example.org' }), /https/);
  assert.throws(() => createBackendTransport({ ...base, baseUrl: BASE, callerId: 'bad caller' }), /callerId/);
  assert.throws(() => createBackendTransport({ ...base, baseUrl: BASE, credential: '' }), /credential/);
  assert.ok(CALLER_ID_PATTERN.test('rein-agent'));
  assert.ok(!CALLER_ID_PATTERN.test('rein agent'));
});

test('the proof shape is strict and frozen', () => {
  assert.ok(isBackendProof({ kind: 'assertion', assertion: 'x' }));
  assert.ok(!isBackendProof({ kind: 'token', assertion: 'x' }));
  assert.ok(!isBackendProof({ kind: 'assertion', assertion: 'x'.repeat(9000) }));
  assert.equal(createBackendProof(42), null);
  assert.ok(Object.isFrozen(proof()));
});

const scope = (overrides = {}) => ({
  platform: 'slack',
  workspaceId: 'T0TEAM',
  channelId: CHANNEL,
  userId: SENDER,
  eventId: 'Ev1',
  ...overrides,
});

test('a run proof resolves only for the exact attested sender and channel', () => {
  const store = createIngressProofStore({ now: () => 1_000 });
  store.recordRun({ runId: 'R1', scope: scope(), proof: proof(), expiresAt: 2_000 });
  assert.equal(store.resolveRun({ runId: 'R1', scope: scope() }).ok, true);
  assert.equal(store.resolveRun({ runId: 'R1', scope: scope({ userId: 'U0OTHER' }) }).reason, 'proof_scope_mismatch');
  assert.equal(store.resolveRun({ runId: 'R1', scope: scope({ channelId: 'C0PUBLIC' }) }).reason, 'proof_scope_mismatch');
  assert.equal(store.resolveRun({ runId: 'R2', scope: scope() }).reason, 'proof_unavailable');
});

test('a second distinct event for one run makes it ambiguous and it fails closed', () => {
  const store = createIngressProofStore({ now: () => 1_000 });
  store.recordRun({ runId: 'R1', scope: scope(), proof: proof(), expiresAt: 2_000 });
  store.recordRun({ runId: 'R1', scope: scope({ eventId: 'Ev2' }), proof: proof(), expiresAt: 2_000 });
  assert.equal(store.resolveRun({ runId: 'R1', scope: scope() }).reason, 'proof_ambiguous');
});

test('an expired proof is refused and swept', () => {
  let clock = 1_000;
  const store = createIngressProofStore({ now: () => clock });
  store.recordRun({ runId: 'R1', scope: scope(), proof: proof(), expiresAt: 1_500 });
  clock = 1_600;
  assert.equal(store.resolveRun({ runId: 'R1', scope: scope() }).reason, 'proof_expired');
  assert.equal(store.size(), 0);
});

test('a session handle is single in flight and released by the tool call that used it', () => {
  const store = createIngressProofStore({ now: () => 1_000 });
  assert.equal(store.bindSession('S1', proof(), 2_000), 'bound');
  assert.equal(store.resolveSession('S1').ok, true);
  assert.equal(store.bindSession('S1', proof(), 2_000), 'in_flight');
  store.releaseSession('S1');
  assert.equal(store.resolveSession('S1').reason, 'proof_unavailable');
  assert.equal(store.bindSession('S1', proof(), 2_000), 'bound');
});

test('tool-call bindings resolve exactly and clear removes everything', () => {
  const store = createIngressProofStore({ now: () => 1_000 });
  store.bindToolCall('call_1', proof(), 2_000);
  assert.equal(store.resolveToolCall('call_1').ok, true);
  assert.equal(store.resolveToolCall('call_2').reason, 'proof_unavailable');
  store.recordRun({ runId: 'R1', scope: scope(), proof: proof(), expiresAt: 2_000 });
  store.clear();
  assert.equal(store.size(), 0);
  assert.equal(store.resolveToolCall('call_1').reason, 'proof_unavailable');
});

test('the store never grows past its ceiling', () => {
  const store = createIngressProofStore({ maxEntries: 3, now: () => 1_000 });
  for (let i = 0; i < 10; i += 1) store.bindToolCall(`call_${i}`, proof(), 2_000);
  assert.equal(store.size(), 3);
});

test('a scope-indexed proof resolves by sender, channel and session, and mismatch fails closed', () => {
  const store = createIngressProofStore({ now: () => 1_000 });
  store.recordScope({ scope: scope(), sessionKey: 'agent:slack:C0BOARD', proof: proof(), expiresAt: 2_000 });
  assert.equal(store.resolveScope({ scope: scope(), sessionKey: 'agent:slack:C0BOARD' }).ok, true);
  assert.equal(
    store.resolveScope({ scope: scope({ userId: 'U0OTHER' }), sessionKey: 'agent:slack:C0BOARD' }).reason,
    'proof_unavailable',
  );
  assert.equal(
    store.resolveScope({ scope: scope(), sessionKey: 'agent:slack:C0OTHER' }).reason,
    'proof_unavailable',
  );
});

test('two distinct events for one scope make it ambiguous and it fails closed', () => {
  const store = createIngressProofStore({ now: () => 1_000 });
  store.recordScope({ scope: scope(), sessionKey: 's', proof: proof(), expiresAt: 2_000 });
  store.recordScope({ scope: scope({ eventId: 'Ev2' }), sessionKey: 's', proof: proof(), expiresAt: 2_000 });
  assert.equal(store.resolveScope({ scope: scope(), sessionKey: 's' }).reason, 'proof_ambiguous');
});
