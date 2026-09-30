// Tests for the Board governance tool bridge (plugins/rein-operations/governance-tool-bridge.ts).
//
// These checks drive the real governance store and the real registry-snapshot eligibility check
// through the real v2 tool factory: host-context account derivation, canonical-member actors,
// authoritative Board eligibility, stale and revoked registries, channel scoping, forged-actor
// rejection, retry replay, changed-argument refusal, the rejected-ballot audit trail, the final
// invocation guard, round-result privacy and restart persistence.
//
// Honest limit: OpenClaw's v2 tool context exposes no trusted inbound message or event id, only the
// `toolCallId` handed to `execute`. Replay safety is therefore per invocation; a caller that invents
// a fresh call id is not stopped by this layer. No chat platform, registry provider, website or
// payment provider is connected, so nothing here proves a live integration.
//
// Run: node --test tests/governance-tool-bridge.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGovernanceStore } from '../plugins/rein-operations/governance-store.ts';
import {
  createGovernanceToolRegistration,
  GOVERNANCE_TOOL_NAMES,
} from '../plugins/rein-operations/governance-tool-bridge.ts';
import { createRegistrySnapshot } from '../plugins/rein-operations/registry-snapshot.ts';

// The P0 chat platform is still undecided (docs/decisions.md), so the rehearsal uses a synthetic
// label that cannot be mistaken for an adopted platform choice.
const PLATFORM = 'rehearsal-chat';
const BOARD_CHANNEL = 'board-room';
const PUBLIC_CHANNEL = 'general';
const OPENS = '2026-09-01T00:00:00Z';
const CLOSES = '2026-09-01T02:00:00Z';
const DURING = '2026-09-01T00:30:00Z';
const STALE_AT = '2026-09-01T00:45:00Z';
const MAX_AGE_MS = 10 * 60 * 1000;
const APPROVAL = { reference: 'board-resolution-2026-09-01', approvedBy: 'board' };

const tempDir = () => mkdtempSync(join(tmpdir(), 'rein-governance-bridge-'));

