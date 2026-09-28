import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MVP_READ_TOOL_NAMES,
  createMvpReadToolRegistration,
} from '../plugins/rein-operations/mvp-read-tools.ts';
import {
  normalizeVoteTypePhrase,
  parseVoteTypeLabelConfig,
  resolveVoteTypePhrase,
} from '../plugins/rein-operations/mvp-vote-type-resolve.ts';

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
const BOT_TOKEN_ENV = 'REIN_SLACK_BOT_TOKEN';
const BOT_TOKEN = 'xoxb-unit-test-0000000000000001';
const VOTE_TYPE = 'event_single';
const PROPOSAL_ID_A = '22222222-2222-4222-8222-222222222222';
const PROPOSAL_ID_B = '33333333-3333-4333-8333-333333333333';
const PROPOSAL_ID_C = '44444444-4444-4444-8444-444444444444';

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

/** One stored proposal as the writer reports it; the listing must never publish the private fields. */
function candidateProposal(overrides = {}) {
  return {
    id: PROPOSAL_ID_A,
    proposerContactId: CONTACT,
    title: 'Repair the workshop',
    summary: null,
    voteType: VOTE_TYPE,
    requestedMinor: null,
    currency: null,
    status: 'submitted',
    createdAt: '2026-09-01T00:00:00+00:00',
    ...overrides,
  };
}

function createFakeWriter({
  voteTypes = [VOTE_TYPE],
  candidates = [candidateProposal()],
  inserts = {},
} = {}) {
  const calls = { listVoteTypes: [], listCandidateProposals: [] };
  return {
    calls,
    writer: {
      async listVoteTypes(input = {}) {
        calls.listVoteTypes.push(input);
        if (inserts.listVoteTypes) return inserts.listVoteTypes(input);
        return { ok: true, status: 'found', reason: 'vote_types', voteTypes: [...voteTypes], httpStatus: 200 };
      },
      async listCandidateProposals(input) {
        calls.listCandidateProposals.push(input);
        if (inserts.listCandidateProposals) return inserts.listCandidateProposals(input);
        return { ok: true, status: 'found', reason: 'candidates', proposals: [...candidates], httpStatus: 200 };
      },
    },
  };
}

