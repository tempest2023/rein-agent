import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MVP_WRITE_TOOL_NAMES,
  createMvpWriteToolRegistration,
} from '../plugins/rein-operations/mvp-write-tools.ts';

// Focused fake-reader and fake-writer tests for the two wiring paths this slice implements:
// `rein_mvp_proposal_submit` and `rein_mvp_poll_open`. No live database or Slack call is made. The
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
const SECRET = 'sb_secret_unit_test_0000000000000000';
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
  candidates = [candidateRecord(CANDIDATE_A), candidateRecord(CANDIDATE_B)],
  inserts,
} = {}) {
  const calls = {
    member: [],
    submitProposal: [],
    createPoll: [],
    castBallot: [],
    getPoll: [],
    listBallots: [],
    getVoteType: [],
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

// ---------------------------------------------------------------------------------------------
// Registration contract
// ---------------------------------------------------------------------------------------------

test('no MVP write tool registers without an explicit enabled block', () => {
  for (const config of [undefined, {}, { enabled: false }, { enabled: 'true' }]) {
    const fakes = createFakes();
    const registration = createMvpWriteToolRegistration({ config, reader: fakes.reader, writer: fakes.writer });
    assert.equal(registration.create({ messageChannel: 'slack' }), null);
    assert.equal(registration.contextVersion, 2);
  }
  assert.deepEqual([...MVP_WRITE_TOOL_NAMES], [
    'rein_mvp_proposal_submit',
    'rein_mvp_poll_open',
    'rein_mvp_vote',
    'rein_mvp_poll_result',
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
      () => createMvpWriteToolRegistration({ config, reader: fakes.reader, writer: fakes.writer }),
      expected,
    );
  }

  // A writer missing the proposal, poll, vote type, candidate pool or finalize methods is not a
  // writer this slice can call, so registration refuses it instead of failing at the first write.
  for (const missing of [
    'submitProposal',
    'createPoll',
    'getVoteType',
    'listCandidateProposals',
    'finalizePoll',
  ]) {
    const partial = { ...fakes.writer, [missing]: undefined };
    assert.throws(
      () => createMvpWriteToolRegistration({ config: baseConfig, reader: fakes.reader, writer: partial }),
      /must implement submitProposal, createPoll, getPoll, listBallots, castBallot, getVoteType, listCandidateProposals and finalizePoll/,
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

  const registration = createMvpWriteToolRegistration({
    config: baseConfig,
    env: { [URL_ENV]: 'https://project-ref.supabase.co', [KEY_ENV]: SECRET },
  });
  const tools = registration.create({
    messageChannel: 'slack',
    nativeChannelId: BOARD_CHANNEL,
    requesterSenderId: SENDER,
    assertInvocationCurrent() {},
  });
  assert.deepEqual(tools.map(tool => tool.name), [...MVP_WRITE_TOOL_NAMES]);
  assert.ok(!JSON.stringify(tools).includes(SECRET));
  assert.ok(!JSON.stringify(tools).includes('project-ref.supabase.co'));
});

// ---------------------------------------------------------------------------------------------
// rein_mvp_proposal_submit
// ---------------------------------------------------------------------------------------------

test('an active Contributor submits one proposal through a per-turn generated identifier', async () => {
  const fakes = createFakes();
  const { tool, calls, guard } = build({ fakes, channel: PROPOSAL_CHANNEL });

  const result = await tool('rein_mvp_proposal_submit').execute('call-1', {
    voteType: VOTE_TYPE,
    title: 'Repair workshop',
    summary: 'Fix the roof tiles',
    requestedMinor: 125000,
    currency: 'usd',
  });

  assert.equal(result.details.ok, true);
  assert.equal(result.details.status, 'inserted');
  assert.equal(result.details.recorded, true);
  assert.equal(result.details.authorizesSpending, false);
  assert.deepEqual(calls.member, [SENDER]);
  assert.equal(calls.submitProposal.length, 1);
  const sent = calls.submitProposal[0];
  assert.match(sent.id, UUID_V4, 'the record identifier is a fresh v4 UUID, never an argument');
  assert.equal(sent.proposerContactId, CONTACT, 'the proposer is the resolved sender record');
  assert.equal(sent.voteType, VOTE_TYPE);
  assert.equal(sent.title, 'Repair workshop');
  assert.equal(sent.summary, 'Fix the roof tiles');
  assert.equal(sent.requestedMinor, 125000);
  assert.equal(sent.currency, 'USD', 'a currency code is normalized to upper case');
  assert.equal(result.details.proposalId, sent.id);
  assert.equal(guard.calls, 1, 'the invocation guard runs once before the write');
  assert.ok(!result.content[0].text.includes(CONTACT), 'the private contact id is not returned');
});

test('one turn reuses its identifier on a retry, and a later turn mints a new one', async () => {
  const fakes = createFakes();
  const { tool, calls } = build({ fakes, channel: PROPOSAL_CHANNEL });

  // A host retry of the same invocation reaches `execute` twice inside one `create(ctx)`.
  await tool('rein_mvp_proposal_submit').execute('call-9', { voteType: VOTE_TYPE, title: 'Repair workshop' });
  await tool('rein_mvp_proposal_submit').execute('call-9', { voteType: VOTE_TYPE, title: 'Repair workshop' });

  assert.equal(calls.submitProposal.length, 2);
  assert.equal(calls.submitProposal[0].id, calls.submitProposal[1].id, 'a same-turn retry is stable');

  // A later turn starts from an empty map, so a host that resets the call id cannot collide with an
  // earlier record.
  const second = createFakes();
  await build({ fakes: second, channel: PROPOSAL_CHANNEL })
    .tool('rein_mvp_proposal_submit')
    .execute('call-9', { voteType: VOTE_TYPE, title: 'Repair workshop' });
  assert.notEqual(calls.submitProposal[0].id, second.calls.submitProposal[0].id, 'a new turn is a new record');
});

test('identifiers are independent of the acting contact and the arguments', async () => {
  const sameActor = createFakes();
  const otherActor = createFakes({ member: contributor({ contactId: OTHER_CONTACT }) });
  await build({ fakes: sameActor, channel: PROPOSAL_CHANNEL })
    .tool('rein_mvp_proposal_submit')
    .execute('call-9', { voteType: VOTE_TYPE, title: 'Repair workshop' });
  await build({ fakes: otherActor, channel: PROPOSAL_CHANNEL })
    .tool('rein_mvp_proposal_submit')
    .execute('call-9', { voteType: VOTE_TYPE, title: 'Another title' });
  assert.notEqual(sameActor.calls.submitProposal[0].id, otherActor.calls.submitProposal[0].id);
});

test('the proposal tool refuses an unlinked, inactive or non-Contributor sender without writing', async () => {
  const refusal = async (member) => {
    const fakes = createFakes({ member });
    const { tool, calls, guard } = build({ fakes, channel: PROPOSAL_CHANNEL });
    const result = await tool('rein_mvp_proposal_submit').execute('call-1', {
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
    'identity_link_required',
    'a failed lookup is not an eligibility pass',
  );
});

test('the proposal tool is limited to the approved proposal channels and ignores a Board channel', async () => {
  const fakes = createFakes();
  const { tool, calls } = build({ fakes, ctx: { nativeChannelId: BOARD_CHANNEL } });
  const result = await tool('rein_mvp_proposal_submit').execute('call-1', {
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
    const result = await tool('rein_mvp_proposal_submit').execute('call-1', { voteType, title: 'Repair workshop' });
    assert.equal(result.details.ok, false, String(voteType));
    assert.equal(result.details.error, 'vote_type_invalid', String(voteType));
    assert.deepEqual(calls.member, [], 'the arguments are refused before the identity lookup');
    assert.deepEqual(calls.submitProposal, [], 'an unusable vote type is never stored');
    assert.equal(guard.calls, 0);
  }
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
    const result = await tool('rein_mvp_proposal_submit').execute('call-1', {
      voteType: VOTE_TYPE,
      title: 'Repair workshop',
      ...extra,
    });
    assert.equal(result.details.ok, false, JSON.stringify(extra));
    assert.equal(result.details.error, expected, JSON.stringify(extra));
    assert.deepEqual(calls.submitProposal, []);
  }

  // A proposal without an amount is still a valid request, and no answer claims it was approved.
  const fakes = createFakes();
  const { tool } = build({ fakes, channel: PROPOSAL_CHANNEL });
  const result = await tool('rein_mvp_proposal_submit').execute('call-1', {
    voteType: VOTE_TYPE,
    title: 'Repair workshop',
  });
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
  const rejection = await build({ fakes: refused, channel: PROPOSAL_CHANNEL })
    .tool('rein_mvp_proposal_submit')
    .execute('call-1', { voteType: VOTE_TYPE, title: 'Repair workshop' });
  assert.equal(rejection.details.ok, false);
  assert.equal(rejection.details.error, 'proposal_rejected');
  assert.equal(rejection.details.recorded, false);

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
  const outage = await build({ fakes: down, channel: PROPOSAL_CHANNEL })
    .tool('rein_mvp_proposal_submit')
    .execute('call-1', { voteType: VOTE_TYPE, title: 'Repair workshop' });
  assert.equal(outage.details.error, 'http_error');
  assert.notEqual(outage.details.error, 'proposal_rejected', 'an outage is not a refusal');
});

test('a reused identifier with changed content is a conflict, never a second proposal', async () => {
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
  const { tool, calls } = build({ fakes, channel: PROPOSAL_CHANNEL });

  const first = await tool('rein_mvp_proposal_submit').execute('call-1', {
    voteType: VOTE_TYPE,
    title: 'Repair workshop',
  });
  const second = await tool('rein_mvp_proposal_submit').execute('call-1', {
    voteType: VOTE_TYPE,
    title: 'Something else entirely',
  });

  assert.equal(first.details.ok, true);
  assert.equal(second.details.ok, false);
  assert.equal(second.details.error, 'proposal_conflict');
  assert.equal(second.details.status, 'conflict');
  assert.equal(calls.submitProposal[0].id, calls.submitProposal[1].id, 'the retry meets the record it wrote');
});

// ---------------------------------------------------------------------------------------------
// rein_mvp_poll_open
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

  const result = await tool('rein_mvp_poll_open').execute('call-2', {
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
  assert.equal(guard.calls, 1, 'the invocation guard runs once before the write');
  assert.ok(!JSON.stringify(result.details).includes(CONTACT), 'the private contact id is not returned');
  assert.ok(!JSON.stringify(result.details).includes('options'), 'no option label is invented for the round');
});

test('an optional submittedSince narrows the pool and a malformed one opens nothing', async () => {
  const fakes = createFakes({ member: director() });
  const { tool, calls } = build({ fakes });
  const since = '2026-09-01T00:00:00Z';

  const accepted = await tool('rein_mvp_poll_open').execute('call-2', {
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
    const result = await build({ fakes: bad }).tool('rein_mvp_poll_open').execute('call-2', {
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
  const opened = await build({ fakes: single }).tool('rein_mvp_poll_open').execute('call-2', {
    voteType: VOTE_TYPE,
    title: 'Fund the single request?',
    closesAt: CLOSES_AT,
  });
  assert.equal(opened.details.ok, true);
  assert.deepEqual(opened.details.candidateProposalIds, [CANDIDATE_A]);
  assert.equal(opened.details.candidateCount, 1);

  const empty = createFakes({ member: director(), candidates: [] });
  const refused = await build({ fakes: empty }).tool('rein_mvp_poll_open').execute('call-2', {
    voteType: VOTE_TYPE,
    title: 'Fund nothing?',
    closesAt: CLOSES_AT,
  });
  assert.equal(refused.details.ok, false);
  assert.equal(refused.details.error, 'no_candidate_proposals');
  assert.deepEqual(empty.calls.createPoll, [], 'a round without a candidate is never stored');
});

test('an unknown or unreadable vote type opens nothing and is never guessed', async () => {
  const unknown = createFakes({ member: director() });
  const unknownResult = await build({ fakes: unknown }).tool('rein_mvp_poll_open').execute('call-2', {
    voteType: 'something_else',
    title: 'Fund something?',
    closesAt: CLOSES_AT,
  });
  assert.equal(unknownResult.details.error, 'vote_type_not_found');
  assert.deepEqual(unknown.calls.listCandidateProposals, [], 'no pool is read for a type with no rule');
  assert.deepEqual(unknown.calls.createPoll, []);

  const down = createFakes({
    member: director(),
    inserts: {
      getVoteType: () => ({ ok: false, status: 'unavailable', reason: 'http_error', voteType: null, httpStatus: 503 }),
    },
  });
  const downResult = await build({ fakes: down }).tool('rein_mvp_poll_open').execute('call-2', {
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
  const poolResult = await build({ fakes: poolDown }).tool('rein_mvp_poll_open').execute('call-2', {
    voteType: VOTE_TYPE,
    title: 'Fund the repair workshop?',
    closesAt: CLOSES_AT,
  });
  assert.equal(poolResult.details.error, 'candidate_pool_unavailable');
  assert.deepEqual(poolDown.calls.createPoll, []);
});

test('opening a poll refuses a non-director and an out-of-scope channel without writing', async () => {
  for (const member of [
    contributor(),
    contributor({ status: 'identity_not_linked', reason: 'identity_not_linked', contactId: null, isActiveContributor: false }),
    contributor({ status: 'identity_link_revoked', reason: 'identity_link_revoked', contactId: null, isActiveContributor: false }),
    contributor({ status: 'unavailable', reason: 'transport_error', contactId: null, isActiveContributor: false }),
  ]) {
    const fakes = createFakes({ member });
    const { tool, calls } = build({ fakes });
    const result = await tool('rein_mvp_poll_open').execute('call-2', {
      voteType: VOTE_TYPE,
      title: 'Fund the repair workshop?',
      closesAt: CLOSES_AT,
    });
    assert.equal(result.details.ok, false);
    assert.ok(['identity_link_required', 'board_membership_required'].includes(result.details.error));
    assert.deepEqual(calls.getVoteType, [], 'a refused caller never reaches the type rule');
    assert.deepEqual(calls.createPoll, [], 'a non-director never reaches the poll write');
  }

  const fakes = createFakes({ member: director() });
  const { tool, calls } = build({ fakes, channel: PROPOSAL_CHANNEL });
  const result = await tool('rein_mvp_poll_open').execute('call-2', {
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
    const result = await tool('rein_mvp_poll_open').execute('call-2', {
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
    ['rein_mvp_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT, candidateProposalIds: [CANDIDATE_A] }],
    ['rein_mvp_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT, candidateLimit: 50 }],
    ['rein_mvp_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT, maxCandidates: 50 }],
    ['rein_mvp_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT, limit: 50 }],
    ['rein_mvp_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT, options: ['approve', 'reject'] }],
    ['rein_mvp_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT, opensAt: NOW }],
    ['rein_mvp_proposal_submit', { voteType: VOTE_TYPE, title: 'Repair workshop', candidateProposalIds: [CANDIDATE_A] }],
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
// `rein_mvp_vote`: one immutable ballot per director
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

  const first = await tool('rein_mvp_vote').execute('call-3', {
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
  const replay = await build({ fakes: replayFakes }).tool('rein_mvp_vote').execute('call-3', {
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
  const accepted = await build({ fakes: multi }).tool('rein_mvp_vote').execute('call-3', {
    pollId: POLL,
    approvedProposalIds: [CANDIDATE_A, CANDIDATE_B],
  });
  assert.equal(accepted.details.ok, true);
  assert.equal(accepted.details.approvalCount, 2);
  assert.deepEqual(multi.calls.castBallot[0].approvedProposalIds, [CANDIDATE_A, CANDIDATE_B]);

  // Exceeding the frozen per-voter budget is refused before any write.
  const overBudget = createFakes({ member: director(), poll: pollRecord({ maxApprovalsPerVoter: 1 }) });
  const tooMany = await build({ fakes: overBudget }).tool('rein_mvp_vote').execute('call-3', {
    pollId: POLL,
    approvedProposalIds: [CANDIDATE_A, CANDIDATE_B],
  });
  assert.equal(tooMany.details.error, 'too_many_approvals');
  assert.deepEqual(overBudget.calls.castBallot, []);

  // Approving a proposal outside this poll's candidate list is refused before any write.
  const offList = createFakes({ member: director(), poll: pollRecord({ maxApprovalsPerVoter: 2 }) });
  const notCandidate = await build({ fakes: offList }).tool('rein_mvp_vote').execute('call-3', {
    pollId: POLL,
    approvedProposalIds: [CANDIDATE_A, CANDIDATE_D],
  });
  assert.equal(notCandidate.details.error, 'approved_proposal_not_in_poll');
  assert.deepEqual(offList.calls.castBallot, []);

  // A repeated candidate inside one ballot is a malformed list, not a double count.
  const repeated = createFakes({ member: director(), poll: pollRecord({ maxApprovalsPerVoter: 2 }) });
  const duplicate = await build({ fakes: repeated }).tool('rein_mvp_vote').execute('call-3', {
    pollId: POLL,
    approvedProposalIds: [CANDIDATE_A, CANDIDATE_A],
  });
  assert.equal(duplicate.details.error, 'approved_proposal_ids_invalid');
  assert.deepEqual(repeated.calls.castBallot, []);

  // A non-uuid entry is the same malformed refusal.
  const malformed = createFakes({ member: director(), poll: pollRecord({ maxApprovalsPerVoter: 2 }) });
  const notId = await build({ fakes: malformed }).tool('rein_mvp_vote').execute('call-3', {
    pollId: POLL,
    approvedProposalIds: ['approve'],
  });
  assert.equal(notId.details.error, 'approved_proposal_ids_invalid');
  assert.deepEqual(malformed.calls.castBallot, []);
});

test('an empty approval list is the abstention and an omitted one is the same', async () => {
  const explicit = createFakes({ member: director() });
  const result = await build({ fakes: explicit }).tool('rein_mvp_vote').execute('call-3', {
    pollId: POLL,
    approvedProposalIds: [],
  });
  assert.equal(result.details.ok, true);
  assert.equal(result.details.abstained, true);
  assert.equal(result.details.approvalCount, 0);
  assert.deepEqual(explicit.calls.castBallot[0].approvedProposalIds, []);

  const omitted = createFakes({ member: director() });
  const omittedResult = await build({ fakes: omitted }).tool('rein_mvp_vote').execute('call-3', { pollId: POLL });
  assert.equal(omittedResult.details.ok, true);
  assert.equal(omittedResult.details.abstained, true);
  assert.deepEqual(omitted.calls.castBallot[0].approvedProposalIds, []);
});

test('an abstention is available even when the poll approval budget would refuse an approval', async () => {
  // `maxApprovalsPerVoter` only bounds approvals; approving nothing is always allowed.
  const fakes = createFakes({ member: director(), poll: pollRecord({ maxApprovalsPerVoter: 1 }) });
  const result = await build({ fakes }).tool('rein_mvp_vote').execute('call-3', {
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
    .tool('rein_mvp_vote')
    .execute('call-3', { pollId: POLL, approvedProposalIds: [CANDIDATE_A] });
  assert.equal(closedResult.details.error, 'poll_closed');
  assert.deepEqual(closed.calls.castBallot, []);

  // Before the opening instant a ballot is premature, not late.
  const early = createFakes({ member: director() });
  const earlyResult = await build({ fakes: early, now: () => new Date('2026-09-24T09:59:00.000Z') })
    .tool('rein_mvp_vote')
    .execute('call-3', { pollId: POLL, approvedProposalIds: [CANDIDATE_A] });
  assert.equal(earlyResult.details.error, 'poll_not_open');
  assert.deepEqual(early.calls.castBallot, []);

  // A stored poll the database already closed refuses a ballot even inside the clock window.
  const statusClosed = createFakes({ member: director(), poll: pollRecord({ status: 'closed' }) });
  const statusClosedResult = await build({ fakes: statusClosed })
    .tool('rein_mvp_vote')
    .execute('call-3', { pollId: POLL, approvedProposalIds: [CANDIDATE_A] });
  assert.equal(statusClosedResult.details.error, 'poll_closed');
  assert.deepEqual(statusClosed.calls.castBallot, []);

  const cancelled = createFakes({ member: director(), poll: pollRecord({ status: 'cancelled' }) });
  const cancelledResult = await build({ fakes: cancelled })
    .tool('rein_mvp_vote')
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
  const result = await build({ fakes }).tool('rein_mvp_vote').execute('call-3', {
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
    .tool('rein_mvp_vote')
    .execute('call-3', { pollId: POLL, approvedProposalIds: [CANDIDATE_A] });
  assert.equal(unknownResult.details.error, 'poll_not_found');
  assert.deepEqual(unknown.calls.castBallot, []);

  // A read that fails for a transport or HTTP reason is an outage, never a missing poll.
  for (const status of ['unavailable', 'invalid_request']) {
    const down = createFakes({ member: director() });
    down.writer.getPoll = async () => ({ ok: false, status, reason: 'http_error', poll: null, httpStatus: 503 });
    const downResult = await build({ fakes: down })
      .tool('rein_mvp_vote')
      .execute('call-3', { pollId: POLL, approvedProposalIds: [CANDIDATE_A] });
    assert.equal(downResult.details.error, 'poll_lookup_unavailable', status);
    assert.notEqual(downResult.details.error, 'poll_not_found', 'an outage must not read as a missing poll');
    assert.deepEqual(down.calls.castBallot, []);
  }

  for (const member of [
    contributor(),
    contributor({ status: 'identity_not_linked', reason: 'identity_not_linked', contactId: null, isActiveContributor: false }),
    contributor({ status: 'unavailable', reason: 'transport_error', contactId: null, isActiveContributor: false }),
  ]) {
    const fakes = createFakes({ member });
    const result = await build({ fakes }).tool('rein_mvp_vote').execute('call-3', {
      pollId: POLL,
      approvedProposalIds: [CANDIDATE_A],
    });
    assert.equal(result.details.ok, false);
    assert.ok(['identity_link_required', 'board_membership_required'].includes(result.details.error));
    assert.deepEqual(fakes.calls.getPoll, [], 'a refused caller never reaches the poll read');
    assert.deepEqual(fakes.calls.castBallot, []);
  }

  const outOfScope = createFakes({ member: director() });
  const channelResult = await build({ fakes: outOfScope, ctx: { nativeChannelId: PROPOSAL_CHANNEL } })
    .tool('rein_mvp_vote')
    .execute('call-3', { pollId: POLL, approvedProposalIds: [CANDIDATE_A] });
  assert.equal(channelResult.details.error, 'channel_out_of_scope');
  assert.deepEqual(outOfScope.calls.member, []);
  assert.deepEqual(outOfScope.calls.castBallot, []);
});

test('a vote requires a canonical poll identifier before any database call', async () => {
  for (const pollId of [undefined, '', 'not-a-uuid']) {
    const fakes = createFakes({ member: director() });
    const result = await build({ fakes }).tool('rein_mvp_vote').execute('call-3', {
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
  const result = await build({ fakes }).tool('rein_mvp_vote').execute('call-3', {
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
// `rein_mvp_poll_result`
// ---------------------------------------------------------------------------------------------

test('before the deadline the result is provisional: readable facts, no count and no winner', async () => {
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

  const pending = await tool('rein_mvp_poll_result').execute('call-4', { pollId: POLL });
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
  assert.equal(pending.details.totalBallots, 2, 'the readable ballot count is still a fact');
  assert.equal(pending.details.pollStatus, 'open');
  assert.equal(pending.details.closesAt, CLOSES_AT, 'the stored deadline is returned to the caller');
  assert.equal(pending.details.authorizesSpending, false);
  assert.deepEqual(calls.listBallots, [POLL]);
  assert.deepEqual(calls.finalizePoll, [], 'an open poll is never finalized');
  assert.equal(guard.calls, 1);
  assert.ok(!pending.content[0].text.includes(CONTACT), 'the private contact id is not returned');

  // The instant the window closes is already past the deadline, exactly as it is for a ballot.
  const atDeadline = createFakes({ member: director(), ballots });
  const boundary = await build({ fakes: atDeadline, now: () => new Date(CLOSES_AT) })
    .tool('rein_mvp_poll_result')
    .execute('call-4', { pollId: POLL });
  assert.equal(boundary.details.closed, true, 'the closing instant closes the round');
  assert.equal(boundary.details.finalized, true);
  assert.deepEqual(atDeadline.calls.finalizePoll, [{ pollId: POLL, actorContactId: CONTACT }]);

  // A cancelled round is over but is never finalized, so it holds no outcome to report.
  const cancelledFakes = createFakes({ member: director(), poll: pollRecord({ status: 'cancelled' }) });
  const cancelled = await build({ fakes: cancelledFakes, now: () => new Date(NOW) })
    .tool('rein_mvp_poll_result')
    .execute('call-4', { pollId: POLL });
  assert.equal(cancelled.details.ok, false);
  assert.equal(cancelled.details.reason, 'poll_not_open');
  assert.equal(cancelled.details.closed, true);
  assert.equal(cancelled.details.official, false);
  assert.equal(cancelled.details.outcome, null, 'a cancelled round names no outcome');
  assert.deepEqual(cancelledFakes.calls.finalizePoll, [], 'a cancelled round is never finalized');
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
    .tool('rein_mvp_poll_result')
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
    .tool('rein_mvp_poll_result')
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

  const result = await tool('rein_mvp_poll_result').execute('call-4', { pollId: POLL });
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
  assert.deepEqual(
    calls.finalizePoll,
    [{ pollId: POLL, actorContactId: CONTACT }],
    'the finalizer is the resolved sender record and nothing else travels with the call',
  );
  assert.ok(!('weights' in calls.finalizePoll[0]), 'no weight is ever supplied by a caller');

  // A second call meets the recorded outcome and reports it unchanged instead of counting again.
  const repeat = await tool('rein_mvp_poll_result').execute('call-4', { pollId: POLL });
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
      .tool('rein_mvp_poll_result')
      .execute('call-4', { pollId: POLL });
    assert.equal(result.details.outcome, 'no_winner', label);
    assert.equal(result.details.winner, null, `${label} must invent no winner`);
    assert.equal(result.details.official, true, `${label} is still a recorded outcome`);
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
    .tool('rein_mvp_poll_result')
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
    .tool('rein_mvp_poll_result')
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
    .tool('rein_mvp_poll_result')
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
    .tool('rein_mvp_poll_result')
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

test('the result tool refuses a failed ballot read, an unknown poll or an unusable identifier', async () => {
  // An open poll whose ballots cannot be read is refused before any finalization is attempted.
  const failed = createFakes({ member: director(), now: () => new Date(NOW) });
  failed.writer.listBallots = async () => ({
    ok: false,
    status: 'unavailable',
    reason: 'http_error',
    ballots: null,
    httpStatus: 503,
  });
  const failedResult = await build({ fakes: failed })
    .tool('rein_mvp_poll_result')
    .execute('call-4', { pollId: POLL });
  assert.equal(failedResult.details.ok, false);
  assert.equal(failedResult.details.error, 'result_unavailable');
  assert.equal(failedResult.details.winner, undefined, 'an error answer names no winner at all');
  assert.deepEqual(failed.calls.finalizePoll, [], 'an unreadable round is never finalized');

  // A poll whose stored definition cannot be read is reported as missing rather than as an outage
  // that never happened, and a missing poll is never finalized either.
  const missing = createFakes({ member: director(), poll: null });
  const unknown = await build({ fakes: missing, now: () => new Date('2026-09-24T11:30:00.000Z') })
    .tool('rein_mvp_poll_result')
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
    .tool('rein_mvp_poll_result')
    .execute('call-4', { pollId: POLL });
  assert.equal(outage.details.error, 'poll_lookup_unavailable');
  assert.deepEqual(unreadable.calls.finalizePoll, []);

  for (const pollId of [undefined, '', 'not-a-uuid']) {
    const fakes = createFakes({ member: director() });
    const result = await build({ fakes }).tool('rein_mvp_poll_result').execute('call-4', { pollId });
    assert.equal(result.details.error, 'poll_id_invalid', String(pollId));
    assert.deepEqual(fakes.calls.member, [], 'an unusable identifier never resolves an identity');
    assert.deepEqual(fakes.calls.getPoll, []);
    assert.deepEqual(fakes.calls.listBallots, []);
    assert.deepEqual(fakes.calls.finalizePoll, []);
  }
});

test('every write tool refuses an impersonation or role argument before any database call', async () => {
  const attempts = [
    ['rein_mvp_proposal_submit', { voteType: VOTE_TYPE, title: 'Repair workshop', proposerContactId: 'x' }],
    ['rein_mvp_proposal_submit', { voteType: VOTE_TYPE, title: 'Repair workshop', contactId: 'x' }],
    ['rein_mvp_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT, creatorContactId: 'x' }],
    ['rein_mvp_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT, role: 'director' }],
    ['rein_mvp_vote', { pollId: POLL, approvedProposalIds: [], memberId: 'x' }],
    ['rein_mvp_vote', { pollId: POLL, approvedProposalIds: [], weight: 3 }],
    ['rein_mvp_poll_result', { pollId: POLL, eligibleMemberIds: ['x'] }],
    ['rein_mvp_poll_result', { pollId: POLL, isDirector: true }],
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
        name === 'rein_mvp_proposal_submit'
          ? { voteType: VOTE_TYPE, title: 'Repair workshop' }
          : name === 'rein_mvp_poll_open'
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
  const proposal = await build({
    fakes: proposalFakes,
    channel: PROPOSAL_CHANNEL,
    ctx: { assertInvocationCurrent: undefined },
  })
    .tool('rein_mvp_proposal_submit')
    .execute('call-1', { voteType: VOTE_TYPE, title: 'Repair workshop' });
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
    .tool('rein_mvp_poll_open')
    .execute('call-2', { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT });
  assert.equal(poll.details.error, 'invocation_not_current');
  assert.deepEqual(pollFakes.calls.createPoll, [], 'a stale turn cannot open a round');
});

test('a missing host tool call id is refused instead of inventing a record identifier', async () => {
  for (const [name, channel, args] of [
    ['rein_mvp_proposal_submit', PROPOSAL_CHANNEL, { voteType: VOTE_TYPE, title: 'Repair workshop' }],
    ['rein_mvp_poll_open', BOARD_CHANNEL, { voteType: VOTE_TYPE, title: 'Poll', closesAt: CLOSES_AT }],
  ]) {
    for (const toolCallId of [undefined, '', '   ']) {
      const fakes = createFakes({ member: director() });
      const { tool } = build({ fakes, channel });
      const result = await tool(name).execute(toolCallId, args);
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
    await proposal.tool('rein_mvp_proposal_submit').execute('call-1', {
      voteType: VOTE_TYPE,
      title: 'Repair workshop',
      requestedMinor: 1,
      currency: 'USD',
    }),
    await board.tool('rein_mvp_poll_open').execute('call-2', {
      voteType: VOTE_TYPE,
      title: 'Poll',
      closesAt: CLOSES_AT,
    }),
    await board.tool('rein_mvp_vote').execute('call-3', { pollId: POLL, approvedProposalIds: [CANDIDATE_A] }),
    await board.tool('rein_mvp_poll_result').execute('call-4', { pollId: POLL }),
  ];
  const serialized = JSON.stringify(outputs.map(output => output.details));
  for (const secret of [CONTACT, OTHER_CONTACT, TEAM, SECRET, 'project-ref.supabase.co', SENDER]) {
    assert.ok(!serialized.includes(secret), `the result must not include ${secret}`);
  }
  assert.ok(!serialized.includes('contactId'));
  assert.ok(!serialized.toLowerCase().includes('authorizesspending": true'));
});
