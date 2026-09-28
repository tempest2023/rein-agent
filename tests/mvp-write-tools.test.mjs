import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MVP_WRITE_TOOL_NAMES,
  createMvpWriteToolRegistration,
} from '../plugins/rein-operations/mvp-write-tools.ts';
import {
  MAX_CONFIRMATION_DOCUMENT_BYTES,
  MAX_CONFIRMATION_TOKEN_LENGTH,
  maxDocumentBytesForToken,
  issueProposalConfirmation,
  verifyProposalConfirmation,
} from '../plugins/rein-operations/mvp-proposal-confirmation.ts';

// Focused fake-reader and fake-writer tests for the two wiring paths this slice implements:
// `rein_governance_proposal_submit` and `rein_poll_open`. No live database or Slack call is made. The
// fakes record every argument, so each test also proves which calls a refusal avoided, and the
// scripted writer decides what the stored database would have answered.

const TEAM = 'T0123456ABC';
const PROPOSAL_CHANNEL = 'C_PROPOSAL';
const BOARD_CHANNEL = 'C_BOARD';
const SENDER = 'U0123456ABC';
const CONTACT = '11111111-1111-4111-8111-111111111111';
const OTHER_CONTACT = '22222222-2222-4222-8222-222222222222';
const POLL = '33333333-3333-4333-8333-333333333333';
const CANDIDATE_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const CANDIDATE_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const CANDIDATE_C = 'cccccccc-3333-4333-8333-333333333333';
const CANDIDATE_D = 'dddddddd-4444-4444-8444-444444444444';
const VOTE_TYPE = 'event_budget';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const URL_ENV = 'REIN_SUPABASE_URL';
const KEY_ENV = 'REIN_SUPABASE_SERVICE_ROLE_KEY';
const CONFIRM_ENV = 'REIN_PROPOSAL_CONFIRMATION_KEY';
const SECRET = 'sb_secret_unit_test_0000000000000000';
const BOT_TOKEN_ENV = 'REIN_SLACK_BOT_TOKEN';
const BOT_TOKEN = 'xoxb-unit-test-0000000000000001';
// A distinct server-only signing key for the proposal confirmation token. The rehearsal injects it
// directly, so no real credential is read from the ambient environment.
const CONFIRM_KEY = 'unit-test-proposal-confirmation-signing-key-0001';
const OPENS_AT = '2026-09-24T10:00:00.000Z';
const CLOSES_AT = '2026-09-24T11:00:00.000Z';
const NOW = '2026-09-24T10:30:00.000Z';

const baseConfig = Object.freeze({
  enabled: true,
  platform: 'slack',
  slackTeamId: TEAM,
  environment: 'dev',
  proposalChannelIds: [PROPOSAL_CHANNEL],
  boardChannelIds: [BOARD_CHANNEL],
  supabaseUrlEnvVar: URL_ENV,
  supabaseServiceKeyEnvVar: KEY_ENV,
  proposalConfirmationKeyEnvVar: CONFIRM_ENV,
});

const contributor = (overrides = {}) => ({
  status: 'resolved',
  reason: 'resolved',
  contactId: CONTACT,
  isActiveContributor: true,
  isDirector: false,
  httpStatus: null,
  ...overrides,
});

const director = (overrides = {}) => contributor({ isDirector: true, ...overrides });

/** The operator-configured rule of one vote type, as `getVoteType` returns it. */
const voteTypeRule = (overrides = {}) => ({
  voteType: VOTE_TYPE,
  maxCandidates: 3,
  maxApprovalsPerVoter: 1,
  updatedAt: OPENS_AT,
  ...overrides,
});

/** One stored proposal, as `listCandidateProposals` returns it. */
const candidateRecord = (id, overrides = {}) => ({
  id,
  proposerContactId: CONTACT,
  title: `Stored request ${id.slice(0, 4)}`,
  summary: null,
  voteType: VOTE_TYPE,
  requestedMinor: null,
  currency: null,
  status: 'submitted',
  createdAt: OPENS_AT,
  ...overrides,
});

const pollRecord = (overrides = {}) => ({
  id: POLL,
  creatorContactId: CONTACT,
  title: 'Fund the repair workshop?',
  voteType: VOTE_TYPE,
  candidateProposalIds: [CANDIDATE_A, CANDIDATE_B],
  candidateLimit: 3,
  maxApprovalsPerVoter: 1,
  status: 'open',
  opensAt: OPENS_AT,
  closesAt: CLOSES_AT,
  createdAt: OPENS_AT,
  ...overrides,
});

/**
 * One recorded finalization, as `finalizePoll` returns it. The outcome and the approvals are the
 * database's; `winner` is the only difference between a winner and a no-winner round.
 */
const finalizeRecord = ({ outcome = 'winner', winner = CANDIDATE_A, ...overrides } = {}) => ({
  pollId: POLL,
  status: 'closed',
  repeated: false,
  outcome,
  winningProposalId: winner,
  finalizedByContactId: CONTACT,
  candidates: [CANDIDATE_A, CANDIDATE_B],
  proposalsRecorded: 1,
  ballots: 2,
  abstentions: 0,
  approvals: [{ proposalId: winner ?? CANDIDATE_A, approvals: 1 }],
  ...overrides,
});

const storedProposal = (input) => ({
  id: input.id,
  proposerContactId: input.proposerContactId,
  title: input.title,
  summary: input.summary ?? null,
  voteType: input.voteType,
  requestedMinor: input.requestedMinor ?? null,
  currency: input.currency ?? null,
  status: 'submitted',
  createdAt: OPENS_AT,
});

function createFakes({
  member = contributor(),
  poll = pollRecord(),
  ballots = [],
  rule = voteTypeRule(),
  configuredVoteTypes = [VOTE_TYPE],
  candidates = [candidateRecord(CANDIDATE_A), candidateRecord(CANDIDATE_B)],
  // The stored proposal rows a title read answers from, by default the pool records themselves.
  proposals = candidates,
  inserts,
} = {}) {
  const calls = {
    member: [],
    submitProposal: [],
    createPoll: [],
    castBallot: [],
    getPoll: [],
    getProposal: [],
    listBallots: [],
    getVoteType: [],
    listVoteTypes: [],
    listCandidateProposals: [],
    finalizePoll: [],
  };
  const reader = {
    async resolveSlackMember(slackUserId) {
      calls.member.push(slackUserId);
      return member;
    },
  };
  const writer = {
    async submitProposal(input) {
      calls.submitProposal.push(input);
      if (inserts?.submitProposal) return inserts.submitProposal(input);
      return {
        ok: true,
        status: 'inserted',
        reason: 'inserted',
        proposal: storedProposal(input),
        httpStatus: 201,
        authorizesSpending: false,
      };
    },
    async createPoll(input) {
      calls.createPoll.push(input);
      if (inserts?.createPoll) return inserts.createPoll(input);
      return {
        ok: true,
        status: 'inserted',
        reason: 'inserted',
        poll: pollRecord({
          id: input.id,
          creatorContactId: input.creatorContactId,
          title: input.title,
          voteType: input.voteType,
          candidateProposalIds: [...input.candidateProposalIds],
          opensAt: input.opensAt,
          closesAt: input.closesAt,
        }),
        httpStatus: 201,
      };
    },
    async castBallot(input) {
      calls.castBallot.push(input);
      if (inserts?.castBallot) return inserts.castBallot(input);
      return {
        ok: true,
        status: 'inserted',
        reason: 'inserted',
        ballot: {
          pollId: input.pollId,
          voterContactId: input.voterContactId,
          approvedProposalIds: [...(input.approvedProposalIds ?? [])],
        },
        httpStatus: 201,
      };
    },
    async getPoll(id) {
      calls.getPoll.push(id);
      if (!poll) {
        return { ok: false, status: 'rejected', reason: 'poll_not_found', poll: null, httpStatus: null };
      }
      return { ok: true, status: 'found', reason: 'poll', poll, httpStatus: 200 };
    },
    async getProposal(id) {
      calls.getProposal.push(id);
      if (inserts?.getProposal) return inserts.getProposal(id);
      const found = proposals.find(proposal => proposal.id === id);
      if (!found) {
        return { ok: false, status: 'rejected', reason: 'proposal_not_found', proposal: null, httpStatus: 200 };
      }
      return { ok: true, status: 'found', reason: 'proposal', proposal: found, httpStatus: 200 };
    },
    async listBallots(pollId) {
      calls.listBallots.push(pollId);
      return { ok: true, status: 'found', reason: 'ballots', ballots, httpStatus: 200 };
    },
    async getVoteType(voteType) {
      calls.getVoteType.push(voteType);
      if (inserts?.getVoteType) return inserts.getVoteType(voteType);
      if (voteType !== rule.voteType) {
        return { ok: false, status: 'rejected', reason: 'vote_type_not_found', voteType: null, httpStatus: 200 };
      }
      return { ok: true, status: 'found', reason: 'vote_type', voteType: rule, httpStatus: 200 };
    },
    async listVoteTypes(input = {}) {
      calls.listVoteTypes.push(input);
      if (inserts?.listVoteTypes) return inserts.listVoteTypes(input);
      return { ok: true, status: 'found', reason: 'vote_types', voteTypes: configuredVoteTypes, httpStatus: 200 };
    },
    async listCandidateProposals(input) {
      calls.listCandidateProposals.push(input);
      if (inserts?.listCandidateProposals) return inserts.listCandidateProposals(input);
      return { ok: true, status: 'found', reason: 'candidates', proposals: candidates, httpStatus: 200 };
    },
    async finalizePoll(input) {
      calls.finalizePoll.push(input);
      if (inserts?.finalizePoll) return inserts.finalizePoll(input);
      // The recorded finalization is scripted per test: the database is the only counter, so the
      // fake never derives an outcome from the ballots it holds.
      return {
        ok: true,
        status: 'inserted',
        reason: 'finalized',
        finalization: finalizeRecord(),
        httpStatus: 200,
      };
    },
  };
  return { reader, writer, calls };
}

const CLOCK = { at: new Date(NOW) };

function build({
  config = baseConfig,
  fakes = createFakes(),
  ctx: overrides = {},
  env,
  now,
  // The Board channel is in scope for the Board tools, so it is the default; a proposal test passes
  // the proposal channel explicitly.
  channel = BOARD_CHANNEL,
} = {}) {
  const guard = { calls: 0 };
  const ctx = {
    messageChannel: 'slack',
    nativeChannelId: channel,
    requesterSenderId: SENDER,
    assertInvocationCurrent() {
      guard.calls += 1;
    },
    ...overrides,
  };
  const registration = createMvpWriteToolRegistration({
    config,
    reader: fakes.reader,
    writer: fakes.writer,
    confirmationSigningKey: CONFIRM_KEY,
    env,
    now: now ?? (() => CLOCK.at),
  });
  const tools = registration.create(ctx);
  return {
    registration,
    tools,
    guard,
    ctx,
    calls: fakes.calls,
    tool: name => tools.find(item => item.name === name),
  };
}

/**
 * Prepare a proposal through the real tool and return the token it minted.
 *
 * The host resolves one `create(ctx)` tool factory per inbound turn, and the confirmation gate
 * refuses a token that the very turn that prepared it then echoes back. So a rehearsal that means
 * to store a proposal has to prepare in one turn and confirm in the next, exactly as a conversation
 * does: the proposer is shown the server's canonical prepared text and answers it later. The fakes,
 * clock and signing key stay the same across the two turns because only the turn, and therefore the
 * factory instance, changes.
 */
async function prepareProposal(tool, toolCallId, args, now) {
  const prepared = await tool.execute(toolCallId, args);
  assert.equal(prepared.details.status, 'prepared', JSON.stringify(prepared.details));
  assert.equal(prepared.details.recorded, false);
  if (now) assert.equal(prepared.details.expiresAt, new Date(now.getTime() + 15 * 60 * 1000).toISOString());
  return prepared.details.confirmationToken;
}

/** Confirm a previously prepared token in a fresh turn, as an author-confirmed submit does. */
async function confirmProposal(tool, toolCallId, args, token) {
  return tool.execute(toolCallId, {
    ...args,
    confirmationToken: token,
    confirmPronouncedByAuthor: true,
  });
}

/**
 * Store one proposal the way a two-turn conversation does: prepare in one turn, confirm in the next.
 * `build` returns a fresh factory instance per call, so passing it in gives the confirm phase the
 * later turn the gate requires while keeping the fakes, the clock and the signing key.
 */
async function submitProposal(buildTurn, toolCallId, args, now) {
  const prepared = buildTurn();
  const token = await prepareProposal(prepared.tool('rein_governance_proposal_submit'), toolCallId, args, now);
  const confirmed = buildTurn();
  return await confirmProposal(confirmed.tool('rein_governance_proposal_submit'), toolCallId, args, token);
}

test('no MVP write tool registers without an explicit enabled block', () => {
  for (const config of [undefined, {}, { enabled: false }, { enabled: 'true' }]) {
    const fakes = createFakes();
    const registration = createMvpWriteToolRegistration({ config, reader: fakes.reader, writer: fakes.writer });
    assert.equal(registration.create({ messageChannel: 'slack' }), null);
    assert.equal(registration.contextVersion, 2);
  }
  assert.deepEqual([...MVP_WRITE_TOOL_NAMES], [
    'rein_governance_proposal_submit',
    'rein_poll_open',
    'rein_poll_vote',
    'rein_poll_result',
  ]);
});

test('an enabled but incomplete MVP block fails loudly instead of registering silently', () => {
  const fakes = createFakes();
  const cases = [
    [{ ...baseConfig, platform: 'discord' }, /platform must be "slack"/],
    [{ ...baseConfig, slackTeamId: undefined }, /slackTeamId must be one Slack team ID/],
    [{ ...baseConfig, proposalChannelIds: [] }, /proposalChannelIds must list at least one/],
    [{ ...baseConfig, boardChannelIds: ['  '] }, /boardChannelIds must contain non-empty/],
    [{ ...baseConfig, environment: 'staging' }, /environment must be 'dev' or 'prod'/],
    [{ ...baseConfig, supabaseUrlEnvVar: undefined }, /supabaseUrlEnvVar must name a server environment variable/],
    [{ ...baseConfig, supabaseServiceKeyEnvVar: 'NOT A NAME' }, /supabaseServiceKeyEnvVar must name a server environment variable/],
  ];
  for (const [config, expected] of cases) {
    assert.throws(
      () =>
        createMvpWriteToolRegistration({
          config,
          reader: fakes.reader,
          writer: fakes.writer,
          confirmationSigningKey: CONFIRM_KEY,
        }),
      expected,
    );
  }

  // A writer missing the proposal, poll, vote type, candidate pool or finalize methods is not a
  // writer this slice can call, so registration refuses it instead of failing at the first write.
  for (const missing of [
    'submitProposal',
    'createPoll',
    'getVoteType',
    'listVoteTypes',
    'listCandidateProposals',
    'finalizePoll',
  ]) {
    const partial = { ...fakes.writer, [missing]: undefined };
    assert.throws(
      () =>
        createMvpWriteToolRegistration({
          config: baseConfig,
          reader: fakes.reader,
          writer: partial,
          confirmationSigningKey: CONFIRM_KEY,
        }),
      /must implement submitProposal, createPoll, getPoll, listBallots, castBallot, getVoteType, listVoteTypes, listCandidateProposals and finalizePoll/,
      missing,
    );
  }
});

