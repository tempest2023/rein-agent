import test from 'node:test';
import assert from 'node:assert/strict';
import { createFoundationDbWriter } from '../plugins/rein-operations/foundation-db-writer.ts';

// Fake-transport tests for the server-side Supabase writer. No live database is contacted: every
// request goes to an injected fetch that records the exact URL, method, body and headers, and the
// scripted handler decides whether the write is accepted or refused. The table contract under test
// is the phase-2 schema with `vote_type`, `candidate_proposal_ids` and `approved_proposal_ids`.

const SECRET = 'sb_secret_test_0000000000000000000000';
const BASE_URL = 'https://project-ref.supabase.co';
const PROPOSAL = '11111111-1111-4111-8111-111111111111';
const PROPOSAL_TWO = '12121212-1212-4212-8212-121212121212';
const POLL = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const VOTER = '44444444-4444-4444-8444-444444444444';
const BALLOT = '55555555-5555-4555-8555-555555555555';
const CREATED_AT = '2026-09-24T10:00:00+00:00';
const OPENS_AT = '2026-09-24T10:00:00+00:00';
const CLOSES_AT = '2026-09-24T11:00:00+00:00';
const CAST_AT = '2026-09-24T10:30:00+00:00';
const VOTE_TYPE = 'repair_budget';

function createFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace(/^\/rest\/v1\//, '');
    const call = {
      url,
      table,
      method: init.method,
      params: parsed.searchParams,
      init,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const handler = handlers[table];
    if (handler === undefined) throw new Error(`unexpected request for ${table}`);
    const value = typeof handler === 'function' ? handler(call) : handler;
    if (value instanceof Response) return value;
    // A plain array is a GET result list; an insert answer is `{ status, rows }`.
    if (Array.isArray(value)) {
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(value.rows), {
      status: value.status ?? 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

function writerFor(handlers, config = {}) {
  const { fetchImpl, calls } = createFetch(handlers);
  const writer = createFoundationDbWriter({
    supabaseUrl: BASE_URL,
    serviceRoleKey: SECRET,
    environment: 'dev',
    fetch: fetchImpl,
    ...config,
  });
  return { writer, calls };
}

const duplicate = (message = 'duplicate key value violates unique constraint') =>
  new Response(JSON.stringify({ message }), {
    status: 409,
    headers: { 'content-type': 'application/json' },
  });

const proposalRow = (overrides = {}) => ({
  id: PROPOSAL,
  proposer_contact_id: CONTACT,
  title: 'Repair workshop',
  summary: null,
  vote_type: VOTE_TYPE,
  requested_minor: null,
  currency: null,
  status: 'submitted',
  created_at: CREATED_AT,
  ...overrides,
});

const pollRow = (overrides = {}) => ({
  id: POLL,
  creator_contact_id: CONTACT,
  title: 'Approve the repair workshop?',
  vote_type: VOTE_TYPE,
  candidate_proposal_ids: [PROPOSAL],
  candidate_limit: 5,
  max_approvals_per_voter: 2,
  status: 'open',
  opens_at: OPENS_AT,
  closes_at: CLOSES_AT,
  created_at: CREATED_AT,
  ...overrides,
});

const ballotRow = (overrides = {}) => ({
  id: BALLOT,
  poll_id: POLL,
  voter_contact_id: VOTER,
  approved_proposal_ids: [PROPOSAL],
  cast_at: CAST_AT,
  ...overrides,
});

const voteTypeRow = (overrides = {}) => ({
  vote_type: VOTE_TYPE,
  max_candidates: 5,
  max_approvals_per_voter: 2,
  updated_at: CREATED_AT,
  ...overrides,
});

const proposalInput = (overrides = {}) => ({
  id: PROPOSAL,
  proposerContactId: CONTACT,
  title: 'Repair workshop',
  summary: 'Fix the roof tiles',
  voteType: VOTE_TYPE,
  requestedMinor: 125000,
  currency: 'USD',
  ...overrides,
});

const pollInput = (overrides = {}) => ({
  id: POLL,
  creatorContactId: CONTACT,
  title: 'Approve the repair workshop?',
  voteType: VOTE_TYPE,
  candidateProposalIds: [PROPOSAL],
  opensAt: OPENS_AT,
  closesAt: CLOSES_AT,
  ...overrides,
});

const ballotInput = (overrides = {}) => ({
  pollId: POLL,
  voterContactId: VOTER,
  approvedProposalIds: [PROPOSAL],
  ...overrides,
});

const REVISION = '77777777-7777-4777-8777-777777777777';
const APPROVER = '88888888-8888-4888-8888-888888888888';
const RECORDED_AT = '2026-09-24T12:00:00+00:00';

const revisionRow = (overrides = {}) => ({
  id: REVISION,
  proposal_id: PROPOSAL,
  version: null,
  author_contact_id: CONTACT,
  changed_fields: [],
  title: null,
  summary: null,
  requested_minor: null,
  currency: null,
  location: null,
  schedule: null,
  personnel: null,
  event_flow: null,
  note: 'Please re-check the roof pitch.',
  approved_by_contact_id: null,
  approved_at: null,
  recorded_at: RECORDED_AT,
  ...overrides,
});

const revisionInput = (overrides = {}) => ({
  id: REVISION,
  proposalId: PROPOSAL,
  authorContactId: CONTACT,
  changedFields: [],
  note: 'Please re-check the roof pitch.',
  ...overrides,
});

const appliedProposalRow = (overrides = {}) => ({
  id: PROPOSAL,
  status: 'selected',
  version: 2,
  effective_revision_id: REVISION,
  title: 'Repair workshop',
  summary: 'Fix the roof tiles',
  requested_minor: 140000,
  currency: 'USD',
  location: null,
  schedule: null,
  personnel: null,
  event_flow: null,
  ...overrides,
});

const finalizePayload = (overrides = {}) => ({
  poll_id: POLL,
  status: 'closed',
  repeated: false,
  outcome: 'winner',
  winning_proposal_id: PROPOSAL,
  finalized_by_contact_id: CONTACT,
  candidates: [PROPOSAL, PROPOSAL_TWO],
  proposals_recorded: 1,
  ballots: 3,
  abstentions: 1,
  approvals: { [PROPOSAL]: 2, [PROPOSAL_TWO]: 1 },
  ...overrides,
});

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const refused = (message = 'a governance rule was violated') =>
  new Response(JSON.stringify({ code: '23514', message }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });

test('a new proposal is inserted once with its vote type and returned as stored', async () => {
  const stored = proposalRow({
    summary: 'Fix the roof tiles',
    requested_minor: 125000,
    currency: 'USD',
  });
  const { writer, calls } = writerFor({ dev_rein_mvp_proposals: { status: 201, rows: [stored] } });

  const result = await writer.submitProposal(proposalInput());

  assert.deepEqual(result, {
    ok: true,
    status: 'inserted',
    reason: 'inserted',
    proposal: {
      id: PROPOSAL,
      proposerContactId: CONTACT,
      title: 'Repair workshop',
      summary: 'Fix the roof tiles',
      voteType: VOTE_TYPE,
      requestedMinor: 125000,
      currency: 'USD',
      status: 'submitted',
      createdAt: CREATED_AT,
    },
    httpStatus: 201,
    authorizesSpending: false,
  });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.table, 'dev_rein_mvp_proposals');
  assert.equal(call.init.headers.prefer, 'return=representation');
  assert.equal(call.init.headers['content-type'], 'application/json');
  assert.equal(call.init.headers.apikey, SECRET);
  assert.equal(call.init.headers.authorization, `Bearer ${SECRET}`);
  assert.deepEqual(call.body, {
    id: PROPOSAL,
    proposer_contact_id: CONTACT,
    title: 'Repair workshop',
    summary: 'Fix the roof tiles',
    vote_type: VOTE_TYPE,
    requested_minor: 125000,
    currency: 'USD',
  });
  assert.ok(!call.url.includes(SECRET), 'the key never appears in a URL');
});

test('a zero-budget proposal stores both request fields as null together', async () => {
  const { writer, calls } = writerFor({
    dev_rein_mvp_proposals: { status: 201, rows: [proposalRow()] },
  });

  const result = await writer.submitProposal(
    proposalInput({ summary: null, requestedMinor: null, currency: null }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].body, {
    id: PROPOSAL,
    proposer_contact_id: CONTACT,
    title: 'Repair workshop',
    summary: null,
    vote_type: VOTE_TYPE,
    requested_minor: null,
    currency: null,
  });
});

test('an identical duplicate proposal is the existing record, not a second one', async () => {
  const stored = proposalRow({ summary: 'Fix the roof tiles', requested_minor: 125000, currency: 'USD' });
  const { writer, calls } = writerFor({
    dev_rein_mvp_proposals: call => (call.method === 'POST' ? duplicate() : [stored]),
  });

  const result = await writer.submitProposal(proposalInput());

  assert.equal(result.ok, true);
  assert.equal(result.status, 'existing');
  assert.equal(result.reason, 'existing_identical');
  assert.equal(result.proposal.id, PROPOSAL);
  assert.equal(result.authorizesSpending, false);
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);
  assert.equal(calls[1].params.get('id'), `eq.${PROPOSAL}`);
});

test('a duplicate proposal whose immutable fields changed is a conflict, never a replacement', async (t) => {
  const cases = [
    ['a changed amount', { requested_minor: 999000, currency: 'USD' }],
    ['a changed currency', { requested_minor: 125000, currency: 'EUR' }],
    ['a changed title', { title: 'Repair workshop (revised)' }],
    ['a changed summary', { summary: 'Different wording' }],
    ['a dropped amount', { requested_minor: null, currency: null }],
    ['a changed vote type', { vote_type: 'other_type' }],
    ['another proposer', { proposer_contact_id: VOTER }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const stored = proposalRow({
        summary: 'Fix the roof tiles',
        requested_minor: 125000,
        currency: 'USD',
        ...overrides,
      });
      const { writer } = writerFor({
        dev_rein_mvp_proposals: call => (call.method === 'POST' ? duplicate() : [stored]),
      });
      const result = await writer.submitProposal(proposalInput());
      assert.equal(result.ok, false);
      assert.equal(result.status, 'conflict');
      assert.equal(result.reason, 'proposal_conflict');
      assert.equal(result.proposal, null);
      assert.equal(result.authorizesSpending, false);
    });
  }
});

test('a 409 with no recorded proposal is a refusal, not a conflict', async () => {
  const { writer, calls } = writerFor({
    dev_rein_mvp_proposals: call => (call.method === 'POST' ? duplicate() : []),
  });

  const result = await writer.submitProposal(proposalInput());

  assert.equal(result.ok, false);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'proposal_rejected');
  assert.equal(result.proposal, null);
  assert.equal(result.httpStatus, 409);
  assert.equal(calls.length, 2, 'a refusal is not retried beyond the confirming read');
});

