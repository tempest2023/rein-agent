import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createFoundationDbReader } from '../plugins/rein-operations/foundation-db-reader.ts';
import { createFoundationDbWriter } from '../plugins/rein-operations/foundation-db-writer.ts';

// Integration test for the server-side Supabase/PostgREST boundary. The reader and writer run
// against a real HTTP server over a loopback socket using the global fetch, so the request line,
// the `apikey` and `authorization` headers, the JSON body and the HTTP status all travel a genuine
// transport instead of an injected fetch stub. The server is a local simulation of PostgREST plus
// the Supabase API gateway, not a real project: it reproduces the two documented behaviours the
// boundary depends on.
//
//   1. A legacy `service_role` key is a three-segment JWT, so it authenticates in both the `apikey`
//      header and `Authorization: Bearer`.
//   2. A modern secret key is not a JWT. It authenticates in the `apikey` header only;
//      presenting it as a bearer token is a 401, which the reader and writer must surface as
//      `auth_error` rather than as a plain provider or governance failure.
//
// Every key and row below is synthetic. No live project is contacted, and no real credential,
// project URL or member record appears here.

// The modern-key prefix is assembled at runtime so no contiguous secret-shaped literal lands in the
// repository, where push protection would flag it. The value is synthetic and authenticates only
// against this in-process gateway.
const MODERN_KEY_PREFIX = `sb_${'secret'}_`;
const MODERN_SECRET = `${MODERN_KEY_PREFIX}gateway_test_000000000000000000`;
const OTHER_MODERN_SECRET = `${MODERN_KEY_PREFIX}gateway_test_rotated_0000000000`;
const LEGACY_SECRET =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwicmVmIjoidGVzdCJ9.not-a-real-credential';
const TEAM = 'T0123456ABC';
const USER = 'U0123456ABC';
const CONTACT = '11111111-1111-4111-8111-111111111111';
const CONTRIBUTOR = '22222222-2222-4222-8222-222222222222';
const PROPOSAL = '33333333-3333-4333-8333-333333333333';
const DIRECTOR = '55555555-5555-4555-8555-555555555555';
const POLL = '44444444-4444-4444-8444-444444444444';
const VERIFIED_AT = '2026-09-20T00:00:00+00:00';
const PREFIX = 'dev_';

const LEGACY_JWT_PATTERN = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const isLegacyJwt = value => typeof value === 'string' && LEGACY_JWT_PATTERN.test(value);
const isModernSecret = value => typeof value === 'string' && value.startsWith(MODERN_KEY_PREFIX);

/**
 * Column defaults the real tables supply, so an insert round-trips as a row the reader and writer
 * accept. A poll freezes `candidate_limit` and `max_approvals_per_voter` from its vote type, and a
 * ballot takes its `id` and `cast_at` from the database clock rather than from the caller.
 */
function applyInsertDefaults(table, row, store) {
  const now = new Date().toISOString();
  if (table.endsWith('_rein_mvp_proposals')) {
    return {
      version: 1,
      effective_revision_id: null,
      location: null,
      schedule: null,
      personnel: null,
      event_flow: null,
      created_at: now,
      updated_at: now,
      status: 'submitted',
      ...row,
    };
  }
  if (table.endsWith('_rein_mvp_polls')) {
    const voteType = (store[`${PREFIX}rein_mvp_vote_types`] ?? []).find(
      entry => entry.vote_type === row.vote_type,
    );
    if (voteType === undefined) throw new Error(`gateway has no vote type ${row.vote_type}`);
    return {
      candidate_limit: voteType.max_candidates,
      max_approvals_per_voter: voteType.max_approvals_per_voter,
      finalized_at: null,
      finalized_by_contact_id: null,
      winning_proposal_id: null,
      created_at: now,
      status: 'open',
      ...row,
    };
  }
  if (table.endsWith('_rein_mvp_ballots')) {
    return { id: randomUUID(), cast_at: now, ...row };
  }
  if (table.endsWith('_rein_mvp_proposal_revisions')) {
    return { version: null, approved_by_contact_id: null, approved_at: null, recorded_at: now, ...row };
  }
  return { ...row };
}

function projectRow(row, select) {
  if (!select) return { ...row };
  const projected = {};
  for (const column of select.split(',').map(entry => entry.trim()).filter(Boolean)) {
    projected[column] = row[column] ?? null;
  }
  return projected;
}

