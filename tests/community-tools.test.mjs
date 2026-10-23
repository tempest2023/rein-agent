import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommunityToolsRegistration, COMMUNITY_TOOL_NAMES } from '../plugins/rein-operations/community-tools.ts';
import { createBackendRuntime } from '../plugins/rein-operations/backend-runtime.ts';
import { createBackendTransport } from '../plugins/rein-operations/backend-transport.ts';

const ID = '10000000-0000-4000-8000-000000000001';
const AT = '2026-10-20T12:00:00Z';
const resource = () => ({ id: ID, title: 'Synthetic agent course', summary: 'An introduction',
  url: 'https://catalog.example.org/course', type: 'Course', language: 'English', difficulty: null,
  topics: ['Agents'], authorPublisher: null, accessNotes: null, verifiedAt: AT,
  updatedAt: AT, publicationStatus: 'published' });
const event = () => ({ id: ID, title: 'Synthetic workshop', summary: 'An introduction',
  url: 'https://catalog.example.org/community/gather/workshop', format: 'online', timezone: 'America/Los_Angeles',
  country: null, region: null, city: null, venue: null, registrationStatus: 'open',
  registrationUrl: 'https://catalog.example.org/register', relationship: 'Independent',
  updatedAt: AT, publicationStatus: 'published', sessions: [{ startsAt: '2026-11-01T09:00:00Z', endsAt: '2026-11-01T10:00:00Z' }] });
const result = (items = [resource()], extra = {}) => ({ ok: true, status: items.length ? 'found' : 'empty',
  source: 'foundation_catalog', environment: 'dev', retrievedAt: AT, items, hasMore: false, nextOffset: null, ...extra });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fixture({ platform = 'discord', respond = body => json({ ok: true, operation: body.operation,
  result: result(body.operation.includes('event') ? [event()] : [resource()]) }), context = {} } = {}) {
  const calls = [];
  const transport = createBackendTransport({ baseUrl: 'https://backend.example.org', callerId: 'unit-test', credential: 'private-credential',
    fetch: async (url, init) => {
      const body = JSON.parse(init.body); calls.push({ url, body });
      if (url.endsWith('/api/ingress/relay')) return json({ assertion: 'private-proof-' + body.platform_user_id });
      return respond(body);
    } });
  const runtime = createBackendRuntime({ config: { enabled: true,
    workspaces: [{ platform, workspaceId: 'TEST_SPACE', nativeChannelIds: ['TEST_CHANNEL'] }],
    proposalChannelIds: ['TEST_CHANNEL'], boardChannelIds: ['TEST_CHANNEL'],
    backendApiBaseUrlEnvVar: 'BACKEND_URL', agentCallerIdEnvVar: 'CALLER', agentCredentialEnvVar: 'CREDENTIAL' },
    env: { BACKEND_URL: 'https://backend.example.org', CALLER: 'unit-test', CREDENTIAL: 'private-credential' }, transport });
  const ctx = { messageChannel: platform, nativeChannelId: 'TEST_CHANNEL', requesterSenderId: 'ACTUAL_MEMBER',
    sessionId: 'TEST_SESSION', assertInvocationCurrent() {}, ...context };
  const tools = createCommunityToolsRegistration({ runtime }).create(ctx);
  return { calls, ctx, tools, tool: name => tools.find(tool => tool.name === name) };
}

for (const platform of ['discord', 'slack']) {
  test(`${platform}: all four tools bind to trusted host sender and expose only catalog data`, async () => {
    const f = fixture({ platform });
    assert.deepEqual(f.tools.map(t => t.name), COMMUNITY_TOOL_NAMES);
    for (const tool of f.tools) {
      const args = tool.name.endsWith('_get') ? { id: ID } : { query: 'agent', limit: 3 };
      const response = await tool.execute('call-' + tool.name, args);
      assert.equal(response.details.ok, true);
      assert.deepEqual(JSON.parse(response.content[0].text), response.details);
      assert.doesNotMatch(JSON.stringify(response), /private-proof|private-credential|ACTUAL_MEMBER|TEST_CHANNEL/);
    }
    assert.equal(f.calls.length, 8);
    assert.equal(f.calls[0].body.platform_user_id, 'ACTUAL_MEMBER');
    assert.equal(f.calls[0].body.platform, platform);
    assert.deepEqual(f.calls[1].body.input, { query: 'agent', limit: 3 });
    assert.equal(f.calls[1].body.proof.assertion, 'private-proof-ACTUAL_MEMBER');
  });
}