test('malformed stored proposal rows fail closed instead of becoming a record', async (t) => {
  const cases = [
    ['an unparseable created_at', { created_at: 'yesterday' }],
    ['a title that is not text', { title: 42 }],
    ['a summary that is neither text nor null', { summary: 42 }],
    ['a fractional amount', { requested_minor: 12.5 }],
    ['a negative amount', { requested_minor: -1 }],
    ['a lowercase currency', { currency: 'usd' }],
    ['an amount without a currency', { requested_minor: 125000 }],
    ['an unconfigured status', { status: 'approved' }],
    ['a row that is not an object', null],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const stored = overrides === null ? [null] : [proposalRow(overrides)];
      const { writer } = writerFor({ dev_rein_mvp_proposals: { status: 201, rows: stored } });
      const result = await writer.submitProposal(proposalInput());
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'response_malformed');
      assert.equal(result.proposal, null);
      assert.equal(result.authorizesSpending, false);
    });
  }
});

test('a new poll is inserted with its vote type, candidates and window, and never its own limits', async () => {
  const { writer, calls } = writerFor({ dev_rein_mvp_polls: { status: 201, rows: [pollRow()] } });

  const result = await writer.createPoll(pollInput());

  assert.equal(result.ok, true);
  assert.equal(result.status, 'inserted');
  assert.equal(result.poll.voteType, VOTE_TYPE);
  assert.deepEqual(result.poll.candidateProposalIds, [PROPOSAL]);
  assert.equal(result.poll.candidateLimit, 5);
  assert.equal(result.poll.maxApprovalsPerVoter, 2);
  assert.equal(result.poll.opensAt, OPENS_AT);
  assert.equal(result.poll.closesAt, CLOSES_AT);
  assert.deepEqual(calls[0].body, {
    id: POLL,
    creator_contact_id: CONTACT,
    title: 'Approve the repair workshop?',
    vote_type: VOTE_TYPE,
    candidate_proposal_ids: [PROPOSAL],
    opens_at: OPENS_AT,
    closes_at: CLOSES_AT,
  });
  assert.ok(
    !('candidate_limit' in calls[0].body) && !('max_approvals_per_voter' in calls[0].body),
    'the database freezes the limits from the vote type, not from the caller',
  );
  assert.equal(calls[0].init.headers.prefer, 'return=representation');
});

