import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGovernanceStore, GovernanceStoreError } from '../plugins/rein-operations/governance-store.ts';
import { createLedger } from '../plugins/rein-operations/ledger.ts';

const OPENS = '2026-09-01T00:00:00Z';
const CLOSES = '2026-09-01T00:45:00Z';
const DURING = '2026-09-01T00:10:00Z';
const LATE = '2026-09-01T00:50:00Z';

// Explicit rules, constructed here rather than taken from any module default.
function rules(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function roundInput(overrides = {}) {
  return {
    roundId: 'round-1',
    rules: rules(),
    opensAt: OPENS,
    closesAt: CLOSES,
    currency: 'USD',
    budgetAvailableMinor: null,
    roster: [
      { memberId: 'm1', weight: 3 },
      { memberId: 'm2', weight: 2 },
      { memberId: 'm3', weight: 1 },
    ],
    proposals: [{ proposalId: 'p1', version: 'v1', leadMemberId: 'lead-1', requestedAmountMinor: 0 }],
    ...overrides,
  };
}

const APPROVAL = { reference: 'board-resolution-2026-09-01', approvedBy: 'board' };

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rein-governance-store-'));
  try {
    return fn(join(dir, 'state.json'), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const openRound = (store, overrides = {}, extra = {}) => store.openRound({
  round: roundInput(overrides),
  approval: APPROVAL,
  actor: 'admin-1',
  at: OPENS,
  idempotencyKey: `open-${overrides.roundId ?? 'round-1'}`,
  ...extra,
});

const vote = (store, extra = {}) => {
  const input = {
    roundId: extra.roundId ?? 'round-1',
    ballot: { proposalId: 'p1', castAt: extra.at ?? DURING, choice: 'approve', ...(extra.ballot ?? {}) },
    actor: extra.actor ?? 'm1',
    at: extra.at ?? DURING,
    idempotencyKey: extra.idempotencyKey ?? 'vote-1',
  };
  if (extra.expectedRevision !== undefined) input.expectedRevision = extra.expectedRevision;
  if (extra.context !== undefined) input.context = extra.context;
  return store.castBallot(input);
};

test('opens one frozen round from explicit approved input and recovers it after a restart', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    const opened = openRound(store, {}, { context: { platform: 'discord', channelId: 'c-1' } });
    assert.equal(opened.roundId, 'round-1');
    assert.equal(opened.revision, 1);
    assert.equal(opened.rulesVersion, 'test-rules-1');
    assert.equal(opened.replayed, false);

    // A fresh store over the same file is a restart: the frozen round comes back unchanged.
    const restarted = createGovernanceStore({ path: file });
    const round = restarted.getRound({ roundId: 'round-1' });
    assert.equal(round.revision, 1);
    assert.equal(round.state.snapshot.rules.rulesVersion, 'test-rules-1');
    assert.equal(round.state.snapshot.opensAt, OPENS);
    assert.equal(round.state.snapshot.closesAt, CLOSES);
    assert.equal(round.state.snapshot.currency, 'USD');
    assert.equal(round.state.snapshot.budgetAvailableMinor, null);
    assert.deepEqual(round.state.snapshot.roster, [
      { memberId: 'm1', weight: 3 },
      { memberId: 'm2', weight: 2 },
      { memberId: 'm3', weight: 1 },
    ]);
    assert.equal(round.approval.reference, APPROVAL.reference);
    assert.equal(round.approval.approvedBy, APPROVAL.approvedBy);
    assert.deepEqual(round.state.ballots, []);
    assert.deepEqual(restarted.listRounds().map((entry) => entry.roundId), ['round-1']);
    const audit = restarted.readAudit();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'open_round');
    assert.equal(audit[0].outcome, 'accepted');
    assert.deepEqual(audit[0].context, { platform: 'discord', channelId: 'c-1' });
  });
});

test('a padded round id is normalized before durable freezing and remains readable', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    const opened = openRound(store, { roundId: ' round-1 ' }, { idempotencyKey: 'open-padded' });
    assert.equal(opened.roundId, 'round-1');
    const restarted = createGovernanceStore({ path: file });
    assert.equal(restarted.getRound({ roundId: 'round-1' }).state.snapshot.roundId, 'round-1');
  });
});