function build({ config = baseConfig, reader, writer, ctx: overrides = {}, env } = {}) {
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
  const registration = createMvpReadToolRegistration({ config, reader, writer, env });
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
  assert.deepEqual([...MVP_READ_TOOL_NAMES], [
    'rein_member_status',
    'rein_funds',
    'rein_poll_candidates',
    'rein_vote_type_resolve',
  ]);
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
    error => error.code === 'foundation_db_env_value_missing' && error.message.includes(URL_ENV),
  );
  assert.throws(
    () => createMvpReadToolRegistration({ config: baseConfig, env: { [URL_ENV]: 'https://project-ref.supabase.co' } }),
    error => error.code === 'foundation_db_env_value_missing' && error.message.includes(KEY_ENV),
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

test('email identity matching is off by default and needs no Slack bot token', () => {
  for (const config of [baseConfig, { ...baseConfig, identityEmailMatch: 'disabled' }]) {
    const { reader } = createFakeReader();
    const registration = createMvpReadToolRegistration({ config, reader });
    const tools = registration.create({
      messageChannel: 'slack',
      nativeChannelId: BOARD_CHANNEL,
      requesterSenderId: SENDER,
      assertInvocationCurrent() {},
    });
    assert.deepEqual(tools.map(tool => tool.name), [...MVP_READ_TOOL_NAMES]);
  }
});

test('an unknown identityEmailMatch value fails loudly instead of being ignored', () => {
  const { reader } = createFakeReader();
  for (const value of ['yes', 'true', 1]) {
    assert.throws(
      () => createMvpReadToolRegistration({ config: { ...baseConfig, identityEmailMatch: value }, reader }),
      /identityEmailMatch must be "enabled" or "disabled"/,
    );
  }
});

test('an injected reader needs no bot token even with email identity matching enabled', () => {
  const { reader, calls } = createFakeReader();
  const registration = createMvpReadToolRegistration({
    config: { ...baseConfig, identityEmailMatch: 'enabled' },
    reader,
  });
  const tools = registration.create({
    messageChannel: 'slack',
    nativeChannelId: BOARD_CHANNEL,
    requesterSenderId: SENDER,
    assertInvocationCurrent() {},
  });
  assert.deepEqual(tools.map(tool => tool.name), [...MVP_READ_TOOL_NAMES]);
  assert.equal(calls.member.length, 0);
});

test('email identity matching names the bot token variable and never echoes its value', () => {
  const enabled = { ...baseConfig, identityEmailMatch: 'enabled' };
  // No variable name at all: enabling the option without it is an operator error.
  assert.throws(
    () => createMvpReadToolRegistration({ config: enabled, env: {} }),
    /foundationDb\.slackBotTokenEnvVar must name a server environment variable/,
  );
  // A name that is present but malformed fails the same way, without quoting the value.
  assert.throws(
    () =>
      createMvpReadToolRegistration({ config: { ...enabled, slackBotTokenEnvVar: 'NOT A NAME' }, env: {} }),
    /foundationDb\.slackBotTokenEnvVar must name a server environment variable/,
  );
  // The name is valid but the server environment holds no value: the failure names the variable,
  // never a credential.
  const named = { ...enabled, slackBotTokenEnvVar: BOT_TOKEN_ENV };
  assert.throws(
    () =>
      createMvpReadToolRegistration({
        config: named,
        env: { [URL_ENV]: 'https://project-ref.supabase.co', [KEY_ENV]: SECRET },
      }),
    error => error.code === 'foundation_db_env_value_missing' && error.message.includes(BOT_TOKEN_ENV),
  );

  const registration = createMvpReadToolRegistration({
    config: named,
    env: {
      [URL_ENV]: 'https://project-ref.supabase.co',
      [KEY_ENV]: SECRET,
      [BOT_TOKEN_ENV]: BOT_TOKEN,
    },
  });
  const tools = registration.create({
    messageChannel: 'slack',
    nativeChannelId: BOARD_CHANNEL,
    requesterSenderId: SENDER,
    assertInvocationCurrent() {},
  });
  assert.deepEqual(tools.map(tool => tool.name), [...MVP_READ_TOOL_NAMES]);
  assert.ok(!JSON.stringify(tools).includes(BOT_TOKEN), 'the bot token never appears in a tool');
  assert.ok(!JSON.stringify(tools).includes(BOT_TOKEN_ENV), 'the variable name never appears in a tool');
});

test('enabled email matching builds one lookup that presents the bot token only as a header', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), headers: init.headers ?? {} });
    // The link table is empty and the Slack provider reports no such user, so the sender resolves
    // as unlinked without a second database read.
    if (String(url).startsWith('https://slack.com/')) {
      return new Response(JSON.stringify({ ok: false, error: 'user_not_found' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const registration = createMvpReadToolRegistration({
      config: { ...baseConfig, identityEmailMatch: 'enabled', slackBotTokenEnvVar: BOT_TOKEN_ENV },
      env: {
        [URL_ENV]: 'https://project-ref.supabase.co',
        [KEY_ENV]: SECRET,
        [BOT_TOKEN_ENV]: BOT_TOKEN,
      },
    });
    const tools = registration.create({
      messageChannel: 'slack',
      nativeChannelId: BOARD_CHANNEL,
      requesterSenderId: SENDER,
      assertInvocationCurrent() {},
    });
    const result = await tools.find(tool => tool.name === 'rein_member_status').execute('call-1', {});

    assert.equal(result.details.status, 'identity_not_linked');
    assert.equal(result.details.reason, 'identity_email_user_not_found');
    const slackRequest = requests.find(request => request.url.startsWith('https://slack.com/api/users.info?'));
    assert.ok(slackRequest, 'the enabled email matching must probe the Slack profile');
    assert.equal(slackRequest.headers.authorization, `Bearer ${BOT_TOKEN}`);
    assert.ok(requests.every(request => !request.url.includes(BOT_TOKEN)), 'the token never travels in a URL');
    assert.ok(!JSON.stringify(result.details).includes(BOT_TOKEN));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('my status reports the trusted sender without leaking the private contact ID', async () => {
  const { reader, calls } = createFakeReader();
  const { tool, guard } = build({ reader });

  const result = await tool('rein_member_status').execute('call-1', {});

  assert.deepEqual(result.details, {
    tool: 'rein_member_status',
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
    const result = await tool('rein_member_status').execute('call-1', {});
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
    const result = await tool('rein_member_status').execute('call-1', {});
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

  const result = await tool('rein_member_status').execute('call-1', {});

  assert.equal(result.details.ok, true);
  assert.equal(result.details.linked, false);
  assert.equal(result.details.status, 'identity_not_linked');
  assert.equal(result.details.isActiveContributor, false);
  assert.equal(result.details.isDirector, false);
  assert.equal(result.details.authorizesSpending, false);
});

test('both tools reject an impersonation argument and never read the database for it', async () => {
  for (const [name, args] of [
    ['rein_member_status', { requesterSenderId: 'U_FAKE' }],
    ['rein_funds', { currency: 'USD', memberId: 'm1' }],
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
  const missing = await tool('rein_member_status').execute('call-1', {});
  assert.equal(missing.details.ok, false);
  assert.equal(missing.details.error, 'current_invocation_guard_unavailable');

  const stale = await build({
    reader: createFakeReader().reader,
    ctx: {
      assertInvocationCurrent() {
        throw Object.assign(new Error('turn closed'), { code: 'invocation_not_current' });
      },
    },
  }).tool('rein_funds').execute('call-1', { currency: 'USD' });
  assert.equal(stale.details.ok, false);
  assert.equal(stale.details.error, 'invocation_not_current');
});

test('funds reads the latest snapshot for a current director in the Board channel', async () => {
  const { reader, calls } = createFakeReader();
  const { tool, guard } = build({ reader });

  const result = await tool('rein_funds').execute('call-1', { currency: 'usd' });

  assert.deepEqual(result.details, {
    tool: 'rein_funds',
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

  const result = await tool('rein_funds').execute('call-1', { currency: 'EUR' });

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
    .tool('rein_funds')
    .execute('call-1', { currency: 'USD' });
  assert.equal(nonBoard.details.error, 'channel_out_of_scope');
  assert.deepEqual(outOfScope.calls.member, [], 'a non-Board channel is refused before any read');
  assert.deepEqual(outOfScope.calls.funds, []);

  for (const [member, expectedError] of [
    [memberResult({ isDirector: false }), 'board_membership_required'],
    [memberResult({ status: 'identity_not_linked', reason: 'identity_not_linked', contactId: null, isActiveContributor: false, isDirector: false }), 'board_membership_required'],
    [memberResult({ status: 'identity_link_revoked', reason: 'identity_link_revoked', contactId: null, isActiveContributor: false, isDirector: false }), 'board_membership_required'],
    [memberResult({ status: 'unavailable', reason: 'transport_error', contactId: null, isActiveContributor: false, isDirector: false, httpStatus: null }), 'identity_check_unavailable'],
  ]) {
    const fake = createFakeReader({ member });
    const result = await build({ reader: fake.reader }).tool('rein_funds').execute('call-1', { currency: 'USD' });
    assert.equal(result.details.ok, false);
    assert.equal(result.details.error, expectedError);
    assert.deepEqual(fake.calls.funds, [], 'a non-director never reaches the funds read');
    assert.ok(!JSON.stringify(result.details).includes(CONTACT));
  }
});

test('funds passes a closed reader failure through without inventing a balance', async () => {
  const { reader } = createFakeReader({
    funds: fundsResult({ status: 'unavailable', reason: 'http_error', availableMinor: null, recordedAt: null, recordedBy: null, httpStatus: 503 }),
  });
  const { tool } = build({ reader });

  const result = await tool('rein_funds').execute('call-1', { currency: 'USD' });

  assert.equal(result.details.ok, false);
  assert.equal(result.details.status, 'unavailable');
  assert.equal(result.details.reason, 'http_error');
  assert.equal(result.details.availableMinor, null);
  assert.equal(result.details.authorizesSpending, false);
});

// ---------------------------------------------------------------------------------------------
// `rein_poll_candidates`
// ---------------------------------------------------------------------------------------------

test('poll candidates lists the eligible proposals of one configured vote type', async () => {
  const letters = createFakeWriter({
    candidates: [
      candidateProposal({ id: PROPOSAL_ID_A, title: 'Repair the workshop' }),
      candidateProposal({ id: PROPOSAL_ID_B, title: 'Community garden', status: 'unselected' }),
    ],
  });
  const { tool, guard } = build({ reader: createFakeReader().reader, writer: letters.writer });

  const result = await tool('rein_poll_candidates').execute('call-1', { voteType: VOTE_TYPE });

  assert.deepEqual(result.details, {
    tool: 'rein_poll_candidates',
    ok: true,
    status: 'found',
    reason: 'candidates',
    voteType: VOTE_TYPE,
    candidates: [
      {
        proposalId: PROPOSAL_ID_A,
        title: 'Repair the workshop',
        status: 'submitted',
        voteType: VOTE_TYPE,
        createdAt: '2026-09-01T00:00:00+00:00',
      },
      {
        proposalId: PROPOSAL_ID_B,
        title: 'Community garden',
        status: 'unselected',
        voteType: VOTE_TYPE,
        createdAt: '2026-09-01T00:00:00+00:00',
      },
    ],
    candidateCount: 2,
    filters: {
      limit: 50,
      submittedSince: null,
      excludeProposalIds: [],
      includeRecentlyUnselected: false,
      eligibleStatuses: ['submitted', 'unselected'],
    },
    eligibleStatuses: ['submitted', 'unselected'],
    authorizesSpending: false,
  });
  assert.equal(result.content[0].text, JSON.stringify(result.details));
  assert.equal(guard.calls, 1, 'the answer is only returned behind the invocation guard');
  assert.deepEqual(letters.calls.listVoteTypes, [{ limit: 200 }], 'the type table is the source of configured types');
  assert.deepEqual(letters.calls.listCandidateProposals, [
    { voteType: VOTE_TYPE, limit: 50, includeRecentlyUnselected: false },
  ]);
  // The private contact id of the proposer is never part of the answer, and neither is a proposal
  // body: the question is what a round may consider, not who asked for what.
  assert.ok(!result.content[0].text.includes(CONTACT));
  assert.ok(!result.content[0].text.includes('summary'));
  assert.ok(!result.content[0].text.includes('requestedMinor'));
});

test('poll candidates passes the optional filters through to the candidate read', async () => {
  const filtered = createFakeWriter({ candidates: [candidateProposal({ id: PROPOSAL_ID_C })] });
  const { tool } = build({ reader: createFakeReader().reader, writer: filtered.writer });

  const result = await tool('rein_poll_candidates').execute('call-1', {
    voteType: VOTE_TYPE,
    limit: 5,
    submittedSince: '2026-09-01T00:00:00Z',
    excludeProposalIds: [PROPOSAL_ID_A, PROPOSAL_ID_B],
    includeRecentlyUnselected: true,
  });

  assert.equal(result.details.ok, true);
  assert.deepEqual(filtered.calls.listCandidateProposals, [
    {
      voteType: VOTE_TYPE,
      limit: 5,
      excludeProposalIds: [PROPOSAL_ID_A, PROPOSAL_ID_B],
      submittedSince: '2026-09-01T00:00:00Z',
      includeRecentlyUnselected: true,
    },
  ]);
  assert.deepEqual(result.details.filters, {
    limit: 5,
    submittedSince: '2026-09-01T00:00:00Z',
    excludeProposalIds: [PROPOSAL_ID_A, PROPOSAL_ID_B],
    includeRecentlyUnselected: true,
    eligibleStatuses: ['submitted', 'unselected'],
  });
});

test('poll candidates refuses a missing or malformed type instead of guessing one from prose', async () => {
  // Every one of these must fail before any read: the type is named explicitly or not at all.
  for (const args of [{}, { voteType: '' }, { voteType: '   ' }, { voteType: 'Event Single' }, { voteType: 'EVENT' }]) {
    const fakes = createFakeWriter();
    const { tool, guard } = build({ reader: createFakeReader().reader, writer: fakes.writer });
    const result = await tool('rein_poll_candidates').execute('call-1', args);

    assert.equal(result.details.ok, false, JSON.stringify(args));
    assert.equal(result.details.error, 'vote_type_invalid');
    assert.deepEqual(fakes.calls.listVoteTypes, [], 'a nameless type never reaches the type table');
    assert.deepEqual(fakes.calls.listCandidateProposals, []);
    assert.equal(guard.calls, 0);
  }
});

test('poll candidates refuses a well-formed but unconfigured type by name, listing the configured ones', async () => {
  const fakes = createFakeWriter({ voteTypes: ['event_pair', 'event_single'] });
  const { tool, guard } = build({ reader: createFakeReader().reader, writer: fakes.writer });

  const result = await tool('rein_poll_candidates').execute('call-1', { voteType: 'event' });

  assert.equal(result.details.ok, false);
  assert.equal(result.details.error, 'vote_type_not_configured');
  assert.equal(result.details.voteType, 'event');
  assert.deepEqual(result.details.configuredVoteTypes, ['event_pair', 'event_single']);
  assert.equal(result.details.nextStep, 'ask_an_operator_to_configure_the_vote_type');
  assert.deepEqual(fakes.calls.listCandidateProposals, [], 'no pool is read for a type that is not configured');
  assert.equal(guard.calls, 0);
});

test('an unreadable type list is an outage, never an empty configuration', async () => {
  const down = createFakeWriter({
    inserts: {
      listVoteTypes: () => ({ ok: false, status: 'unavailable', reason: 'http_error', voteTypes: null, httpStatus: 503 }),
    },
  });
  const { tool } = build({ reader: createFakeReader().reader, writer: down.writer });

  const result = await tool('rein_poll_candidates').execute('call-1', { voteType: VOTE_TYPE });

  assert.equal(result.details.ok, false);
  assert.equal(result.details.error, 'vote_type_configuration_unavailable');
  assert.notEqual(result.details.error, 'vote_type_not_configured', 'an outage is not a missing type');
  assert.deepEqual(down.calls.listCandidateProposals, [], 'an unreadable configuration reads no pool');
});

test('a failed candidate read leaks no count and is never an empty pool', async () => {
  const down = createFakeWriter({
    inserts: {
      listCandidateProposals: () => ({ ok: false, status: 'unavailable', reason: 'http_error', proposals: null, httpStatus: 503 }),
    },
  });
  const { tool } = build({ reader: createFakeReader().reader, writer: down.writer });

  const result = await tool('rein_poll_candidates').execute('call-1', { voteType: VOTE_TYPE });

  assert.equal(result.details.ok, false);
  assert.equal(result.details.error, 'candidate_pool_unavailable');
  assert.equal(result.details.candidates, undefined, 'a failed read names no candidate');
  assert.equal(result.details.candidateCount, undefined, 'a failed read reports no count');
  assert.equal(result.details.authorizesSpending, undefined);
  assert.ok(!result.content[0].text.includes('"candidateCount"'), 'no count reaches the caller');
  assert.ok(!result.content[0].text.includes('[]'), 'no empty pool is reported');
});

test('poll candidates is limited to the trusted Board channel and to current directors', async () => {
  // A non-Board channel, a missing sender and another platform are all refused before any read.
  for (const [overrides, code] of [
    [{ nativeChannelId: PROPOSAL_CHANNEL }, 'channel_out_of_scope'],
    [{ nativeChannelId: 'C_OTHER' }, 'channel_out_of_scope'],
    [{ nativeChannelId: undefined }, 'channel_out_of_scope'],
    [{ requesterSenderId: '   ' }, 'trusted_requester_unavailable'],
    [{ messageChannel: 'discord' }, 'platform_out_of_scope'],
  ]) {
    const fakes = createFakeWriter();
    const readerFake = createFakeReader();
    const { tool, guard } = build({ reader: readerFake.reader, writer: fakes.writer, ctx: overrides });
    const result = await tool('rein_poll_candidates').execute('call-1', { voteType: VOTE_TYPE });

    assert.equal(result.details.ok, false, code);
    assert.equal(result.details.error, code);
    assert.deepEqual(readerFake.calls.member, [], 'a refused caller never resolves an identity');
    assert.deepEqual(fakes.calls.listVoteTypes, [], 'a refused caller never reads the type table');
    assert.deepEqual(fakes.calls.listCandidateProposals, []);
    assert.equal(guard.calls, 0);
  }

  // A linked but non-director sender, and an unresolved one, are refused before the type table.
  for (const [member, expectedError] of [
    [memberResult({ isDirector: false }), 'board_membership_required'],
    [memberResult({ status: 'identity_not_linked', reason: 'identity_not_linked', contactId: null, isActiveContributor: false, isDirector: false }), 'board_membership_required'],
    [memberResult({ status: 'identity_link_revoked', reason: 'identity_link_revoked', contactId: null, isActiveContributor: false, isDirector: false }), 'board_membership_required'],
    [memberResult({ status: 'unavailable', reason: 'transport_error', contactId: null, isActiveContributor: false, isDirector: false, httpStatus: null }), 'identity_check_unavailable'],
  ]) {
    const fakes = createFakeWriter();
    const { tool } = build({ reader: createFakeReader({ member }).reader, writer: fakes.writer });
    const result = await tool('rein_poll_candidates').execute('call-1', { voteType: VOTE_TYPE });

    assert.equal(result.details.ok, false);
    assert.equal(result.details.error, expectedError);
    assert.deepEqual(fakes.calls.listVoteTypes, [], 'a non-director never reads what is configured');
    assert.deepEqual(fakes.calls.listCandidateProposals, []);
    assert.ok(!JSON.stringify(result.details).includes(CONTACT));
  }
});

test('poll candidates rejects an impersonation or policy argument and never reads for it', async () => {
  for (const [args, code] of [
    [{ voteType: VOTE_TYPE, requesterSenderId: 'U_FAKE' }, 'actor_argument_rejected'],
    [{ voteType: VOTE_TYPE, isDirector: true }, 'actor_argument_rejected'],
    [{ voteType: VOTE_TYPE, voterContactId: CONTACT }, 'actor_argument_rejected'],
    [{ voteType: VOTE_TYPE, candidateIds: [PROPOSAL_ID_A] }, 'policy_argument_rejected'],
    [{ voteType: VOTE_TYPE, maxCandidates: 99 }, 'policy_argument_rejected'],
    [{ voteType: VOTE_TYPE, status: 'submitted' }, 'policy_argument_rejected'],
  ]) {
    const fakes = createFakeWriter();
    const readerFake = createFakeReader();
    const { tool, guard } = build({ reader: readerFake.reader, writer: fakes.writer });
    const result = await tool('rein_poll_candidates').execute('call-1', args);

    assert.equal(result.details.ok, false, JSON.stringify(args));
    assert.equal(result.details.error, code);
    assert.deepEqual(readerFake.calls.member, [], 'the argument is refused before any identity read');
    assert.deepEqual(fakes.calls.listCandidateProposals, []);
    assert.equal(guard.calls, 0);
  }
});

test('poll candidates refuses a malformed page, instant or identifier set before any read', async () => {
  for (const [args, code] of [
    [{ voteType: VOTE_TYPE, limit: 0 }, 'candidate_limit_invalid'],
    [{ voteType: VOTE_TYPE, limit: 201 }, 'candidate_limit_invalid'],
    [{ voteType: VOTE_TYPE, limit: 1.5 }, 'candidate_limit_invalid'],
    [{ voteType: VOTE_TYPE, limit: '50' }, 'candidate_limit_invalid'],
    [{ voteType: VOTE_TYPE, submittedSince: 'soon' }, 'submitted_since_invalid'],
    [{ voteType: VOTE_TYPE, excludeProposalIds: ['not-a-uuid'] }, 'candidate_exclude_ids_invalid'],
    [{ voteType: VOTE_TYPE, excludeProposalIds: 'all' }, 'candidate_exclude_ids_invalid'],
    [{ voteType: VOTE_TYPE, includeRecentlyUnselected: 'yes' }, 'candidate_buckets_invalid'],
  ]) {
    const fakes = createFakeWriter();
    const { tool, guard } = build({ reader: createFakeReader().reader, writer: fakes.writer });
    const result = await tool('rein_poll_candidates').execute('call-1', args);

    assert.equal(result.details.ok, false, JSON.stringify(args));
    assert.equal(result.details.error, code);
    assert.deepEqual(fakes.calls.listCandidateProposals, [], 'a malformed filter reads no pool');
    assert.equal(guard.calls, 0);
  }
});

test('a missing or stale host invocation guard produces no candidate answer', async () => {
  const missing = await build({
    reader: createFakeReader().reader,
    writer: createFakeWriter().writer,
    ctx: { assertInvocationCurrent: undefined },
  })
    .tool('rein_poll_candidates')
    .execute('call-1', { voteType: VOTE_TYPE });
  assert.equal(missing.details.ok, false);
  assert.equal(missing.details.error, 'current_invocation_guard_unavailable');
  assert.equal(missing.details.candidateCount, undefined, 'a guarded answer names no count');

  const stale = await build({
    reader: createFakeReader().reader,
    writer: createFakeWriter().writer,
    ctx: {
      assertInvocationCurrent() {
        throw Object.assign(new Error('turn closed'), { code: 'invocation_not_current' });
      },
    },
  })
    .tool('rein_poll_candidates')
    .execute('call-1', { voteType: VOTE_TYPE });
  assert.equal(stale.details.ok, false);
  assert.equal(stale.details.error, 'invocation_not_current');
  assert.equal(stale.details.candidates, undefined);
});

test('a reader with no candidate source reports the source as unavailable, never an empty pool', async () => {
  const { tool } = build({ reader: createFakeReader().reader });

  const result = await tool('rein_poll_candidates').execute('call-1', { voteType: VOTE_TYPE });

  assert.equal(result.details.ok, false);
  assert.equal(result.details.error, 'candidate_source_unavailable');
  assert.equal(result.details.candidateCount, undefined);
  assert.ok(!result.content[0].text.includes('[]'));
});

// ---------------------------------------------------------------------------------------------
// `rein_vote_type_resolve`
// ---------------------------------------------------------------------------------------------

// Operator-authored vocabulary only. Nothing in the tool or the matcher knows any of these words.
const LABELS = Object.freeze({
  event_single: { displayName: 'Single event', aliases: ['one-off', 'solo'] },
  event_pair: { displayName: 'Paired event' },
});
const labelConfig = (labels = LABELS) => ({ ...baseConfig, voteTypeAliases: labels });

/** A board channel caller that is a current director, plus a proposal channel Contributor caller. */
const labelReader = ({ member = memberResult() } = {}) => createFakeReader({ member }).reader;

function labelBuild({ config = labelConfig(), writer, ctx = {}, member, reader } = {}) {
  return build({ config, reader: reader ?? labelReader({ member }), writer, ctx });
}

test('resolve returns the one configured type for a display name or an alias, after normalization', async () => {
  for (const [phrase, expected] of [
    ['Single event', 'event_single'],
    ['  single   event  ', 'event_single'],
    ['SINGLE EVENT', 'event_single'],
    ['One-Off', 'event_single'],
    ['solo', 'event_single'],
    ['Paired event', 'event_pair'],
  ]) {
    const fakes = createFakeWriter({ voteTypes: ['event_single', 'event_pair'] });
    const { tool, guard } = labelBuild({ writer: fakes.writer });

    const result = await tool('rein_vote_type_resolve').execute('call-1', { phrase });

    assert.equal(result.details.ok, true, phrase);
    assert.equal(result.details.status, 'resolved');
    assert.equal(result.details.voteType, expected);
    assert.equal(result.details.displayName, expected === 'event_single' ? 'Single event' : 'Paired event');
    assert.equal(result.details.authorizesSpending, false);
    // The stored type table is the only authority that may confirm the code, and it is read once.
    assert.deepEqual(fakes.calls.listVoteTypes, [{ limit: 200 }]);
    assert.deepEqual(fakes.calls.listCandidateProposals, [], 'resolving a name reads no candidate pool');
    assert.equal(result.details.candidateCount, undefined, 'a resolved name reports no candidate count');
    assert.ok(!result.content[0].text.includes('candidateCount'));
    assert.equal(guard.calls, 1);
  }
});

test('resolve works from both approved audiences with the standing that channel requires', async () => {
  // A Board channel requires a current director, and the same person resolves there.
  const board = labelBuild({ writer: createFakeWriter({ voteTypes: ['event_single'] }).writer });
  const fromBoard = await board.tool('rein_vote_type_resolve').execute('call-1', { phrase: 'solo' });
  assert.equal(fromBoard.details.status, 'resolved');

  // A proposal channel requires an active Contributor; a contributor who is not a director resolves.
  const contributor = memberResult({ isDirector: false });
  const proposal = labelBuild({
    writer: createFakeWriter({ voteTypes: ['event_single'] }).writer,
    ctx: { nativeChannelId: PROPOSAL_CHANNEL },
    member: contributor,
  });
  const fromProposal = await proposal.tool('rein_vote_type_resolve').execute('call-1', { phrase: 'solo' });
  assert.equal(fromProposal.details.status, 'resolved');
  assert.equal(fromProposal.details.voteType, 'event_single');
});

test('resolve reports an ambiguous phrase with both operator names and no chosen type', async () => {
  const ambiguous = labelConfig({
    event_single: { displayName: 'Single event', aliases: ['events'] },
    event_pair: { displayName: 'Paired event', aliases: ['events'] },
  });
  for (const phrase of ['events', 'EVENTS', '  events ']) {
    const fakes = createFakeWriter({ voteTypes: ['event_single', 'event_pair'] });
    const { tool, guard } = labelBuild({ config: ambiguous, writer: fakes.writer });

    const result = await tool('rein_vote_type_resolve').execute('call-1', { phrase });

    assert.equal(result.details.ok, true, phrase);
    assert.equal(result.details.status, 'ambiguous');
    assert.equal(result.details.chosenVoteType, null, 'an ambiguity chooses nothing');
    assert.equal(result.details.voteType, undefined, 'no type code is handed back');
    assert.deepEqual(result.details.matches, [
      { voteType: 'event_single', displayName: 'Single event' },
      { voteType: 'event_pair', displayName: 'Paired event' },
    ]);
    assert.equal(result.details.nextStep, 'ask_the_requester_which_of_these_types_they_mean');
    assert.equal(result.details.authorizesSpending, false);
    // An ambiguity hands back no type at all, so it needs no stored-type read to answer.
    assert.deepEqual(fakes.calls.listVoteTypes, []);
    assert.deepEqual(fakes.calls.listCandidateProposals, []);
    assert.equal(guard.calls, 1);

    // A stale turn is refused even for the answer that never touched the database.
    const stale = await labelBuild({
      config: ambiguous,
      writer: createFakeWriter().writer,
      ctx: {
        assertInvocationCurrent() {
          throw Object.assign(new Error('turn closed'), { code: 'invocation_not_current' });
        },
      },
    })
      .tool('rein_vote_type_resolve')
      .execute('call-1', { phrase });
    assert.equal(stale.details.ok, false);
    assert.equal(stale.details.error, 'invocation_not_current');
    assert.equal(stale.details.matches, undefined);
  }
});

test('resolve reports an unmapped phrase with the operator own names instead of guessing', async () => {
  const fakes = createFakeWriter({ voteTypes: ['event_single', 'event_pair', 'unlabelled_type'] });
  const { tool } = labelBuild({ writer: fakes.writer });

  const result = await tool('rein_vote_type_resolve').execute('call-1', { phrase: 'activity' });

  assert.equal(result.details.ok, true);
  assert.equal(result.details.status, 'unmapped');
  assert.equal(result.details.chosenVoteType, null);
  assert.equal(result.details.voteType, undefined);
  assert.deepEqual(result.details.configuredTypes, [
    { voteType: 'event_single', displayName: 'Single event' },
    { voteType: 'event_pair', displayName: 'Paired event' },
    // The operator wrote no name for this stored type; the caller asks rather than inventing one.
    { voteType: 'unlabelled_type', displayName: null },
  ]);
  assert.equal(result.details.nextStep, 'ask_the_requester_which_configured_type_they_mean');
  assert.equal(result.details.authorizesSpending, false);
  assert.deepEqual(fakes.calls.listVoteTypes, [{ limit: 200 }]);
  assert.deepEqual(fakes.calls.listCandidateProposals, []);
  assert.equal(result.details.candidateCount, undefined);
});

test('resolve carries no built-in vocabulary: an operator label decides, a bare type code never does', async () => {
  // A member writing the category in their own language resolves only because an operator wrote it.
  const category = '\u6d3b\u52a8\u7c7b';
  const fakes = createFakeWriter({ voteTypes: ['event_single', 'event_pair'] });
  const { tool } = labelBuild({
    config: labelConfig({ event_single: { displayName: category } }),
    writer: fakes.writer,
  });

  const spoken = await tool('rein_vote_type_resolve').execute('call-1', { phrase: category });
  assert.equal(spoken.details.status, 'resolved');
  assert.equal(spoken.details.voteType, 'event_single');

  // The same tool with no configured label resolves nothing, not even the stored code itself.
  const bare = await labelBuild({ config: baseConfig, writer: fakes.writer })
    .tool('rein_vote_type_resolve')
    .execute('call-1', { phrase: 'event_single' });
  assert.equal(bare.details.status, 'unmapped');
  assert.equal(bare.details.voteType, undefined);

  // And with no operator vocabulary at all, the category phrase stays unmapped.
  const unconfigured = await labelBuild({ config: baseConfig, writer: fakes.writer })
    .tool('rein_vote_type_resolve')
    .execute('call-1', { phrase: category });
  assert.equal(unconfigured.details.status, 'unmapped');
  assert.equal(unconfigured.details.voteType, undefined);
  assert.deepEqual(unconfigured.details.configuredTypes.map(entry => entry.voteType), [
    'event_single', 'event_pair',
  ]);
});

test('a configured name pointing at a type the operator never stored is refused, not handed back', async () => {
  const fakes = createFakeWriter({ voteTypes: ['event_pair'] });
  const { tool } = labelBuild({
    config: labelConfig({ event_single: { displayName: 'Single event' } }),
    writer: fakes.writer,
  });

  const result = await tool('rein_vote_type_resolve').execute('call-1', { phrase: 'single event' });

  assert.equal(result.details.ok, false);
  assert.equal(result.details.error, 'vote_type_alias_not_configured');
  assert.equal(result.details.voteType, 'event_single');
  assert.equal(result.details.displayName, 'Single event');
  assert.deepEqual(result.details.configuredVoteTypes, ['event_pair']);
  assert.equal(result.details.nextStep, 'ask_an_operator_to_configure_the_vote_type');
  assert.deepEqual(fakes.calls.listCandidateProposals, []);
});

test('an unreadable stored type table is an outage, never an empty configuration', async () => {
  for (const phrase of ['single event', 'activity']) {
    const down = createFakeWriter({
      inserts: {
        listVoteTypes: () => ({ ok: false, status: 'unavailable', reason: 'http_error', voteTypes: null, httpStatus: 503 }),
      },
    });
    const { tool } = labelBuild({ writer: down.writer });

    const result = await tool('rein_vote_type_resolve').execute('call-1', { phrase });

    assert.equal(result.details.ok, false, phrase);
    assert.equal(result.details.error, 'vote_type_configuration_unavailable');
    assert.notEqual(result.details.error, 'unmapped');
    assert.equal(result.details.voteType, undefined);
    assert.equal(result.details.configuredTypes, undefined, 'an outage names no configured type');
    assert.deepEqual(down.calls.listCandidateProposals, []);
  }
});

test('resolve refuses a caller with no type source rather than answering from configuration alone', async () => {
  const { tool } = build({ config: labelConfig(), reader: labelReader() });
  const result = await tool('rein_vote_type_resolve').execute('call-1', { phrase: 'single event' });
  assert.equal(result.details.ok, false);
  assert.equal(result.details.error, 'vote_type_source_unavailable');
  assert.equal(result.details.voteType, undefined);
});

test('resolve is limited to the approved channels and to the standing each one requires', async () => {
  // Channel, platform and sender come from host context only, and are checked before any read.
  for (const [overrides, code] of [
    [{ nativeChannelId: 'C_OTHER' }, 'channel_out_of_scope'],
    [{ nativeChannelId: undefined }, 'channel_out_of_scope'],
    [{ requesterSenderId: '   ' }, 'trusted_requester_unavailable'],
    [{ messageChannel: 'discord' }, 'platform_out_of_scope'],
  ]) {
    const fakes = createFakeWriter();
    const readerFake = createFakeReader();
    const { tool, guard } = labelBuild({ writer: fakes.writer, reader: readerFake.reader, ctx: overrides });

    const result = await tool('rein_vote_type_resolve').execute('call-1', { phrase: 'single event' });

    assert.equal(result.details.ok, false, code);
    assert.equal(result.details.error, code);
    assert.deepEqual(readerFake.calls.member, [], 'a refused caller never resolves an identity');
    assert.deepEqual(fakes.calls.listVoteTypes, [], 'a refused caller never reads the stored types');
    assert.ok(!JSON.stringify(result.details).includes('Single event'), 'no operator label leaks to a refusal');
    assert.equal(guard.calls, 0);
  }

  // A Board channel needs a current director; a proposal channel needs an active Contributor.
  for (const [overrides, member, code] of [
    [{}, memberResult({ isDirector: false }), 'board_membership_required'],
    [{}, memberResult({ status: 'unavailable', reason: 'transport_error', contactId: null, isActiveContributor: false, isDirector: false }), 'identity_check_unavailable'],
    [{ nativeChannelId: PROPOSAL_CHANNEL }, memberResult({ isActiveContributor: false, isDirector: true }), 'contributor_status_required'],
    [{ nativeChannelId: PROPOSAL_CHANNEL }, memberResult({ status: 'identity_link_revoked', reason: 'identity_link_revoked', contactId: null, isActiveContributor: false, isDirector: false }), 'identity_link_required'],
    [{ nativeChannelId: PROPOSAL_CHANNEL }, memberResult({ status: 'unavailable', reason: 'transport_error', contactId: null, isActiveContributor: false, isDirector: false }), 'identity_check_unavailable'],
  ]) {
    const fakes = createFakeWriter();
    const { tool, guard } = labelBuild({ writer: fakes.writer, member, ctx: overrides });

    const result = await tool('rein_vote_type_resolve').execute('call-1', { phrase: 'single event' });

    assert.equal(result.details.ok, false, code);
    assert.equal(result.details.error, code);
    assert.deepEqual(fakes.calls.listVoteTypes, [], 'a refused caller never reads the stored types');
    assert.equal(guard.calls, 0);
    assert.ok(!JSON.stringify(result.details).includes(CONTACT));
  }
});

test('resolve rejects an impersonation or policy argument and never reads for it', async () => {
  for (const [args, code] of [
    [{ phrase: 'single event', requesterSenderId: 'U_FAKE' }, 'actor_argument_rejected'],
    [{ phrase: 'single event', isDirector: true }, 'actor_argument_rejected'],
    [{ phrase: 'single event', voterContactId: CONTACT }, 'actor_argument_rejected'],
    [{ phrase: 'single event', candidateIds: [PROPOSAL_ID_A] }, 'policy_argument_rejected'],
    [{ phrase: 'single event', maxCandidates: 2 }, 'policy_argument_rejected'],
    [{ phrase: 'single event', status: 'submitted' }, 'policy_argument_rejected'],
  ]) {
    const fakes = createFakeWriter();
    const readerFake = createFakeReader();
    const { tool, guard } = labelBuild({ writer: fakes.writer, reader: readerFake.reader });

    const result = await tool('rein_vote_type_resolve').execute('call-1', args);

    assert.equal(result.details.ok, false, JSON.stringify(args));
    assert.equal(result.details.error, code);
    assert.deepEqual(readerFake.calls.member, [], 'the argument is refused before any identity read');
    assert.deepEqual(fakes.calls.listVoteTypes, []);
    assert.equal(guard.calls, 0);
  }
});

test('resolve refuses a phrase that is not usable text before any read', async () => {
  for (const args of [{}, { phrase: '   ' }, { phrase: 42 }, { phrase: '\u3000\n' }, { phrase: 'x'.repeat(201) }]) {
    const fakes = createFakeWriter();
    const readerFake = createFakeReader();
    const { tool, guard } = labelBuild({ writer: fakes.writer, reader: readerFake.reader });

    const result = await tool('rein_vote_type_resolve').execute('call-1', args);

    assert.equal(result.details.ok, false, JSON.stringify(args));
    assert.equal(result.details.error, 'vote_type_phrase_invalid');
    assert.deepEqual(readerFake.calls.member, []);
    assert.deepEqual(fakes.calls.listVoteTypes, []);
    assert.equal(guard.calls, 0);
  }
});

test('a missing or stale host invocation guard produces no resolution', async () => {
  const missing = await labelBuild({
    writer: createFakeWriter().writer,
    ctx: { assertInvocationCurrent: undefined },
  })
    .tool('rein_vote_type_resolve')
    .execute('call-1', { phrase: 'single event' });
  assert.equal(missing.details.ok, false);
  assert.equal(missing.details.error, 'current_invocation_guard_unavailable');
  assert.equal(missing.details.voteType, undefined, 'a guarded answer names no type');

  const stale = await labelBuild({
    writer: createFakeWriter().writer,
    ctx: {
      assertInvocationCurrent() {
        throw Object.assign(new Error('turn closed'), { code: 'invocation_not_current' });
      },
    },
  })
    .tool('rein_vote_type_resolve')
    .execute('call-1', { phrase: 'single event' });
  assert.equal(stale.details.ok, false);
  assert.equal(stale.details.error, 'invocation_not_current');
  assert.equal(stale.details.voteType, undefined);
});

test('phrase normalization is conservative: whitespace and case fold, punctuation never does', () => {
  assert.equal(normalizeVoteTypePhrase('  Single\t\n Event  '), 'single event');
  assert.equal(normalizeVoteTypePhrase('SINGLE EVENT'), 'single event');
  // Full-width forms compose to their ASCII shape under NFKC; nothing else is rewritten.
  assert.equal(normalizeVoteTypePhrase('\uff33\uff49\uff4e\uff47\uff4c\uff45 \uff25\uff56\uff45\uff4e\uff54'), 'single event');
  assert.notEqual(normalizeVoteTypePhrase('single-event'), normalizeVoteTypePhrase('single event'));
  assert.notEqual(normalizeVoteTypePhrase('event\u3000single'), normalizeVoteTypePhrase('event_single'));

  const labels = parseVoteTypeLabelConfig({ event_single: { displayName: 'Single event', aliases: ['one-off'] } });
  assert.equal(resolveVoteTypePhrase('', labels).status, 'invalid');
  assert.equal(resolveVoteTypePhrase('   ', labels).status, 'invalid');
  assert.equal(resolveVoteTypePhrase(42, labels).status, 'invalid');
  assert.equal(resolveVoteTypePhrase('single-event', labels).status, 'unmapped');
  assert.deepEqual(parseVoteTypeLabelConfig(undefined), []);
  assert.deepEqual(parseVoteTypeLabelConfig(null), []);
});

test('an enabled block with a malformed voteTypeAliases map fails loudly at registration', async () => {
  for (const [labels, expected] of [
    [[], /voteTypeAliases: must be an object keyed by configured vote type code/],
    ['Single event', /voteTypeAliases: must be an object keyed by configured vote type code/],
    [{ EventSingle: { displayName: 'Single event' } }, /"EventSingle" must be one lower snake case vote type/],
    [{ event_single: 'Single event' }, /event_single must be an object with a displayName/],
    [{ event_single: {} }, /event_single must carry a displayName/],
    [{ event_single: { displayName: '   ' } }, /event_single\.displayName must not be empty/],
    [{ event_single: { displayName: 'x'.repeat(121) } }, /event_single\.displayName must be at most 120 characters/],
    [{ event_single: { displayName: 'Single event', extra: true } }, /event_single\.extra is not read/],
    [{ event_single: { displayName: 'Single event', aliases: 'solo' } }, /event_single\.aliases must be an array of names/],
    [{ event_single: { displayName: 'Single event', aliases: [''] } }, /event_single\.aliases\[0\] must not be empty/],
    [{ event_single: { displayName: 'Single event', aliases: Array.from({ length: 33 }, (_, i) => `a${i}`) } }, /event_single\.aliases must list at most 32 names/],
  ]) {
    assert.throws(
      () => createMvpReadToolRegistration({ config: labelConfig(labels), reader: labelReader() }),
      error => error.code === 'foundation_db_config_invalid' && expected.test(error.message),
      `expected a loud config failure for ${JSON.stringify(labels)}`,
    );
  }
  // An absent or explicitly null block is not an error: it simply resolves nothing.
  for (const labels of [undefined, null]) {
    const registration = createMvpReadToolRegistration({
      config: labels === undefined ? baseConfig : { ...baseConfig, voteTypeAliases: labels },
      reader: labelReader(),
    });
    assert.deepEqual(registration.create({
      messageChannel: 'slack',
      nativeChannelId: BOARD_CHANNEL,
      requesterSenderId: SENDER,
      assertInvocationCurrent() {},
    }).map(tool => tool.name), [...MVP_READ_TOOL_NAMES]);
  }
});

test('an injected writer needs no environment and never reaches a database on its own', async () => {
  const fakes = createFakeWriter({ voteTypes: ['event_single'], candidates: [candidateProposal()] });
  const { tool } = build({ reader: createFakeReader().reader, writer: fakes.writer });

  const listed = await tool('rein_poll_candidates').execute('call-1', { voteType: VOTE_TYPE });
  assert.equal(listed.details.ok, true);
  assert.equal(listed.details.candidateCount, 1);
  assert.deepEqual(fakes.calls.listVoteTypes, [{ limit: 200 }]);
  assert.deepEqual(fakes.calls.listCandidateProposals, [
    { voteType: VOTE_TYPE, limit: 50, includeRecentlyUnselected: false },
  ]);
});

test('an injected writer that is missing a read method fails the configuration loudly', () => {
  assert.throws(
    () => createMvpReadToolRegistration({
      config: baseConfig,
      reader: createFakeReader().reader,
      writer: { listVoteTypes: async () => ({ ok: true, status: 'found', reason: 'vote_types', voteTypes: [], httpStatus: 200 }) },
    }),
    /the injected writer must implement listVoteTypes and listCandidateProposals/,
  );
});