test('an options-only poll is refused by name and never written', async () => {
  const { writer, calls } = writerFor({});

  const result = await writer.createPoll({
    id: POLL,
    creatorContactId: CONTACT,
    title: 'Approve the repair workshop?',
    options: ['approve', 'reject', 'abstain'],
    opensAt: OPENS_AT,
    closesAt: CLOSES_AT,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'invalid_request');
  assert.equal(result.reason, 'legacy_options_unsupported');
  assert.equal(result.poll, null);
  assert.equal(calls.length, 0, 'a phase-1 shape never reaches the database');
});

test('a duplicate poll with the same definition is existing; changed candidates or window conflict', async (t) => {
  const cases = [
    ['identical definition', {}, {}, 'existing'],
    ['a changed candidate list', { candidate_proposal_ids: [PROPOSAL_TWO] }, {}, 'conflict'],
    [
      'a reordered candidate list',
      { candidate_proposal_ids: [PROPOSAL_TWO, PROPOSAL] },
      { candidateProposalIds: [PROPOSAL, PROPOSAL_TWO] },
      'conflict',
    ],
    ['a changed vote type', { vote_type: 'other_type' }, {}, 'conflict'],
    ['a changed title', { title: 'Approve the roof repair?' }, {}, 'conflict'],
    ['a changed window', { closes_at: '2026-09-24T12:00:00+00:00' }, {}, 'conflict'],
    ['a changed creator', { creator_contact_id: VOTER }, {}, 'conflict'],
  ];
  for (const [name, storedOverrides, inputOverrides, status] of cases) {
    await t.test(name, async () => {
      const { writer } = writerFor({
        dev_rein_mvp_polls: call => (call.method === 'POST' ? duplicate() : [pollRow(storedOverrides)]),
      });
      const result = await writer.createPoll(pollInput(inputOverrides));
      assert.equal(result.ok, status === 'existing');
      assert.equal(result.status, status);
      if (status === 'conflict') assert.equal(result.reason, 'poll_conflict');
      if (status !== 'existing') assert.equal(result.poll, null);
    });
  }
});

test('a poll refused by the database guard is rejected once, without a retry', async () => {
  let posts = 0;
  const { writer } = writerFor({
    dev_rein_mvp_polls: call => {
      if (call.method !== 'POST') return [];
      posts += 1;
      // A trigger raise that fails a governance rule maps to 400.
      return new Response(
        JSON.stringify({ code: '23514', message: 'a candidate is already on an open poll' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const result = await writer.createPoll(pollInput());

  assert.equal(result.ok, false);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'poll_rejected');
  assert.equal(result.httpStatus, 400);
  assert.equal(posts, 1, 'a refusal is not retried');
});

test('a ballot records its approved proposal ids once per poll and voter', async () => {
  const { writer, calls } = writerFor({ dev_rein_mvp_ballots: { status: 201, rows: [ballotRow()] } });

  const result = await writer.castBallot(ballotInput());

  assert.deepEqual(result, {
    ok: true,
    status: 'inserted',
    reason: 'inserted',
    ballot: { pollId: POLL, voterContactId: VOTER, approvedProposalIds: [PROPOSAL] },
    httpStatus: 201,
  });
  assert.deepEqual(calls[0].body, {
    poll_id: POLL,
    voter_contact_id: VOTER,
    approved_proposal_ids: [PROPOSAL],
  });
  assert.equal(calls[0].table, 'dev_rein_mvp_ballots');
  assert.ok(!('cast_at' in calls[0].body), 'the database clock is the default');
});

test('an empty approval list is the abstention, and the deprecated choice maps onto it', async (t) => {
  await t.test('an empty list is stored as an empty list', async () => {
    const { writer, calls } = writerFor({
      dev_rein_mvp_ballots: { status: 201, rows: [ballotRow({ approved_proposal_ids: [] })] },
    });
    const result = await writer.castBallot(ballotInput({ approvedProposalIds: [] }));
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].body.approved_proposal_ids, []);
  });

  await t.test('the phase-1 abstain choice maps to no approvals', async () => {
    const { writer, calls } = writerFor({
      dev_rein_mvp_ballots: { status: 201, rows: [ballotRow({ approved_proposal_ids: [] })] },
    });
    const result = await writer.castBallot({ pollId: POLL, voterContactId: VOTER, choice: 'abstain' });
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].body.approved_proposal_ids, []);
  });

  await t.test('a phase-1 proposal-id choice maps to one approval', async () => {
    const { writer, calls } = writerFor({
      dev_rein_mvp_ballots: { status: 201, rows: [ballotRow()] },
    });
    const result = await writer.castBallot({ pollId: POLL, voterContactId: VOTER, choice: PROPOSAL });
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].body.approved_proposal_ids, [PROPOSAL]);
  });

  await t.test('a phase-1 choice that is neither is refused without a request', async () => {
    const { writer, calls } = writerFor({});
    const result = await writer.castBallot({ pollId: POLL, voterContactId: VOTER, choice: 'approve' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'invalid_request');
    assert.equal(result.reason, 'ballot_approved_proposal_ids_invalid');
    assert.equal(calls.length, 0);
  });
});

test('a replay of the same approvals is existing, and a changed ballot is refused', async (t) => {
  await t.test('the same approvals in another order', async () => {
    const { writer } = writerFor({
      dev_rein_mvp_ballots: call => (call.method === 'POST'
        ? duplicate()
        : [ballotRow({ approved_proposal_ids: [PROPOSAL, PROPOSAL_TWO] })]),
    });
    const result = await writer.castBallot(ballotInput({ approvedProposalIds: [PROPOSAL_TWO, PROPOSAL] }));
    assert.equal(result.ok, true);
    assert.equal(result.status, 'existing');
    assert.equal(result.reason, 'existing_identical');
    assert.deepEqual(result.ballot.approvedProposalIds, [PROPOSAL, PROPOSAL_TWO]);
  });

  await t.test('a changed approval list', async () => {
    const { writer } = writerFor({
      dev_rein_mvp_ballots: call => (call.method === 'POST' ? duplicate() : [ballotRow()]),
    });
    const result = await writer.castBallot(ballotInput({ approvedProposalIds: [PROPOSAL_TWO] }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'conflict');
    assert.equal(result.reason, 'ballot_conflict');
    assert.equal(result.ballot, null);
  });

  await t.test('an abstention replayed after an approval is a conflict', async () => {
    const { writer } = writerFor({
      dev_rein_mvp_ballots: call => (call.method === 'POST' ? duplicate() : [ballotRow()]),
    });
    const result = await writer.castBallot(ballotInput({ approvedProposalIds: [] }));
    assert.equal(result.status, 'conflict');
  });
});

test('a ballot 409 with no recorded row is a refusal that names no server text', async () => {
  const { writer } = writerFor({
    dev_rein_mvp_ballots: call => (call.method === 'POST'
      ? duplicate('ballot references an unknown poll')
      : []),
  });

  const result = await writer.castBallot(ballotInput());

  assert.equal(result.ok, false);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'ballot_rejected');
  assert.equal(result.ballot, null);
  assert.equal(result.httpStatus, 409);
  assert.ok(!JSON.stringify(result).includes('unknown poll'), 'provider text never reaches a result');
});

test('getPoll returns the stored definition and rejects an unknown id', async (t) => {
  await t.test('stored poll', async () => {
    const { writer, calls } = writerFor({ dev_rein_mvp_polls: [pollRow()] });
    const result = await writer.getPoll(POLL);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'found');
    assert.equal(result.reason, 'poll');
    assert.equal(result.poll.title, 'Approve the repair workshop?');
    assert.equal(result.poll.voteType, VOTE_TYPE);
    assert.deepEqual(result.poll.candidateProposalIds, [PROPOSAL]);
    assert.equal(result.poll.status, 'open');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].params.get('id'), `eq.${POLL}`);
    assert.equal(calls[0].params.get('limit'), '2');
  });

  await t.test('absent poll', async () => {
    const { writer } = writerFor({ dev_rein_mvp_polls: [] });
    const result = await writer.getPoll(POLL);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'poll_not_found');
    assert.equal(result.poll, null);
  });
});

test('malformed poll rows fail closed on read', async (t) => {
  const cases = [
    ['no candidate', { candidate_proposal_ids: [] }],
    ['a repeated candidate', { candidate_proposal_ids: [PROPOSAL, PROPOSAL] }],
    ['a candidate that is not a uuid', { candidate_proposal_ids: ['proposal-1'] }],
    ['a window that closes before it opens', { closes_at: '2026-09-24T09:00:00+00:00' }],
    ['a window that never closes', { closes_at: OPENS_AT }],
    ['an unparseable opens_at', { opens_at: 'soon' }],
    ['an approvals limit above the candidate limit', { max_approvals_per_voter: 9 }],
    ['a zero candidate limit', { candidate_limit: 0 }],
    ['a status outside the schema', { status: 'pending' }],
    ['a row that is not an object', null],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const stored = overrides === null ? [null] : [pollRow(overrides)];
      const { writer } = writerFor({ dev_rein_mvp_polls: stored });
      const result = await writer.getPoll(POLL);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'response_malformed');
      assert.equal(result.poll, null);
    });
  }
});

test('listBallots reads the recorded approvals in cast order and never computes a result', async () => {
  const second = ballotRow({
    id: '66666666-6666-4666-8666-666666666666',
    voter_contact_id: CONTACT,
    approved_proposal_ids: [],
    cast_at: '2026-09-24T10:45:00+00:00',
  });
  const { writer, calls } = writerFor({ dev_rein_mvp_ballots: [ballotRow(), second] });

  const result = await writer.listBallots(POLL);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'found');
  assert.equal(result.reason, 'ballots');
  assert.equal(result.ballots.length, 2);
  assert.deepEqual(result.ballots.map(ballot => ballot.approvedProposalIds), [[PROPOSAL], []]);
  assert.ok(!('tally' in result) && !('result' in result), 'the store never returns a tally');
  assert.equal(calls[0].params.get('poll_id'), `eq.${POLL}`);
  assert.equal(calls[0].params.get('order'), 'cast_at.asc,id.asc');
  assert.equal(
    calls[0].params.get('select'),
    'id,poll_id,voter_contact_id,approved_proposal_ids,cast_at',
  );
});