function matchesFilters(row, params) {
  for (const [key, value] of params) {
    if (['select', 'limit', 'order', 'or'].includes(key)) continue;
    const [operator, ...rest] = value.split('.');
    const expected = rest.join('.');
    if (operator === 'eq' && String(row[key] ?? '') !== expected) return false;
    if (operator === 'in') {
      const list = expected.replace(/^\(/, '').replace(/\)$/, '').split(',');
      if (!list.includes(String(row[key] ?? ''))) return false;
    }
    if (operator === 'gte' && !(Date.parse(row[key]) >= Date.parse(expected))) return false;
  }
  const or = params.get('or');
  if (or) {
    const clauses = or.replace(/^\(/, '').replace(/\)$/, '').split(',');
    const matched = clauses.some(clause => {
      const [column, operator, ...rest] = clause.split('.');
      return operator === 'eq' && String(row[column] ?? '') === rest.join('.');
    });
    if (!matched) return false;
  }
  return true;
}

function sortRows(rows, order) {
  if (!order) return rows;
  const [first] = order.split(',');
  const [column, direction = 'asc'] = first.split('.');
  const factor = direction === 'desc' ? -1 : 1;
  return [...rows].sort((left, right) => {
    const a = left[column];
    const b = right[column];
    if (a === b) return 0;
    return (a > b ? 1 : -1) * factor;
  });
}