test('the same ballot retry key in another round cannot replay the first round receipt', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    openRound(store, { roundId: 'round-2' });
    const first = vote(store, { roundId: 'round-1', idempotencyKey: 'shared-key' });
    const second = vote(store, { roundId: 'round-2', idempotencyKey: 'shared-key' });
    assert.equal(first.roundId, 'round-1');
    assert.equal(second.roundId, 'round-2');
    assert.equal(second.replayed, false);
    assert.equal(store.getRound({ roundId: 'round-2' }).state.ballots.length, 1);
  });
});

test('round and retry key delimiters cannot collide across rounds', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store, { roundId: 'round:a' });
    openRound(store, { roundId: 'round' });
    const first = vote(store, { roundId: 'round:a', idempotencyKey: 'b' });
    const second = vote(store, { roundId: 'round', idempotencyKey: 'a:b' });
    assert.equal(first.accepted, true);
    assert.equal(second.accepted, true);
    assert.equal(second.roundId, 'round');
    assert.equal(second.replayed, false);
  });
});

test('a conflict discovered under the ledger lock is reported as an idempotency conflict', () => {
  withStore((file) => {
    const base = createLedger(file);
    const normal = createGovernanceStore({ ledger: base });
    openRound(normal);
    vote(normal, { idempotencyKey: 'raced-key' });
    let hideReceipt = true;
    const racing = createGovernanceStore({ ledger: {
      snapshot() {
        const snapshot = base.snapshot();
        if (hideReceipt) {
          hideReceipt = false;
          snapshot.receipts = {};
        }
        return snapshot;
      },
      transact(input) { return base.transact(input); },
    } });
    assert.throws(() => vote(racing, { actor: 'm2', idempotencyKey: 'raced-key' }),
      error => error instanceof GovernanceStoreError && error.code === 'idempotency_conflict');
  });
});

test('refuses a round without complete explicit rules and persists nothing', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    const missing = { rules: undefined };
    assert.throws(
      () => openRound(store, missing, { idempotencyKey: 'open-missing-rules' }),
      (error) => error instanceof GovernanceStoreError
        && error.code === 'governance_rejected'
        && error.details.governanceCode === 'rules_required',
    );

    const partial = roundInput({ rules: { ...rules(), tie: undefined } });
    assert.throws(
      () => openRound(store, partial, { idempotencyKey: 'open-partial-rules' }),
      (error) => error.code === 'governance_rejected' && error.details.governanceCode === 'rules_required',
    );

    // Nothing was written: no round, no audit entry, no receipt side effect.
    assert.deepEqual(store.snapshot().rounds, {});
    assert.deepEqual(store.readAudit(), []);
  });
});

test('requires an explicit recorded approval before a round is frozen', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    assert.throws(
      () => store.openRound({
        round: roundInput(),
        approval: { approvedBy: 'board' },
        actor: 'admin-1',
        at: OPENS,
        idempotencyKey: 'open-no-reference',
      }),
      (error) => error.code === 'validation' && error.details.field === 'approval.reference',
    );
    assert.throws(
      () => store.openRound({
        round: roundInput(),
        approval: { reference: 'res-1' },
        actor: 'admin-1',
        at: OPENS,
        idempotencyKey: 'open-no-approver',
      }),
      (error) => error.code === 'validation' && error.details.field === 'approval.approvedBy',
    );
    assert.deepEqual(store.snapshot().rounds, {});
  });
});

test('an open round is immutable: a second open for the same id is refused', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    assert.throws(
      () => openRound(store, {}, { idempotencyKey: 'open-again' }),
      (error) => error.code === 'round_exists',
    );
    assert.equal(store.getRound({ roundId: 'round-1' }).revision, 1);
  });
});

test('records an accepted ballot with audit context and replays a same-key retry', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const accepted = vote(store, { context: { platform: 'discord', senderId: 'm1' } });
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.duplicated, false);
    assert.equal(accepted.revision, 2);
    assert.equal(accepted.ballot.sequence, 1);
    assert.equal(accepted.ballot.choice, 'approve');
    assert.equal(accepted.ballot.memberId, 'm1');

    const audit = store.readAudit({ roundId: 'round-1' });
    assert.equal(audit.length, 2);
    assert.equal(audit[1].action, 'cast_ballot');
    assert.equal(audit[1].outcome, 'accepted');
    assert.equal(audit[1].actor, 'm1');
    assert.equal(audit[1].memberId, 'm1');
    assert.equal(audit[1].reason, null);
    assert.equal(audit[1].roundRevision, 2);
    assert.deepEqual(audit[1].context, { platform: 'discord', senderId: 'm1' });

    // The same logical action retried with the same key replays the receipt and adds no audit row.
    const retry = vote(store, { context: { platform: 'discord', senderId: 'm1' } });
    assert.equal(retry.replayed, true);
    assert.equal(retry.revision, 2);
    assert.equal(store.readAudit({ roundId: 'round-1' }).length, 2);
    assert.equal(store.getRound({ roundId: 'round-1' }).state.ballots.length, 1);
  });
});