async function withStore(fn) {
  const dir = tempDir();
  try {
    return await fn(join(dir, 'state.json'), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Explicit rules, constructed here rather than taken from any module default.
function roundInput() {
  return {
    roundId: 'round-1',
    rules: {
      rulesVersion: 'test-rules-1',
      participation: {
        minMemberFraction: { numerator: 1, denominator: 2 },
        minWeightFraction: { numerator: 1, denominator: 2 },
      },
      approval: {
        strictMajorityFraction: { numerator: 1, denominator: 2 },
        requireNonAbstainingVote: true,
      },
      tie: { outcome: 'not_passed' },
      voteReplacement: { allowed: true },
      allocation: { rule: 'no_auto_allocation' },
    },
    opensAt: OPENS,
    closesAt: CLOSES,
    currency: 'USD',
    // Funds are unconfirmed on purpose: R11/R15 require pausing funding commitments instead of
    // presenting a total balance as available budget.
    budgetAvailableMinor: null,
    // m6 is Board eligible in the registry but deliberately outside this frozen roster.
    roster: [
      { memberId: 'm1', weight: 3 },
      { memberId: 'm2', weight: 2 },
      { memberId: 'm3', weight: 1 },
    ],
    proposals: [
      { proposalId: 'p1', version: 'v1', leadMemberId: 'lead-1', requestedAmountMinor: 5000 },
      { proposalId: 'p2', version: 'v1', leadMemberId: 'lead-2', requestedAmountMinor: 0 },
    ],
  };
}

const openRound = (store, overrides = {}) =>
  store.openRound({
    round: { ...roundInput(), ...overrides },
    approval: APPROVAL,
    actor: 'admin-1',
    at: OPENS,
    idempotencyKey: 'open-round-1',
  });

// u-5's link is revoked; m4 has no Board role; m6 is Board eligible but outside the frozen roster.
function registryRaw() {
  return {
    version: 'registry-2026-09-01.1',
    generatedAt: DURING,
    platform: PLATFORM,
    members: [
      { memberId: 'm1', status: 'active', roles: [{ role: 'board', status: 'active' }] },
      { memberId: 'm2', status: 'active', roles: [{ role: 'board', status: 'active' }] },
      { memberId: 'm3', status: 'active', roles: [{ role: 'board', status: 'active' }] },
      { memberId: 'm4', status: 'active', roles: [{ role: 'contributor', status: 'active' }] },
      { memberId: 'm5', status: 'active', roles: [{ role: 'board', status: 'active' }] },
      { memberId: 'm6', status: 'active', roles: [{ role: 'board', status: 'active' }] },
    ],
    links: [
      { platform: PLATFORM, accountId: 'u-1', memberId: 'm1', status: 'verified', verifiedAt: '2026-08-01T00:00:00Z' },
      { platform: PLATFORM, accountId: 'u-2', memberId: 'm2', status: 'verified', verifiedAt: '2026-08-01T00:00:00Z' },
      { platform: PLATFORM, accountId: 'u-3', memberId: 'm3', status: 'verified', verifiedAt: '2026-08-01T00:00:00Z' },
      { platform: PLATFORM, accountId: 'u-4', memberId: 'm4', status: 'verified', verifiedAt: '2026-08-01T00:00:00Z' },
      { platform: PLATFORM, accountId: 'u-5', memberId: 'm5', status: 'revoked', verifiedAt: '2026-08-01T00:00:00Z' },
      { platform: PLATFORM, accountId: 'u-6', memberId: 'm6', status: 'verified', verifiedAt: '2026-08-01T00:00:00Z' },
    ],
  };
}

const freshSnapshot = () => createRegistrySnapshot(registryRaw(), { at: DURING, maxAgeMs: MAX_AGE_MS });

function registrationFor(store, { snapshot = freshSnapshot(), now = () => DURING, checkBoardEligibility, getRegistrySnapshot } = {}) {
  const options = {
    platform: PLATFORM,
    boardNativeChannelIds: [BOARD_CHANNEL],
    store,
    getRegistrySnapshot: getRegistrySnapshot ?? (() => snapshot),
    now,
  };
  if (checkBoardEligibility) options.checkBoardEligibility = checkBoardEligibility;
  return createGovernanceToolRegistration(options);
}

function makeContext(overrides = {}) {
  return {
    messageChannel: PLATFORM,
    nativeChannelId: BOARD_CHANNEL,
    requesterSenderId: 'u-1',
    assertInvocationCurrent: () => {},
    ...overrides,
  };
}

function toolsFor(registration, context) {
  const tools = registration.create(context);
  return tools ? Object.fromEntries(tools.map((tool) => [tool.name, tool])) : null;
}

const ballotsOf = (store) => store.getRound({ roundId: 'round-1' }).state.ballots;
const recusalsOf = (store) => store.getRound({ roundId: 'round-1' }).state.recusals;
const ballotAuditOf = (store) =>
  store.readAudit({ roundId: 'round-1' }).filter((entry) => entry.action === 'cast_ballot');

test('absent configuration registers no tools and no round, funding or messaging surface', async () => {
  await withStore((file) => {
    const store = createGovernanceStore({ path: file });
    const snapshot = freshSnapshot();

    assert.equal(createGovernanceToolRegistration().create(makeContext()), null, 'no options means no tools');
    assert.equal(
      createGovernanceToolRegistration({ boardNativeChannelIds: [BOARD_CHANNEL], store, getRegistrySnapshot: () => snapshot }).create(makeContext()),
      null,
      'missing platform means no tools',
    );
    assert.equal(
      createGovernanceToolRegistration({ platform: PLATFORM, store, getRegistrySnapshot: () => snapshot }).create(makeContext()),
      null,
      'missing Board channels means no tools',
    );
    assert.equal(
      createGovernanceToolRegistration({ platform: PLATFORM, boardNativeChannelIds: [BOARD_CHANNEL], getRegistrySnapshot: () => snapshot }).create(makeContext()),
      null,
      'missing store means no tools',
    );
    assert.equal(
      createGovernanceToolRegistration({ platform: PLATFORM, boardNativeChannelIds: [BOARD_CHANNEL], store }).create(makeContext()),
      null,
      'missing authoritative registry getter means no tools',
    );
    assert.equal(
      createGovernanceToolRegistration({ platform: '   ', boardNativeChannelIds: [BOARD_CHANNEL], store, getRegistrySnapshot: () => snapshot }).create(makeContext()),
      null,
      'blank platform means no tools',
    );

    const registration = registrationFor(store);
    assert.equal(registration.contextVersion, 2);
    const tools = registration.create(makeContext());
    assert.deepEqual(tools.map((tool) => tool.name), [...GOVERNANCE_TOOL_NAMES]);
    // No round creation, policy, funding, payment or messaging tool is exposed here.
    assert.ok(!tools.some((tool) => /open|create|fund|alloc|pay|settle|message|publish|policy|registrar|roster|weight/i.test(tool.name)));
    for (const tool of tools) {
      const properties = tool.parameters?.properties ?? {};
      assert.ok(!('actor' in properties) && !('memberId' in properties) && !('accountId' in properties));
      assert.ok(!('weight' in properties) && !('castAt' in properties));
      assert.equal(tool.parameters?.additionalProperties, false);
    }
    const byName = toolsFor(registration, makeContext());
    assert.deepEqual(Object.keys(byName['rein_governance_vote'].parameters.properties).sort(), ['choice', 'proposalId', 'roundId']);
    assert.deepEqual(Object.keys(byName['rein_governance_recuse'].parameters.properties).sort(), ['proposalId', 'reason', 'roundId']);
    assert.deepEqual(Object.keys(byName['rein_governance_round_result'].parameters.properties), ['roundId']);
  });
});

test('a current eligible Board member votes and the store records the canonical member id', async () => {
  await withStore(async (file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const tools = toolsFor(registrationFor(store), makeContext({ requesterSenderId: 'u-2' }));

    const vote = await tools['rein_governance_vote'].execute('call-vote-1', {
      roundId: 'round-1',
      proposalId: 'p1',
      choice: 'approve',
    });
    assert.equal(vote.details.ok, true);
    assert.equal(vote.details.accepted, true);
    assert.equal(vote.details.duplicated, false);
    assert.equal(vote.details.reason, null);
    assert.equal(vote.details.replayed, false);
    assert.equal(vote.details.recordedAt, DURING);
    assert.equal(vote.details.choice, 'approve');

    const ballots = ballotsOf(store);
    assert.deepEqual(
      ballots.map((ballot) => ({ proposalId: ballot.proposalId, memberId: ballot.memberId, choice: ballot.choice, castAt: ballot.castAt })),
      [{ proposalId: 'p1', memberId: 'm2', choice: 'approve', castAt: DURING }],
    );
    assert.equal(ballots[0].idempotencyKey, `governance-tool:${PLATFORM}:m2:call-vote-1`);

    const audit = ballotAuditOf(store);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].outcome, 'accepted');
    assert.equal(audit[0].actor, 'm2');
    assert.equal(audit[0].memberId, 'm2');
    assert.deepEqual(audit[0].context, {
      platform: PLATFORM,
      nativeChannelId: BOARD_CHANNEL,
      toolCallId: 'call-vote-1',
    });
    // The acting platform account id is never written to the durable store by this bridge.
    assert.ok(!JSON.stringify(store.snapshot()).includes('u-2'));
  });
});

test('a member without a current Board role is refused and nothing is written', async () => {
  await withStore(async (file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const before = store.snapshot().revision;
    const tools = toolsFor(registrationFor(store), makeContext({ requesterSenderId: 'u-4' }));

    const refused = await tools['rein_governance_vote'].execute('call-contributor', {
      roundId: 'round-1',
      proposalId: 'p1',
      choice: 'approve',
    });
    assert.equal(refused.details.ok, false);
    assert.equal(refused.details.error, 'board_eligibility_required');
    assert.equal(refused.details.reason, 'no_active_board_role');

    const recused = await tools['rein_governance_recuse'].execute('call-contributor-recuse', {
      roundId: 'round-1',
      proposalId: 'p2',
      reason: 'Not my call',
    });
    assert.equal(recused.details.error, 'board_eligibility_required');

    assert.equal(store.snapshot().revision, before);
    assert.deepEqual(ballotsOf(store), []);
    assert.deepEqual(recusalsOf(store), []);
    assert.deepEqual(ballotAuditOf(store), []);
  });
});

test('a stale or revoked authoritative registry fails closed before the store write', async () => {
  await withStore(async (file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const before = store.snapshot().revision;

    const staleTools = toolsFor(
      registrationFor(store, { now: () => STALE_AT }),
      makeContext(),
    );
    const stale = await staleTools['rein_governance_vote'].execute('call-stale', {
      roundId: 'round-1',
      proposalId: 'p1',
      choice: 'approve',
    });
    assert.equal(stale.details.ok, false);
    assert.equal(stale.details.error, 'board_eligibility_required');
    assert.equal(stale.details.reason, 'snapshot_stale');

    const revokedTools = toolsFor(registrationFor(store), makeContext({ requesterSenderId: 'u-5' }));
    const revoked = await revokedTools['rein_governance_vote'].execute('call-revoked', {
      roundId: 'round-1',
      proposalId: 'p1',
      choice: 'approve',
    });
    assert.equal(revoked.details.error, 'board_eligibility_required');
    assert.equal(revoked.details.reason, 'identity_link_revoked');

    assert.equal(store.snapshot().revision, before);
    assert.deepEqual(ballotsOf(store), []);
  });
});

test('a wrong channel, another platform or a missing sender fails closed without writing', async () => {
  await withStore(async (file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const before = store.snapshot().revision;
    const registration = registrationFor(store);
    const args = { roundId: 'round-1', proposalId: 'p1', choice: 'approve' };

    const wrongChannel = await toolsFor(registration, makeContext({ nativeChannelId: PUBLIC_CHANNEL }))[
      'rein_governance_vote'
    ].execute('call-public', args);
    assert.equal(wrongChannel.details.ok, false);
    assert.equal(wrongChannel.details.error, 'channel_out_of_scope');
    assert.equal(wrongChannel.details.nativeChannelId, PUBLIC_CHANNEL);

    const otherPlatform = await toolsFor(registration, makeContext({ messageChannel: 'slack' }))[
      'rein_governance_vote'
    ].execute('call-other-platform', args);
    assert.equal(otherPlatform.details.error, 'trusted_requester_unavailable');

    const anonymous = await toolsFor(registration, makeContext({ requesterSenderId: '   ' }))[
      'rein_governance_vote'
    ].execute('call-anonymous', args);
    assert.equal(anonymous.details.error, 'trusted_requester_unavailable');

    const noChannel = await toolsFor(registration, makeContext({ nativeChannelId: '' }))[
      'rein_governance_vote'
    ].execute('call-no-channel', args);
    assert.equal(noChannel.details.error, 'trusted_requester_unavailable');

    // The result read is Board scoped too.
    const resultOutside = await toolsFor(registration, makeContext({ nativeChannelId: PUBLIC_CHANNEL }))[
      'rein_governance_round_result'
    ].execute('call-result-public', { roundId: 'round-1' });
    assert.equal(resultOutside.details.error, 'channel_out_of_scope');

    assert.equal(store.snapshot().revision, before);
    assert.deepEqual(ballotsOf(store), []);
  });
});

test('a forged actor, member, weight or timestamp argument is rejected', async () => {
  await withStore(async (file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const tools = toolsFor(registrationFor(store), makeContext());
    const base = { roundId: 'round-1', proposalId: 'p1', choice: 'approve' };

    for (const [key, value] of [
      ['actor', 'board-chair'],
      ['memberId', 'm3'],
      ['accountId', 'u-3'],
      ['voterId', 'm3'],
      ['weight', 99],
      ['castAt', OPENS],
      ['eligible', true],
    ]) {
      const forged = await tools['rein_governance_vote'].execute(`call-forged-${key}`, { ...base, [key]: value });
      assert.equal(forged.details.ok, false, `${key} must be rejected`);
      assert.equal(forged.details.error, 'actor_argument_rejected');
      assert.equal(forged.details.key, key);
    }

    const forgedRecusal = await tools['rein_governance_recuse'].execute('call-forged-recuse', {
      roundId: 'round-1',
      proposalId: 'p2',
      reason: 'Interest',
      memberId: 'm3',
    });
    assert.equal(forgedRecusal.details.error, 'actor_argument_rejected');

    assert.deepEqual(ballotsOf(store), []);
    assert.deepEqual(recusalsOf(store), []);
  });
});

test('a rejected ballot is durable in the audit trail without changing the round', async () => {
  await withStore(async (file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const before = store.getRound({ roundId: 'round-1' }).revision;
    // m6 is currently Board eligible but is not in the frozen roster, so the engine rejects it.
    const tools = toolsFor(registrationFor(store), makeContext({ requesterSenderId: 'u-6' }));

    const rejected = await tools['rein_governance_vote'].execute('call-m6', {
      roundId: 'round-1',
      proposalId: 'p1',
      choice: 'approve',
    });
    assert.equal(rejected.details.ok, false, 'a domain rejection is not reported as success');
    assert.equal(rejected.details.accepted, false);
    assert.equal(rejected.details.reason, 'ineligible_voter');
    assert.equal(rejected.details.result.accepted, false);

    const audit = ballotAuditOf(store);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].outcome, 'rejected');
    assert.equal(audit[0].reason, 'ineligible_voter');
    assert.equal(audit[0].actor, 'm6');
    assert.equal(audit[0].ballotSequence, null);
    assert.equal(store.getRound({ roundId: 'round-1' }).revision, before, 'a rejected ballot never advances the round');
    assert.deepEqual(ballotsOf(store), []);
  });
});

