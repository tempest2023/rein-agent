import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MVP_READ_TOOL_NAMES,
  createMvpReadToolRegistration,
} from '../plugins/rein-operations/mvp-read-tools.ts';

// Fake-reader tests for the MVP read tools. No live database or Slack call is made: the reader is a
// stub that records the arguments it received, so every test also proves which calls a refusal
// avoided.

const TEAM = 'T0123456ABC';
const PROPOSAL_CHANNEL = 'C_PROPOSAL';
const BOARD_CHANNEL = 'C_BOARD';
const SENDER = 'U0123456ABC';
const CONTACT = '11111111-1111-4111-8111-111111111111';
const URL_ENV = 'REIN_SUPABASE_URL';
const KEY_ENV = 'REIN_SUPABASE_SERVICE_ROLE_KEY';
const SECRET = 'sb_secret_unit_test_0000000000000000';

const baseConfig = Object.freeze({
  enabled: true,
  platform: 'slack',
  slackTeamId: TEAM,
  environment: 'dev',
  proposalChannelIds: [PROPOSAL_CHANNEL],
  boardChannelIds: [BOARD_CHANNEL],
  supabaseUrlEnvVar: URL_ENV,
  supabaseServiceKeyEnvVar: KEY_ENV,
});

const memberResult = (overrides = {}) => ({
  status: 'resolved',
  reason: 'resolved',
  contactId: CONTACT,
  isActiveContributor: true,
  isDirector: true,
  httpStatus: null,
  ...overrides,
});

const fundsResult = (overrides = {}) => ({
  status: 'snapshot',
  reason: 'snapshot',
  currency: 'USD',
  availableMinor: 250000,
  recordedAt: '2026-09-21T00:00:00+00:00',
  recordedBy: 'ops@rein.example',
  sourceNote: null,
  httpStatus: null,
  authorizesSpending: false,
  ...overrides,
});

function createFakeReader({ member = memberResult(), funds = fundsResult() } = {}) {
  const calls = { member: [], funds: [] };
  return {
    calls,
    reader: {
      async resolveSlackMember(slackUserId) {
        calls.member.push(slackUserId);
        return member;
      },
      async readAvailableFunds(currency) {
        calls.funds.push(currency);
        // Echo the requested code the way the real reader reports it back.
        return { ...funds, currency };
      },
    },
  };
}

function build({ config = baseConfig, reader, ctx: overrides = {}, env } = {}) {
  const guard = { calls: 0 };
  const ctx = {
    messageChannel: 'slack',
    nativeChannelId: BOARD_CHANNEL,
    requesterSenderId: SENDER,
    assertInvocationCurrent() {
      guard.calls += 1;
    },
    ...overrides,
  };
  const registration = createMvpReadToolRegistration({ config, reader, env });
  const tools = registration.create(ctx);
  return { registration, tools, guard, ctx, tool: name => tools.find(item => item.name === name) };
}

test('no MVP read tool registers without an explicit enabled block', () => {
  for (const config of [undefined, {}, { enabled: false }, { enabled: 'true' }]) {
    const { reader } = createFakeReader();
    const registration = createMvpReadToolRegistration({ config, reader });
    assert.equal(registration.create({ messageChannel: 'slack' }), null);
    assert.equal(registration.contextVersion, 2);
  }
  assert.deepEqual([...MVP_READ_TOOL_NAMES], ['rein_mvp_my_status', 'rein_mvp_funds']);
});

test('an enabled but incomplete MVP block fails loudly instead of registering silently', () => {
  const { reader } = createFakeReader();
  const cases = [
    [{ ...baseConfig, platform: 'discord' }, /platform must be "slack"/],
    [{ ...baseConfig, platform: undefined }, /platform must be "slack"/],
    [{ ...baseConfig, slackTeamId: 'not a team id' }, /slackTeamId must be one Slack team ID/],
    [{ ...baseConfig, slackTeamId: undefined }, /slackTeamId must be one Slack team ID/],
    [{ ...baseConfig, proposalChannelIds: [] }, /proposalChannelIds must list at least one/],
    [{ ...baseConfig, boardChannelIds: ['  '] }, /boardChannelIds must contain non-empty/],
    [{ ...baseConfig, environment: 'staging' }, /environment must be 'dev' or 'prod'/],
    [{ ...baseConfig, supabaseUrlEnvVar: undefined }, /supabaseUrlEnvVar must name a server environment variable/],
    [{ ...baseConfig, supabaseServiceKeyEnvVar: 'NOT A NAME' }, /supabaseServiceKeyEnvVar must name a server environment variable/],
  ];
  for (const [config, expected] of cases) {
    assert.throws(() => createMvpReadToolRegistration({ config, reader }), expected);
  }
});