test('a duplicate ballot suppressed by the engine key does not advance the round', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const first = vote(store, { ballot: { idempotencyKey: 'ballot-key-1' } });
    assert.equal(first.accepted, true);
    assert.equal(first.revision, 2);

    // Same ballot content, same engine key, different store key: suppressed, not a second ballot.
    const duplicate = vote(store, { ballot: { idempotencyKey: 'ballot-key-1' }, idempotencyKey: 'vote-retry' });
    assert.equal(duplicate.accepted, true);
    assert.equal(duplicate.duplicated, true);
    assert.equal(duplicate.revision, 2);
    assert.equal(duplicate.ballot.sequence, 1);

    const round = store.getRound({ roundId: 'round-1' });
    assert.equal(round.revision, 2);
    assert.equal(round.state.ballots.length, 1);
    const audit = store.readAudit({ roundId: 'round-1' });
    assert.equal(audit.at(-1).outcome, 'duplicate_suppressed');
    assert.equal(audit.at(-1).reason, null);
    assert.equal(audit.at(-1).roundRevision, 2);
  });
});

test('a reused engine key with different content is rejected, audited and never counted', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    vote(store, { ballot: { idempotencyKey: 'ballot-key-1' } });

    const conflict = vote(store, { ballot: { choice: 'reject', idempotencyKey: 'ballot-key-1' }, idempotencyKey: 'vote-conflict' });
    assert.equal(conflict.accepted, false);
    assert.equal(conflict.reason, 'idempotency_key_conflict');
    assert.equal(conflict.revision, 2);

    const round = store.getRound({ roundId: 'round-1' });
    assert.equal(round.state.ballots.length, 1);
    assert.equal(round.state.ballots[0].choice, 'approve');
    const audit = store.readAudit({ roundId: 'round-1' });
    assert.equal(audit.at(-1).outcome, 'rejected');
    assert.equal(audit.at(-1).reason, 'idempotency_key_conflict');
    assert.equal(audit.at(-1).choice, 'reject');
    assert.equal(audit.at(-1).ballotSequence, null);
  });
});

test('rejects a stale writer that commits against an out-of-date round revision', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const observed = store.getRound({ roundId: 'round-1' }).revision;
    assert.equal(observed, 1);

    vote(store, { actor: 'm2', idempotencyKey: 'vote-m2' });
    assert.equal(store.getRound({ roundId: 'round-1' }).revision, 2);

    const auditLength = store.readAudit({ roundId: 'round-1' }).length;
    assert.throws(
      () => vote(store, { actor: 'm3', idempotencyKey: 'vote-m3', expectedRevision: observed }),
      (error) => error.code === 'storage_conflict'
        && error.details.expectedRevision === 1
        && error.details.actualRevision === 2,
    );

    // The refused write left no trace: no ballot, no audit row, no revision move.
    const round = store.getRound({ roundId: 'round-1' });
    assert.equal(round.revision, 2);
    assert.deepEqual(round.state.ballots.map((ballot) => ballot.memberId), ['m2']);
    assert.equal(store.readAudit({ roundId: 'round-1' }).length, auditLength);

    // Retrying against the current revision succeeds.
    const fresh = vote(store, { actor: 'm3', idempotencyKey: 'vote-m3', expectedRevision: 2 });
    assert.equal(fresh.accepted, true);
    assert.equal(fresh.revision, 3);
  });
});

test('a late ballot is rejected and audited without entering the round', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const late = vote(store, { actor: 'm1', at: LATE, ballot: { castAt: LATE }, idempotencyKey: 'vote-late' });
    assert.equal(late.accepted, false);
    assert.equal(late.reason, 'outside_voting_window');
    assert.equal(late.revision, 1);
    const round = store.getRound({ roundId: 'round-1' });
    assert.equal(round.revision, 1);
    assert.deepEqual(round.state.ballots, []);
    const audit = store.readAudit({ roundId: 'round-1' });
    assert.equal(audit.at(-1).outcome, 'rejected');
    assert.equal(audit.at(-1).reason, 'outside_voting_window');
    assert.equal(audit.at(-1).roundRevision, 1);
  });
});

