// MVP end-to-end rehearsals: the Slack P0 vertical slice (docs/decisions.md steps 1 to 4, D04, D06,
// D08, D09) driven through the real v2 tool factories over one stateful in-memory store.
//
// What these rehearsals add over `mvp-read-tools.test.mjs`, `mvp-write-tools.test.mjs` and
// `mvp-vote-tally.test.mjs`: those tests script one canned writer answer per scenario, so they prove
// a single tool's behaviour. These drive every turn through the same store across separate
// `create(ctx)` contexts and therefore exercise what no unit test does — that an identifier minted in
// one turn is what the next turn's poll freezes, that the assembled candidate pool is the pool the
// later ballots are checked against, that a proposal which lost one round is offered again in the
// next, that eligibility is re-read from a mutable community record per turn, and that no turn moves
// money, publishes a message or finalizes a decision early.
//
// No live Slack or database is touched: the reader is a synthetic Slack-to-contact directory and the
// writer is an in-memory store that enforces the migration's constraints the way PostgREST plus the
// RLS tables plus the two deterministic RPCs do — an immutable proposal row, a poll whose candidate
// list and limits are frozen from the stored vote type at insert time, one immutable ballot per
// `(poll_id, voter_contact_id)`, a refused ballot outside the stored window, a refused approval that
// is not a frozen candidate, and a finalization the store derives from the stored ballots at the
// stored deadline rather than from anything a caller sends.
//
// Host retry deduplication is *not* simulated across turns: every `create(ctx)` is a fresh turn,
// exactly as `mvp-write-tools.ts` documents for its per-context identifier map. It *is* exercised
// inside one turn, where a repeated tool call id has to meet the record it already wrote.
//
// The actor of every turn comes from `ctx.requesterSenderId` alone. Where a rehearsal needs to show
// that a role is not granted by an argument, the model-supplied argument carries an impersonation or
// policy key and is refused; no rehearsal ever passes an actor or a role into a tool.
//
// Run: node --test tests/mvp-rehearsal.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMvpReadToolRegistration } from '../plugins/rein-operations/mvp-read-tools.ts';
import { createMvpWriteToolRegistration } from '../plugins/rein-operations/mvp-write-tools.ts';

const TEAM = 'T0REHEARSAL';
const PROPOSAL_CHANNEL = 'C_PROPOSAL';
const BOARD_CHANNEL = 'C_BOARD';
const URL_ENV = 'REIN_SUPABASE_URL';
const KEY_ENV = 'REIN_SUPABASE_SERVICE_ROLE_KEY';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The one configured proposal type. Its candidate cap and approval budget are operator
// configuration frozen into a poll at insert time (D08, D09), so the rehearsals read them from the
// stored type instead of assuming a universal number.
const VOTE_TYPE = 'event_budget';
const OTHER_VOTE_TYPE = 'reading_group';
const CAP = 2;
const APPROVAL_BUDGET = 1;

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

// The community record. `contactId` is the private canonical contact the tools resolve and never
// return; `slackUserId` is the trusted host sender. Only `isActiveContributor` and `isDirector` are
// ever visible to a caller.
const CONTRIBUTOR = Object.freeze({
  slackUserId: 'U0CONTRIBUTOR',
  contactId: '11111111-1111-4111-8111-111111111111',
  isActiveContributor: true,
  isDirector: false,
});

const DIRECTOR_A = Object.freeze({
  slackUserId: 'U0DIRECTORA',
  contactId: '22222222-2222-4222-8222-222222222222',
  isActiveContributor: true,
  isDirector: true,
});

const DIRECTOR_B = Object.freeze({
  slackUserId: 'U0DIRECTORB',
  contactId: '33333333-3333-4333-8333-333333333333',
  isActiveContributor: false,
  isDirector: true,
});

const OUTSIDER = Object.freeze({
  slackUserId: 'U0OUTSIDER',
  contactId: '44444444-4444-4444-8444-444444444444',
  isActiveContributor: true,
  isDirector: false,
});

const ALIEN_SENDER = 'U0ALIEN';

const proposalIdFrom = result => {
  assert.equal(result.details.ok, true, JSON.stringify(result.details));
  assert.match(result.details.proposalId, UUID, 'a proposal id is a stored canonical UUID');
  return result.details.proposalId;
};

const pollIdFrom = result => {
  assert.equal(result.details.ok, true, JSON.stringify(result.details));
  assert.match(result.details.pollId, UUID, 'a poll id is a stored canonical UUID');
  return result.details.pollId;
};

/**
 * One synthetic community + database world. Every collection is frozen per instance, so two
 * rehearsals never mix their stored proposals, polls or ballots.
 *
 * `rules` is the stored vote type table. It is what the poll path reads for the candidate cap and
 * the approval budget, and it stays mutable after construction so a rehearsal can prove that a poll
 * freezes the rule it was opened with.
 */