test('the Supabase key is read from the server environment and never appears in the tools', () => {
  assert.throws(
    () => createMvpWriteToolRegistration({ config: baseConfig, env: {} }),
    error => error.code === 'mvp_env_value_missing' && error.message.includes(URL_ENV),
  );
  assert.throws(
    () => createMvpWriteToolRegistration({ config: baseConfig, env: { [URL_ENV]: 'https://project-ref.supabase.co' } }),
    error => error.code === 'mvp_env_value_missing' && error.message.includes(KEY_ENV),
  );
  // The confirmation signing key is a third server-only secret, read the same way and named only by
  // its environment variable. A deployment missing it fails loudly instead of signing with an
  // accidental default.
  assert.throws(
    () =>
      createMvpWriteToolRegistration({
        config: baseConfig,
        env: { [URL_ENV]: 'https://project-ref.supabase.co', [KEY_ENV]: SECRET },
      }),
    error => error.code === 'mvp_env_value_missing' && error.message.includes(CONFIRM_ENV),
  );

  const registration = createMvpWriteToolRegistration({
    config: baseConfig,
    env: { [URL_ENV]: 'https://project-ref.supabase.co', [KEY_ENV]: SECRET, [CONFIRM_ENV]: CONFIRM_KEY },
  });
  const tools = registration.create({
    messageChannel: 'slack',
    nativeChannelId: BOARD_CHANNEL,
    requesterSenderId: SENDER,
    assertInvocationCurrent() {},
  });
  assert.deepEqual(tools.map(tool => tool.name), [...MVP_WRITE_TOOL_NAMES]);
  assert.ok(!JSON.stringify(tools).includes(SECRET));
  assert.ok(!JSON.stringify(tools).includes(CONFIRM_KEY), 'the confirmation key never appears in a tool');
  assert.ok(!JSON.stringify(tools).includes('project-ref.supabase.co'));
});

test('email identity matching is off by default and an injected reader needs no bot token', () => {
  for (const config of [
    baseConfig,
    { ...baseConfig, identityEmailMatch: 'disabled' },
    { ...baseConfig, identityEmailMatch: 'enabled' },
  ]) {
    const fakes = createFakes();
    const registration = createMvpWriteToolRegistration({
      config,
      reader: fakes.reader,
      writer: fakes.writer,
      confirmationSigningKey: CONFIRM_KEY,
    });
    const tools = registration.create({
      messageChannel: 'slack',
      nativeChannelId: BOARD_CHANNEL,
      requesterSenderId: SENDER,
      assertInvocationCurrent() {},
    });
    assert.deepEqual(tools.map(tool => tool.name), [...MVP_WRITE_TOOL_NAMES]);
  }
});

test('an unknown identityEmailMatch value fails loudly instead of being ignored', () => {
  const fakes = createFakes();
  for (const value of ['yes', 'true', 1]) {
    assert.throws(
      () =>
        createMvpWriteToolRegistration({
          config: { ...baseConfig, identityEmailMatch: value },
          reader: fakes.reader,
          writer: fakes.writer,
          confirmationSigningKey: CONFIRM_KEY,
        }),
      /identityEmailMatch must be "enabled" or "disabled"/,
    );
  }
});

test('enabled email matching names the bot token variable and never echoes its value', () => {
  const fakes = createFakes();
  const enabled = { ...baseConfig, identityEmailMatch: 'enabled' };
  const resolve = (config, env) =>
    createMvpWriteToolRegistration({ config, writer: fakes.writer, confirmationSigningKey: CONFIRM_KEY, env });

  assert.throws(
    () => resolve(enabled, {}),
    /foundationDb\.slackBotTokenEnvVar must name a server environment variable/,
  );
  assert.throws(
    () => resolve({ ...enabled, slackBotTokenEnvVar: 'NOT A NAME' }, {}),
    /foundationDb\.slackBotTokenEnvVar must name a server environment variable/,
  );
  const named = { ...enabled, slackBotTokenEnvVar: BOT_TOKEN_ENV };
  assert.throws(
    () => resolve(named, { [URL_ENV]: 'https://project-ref.supabase.co', [KEY_ENV]: SECRET }),
    error => error.code === 'mvp_env_value_missing' && error.message.includes(BOT_TOKEN_ENV),
  );

  const registration = resolve(named, {
    [URL_ENV]: 'https://project-ref.supabase.co',
    [KEY_ENV]: SECRET,
    [BOT_TOKEN_ENV]: BOT_TOKEN,
  });
  const tools = registration.create({
    messageChannel: 'slack',
    nativeChannelId: BOARD_CHANNEL,
    requesterSenderId: SENDER,
    assertInvocationCurrent() {},
  });
  assert.deepEqual(tools.map(tool => tool.name), [...MVP_WRITE_TOOL_NAMES]);
  assert.ok(!JSON.stringify(tools).includes(BOT_TOKEN), 'the bot token never appears in a tool');
  assert.ok(!JSON.stringify(tools).includes(BOT_TOKEN_ENV), 'the variable name never appears in a tool');
});