test('retrying one tool call id replays instead of recording a second ballot', async () => {
  await withStore(async (file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const tools = toolsFor(registrationFor(store), makeContext());
    const args = { roundId: 'round-1', proposalId: 'p1', choice: 'approve' };

    const first = await tools['rein_governance_vote'].execute('call-retry', args);
    assert.equal(first.details.ok, true);
    assert.equal(first.details.replayed, false);

    const retry = await tools['rein_governance_vote'].execute('call-retry', args);
    assert.equal(retry.details.ok, true);
    assert.equal(retry.details.accepted, true);
    assert.equal(retry.details.replayed, true);
    // The replay returns the same recorded outcome; only the replay flag differs.
    assert.deepEqual({ ...retry.details.result, replayed: false }, first.details.result);

    assert.equal(ballotsOf(store).length, 1);
    assert.equal(ballotAuditOf(store).length, 1);
  });
});

test('reusing one tool call id with changed ballot arguments is refused loudly and audited', async () => {
  await withStore(async (file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const tools = toolsFor(registrationFor(store), makeContext());

    const first = await tools['rein_governance_vote'].execute('call-conflict', {
      roundId: 'round-1',
      proposalId: 'p1',
      choice: 'approve',
    });
    assert.equal(first.details.ok, true);

    const changedChoice = await tools['rein_governance_vote'].execute('call-conflict', {
      roundId: 'round-1',
      proposalId: 'p1',
      choice: 'reject',
    });
    assert.equal(changedChoice.details.ok, false, 'a changed retry is not silently accepted');
    assert.equal(changedChoice.details.accepted, false);
    assert.equal(changedChoice.details.reason, 'idempotency_key_conflict');
    assert.equal(changedChoice.details.replayed, false);

    const changedProposal = await tools['rein_governance_vote'].execute('call-conflict', {
      roundId: 'round-1',
      proposalId: 'p2',
      choice: 'approve',
    });
    assert.equal(changedProposal.details.ok, false);
    assert.equal(changedProposal.details.reason, 'idempotency_key_conflict');

    const ballots = ballotsOf(store);
    assert.equal(ballots.length, 1);
    assert.equal(ballots[0].choice, 'approve');
    assert.equal(ballots[0].proposalId, 'p1');
    assert.deepEqual(
      ballotAuditOf(store).map((entry) => [entry.outcome, entry.reason]),
      [['accepted', null], ['rejected', 'idempotency_key_conflict'], ['rejected', 'idempotency_key_conflict']],
    );
  });
});