function createWorld({ funds = null, records = [], rules = {} } = {}) {
  const members = new Map(records.map(record => [record.slackUserId, { ...record }]));
  const voteTypes = new Map(
    Object.entries({ [VOTE_TYPE]: { maxCandidates: CAP, maxApprovalsPerVoter: APPROVAL_BUDGET }, ...rules }).map(
      ([name, rule]) => [name, { voteType: name, updatedAt: '2026-09-20T00:00:00.000Z', ...rule }],
    ),
  );
  const proposals = new Map();
  const polls = new Map();
  const ballots = new Map();
  const finalizations = new Map();
  const readTurns = [];
  const readFundsRequests = [];
  const candidatePoolReads = [];
  let currentSway = null;
  // The store's own clock, advanced by every turn. A stored row is stamped with it, exactly as the
  // migration's `created_at` default stamps a row at insert time.
  let currentAt = '2026-09-24T00:00:00.000Z';
  const storeStamp = () => currentAt;

  const asMember = (slackUserId, record) => ({
    status: 'resolved',
    reason: 'resolved',
    contactId: record.contactId,
    isActiveContributor: record.isActiveContributor === true,
    isDirector: record.isDirector === true,
    httpStatus: null,
    slackUserId,
  });

  // A swayed or malformed turn overlays one community record for one turn only, the way an in-flight
  // link revocation or an unavailable provider would.
  const resolveFor = (slackUserId, sway) => {
    if (sway && sway.slackUserId === slackUserId) return { ...sway.result };
    const record = members.get(slackUserId);
    if (!record) {
      return {
        status: 'identity_not_linked',
        reason: 'identity_not_linked',
        contactId: null,
        isActiveContributor: false,
        isDirector: false,
        httpStatus: null,
        slackUserId,
      };
    }
    return asMember(slackUserId, record);
  };

  // The reader is stateful: it answers from the current roster, so a role revoked between turns is
  // seen by the next turn.
  const reader = {
    async resolveSlackMember(slackUserId) {
      readTurns.push({ slackUserId, sway: currentSway });
      return resolveFor(slackUserId, currentSway);
    },
    async readAvailableFunds(currency) {
      readFundsRequests.push(currency);
      if (funds === null) {
        return {
          status: 'unknown',
          reason: 'no_snapshot',
          currency,
          availableMinor: null,
          recordedAt: null,
          recordedBy: null,
          sourceNote: null,
          httpStatus: null,
          authorizesSpending: false,
        };
      }
      return {
        status: 'snapshot',
        reason: 'snapshot',
        ...funds,
        currency,
        authorizesSpending: false,
        httpStatus: null,
      };
    },
  };

  const closedPoll = (status, reason) => ({ ok: false, status, reason, poll: null, httpStatus: null });
  const closedBallot = (status, reason) => ({ ok: false, status, reason, ballot: null, httpStatus: null });
  const finalizationFailure = (status, reason) => ({
    ok: false,
    status,
    reason,
    finalization: null,
    httpStatus: null,
  });
  const storedBallots = pollId =>
    [...ballots.values()]
      .filter(ballot => ballot.pollId === pollId)
      .sort((left, right) =>
        left.castAt === right.castAt ? left.id.localeCompare(right.id) : left.castAt < right.castAt ? -1 : 1,
      );

  const store = {
    proposals,
    polls,
    ballots,
    voteTypes,
    finalizations,
    ballotsFor: storedBallots,
    /** Every currency code the funds reader was asked for, in order. */
    readFundsRequests,
    /** Every identity lookup a turn performed, in order. */
    readTurns,
    /** Every candidate-pool query a poll turn made, in order. */
    candidatePoolReads,
    setRecord(slackUserId, patch) {
      const record = members.get(slackUserId);
      if (record) members.set(slackUserId, { ...record, ...patch });
    },
    setRule(voteType, patch) {
      const rule = voteTypes.get(voteType);
      if (rule) voteTypes.set(voteType, { ...rule, ...patch });
    },
    setFunds(next) {
      funds = next;
    },
    // One turn's clock. It is also the read clock, so a provisional read lands strictly before the
    // deadline and an official read lands at or after it, with no ambiguity about which side.
    turn({ sender, channel, at, sway = null, assertInvocationCurrent = () => {} }) {
      currentSway = sway;
      currentAt = new Date(at).toISOString();
      const ctx = {
        messageChannel: 'slack',
        nativeChannelId: channel,
        requesterSenderId: sender,
        assertInvocationCurrent,
      };
      const clock = () => new Date(at);
      const tools = name => {
        const registration =
          name === 'read'
            ? createMvpReadToolRegistration({ config: baseConfig, reader })
            : createMvpWriteToolRegistration({ config: baseConfig, reader, writer: store, now: clock });
        return registration.create(ctx);
      };
      const tool = (name, toolName) => {
        const found = tools(name).find(item => item.name === toolName);
        assert.ok(found, `tool ${toolName} is registered for this turn`);
        return found;
      };
      return {
        ctx,
        read: (toolName, args) => tool('read', toolName).execute('call-read', args),
        write: (toolName, args, toolCallId = 'call-1') => tool('write', toolName).execute(toolCallId, args),
      };
    },
  };

  let recordCounter = 0;

  // The store itself is the writer. Each method mirrors the migration's constraints so a rehearsal
  // asserts against stored state rather than against a scripted answer.
  Object.assign(store, {
    async submitProposal(input) {
      const existing = proposals.get(input.id);
      if (existing) {
        const same =
          existing.proposerContactId === input.proposerContactId &&
          existing.title === input.title &&
          existing.summary === (input.summary ?? null) &&
          existing.voteType === input.voteType &&
          existing.requestedMinor === (input.requestedMinor ?? null) &&
          existing.currency === (input.currency ?? null);
        return same
          ? {
              ok: true,
              status: 'existing',
              reason: 'existing_identical',
              proposal: existing,
              httpStatus: 409,
              authorizesSpending: false,
            }
          : {
              ok: false,
              status: 'conflict',
              reason: 'proposal_conflict',
              proposal: null,
              httpStatus: 409,
              authorizesSpending: false,
            };
      }
      // The foreign key to the vote type table: an unconfigured type is refused by the database.
      if (!voteTypes.has(input.voteType)) {
        return {
          ok: false,
          status: 'rejected',
          reason: 'proposal_rejected',
          proposal: null,
          httpStatus: 400,
          authorizesSpending: false,
        };
      }
      // The store stamps `created_at` from its own clock, as the migration default does. That stamp
      // is what the candidate query orders by, so a rehearsal that needs a deterministic order
      // submits through `turn()` in the order it wants the proposals offered in.
      const record = {
        id: input.id,
        proposerContactId: input.proposerContactId,
        title: input.title,
        summary: input.summary ?? null,
        voteType: input.voteType,
        requestedMinor: input.requestedMinor ?? null,
        currency: input.currency ?? null,
        status: 'submitted',
        createdAt: storeStamp(),
      };
      proposals.set(record.id, record);
      return {
        ok: true,
        status: 'inserted',
        reason: 'inserted',
        proposal: record,
        httpStatus: 201,
        authorizesSpending: false,
      };
    },

    async createPoll(input) {
      const existing = polls.get(input.id);
      if (existing) {
        const same =
          existing.creatorContactId === input.creatorContactId &&
          existing.title === input.title &&
          existing.voteType === input.voteType &&
          existing.opensAt === input.opensAt &&
          existing.closesAt === input.closesAt &&
          existing.candidateProposalIds.length === input.candidateProposalIds.length &&
          existing.candidateProposalIds.every((id, index) => id === input.candidateProposalIds[index]);
        return same
          ? { ok: true, status: 'existing', reason: 'existing_identical', poll: existing, httpStatus: 409 }
          : { ok: false, status: 'conflict', reason: 'poll_conflict', poll: null, httpStatus: 409 };
      }
      const rule = voteTypes.get(input.voteType);
      // The vote type table is the only source of the cap and the approval budget, and the candidate
      // list is frozen here: a later attempt to widen it cannot reach a stored poll.
      if (!rule) {
        return { ok: false, status: 'rejected', reason: 'poll_rejected', poll: null, httpStatus: 400 };
      }
      const candidates = [...input.candidateProposalIds];
      if (candidates.length < 1 || candidates.length > rule.maxCandidates) {
        return { ok: false, status: 'rejected', reason: 'poll_rejected', poll: null, httpStatus: 400 };
      }
      const record = {
        id: input.id,
        creatorContactId: input.creatorContactId,
        title: input.title,
        voteType: input.voteType,
        candidateProposalIds: Object.freeze(candidates),
        candidateLimit: rule.maxCandidates,
        maxApprovalsPerVoter: rule.maxApprovalsPerVoter,
        status: 'open',
        opensAt: input.opensAt,
        closesAt: input.closesAt,
        createdAt: storeStamp(),
      };
      polls.set(record.id, record);
      return { ok: true, status: 'inserted', reason: 'inserted', poll: record, httpStatus: 201 };
    },

    async getVoteType(voteType) {
      const rule = voteTypes.get(voteType);
      if (!rule) {
        return { ok: false, status: 'rejected', reason: 'vote_type_not_found', voteType: null, httpStatus: 404 };
      }
      return { ok: true, status: 'found', reason: 'vote_type', voteType: rule, httpStatus: 200 };
    },

    async listCandidateProposals(input) {
      candidatePoolReads.push({
        voteType: input.voteType,
        limit: input.limit,
        submittedSince: input.submittedSince ?? null,
        includeRecentlyUnselected: input.includeRecentlyUnselected ?? false,
      });
      const rule = voteTypes.get(input.voteType);
      if (!rule) {
        return { ok: false, status: 'rejected', reason: 'vote_type_not_found', proposals: null, httpStatus: 404 };
      }
      const limit = input.limit ?? rule.maxCandidates;
      // The store answers in the order the real query does: the most recently created `unselected`
      // proposals first, then the eligible `submitted` and `unselected` ones by ascending creation.
      const eligible = [...proposals.values()].filter(proposal => proposal.voteType === input.voteType);
      const recent = eligible
        .filter(proposal => proposal.status === 'unselected')
        .sort((left, right) =>
          left.createdAt === right.createdAt
            ? right.id.localeCompare(left.id)
            : left.createdAt < right.createdAt
              ? 1
              : -1,
        );
      const fetched = eligible
        .filter(proposal => proposal.status === 'submitted' || proposal.status === 'unselected')
        .sort((left, right) =>
          left.createdAt === right.createdAt
            ? left.id.localeCompare(right.id)
            : left.createdAt < right.createdAt
              ? -1
              : 1,
        );
      const seen = new Set();
      const page = [];
      for (const proposal of [...recent, ...fetched]) {
        if (seen.has(proposal.id)) continue;
        if (input.submittedSince && proposal.createdAt < input.submittedSince) continue;
        seen.add(proposal.id);
        page.push(proposal);
        if (page.length === limit) break;
      }
      return { ok: true, status: 'found', reason: 'candidates', proposals: page, httpStatus: 200 };
    },

    async castBallot(input) {
      const poll = polls.get(input.pollId);
      if (!poll) return closedBallot('rejected', 'poll_not_found');
      const approvals = [...(input.approvedProposalIds ?? [])];
      // The database re-checks the frozen candidate list and the frozen approval budget, and a
      // repeated or changed ballot never replaces a recorded one.
      if (approvals.length > poll.maxApprovalsPerVoter) return closedBallot('rejected', 'ballot_rejected');
      if (approvals.some(id => !poll.candidateProposalIds.includes(id))) {
        return closedBallot('rejected', 'ballot_rejected');
      }
      const key = `${input.pollId}:${input.voterContactId}`;
      const existing = ballots.get(key);
      if (existing) {
        const same =
          existing.approvedProposalIds.length === approvals.length &&
          existing.approvedProposalIds.every((id, index) => id === approvals[index]);
        return same
          ? { ok: true, status: 'existing', reason: 'existing_identical', ballot: existing, httpStatus: 409 }
          : { ok: false, status: 'conflict', reason: 'ballot_conflict', ballot: null, httpStatus: 409 };
      }
      if (input.windowRejects === true) return closedBallot('rejected', 'poll_closed');
      recordCounter += 1;
      const record = {
        id: `00000000-0000-4000-8000-${String(recordCounter).padStart(12, '0')}`,
        pollId: input.pollId,
        voterContactId: input.voterContactId,
        approvedProposalIds: Object.freeze(approvals),
        castAt: storeStamp(),
      };
      ballots.set(key, record);
      return {
        ok: true,
        status: 'inserted',
        reason: 'inserted',
        ballot: {
          pollId: record.pollId,
          voterContactId: record.voterContactId,
          approvedProposalIds: record.approvedProposalIds,
        },
        httpStatus: 201,
      };
    },

    async getPoll(id) {
      const poll = polls.get(id);
      if (!poll) return closedPoll('rejected', 'poll_not_found');
      return { ok: true, status: 'found', reason: 'poll', poll, httpStatus: 200 };
    },

    async listBallots(pollId) {
      if (!polls.has(pollId)) {
        return { ok: false, status: 'rejected', reason: 'poll_not_found', ballots: null, httpStatus: null };
      }
      return {
        ok: true,
        status: 'found',
        reason: 'ballots',
        ballots: Object.freeze(storedBallots(pollId)),
        httpStatus: 200,
      };
    },

    /**
     * The `rein_mvp_finalize_poll` RPC: it counts the stored ballots at one equal weight each, stores
     * one outcome and replays that stored outcome on every later call. The caller cannot hand it a
     * count, a winner or a weight, and the deadline is the stored poll window rather than a caller's
     * word for it.
     */
    async finalizePoll(input) {
      const poll = polls.get(input.pollId);
      if (!poll) return finalizationFailure('rejected', 'poll_not_found');
      const known = finalizations.get(input.pollId);
      if (known) {
        return {
          ok: true,
          status: 'existing',
          reason: 'existing_finalized',
          finalization: { ...known, repeated: true },
          httpStatus: 200,
        };
      }
      if (poll.status !== 'open') return finalizationFailure('rejected', 'finalize_rejected');
      const counted = storedBallots(input.pollId);
      const counts = new Map(poll.candidateProposalIds.map(id => [id, 0]));
      let abstentions = 0;
      for (const ballot of counted) {
        if (ballot.approvedProposalIds.length === 0) abstentions += 1;
        for (const id of ballot.approvedProposalIds) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const highest = Math.max(...poll.candidateProposalIds.map(id => counts.get(id) ?? 0));
      const leaders = poll.candidateProposalIds.filter(id => (counts.get(id) ?? 0) === highest);
      const outcome = highest === 0 || leaders.length !== 1 ? 'no_winner' : 'winner';
      const approvals = poll.candidateProposalIds
        .map(id => ({ proposalId: id, approvals: counts.get(id) ?? 0 }))
        .filter(entry => entry.approvals > 0)
        .sort((left, right) => right.approvals - left.approvals || left.proposalId.localeCompare(right.proposalId));
      const record = {
        pollId: input.pollId,
        status: 'closed',
        repeated: false,
        outcome,
        winningProposalId: outcome === 'winner' ? leaders[0] : null,
        finalizedByContactId: input.actorContactId,
        candidates: [...poll.candidateProposalIds],
        proposalsRecorded: 0,
        ballots: counted.length,
        abstentions,
        approvals,
      };
      finalizations.set(input.pollId, record);
      polls.set(input.pollId, { ...poll, status: 'closed' });
      // A round that produced a winner marks its winning proposal selected and every other candidate
      // unselected, which is what lets a later round re-offer a proposal that lost.
      for (const id of poll.candidateProposalIds) {
        const proposal = proposals.get(id);
        if (!proposal) continue;
        proposals.set(id, { ...proposal, status: id === record.winningProposalId ? 'selected' : 'unselected' });
      }
      return { ok: true, status: 'inserted', reason: 'finalized', finalization: record, httpStatus: 200 };
    },
  });

  return store;
}

const at = iso => new Date(iso);

// ---------------------------------------------------------------------------------------------
// Rehearsal 1: the full vertical slice, from a Contributor proposal to an official decision.
// ---------------------------------------------------------------------------------------------

test('a Slack rehearsal runs proposal intake, a capped candidate pool, ballots and an official decision across turns', async () => {
  const world = createWorld({
    records: [CONTRIBUTOR, DIRECTOR_A, DIRECTOR_B, OUTSIDER],
    funds: {
      availableMinor: 500000,
      recordedAt: '2026-09-21T09:00:00Z',
      recordedBy: 'ops@rein.example',
      sourceNote: null,
    },
  });

  // Turn 1 (proposal channel, active Contributor). The model-supplied argument carries an
  // impersonation key, which is refused before any identity lookup, so this turn stores nothing.
  const injected = await world
    .turn({ sender: CONTRIBUTOR.slackUserId, channel: PROPOSAL_CHANNEL, at: at('2026-09-24T09:00:00Z') })
    .write('rein_mvp_proposal_submit', {
      voteType: VOTE_TYPE,
      title: 'Repair the workshop roof',
      summary: 'Replace two broken tiles',
      proposerContactId: DIRECTOR_A.contactId,
    });
  assert.equal(injected.details.error, 'actor_argument_rejected');
  assert.equal(world.proposals.size, 0, 'a claimed actor never creates a record');
  assert.deepEqual(world.readTurns, [], 'a refused argument never resolves an identity');

  // Turn 2 (proposal channel, active Contributor). The acting contact comes only from the host
  // context; the amount is stored as a request against the configured proposal type.
  const proposalTurn = world.turn({
    sender: CONTRIBUTOR.slackUserId,
    channel: PROPOSAL_CHANNEL,
    at: at('2026-09-24T09:05:00Z'),
  });
  const submitted = await proposalTurn.write('rein_mvp_proposal_submit', {
    voteType: VOTE_TYPE,
    title: 'Repair the workshop roof',
    summary: 'Replace two broken tiles',
    requestedMinor: 120000,
    currency: 'usd',
  });
  const proposalId = proposalIdFrom(submitted);
  assert.equal(submitted.details.authorizesSpending, false, 'a stored request never authorizes money');
  const storedProposal = world.proposals.get(proposalId);
  assert.equal(
    storedProposal.proposerContactId,
    CONTRIBUTOR.contactId,
    'the host sender resolved to its own contact',
  );
  assert.equal(storedProposal.voteType, VOTE_TYPE);
  assert.equal(storedProposal.currency, 'USD');
  assert.equal(storedProposal.requestedMinor, 120000);
  assert.equal(storedProposal.status, 'submitted');
  assert.ok(
    !submitted.content[0].text.includes(CONTRIBUTOR.contactId),
    'the private contact id is never returned',
  );

  // Turn 3 (proposal channel, an unlinked sender). A lookup failure is not eligibility.
  const alienTurn = world.turn({ sender: ALIEN_SENDER, channel: PROPOSAL_CHANNEL, at: at('2026-09-24T09:10:00Z') });
  const alienRead = await alienTurn.read('rein_mvp_my_status', {});
  assert.equal(alienRead.details.linked, false);
  assert.equal(alienRead.details.isActiveContributor, false);
  const alienSubmit = await alienTurn.write('rein_mvp_proposal_submit', {
    voteType: VOTE_TYPE,
    title: 'Unlinked request',
  });
  assert.equal(alienSubmit.details.error, 'identity_link_required');
  assert.equal(world.proposals.size, 1, 'an unlinked sender adds no proposal');

  // Turn 4 (proposal channel, an unknown proposal type). The stored type table is the authority, so
  // an unconfigured name is refused by the store instead of being invented here.
  const unknownType = await world
    .turn({ sender: CONTRIBUTOR.slackUserId, channel: PROPOSAL_CHANNEL, at: at('2026-09-24T09:12:00Z') })
    .write('rein_mvp_proposal_submit', { voteType: 'not_configured', title: 'Unconfigured request' });
  assert.equal(unknownType.details.ok, false);
  assert.equal(unknownType.details.error, 'proposal_rejected');
  assert.equal(world.proposals.size, 1, 'an unconfigured type stores no proposal');

  // Turn 5 (Board channel, director A). No candidate list, cap or label is accepted from the caller:
  // the round takes its cap from the stored type and the Agent reads the pool over the stored
  // proposals of that type. The deadline is explicit and frozen here.
  const openTurn = world.turn({
    sender: DIRECTOR_A.slackUserId,
    channel: BOARD_CHANNEL,
    at: at('2026-09-24T10:00:00Z'),
  });
  const opened = await openTurn.write('rein_mvp_poll_open', {
    voteType: VOTE_TYPE,
    title: 'Fund the repair workshop?',
    closesAt: '2026-09-26T18:00:00Z',
  });
  const pollId = pollIdFrom(opened);
  const storedPoll = world.polls.get(pollId);
  assert.equal(storedPoll.creatorContactId, DIRECTOR_A.contactId);
  assert.equal(storedPoll.voteType, VOTE_TYPE);
  assert.equal(storedPoll.opensAt, '2026-09-24T10:00:00.000Z', 'the round opens at the trusted clock instant');
  assert.equal(storedPoll.closesAt, '2026-09-26T18:00:00Z');
  assert.deepEqual(storedPoll.candidateProposalIds, [proposalId], 'the pool is the submitted proposal of this type');
  assert.equal(storedPoll.candidateLimit, CAP, 'the cap is frozen from the stored vote type');
  assert.equal(storedPoll.maxApprovalsPerVoter, APPROVAL_BUDGET);
  assert.deepEqual(opened.details.candidateProposalIds, [proposalId]);
  assert.equal(opened.details.candidateLimit, CAP);
  assert.equal(opened.details.maxApprovalsPerVoter, APPROVAL_BUDGET);
  assert.equal(opened.details.authorizesSpending, false);
  assert.deepEqual(world.candidatePoolReads, [
    { voteType: VOTE_TYPE, limit: CAP, submittedSince: null, includeRecentlyUnselected: true },
  ]);
  assert.equal(world.ballots.size, 0, 'opening a poll records no ballot');
  assert.ok(!opened.content[0].text.includes(DIRECTOR_A.contactId), 'the creator contact id is not returned');

  // Turn 6 (proposal channel, director A). Directorship does not make the Board tools reachable from
  // an unapproved native channel.
  const wrongChannel = await world
    .turn({ sender: DIRECTOR_A.slackUserId, channel: PROPOSAL_CHANNEL, at: at('2026-09-24T11:00:00Z') })
    .write('rein_mvp_vote', { pollId, approvedProposalIds: [proposalId] });
  assert.equal(wrongChannel.details.error, 'channel_out_of_scope');
  assert.equal(world.ballots.size, 0, 'a refused channel records no ballot');

  // Turn 7 (Board channel, a non-director Contributor). The directory decides the role, not the
  // caller, so no ballot is recorded.
  const outsiderVote = await world
    .turn({ sender: OUTSIDER.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-25T10:00:00Z') })
    .write('rein_mvp_vote', { pollId, approvedProposalIds: [proposalId] });
  assert.equal(outsiderVote.details.error, 'board_membership_required');
  assert.equal(world.ballots.size, 0, 'a non-director ballot never reaches the store');

  // Turn 8 (Board channel, director A): one approval. Turn 9 (Board channel, director B): an empty
  // approval list, which is the abstention and casts no approval (D04). Each turn is its own
  // `create(ctx)` context, so each ballot is a first ballot.
  const directorAVote = await world
    .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-25T11:00:00Z') })
    .write('rein_mvp_vote', { pollId, approvedProposalIds: [proposalId] });
  assert.equal(directorAVote.details.ok, true);
  assert.equal(directorAVote.details.recorded, true);
  assert.equal(directorAVote.details.approvalCount, 1);
  assert.equal(directorAVote.details.abstained, false);
  assert.equal(directorAVote.details.authorizesSpending, false);
  const directorBVote = await world
    .turn({ sender: DIRECTOR_B.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-25T12:00:00Z') })
    .write('rein_mvp_vote', { pollId, approvedProposalIds: [] });
  assert.equal(directorBVote.details.ok, true);
  assert.equal(directorBVote.details.abstained, true);
  assert.equal(directorBVote.details.approvalCount, 0);
  assert.deepEqual(
    world.ballotsFor(pollId).map(ballot => [ballot.voterContactId, [...ballot.approvedProposalIds]]),
    [
      [DIRECTOR_A.contactId, [proposalId]],
      [DIRECTOR_B.contactId, []],
    ],
    'two directors hold one stored ballot each',
  );

  // Turn 10 (Board channel, director A). Before the deadline the counts stay provisional: the tool
  // publishes no winner and no counts at all, even though the store already holds both ballots, and
  // it finalizes nothing.
  const provisional = await world
    .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-26T17:59:00Z') })
    .write('rein_mvp_poll_result', { pollId });
  assert.equal(provisional.details.ok, false);
  assert.equal(provisional.details.status, 'provisional');
  assert.equal(provisional.details.reason, 'poll_still_open');
  assert.equal(provisional.details.closed, false);
  assert.equal(provisional.details.official, false);
  assert.equal(provisional.details.winner, null);
  assert.equal(provisional.details.counts, null, 'a provisional read publishes no tally');
  assert.equal(provisional.details.totalBallots, 2, 'the recorded ballots are counted as a readable fact');
  assert.equal(provisional.details.finalized, false);
  assert.equal(world.finalizations.size, 0, 'nothing is finalized before the deadline');

  // Turn 11 (Board channel, director B). At or after the deadline the stored outcome is official.
  const official = await world
    .turn({ sender: DIRECTOR_B.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-26T18:00:01Z') })
    .write('rein_mvp_poll_result', { pollId });
  assert.equal(official.details.ok, true);
  assert.equal(official.details.closed, true);
  assert.equal(official.details.official, true);
  assert.equal(official.details.outcome, 'winner');
  assert.equal(official.details.winner, proposalId);
  assert.deepEqual({ ...official.details.counts }, { [proposalId]: 1 });
  assert.equal(official.details.abstainCount, 1, 'an abstention contributes zero approvals');
  assert.equal(official.details.totalBallots, 2);
  assert.deepEqual(official.details.candidates, [proposalId]);
  assert.equal(
    official.details.eligibleVoters,
    undefined,
    'the recorded ballots are not an electorate, so no eligible-voter figure is published',
  );
  assert.equal(official.details.finalized, true);
  assert.equal(official.details.repeated, false);
  assert.equal(official.details.authorizesSpending, false, 'a vote outcome never moves money');
  assert.ok(!official.content[0].text.includes(DIRECTOR_A.contactId), 'the finalizing director is not returned');

  // Turn 12 (Board channel, director A). A second read of a finalized round replays the stored
  // outcome: the finalization wrote `status = 'closed'`, and a `closed` row is answered by the same
  // idempotent `finalizePoll` call, which returns the record already stored instead of writing a
  // second one. A cancelled round is the only non-`open` row that still reads as provisional.
  const replay = await world
    .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-26T18:10:00Z') })
    .write('rein_mvp_poll_result', { pollId });
  assert.equal(replay.details.ok, true, 'a finalized round replays its stored outcome');
  assert.equal(replay.details.status, 'existing');
  assert.equal(replay.details.reason, 'existing_finalized');
  assert.equal(replay.details.official, true);
  assert.equal(replay.details.finalized, true);
  assert.equal(replay.details.outcome, 'winner');
  assert.equal(replay.details.winner, proposalId, 'the stored winner is re-published from the closed row');
  assert.deepEqual({ ...replay.details.counts }, { [proposalId]: 1 });
  assert.equal(replay.details.repeated, true, 'the database reports the record was already stored');
  assert.equal(world.finalizations.size, 1, 'the round still holds exactly one stored outcome');
  assert.equal(world.finalizations.get(pollId).outcome, 'winner', 'the stored outcome itself is unchanged');
  assert.equal(world.finalizations.get(pollId).winningProposalId, proposalId);

  // Turn 13 (Board channel, director A). A late ballot is refused by the recorded deadline and the
  // stored ballot set is unchanged.
  const lateVote = await world
    .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-26T18:30:00Z') })
    .write('rein_mvp_vote', { pollId, approvedProposalIds: [] });
  assert.equal(lateVote.details.error, 'poll_closed');
  assert.equal(world.ballots.size, 2, 'a late ballot is refused, not recorded');

  // Turn 14 (Board channel, director B). The funds figure is a read-only snapshot, and the poll
  // result never rewrote it.
  const fundsTurn = world.turn({
    sender: DIRECTOR_B.slackUserId,
    channel: BOARD_CHANNEL,
    at: at('2026-09-26T19:00:00Z'),
  });
  const funds = await fundsTurn.read('rein_mvp_funds', { currency: 'usd' });
  assert.equal(funds.details.status, 'snapshot');
  assert.equal(funds.details.availableMinor, 500000, 'the funds figure is the human-entered snapshot, untouched');
  assert.equal(funds.details.authorizesSpending, false);
  assert.deepEqual(world.readFundsRequests, ['USD'], 'the snapshot is read once, for the normalized code');

  // Turn 15 (Board channel, a non-director). Funds stay out of reach even after the official result.
  const outsiderFunds = await world
    .turn({ sender: OUTSIDER.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-26T19:05:00Z') })
    .read('rein_mvp_funds', { currency: 'USD' });
  assert.equal(outsiderFunds.details.error, 'board_membership_required');

  // Turn 16 (proposal channel, director B). A failed identity lookup is not eligibility: an
  // unavailable provider never reads as an active Contributor.
  const swayed = await world
    .turn({
      sender: DIRECTOR_B.slackUserId,
      channel: PROPOSAL_CHANNEL,
      at: at('2026-09-26T19:10:00Z'),
      sway: {
        slackUserId: DIRECTOR_B.slackUserId,
        result: {
          status: 'unavailable',
          reason: 'transport_error',
          contactId: null,
          isActiveContributor: false,
          isDirector: false,
          httpStatus: 503,
          slackUserId: DIRECTOR_B.slackUserId,
        },
      },
    })
    .write('rein_mvp_proposal_submit', { voteType: VOTE_TYPE, title: 'Request during an outage' });
  assert.equal(swayed.details.error, 'identity_link_required');
  assert.equal(world.proposals.size, 1, 'an outage stores no proposal');

  // Nothing was posted anywhere: the candidate freeze survived every later turn.
  assert.deepEqual(world.polls.get(pollId).candidateProposalIds, [proposalId]);
  assert.equal(world.polls.get(pollId).status, 'closed');
});

// ---------------------------------------------------------------------------------------------
// Rehearsal 2: the same integration proves its refusals. A tie and an unanswered round are never a
// named winner, a withdrawn director writes nothing, and a stale turn is refused at the guard.
// ---------------------------------------------------------------------------------------------

test('a Slack rehearsal refuses to name a winner for a tie, an unanswered round or a withdrawn director', async () => {
  const world = createWorld({ records: [CONTRIBUTOR, DIRECTOR_A, DIRECTOR_B, OUTSIDER] });

  const submitted = await world
    .turn({ sender: CONTRIBUTOR.slackUserId, channel: PROPOSAL_CHANNEL, at: at('2026-09-24T09:00:00Z') })
    .write('rein_mvp_proposal_submit', { voteType: VOTE_TYPE, title: 'Repair the workshop roof' });
  assert.equal(submitted.details.ok, true, 'a proposal without an amount is still a valid request');
  const proposalId = proposalIdFrom(submitted);

  // A round over two candidates of the same type, so a two-way tie is possible.
  const second = proposalIdFrom(
    await world
      .turn({ sender: CONTRIBUTOR.slackUserId, channel: PROPOSAL_CHANNEL, at: at('2026-09-24T09:30:00Z') })
      .write('rein_mvp_proposal_submit', { voteType: VOTE_TYPE, title: 'Fund the reading group' }),
  );
  // A director who is not an active Contributor can still open a round: the Board role and the
  // Contributor record are separate, and a poll needs only the Board role.
  const pollId = pollIdFrom(
    await world
      .turn({ sender: DIRECTOR_B.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-24T10:00:00Z') })
      .write('rein_mvp_poll_open', {
        voteType: VOTE_TYPE,
        title: 'Fund the repair workshop?',
        closesAt: '2026-09-26T18:00:00Z',
      }),
  );
  assert.deepEqual(world.polls.get(pollId).candidateProposalIds, [proposalId, second]);

  // A tied ballot set: each candidate holds one approval, so there is no adopted tie rule to name a
  // winner out of a two-way tie.
  const firstBallot = await world
    .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-25T11:00:00Z') })
    .write('rein_mvp_vote', { pollId, approvedProposalIds: [proposalId] });
  assert.equal(firstBallot.details.ok, true);
  const secondBallot = await world
    .turn({ sender: DIRECTOR_B.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-25T12:00:00Z') })
    .write('rein_mvp_vote', { pollId, approvedProposalIds: [second] });
  assert.equal(secondBallot.details.ok, true);

  const tied = await world
    .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-26T18:00:01Z') })
    .write('rein_mvp_poll_result', { pollId });
  assert.equal(tied.details.closed, true);
  assert.equal(tied.details.official, true);
  assert.equal(tied.details.outcome, 'no_winner', 'a tied round is stored as no winner by rule');
  assert.equal(tied.details.winner, null);
  assert.deepEqual({ ...tied.details.counts }, { [proposalId]: 1, [second]: 1 }, 'the recorded counts are reported');
  assert.equal(tied.details.authorizesSpending, false);

  // A non-director who tries to add a third ballot is refused and the stored set is unchanged.
  const outsider = await world
    .turn({ sender: OUTSIDER.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-26T18:10:00Z') })
    .write('rein_mvp_vote', { pollId, approvedProposalIds: [] });
  assert.equal(outsider.details.error, 'board_membership_required');
  assert.equal(world.ballots.size, 2, 'a non-director cannot add a third ballot');

  // A repeat read of the finalized tie replays the stored `no_winner` outcome from the closed row.
  const stillTied = await world
    .turn({ sender: DIRECTOR_B.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-26T18:20:00Z') })
    .write('rein_mvp_poll_result', { pollId });
  assert.equal(stillTied.details.ok, true);
  assert.equal(stillTied.details.reason, 'existing_finalized');
  assert.equal(stillTied.details.outcome, 'no_winner', 'the stored tie outcome is replayed');
  assert.equal(stillTied.details.winner, null, 'a tie names no winner on the first read or any later one');
  assert.deepEqual({ ...stillTied.details.counts }, { [proposalId]: 1, [second]: 1 }, 'the stored counts replay');
  assert.equal(world.finalizations.get(pollId).outcome, 'no_winner', 'the stored tie outcome is unchanged');

  // A round nobody answers is equally not a decision, and it is not reported as a zero-vote outcome.
  const emptyWorld = createWorld({ records: [CONTRIBUTOR, DIRECTOR_A] });
  await emptyWorld
    .turn({ sender: CONTRIBUTOR.slackUserId, channel: PROPOSAL_CHANNEL, at: at('2026-09-24T09:00:00Z') })
    .write('rein_mvp_proposal_submit', { voteType: VOTE_TYPE, title: 'Fund the reading group' });
  const emptyPollId = pollIdFrom(
    await emptyWorld
      .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-24T10:00:00Z') })
      .write('rein_mvp_poll_open', {
        voteType: VOTE_TYPE,
        title: 'Fund the reading group?',
        closesAt: '2026-09-26T18:00:00Z',
      }),
  );
  const empty = await emptyWorld
    .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-26T18:00:01Z') })
    .write('rein_mvp_poll_result', { pollId: emptyPollId });
  assert.equal(empty.details.ok, true);
  assert.equal(empty.details.closed, true);
  assert.equal(empty.details.official, true);
  assert.equal(empty.details.outcome, 'no_winner');
  assert.equal(empty.details.winner, null);
  assert.equal(empty.details.totalBallots, 0);
  assert.equal(empty.details.abstainCount, 0);
  assert.deepEqual({ ...empty.details.counts }, {});

  // An all-abstain round is participation with no approval: it produces no winner and the stored
  // outcome says so.
  const abstainWorld = createWorld({ records: [CONTRIBUTOR, DIRECTOR_A, DIRECTOR_B] });
  await abstainWorld
    .turn({ sender: CONTRIBUTOR.slackUserId, channel: PROPOSAL_CHANNEL, at: at('2026-09-24T09:00:00Z') })
    .write('rein_mvp_proposal_submit', { voteType: VOTE_TYPE, title: 'Fund the reading group' });
  const abstainPollId = pollIdFrom(
    await abstainWorld
      .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-24T10:00:00Z') })
      .write('rein_mvp_poll_open', {
        voteType: VOTE_TYPE,
        title: 'Fund the reading group?',
        closesAt: '2026-09-26T18:00:00Z',
      }),
  );
  await abstainWorld
    .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-25T11:00:00Z') })
    .write('rein_mvp_vote', { pollId: abstainPollId, approvedProposalIds: [] });
  await abstainWorld
    .turn({ sender: DIRECTOR_B.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-25T12:00:00Z') })
    .write('rein_mvp_vote', { pollId: abstainPollId, approvedProposalIds: [] });
  const allAbstain = await abstainWorld
    .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-26T18:00:01Z') })
    .write('rein_mvp_poll_result', { pollId: abstainPollId });
  assert.equal(allAbstain.details.outcome, 'no_winner');
  assert.equal(allAbstain.details.winner, null);
  assert.equal(allAbstain.details.abstainCount, 2, 'both directors participated by abstaining');
  assert.equal(allAbstain.details.totalBallots, 2);

  // A director whose Board role is withdrawn between turns loses the live capability.
  world.setRecord(DIRECTOR_A.slackUserId, { isDirector: false });
  const withdrawnVote = await world
    .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-26T19:00:00Z') })
    .write('rein_mvp_vote', { pollId, approvedProposalIds: [] });
  assert.equal(withdrawnVote.details.error, 'board_membership_required');
  const withdrawnResult = await world
    .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-26T19:05:00Z') })
    .write('rein_mvp_poll_result', { pollId });
  assert.equal(withdrawnResult.details.error, 'board_membership_required');
  assert.equal(world.ballots.size, 2, 'a withdrawn director writes nothing');

  // The stale-guard and immutability checks below need a round that is still inside its voting
  // window, because the finalized tie above now reads `closed` and the store refuses a ballot on the
  // deadline before the guard is ever reached. A second, open round over the same two candidates.
  const liveWorld = createWorld({ records: [CONTRIBUTOR, DIRECTOR_A, DIRECTOR_B] });
  const liveFirst = proposalIdFrom(
    await liveWorld
      .turn({ sender: CONTRIBUTOR.slackUserId, channel: PROPOSAL_CHANNEL, at: at('2026-09-24T09:00:00Z') })
      .write('rein_mvp_proposal_submit', { voteType: VOTE_TYPE, title: 'Repair the workshop roof' }),
  );
  const liveSecond = proposalIdFrom(
    await liveWorld
      .turn({ sender: CONTRIBUTOR.slackUserId, channel: PROPOSAL_CHANNEL, at: at('2026-09-24T09:30:00Z') })
      .write('rein_mvp_proposal_submit', { voteType: VOTE_TYPE, title: 'Fund the reading group' }),
  );
  const livePollId = pollIdFrom(
    await liveWorld
      .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-24T10:00:00Z') })
      .write('rein_mvp_poll_open', {
        voteType: VOTE_TYPE,
        title: 'A round still inside its window',
        closesAt: '2026-09-26T18:00:00Z',
      }),
  );
  // Director B records one ballot inside the window; that ballot is what the later change cannot
  // replace.
  await liveWorld
    .turn({ sender: DIRECTOR_B.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-25T11:00:00Z') })
    .write('rein_mvp_vote', { pollId: livePollId, approvedProposalIds: [liveSecond] });

  // A stale turn cannot write: the host guard is the last step before the write. The clock is inside
  // the voting window, the sender is a current director, and the ballot is a valid first ballot for
  // this round, so the deadline and eligibility checks pass and the guard is the step that refuses.
  let invocations = 0;
  const stale = await liveWorld
    .turn({
      sender: DIRECTOR_A.slackUserId,
      channel: BOARD_CHANNEL,
      at: at('2026-09-25T13:00:00Z'),
      assertInvocationCurrent: () => {
        invocations += 1;
        throw new Error('cancelled');
      },
    })
    .write('rein_mvp_vote', { pollId: livePollId, approvedProposalIds: [liveFirst] });
  assert.equal(stale.details.ok, false);
  assert.equal(stale.details.error, 'tool_failed', 'a thrown guard collapses to a fixed code');
  assert.equal(invocations, 1, 'the guard runs before the write');
  assert.equal(liveWorld.ballots.size, 1, 'a cancelled turn records no ballot');

  // A director who already voted cannot change the recorded ballot: inside the window the store
  // answers `conflict`, and the tool never reports a replacement.
  const changeAttempt = await liveWorld
    .turn({ sender: DIRECTOR_B.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-25T15:00:00Z') })
    .write('rein_mvp_vote', { pollId: livePollId, approvedProposalIds: [liveFirst] });
  assert.equal(changeAttempt.details.ok, false, 'a recorded ballot is immutable');
  assert.equal(changeAttempt.details.status, 'conflict');
  assert.equal(changeAttempt.details.reason, 'ballot_conflict');
  assert.equal(changeAttempt.details.replaced, false, 'a recorded ballot is never replaced');
  assert.equal(liveWorld.ballots.size, 1, 'a conflicted change adds no ballot');
  assert.deepEqual(
    [
      ...liveWorld
        .ballotsFor(livePollId)
        .find(ballot => ballot.voterContactId === DIRECTOR_B.contactId)
        .approvedProposalIds,
    ],
    [liveSecond],
    'the first recorded choice survives the attempted change',
  );
});

// ---------------------------------------------------------------------------------------------
// Rehearsal 3: the round itself. The cap bounds the pool, a losing proposal is offered again, a
// single-candidate round is valid, and a multi-approval type spends its approval budget.
// ---------------------------------------------------------------------------------------------

test('a rehearsal assembles a capped pool, re-offers a proposal that lost and honours the approval budget', async () => {
  const world = createWorld({
    records: [CONTRIBUTOR, DIRECTOR_A, DIRECTOR_B],
    rules: {
      [VOTE_TYPE]: { maxCandidates: 2, maxApprovalsPerVoter: 2 },
      // A second configured type, so the rehearsal can prove that another type's proposal is never a
      // candidate of this round.
      [OTHER_VOTE_TYPE]: { maxCandidates: 5, maxApprovalsPerVoter: 1 },
    },
  });
  const submit = (title, when) =>
    world
      .turn({ sender: CONTRIBUTOR.slackUserId, channel: PROPOSAL_CHANNEL, at: at(when) })
      .write('rein_mvp_proposal_submit', { voteType: VOTE_TYPE, title });

  const first = proposalIdFrom(await submit('Repair the workshop roof', '2026-09-24T08:00:00Z'));
  const second = proposalIdFrom(await submit('Fund the reading group', '2026-09-24T08:10:00Z'));
  const third = proposalIdFrom(await submit('Replace the projector', '2026-09-24T08:20:00Z'));
  // A proposal of another type is never a candidate of this round.
  const foreign = proposalIdFrom(
    await world
      .turn({ sender: CONTRIBUTOR.slackUserId, channel: PROPOSAL_CHANNEL, at: at('2026-09-24T08:30:00Z') })
      .write('rein_mvp_proposal_submit', { voteType: OTHER_VOTE_TYPE, title: 'Buy more paper' }),
  );
  assert.equal(world.proposals.size, 4);
  assert.equal(world.proposals.get(foreign).voteType, OTHER_VOTE_TYPE);

  // The cap is two, so the round is opened over the first two eligible proposals and the third stays
  // out of the frozen candidate list.
  const roundOneId = pollIdFrom(
    await world
      .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-24T10:00:00Z') })
      .write('rein_mvp_poll_open', { voteType: VOTE_TYPE, title: 'Round one', closesAt: '2026-09-26T18:00:00Z' }),
  );
  const roundOne = world.polls.get(roundOneId);
  assert.equal(roundOne.candidateLimit, 2);
  assert.equal(roundOne.candidateProposalIds.length, 2, 'the caller cannot widen the round past the cap');
  assert.deepEqual(roundOne.candidateProposalIds, [first, second]);
  assert.ok(!roundOne.candidateProposalIds.includes(foreign), 'another type is never a candidate');
  assert.ok(!roundOne.candidateProposalIds.includes(third), 'the cap keeps the third proposal out');

  // One ballot spends two approvals, which this type allows.
  const twoApprovals = await world
    .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-25T11:00:00Z') })
    .write('rein_mvp_vote', { pollId: roundOneId, approvedProposalIds: [first, second] });
  assert.equal(twoApprovals.details.ok, true);
  assert.equal(twoApprovals.details.approvalCount, 2);

  // A second director approves only the first candidate, so that candidate wins uniquely.
  await world
    .turn({ sender: DIRECTOR_B.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-25T12:00:00Z') })
    .write('rein_mvp_vote', { pollId: roundOneId, approvedProposalIds: [first] });

  const result = await world
    .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-26T18:00:01Z') })
    .write('rein_mvp_poll_result', { pollId: roundOneId });
  assert.equal(result.details.outcome, 'winner');
  assert.equal(result.details.winner, first);
  assert.deepEqual(
    { ...result.details.counts },
    { [first]: 2, [second]: 1 },
    'a multi-approval ballot adds one count per approved candidate',
  );
  assert.equal(result.details.abstainCount, 0);
  assert.equal(result.details.totalBallots, 2, 'two ballots, not three approvals');
  assert.equal(world.proposals.get(first).status, 'selected');
  assert.equal(world.proposals.get(second).status, 'unselected', 'the losers become eligible again');
  assert.equal(world.proposals.get(third).status, 'submitted', 'a proposal outside the round is untouched');

  // The next round is opened over the pool again: the recently unselected loser is offered first and
  // the selected winner is not offered again.
  const roundTwoId = pollIdFrom(
    await world
      .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-27T10:00:00Z') })
      .write('rein_mvp_poll_open', { voteType: VOTE_TYPE, title: 'Round two', closesAt: '2026-09-29T18:00:00Z' }),
  );
  const roundTwo = world.polls.get(roundTwoId);
  assert.ok(roundTwo.candidateProposalIds.includes(second), 'a proposal that lost is offered again');
  assert.ok(!roundTwo.candidateProposalIds.includes(first), 'a selected proposal is not offered again');
  assert.equal(
    world.candidatePoolReads.at(-1).includeRecentlyUnselected,
    true,
    'the pool query asks for recently unselected proposals',
  );

  // A single-candidate round is valid: the type has a cap of one and one unselected proposal remains.
  const singleWorld = createWorld({
    records: [CONTRIBUTOR, DIRECTOR_A],
    rules: { [VOTE_TYPE]: { maxCandidates: 1, maxApprovalsPerVoter: 1 } },
  });
  await singleWorld
    .turn({ sender: CONTRIBUTOR.slackUserId, channel: PROPOSAL_CHANNEL, at: at('2026-09-24T09:00:00Z') })
    .write('rein_mvp_proposal_submit', { voteType: VOTE_TYPE, title: 'The only request' });
  const singleId = pollIdFrom(
    await singleWorld
      .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-24T10:00:00Z') })
      .write('rein_mvp_poll_open', {
        voteType: VOTE_TYPE,
        title: 'Single candidate round',
        closesAt: '2026-09-26T18:00:00Z',
      }),
  );
  assert.equal(singleWorld.polls.get(singleId).candidateProposalIds.length, 1);

  // A round with no eligible proposal is refused instead of being stored empty.
  const barrenWorld = createWorld({ records: [CONTRIBUTOR, DIRECTOR_A] });
  const noCandidates = await barrenWorld
    .turn({ sender: DIRECTOR_A.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-24T10:00:00Z') })
    .write('rein_mvp_poll_open', { voteType: VOTE_TYPE, title: 'Nothing to fund', closesAt: '2026-09-26T18:00:00Z' });
  assert.equal(noCandidates.details.ok, false);
  assert.equal(noCandidates.details.error, 'no_candidate_proposals');
  assert.equal(barrenWorld.polls.size, 0, 'a round without a candidate is never stored');
});

// ---------------------------------------------------------------------------------------------
// Rehearsal 4: the fail-closed boundary. Registration needs an explicit config, the model never
// supplies an actor, a cap or a label, and a refused turn writes nothing at all.
// ---------------------------------------------------------------------------------------------

test('no rehearsal turn writes when the MVP block is absent, the channel is unapproved or the sender is missing', async () => {
  const world = createWorld({ records: [CONTRIBUTOR, DIRECTOR_A] });

  // No enabled MVP block: no tool is registered, so there is no actor resolution at all.
  const disabled = createMvpWriteToolRegistration({
    config: { enabled: false },
    reader: world,
    writer: world,
  }).create({
    messageChannel: 'slack',
    nativeChannelId: BOARD_CHANNEL,
    requesterSenderId: DIRECTOR_A.slackUserId,
  });
  assert.equal(disabled, null);
  assert.equal(
    createMvpReadToolRegistration({ config: undefined, reader: world }).create({ messageChannel: 'slack' }),
    null,
  );

  const unapproved = await world
    .turn({ sender: DIRECTOR_A.slackUserId, channel: 'C_RANDOM', at: at('2026-09-24T10:00:00Z') })
    .write('rein_mvp_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: '2026-09-26T18:00:00Z' });
  assert.equal(unapproved.details.error, 'channel_out_of_scope');
  assert.equal(world.polls.size, 0);

  const noSender = await world
    .turn({ sender: '   ', channel: BOARD_CHANNEL, at: at('2026-09-24T10:00:00Z') })
    .write('rein_mvp_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: '2026-09-26T18:00:00Z' });
  assert.equal(noSender.details.error, 'trusted_requester_unavailable');
  assert.equal(world.polls.size, 0);
  assert.deepEqual(world.readTurns, [], 'a refused sender is rejected before any identity lookup');

  // A mid-turn revocation is seen by the next turn, because the directory is read per turn.
  world.setRecord(CONTRIBUTOR.slackUserId, { isActiveContributor: false });
  const revoked = await world
    .turn({ sender: CONTRIBUTOR.slackUserId, channel: PROPOSAL_CHANNEL, at: at('2026-09-24T10:05:00Z') })
    .write('rein_mvp_proposal_submit', { voteType: VOTE_TYPE, title: 'After revocation' });
  assert.equal(revoked.details.error, 'contributor_status_required');
  assert.equal(world.proposals.size, 0, 'a revoked Contributor adds no proposal');
  world.setRecord(CONTRIBUTOR.slackUserId, { isActiveContributor: true });

  // Roles cannot be claimed through an argument on any write tool, and the refusal happens before
  // the identity lookup, before the stored rule is read and before the pool is queried.
  const attempts = [
    ['rein_mvp_proposal_submit', { voteType: VOTE_TYPE, title: 'Poll', proposerContactId: DIRECTOR_A.contactId }, 'actor_argument_rejected'],
    ['rein_mvp_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: '2026-09-26T18:00:00Z', isDirector: true }, 'actor_argument_rejected'],
    ['rein_mvp_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: '2026-09-26T18:00:00Z', candidateProposalIds: [DIRECTOR_A.contactId] }, 'policy_argument_rejected'],
    ['rein_mvp_poll_open', { voteType: VOTE_TYPE, title: 'Poll', closesAt: '2026-09-26T18:00:00Z', maxApprovalsPerVoter: 5 }, 'policy_argument_rejected'],
    ['rein_mvp_vote', { pollId: '00000000-0000-4000-8000-000000000000', approvedProposalIds: [], weight: 5 }, 'actor_argument_rejected'],
    ['rein_mvp_poll_result', { pollId: '00000000-0000-4000-8000-000000000000', role: 'director' }, 'actor_argument_rejected'],
  ];
  for (const [toolName, args, expected] of attempts) {
    const before = world.readTurns.length;
    const result = await world
      .turn({ sender: OUTSIDER.slackUserId, channel: BOARD_CHANNEL, at: at('2026-09-24T10:10:00Z') })
      .write(toolName, args);
    assert.equal(result.details.error, expected, `${toolName} ${JSON.stringify(args)}`);
    assert.equal(world.readTurns.length, before, `${toolName} must not resolve an identity from an argument`);
  }
  assert.equal(world.polls.size, 0, 'a refused argument never opens a round');
  assert.deepEqual(world.candidatePoolReads, [], 'a refused argument never reads the candidate pool');

  // Nothing in this rehearsal ever wrote a message or moved money: every write this store accepts is
  // a proposal row, a poll row or a ballot row.
  assert.equal(world.proposals.size, 0);
});