test('the Supabase key is read from the server environment and never appears in the failure or the tools', () => {
  const missing = {};
  assert.throws(
    () => createMvpReadToolRegistration({ config: baseConfig, env: missing }),
    error => error.code === 'mvp_env_value_missing' && error.message.includes(URL_ENV),
  );
  assert.throws(
    () => createMvpReadToolRegistration({ config: baseConfig, env: { [URL_ENV]: 'https://project-ref.supabase.co' } }),
    error => error.code === 'mvp_env_value_missing' && error.message.includes(KEY_ENV),
  );

  const registration = createMvpReadToolRegistration({
    config: baseConfig,
    env: { [URL_ENV]: 'https://project-ref.supabase.co', [KEY_ENV]: SECRET },
  });
  const tools = registration.create({
    messageChannel: 'slack',
    nativeChannelId: BOARD_CHANNEL,
    requesterSenderId: SENDER,
    assertInvocationCurrent() {},
  });
  assert.deepEqual(tools.map(tool => tool.name), [...MVP_READ_TOOL_NAMES]);
  assert.ok(!JSON.stringify(tools).includes(SECRET));
  assert.ok(!JSON.stringify(tools).includes(URL_ENV));
});

test('my status reports the trusted sender without leaking the private contact ID', async () => {
  const { reader, calls } = createFakeReader();
  const { tool, guard } = build({ reader });

  const result = await tool('rein_mvp_my_status').execute('call-1', {});

  assert.deepEqual(result.details, {
    tool: 'rein_mvp_my_status',
    ok: true,
    linked: true,
    status: 'resolved',
    reason: 'resolved',
    isActiveContributor: true,
    isDirector: true,
    authorizesSpending: false,
  });
  assert.equal(result.content[0].text, JSON.stringify(result.details));
  assert.deepEqual(calls.member, [SENDER]);
  assert.equal(calls.funds.length, 0);
  assert.equal(guard.calls, 1);
  assert.ok(!result.content[0].text.includes(CONTACT));
  assert.ok(!result.content[0].text.includes(TEAM));
});

test('my status answers in an approved proposal or Board channel and refuses everything else', async () => {
  for (const channel of [PROPOSAL_CHANNEL, BOARD_CHANNEL]) {
    const { reader, calls } = createFakeReader();
    const { tool } = build({ reader, ctx: { nativeChannelId: channel } });
    const result = await tool('rein_mvp_my_status').execute('call-1', {});
    assert.equal(result.details.ok, true);
    assert.deepEqual(calls.member, [SENDER]);
  }

  const refused = [
    [{ nativeChannelId: 'C_OTHER' }, 'channel_out_of_scope'],
    [{ nativeChannelId: undefined }, 'channel_out_of_scope'],
    [{ messageChannel: 'discord' }, 'platform_out_of_scope'],
    [{ requesterSenderId: '   ' }, 'trusted_requester_unavailable'],
  ];
  for (const [overrides, code] of refused) {
    const { reader, calls } = createFakeReader();
    const { tool, guard } = build({ reader, ctx: overrides });
    const result = await tool('rein_mvp_my_status').execute('call-1', {});
    assert.equal(result.details.ok, false, code);
    assert.equal(result.details.error, code);
    assert.equal(result.details.authorizesSpending, undefined);
    assert.deepEqual(calls.member, [], 'a refused caller must not reach the database');
    assert.equal(guard.calls, 0);
  }
});

test('my status reports an unlinked sender without inventing a role', async () => {
  const { reader } = createFakeReader({
    member: memberResult({ status: 'identity_not_linked', reason: 'identity_not_linked', contactId: null, isActiveContributor: false, isDirector: false }),
  });
  const { tool } = build({ reader });

  const result = await tool('rein_mvp_my_status').execute('call-1', {});

  assert.equal(result.details.ok, true);
  assert.equal(result.details.linked, false);
  assert.equal(result.details.status, 'identity_not_linked');
  assert.equal(result.details.isActiveContributor, false);
  assert.equal(result.details.isDirector, false);
  assert.equal(result.details.authorizesSpending, false);
});

test('both tools reject an impersonation argument and never read the database for it', async () => {
  for (const [name, args] of [
    ['rein_mvp_my_status', { requesterSenderId: 'U_FAKE' }],
    ['rein_mvp_funds', { currency: 'USD', memberId: 'm1' }],
  ]) {
    const { reader, calls } = createFakeReader();
    const { tool } = build({ reader });
    const result = await tool(name).execute('call-1', args);
    assert.equal(result.details.ok, false);
    assert.equal(result.details.error, 'actor_argument_rejected');
    assert.deepEqual(calls.member, []);
    assert.deepEqual(calls.funds, []);
  }
});