test('a Board member declares a recusal once and cannot silently replace it', async () => {
  await withStore(async (file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const tools = toolsFor(registrationFor(store), makeContext({ requesterSenderId: 'u-2' }));
    const args = { roundId: 'round-1', proposalId: 'p2', reason: 'Direct interest in the venue contract' };

    const recusal = await tools['rein_governance_recuse'].execute('call-recuse-1', args);
    assert.equal(recusal.details.ok, true);
    assert.equal(recusal.details.accepted, true);
    assert.equal(recusal.details.reason, null);

    const retry = await tools['rein_governance_recuse'].execute('call-recuse-1', args);
    assert.equal(retry.details.replayed, true);
    assert.equal(retry.details.ok, true);

    const again = await tools['rein_governance_recuse'].execute('call-recuse-2', {
      roundId: 'round-1',
      proposalId: 'p2',
      reason: 'A different reason',
    });
    assert.equal(again.details.ok, false);
    assert.equal(again.details.reason, 'already_recused');

    const recusals = recusalsOf(store);
    assert.equal(recusals.length, 1);
    assert.equal(recusals[0].memberId, 'm2');
    assert.equal(recusals[0].reason, args.reason);

    const audit = store.readAudit({ roundId: 'round-1' }).filter((entry) => entry.action === 'declare_recusal');
    assert.deepEqual(audit.map((entry) => [entry.outcome, entry.reason]), [['accepted', null], ['rejected', 'already_recused']]);
  });
});