test('a revoked link fails on the next call in the same conversation; no cached success is reused', async () => {
  let linked = true;
  const f = fixture({ respond: body => linked ? json({ ok: true, operation: body.operation, result: result() })
    : json({ ok: false, reason: 'identity_revoked', private: 'must-not-leak' }, 403) });
  const tool = f.tool('rein_resources_search');
  assert.equal((await tool.execute('first', {})).details.ok, true);
  linked = false;
  const denied = await tool.execute('second', {});
  assert.equal(denied.isError, true);
  assert.equal(denied.details.reason, 'community_member_required');
  assert.equal(denied.details.status, 'failed');
  assert.ok(!Object.hasOwn(denied.details, 'items'));
  assert.doesNotMatch(JSON.stringify(denied), /must-not-leak|Synthetic/);
  assert.equal(f.calls.length, 4);
});

for (const [reason, status, expected] of [
  ['binding_not_verified', 403, 'community_member_required'], ['scope_missing', 403, 'permission_denied'],
  ['channel_not_allowed', 403, 'permission_denied'], ['proof_expired', 401, 'permission_denied'],
  ['unavailable', 503, 'unavailable'], ['invalid_request', 400, 'invalid_request'], ['private database error', 500, 'unavailable'],
]) test(`HTTP ${status} ${reason} becomes an explicit sanitized failure`, async () => {
  const f = fixture({ respond: () => json({ ok: false, reason, items: [resource()], secret: 'must-not-leak' }, status) });
  const response = await f.tools[0].execute('call', {});
  assert.equal(response.details.reason, expected);
  assert.equal(response.isError, true);
  assert.doesNotMatch(JSON.stringify(response), /must-not-leak|Synthetic|private database/);
});

for (const args of [{ actor: 'other' }, { role: 'member' }, { environment: 'prod' }, { limit: 21 }, { offset: -1 },
  { query: '' }, { query: ' '.repeat(4) }, { query: 'x'.repeat(161) }, { query: { $ne: null } }]) {
  test(`invalid or impersonating input cannot query data: ${JSON.stringify(args)}`, async () => {
    const f = fixture();
    assert.equal((await f.tools[0].execute('call', args)).details.reason, 'invalid_request');
    assert.equal(f.calls.filter(c => c.url.endsWith('/operations')).length, 0);
  });
}

test('missing, stale and out-of-scope host contexts fail without a catalog request', async () => {
  for (const context of [{ requesterSenderId: '' }, { nativeChannelId: 'OTHER' }, { messageChannel: 'webchat' },
    { assertInvocationCurrent: undefined }, { assertInvocationCurrent() { throw Error('stale secret'); } }]) {
    const f = fixture({ context });
    const response = await f.tools[0].execute('call', {});
    assert.equal(response.details.ok, false);
    assert.equal(f.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(response), /stale secret/);
  }
});

test('an invocation cancelled during the backend call cannot release the data', async () => {
  const f = fixture({ respond: body => {
    f.ctx.assertInvocationCurrent = () => { throw Error('cancelled'); };
    return json({ ok: true, operation: body.operation, result: result() });
  } });
  const response = await f.tools[0].execute('call', {});
  assert.equal(response.details.ok, false);
  assert.doesNotMatch(JSON.stringify(response), /Synthetic agent course/);
});

for (const bad of [
  result([resource()], { status: 'empty' }), result([], { status: 'found' }),
  result([resource()], { hasMore: true }), result([resource()], { actor: 'secret' }),
  result([{ ...resource(), publicationStatus: 'draft' }]), result([{ ...resource(), url: 'javascript:alert(1)' }]),
  result([{ ...resource(), adminNotes: 'secret' }]), result([{ ...resource(), url: 'https://user:secret@example.org' }]),
]) test('malformed success never becomes a verified recommendation', async () => {
  const f = fixture({ respond: body => json({ ok: true, operation: body.operation, result: bad }) });
  assert.equal((await f.tools[0].execute('call', {})).details.reason, 'unavailable');
});

test('empty search, pagination and missing detail remain distinct successful outcomes', async () => {
  for (const [name, payload, args] of [
    ['rein_resources_search', result([]), {}],
    ['rein_resources_search', result([resource()], { hasMore: true, nextOffset: 1 }), { limit: 1 }],
    ['rein_resource_get', result([], { status: 'not_found' }), { id: ID }],
  ]) {
    const f = fixture({ respond: body => json({ ok: true, operation: body.operation, result: payload }) });
    assert.deepEqual((await f.tool(name).execute('call', args)).details, payload);
  }
});

test('detail must refer to the requested record, and events require valid time and zone', async () => {
  const wrong = fixture();
  assert.equal((await wrong.tool('rein_resource_get').execute('call', { id: ID.replace(/1$/, '2') })).details.reason, 'unavailable');
  for (const change of [{ timezone: 'Invalid/Zone' }, { sessions: [{ startsAt: AT, endsAt: AT }] }]) {
    const f = fixture({ respond: body => json({ ok: true, operation: body.operation, result: result([{ ...event(), ...change }]) }) });
    assert.equal((await f.tool('rein_events_search').execute('call', {})).details.reason, 'unavailable');
  }
});