test('a missing or stale host invocation guard produces no answer', async () => {
  const { reader } = createFakeReader();
  const { tool } = build({ reader, ctx: { assertInvocationCurrent: undefined } });
  const missing = await tool('rein_mvp_my_status').execute('call-1', {});
  assert.equal(missing.details.ok, false);
  assert.equal(missing.details.error, 'current_invocation_guard_unavailable');

  const stale = await build({
    reader: createFakeReader().reader,
    ctx: {
      assertInvocationCurrent() {
        throw Object.assign(new Error('turn closed'), { code: 'invocation_not_current' });
      },
    },
  }).tool('rein_mvp_funds').execute('call-1', { currency: 'USD' });
  assert.equal(stale.details.ok, false);
  assert.equal(stale.details.error, 'invocation_not_current');
});

test('funds reads the latest snapshot for a current director in the Board channel', async () => {
  const { reader, calls } = createFakeReader();
  const { tool, guard } = build({ reader });

  const result = await tool('rein_mvp_funds').execute('call-1', { currency: 'usd' });

  assert.deepEqual(result.details, {
    tool: 'rein_mvp_funds',
    ok: true,
    status: 'snapshot',
    reason: 'snapshot',
    currency: 'USD',
    availableMinor: 250000,
    recordedAt: '2026-09-21T00:00:00+00:00',
    recordedBy: 'ops@rein.example',
    sourceNote: null,
    authorizesSpending: false,
  });
  assert.deepEqual(calls.member, [SENDER]);
  assert.deepEqual(calls.funds, ['USD']);
  assert.equal(guard.calls, 1);
});

test('funds reports an explicit unknown instead of guessing a figure', async () => {
  const { reader } = createFakeReader({
    funds: fundsResult({ status: 'unknown', reason: 'no_snapshot', availableMinor: null, recordedAt: null, recordedBy: null }),
  });
  const { tool } = build({ reader });

  const result = await tool('rein_mvp_funds').execute('call-1', { currency: 'EUR' });

  assert.equal(result.details.ok, false);
  assert.equal(result.details.status, 'unknown');
  assert.equal(result.details.reason, 'no_snapshot');
  assert.equal(result.details.currency, 'EUR');
  assert.equal(result.details.availableMinor, null);
  assert.equal(result.details.authorizesSpending, false);
});

test('funds is limited to the trusted Board channel and to current directors', async () => {
  const outOfScope = createFakeReader();
  const nonBoard = await build({ reader: outOfScope.reader, ctx: { nativeChannelId: PROPOSAL_CHANNEL } })
    .tool('rein_mvp_funds')
    .execute('call-1', { currency: 'USD' });
  assert.equal(nonBoard.details.error, 'channel_out_of_scope');
  assert.deepEqual(outOfScope.calls.member, [], 'a non-Board channel is refused before any read');
  assert.deepEqual(outOfScope.calls.funds, []);

  for (const member of [
    memberResult({ isDirector: false }),
    memberResult({ status: 'identity_not_linked', reason: 'identity_not_linked', contactId: null, isActiveContributor: false, isDirector: false }),
    memberResult({ status: 'identity_link_revoked', reason: 'identity_link_revoked', contactId: null, isActiveContributor: false, isDirector: false }),
    memberResult({ status: 'unavailable', reason: 'transport_error', contactId: null, isActiveContributor: false, isDirector: false, httpStatus: null }),
  ]) {
    const fake = createFakeReader({ member });
    const result = await build({ reader: fake.reader }).tool('rein_mvp_funds').execute('call-1', { currency: 'USD' });
    assert.equal(result.details.ok, false);
    assert.equal(result.details.error, 'board_membership_required');
    assert.deepEqual(fake.calls.funds, [], 'a non-director never reaches the funds read');
    assert.ok(!JSON.stringify(result.details).includes(CONTACT));
  }
});

test('funds passes a closed reader failure through without inventing a balance', async () => {
  const { reader } = createFakeReader({
    funds: fundsResult({ status: 'unavailable', reason: 'http_error', availableMinor: null, recordedAt: null, recordedBy: null, httpStatus: 503 }),
  });
  const { tool } = build({ reader });

  const result = await tool('rein_mvp_funds').execute('call-1', { currency: 'USD' });

  assert.equal(result.details.ok, false);
  assert.equal(result.details.status, 'unavailable');
  assert.equal(result.details.reason, 'http_error');
  assert.equal(result.details.availableMinor, null);
  assert.equal(result.details.authorizesSpending, false);
});