test('a recusal is refused once a ballot exists for that proposal', async () => {
  await withStore(async (file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const tools = toolsFor(registrationFor(store), makeContext({ requesterSenderId: 'u-2' }));

    await tools['rein_governance_vote'].execute('call-vote', { roundId: 'round-1', proposalId: 'p2', choice: 'approve' });
    const recusal = await tools['rein_governance_recuse'].execute('call-recuse', {
      roundId: 'round-1',
      proposalId: 'p2',
      reason: 'Late change of heart',
    });
    assert.equal(recusal.details.ok, false);
    assert.equal(recusal.details.reason, 'ballots_already_recorded_restart_required');
    assert.deepEqual(recusalsOf(store), []);
  });
});

test('the round result is read-only, Board scoped and free of ballots, reasons and allocations', async () => {
  await withStore(async (file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const registration = registrationFor(store);
    await toolsFor(registration, makeContext({ requesterSenderId: 'u-1' }))['rein_governance_vote'].execute('call-r1', {
      roundId: 'round-1',
      proposalId: 'p1',
      choice: 'approve',
    });
    await toolsFor(registration, makeContext({ requesterSenderId: 'u-2' }))['rein_governance_vote'].execute('call-r2', {
      roundId: 'round-1',
      proposalId: 'p1',
      choice: 'reject',
    });
    await toolsFor(registration, makeContext({ requesterSenderId: 'u-3' }))['rein_governance_vote'].execute('call-r3', {
      roundId: 'round-1',
      proposalId: 'p1',
      choice: 'abstain',
    });

    const before = store.snapshot().revision;
    const tools = toolsFor(registration, makeContext({ requesterSenderId: 'u-1' }));
    const result = await tools['rein_governance_round_result'].execute('call-result', { roundId: 'round-1' });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.readBy, 'm1');
    assert.equal(result.details.readAt, DURING);

    const payload = result.details.result;
    assert.equal(payload.roundId, 'round-1');
    assert.equal(payload.rulesVersion, 'test-rules-1');
    assert.equal(payload.currency, 'USD');
    const p1 = payload.proposals.find((proposal) => proposal.proposalId === 'p1');
    assert.deepEqual(p1.counts, { approve: 1, reject: 1, abstain: 1 });
    assert.deepEqual(p1.weights, { approve: 3, reject: 2, abstain: 1 });
    assert.equal(p1.eligibleMemberCount, 3);
    assert.equal(p1.eligibleWeight, 6);
    assert.equal(p1.participatingMemberCount, 3);
    assert.equal(p1.participatingWeight, 6);
    assert.deepEqual(p1.participation, { memberRequirementMet: true, weightRequirementMet: true, met: true });
    assert.equal(p1.status, 'passed');
    assert.equal(p1.passed, true);
    assert.equal(p1.leadMemberId, 'lead-1');
    assert.equal(p1.requestedAmountMinor, 5000);
    assert.deepEqual(p1.recusedMemberIds, []);
    assert.equal(payload.budget.status, 'available_funds_unknown');
    assert.equal(payload.budget.availableMinor, null);
    assert.equal(payload.budget.availableFundsKnown, false);
    assert.equal(payload.budget.requestedByPassedMinor, 5000);
    assert.equal(payload.budget.shortfallMinor, null);
    assert.deepEqual(payload.awaitingFundingAllocation, ['p1']);
    assert.ok(payload.outstanding.includes('available_funds_unknown_pause_commitments'));

    // Privacy: no individual ballot, recusal reason, platform account id or allocation decision.
    const serialized = JSON.stringify(result.details);
    assert.ok(!serialized.includes('u-1') && !serialized.includes('u-2') && !serialized.includes('u-3'));
    assert.ok(!serialized.includes('ballots'));
    assert.ok(!serialized.includes('castAt'));
    assert.ok(!serialized.includes('idempotencyKey'));
    assert.ok(!serialized.includes('allocatedMinor'));
    assert.ok(!serialized.includes('"allocations"'));

    assert.equal(store.snapshot().revision, before, 'reading a result never writes');
    assert.equal(ballotsOf(store).length, 3);
  });
});