test('refuses an ineligible voter, a recused voter and a vote cast for another member', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);

    const outsider = vote(store, { actor: 'outsider', ballot: { memberId: 'outsider' }, idempotencyKey: 'vote-outsider' });
    assert.equal(outsider.accepted, false);
    assert.equal(outsider.reason, 'ineligible_voter');

    // AC06: the trusted requester is the voter, so a ballot naming someone else is refused.
    const impostor = vote(store, { actor: 'm1', ballot: { memberId: 'm2' }, idempotencyKey: 'vote-for-m2' });
    assert.equal(impostor.accepted, false);
    assert.equal(impostor.reason, 'actor_mismatch');
    assert.equal(store.getRound({ roundId: 'round-1' }).state.ballots.length, 0);

    const recusal = store.declareRecusal({
      roundId: 'round-1',
      recusal: { proposalId: 'p1', memberId: 'm2', declaredAt: DURING, reason: 'direct interest' },
      actor: 'm2',
      at: DURING,
      idempotencyKey: 'recusal-1',
    });
    assert.equal(recusal.accepted, true);
    assert.equal(recusal.revision, 2);
    assert.equal(recusal.recusal.memberId, 'm2');

    const recused = vote(store, { actor: 'm2', ballot: { memberId: 'm2' }, idempotencyKey: 'vote-recused' });
    assert.equal(recused.accepted, false);
    assert.equal(recused.reason, 'recused_member');

    const again = store.declareRecusal({
      roundId: 'round-1',
      recusal: { proposalId: 'p1', memberId: 'm2', declaredAt: DURING, reason: 'again' },
      actor: 'm2',
      at: DURING,
      idempotencyKey: 'recusal-2',
    });
    assert.equal(again.accepted, false);
    assert.equal(again.reason, 'already_recused');

    const audit = store.readAudit({ roundId: 'round-1' });
    assert.deepEqual(
      audit.map((entry) => `${entry.action}:${entry.outcome}:${entry.reason}`),
      [
        'open_round:accepted:null',
        'cast_ballot:rejected:ineligible_voter',
        'cast_ballot:rejected:actor_mismatch',
        'declare_recusal:accepted:null',
        'cast_ballot:rejected:recused_member',
        'declare_recusal:rejected:already_recused',
      ],
    );
  });
});

test('a rejected attempt grows the audit trail but never rewrites the round as an accepted ballot', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    vote(store, { actor: 'm1', idempotencyKey: 'vote-m1' });
    const before = store.getRound({ roundId: 'round-1' });
    const auditBefore = store.readAudit({ roundId: 'round-1' }).length;

    const rejected = vote(store, { actor: 'outsider', ballot: { memberId: 'outsider' }, idempotencyKey: 'vote-outsider' });
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.ballot, null);
    assert.equal(rejected.revision, before.revision);

    const after = store.getRound({ roundId: 'round-1' });
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.state.ballots, before.state.ballots);
    assert.deepEqual(after.state.recusals, before.state.recusals);
    assert.equal(store.readAudit({ roundId: 'round-1' }).length, auditBefore + 1);
  });
});

test('counts a round from durable state and keeps the tally a pure read', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    vote(store, { actor: 'm1', idempotencyKey: 'vote-m1' });
    vote(store, { actor: 'm2', idempotencyKey: 'vote-m2' });
    const revision = store.getRound({ roundId: 'round-1' }).revision;

    const tally = store.tallyRound({ roundId: 'round-1' });
    assert.equal(tally.roundId, 'round-1');
    assert.equal(tally.proposals.length, 1);
    assert.equal(tally.proposals[0].status, 'passed');
    assert.equal(tally.proposals[0].participatingMemberCount, 2);
    assert.equal(tally.proposals[0].participatingWeight, 5);
    assert.equal(tally.proposals[0].weights.approve, 5);
    assert.equal(tally.proposals[0].proposalVersion, 'v1');

    const single = store.tallyProposal({ roundId: 'round-1', proposalId: 'p1' });
    assert.equal(single.status, 'passed');

    // Reads never move the round revision.
    assert.equal(store.getRound({ roundId: 'round-1' }).revision, revision);
  });
});