test('a ballot page that overflows is refused rather than silently truncated', async () => {
  const rows = Array.from({ length: 1001 }, (_, index) =>
    ballotRow({ id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111` }));
  const { writer } = writerFor({ dev_rein_mvp_ballots: rows });

  const result = await writer.listBallots(POLL);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ballots_truncated');
  assert.equal(result.ballots, null);
});

test('a malformed ballot row fails closed on read', async () => {
  const { writer } = writerFor({ dev_rein_mvp_ballots: [ballotRow({ approved_proposal_ids: 'approve' })] });
  const result = await writer.listBallots(POLL);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'response_malformed');
  assert.equal(result.ballots, null);
});

test('getVoteType reads the configured limits and reports a missing type', async (t) => {
  await t.test('configured type', async () => {
    const { writer, calls } = writerFor({ dev_rein_mvp_vote_types: [voteTypeRow()] });
    const result = await writer.getVoteType(VOTE_TYPE);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'found');
    assert.deepEqual(result.voteType, {
      voteType: VOTE_TYPE,
      maxCandidates: 5,
      maxApprovalsPerVoter: 2,
      updatedAt: CREATED_AT,
    });
    assert.equal(calls[0].params.get('vote_type'), `eq.${VOTE_TYPE}`);
  });

  await t.test('missing type', async () => {
    const { writer } = writerFor({ dev_rein_mvp_vote_types: [] });
    const result = await writer.getVoteType(VOTE_TYPE);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'vote_type_not_found');
    assert.equal(result.voteType, null);
  });

  await t.test('a type whose approvals exceed its candidates', async () => {
    const { writer } = writerFor({
      dev_rein_mvp_vote_types: [voteTypeRow({ max_candidates: 1, max_approvals_per_voter: 3 })],
    });
    const result = await writer.getVoteType(VOTE_TYPE);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'response_malformed');
  });
});

test('listCandidateProposals reads the eligible proposals of one vote type', async () => {
  const second = proposalRow({ id: PROPOSAL_TWO, title: 'Repair the fence' });
  const { writer, calls } = writerFor({ dev_rein_mvp_proposals: [proposalRow(), second] });

  const result = await writer.listCandidateProposals({ voteType: VOTE_TYPE });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'found');
  assert.equal(result.reason, 'candidates');
  assert.deepEqual(result.proposals.map(proposal => proposal.id), [PROPOSAL, PROPOSAL_TWO]);
  assert.equal(calls[0].params.get('vote_type'), `eq.${VOTE_TYPE}`);
  assert.equal(calls[0].params.get('status'), 'in.(submitted,unselected)');
  assert.equal(calls[0].params.get('order'), 'created_at.asc,id.asc');
  assert.equal(calls[0].params.get('limit'), '50');
});

test('listCandidateProposals can bound the age and offer recent unselected proposals first', async (t) => {
  await t.test('a submittedSince bound is sent as a created_at filter', async () => {
    const { writer, calls } = writerFor({ dev_rein_mvp_proposals: [proposalRow()] });
    const result = await writer.listCandidateProposals({
      voteType: VOTE_TYPE,
      submittedSince: '2026-09-20T00:00:00Z',
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.get('created_at'), 'gte.2026-09-20T00:00:00Z');
  });

  await t.test('the recent unselected bucket is read second and offered first', async () => {
    const older = proposalRow({ id: PROPOSAL_TWO, title: 'Repair the fence' });
    const { writer, calls } = writerFor({
      dev_rein_mvp_proposals: call => (call.params.get('status') === 'eq.unselected'
        ? [proposalRow()]
        : [older, proposalRow()]),
    });
    const result = await writer.listCandidateProposals({
      voteType: VOTE_TYPE,
      includeRecentlyUnselected: true,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.proposals.map(proposal => proposal.id), [PROPOSAL, PROPOSAL_TWO]);
    assert.deepEqual(calls.map(call => call.params.get('status')), [
      'eq.unselected',
      'in.(submitted,unselected)',
    ]);
    assert.equal(calls[0].params.get('order'), 'created_at.desc,id.desc');
  });

  await t.test('a failed recent bucket read is unavailable, never a short list', async () => {
    const { writer } = writerFor({
      dev_rein_mvp_proposals: call => (call.params.get('status') === 'eq.unselected'
        ? new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })
        : [proposalRow()]),
    });
    const result = await writer.listCandidateProposals({
      voteType: VOTE_TYPE,
      includeRecentlyUnselected: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.proposals, null);
  });
});

test('listCandidateProposals leaves excluded ids out and refuses a bad page', async (t) => {
  await t.test('an excluded candidate is left out', async () => {
    const second = proposalRow({ id: PROPOSAL_TWO, title: 'Repair the fence' });
    const { writer, calls } = writerFor({ dev_rein_mvp_proposals: [proposalRow(), second] });
    const result = await writer.listCandidateProposals({
      voteType: VOTE_TYPE,
      excludeProposalIds: [PROPOSAL],
    });
    assert.deepEqual(result.proposals.map(proposal => proposal.id), [PROPOSAL_TWO]);
    assert.equal(calls[0].params.get('limit'), '51');
  });

  await t.test('a candidate of another vote type is not a candidate', async () => {
    const { writer } = writerFor({
      dev_rein_mvp_proposals: [proposalRow({ vote_type: 'other_type' })],
    });
    const result = await writer.listCandidateProposals({ voteType: VOTE_TYPE });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'response_malformed');
    assert.equal(result.proposals, null);
  });

  await t.test('an oversized page is refused unwritten', async () => {
    const { writer, calls } = writerFor({});
    const result = await writer.listCandidateProposals({ voteType: VOTE_TYPE, limit: 201 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'candidate_limit_invalid');
    assert.equal(calls.length, 0);
  });
});

test('the production environment writes the prod_ tables', async () => {
  const { writer, calls } = writerFor(
    { prod_rein_mvp_polls: { status: 201, rows: [pollRow()] } },
    { environment: 'prod' },
  );

  const result = await writer.createPoll(pollInput());

  assert.equal(writer.tablePrefix, 'prod_');
  assert.equal(result.ok, true);
  assert.ok(calls.every(call => call.url.includes('/rest/v1/prod_')), 'every request uses prod_');
});

test('the record and read operations insert or read, and never update, delete, upsert or RPC', async () => {
  const { writer, calls } = writerFor({
    dev_rein_mvp_proposals: {
      status: 201,
      rows: [proposalRow({ summary: 'Fix the roof tiles', requested_minor: 125000, currency: 'USD' })],
    },
    dev_rein_mvp_polls: [pollRow()],
    dev_rein_mvp_ballots: [ballotRow()],
    dev_rein_mvp_vote_types: [voteTypeRow()],
  });

  await writer.submitProposal(proposalInput());
  await writer.getPoll(POLL);
  await writer.listBallots(POLL);
  await writer.getVoteType(VOTE_TYPE);
  await writer.listCandidateProposals({ voteType: VOTE_TYPE });

  for (const call of calls) {
    assert.ok(['GET', 'POST'].includes(call.method), `${call.method} is not allowed`);
    assert.ok(!call.url.includes('/rpc/'), 'no RPC path is used');
    assert.equal(call.url.includes('on_conflict'), false, 'no upsert is issued');
    if (call.method === 'GET') assert.equal(call.init.body, undefined);
  }
});

test('input validation rejects malformed values without touching the database', async (t) => {
  const { writer, calls } = writerFor({});
  const cases = [
    ['a non-UUID proposal id', () => writer.submitProposal(proposalInput({ id: 'proposal-1' })), 'proposal_id_invalid'],
    ['a non-UUID proposer', () => writer.submitProposal(proposalInput({ proposerContactId: 'nope' })), 'proposer_contact_id_invalid'],
    ['an empty title', () => writer.submitProposal(proposalInput({ title: '   ' })), 'proposal_title_invalid'],
    ['an over-long title', () => writer.submitProposal(proposalInput({ title: 'x'.repeat(201) })), 'proposal_title_invalid'],
    ['a missing vote type', () => writer.submitProposal(proposalInput({ voteType: undefined })), 'proposal_vote_type_invalid'],
    ['a malformed vote type', () => writer.submitProposal(proposalInput({ voteType: 'Repair Budget' })), 'proposal_vote_type_invalid'],
    ['a non-text summary', () => writer.submitProposal(proposalInput({ summary: 42 })), 'proposal_summary_invalid'],
    ['an amount without a currency', () => writer.submitProposal(proposalInput({ currency: null })), 'proposal_request_incomplete'],
    ['a currency without an amount', () => writer.submitProposal(proposalInput({ requestedMinor: null })), 'proposal_request_incomplete'],
    ['a negative amount', () => writer.submitProposal(proposalInput({ requestedMinor: -1 })), 'proposal_requested_minor_invalid'],
    ['a fractional amount', () => writer.submitProposal(proposalInput({ requestedMinor: 12.5 })), 'proposal_requested_minor_invalid'],
    ['a lowercase currency', () => writer.submitProposal(proposalInput({ currency: 'usd' })), 'proposal_currency_invalid'],
    ['a non-UUID poll id', () => writer.createPoll(pollInput({ id: 'poll-1' })), 'poll_id_invalid'],
    ['no candidate', () => writer.createPoll(pollInput({ candidateProposalIds: [] })), 'poll_candidate_proposal_ids_invalid'],
    ['a repeated candidate', () => writer.createPoll(pollInput({ candidateProposalIds: [PROPOSAL, PROPOSAL] })), 'poll_candidate_proposal_ids_invalid'],
    ['a candidate that is not a uuid', () => writer.createPoll(pollInput({ candidateProposalIds: ['proposal-1'] })), 'poll_candidate_proposal_ids_invalid'],
    ['a missing poll vote type', () => writer.createPoll(pollInput({ voteType: undefined })), 'poll_vote_type_invalid'],
    ['an unparseable opensAt', () => writer.createPoll(pollInput({ opensAt: '2026' })), 'poll_opens_at_invalid'],
    ['an unparseable closesAt', () => writer.createPoll(pollInput({ closesAt: 'later' })), 'poll_closes_at_invalid'],
    ['a window that does not advance', () => writer.createPoll(pollInput({ closesAt: OPENS_AT })), 'poll_window_invalid'],
    ['a non-UUID poll id on a ballot', () => writer.castBallot(ballotInput({ pollId: 'poll-1' })), 'poll_id_invalid'],
    ['a non-UUID voter', () => writer.castBallot(ballotInput({ voterContactId: 'me' })), 'voter_contact_id_invalid'],
    ['a repeated approval', () => writer.castBallot(ballotInput({ approvedProposalIds: [PROPOSAL, PROPOSAL] })), 'ballot_approved_proposal_ids_invalid'],
    ['an approval that is not a uuid', () => writer.castBallot(ballotInput({ approvedProposalIds: ['approve'] })), 'ballot_approved_proposal_ids_invalid'],
    ['neither approvals nor a choice', () => writer.castBallot({ pollId: POLL, voterContactId: VOTER }), 'ballot_approved_proposal_ids_invalid'],
    ['an unparseable castAt', () => writer.castBallot(ballotInput({ castAt: 'now' })), 'ballot_cast_at_invalid'],
    ['a non-UUID poll id on a read', () => writer.getPoll('poll-1'), 'poll_id_invalid'],
    ['a non-UUID poll id on a ballot list', () => writer.listBallots('poll-1'), 'poll_id_invalid'],
    ['a malformed vote type on a read', () => writer.getVoteType('Repair Budget'), 'vote_type_invalid'],
    ['a malformed vote type on a candidate list', () => writer.listCandidateProposals({ voteType: '' }), 'vote_type_invalid'],
    ['a zero page size', () => writer.listCandidateProposals({ voteType: VOTE_TYPE, limit: 0 }), 'candidate_limit_invalid'],
    ['a malformed excluded id', () => writer.listCandidateProposals({ voteType: VOTE_TYPE, excludeProposalIds: ['x'] }), 'candidate_exclude_ids_invalid'],
    ['an unparseable submittedSince', () => writer.listCandidateProposals({ voteType: VOTE_TYPE, submittedSince: 'soon' }), 'submitted_since_invalid'],
  ];
  for (const [name, run, reason] of cases) {
    await t.test(name, async () => {
      const result = await run();
      assert.equal(result.ok, false);
      assert.equal(result.status, 'invalid_request');
      assert.equal(result.reason, reason);
    });
  }
  assert.equal(calls.length, 0, 'no invalid input reaches the database');
});

test('invalid writer configuration is rejected at construction without echoing the key', () => {
  const base = {
    supabaseUrl: BASE_URL,
    serviceRoleKey: SECRET,
    environment: 'dev',
    fetch: async () => new Response('[]'),
  };
  const attempts = [
    [{ ...base, serviceRoleKey: '' }, 'serviceRoleKey is required'],
    [{ ...base, supabaseUrl: '' }, 'supabaseUrl is required'],
    [{ ...base, supabaseUrl: 'not a url' }, 'absolute URL'],
    [{ ...base, supabaseUrl: 'ftp://project-ref.supabase.co' }, 'http or https'],
    [{ ...base, supabaseUrl: 'https://user:pass@project-ref.supabase.co' }, 'bare project URL'],
    [{ ...base, supabaseUrl: `${BASE_URL}/rest/v1/?x=1` }, 'bare project URL'],
    [{ ...base, environment: 'staging' }, "environment must be 'dev' or 'prod'"],
    [{ ...base, fetch: 'not a function' }, 'fetch implementation is required'],
  ];
  for (const [config, expected] of attempts) {
    let error = null;
    try {
      createFoundationDbWriter(config);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error, `expected construction to be rejected: ${expected}`);
    assert.match(error.message, new RegExp(expected));
    assert.ok(!error.message.includes(SECRET), 'the configuration error never echoes the key');
    assert.ok(!error.message.includes('sb_secret'), 'the configuration error never echoes the key');
  }
});

test('database failures resolve to an unavailable result rather than throwing', async (t) => {
  await t.test('an HTTP failure', async () => {
    const { writer } = writerFor({
      dev_rein_mvp_proposals: new Response('{}', {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    });
    const result = await writer.submitProposal(proposalInput());
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'http_error');
    assert.equal(result.httpStatus, 503);
    assert.equal(result.proposal, null);
  });

  await t.test('a transport failure', async () => {
    const { writer } = writerFor({
      dev_rein_mvp_polls: () => {
        throw new Error('socket hang up');
      },
    });
    const result = await writer.getPoll(POLL);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'transport_error');
    assert.equal(result.httpStatus, null);
  });

  await t.test('an unparseable body', async () => {
    const { writer } = writerFor({
      dev_rein_mvp_vote_types: new Response('not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });
    const result = await writer.getVoteType(VOTE_TYPE);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'response_malformed');
  });
});

test('a re-read that fails keeps an ambiguous 409 unavailable rather than guessing', async () => {
  const { writer } = writerFor({
    dev_rein_mvp_polls: call => (call.method === 'POST'
      ? duplicate()
      : new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })),
  });

  const result = await writer.createPoll(pollInput());

  assert.equal(result.ok, false);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'http_error');
  assert.equal(result.httpStatus, 503);
  assert.equal(result.poll, null);
});

test('no result, error or request ever carries the secret key', async () => {
  const { writer, calls } = writerFor({
    dev_rein_mvp_proposals: {
      status: 201,
      rows: [proposalRow({ summary: 'Fix the roof tiles', requested_minor: 125000, currency: 'USD' })],
    },
    dev_rein_mvp_polls: new Response(
      JSON.stringify({ code: '23505', message: `duplicate key ${SECRET}` }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ),
    dev_rein_mvp_ballots: new Response(`internal error near ${SECRET}`, { status: 500 }),
    dev_rein_mvp_vote_types: new Response(`internal error near ${SECRET}`, { status: 500 }),
  });

  const results = [
    await writer.submitProposal(proposalInput()),
    await writer.createPoll(pollInput()),
    await writer.castBallot(ballotInput()),
    await writer.getPoll(POLL),
    await writer.listBallots(POLL),
    await writer.getVoteType(VOTE_TYPE),
    await writer.listCandidateProposals({ voteType: VOTE_TYPE }),
  ];

  for (const result of results) {
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(SECRET), 'no result carries the key');
    assert.ok(!serialized.includes('duplicate key'), 'no result echoes provider text');
    assert.ok(!serialized.includes('internal error'), 'no result echoes provider text');
  }
  for (const call of calls) {
    assert.ok(!call.url.includes(SECRET), 'the key never appears in a URL');
    assert.ok(!JSON.stringify(call.body ?? null).includes(SECRET), 'the key never appears in a body');
  }
});

test('the writer exposes only its environment and its named operations', () => {
  const { writer } = writerFor({});

  assert.equal(writer.environment, 'dev');
  assert.equal(writer.tablePrefix, 'dev_');
  assert.deepEqual(Object.keys(writer).sort(), [
    'applyProposalRevision',
    'approveProposalRevision',
    'castBallot',
    'createPoll',
    'environment',
    'finalizePoll',
    'getPoll',
    'getProposal',
    'getRevision',
    'getVoteType',
    'listBallots',
    'listCandidateProposals',
    'recordProposalRevision',
    'submitProposal',
    'tablePrefix',
  ]);
  assert.ok(Object.isFrozen(writer));
});

test('finalizePoll calls the deterministic RPC with only the poll and its director', async () => {
  const { writer, calls } = writerFor({
    'rpc/dev_rein_mvp_finalize_poll': jsonResponse(finalizePayload()),
  });

  const result = await writer.finalizePoll({ pollId: POLL, actorContactId: CONTACT });

  assert.deepEqual(result, {
    ok: true,
    status: 'inserted',
    reason: 'finalized',
    finalization: {
      pollId: POLL,
      status: 'closed',
      repeated: false,
      outcome: 'winner',
      winningProposalId: PROPOSAL,
      finalizedByContactId: CONTACT,
      candidates: [PROPOSAL, PROPOSAL_TWO],
      proposalsRecorded: 1,
      ballots: 3,
      abstentions: 1,
      approvals: [
        { proposalId: PROPOSAL, approvals: 2 },
        { proposalId: PROPOSAL_TWO, approvals: 1 },
      ],
    },
    httpStatus: 200,
  });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.table, 'rpc/dev_rein_mvp_finalize_poll');
  assert.equal(call.init.headers.apikey, SECRET);
  assert.equal(call.init.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(call.init.headers['content-type'], 'application/json');
  assert.deepEqual(call.body, { p_poll_id: POLL, p_actor_contact_id: CONTACT });
  assert.ok(!call.url.includes(SECRET), 'the key never appears in a URL');
});

test('finalizePoll records a no-winner outcome when the ballots produced none', async () => {
  const { writer } = writerFor({
    'rpc/dev_rein_mvp_finalize_poll': jsonResponse(
      finalizePayload({
        outcome: 'no_winner',
        winning_proposal_id: null,
        approvals: {},
        proposals_recorded: 0,
        ballots: 2,
        abstentions: 2,
      }),
    ),
  });

  const result = await writer.finalizePoll({ pollId: POLL, actorContactId: CONTACT });

  assert.equal(result.ok, true);
  assert.equal(result.finalization.outcome, 'no_winner');
  assert.equal(result.finalization.winningProposalId, null);
  assert.deepEqual(result.finalization.approvals, []);
});

test('a repeated finalize reports the recorded outcome instead of counting again', async () => {
  const recorded = finalizePayload({ repeated: true, finalized_by_contact_id: VOTER });
  const { writer, calls } = writerFor({
    'rpc/dev_rein_mvp_finalize_poll': jsonResponse(recorded),
  });

  const result = await writer.finalizePoll({ pollId: POLL, actorContactId: CONTACT });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'existing');
  assert.equal(result.reason, 'existing_finalized');
  assert.equal(result.finalization.repeated, true);
  assert.equal(result.finalization.finalizedByContactId, VOTER);
  assert.equal(calls.length, 1, 'the RPC decides repetition; the writer does not re-count');
});

test('a poll the database refuses to finalize is rejected once, without server text', async () => {
  const { writer, calls } = writerFor({
    'rpc/dev_rein_mvp_finalize_poll': refused('poll 222 stays open until 2026-09-24 11:00:00+00'),
  });

  const result = await writer.finalizePoll({ pollId: POLL, actorContactId: CONTACT });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'finalize_rejected');
  assert.equal(result.finalization, null);
  assert.equal(result.httpStatus, 400);
  assert.equal(calls.length, 1, 'a refusal is not retried');
  assert.ok(!JSON.stringify(result).includes('stays open'), 'provider text never reaches a result');
});

test('a finalize outage stays unavailable rather than reading as a decision', async () => {
  const { writer } = writerFor({
    'rpc/dev_rein_mvp_finalize_poll': new Response('{}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const result = await writer.finalizePoll({ pollId: POLL, actorContactId: CONTACT });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'http_error');
  assert.equal(result.httpStatus, 503);
  assert.equal(result.finalization, null);
});

test('a finalize payload that contradicts itself fails closed', async (t) => {
  const cases = [
    ['a winner with no winning id', { winning_proposal_id: null }],
    ['a non-winner that still names a winner', { outcome: 'no_winner' }],
    ['a winning id outside the candidates', { winning_proposal_id: REVISION }],
    ['an unknown outcome', { outcome: 'tie' }],
    ['more abstentions than ballots', { abstentions: 9 }],
    ['an approval for a non-candidate', { approvals: { [REVISION]: 1 } }],
    ['a non-boolean repeated flag', { repeated: 'yes' }],
    ['a candidates list that is not uuids', { candidates: ['proposal-1'] }],
    ['an empty body', null],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const payload = overrides === null ? {} : finalizePayload(overrides);
      const { writer } = writerFor({ 'rpc/dev_rein_mvp_finalize_poll': jsonResponse(payload) });
      const result = await writer.finalizePoll({ pollId: POLL, actorContactId: CONTACT });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'response_malformed');
      assert.equal(result.finalization, null);
    });
  }
});

test('finalizePoll rejects malformed input without touching the database', async () => {
  const { writer, calls } = writerFor({});

  const badPoll = await writer.finalizePoll({ pollId: 'poll-1', actorContactId: CONTACT });
  assert.equal(badPoll.status, 'invalid_request');
  assert.equal(badPoll.reason, 'poll_id_invalid');
  const badActor = await writer.finalizePoll({ pollId: POLL, actorContactId: null });
  assert.equal(badActor.status, 'invalid_request');
  assert.equal(badActor.reason, 'actor_contact_id_invalid');
  assert.equal(calls.length, 0);
});

test('a comment is recorded as one append-only row with no version and no field values', async () => {
  const { writer, calls } = writerFor({
    dev_rein_mvp_proposal_revisions: { status: 201, rows: [revisionRow()] },
  });

  const result = await writer.recordProposalRevision(revisionInput());

  assert.deepEqual(result, {
    ok: true,
    status: 'inserted',
    reason: 'inserted',
    revision: {
      id: REVISION,
      proposalId: PROPOSAL,
      version: null,
      authorContactId: CONTACT,
      changedFields: [],
      title: null,
      summary: null,
      requestedMinor: null,
      currency: null,
      location: null,
      schedule: null,
      personnel: null,
      eventFlow: null,
      note: 'Please re-check the roof pitch.',
      approvedByContactId: null,
      approvedAt: null,
      recordedAt: RECORDED_AT,
    },
    httpStatus: 201,
  });
  assert.deepEqual(calls[0].body, {
    id: REVISION,
    proposal_id: PROPOSAL,
    author_contact_id: CONTACT,
    changed_fields: [],
    note: 'Please re-check the roof pitch.',
  });
  assert.ok(
    !('version' in calls[0].body) && !('approved_by_contact_id' in calls[0].body),
    'the database assigns the version and the approval, never the caller',
  );
  assert.equal(
    calls[0].params.get('select'),
    'id,proposal_id,version,author_contact_id,changed_fields,title,summary,requested_minor,currency,location,schedule,personnel,event_flow,note,approved_by_contact_id,approved_at,recorded_at',
  );
});

test('a suggested revision carries exactly the fields it names and no version', async (t) => {
  await t.test('a material budget revision', async () => {
    const stored = revisionRow({
      changed_fields: ['budget'],
      requested_minor: 140000,
      currency: 'USD',
      note: null,
    });
    const { writer, calls } = writerFor({
      dev_rein_mvp_proposal_revisions: { status: 201, rows: [stored] },
    });
    const result = await writer.recordProposalRevision(
      revisionInput({
        changedFields: ['budget'],
        requestedMinor: 140000,
        currency: 'USD',
        note: undefined,
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.revision.version, null);
    assert.deepEqual(result.revision.changedFields, ['budget']);
    assert.deepEqual(calls[0].body, {
      id: REVISION,
      proposal_id: PROPOSAL,
      author_contact_id: CONTACT,
      changed_fields: ['budget'],
      requested_minor: 140000,
      currency: 'USD',
    });
  });

  await t.test('a wording revision to the title', async () => {
    const stored = revisionRow({ changed_fields: ['title'], title: 'Repair the roof', note: null });
    const { writer, calls } = writerFor({
      dev_rein_mvp_proposal_revisions: { status: 201, rows: [stored] },
    });
    const result = await writer.recordProposalRevision(
      revisionInput({ changedFields: ['title'], title: '  Repair the roof  ', note: undefined }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].body, {
      id: REVISION,
      proposal_id: PROPOSAL,
      author_contact_id: CONTACT,
      changed_fields: ['title'],
      title: 'Repair the roof',
    });
  });
});

test('a replay of the same revision is existing and a changed one is a conflict', async (t) => {
  const stored = revisionRow({ changed_fields: ['title'], title: 'Repair the roof', note: null });

  await t.test('an identical replay', async () => {
    const { writer, calls } = writerFor({
      dev_rein_mvp_proposal_revisions: call => (call.method === 'POST' ? duplicate() : [stored]),
    });
    const result = await writer.recordProposalRevision(
      revisionInput({ changedFields: ['title'], title: 'Repair the roof', note: undefined }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, 'existing');
    assert.equal(result.reason, 'existing_identical');
    assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);
    assert.equal(calls[1].params.get('id'), `eq.${REVISION}`);
  });

  await t.test('a changed value', async () => {
    const { writer } = writerFor({
      dev_rein_mvp_proposal_revisions: call => (call.method === 'POST' ? duplicate() : [stored]),
    });
    const result = await writer.recordProposalRevision(
      revisionInput({ changedFields: ['title'], title: 'Repair the roof tiles', note: undefined }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 'conflict');
    assert.equal(result.reason, 'revision_conflict');
    assert.equal(result.revision, null);
  });

  await t.test('a changed field list', async () => {
    const { writer } = writerFor({
      dev_rein_mvp_proposal_revisions: call => (call.method === 'POST' ? duplicate() : [stored]),
    });
    const result = await writer.recordProposalRevision(
      revisionInput({ changedFields: ['summary'], summary: 'New wording', note: undefined }),
    );
    assert.equal(result.status, 'conflict');
  });
});

test('a revisions 409 with no recorded row is a refusal that names no server text', async () => {
  const { writer, calls } = writerFor({
    dev_rein_mvp_proposal_revisions: call => (call.method === 'POST'
      ? duplicate('revision author 333 is neither a director nor a Contributor')
      : []),
  });

  const result = await writer.recordProposalRevision(revisionInput());

  assert.equal(result.ok, false);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'revision_rejected');
  assert.equal(result.revision, null);
  assert.equal(result.httpStatus, 409);
  assert.equal(calls.length, 2, 'a refusal is not retried beyond the confirming read');
  assert.ok(!JSON.stringify(result).includes('Contributor'), 'provider text never reaches a result');
});

test('a revision the database guard refuses is rejected once, without a second write', async () => {
  let posts = 0;
  const { writer } = writerFor({
    dev_rein_mvp_proposal_revisions: call => {
      if (call.method !== 'POST') return [];
      posts += 1;
      return refused('revision 777 takes its version when it becomes the effective version');
    },
  });

  const result = await writer.recordProposalRevision(
    revisionInput({ changedFields: ['budget'], requestedMinor: 140000, currency: 'USD', note: undefined }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'revision_rejected');
  assert.equal(result.httpStatus, 400);
  assert.equal(posts, 1);
});

test('revision input is validated without touching the database', async (t) => {
  const { writer, calls } = writerFor({});
  const cases = [
    ['a non-UUID revision id', revisionInput({ id: 'revision-1' }), 'revision_id_invalid'],
    ['a non-UUID proposal', revisionInput({ proposalId: 'p' }), 'revision_proposal_id_invalid'],
    ['a non-UUID author', revisionInput({ authorContactId: 'a' }), 'revision_author_contact_id_invalid'],
    ['no field list', revisionInput({ changedFields: undefined }), 'revision_changed_fields_invalid'],
    ['an unknown field', revisionInput({ changedFields: ['deadline'] }), 'revision_changed_fields_invalid'],
    ['a repeated field', revisionInput({ changedFields: ['title', 'title'] }), 'revision_changed_fields_invalid'],
    ['a named title with no value', revisionInput({ changedFields: ['title'], title: undefined }), 'revision_title_invalid'],
    ['a whitespace title', revisionInput({ changedFields: ['title'], title: '   ' }), 'revision_title_invalid'],
    ['an unnamed title with a value', revisionInput({ title: 'New' }), 'revision_title_unexpected'],
    ['a named summary that is null', revisionInput({ changedFields: ['summary'], summary: null }), 'revision_summary_invalid'],
    ['an unnamed summary with a value', revisionInput({ summary: 'wording' }), 'revision_summary_unexpected'],
    ['a budget with a malformed amount', revisionInput({ changedFields: ['budget'], requestedMinor: -1, currency: 'USD' }), 'revision_budget_invalid'],
    ['a budget with a lowercase currency', revisionInput({ changedFields: ['budget'], requestedMinor: 5, currency: 'usd' }), 'revision_budget_invalid'],
    ['an amount without its currency', revisionInput({ changedFields: ['budget'], requestedMinor: 5 }), 'revision_budget_invalid'],
    ['a half budget without the field', revisionInput({ currency: 'USD' }), 'revision_budget_incomplete'],
    ['a whole budget without the field', revisionInput({ requestedMinor: 5, currency: 'USD' }), 'revision_budget_unexpected'],
    ['a named location that is null', revisionInput({ changedFields: ['location'], location: null }), 'revision_location_invalid'],
    ['an unnamed location with a value', revisionInput({ location: 'Hall' }), 'revision_location_unexpected'],
    ['an unnamed schedule with a value', revisionInput({ schedule: 'March' }), 'revision_schedule_unexpected'],
    ['an unnamed personnel with a value', revisionInput({ personnel: 'two cooks' }), 'revision_personnel_unexpected'],
    ['an unnamed event flow with a value', revisionInput({ eventFlow: 'speeches' }), 'revision_event_flow_unexpected'],
    ['a comment with no note', revisionInput({ note: undefined }), 'revision_note_required'],
    ['a comment with an empty note', revisionInput({ note: '   ' }), 'revision_note_invalid'],
  ];
  for (const [name, input, reason] of cases) {
    await t.test(name, async () => {
      const result = await writer.recordProposalRevision(input);
      assert.equal(result.ok, false);
      assert.equal(result.status, 'invalid_request');
      assert.equal(result.reason, reason);
    });
  }
  assert.equal(calls.length, 0, 'no invalid input reaches the database');
});

test('a malformed revision row fails closed', async (t) => {
  const cases = [
    ['a comment with no note', { changed_fields: [], note: null }],
    ['a named title with a null value', { changed_fields: ['title'], title: null, note: null }],
    ['an unnamed title with a value', { changed_fields: [], title: 'New' }],
    ['a budget half', { changed_fields: ['budget'], requested_minor: 5, currency: null, note: null }],
    ['an approval without a time', { approved_by_contact_id: APPROVER, approved_at: null }],
    ['an unknown changed field', { changed_fields: ['deadline'], note: null }],
    ['a version of zero', { version: 0 }],
    ['a row that is not an object', null],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const rows = overrides === null ? [null] : [revisionRow(overrides)];
      const { writer } = writerFor({ dev_rein_mvp_proposal_revisions: { status: 201, rows } });
      const result = await writer.recordProposalRevision(revisionInput());
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'response_malformed');
      assert.equal(result.revision, null);
    });
  }
});

test('approving a revision records it through the RPC and returns the stored row', async () => {
  const approved = revisionRow({
    changed_fields: ['budget'],
    requested_minor: 140000,
    currency: 'USD',
    note: null,
    approved_by_contact_id: APPROVER,
    approved_at: RECORDED_AT,
  });
  const { writer, calls } = writerFor({
    'rpc/dev_rein_mvp_approve_revision': new Response(null, { status: 204 }),
    dev_rein_mvp_proposal_revisions: [approved],
  });

  const result = await writer.approveProposalRevision({
    revisionId: REVISION,
    approverContactId: APPROVER,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'updated');
  assert.equal(result.reason, 'approved');
  assert.equal(result.revision.approvedByContactId, APPROVER);
  assert.equal(result.revision.approvedAt, RECORDED_AT);
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);
  assert.equal(calls[0].table, 'rpc/dev_rein_mvp_approve_revision');
  assert.deepEqual(calls[0].body, { p_revision_id: REVISION, p_approver_contact_id: APPROVER });
  assert.ok(!calls[0].url.includes(SECRET), 'the key never appears in a URL');
});

test('a refused approval is named from the recorded revision, not the provider text', async (t) => {
  const rpcRefusal = () => refused('approving contact 888 is not a current director');

  await t.test('the same director approved it already', async () => {
    const { writer } = writerFor({
      'rpc/dev_rein_mvp_approve_revision': rpcRefusal(),
      dev_rein_mvp_proposal_revisions: [
        revisionRow({ approved_by_contact_id: APPROVER, approved_at: RECORDED_AT }),
      ],
    });
    const result = await writer.approveProposalRevision({
      revisionId: REVISION,
      approverContactId: APPROVER,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'existing');
    assert.equal(result.reason, 'existing_approved');
  });

  await t.test('another director approved it first', async () => {
    const recorded = revisionRow({ approved_by_contact_id: CONTACT, approved_at: RECORDED_AT });
    const { writer } = writerFor({
      'rpc/dev_rein_mvp_approve_revision': rpcRefusal(),
      dev_rein_mvp_proposal_revisions: [recorded],
    });
    const result = await writer.approveProposalRevision({
      revisionId: REVISION,
      approverContactId: APPROVER,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'conflict');
    assert.equal(result.reason, 'revision_already_approved');
    assert.equal(result.revision, null);
  });

  await t.test('the approver is not a current director', async () => {
    const { writer } = writerFor({
      'rpc/dev_rein_mvp_approve_revision': rpcRefusal(),
      dev_rein_mvp_proposal_revisions: [revisionRow()],
    });
    const result = await writer.approveProposalRevision({
      revisionId: REVISION,
      approverContactId: APPROVER,
    });
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'revision_approval_rejected');
    assert.ok(!JSON.stringify(result).includes('current director'), 'provider text is never echoed');
  });

  await t.test('the revision does not exist', async () => {
    const { writer } = writerFor({
      'rpc/dev_rein_mvp_approve_revision': rpcRefusal(),
      dev_rein_mvp_proposal_revisions: [],
    });
    const result = await writer.approveProposalRevision({
      revisionId: REVISION,
      approverContactId: APPROVER,
    });
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'revision_not_found');
  });
});

test('an approval outage stays unavailable and a malformed request is refused unwritten', async () => {
  const { writer, calls } = writerFor({
    'rpc/dev_rein_mvp_approve_revision': new Response('{}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const outage = await writer.approveProposalRevision({
    revisionId: REVISION,
    approverContactId: APPROVER,
  });
  assert.equal(outage.status, 'unavailable');
  assert.equal(outage.reason, 'http_error');
  assert.equal(outage.httpStatus, 503);

  const badId = await writer.approveProposalRevision({ revisionId: 'x', approverContactId: APPROVER });
  assert.equal(badId.status, 'invalid_request');
  assert.equal(badId.reason, 'revision_id_invalid');
  const badApprover = await writer.approveProposalRevision({ revisionId: REVISION, approverContactId: 'x' });
  assert.equal(badApprover.reason, 'approver_contact_id_invalid');
  assert.equal(calls.length, 1, 'only the outage reached the database');
});

test('applying a budget revision patches exactly its fields and lets the trigger version it', async () => {
  const revision = revisionRow({
    changed_fields: ['budget'],
    requested_minor: 140000,
    currency: 'USD',
    note: null,
    approved_by_contact_id: APPROVER,
    approved_at: RECORDED_AT,
  });
  const { writer, calls } = writerFor({
    dev_rein_mvp_proposal_revisions: [revision],
    dev_rein_mvp_proposals: call => (call.method === 'PATCH' ? { status: 200, rows: [appliedProposalRow()] } : []),
  });

  const result = await writer.applyProposalRevision({ revisionId: REVISION });

  assert.deepEqual(result, {
    ok: true,
    status: 'updated',
    reason: 'revision_applied',
    version: {
      proposalId: PROPOSAL,
      status: 'selected',
      version: 2,
      effectiveRevisionId: REVISION,
      title: 'Repair workshop',
      summary: 'Fix the roof tiles',
      requestedMinor: 140000,
      currency: 'USD',
      location: null,
      schedule: null,
      personnel: null,
      eventFlow: null,
    },
    httpStatus: 200,
  });
  assert.deepEqual(calls.map(call => call.method), ['GET', 'PATCH']);
  const patch = calls[1];
  assert.equal(patch.table, 'dev_rein_mvp_proposals');
  assert.equal(patch.params.get('id'), `eq.${PROPOSAL}`);
  assert.deepEqual(patch.body, {
    effective_revision_id: REVISION,
    requested_minor: 140000,
    currency: 'USD',
  });
  assert.ok(!('version' in patch.body), 'the trigger assigns the new version, never the caller');
  assert.equal(patch.init.headers.prefer, 'return=representation');
});

test('applying a wording revision patches only the title', async () => {
  const revision = revisionRow({ changed_fields: ['title'], title: 'Repair the roof', note: null });
  const applied = appliedProposalRow({
    title: 'Repair the roof',
    requested_minor: null,
    currency: null,
  });
  const { writer, calls } = writerFor({
    dev_rein_mvp_proposal_revisions: [revision],
    dev_rein_mvp_proposals: { status: 200, rows: [applied] },
  });

  const result = await writer.applyProposalRevision({ revisionId: REVISION });

  assert.equal(result.ok, true);
  assert.equal(result.version.effectiveRevisionId, REVISION);
  const patch = calls.find(call => call.method === 'PATCH');
  assert.deepEqual(patch.body, { effective_revision_id: REVISION, title: 'Repair the roof' });
});

test('a comment, an applied revision and an unapproved material revision are refused by name', async (t) => {
  await t.test('a comment is not applicable', async () => {
    const { writer, calls } = writerFor({ dev_rein_mvp_proposal_revisions: [revisionRow()] });
    const result = await writer.applyProposalRevision({ revisionId: REVISION });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'revision_is_comment');
    assert.deepEqual(calls.map(call => call.method), ['GET'], 'no patch is attempted');
  });

  await t.test('a revision that already became a version', async () => {
    const { writer, calls } = writerFor({
      dev_rein_mvp_proposal_revisions: [
        revisionRow({ changed_fields: ['title'], title: 'Repair the roof', note: null, version: 3 }),
      ],
    });
    const result = await writer.applyProposalRevision({ revisionId: REVISION });
    assert.equal(result.reason, 'revision_already_applied');
    assert.deepEqual(calls.map(call => call.method), ['GET']);
  });

  await t.test('a material revision with no recorded approval', async () => {
    const { writer, calls } = writerFor({
      dev_rein_mvp_proposal_revisions: [
        revisionRow({ changed_fields: ['location'], location: 'Hall', note: null }),
      ],
    });
    const result = await writer.applyProposalRevision({ revisionId: REVISION });
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'revision_not_approved');
    assert.deepEqual(calls.map(call => call.method), ['GET']);
  });

  await t.test('a revision that does not exist', async () => {
    const { writer, calls } = writerFor({ dev_rein_mvp_proposal_revisions: [] });
    const result = await writer.applyProposalRevision({ revisionId: REVISION });
    assert.equal(result.reason, 'revision_not_found');
    assert.deepEqual(calls.map(call => call.method), ['GET']);
  });
});

test('an apply the trigger refuses is rejected once, and a missing proposal row is named', async (t) => {
  const revision = revisionRow({ changed_fields: ['title'], title: 'Repair the roof', note: null });

  await t.test('the trigger refuses the update', async () => {
    let patches = 0;
    const { writer } = writerFor({
      dev_rein_mvp_proposal_revisions: [revision],
      dev_rein_mvp_proposals: call => {
        if (call.method !== 'PATCH') return [];
        patches += 1;
        return refused('the applied content does not match revision 777');
      },
    });
    const result = await writer.applyProposalRevision({ revisionId: REVISION });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'revision_apply_rejected');
    assert.equal(result.httpStatus, 400);
    assert.equal(result.version, null);
    assert.equal(patches, 1);
    assert.ok(!JSON.stringify(result).includes('does not match'), 'provider text never reaches a result');
  });

  await t.test('the proposal row is no longer there', async () => {
    const { writer } = writerFor({
      dev_rein_mvp_proposal_revisions: [revision],
      dev_rein_mvp_proposals: { status: 200, rows: [] },
    });
    const result = await writer.applyProposalRevision({ revisionId: REVISION });
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'proposal_not_found');
  });
});

test('an apply outage stays unavailable and a malformed request is refused unwritten', async () => {
  const { writer, calls } = writerFor({
    dev_rein_mvp_proposal_revisions: new Response('{}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const outage = await writer.applyProposalRevision({ revisionId: REVISION });
  assert.equal(outage.status, 'unavailable');
  assert.equal(outage.reason, 'http_error');
  assert.equal(outage.httpStatus, 503);

  const badId = await writer.applyProposalRevision({ revisionId: 'revision-1' });
  assert.equal(badId.status, 'invalid_request');
  assert.equal(badId.reason, 'revision_id_invalid');
  assert.equal(calls.length, 1, 'only the outage reached the database');
});

test('no finalize, revision or approval result, error or request ever carries the secret key', async () => {
  const { writer, calls } = writerFor({
    'rpc/dev_rein_mvp_finalize_poll': new Response(`internal error near ${SECRET}`, { status: 500 }),
    'rpc/dev_rein_mvp_approve_revision': new Response(`internal error near ${SECRET}`, { status: 500 }),
    dev_rein_mvp_proposal_revisions: call => {
      if (call.method === 'POST') return duplicate(`duplicate key ${SECRET}`);
      return new Response(`internal error near ${SECRET}`, { status: 500 });
    },
    dev_rein_mvp_proposals: new Response(`internal error near ${SECRET}`, { status: 500 }),
  });

  const results = [
    await writer.finalizePoll({ pollId: POLL, actorContactId: CONTACT }),
    await writer.recordProposalRevision(revisionInput()),
    await writer.approveProposalRevision({ revisionId: REVISION, approverContactId: APPROVER }),
    await writer.applyProposalRevision({ revisionId: REVISION }),
  ];

  for (const result of results) {
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(SECRET), 'no result carries the key');
    assert.ok(!serialized.includes('internal error'), 'no result echoes provider text');
    assert.ok(!serialized.includes('duplicate key'), 'no result echoes provider text');
  }
  for (const call of calls) {
    assert.ok(!call.url.includes(SECRET), 'the key never appears in a URL');
    assert.ok(!JSON.stringify(call.body ?? null).includes(SECRET), 'the key never appears in a body');
  }
});