test('the round result refuses a member without a current Board role', async () => {
  await withStore(async (file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const before = store.snapshot().revision;
    const tools = toolsFor(registrationFor(store), makeContext({ requesterSenderId: 'u-4' }));
    const result = await tools['rein_governance_round_result'].execute('call-result', { roundId: 'round-1' });
    assert.equal(result.details.ok, false);
    assert.equal(result.details.error, 'board_eligibility_required');
    assert.equal(result.details.reason, 'no_active_board_role');
    assert.equal(store.snapshot().revision, before);
  });
});

test('an injected Board eligibility check decides the canonical actor', async () => {
  await withStore(async (file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const calls = [];
    const registration = registrationFor(store, {
      checkBoardEligibility: (snapshot, args) => {
        calls.push({ args, hasSnapshot: typeof snapshot?.generatedAtMs === 'number' });
        return { eligible: true, reason: 'synthetic_board_grant', memberId: 'm3' };
      },
    });
    const tools = toolsFor(registration, makeContext({ requesterSenderId: 'u-1' }));

    const vote = await tools['rein_governance_vote'].execute('call-injected', {
      roundId: 'round-1',
      proposalId: 'p1',
      choice: 'approve',
    });
    assert.equal(vote.details.ok, true);
    assert.deepEqual(calls, [{ args: { platform: PLATFORM, accountId: 'u-1', at: DURING }, hasSnapshot: true }]);
    assert.equal(ballotsOf(store)[0].memberId, 'm3');
    assert.equal(ballotAuditOf(store)[0].actor, 'm3');
  });
});