test('enabled email matching builds one lookup in this slice and presents the token only as a header', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), headers: init.headers ?? {} });
    if (String(url).startsWith('https://slack.com/')) {
      return new Response(JSON.stringify({ ok: false, error: 'user_not_found' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const fakes = createFakes();
    const registration = createMvpWriteToolRegistration({
      config: { ...baseConfig, identityEmailMatch: 'enabled', slackBotTokenEnvVar: BOT_TOKEN_ENV },
      writer: fakes.writer,
      confirmationSigningKey: CONFIRM_KEY,
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
    const result = await tools
      .find(tool => tool.name === 'rein_poll_vote')
      .execute('call-1', { pollId: POLL });

    // The sender resolves as unlinked, so the ballot is refused before any writer call.
    assert.equal(result.details.error, 'identity_link_required');
    assert.deepEqual(fakes.calls.castBallot, []);
    const slackRequest = requests.find(request => request.url.startsWith('https://slack.com/api/users.info?'));
    assert.ok(slackRequest, 'the enabled email matching must probe the Slack profile');
    assert.equal(slackRequest.headers.authorization, `Bearer ${BOT_TOKEN}`);
    assert.ok(requests.every(request => !request.url.includes(BOT_TOKEN)), 'the token never travels in a URL');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------------------------
// rein_governance_proposal_submit
// ---------------------------------------------------------------------------------------------

test('an active Contributor submits one proposal only after the prepared version is confirmed', async () => {
  const fakes = createFakes();
  const prepareTurn = build({ fakes, channel: PROPOSAL_CHANNEL });
  const { tool, calls } = prepareTurn;
  // The confirming turn is a second factory instance, because the gate refuses a token the turn
  // that minted it then echoes back.
  const confirmingTurn = build({ fakes, channel: PROPOSAL_CHANNEL });
  const guard = confirmingTurn.guard;

  const args = {
    voteType: VOTE_TYPE,
    title: 'Repair workshop',
    summary: 'Fix the roof tiles',
    requestedMinor: 125000,
    currency: 'usd',
  };

  // Phase 1: nothing is written, and the caller gets the canonical text plus one token.
  const prepared = await tool('rein_governance_proposal_submit').execute('call-1', args);
  assert.equal(prepared.details.ok, true);
  assert.equal(prepared.details.status, 'prepared');
  assert.equal(prepared.details.reason, 'awaiting_author_confirmation');
  assert.equal(prepared.details.recorded, false);
  assert.equal(prepared.details.authorizesSpending, false);
  assert.deepEqual(prepared.details.prepared, {
    title: 'Repair workshop',
    summary: 'Fix the roof tiles',
    voteType: VOTE_TYPE,
    requestedMinor: 125000,
    currency: 'USD',
  });
  assert.match(prepared.details.confirmationToken, /^rein_proposal_confirm\.rpc2\./);
  assert.deepEqual(calls.submitProposal, [], 'the prepare phase writes nothing');
  assert.equal(guard.calls, 0, 'no write guard runs when nothing is written');

  // Phase 2: the next turn's author-confirmed call writes one row.
  const result = await confirmProposal(
    confirmingTurn.tool('rein_governance_proposal_submit'),
    'call-1',
    args,
    prepared.details.confirmationToken,
  );

  assert.equal(result.details.status, 'inserted');
  assert.equal(result.details.recorded, true);
  assert.equal(result.details.authorConfirmed, true);
  assert.equal(result.details.authorizesSpending, false);
  // Both turns resolve the trusted sender, and the write uses the record the confirm turn resolved.
  assert.deepEqual(calls.member, [SENDER, SENDER]);
  assert.equal(calls.submitProposal.length, 1);
  const sent = calls.submitProposal[0];
  assert.match(sent.id, UUID_V4, 'the record identifier is a v4-shaped UUID, never an argument');
  assert.equal(sent.proposerContactId, CONTACT, 'the proposer is the resolved sender record');
  assert.equal(sent.voteType, VOTE_TYPE);
  assert.equal(sent.title, 'Repair workshop');
  assert.equal(sent.summary, 'Fix the roof tiles');
  assert.equal(sent.requestedMinor, 125000);
  assert.equal(sent.currency, 'USD', 'a currency code is normalized to upper case');
  assert.equal(result.details.proposalId, sent.id);
  assert.equal(guard.calls, 1, 'the invocation guard runs once before the write');
  assert.ok(!result.content[0].text.includes(CONTACT), 'the private contact id is not returned');
  assert.ok(!result.content[0].text.includes(CONFIRM_KEY), 'the signing key is never returned');
});

test('a retry inside one turn and a repeat of the same confirmed text both meet one record', async () => {
  const fakes = createFakes();
  const args = { voteType: VOTE_TYPE, title: 'Repair workshop' };
  const buildTurn = () => build({ fakes, channel: PROPOSAL_CHANNEL });

  // The proposal is prepared in one turn and confirmed in the next, as the gate requires.
  const token = await prepareProposal(buildTurn().tool('rein_governance_proposal_submit'), 'call-9', args);
  // A host retry of the same confirmed invocation reaches `execute` twice inside the confirming
  // `create(ctx)`, so the retry meets the record the first call just wrote.
  const confirming = buildTurn();
  await confirmProposal(confirming.tool('rein_governance_proposal_submit'), 'call-9', args, token);
  await confirmProposal(confirming.tool('rein_governance_proposal_submit'), 'call-9', args, token);

  assert.equal(fakes.calls.submitProposal.length, 2);
  assert.equal(
    fakes.calls.submitProposal[0].id,
    fakes.calls.submitProposal[1].id,
    'a same-turn retry is stable',
  );

  // A later turn resets the per-turn map, but the identifier comes from the confirmed content, so
  // confirming the same text again still addresses the one row instead of inserting a second one.
  const second = createFakes();
  await submitProposal(() => build({ fakes: second, channel: PROPOSAL_CHANNEL }), 'call-9', args);
  assert.equal(
    fakes.calls.submitProposal[0].id,
    second.calls.submitProposal[0].id,
    'the same confirmed text is the same record across turns',
  );
});

test('the record identifier follows the confirmed content and the proposer', async () => {
  const sameActor = createFakes();
  const otherActor = createFakes({ member: contributor({ contactId: OTHER_CONTACT }) });
  const args = { voteType: VOTE_TYPE, title: 'Repair workshop' };
  await submitProposal(
    () => build({ fakes: sameActor, channel: PROPOSAL_CHANNEL }),
    'call-9',
    args,
  );
  await submitProposal(
    () => build({ fakes: otherActor, channel: PROPOSAL_CHANNEL }),
    'call-9',
    { voteType: VOTE_TYPE, title: 'Another title' },
  );
  assert.notEqual(sameActor.calls.submitProposal[0].id, otherActor.calls.submitProposal[0].id);

  // Two distinct confirmed texts from one proposer are two records, not a collision.
  const changed = createFakes();
  await submitProposal(
    () => build({ fakes: changed, channel: PROPOSAL_CHANNEL }),
    'call-9',
    { voteType: VOTE_TYPE, title: 'A different repair workshop' },
  );
  assert.notEqual(sameActor.calls.submitProposal[0].id, changed.calls.submitProposal[0].id);
});

test('the proposal tool refuses an unlinked, inactive or non-Contributor sender without writing', async () => {
  const refusal = async (member) => {
    const fakes = createFakes({ member });
    const { tool, calls, guard } = build({ fakes, channel: PROPOSAL_CHANNEL });
    const result = await tool('rein_governance_proposal_submit').execute('call-1', {
      voteType: VOTE_TYPE,
      title: 'Repair workshop',
    });
    assert.equal(result.details.ok, false);
    assert.deepEqual(calls.submitProposal, [], 'a refused sender must not reach the database');
    assert.equal(guard.calls, 0);
    return result;
  };

  assert.equal(
    (await refusal(contributor({ status: 'identity_not_linked', reason: 'identity_not_linked', contactId: null, isActiveContributor: false }))).details.error,
    'identity_link_required',
  );
  assert.equal(
    (await refusal(contributor({ status: 'identity_link_revoked', reason: 'identity_link_revoked', contactId: null, isActiveContributor: false }))).details.error,
    'identity_link_required',
  );
  assert.equal(
    (await refusal(contributor({ isActiveContributor: false }))).details.error,
    'contributor_status_required',
  );
  assert.equal(
    (await refusal(director({ isActiveContributor: false }))).details.error,
    'contributor_status_required',
    'a director without an active Contributor record cannot submit',
  );
  assert.equal(
    (await refusal(contributor({ status: 'unavailable', reason: 'transport_error', contactId: null, isActiveContributor: false }))).details.error,
    'identity_check_unavailable',
    'a failed lookup is reported as an unavailable identity check, not as an unlinked account',
  );
});

test('the proposal tool is limited to the approved proposal channels and ignores a Board channel', async () => {
  const fakes = createFakes();
  const { tool, calls } = build({ fakes, ctx: { nativeChannelId: BOARD_CHANNEL } });
  const result = await tool('rein_governance_proposal_submit').execute('call-1', {
    voteType: VOTE_TYPE,
    title: 'Repair workshop',
  });
  assert.equal(result.details.error, 'channel_out_of_scope');
  assert.deepEqual(calls.member, [], 'a refused channel is rejected before the identity lookup');
  assert.deepEqual(calls.submitProposal, []);
});

test('the proposal tool requires a lower snake case vote type without writing', async () => {
  for (const voteType of [undefined, '', 'Event Budget', 'event-budget', '1event', 'eventBudget', 7]) {
    const fakes = createFakes();
    const { tool, calls, guard } = build({ fakes, channel: PROPOSAL_CHANNEL });
    const result = await tool('rein_governance_proposal_submit').execute('call-1', { voteType, title: 'Repair workshop' });
    assert.equal(result.details.ok, false, String(voteType));
    assert.equal(result.details.error, 'vote_type_invalid', String(voteType));
    // The configured type list is the first read on this path, so a malformed name is refused before
    // the identity lookup ever runs; no proposal is stored either way.
    assert.deepEqual(calls.listVoteTypes, [{ limit: 200 }], String(voteType));
    assert.deepEqual(calls.submitProposal, [], 'an unusable vote type is never stored');
    assert.equal(guard.calls, 0);
  }
});

test('a well-formed but unconfigured proposal type is refused by name against the stored list', async () => {
  // `event` is exactly the case-2 shape: a legal lower snake case name with no row in the operator's
  // type table. The tool reports the names that do exist instead of guessing a substitute.
  const fakes = createFakes({ configuredVoteTypes: ['event_pair', 'event_single'] });
  const { tool, calls, guard } = build({ fakes, channel: PROPOSAL_CHANNEL });

  const result = await tool('rein_governance_proposal_submit').execute('call-1', {
    voteType: 'event',
    title: 'Free campus discussion',
  });

  assert.equal(result.details.ok, false);
  assert.equal(result.details.error, 'vote_type_not_configured');
  assert.equal(result.details.voteType, 'event');
  assert.deepEqual(result.details.configuredVoteTypes, ['event_pair', 'event_single']);
  assert.equal(result.details.nextStep, 'ask_an_operator_to_configure_the_vote_type');
  assert.deepEqual(calls.submitProposal, [], 'an unconfigured type is never stored');
  assert.equal(guard.calls, 0, 'the refusal happens before the write guard would run');
  assert.deepEqual(calls.listVoteTypes, [{ limit: 200 }], 'the list is read once, from the type table');
});

test('a configured proposal type submits, and an unreadable type list never reads as configured', async () => {
  const ok = createFakes({ configuredVoteTypes: ['event_single'] });
  const submitted = await submitProposal(
    () => build({ fakes: ok, channel: PROPOSAL_CHANNEL }),
    'call-1',
    { voteType: 'event_single', title: 'Free campus discussion' },
  );
  assert.equal(submitted.details.ok, true);
  assert.equal(ok.calls.submitProposal[0].voteType, 'event_single');

  const down = createFakes({
    inserts: {
      listVoteTypes: () => ({ ok: false, status: 'unavailable', reason: 'http_error', voteTypes: null, httpStatus: 503 }),
    },
  });
  const refused = await build({ fakes: down, channel: PROPOSAL_CHANNEL })
    .tool('rein_governance_proposal_submit')
    .execute('call-1', { voteType: 'event_single', title: 'Free campus discussion' });
  assert.equal(refused.details.error, 'vote_type_configuration_unavailable');
  assert.notEqual(refused.details.error, 'vote_type_not_configured', 'an outage is not a missing type');
  assert.deepEqual(down.calls.submitProposal, [], 'an unreadable configuration writes nothing');
});

test('a requested amount is recorded with its currency or refused as incomplete', async () => {
  const cases = [
    [{ requestedMinor: 120000 }, 'proposal_request_incomplete'],
    [{ currency: 'USD' }, 'proposal_request_incomplete'],
    [{ requestedMinor: -1, currency: 'USD' }, 'proposal_requested_minor_invalid'],
    [{ requestedMinor: 1.5, currency: 'USD' }, 'proposal_requested_minor_invalid'],
    [{ requestedMinor: 100, currency: 'dollars' }, 'proposal_currency_invalid'],
    [{ requestedMinor: 100, currency: 'US' }, 'proposal_currency_invalid'],
  ];
  for (const [extra, expected] of cases) {
    const fakes = createFakes();
    const { tool, calls } = build({ fakes, channel: PROPOSAL_CHANNEL });
    const args = {
      voteType: VOTE_TYPE,
      title: 'Repair workshop',
      ...extra,
    };
    // A malformed amount is refused in the prepare phase, before a token is ever minted.
    const result = await tool('rein_governance_proposal_submit').execute('call-1', args);
    assert.equal(result.details.ok, false, JSON.stringify(extra));
    assert.equal(result.details.error, expected, JSON.stringify(extra));
    assert.deepEqual(calls.submitProposal, []);
  }

  // A proposal without an amount is still a valid request, and no answer claims it was approved.
  const fakes = createFakes();
  const result = await submitProposal(
    () => build({ fakes, channel: PROPOSAL_CHANNEL }),
    'call-1',
    { voteType: VOTE_TYPE, title: 'Repair workshop' },
  );
  assert.equal(result.details.ok, true);
  assert.equal(result.details.requestedMinor, null);
  assert.equal(result.details.currency, null);
  assert.equal(result.details.authorizesSpending, false);
});

test('the database decides the proposal write: a refusal and an outage are reported as themselves', async () => {
  const refused = createFakes({
    inserts: {
      submitProposal: () => ({
        ok: false,
        status: 'rejected',
        reason: 'proposal_rejected',
        proposal: null,
        httpStatus: 400,
        authorizesSpending: false,
      }),
    },
  });
  const rejected = await submitProposal(
    () => build({ fakes: refused, channel: PROPOSAL_CHANNEL }),
    'call-1',
    { voteType: VOTE_TYPE, title: 'Repair workshop' },
  );
  assert.equal(rejected.details.ok, false);
  assert.equal(rejected.details.error, 'proposal_rejected');
  assert.equal(rejected.details.recorded, false);

  const down = createFakes({
    inserts: {
      submitProposal: () => ({
        ok: false,
        status: 'unavailable',
        reason: 'http_error',
        proposal: null,
        httpStatus: 503,
        authorizesSpending: false,
      }),
    },
  });
  const downResult = await submitProposal(
    () => build({ fakes: down, channel: PROPOSAL_CHANNEL }),
    'call-1',
    { voteType: VOTE_TYPE, title: 'Repair workshop' },
  );
  assert.equal(downResult.details.error, 'http_error');
  assert.notEqual(downResult.details.error, 'proposal_rejected', 'an outage is not a refusal');
});

test('a changed confirmation is refused before the write, and a stored row is never overwritten', async () => {
  let attempts = 0;
  const fakes = createFakes({
    inserts: {
      submitProposal: (input) => {
        attempts += 1;
        return attempts === 1
          ? { ok: true, status: 'inserted', reason: 'inserted', proposal: storedProposal(input), httpStatus: 201, authorizesSpending: false }
          : { ok: false, status: 'conflict', reason: 'proposal_conflict', proposal: null, httpStatus: 409, authorizesSpending: false };
      },
    },
  });
  const calls = fakes.calls;
  const buildTurn = () => build({ fakes, channel: PROPOSAL_CHANNEL });

  const first = await submitProposal(buildTurn, 'call-1', { voteType: VOTE_TYPE, title: 'Repair workshop' });
  assert.equal(first.details.ok, true);

  // The token commits to the prepared payload, so the confirm turn cannot be used to store different
  // text: an altered field is refused before the writer is called at all.
  const token = await prepareProposal(buildTurn().tool('rein_governance_proposal_submit'), 'call-2', {
    voteType: VOTE_TYPE,
    title: 'Repair workshop',
  });
  const altered = await buildTurn().tool('rein_governance_proposal_submit').execute('call-2', {
    voteType: VOTE_TYPE,
    title: 'Something else entirely',
    confirmationToken: token,
    confirmPronouncedByAuthor: true,
  });
  assert.equal(altered.details.ok, false);
  assert.equal(altered.details.error, 'proposal_confirmation_mismatch');
  assert.equal(calls.submitProposal.length, 1, 'the altered payload never reaches the writer');

  // Replaying the exact confirmed text is an idempotent duplicate, reported as the stored record and
  // never a second row or a mutating update.
  const replayToken = await prepareProposal(buildTurn().tool('rein_governance_proposal_submit'), 'call-3', {
    voteType: VOTE_TYPE,
    title: 'Repair workshop',
  });
  const replay = await confirmProposal(
    buildTurn().tool('rein_governance_proposal_submit'),
    'call-1',
    { voteType: VOTE_TYPE, title: 'Repair workshop' },
    replayToken,
  );
  assert.equal(replay.details.proposalId, first.details.proposalId, 'the same confirmed text is the same row');
});

test('the confirmation gate has four distinct refusals, and only a valid token writes', async () => {
  const args = { voteType: VOTE_TYPE, title: 'Repair workshop' };

  // Missing confirmation statement: a token without the author's explicit confirmation is refused,
  // so a model cannot store a proposal by passing the token alone.
  {
    const fakes = createFakes();
    const { tool, calls } = build({ fakes, channel: PROPOSAL_CHANNEL });
    const submit = tool('rein_governance_proposal_submit');
    const token = await prepareProposal(submit, 'call-1', args);
    const result = await submit.execute('call-1', { ...args, confirmationToken: token });
    assert.equal(result.details.error, 'proposal_confirmation_required');
    assert.deepEqual(calls.submitProposal, [], 'a token without the author statement writes nothing');
  }

  // Missing token: asking to confirm without a prepared token is refused, never treated as a submit.
  {
    const fakes = createFakes();
    const { tool, calls } = build({ fakes, channel: PROPOSAL_CHANNEL });
    const result = await tool('rein_governance_proposal_submit').execute('call-1', {
      ...args,
      confirmPronouncedByAuthor: true,
    });
    assert.equal(result.details.error, 'proposal_confirmation_required');
    assert.deepEqual(calls.submitProposal, [], 'no token means no write');
  }

  // A token the server did not mint, a well-shaped token whose ciphertext does not authenticate, and
  // a token of the superseded HMAC-only shape are all invalid. The old `rpc1` shape is never re-read
  // as current: its version no longer matches, so it is refused as the wrong shape.
  for (const token of [
    'not-a-token',
    `rein_proposal_confirm.rpc2.${Date.parse(NOW) + 600000}.abc-def`,
    'rein_proposal_confirm.rpc1.1.abc.def',
    'rein_proposal_confirm.rpc1.1790513356000.eyJwcm9wb3NlckNvbnRhY3RJZCI6IngifQ.def',
  ]) {
    const fakes = createFakes();
    const { tool, calls } = build({ fakes, channel: PROPOSAL_CHANNEL });
    const result = await tool('rein_governance_proposal_submit').execute('call-1', {
      ...args,
      confirmationToken: token,
      confirmPronouncedByAuthor: true,
    });
    assert.equal(result.details.error, 'proposal_confirmation_invalid', token);
    assert.deepEqual(calls.submitProposal, [], 'a forged token writes nothing');
  }
});

test('a token minted and answered inside one turn is refused, and the next turn confirms it', async () => {
  // The live case: the Agent prepared the canonical text, the proposer agreed to an Agent-authored
  // recap the Agent had already written, and the Agent then confirmed in the very same inbound turn
  // without ever showing the server's own prepared result. One inbound turn resolves one factory
  // instance, so the token the prepare phase minted and the confirm phase's echo of it share an
  // instance, and the confirmation is refused.
  const fakes = createFakes();
  const { tool, calls, guard } = build({ fakes, channel: PROPOSAL_CHANNEL });
  const submit = tool('rein_governance_proposal_submit');
  const args = { voteType: VOTE_TYPE, title: 'Repair workshop' };

  const token = await prepareProposal(submit, 'call-1', args);
  const sameTurn = await submit.execute('call-1', {
    ...args,
    confirmationToken: token,
    confirmPronouncedByAuthor: true,
  });
  assert.equal(sameTurn.details.ok, false);
  assert.equal(sameTurn.details.error, 'proposal_confirmation_next_turn_required');
  assert.deepEqual(calls.submitProposal, [], 'a same-turn confirmation never reaches the writer');
  assert.equal(guard.calls, 0, 'the refusal happens before the write guard would run');
  // The refusal is about the turn, not about the token: the same token is still signed, unexpired
  // and bound to this payload, so the guard is what stopped it rather than a bad token.
  assert.match(token, /^rein_proposal_confirm\.rpc2\./);
  assert.notEqual(sameTurn.details.error, 'proposal_confirmation_expired');
  assert.notEqual(sameTurn.details.error, 'proposal_confirmation_mismatch');
  assert.notEqual(sameTurn.details.error, 'proposal_confirmation_invalid');

  // The proposer answers in a later inbound turn. The host resolves a fresh factory instance over
  // the same sender, channel, clock and signing key, and that instance starts with no minted token,
  // so it verifies the carried-over token and stores the proposal.
  const nextTurn = createFakes();
  const confirmed = await build({ fakes: nextTurn, channel: PROPOSAL_CHANNEL })
    .tool('rein_governance_proposal_submit')
    .execute('call-1', {
      ...args,
      confirmationToken: token,
      confirmPronouncedByAuthor: true,
    });
  assert.equal(confirmed.details.ok, true, JSON.stringify(confirmed.details));
  assert.equal(confirmed.details.status, 'inserted');
  assert.equal(confirmed.details.authorConfirmed, true);
  assert.equal(nextTurn.calls.submitProposal.length, 1);
  // The same confirmed text is the same row whichever turn writes it, so the later-turn write is
  // the record the same-instance refusal never created rather than a second one.
  const repeat = createFakes();
  const repeated = await submitProposal(
    () => build({ fakes: repeat, channel: PROPOSAL_CHANNEL }),
    'call-1',
    args,
  );
  assert.equal(repeated.details.proposalId, confirmed.details.proposalId);

  // A turn that mints a token, moves on, and then mints a second one still cannot confirm the first.
  const resumed = createFakes();
  const turn = build({ fakes: resumed, channel: PROPOSAL_CHANNEL }).tool('rein_governance_proposal_submit');
  const first = await prepareProposal(turn, 'call-1', args);
  await prepareProposal(turn, 'call-2', args);
  const leftover = await turn.execute('call-1', {
    ...args,
    confirmationToken: first,
    confirmPronouncedByAuthor: true,
  });
  assert.equal(leftover.details.error, 'proposal_confirmation_next_turn_required');
  assert.deepEqual(resumed.calls.submitProposal, [], 'a stale same-turn token still cannot write');
});

test('an expired confirmation is refused and the proposal is not written', async () => {
  const fakes = createFakes();
  const clock = { at: new Date(NOW) };
  const calls = fakes.calls;
  // Each turn is its own factory instance over the same fakes and the same mutable clock.
  const buildTurn = () => build({ fakes, channel: PROPOSAL_CHANNEL, now: () => clock.at });
  const args = { voteType: VOTE_TYPE, title: 'Repair workshop' };

  const token = await prepareProposal(buildTurn().tool('rein_governance_proposal_submit'), 'call-1', args, clock.at);
  // Move past the token lifetime; the next turn presents it and it is refused rather than accepted
  // late, which is the expiry check rather than the same-turn check.
  clock.at = new Date(new Date(NOW).getTime() + 15 * 60 * 1000 + 1000);
  const result = await confirmProposal(
    buildTurn().tool('rein_governance_proposal_submit'),
    'call-1',
    args,
    token,
  );
  assert.equal(result.details.error, 'proposal_confirmation_expired');
  assert.deepEqual(calls.submitProposal, [], 'an expired confirmation writes nothing');

  // Re-preparing after the original window still works: the proposer can confirm a fresh preview.
  const fresh = await prepareProposal(buildTurn().tool('rein_governance_proposal_submit'), 'call-2', args, clock.at);
  const after = await confirmProposal(
    buildTurn().tool('rein_governance_proposal_submit'),
    'call-2',
    args,
    fresh,
  );
  assert.equal(after.details.ok, true);
  assert.equal(calls.submitProposal.length, 1);
});

test('no segment of the confirmation token reveals the contact id or the proposal text', async () => {
  const fakes = createFakes();
  const { tool } = build({ fakes, channel: PROPOSAL_CHANNEL });
  const title = 'Repair workshop';
  const summary = 'Fix the roof tiles before the rain';
  const prepared = await tool('rein_governance_proposal_submit').execute('call-1', {
    voteType: VOTE_TYPE,
    title,
    summary,
    requestedMinor: 125000,
    currency: 'USD',
  });
  const token = prepared.details.confirmationToken;
  const [prefix, version, expiresText, sealed] = token.split('.');
  assert.equal(prefix, 'rein_proposal_confirm');
  assert.equal(version, 'rpc2', 'an encrypted token, not the superseded clear-text shape');
  assert.match(expiresText, /^\d+$/, 'only the expiry travels in the clear');

  // Every readable segment is inspected, not just the ciphertext: nothing that travels outside the
  // sealed blob may name the proposer or any part of the proposal text they confirmed.
  const readable = [prefix, version, expiresText].join('\n');
  for (const secret of [CONTACT, title, summary, 'roof', 'workshop']) {
    assert.ok(!readable.includes(secret), `the clear envelope must not carry ${secret}`);
  }

  // Neither the raw ciphertext nor its decoded bytes contain the plaintext document: the payload is
  // sealed, so a reader who can see the token learns the expiry and nothing else.
  assert.ok(!sealed.includes(CONTACT));
  assert.ok(!sealed.includes('roof'));
  const raw = Buffer.from(sealed, 'base64url');
  assert.ok(!raw.toString('latin1').includes(CONTACT), 'the sealed bytes do not hold the contact id');
  assert.ok(!raw.toString('latin1').includes('roof'), 'the sealed bytes do not hold the summary text');
  assert.ok(!raw.toString('utf8').includes(title), 'the sealed bytes do not hold the title');
  assert.ok(!raw.toString('utf8').includes(summary));

  // The whole answer still carries no secret: the key is absent, and the private contact id of the
  // proposer is bound into the token but never returned.
  assert.ok(!token.includes(CONFIRM_KEY), 'the signing key is not in the token');
  assert.ok(!JSON.stringify(prepared.details).includes(CONFIRM_KEY));
  assert.ok(!JSON.stringify(prepared.details).includes(CONTACT));
  assert.ok(!JSON.stringify(prepared.details).toLowerCase().includes('authorizesspending": true'));
});

test('two prepares of one payload mint different tokens that both confirm the same record', async () => {
  // A random nonce per token keeps a token from being replayed byte-for-byte, and the record
  // identifier stays a function of the confirmed content, so the two tokens address one row.
  const fakes = createFakes();
  const buildTurn = () => build({ fakes, channel: PROPOSAL_CHANNEL });
  const args = { voteType: VOTE_TYPE, title: 'Repair workshop', summary: 'Fix the roof tiles' };

  const first = await prepareProposal(buildTurn().tool('rein_governance_proposal_submit'), 'call-1', args);
  const second = await prepareProposal(buildTurn().tool('rein_governance_proposal_submit'), 'call-2', args);
  assert.notEqual(first, second, 'a fresh nonce makes each token its own ciphertext');
  assert.notEqual(first.split('.')[3], second.split('.')[3], 'the sealed segments differ');

  const one = await confirmProposal(buildTurn().tool('rein_governance_proposal_submit'), 'call-1', args, first);
  const two = await confirmProposal(buildTurn().tool('rein_governance_proposal_submit'), 'call-2', args, second);
  assert.equal(one.details.ok, true, JSON.stringify(one.details));
  assert.equal(two.details.ok, true, JSON.stringify(two.details));
  assert.equal(one.details.proposalId, two.details.proposalId, 'the same confirmed text is the same row');
});

test('a tampered, re-dated or re-aimed token is refused before the write', async () => {
  const args = { voteType: VOTE_TYPE, title: 'Repair workshop', summary: 'Fix the roof tiles' };
  const settle = token => ({ confirmationToken: token, confirmPronouncedByAuthor: true });

  const forge = async (mutate) => {
    const fakes = createFakes();
    const buildTurn = () => build({ fakes, channel: PROPOSAL_CHANNEL });
    const token = await prepareProposal(buildTurn().tool('rein_governance_proposal_submit'), 'call-1', args);
    const parts = token.split('.');
    const changed = mutate(parts).join('.');
    const result = await buildTurn()
      .tool('rein_governance_proposal_submit')
      .execute('call-1', { ...args, ...settle(changed) });
    return { result, calls: fakes.calls };
  };

  // A flipped character in the sealed blob fails authentication rather than decoding to something.
  const flipped = parts =>
    parts.map((part, index) =>
      index === 3 ? part.slice(0, -1) + (part.at(-1) === 'A' ? 'B' : 'A') : part,
    );
  const bodyTamper = await forge(flipped);
  assert.equal(bodyTamper.result.details.error, 'proposal_confirmation_invalid');
  assert.deepEqual(bodyTamper.calls.submitProposal, [], 'a tampered token never reaches the writer');

  // Moving the clear expiry forward is not enough: the expiry is authenticated, so the ciphertext no
  // longer opens and a late token cannot be re-dated into its window.
  const reDated = await forge(parts => {
    const moved = parts.slice();
    moved[2] = String(Number(moved[2]) + 60 * 60 * 1000);
    return moved;
  });
  assert.equal(reDated.result.details.error, 'proposal_confirmation_invalid');
  assert.deepEqual(reDated.calls.submitProposal, []);

  // The proposer binding is authenticated too, so another author's token fails as invalid rather
  // than being treated as a payload the current author merely mistyped.
  const otherAuthor = createFakes({ member: contributor({ contactId: OTHER_CONTACT }) });
  const prepareTurn = build({ fakes: otherAuthor, channel: PROPOSAL_CHANNEL });
  const foreignToken = await prepareProposal(
    prepareTurn.tool('rein_governance_proposal_submit'),
    'call-1',
    args,
  );
  const strangerTurn = createFakes();
  const stolen = await build({ fakes: strangerTurn, channel: PROPOSAL_CHANNEL })
    .tool('rein_governance_proposal_submit')
    .execute('call-1', { ...args, ...settle(foreignToken) });
  assert.equal(stolen.details.error, 'proposal_confirmation_invalid');
  assert.deepEqual(strangerTurn.calls.submitProposal, [], 'a cross-author token writes nothing');
});

test('the longest legal summary prepares and confirms across turns, in ASCII and non-ASCII', async () => {
  // The summary cap is a count of UTF-16 code units, and one unit can be one, two or three UTF-8
  // bytes, while JSON escaping can widen a unit further still. These four shapes are the ASCII case,
  // the two- and three-byte cases, and the widest escape case. Each has to prepare a token the
  // schema accepts, travel intact, and confirm against the same text in a later turn.
  const summaries = [
    ['ascii, one byte per unit', 'a'.repeat(4000)],
    ['two-byte code points', 'Ω'.repeat(4000)],
    ['three-byte code points', '中'.repeat(4000)],
    ['control units, the widest JSON escape', '\u0000'.repeat(4000)],
  ];
  for (const [label, summary] of summaries) {
    assert.equal(summary.length, 4000, `${label}: exactly the schema's own summary cap`);
    const fakes = createFakes();
    const buildTurn = () => build({ fakes, channel: PROPOSAL_CHANNEL });
    const title = 'Δ'.repeat(200);
    const args = { voteType: VOTE_TYPE, title, summary, requestedMinor: 125000, currency: 'USD' };
    const token = await prepareProposal(buildTurn().tool('rein_governance_proposal_submit'), 'call-1', args);
    const result = await confirmProposal(
      buildTurn().tool('rein_governance_proposal_submit'),
      'call-1',
      args,
      token,
    );
    assert.equal(result.details.ok, true, `${label}: ${JSON.stringify(result.details)}`);
    assert.equal(result.details.status, 'inserted', label);
    assert.equal(fakes.calls.submitProposal.length, 1, label);
    assert.equal(fakes.calls.submitProposal[0].summary, summary, `${label}: the summary round-trips`);
    assert.equal(fakes.calls.submitProposal[0].title, title, `${label}: the title round-trips`);
  }
});

test('the confirmation token schema cap covers the measured non-ASCII worst case', async () => {
  // Read the cap the schema advertises instead of assuming one, then measure what minting actually
  // produces for the largest legal payload in the widest encoding. The cap has to cover the
  // measurement, and the measurement has to cover the ASCII case that motivated the old 4000 cap.
  const { tool } = build({ fakes: createFakes(), channel: PROPOSAL_CHANNEL });
  const submit = tool('rein_governance_proposal_submit');
  const cap = submit.parameters.properties.confirmationToken.maxLength;
  assert.ok(cap > 4000, `the cap grew past the value the clear-text token outgrew (got ${cap})`);

  const measured = async summary => {
    const fakes = createFakes();
    const prepared = await build({ fakes, channel: PROPOSAL_CHANNEL })
      .tool('rein_governance_proposal_submit')
      .execute('call-1', { voteType: VOTE_TYPE, title: 'a'.repeat(200), summary });
    assert.equal(prepared.details.status, 'prepared', JSON.stringify(prepared.details));
    return prepared.details.confirmationToken.length;
  };

  const ascii = await measured('a'.repeat(4000));
  const widest = await measured('\u0000'.repeat(4000));
  assert.ok(ascii > 4000, 'a 4000-character summary no longer fits the old cap');
  assert.ok(widest <= cap, `the worst measured token (${widest}) fits the advertised cap (${cap})`);
  assert.ok(widest > ascii, 'the non-ASCII worst case really is larger than the ASCII case');
});

test('the document fence and the token cap are one bound, so no minted token can exceed the cap', async () => {
  // The fence and the cap have to come from the same arithmetic: a fence that admits one more byte
  // produces a token the confirm side would reject, which is exactly the bug this pins. The cap is
  // read from the schema rather than assumed, and the fence is reproduced from it independently.
  const { tool } = build({ fakes: createFakes(), channel: PROPOSAL_CHANNEL });
  const cap = tool('rein_governance_proposal_submit').parameters.properties.confirmationToken.maxLength;
  assert.equal(cap, MAX_CONFIRMATION_TOKEN_LENGTH, 'the schema advertises the exported cap');
  assert.equal(
    MAX_CONFIRMATION_DOCUMENT_BYTES,
    maxDocumentBytesForToken(cap),
    'the enforced fence is the one the cap implies',
  );

  // Build a payload whose canonical document is an exact number of UTF-8 bytes, then test the two
  // sides of the fence: the last admissible byte issues a token inside the cap, and one more byte is
  // refused before a token exists.
  const key = CONFIRM_KEY;
  const now = new Date(NOW);
  const shape = (summary) => ({
    proposerContactId: CONTACT,
    title: 't',
    summary,
    voteType: VOTE_TYPE,
    requestedMinor: null,
    currency: null,
  });
  const documentBytes = (summary) =>
    Buffer.byteLength(JSON.stringify({
      v: 1,
      proposerContactId: CONTACT,
      title: 't',
      summary,
      voteType: VOTE_TYPE,
      requestedMinor: null,
      currency: null,
    }), 'utf8');
  const empty = documentBytes('');
  const atFence = 'x'.repeat(MAX_CONFIRMATION_DOCUMENT_BYTES - empty);
  const pastFence = `${atFence}x`;
  assert.equal(documentBytes(atFence), MAX_CONFIRMATION_DOCUMENT_BYTES, 'the payload sits on the fence');
  assert.equal(documentBytes(pastFence), MAX_CONFIRMATION_DOCUMENT_BYTES + 1, 'one byte past it');

  const inside = issueProposalConfirmation(shape(atFence), key, now);
  assert.equal(inside.ok, true, JSON.stringify(inside));
  assert.ok(
    inside.token.length <= cap,
    `the token on the fence stays inside the cap (${inside.token.length} > ${cap})`,
  );
  assert.equal(
    inside.token.length,
    cap - 5,
    'the fence lands the longest legal token just inside the cap rather than a group past it',
  );
  assert.equal(
    verifyProposalConfirmation(inside.token, shape(atFence), key, now).ok,
    true,
    'the fence-edge token verifies',
  );

  const outside = issueProposalConfirmation(shape(pastFence), key, now);
  assert.equal(outside.ok, false, 'a document one byte past the fence is refused');
  assert.equal(outside.reason, 'proposal_confirmation_payload_too_large');
  assert.equal(outside.documentBytes, MAX_CONFIRMATION_DOCUMENT_BYTES + 1);

  // A summary that long is also past the tool's own 4000-unit summary cap, so the two refusals meet:
  // the tool refuses the text first, and no token is ever minted for it. The point of this test is
  // the envelope arithmetic above, which is what the tool's own cap rests on.
  const fakes = createFakes();
  const refused = await build({ fakes, channel: PROPOSAL_CHANNEL })
    .tool('rein_governance_proposal_submit')
    .execute('call-1', { voteType: VOTE_TYPE, title: 't', summary: atFence });
  assert.equal(refused.details.error, 'summary_invalid');
  assert.deepEqual(fakes.calls.submitProposal, [], 'an oversized document never reaches the writer');

  // The longest summary the tool accepts still prepares a token inside the cap, so the fence is not
  // load-bearing for a legal request: it is the backstop the arithmetic needs.
  const legal = createFakes();
  const prepared = await build({ fakes: legal, channel: PROPOSAL_CHANNEL })
    .tool('rein_governance_proposal_submit')
    .execute('call-1', { voteType: VOTE_TYPE, title: 't', summary: '\u0000'.repeat(4000) });
  assert.equal(prepared.details.status, 'prepared', JSON.stringify(prepared.details));
  assert.ok(prepared.details.confirmationToken.length <= cap);
  assert.ok(!JSON.stringify(prepared.details).includes(CONTACT), 'the prepare result hides the contact id');
});

// ---------------------------------------------------------------------------------------------
// rein_poll_open
// ---------------------------------------------------------------------------------------------

test('a verified director opens a round over the capped candidate pool of the stored vote type', async () => {
  const fakes = createFakes({
    member: director(),
    rule: voteTypeRule({ maxCandidates: 3 }),
    candidates: [
      candidateRecord(CANDIDATE_A),
      candidateRecord(CANDIDATE_B),
      candidateRecord(CANDIDATE_C),
      candidateRecord(CANDIDATE_D),
    ],
  });
  const { tool, calls, guard } = build({ fakes });

  const result = await tool('rein_poll_open').execute('call-2', {
    voteType: VOTE_TYPE,
    title: 'Fund the repair workshop?',
    closesAt: CLOSES_AT,
  });

  assert.equal(result.details.ok, true);
  assert.equal(result.details.status, 'inserted');
  assert.equal(result.details.recorded, true);
  assert.equal(result.details.authorizesSpending, false);
  assert.deepEqual(calls.getVoteType, [VOTE_TYPE], 'the type rule is read before the pool');
  assert.deepEqual(calls.listCandidateProposals, [
    { voteType: VOTE_TYPE, limit: 3, includeRecentlyUnselected: true },
  ]);
  assert.equal(calls.createPoll.length, 1);
  const sent = calls.createPoll[0];
  assert.match(sent.id, UUID_V4);
  assert.equal(sent.creatorContactId, CONTACT, 'the creator is the resolved sender record');
  assert.equal(sent.voteType, VOTE_TYPE);
  assert.equal(sent.title, 'Fund the repair workshop?');
  assert.deepEqual(
    sent.candidateProposalIds,
    [CANDIDATE_A, CANDIDATE_B, CANDIDATE_C],
    'the pool is capped to the type rule and never widened by the caller',
  );
  assert.equal(sent.opensAt, NOW, 'the round opens at the current instant');
  assert.equal(sent.closesAt, CLOSES_AT);
  assert.ok(!('candidateLimit' in sent) && !('maxApprovalsPerVoter' in sent), 'the database freezes the limits');
  assert.equal(result.details.pollId, sent.id);
  assert.equal(result.details.candidateCount, 3);
  assert.equal(result.details.candidateLimit, 3);
  assert.equal(result.details.maxApprovalsPerVoter, 1);
  // The frozen identifiers travel with the stored title behind each one, in the round's own order,
  // so a spoken proposal name is matched against this list instead of being guessed at.
  assert.deepEqual(result.details.candidateProposals, [
    { proposalId: CANDIDATE_A, title: 'Stored request aaaa' },
    { proposalId: CANDIDATE_B, title: 'Stored request bbbb' },
    { proposalId: CANDIDATE_C, title: 'Stored request cccc' },
  ]);
  assert.deepEqual(
    result.details.candidateProposals.map(entry => entry.proposalId),
    result.details.candidateProposalIds,
    'the reported candidate list is exactly the frozen list, in order',
  );
  assert.deepEqual(Object.keys(result.details.candidateProposals[0]), ['proposalId', 'title']);
  assert.equal(result.details.candidateTitlesResolved, true);
  assert.deepEqual(result.details.ambiguousCandidateTitles, []);
  assert.deepEqual(calls.getProposal, [], 'the pool read already carried every stored title');
  assert.equal(guard.calls, 1, 'the invocation guard runs once before the write');
  assert.ok(!JSON.stringify(result.details).includes(CONTACT), 'the private contact id is not returned');
  assert.ok(!JSON.stringify(result.details).includes('options'), 'no option label is invented for the round');
});

test('poll_open freezes exactly the free pool the writer returns and never re-adds a frozen candidate', async () => {
  // The writer is the one place that removes the candidates an open round already froze, whatever
  // that round's type; the write tool consumes the returned pool as-is, so a short pool stays short
  // and an identifier it never received is never frozen.
  const free = [candidateRecord(CANDIDATE_B), candidateRecord(CANDIDATE_C)];
  const fakes = createFakes({ member: director(), candidates: free });
  const { tool, calls } = build({ fakes });

  const result = await tool('rein_poll_open').execute('call-2', {
    voteType: VOTE_TYPE,
    title: 'Fund the repair workshop?',
    closesAt: CLOSES_AT,
  });

  assert.equal(result.details.ok, true);
  assert.deepEqual(calls.listCandidateProposals, [
    { voteType: VOTE_TYPE, limit: 3, includeRecentlyUnselected: true },
  ]);
  assert.deepEqual(calls.createPoll[0].candidateProposalIds, [CANDIDATE_B, CANDIDATE_C]);
  assert.deepEqual(result.details.candidateProposalIds, [CANDIDATE_B, CANDIDATE_C]);
  assert.equal(result.details.candidateCount, 2, 'a pool short of the cap is reported as it is');
  assert.ok(
    !JSON.stringify(result.details).includes(CANDIDATE_A),
    'a candidate the free pool left out is never frozen into the round',
  );
});

test('an optional submittedSince narrows the pool and a malformed one opens nothing', async () => {
  const fakes = createFakes({ member: director() });
  const { tool, calls } = build({ fakes });
  const since = '2026-09-01T00:00:00Z';

  const accepted = await tool('rein_poll_open').execute('call-2', {
    voteType: VOTE_TYPE,
    title: 'Fund the repair workshop?',
    closesAt: CLOSES_AT,
    submittedSince: since,
  });
  assert.equal(accepted.details.ok, true);
  assert.deepEqual(calls.listCandidateProposals[0], {
    voteType: VOTE_TYPE,
    limit: 3,
    submittedSince: since,
    includeRecentlyUnselected: true,
  });

  for (const submittedSince of ['', 'soon', '2026-09', 20260901]) {
    const bad = createFakes({ member: director() });
    const result = await build({ fakes: bad }).tool('rein_poll_open').execute('call-2', {
      voteType: VOTE_TYPE,
      title: 'Fund the repair workshop?',
      closesAt: CLOSES_AT,
      submittedSince,
    });
    assert.equal(result.details.error, 'submitted_since_invalid', String(submittedSince));
    assert.deepEqual(bad.calls.createPoll, []);
  }
});

test('a single-candidate round is valid and an empty pool opens nothing', async () => {
  const single = createFakes({
    member: director(),
    rule: voteTypeRule({ maxCandidates: 1 }),
    candidates: [candidateRecord(CANDIDATE_A)],
  });
  const opened = await build({ fakes: single }).tool('rein_poll_open').execute('call-2', {
    voteType: VOTE_TYPE,
    title: 'Fund the single request?',
    closesAt: CLOSES_AT,
  });
  assert.equal(opened.details.ok, true);
  assert.deepEqual(opened.details.candidateProposalIds, [CANDIDATE_A]);
  assert.equal(opened.details.candidateCount, 1);

  const empty = createFakes({ member: director(), candidates: [] });
  const refused = await build({ fakes: empty }).tool('rein_poll_open').execute('call-2', {
    voteType: VOTE_TYPE,
    title: 'Fund nothing?',
    closesAt: CLOSES_AT,
  });
  assert.equal(refused.details.ok, false);
  assert.equal(refused.details.error, 'no_candidate_proposals');
  assert.deepEqual(empty.calls.createPoll, [], 'a round without a candidate is never stored');
});

test('a round whose candidate titles are shared or unreadable says so instead of guessing', async () => {
  // Two stored proposals carry the same title and a third row cannot be read at all. The answer
  // keeps the frozen identifiers, names the shared title as ambiguous and leaves the unreadable one
  // null, so a caller has to ask which proposal is meant rather than pick one identifier.
  const shared = candidateRecord(CANDIDATE_A, { title: 'Reading group, second session' });
  const twin = candidateRecord(CANDIDATE_B, { title: 'reading   group,   second SESSION ' });
  const fakes = createFakes({
    member: director(),
    candidates: [shared, twin],
    proposals: [shared],
  });
  const { tool, calls } = build({ fakes });

  const result = await tool('rein_poll_open').execute('call-2', {
    voteType: VOTE_TYPE,
    title: 'Two reading groups?',
    closesAt: CLOSES_AT,
  });

  assert.equal(result.details.ok, true);
  assert.deepEqual(result.details.candidateProposalIds, [CANDIDATE_A, CANDIDATE_B]);
  assert.deepEqual(result.details.candidateProposals, [
    { proposalId: CANDIDATE_A, title: 'Reading group, second session' },
    { proposalId: CANDIDATE_B, title: 'reading   group,   second SESSION ' },
  ]);
  assert.deepEqual(
    result.details.ambiguousCandidateTitles,
    ['Reading group, second session', 'reading   group,   second SESSION '],
    'a title two frozen candidates share is named rather than matched',
  );
  assert.equal(result.details.candidateTitlesResolved, true, 'both titles are stored, so none is missing');

  // The same round opened over identifiers the pool answered for still reads no extra row: the pool
  // is the source the frozen list came from.
  assert.deepEqual(calls.getProposal, [], 'the pool read carried both titles');
});

test('an unknown or unreadable vote type opens nothing and is never guessed', async () => {
  const unknown = createFakes({ member: director() });
  const unknownResult = await build({ fakes: unknown }).tool('rein_poll_open').execute('call-2', {
    voteType: 'something_else',
    title: 'Fund something?',
    closesAt: CLOSES_AT,
  });
  // A well-formed name that the stored type table does not carry is refused before any rule read.
  assert.equal(unknownResult.details.error, 'vote_type_not_configured');
  assert.deepEqual(unknownResult.details.configuredVoteTypes, [VOTE_TYPE]);
  assert.deepEqual(unknown.calls.getVoteType, [], 'no rule is read for a type that is not configured');
  assert.deepEqual(unknown.calls.listCandidateProposals, [], 'no pool is read for a type with no rule');
  assert.deepEqual(unknown.calls.createPoll, []);

  // A type that is listed but whose rule cannot be read is still the older, narrower refusal.
  const vanished = createFakes({ member: director(), configuredVoteTypes: [VOTE_TYPE] });
  vanished.writer.getVoteType = async () => ({
    ok: false,
    status: 'rejected',
    reason: 'vote_type_not_found',
    voteType: null,
    httpStatus: 200,
  });
  const vanishedResult = await build({ fakes: vanished }).tool('rein_poll_open').execute('call-2', {
    voteType: VOTE_TYPE,
    title: 'Fund the repair workshop?',
    closesAt: CLOSES_AT,
  });
  assert.equal(vanishedResult.details.error, 'vote_type_not_found');
  assert.deepEqual(vanished.calls.createPoll, []);

  const down = createFakes({
    member: director(),
    inserts: {
      getVoteType: () => ({ ok: false, status: 'unavailable', reason: 'http_error', voteType: null, httpStatus: 503 }),
    },
  });
  const downResult = await build({ fakes: down }).tool('rein_poll_open').execute('call-2', {
    voteType: VOTE_TYPE,
    title: 'Fund the repair workshop?',
    closesAt: CLOSES_AT,
  });
  assert.equal(downResult.details.error, 'vote_type_lookup_unavailable');
  assert.notEqual(downResult.details.error, 'vote_type_not_found', 'an outage is not a missing type');
  assert.deepEqual(down.calls.createPoll, []);

  const poolDown = createFakes({
    member: director(),
    inserts: {
      listCandidateProposals: () => ({ ok: false, status: 'unavailable', reason: 'http_error', proposals: null, httpStatus: 503 }),
    },
  });
  const poolResult = await build({ fakes: poolDown }).tool('rein_poll_open').execute('call-2', {
    voteType: VOTE_TYPE,
    title: 'Fund the repair workshop?',
    closesAt: CLOSES_AT,
  });
  assert.equal(poolResult.details.error, 'candidate_pool_unavailable');
  assert.deepEqual(poolDown.calls.createPoll, []);
});

test('opening a poll refuses a non-director and an out-of-scope channel without writing', async () => {
  for (const [member, expectedError] of [
    [contributor(), 'board_membership_required'],
    [contributor({ status: 'identity_not_linked', reason: 'identity_not_linked', contactId: null, isActiveContributor: false }), 'identity_link_required'],
    [contributor({ status: 'identity_link_revoked', reason: 'identity_link_revoked', contactId: null, isActiveContributor: false }), 'identity_link_required'],
    [contributor({ status: 'unavailable', reason: 'transport_error', contactId: null, isActiveContributor: false }), 'identity_check_unavailable'],
  ]) {
    const fakes = createFakes({ member });
    const { tool, calls } = build({ fakes });
    const result = await tool('rein_poll_open').execute('call-2', {
      voteType: VOTE_TYPE,
      title: 'Fund the repair workshop?',
      closesAt: CLOSES_AT,
    });
    assert.equal(result.details.ok, false);
    assert.equal(result.details.error, expectedError);
    assert.deepEqual(calls.getVoteType, [], 'a refused caller never reaches the type rule');
    assert.deepEqual(calls.createPoll, [], 'a non-director never reaches the poll write');
  }

  const fakes = createFakes({ member: director() });
  const { tool, calls } = build({ fakes, channel: PROPOSAL_CHANNEL });
  const result = await tool('rein_poll_open').execute('call-2', {
    voteType: VOTE_TYPE,
    title: 'Fund the repair workshop?',
    closesAt: CLOSES_AT,
  });
  assert.equal(result.details.error, 'channel_out_of_scope');
  assert.deepEqual(calls.member, []);
  assert.deepEqual(calls.createPoll, []);
});

test('opening a poll refuses a past or missing deadline without writing', async () => {
  for (const closesAt of [OPENS_AT, NOW, 'not-a-time', undefined, '', 20260924]) {
    const fakes = createFakes({ member: director() });
    const { tool, calls } = build({ fakes });
    const result = await tool('rein_poll_open').execute('call-2', {
      voteType: VOTE_TYPE,
      title: 'Fund the repair workshop?',
      closesAt,
    });
    assert.equal(result.details.ok, false, String(closesAt));
    assert.ok(
      ['poll_closes_at_invalid', 'poll_window_invalid'].includes(result.details.error),
      `${String(closesAt)} produced ${result.details.error}`,
    );
    assert.deepEqual(calls.createPoll, [], 'a round without a usable window is never stored');
  }
});

test('no write tool accepts a caller-supplied candidate list, cap or label', async () => {
  const attempts = [
    ['rein_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT, candidateProposalIds: [CANDIDATE_A] }],
    ['rein_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT, candidateLimit: 50 }],
    ['rein_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT, maxCandidates: 50 }],
    ['rein_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT, limit: 50 }],
    ['rein_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT, options: ['approve', 'reject'] }],
    ['rein_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT, opensAt: NOW }],
    ['rein_governance_proposal_submit', { voteType: VOTE_TYPE, title: 'Repair workshop', candidateProposalIds: [CANDIDATE_A] }],
  ];
  for (const [name, args] of attempts) {
    const fakes = createFakes({ member: director() });
    const { tool, calls } = build({ fakes });
    const result = await tool(name).execute('call-1', args);
    assert.equal(result.details.ok, false, `${name} ${JSON.stringify(args)}`);
    assert.equal(result.details.error, 'policy_argument_rejected', `${name} ${JSON.stringify(args)}`);
    assert.deepEqual(calls.member, [], 'a refused argument never resolves an identity');
    assert.deepEqual(calls.getVoteType, []);
    assert.deepEqual(calls.listCandidateProposals, []);
    assert.deepEqual(calls.createPoll, []);
    assert.deepEqual(calls.submitProposal, []);
  }
});

// ---------------------------------------------------------------------------------------------
// Shared trust boundary
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// `rein_poll_vote`: one immutable ballot per director
// ---------------------------------------------------------------------------------------------

const ballotRecord = (overrides = {}) => ({
  id: '99999999-9999-4999-8999-999999999999',
  pollId: POLL,
  voterContactId: OTHER_CONTACT,
  approvedProposalIds: [CANDIDATE_A],
  castAt: OPENS_AT,
  ...overrides,
});

test('a director records one approval and the same ballot replays as an exact duplicate', async () => {
  const fakes = createFakes({ member: director() });
  const { tool, calls, guard } = build({ fakes });

  const first = await tool('rein_poll_vote').execute('call-3', {
    pollId: POLL,
    approvedProposalIds: [CANDIDATE_A],
  });
  assert.equal(first.details.ok, true);
  assert.equal(first.details.status, 'inserted');
  assert.equal(first.details.recorded, true);
  assert.equal(first.details.replaced, false);
  assert.equal(first.details.approvalCount, 1);
  assert.equal(first.details.abstained, false);
  assert.equal(first.details.authorizesSpending, false);
  assert.deepEqual(calls.castBallot, [
    { pollId: POLL, voterContactId: CONTACT, approvedProposalIds: [CANDIDATE_A] },
  ], 'the voter is the resolved sender record, never an argument');
  assert.equal(guard.calls, 1, 'the invocation guard runs once before the write');
  assert.ok(!JSON.stringify(first.details).includes(CONTACT));

  // A host retry that reaches the endpoint again is the same record, not a second ballot.
  const replayFakes = createFakes({
    member: director(),
    inserts: {
      castBallot: input => ({
        ok: true,
        status: 'existing',
        reason: 'existing_identical',
        ballot: {
          pollId: input.pollId,
          voterContactId: input.voterContactId,
          approvedProposalIds: [...(input.approvedProposalIds ?? [])],
        },
        httpStatus: 409,
      }),
    },
  });
  const replay = await build({ fakes: replayFakes }).tool('rein_poll_vote').execute('call-3', {
    pollId: POLL,
    approvedProposalIds: [CANDIDATE_A],
  });
  assert.equal(replay.details.ok, true);
  assert.equal(replay.details.status, 'existing');
  assert.equal(replay.details.approvalCount, 1);
});

test('a multi-approval ballot is bounded by the poll approval budget and the candidate list', async () => {
  // A poll whose rule allows two approvals accepts two distinct candidates.
  const multi = createFakes({ member: director(), poll: pollRecord({ maxApprovalsPerVoter: 2 }) });
  const accepted = await build({ fakes: multi }).tool('rein_poll_vote').execute('call-3', {
    pollId: POLL,
    approvedProposalIds: [CANDIDATE_A, CANDIDATE_B],
  });
  assert.equal(accepted.details.ok, true);
  assert.equal(accepted.details.approvalCount, 2);
  assert.deepEqual(multi.calls.castBallot[0].approvedProposalIds, [CANDIDATE_A, CANDIDATE_B]);

  // Exceeding the frozen per-voter budget is refused before any write.
  const overBudget = createFakes({ member: director(), poll: pollRecord({ maxApprovalsPerVoter: 1 }) });
  const tooMany = await build({ fakes: overBudget }).tool('rein_poll_vote').execute('call-3', {
    pollId: POLL,
    approvedProposalIds: [CANDIDATE_A, CANDIDATE_B],
  });
  assert.equal(tooMany.details.error, 'too_many_approvals');
  assert.deepEqual(overBudget.calls.castBallot, []);

  // Approving a proposal outside this poll's candidate list is refused before any write.
  const offList = createFakes({ member: director(), poll: pollRecord({ maxApprovalsPerVoter: 2 }) });
  const notCandidate = await build({ fakes: offList }).tool('rein_poll_vote').execute('call-3', {
    pollId: POLL,
    approvedProposalIds: [CANDIDATE_A, CANDIDATE_D],
  });
  assert.equal(notCandidate.details.error, 'approved_proposal_not_in_poll');
  assert.deepEqual(offList.calls.castBallot, []);

  // A repeated candidate inside one ballot is a malformed list, not a double count.
  const repeated = createFakes({ member: director(), poll: pollRecord({ maxApprovalsPerVoter: 2 }) });
  const duplicate = await build({ fakes: repeated }).tool('rein_poll_vote').execute('call-3', {
    pollId: POLL,
    approvedProposalIds: [CANDIDATE_A, CANDIDATE_A],
  });
  assert.equal(duplicate.details.error, 'approved_proposal_ids_invalid');
  assert.deepEqual(repeated.calls.castBallot, []);

  // A non-uuid entry is the same malformed refusal.
  const malformed = createFakes({ member: director(), poll: pollRecord({ maxApprovalsPerVoter: 2 }) });
  const notId = await build({ fakes: malformed }).tool('rein_poll_vote').execute('call-3', {
    pollId: POLL,
    approvedProposalIds: ['approve'],
  });
  assert.equal(notId.details.error, 'approved_proposal_ids_invalid');
  assert.deepEqual(malformed.calls.castBallot, []);
});

test('an empty approval list is the abstention and an omitted one is the same', async () => {
  const explicit = createFakes({ member: director() });
  const result = await build({ fakes: explicit }).tool('rein_poll_vote').execute('call-3', {
    pollId: POLL,
    approvedProposalIds: [],
  });
  assert.equal(result.details.ok, true);
  assert.equal(result.details.abstained, true);
  assert.equal(result.details.approvalCount, 0);
  assert.deepEqual(explicit.calls.castBallot[0].approvedProposalIds, []);

  const omitted = createFakes({ member: director() });
  const omittedResult = await build({ fakes: omitted }).tool('rein_poll_vote').execute('call-3', { pollId: POLL });
  assert.equal(omittedResult.details.ok, true);
  assert.equal(omittedResult.details.abstained, true);
  assert.deepEqual(omitted.calls.castBallot[0].approvedProposalIds, []);
});

test('an abstention is available even when the poll approval budget would refuse an approval', async () => {
  // `maxApprovalsPerVoter` only bounds approvals; approving nothing is always allowed.
  const fakes = createFakes({ member: director(), poll: pollRecord({ maxApprovalsPerVoter: 1 }) });
  const result = await build({ fakes }).tool('rein_poll_vote').execute('call-3', {
    pollId: POLL,
    approvedProposalIds: [],
  });
  assert.equal(result.details.ok, true);
  assert.equal(result.details.abstained, true);
});

test('a ballot is refused outside the poll window and for a closed or cancelled poll', async () => {
  // At the closing instant the ballot is late, not counted.
  const closed = createFakes({ member: director() });
  const closedResult = await build({ fakes: closed, now: () => new Date(CLOSES_AT) })
    .tool('rein_poll_vote')
    .execute('call-3', { pollId: POLL, approvedProposalIds: [CANDIDATE_A] });
  assert.equal(closedResult.details.error, 'poll_closed');
  assert.deepEqual(closed.calls.castBallot, []);

  // Before the opening instant a ballot is premature, not late.
  const early = createFakes({ member: director() });
  const earlyResult = await build({ fakes: early, now: () => new Date('2026-09-24T09:59:00.000Z') })
    .tool('rein_poll_vote')
    .execute('call-3', { pollId: POLL, approvedProposalIds: [CANDIDATE_A] });
  assert.equal(earlyResult.details.error, 'poll_not_open');
  assert.deepEqual(early.calls.castBallot, []);

  // A stored poll the database already closed refuses a ballot even inside the clock window.
  const statusClosed = createFakes({ member: director(), poll: pollRecord({ status: 'closed' }) });
  const statusClosedResult = await build({ fakes: statusClosed })
    .tool('rein_poll_vote')
    .execute('call-3', { pollId: POLL, approvedProposalIds: [CANDIDATE_A] });
  assert.equal(statusClosedResult.details.error, 'poll_closed');
  assert.deepEqual(statusClosed.calls.castBallot, []);

  const cancelled = createFakes({ member: director(), poll: pollRecord({ status: 'cancelled' }) });
  const cancelledResult = await build({ fakes: cancelled })
    .tool('rein_poll_vote')
    .execute('call-3', { pollId: POLL, approvedProposalIds: [CANDIDATE_A] });
  assert.equal(cancelledResult.details.error, 'poll_cancelled');
  assert.deepEqual(cancelled.calls.castBallot, []);
});

test('a changed approval list on the same ballot is a conflict and never replaces the vote', async () => {
  const fakes = createFakes({
    member: director(),
    inserts: {
      castBallot: () => ({
        ok: false,
        status: 'conflict',
        reason: 'ballot_conflict',
        ballot: null,
        httpStatus: 409,
      }),
    },
  });
  const result = await build({ fakes }).tool('rein_poll_vote').execute('call-3', {
    pollId: POLL,
    approvedProposalIds: [CANDIDATE_B],
  });
  assert.equal(result.details.ok, false);
  assert.equal(result.details.status, 'conflict');
  assert.equal(result.details.reason, 'ballot_conflict');
  assert.equal(result.details.error, 'ballot_conflict');
  assert.equal(result.details.replaced, false, 'the endpoint never reports a replacement');
});

test('a ballot is refused for an unknown poll, a non-director or an out-of-scope channel', async () => {
  const unknown = createFakes({ member: director(), poll: null });
  const unknownResult = await build({ fakes: unknown })
    .tool('rein_poll_vote')
    .execute('call-3', { pollId: POLL, approvedProposalIds: [CANDIDATE_A] });
  assert.equal(unknownResult.details.error, 'poll_not_found');
  assert.deepEqual(unknown.calls.castBallot, []);

  // A read that fails for a transport or HTTP reason is an outage, never a missing poll.
  for (const status of ['unavailable', 'invalid_request']) {
    const down = createFakes({ member: director() });
    down.writer.getPoll = async () => ({ ok: false, status, reason: 'http_error', poll: null, httpStatus: 503 });
    const downResult = await build({ fakes: down })
      .tool('rein_poll_vote')
      .execute('call-3', { pollId: POLL, approvedProposalIds: [CANDIDATE_A] });
    assert.equal(downResult.details.error, 'poll_lookup_unavailable', status);
    assert.notEqual(downResult.details.error, 'poll_not_found', 'an outage must not read as a missing poll');
    assert.deepEqual(down.calls.castBallot, []);
  }

  for (const member of [
    contributor(),
    contributor({ status: 'identity_not_linked', reason: 'identity_not_linked', contactId: null, isActiveContributor: false }),
  ]) {
    const fakes = createFakes({ member });
    const result = await build({ fakes }).tool('rein_poll_vote').execute('call-3', {
      pollId: POLL,
      approvedProposalIds: [CANDIDATE_A],
    });
    assert.equal(result.details.ok, false);
    assert.ok(['identity_link_required', 'board_membership_required'].includes(result.details.error));
    assert.deepEqual(fakes.calls.getPoll, [], 'a refused caller never reaches the poll read');
    assert.deepEqual(fakes.calls.castBallot, []);
  }

  // A read outage on the community record is reported as an unavailable identity check, not as an
  // unlinked or unauthorized caller, and still never reaches the poll read or the ballot write.
  {
    const fakes = createFakes({
      member: contributor({ status: 'unavailable', reason: 'transport_error', contactId: null, isActiveContributor: false }),
    });
    const result = await build({ fakes }).tool('rein_poll_vote').execute('call-3', {
      pollId: POLL,
      approvedProposalIds: [CANDIDATE_A],
    });
    assert.equal(result.details.ok, false);
    assert.equal(result.details.error, 'identity_check_unavailable');
    assert.deepEqual(fakes.calls.getPoll, [], 'a refused caller never reaches the poll read');
    assert.deepEqual(fakes.calls.castBallot, []);
  }

  const outOfScope = createFakes({ member: director() });
  const channelResult = await build({ fakes: outOfScope, ctx: { nativeChannelId: PROPOSAL_CHANNEL } })
    .tool('rein_poll_vote')
    .execute('call-3', { pollId: POLL, approvedProposalIds: [CANDIDATE_A] });
  assert.equal(channelResult.details.error, 'channel_out_of_scope');
  assert.deepEqual(outOfScope.calls.member, []);
  assert.deepEqual(outOfScope.calls.castBallot, []);
});

test('a vote requires a canonical poll identifier before any database call', async () => {
  for (const pollId of [undefined, '', 'not-a-uuid']) {
    const fakes = createFakes({ member: director() });
    const result = await build({ fakes }).tool('rein_poll_vote').execute('call-3', {
      pollId,
      approvedProposalIds: [CANDIDATE_A],
    });
    assert.equal(result.details.error, 'poll_id_invalid', String(pollId));
    assert.deepEqual(fakes.calls.member, [], 'an unusable identifier never resolves an identity');
    assert.deepEqual(fakes.calls.getPoll, [], 'an unusable identifier never reaches a read');
    assert.deepEqual(fakes.calls.castBallot, []);
  }
});

test('a vote write that fails reports the endpoint reason and never echoes provider text', async () => {
  const fakes = createFakes({
    member: director(),
    inserts: {
      castBallot: () => ({
        ok: false,
        status: 'unavailable',
        reason: 'http_error',
        ballot: null,
        httpStatus: 500,
      }),
    },
  });
  const result = await build({ fakes }).tool('rein_poll_vote').execute('call-3', {
    pollId: POLL,
    approvedProposalIds: [CANDIDATE_A],
  });
  assert.equal(result.details.ok, false);
  assert.equal(result.details.status, 'unavailable');
  assert.equal(result.details.reason, 'http_error');
  assert.equal(result.details.error, 'http_error');
  assert.equal(result.details.recorded, false);
  assert.ok(!JSON.stringify(result.details).includes(SECRET));
});

// ---------------------------------------------------------------------------------------------
// `rein_poll_result`
// ---------------------------------------------------------------------------------------------

test('before the deadline the result is provisional: window and candidates only, no total and no voter', async () => {
  const ballots = [
    ballotRecord({ voterContactId: OTHER_CONTACT, approvedProposalIds: [CANDIDATE_A] }),
    ballotRecord({
      id: 'aaaaaaa1-1111-4111-8111-111111111111',
      voterContactId: 'bbbbbbb2-2222-4222-8222-222222222222',
      approvedProposalIds: [CANDIDATE_B],
    }),
  ];
  const fakes = createFakes({ member: director(), ballots });
  const { tool, calls, guard } = build({ fakes });

  const pending = await tool('rein_poll_result').execute('call-4', { pollId: POLL });
  assert.equal(pending.details.ok, false);
  assert.equal(pending.details.status, 'provisional');
  assert.equal(pending.details.error, 'provisional');
  assert.equal(pending.details.reason, 'poll_still_open');
  assert.equal(pending.details.closed, false, 'before the deadline the read reports an open window');
  assert.equal(pending.details.official, false);
  assert.equal(pending.details.finalized, false);
  assert.equal(pending.details.outcome, null);
  assert.equal(pending.details.winner, null);
  assert.equal(pending.details.counts, null, 'an open poll publishes no tally');
  assert.equal(
    pending.details.totalBallots,
    null,
    'an open round publishes no participation total, even though two ballots are stored',
  );
  assert.equal(pending.details.abstainCount, undefined, 'an open round publishes no abstention figure');
  assert.equal(pending.details.pollStatus, 'open');
  assert.equal(pending.details.closesAt, CLOSES_AT, 'the stored deadline is returned to the caller');
  assert.equal(pending.details.authorizesSpending, false);
  // The ballot rows are not read for a provisional answer, so no count and no voter identity can be
  // inferred from it: the readable facts are the stored window and the frozen candidates.
  assert.deepEqual(calls.listBallots, [], 'an open round never reads the ballot list');
  assert.ok(
    !pending.content[0].text.includes('ballot'),
    'the provisional answer names no ballot row',
  );
  assert.deepEqual(calls.finalizePoll, [], 'an open poll is never finalized');
  assert.equal(guard.calls, 1);
  assert.ok(!pending.content[0].text.includes(CONTACT), 'the private contact id is not returned');
  assert.ok(
    !pending.content[0].text.includes(OTHER_CONTACT),
    'no recorded voter identity appears in an open round',
  );
  // A later director turn is addressed by the round's own identifier and gets the frozen candidate
  // list with the stored title behind each identifier, so a spoken proposal name is matched against
  // that list. The count and the winner stay unpublished while the round is open.
  assert.deepEqual(pending.details.candidateProposals, [
    { proposalId: CANDIDATE_A, title: 'Stored request aaaa' },
    { proposalId: CANDIDATE_B, title: 'Stored request bbbb' },
  ]);
  assert.equal(pending.details.candidateTitlesResolved, true);
  assert.deepEqual(pending.details.ambiguousCandidateTitles, []);
  assert.deepEqual(
    calls.getProposal,
    [CANDIDATE_A, CANDIDATE_B],
    'each frozen identifier is read from the stored proposals, in the frozen order',
  );
  assert.deepEqual(calls.getPoll, [POLL], 'the stored poll row is the source of the frozen list');

  // The narration object is the structured relay of a provisional read. It is model-relayed, it
  // carries no outcome-shaped fact, and it exposes no ballot count, no vote total, no winner and no
  // identity - the same boundary the outer answer holds.
  assert.equal(pending.details.narration.kind, 'provisional');
  assert.equal(pending.details.narration.delivery, 'model_relayed');
  assert.equal(pending.details.narration.finalized, false);
  assert.equal(pending.details.narration.settled, false);
  assert.equal(pending.details.narration.record, 'provisional');
  assert.equal(
    pending.details.narration.official,
    undefined,
    'a provisional read claims no official standing at all',
  );
  assert.equal(pending.details.narration.pollId, POLL);
  assert.equal(pending.details.narration.outcome, null, 'an open round narrates no outcome');
  assert.equal(pending.details.narration.winner, null);
  assert.equal(pending.details.narration.winnerTitle, null);
  assert.equal(pending.details.narration.counts, null);
  assert.equal(pending.details.narration.totalBallots, null, 'an open round narrates no participation total');
  assert.equal(pending.details.narration.abstainCount, null);
  assert.equal(pending.details.narration.authorizesSpending, false);
  assert.deepEqual(pending.details.narration.candidateProposals, [
    { proposalId: CANDIDATE_A, title: 'Stored request aaaa' },
    { proposalId: CANDIDATE_B, title: 'Stored request bbbb' },
  ]);
  // The note is the user-facing wording, so it has to be sayable as it stands: no implementation
  // vocabulary, no field names, no claim that the round is decided, and no figure a spoken reply
  // could carry as a count.
  assert.equal(
    pending.details.narration.note,
    '本轮还没有结束，所以还没有结果：现在没有赢家，也没有票数与参与人数。',
    'the provisional note is the exact sentence, and it publishes no figure',
  );
  for (const term of [
    'model-relayed',
    'model relayed',
    'tool',
    'narration',
    'delivery',
    'provisional',
    'official',
    'schema',
    'field',
    'Slack',
  ]) {
    assert.ok(
      !pending.details.narration.note.toLowerCase().includes(term.toLowerCase()),
      `the provisional note must not carry the implementation term ${term}`,
    );
  }
  assert.ok(
    !/\d/.test(pending.details.narration.note),
    'the provisional note carries no number a reader could take as a count',
  );
  const provisionalNarration = JSON.stringify(pending.details.narration);
  for (const withheld of [CONTACT, OTHER_CONTACT, TEAM]) {
    assert.ok(!provisionalNarration.includes(withheld), `provisional narration must not carry ${withheld}`);
  }
  assert.ok(!/\d+\s*(?:vote|ballot)/i.test(provisionalNarration), 'the provisional narration states no count');

  // The instant the window closes is already past the deadline, exactly as it is for a ballot.
  const atDeadline = createFakes({ member: director(), ballots });
  const boundary = await build({ fakes: atDeadline, now: () => new Date(CLOSES_AT) })
    .tool('rein_poll_result')
    .execute('call-4', { pollId: POLL });
  assert.equal(boundary.details.closed, true, 'the closing instant closes the round');
  assert.equal(boundary.details.finalized, true);
  assert.deepEqual(atDeadline.calls.finalizePoll, [{ pollId: POLL, actorContactId: CONTACT }]);

  // A cancelled round is over but is never finalized, so it holds no outcome to report.
  const cancelledFakes = createFakes({ member: director(), poll: pollRecord({ status: 'cancelled' }) });
  const cancelled = await build({ fakes: cancelledFakes, now: () => new Date(NOW) })
    .tool('rein_poll_result')
    .execute('call-4', { pollId: POLL });
  assert.equal(cancelled.details.ok, false);
  assert.equal(cancelled.details.reason, 'poll_not_open');
  assert.equal(cancelled.details.closed, true);
  assert.equal(cancelled.details.official, false);
  assert.equal(cancelled.details.outcome, null, 'a cancelled round names no outcome');
  assert.equal(cancelled.details.narration.record, 'provisional');
  assert.equal(cancelled.details.narration.settled, false);
  assert.equal(
    cancelled.details.narration.official,
    undefined,
    'a cancelled round claims no official standing either',
  );
  assert.deepEqual(cancelledFakes.calls.finalizePoll, [], 'a cancelled round is never finalized');
  assert.deepEqual(
    cancelled.details.candidateProposals.map(entry => entry.proposalId),
    [CANDIDATE_A, CANDIDATE_B],
    'a cancelled round still names its frozen candidates',
  );
  assert.equal(cancelled.details.candidateTitlesResolved, true);
});

test('a candidate title the stored row cannot answer for stays null and is not guessed', async () => {
  // The frozen list comes from the poll row, so a proposal row that is gone or unreadable cannot
  // erase the candidate: the identifier stays, the title stays null, and the answer says the titles
  // are not all resolved. No title is invented and no identifier is substituted.
  const fakes = createFakes({
    member: director(),
    inserts: {
      getProposal: id =>
        id === CANDIDATE_A
          ? { ok: true, status: 'found', reason: 'proposal', proposal: candidateRecord(id), httpStatus: 200 }
          : { ok: false, status: 'unavailable', reason: 'http_error', proposal: null, httpStatus: 503 },
    },
  });
  const { tool, calls } = build({ fakes });

  const pending = await tool('rein_poll_result').execute('call-4', { pollId: POLL });
  assert.equal(pending.details.ok, false);
  assert.equal(pending.details.reason, 'poll_still_open');
  assert.equal(pending.details.counts, null, 'an unresolved title is not an outcome either');
  assert.equal(pending.details.winner, null);
  assert.deepEqual(pending.details.candidateProposals, [
    { proposalId: CANDIDATE_A, title: 'Stored request aaaa' },
    { proposalId: CANDIDATE_B, title: null },
  ]);
  assert.equal(pending.details.candidateTitlesResolved, false);
  assert.deepEqual(pending.details.ambiguousCandidateTitles, []);
  assert.deepEqual(calls.getProposal, [CANDIDATE_A, CANDIDATE_B]);

  // An injected writer with no single-proposal read leaves every title unresolved instead of
  // failing the read: the frozen identifiers are still the auditable fact of the round.
  const withoutTitleReads = createFakes({ member: director() });
  const { getProposal: _omitted, ...writerWithoutTitleReads } = withoutTitleReads.writer;
  const bare = await build({ fakes: { ...withoutTitleReads, writer: writerWithoutTitleReads } })
    .tool('rein_poll_result')
    .execute('call-4', { pollId: POLL });
  assert.equal(bare.details.status, 'provisional');
  assert.equal(bare.details.reason, 'poll_still_open');
  assert.deepEqual(
    bare.details.candidateProposals,
    [
      { proposalId: CANDIDATE_A, title: null },
      { proposalId: CANDIDATE_B, title: null },
    ],
  );
  assert.equal(bare.details.candidateTitlesResolved, false);
  assert.deepEqual(withoutTitleReads.calls.getProposal, []);
});

test('a row a finalization already closed replays the stored outcome instead of a provisional read', async () => {
  // A stored poll row reads `closed` once a finalization has written it. A later read has to reach
  // the stored record rather than answer `provisional`/`poll_not_open` for an outcome the database
  // already holds.
  const ballots = [
    ballotRecord({ voterContactId: OTHER_CONTACT, approvedProposalIds: [CANDIDATE_A] }),
  ];
  const fakes = createFakes({
    member: director(),
    poll: pollRecord({ status: 'closed' }),
    ballots,
    inserts: {
      finalizePoll: () => ({
        ok: true,
        status: 'existing',
        reason: 'existing_finalized',
        finalization: finalizeRecord({ repeated: true, ballots: 1 }),
        httpStatus: 200,
      }),
    },
  });
  const result = await build({ fakes, now: () => new Date(NOW) })
    .tool('rein_poll_result')
    .execute('call-4', { pollId: POLL });

  assert.equal(fakes.calls.getPoll.length, 1, 'the stored poll row is read first');
  assert.deepEqual(
    fakes.calls.finalizePoll,
    [{ pollId: POLL, actorContactId: CONTACT }],
    'the closed row still asks the idempotent writer for the stored record',
  );
  assert.equal(result.details.ok, true);
  assert.equal(result.details.status, 'existing');
  assert.equal(result.details.reason, 'existing_finalized');
  assert.equal(result.details.official, true);
  assert.equal(result.details.outcome, 'winner');
  assert.equal(result.details.winner, CANDIDATE_A);
  assert.deepEqual({ ...result.details.counts }, { [CANDIDATE_A]: 1 });
  assert.equal(result.details.pollStatus, 'closed');
  assert.equal(result.details.finalized, true);
  assert.equal(result.details.repeated, true, 'the database reports the record was already stored');
  assert.equal(result.details.totalBallots, 1);
  assert.equal(result.details.eligibleVoters, undefined, 'a closed row publishes no eligible-voter figure');
  assert.equal(result.details.authorizesSpending, false);
  // The closed round names the same recorded candidates with the stored title behind each
  // identifier, so the outcome can be read by proposal name as well as by identifier.
  assert.deepEqual(result.details.candidateProposals, [
    { proposalId: CANDIDATE_A, title: 'Stored request aaaa' },
    { proposalId: CANDIDATE_B, title: 'Stored request bbbb' },
  ]);
  assert.equal(result.details.candidateTitlesResolved, true);
  assert.ok(!JSON.stringify(result.details).includes(CONTACT), 'the private contact id is not returned');

  // A cancelled round is still refused even though its row is equally not `open`.
  const cancelledFakes = createFakes({
    member: director(),
    poll: pollRecord({ status: 'cancelled' }),
    inserts: {
      finalizePoll: () => {
        throw new Error('a cancelled round must never reach the finalizer');
      },
    },
  });
  const cancelled = await build({ fakes: cancelledFakes, now: () => new Date(NOW) })
    .tool('rein_poll_result')
    .execute('call-4', { pollId: POLL });
  assert.equal(cancelled.details.ok, false);
  assert.equal(cancelled.details.reason, 'poll_not_open');
  assert.equal(cancelled.details.outcome, null);
  assert.deepEqual(cancelledFakes.calls.finalizePoll, [], 'a cancelled round is never finalized');
});

test('past the deadline the stored outcome is reported, and a repeat returns the same record', async () => {
  const ballots = [
    ballotRecord({ voterContactId: OTHER_CONTACT, approvedProposalIds: [CANDIDATE_A] }),
    ballotRecord({
      id: 'aaaaaaa1-1111-4111-8111-111111111111',
      voterContactId: 'bbbbbbb2-2222-4222-8222-222222222222',
      approvedProposalIds: [CANDIDATE_B],
    }),
  ];
  const fakes = createFakes({ member: director(), ballots });
  const { tool, calls } = build({ fakes, now: () => new Date('2026-09-24T11:30:00.000Z') });

  const result = await tool('rein_poll_result').execute('call-4', { pollId: POLL });
  assert.equal(result.details.ok, true);
  assert.equal(result.details.status, 'inserted');
  assert.equal(result.details.reason, 'finalized');
  assert.equal(result.details.closed, true);
  assert.equal(result.details.official, true);
  assert.equal(result.details.outcome, 'winner');
  assert.equal(result.details.winner, CANDIDATE_A);
  assert.deepEqual({ ...result.details.counts }, { [CANDIDATE_A]: 1 });
  assert.equal(result.details.totalBallots, 2);
  assert.equal(result.details.abstainCount, 0);
  assert.equal(result.details.authorizesSpending, false, 'a decision record never moves money');
  // The final narration carries the outcome-shaped facts in one object: the recorded outcome, the
  // winning proposal with its stored title, the participation total and the abstention count. It is
  // model-relayed, and it still authorizes no spending.
  assert.deepEqual(result.details.narration, {
    kind: 'final',
    delivery: 'model_relayed',
    finalized: true,
    settled: true,
    pollId: POLL,
    candidateProposals: [
      { proposalId: CANDIDATE_A, title: 'Stored request aaaa' },
      { proposalId: CANDIDATE_B, title: 'Stored request bbbb' },
    ],
    candidateTitlesResolved: true,
    ambiguousCandidateTitles: [],
    record: 'decided',
    outcome: 'winner',
    winner: CANDIDATE_A,
    winnerTitle: 'Stored request aaaa',
    counts: { [CANDIDATE_A]: 1 },
    totalBallots: 2,
    abstainCount: 0,
    authorizesSpending: false,
    note: result.details.narration.note,
  });
  assert.equal(result.details.narration.settled, true);
  assert.equal(
    result.details.narration.official,
    undefined,
    'the narration claims a stored record, never adopted official standing',
  );
  // The note is the user-facing wording: it names the winner and the standing of the record, and it
  // carries no implementation term a reply could echo back at a director.
  assert.match(result.details.narration.note, /本轮投票已结束/);
  assert.ok(result.details.narration.note.includes('Stored request aaaa'), 'the winner is named by title');
  assert.match(result.details.narration.note, /不移动任何资金/);
  // The case-7 standard asks the closing explanation for the winner, the participation figure and
  // the outcome record, so the sentence a director hears carries the recorded totals too.
  assert.ok(
    result.details.narration.note.includes('2 位董事参与投票'),
    'the winner note names the recorded participation total',
  );
  assert.ok(
    result.details.narration.note.includes('0 位弃权'),
    'the winner note names the recorded abstention count',
  );
  // Case 7 asks for the winner and its count together, so the sentence names the count the winner
  // took, read from the recorded per-proposal counts, beside the recorded totals.
  assert.ok(
    result.details.narration.note.includes('本轮该候选人获得赞成 1 票。'),
    'the winner note names the recorded count the winner took',
  );
  assert.equal(
    result.details.narration.note,
    '本轮投票已结束，最高赞成票的候选人是：Stored request aaaa。本轮该候选人获得赞成 1 票。本轮有 2 位董事参与投票，其中 0 位弃权。这是一条决策记录，不移动任何资金。',
    'the winner note is the exact sentence the recorded counts produce',
  );
  for (const term of [
    'model-relayed',
    'model relayed',
    'tool',
    'narration',
    'delivery',
    'official',
    'schema',
    'field',
    'Slack',
    'finalized',
  ]) {
    assert.ok(
      !result.details.narration.note.toLowerCase().includes(term.toLowerCase()),
      `the final note must not carry the implementation term ${term}`,
    );
  }
  assert.ok(
    !JSON.stringify(result.details.narration).includes(CONTACT) &&
      !JSON.stringify(result.details.narration).includes(OTHER_CONTACT),
    'the final narration names no voter identity',
  );
  assert.deepEqual(
    calls.finalizePoll,
    [{ pollId: POLL, actorContactId: CONTACT }],
    'the finalizer is the resolved sender record and nothing else travels with the call',
  );
  assert.ok(!('weights' in calls.finalizePoll[0]), 'no weight is ever supplied by a caller');

  // A second call meets the recorded outcome and reports it unchanged instead of counting again.
  const repeat = await tool('rein_poll_result').execute('call-4', { pollId: POLL });
  assert.equal(repeat.details.ok, true);
  assert.equal(repeat.details.finalized, true);
  assert.equal(repeat.details.winner, CANDIDATE_A);
  assert.equal(calls.finalizePoll.length, 2, 'the repeat still asks the database for the record');
  assert.ok(!JSON.stringify(result.details).includes(CONTACT), 'the private contact id is not returned');
});

test('a tie or an all-abstain round reports the stored no-winner outcome rather than a winner', async () => {
  const cases = [
    {
      label: 'a tie',
      finalization: finalizeRecord({
        outcome: 'no_winner',
        winner: null,
        ballots: 2,
        abstentions: 0,
        approvals: [
          { proposalId: CANDIDATE_A, approvals: 1 },
          { proposalId: CANDIDATE_B, approvals: 1 },
        ],
      }),
    },
    {
      label: 'an all-abstain round',
      finalization: finalizeRecord({
        outcome: 'no_winner',
        winner: null,
        ballots: 2,
        abstentions: 2,
        approvals: [],
      }),
    },
  ];
  for (const { label, finalization } of cases) {
    const fakes = createFakes({
      member: director(),
      inserts: {
        finalizePoll: () => ({
          ok: true,
          status: 'inserted',
          reason: 'finalized',
          finalization,
          httpStatus: 200,
        }),
      },
    });
    const result = await build({ fakes, now: () => new Date('2026-09-24T11:30:00.000Z') })
      .tool('rein_poll_result')
      .execute('call-4', { pollId: POLL });
    assert.equal(result.details.outcome, 'no_winner', label);
    assert.equal(result.details.winner, null, `${label} must invent no winner`);
    assert.equal(result.details.official, true, `${label} is still a recorded outcome`);
    assert.equal(result.details.narration.outcome, 'no_winner', label);
    assert.equal(result.details.narration.winner, null, `${label} must narrate no winner`);
    assert.equal(result.details.narration.winnerTitle, null, `${label} must narrate no winning title`);
    assert.equal(result.details.narration.totalBallots, finalization.ballots, label);
    assert.equal(result.details.narration.abstainCount, finalization.abstentions, label);
    assert.equal(result.details.narration.authorizesSpending, false, label);
    assert.equal(result.details.narration.delivery, 'model_relayed', label);
    assert.equal(result.details.narration.record, 'decided', label);
    assert.equal(result.details.narration.settled, true, label);
    assert.equal(
      result.details.narration.note,
      '本轮投票已结束，记录的结果是无赢家，票数已按规则记录在案。' +
        `本轮有 ${finalization.ballots} 位董事参与投票，其中 ${finalization.abstentions} 位弃权。` +
        '请注意：平票如何处理的规则尚未确认，这条记录不代表组织已经通过或采纳了任何规则。' +
        '这是一条决策记录，不移动任何资金。',
      `${label} must be the exact neutral sentence the recorded counts produce`,
    );
    // The record cannot tell a tie from an all-abstain round - the stored finalization carries no tie
    // reason - so the sentence must state the recorded outcome without claiming a cause. Saying "no
    // candidate received the highest approval" would be false for a tie, where several candidates
    // share the highest approval, so that claim must never appear.
    assert.match(result.details.narration.note, /记录的结果是无赢家/, `${label} states the recorded outcome`);
    assert.ok(
      !result.details.narration.note.includes('没有候选人获得最高赞成票'),
      `${label} must not claim a cause the record cannot prove`,
    );
    for (const cause of ['平票时', '并列最高', '得票相同', '没有人投赞成票', '全员弃权']) {
      assert.ok(
        !result.details.narration.note.includes(cause),
        `${label} must not invent the cause ${cause}`,
      );
    }
    assert.ok(
      result.details.narration.note.includes(`${finalization.ballots} 位董事参与投票`),
      `${label} names the recorded participation total`,
    );
    assert.ok(
      result.details.narration.note.includes(`${finalization.abstentions} 位弃权`),
      `${label} names the recorded abstention count`,
    );
    assert.match(
      result.details.narration.note,
      /尚未确认/,
      `${label} must not read as an adopted governance rule`,
    );
    assert.match(
      result.details.narration.note,
      /不代表组织已经通过或采纳了任何规则/,
      `${label} must state the unconfirmed rule plainly`,
    );
    assert.match(result.details.narration.note, /不移动任何资金/, label);
    assert.ok(
      !result.details.narration.note.includes('Stored request'),
      `${label} must narrate no winning title`,
    );
    for (const term of ['official', 'tool', 'narration', 'delivery', 'model-relayed', 'Slack']) {
      assert.ok(
        !result.details.narration.note.toLowerCase().includes(term.toLowerCase()),
        `${label} note must not carry ${term}`,
      );
    }
    assert.deepEqual(
      { ...result.details.counts },
      Object.fromEntries(finalization.approvals.map(approval => [approval.proposalId, approval.approvals])),
      label,
    );
    assert.equal(result.details.abstainCount, finalization.abstentions, label);
    assert.equal(result.details.authorizesSpending, false, label);
  }
});

test('a repeated finalization reports the already-stored record and a refusal reports itself', async () => {
  const repeated = createFakes({
    member: director(),
    inserts: {
      finalizePoll: () => ({
        ok: true,
        status: 'existing',
        reason: 'existing_finalized',
        finalization: finalizeRecord({ repeated: true }),
        httpStatus: 200,
      }),
    },
  });
  const already = await build({ fakes: repeated, now: () => new Date('2026-09-24T11:30:00.000Z') })
    .tool('rein_poll_result')
    .execute('call-4', { pollId: POLL });
  assert.equal(already.details.ok, true);
  assert.equal(already.details.status, 'existing');
  assert.equal(already.details.reason, 'existing_finalized');
  assert.equal(already.details.repeated, true);
  assert.equal(already.details.winner, CANDIDATE_A, 'the recorded winner is reported again');

  // A refused finalization (for example a director who lost standing) is an error, never a result:
  // no outcome, no winner and no count is published from a failed call.
  const refused = createFakes({
    member: director(),
    inserts: {
      finalizePoll: () => ({
        ok: false,
        status: 'rejected',
        reason: 'finalize_rejected',
        finalization: null,
        httpStatus: 400,
      }),
    },
  });
  const refusal = await build({ fakes: refused, now: () => new Date('2026-09-24T11:30:00.000Z') })
    .tool('rein_poll_result')
    .execute('call-4', { pollId: POLL });
  assert.equal(refusal.details.ok, false);
  assert.equal(refusal.details.error, 'finalize_rejected');
  assert.equal(refusal.details.winner, undefined, 'a refused finalization names no winner at all');
  assert.equal(refusal.details.counts, undefined);
  assert.ok(!JSON.stringify(refusal.details).includes(SECRET));

  const down = createFakes({
    member: director(),
    inserts: {
      finalizePoll: () => ({
        ok: false,
        status: 'unavailable',
        reason: 'http_error',
        finalization: null,
        httpStatus: 503,
      }),
    },
  });
  const outage = await build({ fakes: down, now: () => new Date('2026-09-24T11:30:00.000Z') })
    .tool('rein_poll_result')
    .execute('call-4', { pollId: POLL });
  assert.equal(outage.details.error, 'http_error');
  assert.notEqual(outage.details.error, 'finalize_rejected', 'an outage is not a refusal');
});

test('the result read counts the stored ballots without re-evaluating voter eligibility', async () => {
  // The recorded ballots' voters are never re-checked against the roster, so a ballot stays valid
  // even after its voter later loses director status. Only the requesting director is resolved, and
  // the counted record is what the database stored rather than a roster this tool re-reads.
  const fakes = createFakes({
    member: director(),
    ballots: [ballotRecord({ voterContactId: OTHER_CONTACT, approvedProposalIds: [CANDIDATE_A] })],
    inserts: {
      finalizePoll: () => ({
        ok: true,
        status: 'inserted',
        reason: 'finalized',
        finalization: finalizeRecord({ ballots: 1 }),
        httpStatus: 200,
      }),
    },
  });
  const result = await build({ fakes, now: () => new Date('2026-09-24T11:30:00.000Z') })
    .tool('rein_poll_result')
    .execute('call-4', { pollId: POLL });
  assert.equal(result.details.totalBallots, 1);
  assert.equal(
    result.details.eligibleVoters,
    undefined,
    'the recorded ballots are not an electorate, so no eligible-voter figure is published',
  );
  assert.equal(result.details.totalBallots, 1, 'the accepted ballots are the recorded participation');
  assert.deepEqual(fakes.calls.member, [SENDER]);
  assert.equal(fakes.calls.getPoll.length, 1);
  // A finalized outcome carries the recorded ballot count, so no second ballot read is made.
  assert.deepEqual(fakes.calls.listBallots, [], 'a finalized round reads no ballot list');
  // The voters are never resolved: only the requesting sender is looked up.
  assert.deepEqual(fakes.calls.finalizePoll, [{ pollId: POLL, actorContactId: CONTACT }]);
});

test('the result tool refuses an unknown poll or an unusable identifier, and an open round reads no ballot', async () => {
  // An open round never reads the ballot rows, so a ballot reader that would fail changes nothing:
  // the provisional answer is still the window and the frozen candidates, with no total and no voter.
  const unreadableBallots = createFakes({ member: director(), now: () => new Date(NOW) });
  unreadableBallots.writer.listBallots = async () => ({
    ok: false,
    status: 'unavailable',
    reason: 'http_error',
    ballots: null,
    httpStatus: 503,
  });
  const provisional = await build({ fakes: unreadableBallots })
    .tool('rein_poll_result')
    .execute('call-4', { pollId: POLL });
  assert.equal(provisional.details.ok, false);
  assert.equal(provisional.details.status, 'provisional');
  assert.equal(provisional.details.reason, 'poll_still_open');
  assert.equal(provisional.details.winner, null);
  assert.equal(provisional.details.totalBallots, null, 'an open round publishes no participation total');
  assert.deepEqual(unreadableBallots.calls.listBallots, [], 'an open round never reads the ballot list');
  assert.deepEqual(unreadableBallots.calls.finalizePoll, [], 'an open round is never finalized');

  // A poll whose stored definition cannot be read is reported as missing rather than as an outage
  // that never happened, and a missing poll is never finalized either.
  const missing = createFakes({ member: director(), poll: null });
  const unknown = await build({ fakes: missing, now: () => new Date('2026-09-24T11:30:00.000Z') })
    .tool('rein_poll_result')
    .execute('call-4', { pollId: POLL });
  assert.equal(unknown.details.error, 'poll_not_found');
  assert.deepEqual(missing.calls.finalizePoll, []);

  // A poll read that fails is never reported as a missing poll: an outage is not a decision that was
  // never made.
  const unreadable = createFakes({ member: director() });
  unreadable.writer.getPoll = async () => ({
    ok: false,
    status: 'unavailable',
    reason: 'http_error',
    poll: null,
    httpStatus: 503,
  });
  const outage = await build({ fakes: unreadable, now: () => new Date('2026-09-24T11:30:00.000Z') })
    .tool('rein_poll_result')
    .execute('call-4', { pollId: POLL });
  assert.equal(outage.details.error, 'poll_lookup_unavailable');
  assert.deepEqual(unreadable.calls.finalizePoll, []);

  for (const pollId of [undefined, '', 'not-a-uuid']) {
    const fakes = createFakes({ member: director() });
    const result = await build({ fakes }).tool('rein_poll_result').execute('call-4', { pollId });
    assert.equal(result.details.error, 'poll_id_invalid', String(pollId));
    assert.deepEqual(fakes.calls.member, [], 'an unusable identifier never resolves an identity');
    assert.deepEqual(fakes.calls.getPoll, []);
    assert.deepEqual(fakes.calls.listBallots, []);
    assert.deepEqual(fakes.calls.finalizePoll, []);
  }
});

test('every write tool refuses an impersonation or role argument before any database call', async () => {
  const attempts = [
    ['rein_governance_proposal_submit', { voteType: VOTE_TYPE, title: 'Repair workshop', proposerContactId: 'x' }],
    ['rein_governance_proposal_submit', { voteType: VOTE_TYPE, title: 'Repair workshop', contactId: 'x' }],
    ['rein_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT, creatorContactId: 'x' }],
    ['rein_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT, role: 'director' }],
    ['rein_poll_vote', { pollId: POLL, approvedProposalIds: [], memberId: 'x' }],
    ['rein_poll_vote', { pollId: POLL, approvedProposalIds: [], weight: 3 }],
    ['rein_poll_result', { pollId: POLL, eligibleMemberIds: ['x'] }],
    ['rein_poll_result', { pollId: POLL, isDirector: true }],
  ];
  for (const [name, args] of attempts) {
    const fakes = createFakes({ member: director() });
    const result = await build({ fakes }).tool(name).execute('call-1', args);
    assert.equal(result.details.ok, false, name);
    assert.equal(result.details.error, 'actor_argument_rejected', name);
    assert.deepEqual(fakes.calls.member, [], `${name} must not resolve an identity from an argument`);
    assert.deepEqual(fakes.calls.submitProposal, []);
    assert.deepEqual(fakes.calls.createPoll, []);
    assert.deepEqual(fakes.calls.castBallot, []);
  }
});

test('every write tool refuses a non-Slack context or a missing trusted sender', async () => {
  for (const name of MVP_WRITE_TOOL_NAMES) {
    for (const [overrides, code] of [
      [{ messageChannel: 'discord' }, 'platform_out_of_scope'],
      [{ requesterSenderId: '   ' }, 'trusted_requester_unavailable'],
      [{ requesterSenderId: undefined }, 'trusted_requester_unavailable'],
      [{ nativeChannelId: 'C_OTHER' }, 'channel_out_of_scope'],
      [{ nativeChannelId: undefined }, 'channel_out_of_scope'],
    ]) {
      const fakes = createFakes({ member: director() });
      const { tool } = build({ fakes, ctx: overrides });
      const args =
        name === 'rein_governance_proposal_submit'
          ? { voteType: VOTE_TYPE, title: 'Repair workshop' }
          : name === 'rein_poll_open'
            ? { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT }
            : { pollId: POLL, approvedProposalIds: [] };
      const result = await tool(name).execute('call-1', args);
      assert.equal(result.details.ok, false, `${name} ${code}`);
      assert.equal(result.details.error, code);
      assert.deepEqual(fakes.calls.submitProposal, []);
      assert.deepEqual(fakes.calls.createPoll, []);
      assert.deepEqual(fakes.calls.castBallot, []);
    }
  }
});

test('a missing or stale host invocation guard produces no proposal and no round', async () => {
  const proposalFakes = createFakes();
  const buildTurn = () => build({
    fakes: proposalFakes,
    channel: PROPOSAL_CHANNEL,
    ctx: { assertInvocationCurrent: undefined },
  });
  const token = await prepareProposal(buildTurn().tool('rein_governance_proposal_submit'), 'call-1', {
    voteType: VOTE_TYPE,
    title: 'Repair workshop',
  });
  const proposal = await confirmProposal(
    buildTurn().tool('rein_governance_proposal_submit'),
    'call-1',
    { voteType: VOTE_TYPE, title: 'Repair workshop' },
    token,
  );
  assert.equal(proposal.details.error, 'current_invocation_guard_unavailable');
  assert.deepEqual(proposalFakes.calls.submitProposal, [], 'no proposal is written without the guard');

  const pollFakes = createFakes({ member: director() });
  const poll = await build({
    fakes: pollFakes,
    ctx: {
      assertInvocationCurrent() {
        throw Object.assign(new Error('turn closed'), { code: 'invocation_not_current' });
      },
    },
  })
    .tool('rein_poll_open')
    .execute('call-2', { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT });
  assert.equal(poll.details.error, 'invocation_not_current');
  assert.deepEqual(pollFakes.calls.createPoll, [], 'a stale turn cannot open a round');
});

test('a missing host tool call id is refused instead of inventing a record identifier', async () => {
  for (const [name, channel, args] of [
    ['rein_governance_proposal_submit', PROPOSAL_CHANNEL, { voteType: VOTE_TYPE, title: 'Repair workshop' }],
    ['rein_poll_open', BOARD_CHANNEL, { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT }],
  ]) {
    for (const toolCallId of [undefined, '', '   ']) {
      const fakes = createFakes({ member: director() });
      const { tool } = build({ fakes, channel });
      // The proposal needs a confirmation token from an earlier turn to reach the write, so it is
      // prepared with a real call id in its own turn; the confirm turn then carries the unusable id
      // under test, and each iteration resolves a fresh pair of turns so nothing is carried over.
      const preparedToken = name === 'rein_governance_proposal_submit'
        ? await prepareProposal(build({ fakes, channel }).tool(name), 'call-prepare', args)
        : null;
      const confirmTurn = build({ fakes, channel });
      const submitArgs = preparedToken
        ? { ...args, confirmationToken: preparedToken, confirmPronouncedByAuthor: true }
        : args;
      const result = await confirmTurn.tool(name).execute(toolCallId, submitArgs);
      assert.equal(result.details.error, 'tool_call_id_required', `${name} ${String(toolCallId)}`);
      assert.deepEqual(fakes.calls.submitProposal, []);
      assert.deepEqual(fakes.calls.createPoll, []);
    }
  }
});

test('no tool result leaks the private contact ids, the team id or a secret', async () => {
  const fakes = createFakes({ member: director() });
  const board = build({ fakes, now: () => new Date(NOW) });
  const proposalFakes = createFakes({ member: director() });
  const proposal = build({ fakes: proposalFakes, channel: PROPOSAL_CHANNEL });
  const outputs = [
    await proposal.tool('rein_governance_proposal_submit').execute('call-1', {
      voteType: VOTE_TYPE,
      title: 'Repair workshop',
      requestedMinor: 1,
      currency: 'USD',
    }),
    await board.tool('rein_poll_open').execute('call-2', {
      voteType: VOTE_TYPE,
      title: 'Poll',
      closesAt: CLOSES_AT,
    }),
    await board.tool('rein_poll_vote').execute('call-3', { pollId: POLL, approvedProposalIds: [CANDIDATE_A] }),
    await board.tool('rein_poll_result').execute('call-4', { pollId: POLL }),
  ];
  const serialized = JSON.stringify(outputs.map(output => output.details));
  for (const secret of [CONTACT, OTHER_CONTACT, TEAM, SECRET, 'project-ref.supabase.co', SENDER]) {
    assert.ok(!serialized.includes(secret), `the result must not include ${secret}`);
  }
  assert.ok(!serialized.includes('contactId'));
  assert.ok(!serialized.toLowerCase().includes('authorizesspending": true'));
});