test('a funded proposal is counted as awaiting allocation, never as a reservation or payment', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store, {
      proposals: [{ proposalId: 'p1', version: 'v1', leadMemberId: 'lead-1', requestedAmountMinor: 5000 }],
    });
    vote(store, { actor: 'm1', idempotencyKey: 'vote-m1' });
    vote(store, { actor: 'm2', idempotencyKey: 'vote-m2' });

    const tally = store.tallyRound({ roundId: 'round-1' });
    assert.equal(tally.proposals[0].status, 'passed');
    assert.equal(tally.budget.status, 'available_funds_unknown');
    assert.equal(tally.budget.availableFundsKnown, false);
    assert.deepEqual(tally.awaitingFundingAllocation, ['p1']);
    assert.equal(tally.allocations[0].status, 'awaiting_funding_allocation');
    assert.equal(tally.allocations[0].allocatedMinor, 0);
  });
});

test('restart preserves ballots, recusals and audit, and continues the ballot sequence', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    // Recusal is declared before any ballot exists for the proposal, which is what the engine allows.
    store.declareRecusal({
      roundId: 'round-1',
      recusal: { proposalId: 'p1', memberId: 'm3', declaredAt: DURING, reason: 'conflict' },
      actor: 'm3',
      at: DURING,
      idempotencyKey: 'recusal-1',
    });
    vote(store, { actor: 'm1', idempotencyKey: 'vote-m1' });
    vote(store, { actor: 'm2', idempotencyKey: 'vote-m2' });
    const before = store.snapshot();

    const restarted = createGovernanceStore({ path: file });
    const after = restarted.snapshot();
    assert.deepEqual(after, before);

    const round = restarted.getRound({ roundId: 'round-1' });
    assert.deepEqual(round.state.ballots.map((ballot) => [ballot.sequence, ballot.memberId]), [[1, 'm1'], [2, 'm2']]);
    assert.deepEqual(round.state.recusals.map((recusal) => recusal.memberId), ['m3']);

    const next = vote(restarted, { actor: 'm2', ballot: { choice: 'reject' }, idempotencyKey: 'vote-m2-replace' });
    assert.equal(next.accepted, true);
    assert.equal(next.ballot.sequence, 3);
    assert.equal(next.replacedSequence, 2);
  });
});

test('one idempotency key cannot be reused for another actor or action', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    vote(store, { actor: 'm1', idempotencyKey: 'shared-key' });
    assert.throws(
      () => vote(store, { actor: 'm2', idempotencyKey: 'shared-key' }),
      (error) => error.code === 'idempotency_conflict' && error.details.existingActor === 'm1',
    );
    assert.throws(
      () => store.declareRecusal({
        roundId: 'round-1',
        recusal: { proposalId: 'p1', declaredAt: DURING, reason: 'x' },
        actor: 'm1',
        at: DURING,
        idempotencyKey: 'shared-key',
      }),
      (error) => error.code === 'idempotency_conflict' && error.details.existingAction === 'cast_ballot',
    );
  });
});

test('refuses an unknown round instead of inventing one', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    assert.throws(() => store.getRound({ roundId: 'nope' }), (error) => error.code === 'round_not_found');
    assert.throws(() => vote(store, {}), (error) => error.code === 'round_not_found');
    assert.throws(() => store.tallyRound({ roundId: 'nope' }), (error) => error.code === 'round_not_found');
  });
});

test('a malformed persisted slot is refused rather than hydrated into a broken round', () => {
  withStore((file) => {
    const store = createGovernanceStore({ path: file });
    openRound(store);
    const raw = JSON.parse(readFileSync(file, 'utf8'));

    raw.records.reinGovernance.rounds['round-1'].state.snapshot = {};
    writeFileSync(file, JSON.stringify(raw));
    assert.throws(
      () => createGovernanceStore({ path: file }).getRound({ roundId: 'round-1' }),
      (error) => error.code === 'corrupt_state',
    );

    raw.records.reinGovernance.schema = 'rein-governance-store/999';
    writeFileSync(file, JSON.stringify(raw));
    assert.throws(
      () => createGovernanceStore({ path: file }).readAudit(),
      (error) => error.code === 'corrupt_state',
    );
  });
});