test('an injected denial or an unusable snapshot fails closed', async () => {
  await withStore(async (file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const before = store.snapshot().revision;
    const args = { roundId: 'round-1', proposalId: 'p1', choice: 'approve' };

    const denied = toolsFor(
      registrationFor(store, { checkBoardEligibility: () => ({ eligible: false, reason: 'synthetic_denied', memberId: 'm1' }) }),
      makeContext(),
    );
    const deniedVote = await denied['rein_governance_vote'].execute('call-denied', args);
    assert.equal(deniedVote.details.error, 'board_eligibility_required');
    assert.equal(deniedVote.details.reason, 'synthetic_denied');

    const noMember = toolsFor(
      registrationFor(store, { checkBoardEligibility: () => ({ eligible: true, reason: 'synthetic', memberId: null }) }),
      makeContext(),
    );
    const noMemberVote = await noMember['rein_governance_vote'].execute('call-no-member', args);
    assert.equal(noMemberVote.details.error, 'board_eligibility_required');

    const throwingProvider = toolsFor(
      registrationFor(store, { getRegistrySnapshot: () => { throw new Error('provider offline'); } }),
      makeContext(),
    );
    const offline = await throwingProvider['rein_governance_vote'].execute('call-offline', args);
    assert.equal(offline.details.error, 'registry_snapshot_unavailable');
    assert.match(offline.details.message, /provider offline/);

    const rawProvider = toolsFor(
      registrationFor(store, { getRegistrySnapshot: () => ({ members: [], links: [] }) }),
      makeContext(),
    );
    const raw = await rawProvider['rein_governance_vote'].execute('call-raw', args);
    assert.equal(raw.details.error, 'registry_snapshot_unavailable');

    assert.equal(store.snapshot().revision, before);
    assert.deepEqual(ballotsOf(store), []);
  });
});