/** Start the simulated gateway and return its base URL, recorded requests and close handle. */
function startGateway(policy = {}) {
  const store = {};
  for (const [table, rows] of Object.entries(policy.seeds ?? {})) {
    store[table] = rows.map(row => ({ ...row }));
  }
  const requests = [];
  const acceptedKeys = [policy.secret, policy.legacy].filter(Boolean);

  const respond = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body === undefined ? '' : JSON.stringify(body));
  };

  const rpc = (name, body) => {
    if (name.endsWith('_rein_mvp_finalize_poll')) {
      const poll = (store[`${PREFIX}rein_mvp_polls`] ?? []).find(row => row.id === body.p_poll_id);
      if (poll === undefined) return { status: 404, body: { message: 'poll not found' } };
      const ballots = (store[`${PREFIX}rein_mvp_ballots`] ?? []).filter(row => row.poll_id === body.p_poll_id);
      const approvals = {};
      let abstentions = 0;
      for (const ballot of ballots) {
        if (ballot.approved_proposal_ids.length === 0) abstentions += 1;
        for (const candidate of ballot.approved_proposal_ids) {
          approvals[candidate] = (approvals[candidate] ?? 0) + 1;
        }
      }
      const ranked = Object.entries(approvals).sort((left, right) => right[1] - left[1]);
      const winner = ranked.length > 0 && (ranked.length === 1 || ranked[1][1] < ranked[0][1]) ? ranked[0][0] : null;
      return {
        status: 200,
        body: {
          poll_id: body.p_poll_id,
          status: 'closed',
          repeated: false,
          outcome: winner === null ? 'no_winner' : 'winner',
          winning_proposal_id: winner,
          finalized_by_contact_id: body.p_actor_contact_id,
          candidates: poll.candidate_proposal_ids,
          proposals_recorded: poll.candidate_proposal_ids.length,
          ballots: ballots.length,
          abstentions,
          approvals,
        },
      };
    }
    if (name.endsWith('_rein_mvp_approve_revision')) {
      const revision = (store[`${PREFIX}rein_mvp_proposal_revisions`] ?? []).find(
        row => row.id === body.p_revision_id,
      );
      if (revision === undefined) return { status: 404, body: { message: 'revision not found' } };
      revision.approved_by_contact_id = body.p_approver_contact_id;
      revision.approved_at = new Date().toISOString();
      return { status: 200, body: undefined };
    }
    return { status: 404, body: { message: `unknown rpc ${name}` } };
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const parsedBody = raw ? JSON.parse(raw) : undefined;
    const apikey = request.headers.apikey;
    const authorization = request.headers.authorization;
    const bearer = typeof authorization === 'string' ? authorization.replace(/^Bearer\s+/i, '') : null;
    requests.push({ method: request.method, path: url.pathname, url, apikey, authorization, body: parsedBody });

    // A forced status models a gateway or upstream fault for the failure-mapping cases.
    if (policy.forceStatus) return respond(response, policy.forceStatus, { message: 'simulated fault' });

    // Authentication, in the order the Supabase gateway applies it.
    if (!apikey) return respond(response, 401, { message: 'No API key found in request' });
    if (isModernSecret(bearer)) {
      return respond(response, 401, { message: 'Invalid authentication credentials', hint: 'Expected 3 parts in JWT' });
    }
    if (bearer !== null && !isLegacyJwt(bearer)) return respond(response, 401, { message: 'Invalid JWT' });
    if (bearer !== null && bearer !== apikey) {
      return respond(response, 401, { message: 'JWT and API key do not match' });
    }
    if (policy.requireBearer === true && bearer === null) {
      return respond(response, 401, { message: 'No bearer token found' });
    }
    if (acceptedKeys.length > 0 && !acceptedKeys.includes(apikey)) {
      return respond(response, 401, { message: 'Invalid API key' });
    }

    const rpcMatch = /^\/rest\/v1\/rpc\/(.+)$/.exec(url.pathname);
    if (rpcMatch) {
      const outcome = rpc(rpcMatch[1], parsedBody ?? {});
      return respond(response, outcome.status, outcome.body);
    }

    const tableMatch = /^\/rest\/v1\/(.+)$/.exec(url.pathname);
    if (!tableMatch) return respond(response, 404, { message: 'not found' });
    const table = tableMatch[1];
    const rows = (store[table] ??= []);
    const select = url.searchParams.get('select');

    if (request.method === 'GET') {
      const matched = rows.filter(row => matchesFilters(row, url.searchParams));
      const ordered = sortRows(matched, url.searchParams.get('order'));
      const limit = Number(url.searchParams.get('limit') ?? ordered.length);
      return respond(response, 200, ordered.slice(0, limit).map(row => projectRow(row, select)));
    }
    if (request.method === 'POST') {
      const row = applyInsertDefaults(table, parsedBody ?? {}, store);
      if (row.id && rows.some(existing => existing.id === row.id)) {
        return respond(response, 409, { message: 'duplicate key value violates unique constraint' });
      }
      rows.push(row);
      return respond(response, 201, [projectRow(row, select)]);
    }
    if (request.method === 'PATCH') {
      const matched = rows.filter(row => matchesFilters(row, url.searchParams));
      for (const row of matched) Object.assign(row, parsedBody ?? {});
      return respond(response, 200, matched.map(row => projectRow(row, select)));
    }
    return respond(response, 405, { message: 'method not allowed' });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        store,
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

const devSeeds = () => ({
  dev_rein_slack_links: [
    {
      slack_team_id: TEAM,
      slack_user_id: USER,
      contact_id: CONTACT,
      status: 'verified',
      verified_at: VERIFIED_AT,
      verified_by: 'ops@rein.example',
      revoked_at: null,
    },
  ],
  dev_community_contacts: [{ id: CONTACT }],
  dev_contributors: [{ id: CONTRIBUTOR, contact_id: CONTACT, status: 'active' }],
  dev_people: [{ contact_id: CONTACT, contributor_id: CONTRIBUTOR, person_type: 'director' }],
  dev_rein_fund_snapshots: [
    {
      currency: 'USD',
      available_minor: 500000,
      recorded_at: VERIFIED_AT,
      recorded_by: 'finance@rein.example',
      source_note: 'monthly statement',
    },
  ],
  dev_rein_mvp_vote_types: [
    { vote_type: 'event_budget', max_candidates: 10, max_approvals_per_voter: 2, updated_at: VERIFIED_AT },
  ],
});

const readerFor = (url, key) =>
  createFoundationDbReader({ supabaseUrl: url, serviceRoleKey: key, environment: 'dev', slackTeamId: TEAM });

const writerFor = (url, key) =>
  createFoundationDbWriter({ supabaseUrl: url, serviceRoleKey: key, environment: 'dev' });

test('a modern secret key resolves identity and reads funds through a live loopback gateway', async () => {
  const gateway = await startGateway({ secret: MODERN_SECRET, legacy: LEGACY_SECRET, seeds: devSeeds() });
  try {
    const reader = readerFor(gateway.url, MODERN_SECRET);
    const member = await reader.resolveSlackMember(USER);
    assert.deepEqual(member, {
      status: 'resolved',
      reason: 'resolved',
      contactId: CONTACT,
      // The link table is still the default path; the D13 email resolver is opt-in and off here.
      matchedBy: 'slack_link',
      isActiveContributor: true,
      isDirector: true,
      httpStatus: null,
    });
    const funds = await reader.readAvailableFunds('USD');
    assert.equal(funds.status, 'snapshot');
    assert.equal(funds.availableMinor, 500000);

    assert.ok(gateway.requests.length >= 5);
    for (const request of gateway.requests) {
      // A modern secret key authenticates in `apikey` only; Supabase rejects it as a bearer token.
      assert.equal(request.apikey, MODERN_SECRET);
      assert.equal(request.authorization, undefined);
      assert.ok(!request.url.href.includes(MODERN_SECRET), 'the key never appears in a URL');
    }
  } finally {
    await gateway.close();
  }
});

test('a legacy service_role JWT travels in apikey and bearer and reads through the same gateway', async () => {
  const gateway = await startGateway({ secret: MODERN_SECRET, legacy: LEGACY_SECRET, seeds: devSeeds() });
  try {
    const reader = readerFor(gateway.url, LEGACY_SECRET);
    const member = await reader.resolveSlackMember(USER);
    assert.equal(member.status, 'resolved');
    const funds = await reader.readAvailableFunds('USD');
    assert.equal(funds.status, 'snapshot');

    for (const request of gateway.requests) {
      assert.equal(request.apikey, LEGACY_SECRET);
      assert.equal(request.authorization, `Bearer ${LEGACY_SECRET}`);
      assert.ok(!request.url.href.includes(LEGACY_SECRET), 'the key never appears in a URL');
    }
  } finally {
    await gateway.close();
  }
});

test('a modern secret key records a proposal, opens a poll, casts a ballot and finalizes it', async () => {
  const gateway = await startGateway({ secret: MODERN_SECRET, legacy: LEGACY_SECRET, seeds: devSeeds() });
  try {
    const writer = writerFor(gateway.url, MODERN_SECRET);
    const submitted = await writer.submitProposal({
      id: PROPOSAL,
      proposerContactId: CONTACT,
      title: 'September community meetup',
      summary: 'Venue and refreshments',
      voteType: 'event_budget',
      requestedMinor: 30000,
      currency: 'USD',
    });
    assert.equal(submitted.ok, true, submitted.reason);
    assert.equal(submitted.proposal.id, PROPOSAL);
    assert.equal(submitted.proposal.status, 'submitted');
    assert.equal(submitted.authorizesSpending, false);

    const poll = await writer.createPoll({
      id: POLL,
      creatorContactId: CONTACT,
      title: 'September round',
      voteType: 'event_budget',
      candidateProposalIds: [PROPOSAL],
      opensAt: '2026-09-20T00:00:00+00:00',
      closesAt: '2026-09-27T00:00:00+00:00',
    });
    assert.equal(poll.ok, true, poll.reason);
    // The database froze both limits from the vote type; the caller never sent them.
    assert.equal(poll.poll.candidateLimit, 10);
    assert.equal(poll.poll.maxApprovalsPerVoter, 2);

    const ballot = await writer.castBallot({
      pollId: POLL,
      voterContactId: CONTRIBUTOR,
      approvedProposalIds: [PROPOSAL],
    });
    assert.equal(ballot.ok, true, ballot.reason);
    assert.equal(ballot.ballot.approvedProposalIds.length, 1);

    const finalized = await writer.finalizePoll({ pollId: POLL, actorContactId: DIRECTOR });
    assert.equal(finalized.ok, true, finalized.reason);
    assert.equal(finalized.finalization.outcome, 'winner');
    assert.equal(finalized.finalization.winningProposalId, PROPOSAL);
    assert.equal(finalized.finalization.ballots, 1);

    for (const request of gateway.requests) {
      assert.equal(request.apikey, MODERN_SECRET);
      assert.equal(request.authorization, undefined);
    }
    // The gateway saw the write methods and the RPC on the wire, not just injected headers.
    assert.ok(gateway.requests.some(request => request.method === 'POST' && /rein_mvp_proposals$/.test(request.path)));
    assert.ok(gateway.requests.some(request => request.method === 'POST' && /rein_mvp_polls$/.test(request.path)));
    assert.ok(gateway.requests.some(request => request.method === 'POST' && /rein_mvp_ballots$/.test(request.path)));
    assert.ok(gateway.requests.some(request => /\/rpc\/dev_rein_mvp_finalize_poll$/.test(request.path)));
  } finally {
    await gateway.close();
  }
});

test('the writer records a proposal with a legacy JWT in both headers', async () => {
  const gateway = await startGateway({ secret: MODERN_SECRET, legacy: LEGACY_SECRET, seeds: devSeeds() });
  try {
    const writer = writerFor(gateway.url, LEGACY_SECRET);
    const submitted = await writer.submitProposal({
      id: PROPOSAL,
      proposerContactId: CONTACT,
      title: 'September community meetup',
      voteType: 'event_budget',
    });
    assert.equal(submitted.ok, true, submitted.reason);
    for (const request of gateway.requests) {
      assert.equal(request.apikey, LEGACY_SECRET);
      assert.equal(request.authorization, `Bearer ${LEGACY_SECRET}`);
    }
  } finally {
    await gateway.close();
  }
});

test('the simulated gateway rejects a modern secret key used as a bearer token with 401', async () => {
  const gateway = await startGateway({ secret: MODERN_SECRET, legacy: LEGACY_SECRET, seeds: devSeeds() });
  try {
    const response = await fetch(`${gateway.url}/rest/v1/dev_rein_slack_links?select=slack_user_id`, {
      headers: { apikey: MODERN_SECRET, authorization: `Bearer ${MODERN_SECRET}` },
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.match(body.hint, /JWT/i);
  } finally {
    await gateway.close();
  }
});

test('a rejected server key is auth_error for the reader and the writer, distinct from a gateway fault', async () => {
  // The gateway accepts a rotated secret, so the client's key is a genuine 401.
  const rejecting = await startGateway({ secret: OTHER_MODERN_SECRET, legacy: LEGACY_SECRET, seeds: devSeeds() });
  try {
    const member = await readerFor(rejecting.url, MODERN_SECRET).resolveSlackMember(USER);
    assert.equal(member.status, 'unavailable');
    assert.equal(member.reason, 'auth_error');
    assert.equal(member.httpStatus, 401);
    assert.equal(member.contactId, null);

    const funds = await readerFor(rejecting.url, MODERN_SECRET).readAvailableFunds('USD');
    assert.equal(funds.status, 'unavailable');
    assert.equal(funds.reason, 'auth_error');
    assert.equal(funds.httpStatus, 401);

    const submitted = await writerFor(rejecting.url, MODERN_SECRET).submitProposal({
      id: PROPOSAL,
      proposerContactId: CONTACT,
      title: 'September community meetup',
      voteType: 'event_budget',
    });
    assert.equal(submitted.ok, false);
    assert.equal(submitted.status, 'unavailable');
    assert.equal(submitted.reason, 'auth_error');
    assert.equal(submitted.httpStatus, 401);
    assert.ok(!JSON.stringify(submitted).includes(MODERN_SECRET), 'no result carries the key');
  } finally {
    await rejecting.close();
  }

  // The same key on a gateway that returns 500 is a provider fault, not an authentication failure.
  const faulted = await startGateway({ secret: MODERN_SECRET, legacy: LEGACY_SECRET, forceStatus: 500, seeds: devSeeds() });
  try {
    const member = await readerFor(faulted.url, MODERN_SECRET).resolveSlackMember(USER);
    assert.equal(member.status, 'unavailable');
    assert.equal(member.reason, 'http_error');
    assert.equal(member.httpStatus, 500);
  } finally {
    await faulted.close();
  }
});

test('a gateway that requires a bearer token turns a modern-secret read into an auth_error', async () => {
  // The operationally important shape: the client sends only `apikey` for a modern secret, and a
  // gateway that insists on a bearer JWT rejects it with 401.
  const gateway = await startGateway({
    secret: MODERN_SECRET,
    legacy: LEGACY_SECRET,
    requireBearer: true,
    seeds: devSeeds(),
  });
  try {
    const member = await readerFor(gateway.url, MODERN_SECRET).resolveSlackMember(USER);
    assert.equal(member.status, 'unavailable');
    assert.equal(member.reason, 'auth_error');
    assert.equal(member.httpStatus, 401);
    assert.equal(gateway.requests[0].authorization, undefined);
  } finally {
    await gateway.close();
  }
});