test('the final invocation guard runs before the store mutation and a stale turn writes nothing', async () => {
  await withStore(async (file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const registration = registrationFor(store);
    const before = store.snapshot().revision;
    const args = { roundId: 'round-1', proposalId: 'p1', choice: 'approve' };

    let guardCalls = 0;
    const staleTools = toolsFor(
      registration,
      makeContext({
        assertInvocationCurrent() {
          guardCalls += 1;
          throw new Error('invocation no longer current');
        },
      }),
    );
    const stale = await staleTools['rein_governance_vote'].execute('call-stale-turn', args);
    assert.equal(stale.details.ok, false);
    assert.equal(guardCalls, 1, 'the guard ran before the store mutation');
    assert.match(stale.details.message, /no longer current/);
    assert.equal(store.snapshot().revision, before);
    assert.deepEqual(ballotsOf(store), []);

    const noGuardTools = toolsFor(registration, makeContext({ assertInvocationCurrent: undefined }));
    const missing = await noGuardTools['rein_governance_vote'].execute('call-no-guard', args);
    assert.equal(missing.details.ok, false);
    assert.equal(missing.details.error, 'current_invocation_guard_unavailable');
    assert.equal(store.snapshot().revision, before);
    assert.deepEqual(ballotsOf(store), []);

    const missingRecuse = await noGuardTools['rein_governance_recuse'].execute('call-no-guard-recuse', {
      roundId: 'round-1',
      proposalId: 'p2',
      reason: 'Interest',
    });
    assert.equal(missingRecuse.details.error, 'current_invocation_guard_unavailable');
    assert.deepEqual(recusalsOf(store), []);
  });
});

test('a committed ballot and its retry receipt survive a restart', async () => {
  await withStore(async (file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const args = { roundId: 'round-1', proposalId: 'p1', choice: 'approve' };
    const first = await toolsFor(registrationFor(store), makeContext())['rein_governance_vote'].execute('call-persist', args);
    assert.equal(first.details.ok, true);

    const reopened = createGovernanceStore({ path: file });
    assert.equal(ballotsOf(reopened).length, 1);
    const retried = await toolsFor(registrationFor(reopened), makeContext())['rein_governance_vote'].execute('call-persist', args);
    assert.equal(retried.details.ok, true);
    assert.equal(retried.details.replayed, true);
    assert.equal(ballotsOf(reopened).length, 1);
    assert.equal(ballotAuditOf(reopened).length, 1);
  });
});

test('a missing tool call id is refused instead of guessing a retry scope', async () => {
  await withStore(async (file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const tools = toolsFor(registrationFor(store), makeContext());
    const args = { roundId: 'round-1', proposalId: 'p1', choice: 'approve' };
    for (const bad of [undefined, '', '   ']) {
      const refused = await tools['rein_governance_vote'].execute(bad, args);
      assert.equal(refused.details.ok, false);
      assert.equal(refused.details.error, 'tool_call_id_required');
    }
    assert.deepEqual(ballotsOf(store), []);
  });
});

test('an unknown round is reported as a store error without inventing state', async () => {
  await withStore(async (file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const tools = toolsFor(registrationFor(store), makeContext());
    const vote = await tools['rein_governance_vote'].execute('call-unknown', {
      roundId: 'round-404',
      proposalId: 'p1',
      choice: 'approve',
    });
    assert.equal(vote.details.ok, false);
    assert.equal(vote.details.error, 'round_not_found');
    const result = await tools['rein_governance_round_result'].execute('call-unknown-result', { roundId: 'round-404' });
    assert.equal(result.details.ok, false);
    assert.equal(result.details.error, 'round_not_found');
  });
});
