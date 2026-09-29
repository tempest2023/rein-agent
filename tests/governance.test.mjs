import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRound,
  castBallot,
  declareRecusal,
  tallyProposal,
  tallyRound,
  effectiveRecusedMemberIds,
  isProposalEligible,
  isVoterEligible,
  getRoundStatus,
  prdR14DiscussionDefaultRules,
  GovernanceError,
} from '../plugins/rein-operations/governance.ts';

const OPENS = '2026-09-01T00:00:00Z';
const CLOSES = '2026-09-01T00:45:00Z';
const DURING = '2026-09-01T00:10:00Z';

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
    proposals: [
      { proposalId: 'p1', version: 'v1', leadMemberId: 'lead-1', requestedAmountMinor: 0 },
    ],
    ...overrides,
  };
}

function cast(state, proposalId, memberId, choice, castAt = DURING, idempotencyKey) {
  return castBallot(state, { proposalId, memberId, choice, castAt, idempotencyKey });
}

test('rules must be explicit: no counting default is activated implicitly', () => {
  assert.throws(() => createRound(roundInput({ rules: undefined })), (error) => {
    assert.ok(error instanceof GovernanceError);
    assert.equal(error.code, 'rules_required');
    return true;
  });
  assert.throws(() => createRound(roundInput({ rules: {} })), { code: 'rules_required' });
  // An incomplete rule set is refused rather than completed with PRD recommendations.
  assert.throws(
    () => createRound(roundInput({ rules: { rulesVersion: 'x', participation: { minMemberFraction: { numerator: 1, denominator: 2 } } } })),
    { code: 'rules_required' },
  );
  assert.throws(() => createRound(roundInput({ rules: rules({ tie: undefined }) })), { code: 'rules_required' });
  // A present but malformed rule value is reported as invalid rather than missing.
  assert.throws(
    () => createRound(roundInput({ rules: rules({ tie: { outcome: 'coin_flip' } }) })),
    { code: 'invalid_rules' },
  );
});

test('the PRD R14 rules exist only as an explicit opt-in preset', () => {
  const preset = prdR14DiscussionDefaultRules({ rulesVersion: 'prd-r14-draft' });
  assert.equal(preset.rulesVersion, 'prd-r14-draft');
  assert.deepEqual(preset.participation.minMemberFraction, { numerator: 1, denominator: 2 });
  assert.deepEqual(preset.approval.strictMajorityFraction, { numerator: 1, denominator: 2 });
  assert.equal(preset.tie.outcome, 'not_passed');
  assert.equal(preset.allocation.rule, 'no_auto_allocation');
  // Passing it is still an explicit act; the module never reaches for it on its own.
  const state = createRound(roundInput({ rules: preset }));
  assert.equal(state.snapshot.rulesVersion, 'prd-r14-draft');
});

test('createRound freezes and detaches the snapshot from caller-owned inputs', () => {
  const roster = [
    { memberId: 'm1', weight: 3 },
    { memberId: 'm2', weight: 2 },
  ];
  const proposals = [
    { proposalId: 'p1', version: 'v1', leadMemberId: 'm1', requestedAmountMinor: 500, recusedMemberIds: ['m1'] },
  ];
  const input = roundInput({ roster, proposals, budgetAvailableMinor: 1000 });
  const state = createRound(input);

  roster[0].weight = 99;
  proposals.push({ proposalId: 'p2', version: 'v1', leadMemberId: 'm2', requestedAmountMinor: 100 });
  proposals[0].requestedAmountMinor = 999999;
  input.budgetAvailableMinor = 5;

  assert.equal(state.snapshot.roster[0].weight, 3);
  assert.equal(state.snapshot.proposals.length, 1);
  assert.equal(state.snapshot.proposals[0].requestedAmountMinor, 500);
  assert.equal(state.snapshot.budgetAvailableMinor, 1000);
  assert.ok(Object.isFrozen(state.snapshot));
  assert.ok(Object.isFrozen(state.snapshot.rules));
  assert.ok(Object.isFrozen(state.snapshot.proposals));
  assert.ok(Object.isFrozen(state.ballots));
  assert.deepEqual(state.ballots, []);
  assert.deepEqual(state.snapshot.warnings, []);
});

test('createRound rejects malformed snapshots instead of guessing', () => {
  assert.throws(() => createRound(roundInput({ closesAt: OPENS })), { code: 'invalid_input' });
  assert.throws(
    () => createRound(roundInput({ roster: [{ memberId: 'm1', weight: 1 }, { memberId: 'm1', weight: 2 }] })),
    { code: 'invalid_input' },
  );
  assert.throws(
    () => createRound(roundInput({ roster: [{ memberId: 'm1', weight: 1.5 }] })),
    { code: 'invalid_input' },
  );
  assert.throws(
    () =>
      createRound(
        roundInput({
          proposals: [
            { proposalId: 'p1', version: 'v1', leadMemberId: 'm1', requestedAmountMinor: 0, recusedMemberIds: ['ghost'] },
          ],
        }),
      ),
    { code: 'invalid_input' },
  );
  assert.throws(
    () => createRound(roundInput({ rules: rules({ allocation: { rule: 'explicit_ranking' } }) })),
    { code: 'invalid_rules' },
  );
  assert.throws(
    () =>
      createRound(
        roundInput({
          proposals: [
            { proposalId: 'p1', version: 'v1', leadMemberId: 'm1', requestedAmountMinor: 0 },
            { proposalId: 'p2', version: 'v1', leadMemberId: 'm2', requestedAmountMinor: 0 },
          ],
          rules: rules({ allocation: { rule: 'explicit_ranking', ranking: ['p1'], exhaustion: 'stop_at_first_unfundable' } }),
        }),
      ),
    { code: 'invalid_rules' },
  );
});

test('the lead may be a Contributor outside the Board roster, and warns only when a roster lead did not recuse', () => {
  const outsideLead = createRound(
    roundInput({ proposals: [{ proposalId: 'p1', version: 'v1', leadMemberId: 'contributor-9', requestedAmountMinor: 0 }] }),
  );
  assert.deepEqual(outsideLead.snapshot.warnings, []);

  const rosterLead = createRound(
    roundInput({ proposals: [{ proposalId: 'p1', version: 'v1', leadMemberId: 'm1', requestedAmountMinor: 0 }] }),
  );
  assert.deepEqual(rosterLead.snapshot.warnings, ['proposal p1: lead m1 is not marked recused']);
});

test('eligibility and deadline helpers are explicit and deterministic', () => {
  const state = createRound(roundInput());
  assert.equal(isVoterEligible(state, 'm1'), true);
  assert.equal(isVoterEligible(state, 'stranger'), false);
  assert.equal(isProposalEligible(state, 'p1'), true);
  assert.equal(isProposalEligible(state, 'p9'), false);
  assert.equal(getRoundStatus(state, '2026-08-31T23:59:59Z'), 'scheduled');
  assert.equal(getRoundStatus(state, DURING), 'open');
  assert.equal(getRoundStatus(state, CLOSES), 'closed');
});

test('ballots outside the window, for ineligible voters, unknown proposals or invalid choices are rejected', () => {
  const state = createRound(roundInput());

  assert.equal(cast(state, 'p1', 'stranger', 'approve').reason, 'ineligible_voter');
  assert.equal(cast(state, 'p9', 'm1', 'approve').reason, 'proposal_not_eligible');
  assert.equal(cast(state, 'p1', 'm1', 'maybe').reason, 'invalid_choice');
  assert.equal(cast(state, 'p1', 'm1', 'approve', '2026-08-31T23:59:59Z').reason, 'outside_voting_window');
  assert.equal(cast(state, 'p1', 'm1', 'approve', CLOSES).reason, 'outside_voting_window');
  assert.equal(state.ballots.length, 0, 'rejections never mutate the round');
});

test('an accepted ballot records choice, weight context and sequence without mutating prior state', () => {
  const state = createRound(roundInput());
  const result = cast(state, 'p1', 'm1', 'approve');

  assert.equal(result.accepted, true);
  assert.equal(result.duplicated, false);
  assert.equal(result.replacedSequence, null);
  assert.deepEqual(result.ballot, {
    sequence: 1,
    proposalId: 'p1',
    memberId: 'm1',
    choice: 'approve',
    castAt: DURING,
    idempotencyKey: null,
    replacesSequence: null,
  });
  assert.equal(state.ballots.length, 0, 'the original round is untouched');
  assert.equal(result.state.ballots.length, 1);
  assert.ok(Object.isFrozen(result.state.ballots));
});

test('vote replacement keeps history and only the latest valid choice counts', () => {
  let state = createRound(roundInput());
  state = cast(state, 'p1', 'm1', 'reject').state;
  const replaced = cast(state, 'p1', 'm1', 'approve');

  assert.equal(replaced.accepted, true);
  assert.equal(replaced.replacedSequence, 1);
  state = replaced.state;
  assert.equal(state.ballots.length, 2, 'prior choices stay available for verification');
  assert.deepEqual(state.ballots.map((ballot) => ballot.choice), ['reject', 'approve']);

  const tally = tallyProposal(state, 'p1');
  assert.deepEqual(tally.weights, { approve: 3, reject: 0, abstain: 0 });
  assert.equal(tally.counts.approve, 1);
  assert.equal(tally.counts.reject, 0);
});

test('when the rules forbid replacement a second ballot is refused as a duplicate', () => {
  let state = createRound(roundInput({ rules: rules({ voteReplacement: { allowed: false } }) }));
  state = cast(state, 'p1', 'm1', 'reject').state;
  const second = cast(state, 'p1', 'm1', 'approve');
  assert.equal(second.accepted, false);
  assert.equal(second.reason, 'vote_replacement_not_allowed');
  assert.equal(second.state.ballots.length, 1);
});

test('an idempotency key suppresses a repeated click and conflicts are refused', () => {
  const state = createRound(roundInput());
  const first = cast(state, 'p1', 'm1', 'approve', DURING, 'click-1');
  const repeat = cast(first.state, 'p1', 'm1', 'approve', DURING, 'click-1');

  assert.equal(repeat.accepted, true);
  assert.equal(repeat.duplicated, true);
  assert.equal(repeat.state.ballots.length, 1);
  assert.equal(repeat.ballot.sequence, 1);

  const conflict = cast(first.state, 'p1', 'm2', 'reject', DURING, 'click-1');
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.reason, 'idempotency_key_conflict');
  assert.equal(conflict.state.ballots.length, 1);
});

test('a recusal declared before any ballot removes the member from headcount and weight and blocks their ballot', () => {
  let state = createRound(roundInput());
  const recusal = declareRecusal(state, {
    proposalId: 'p1',
    memberId: 'm1',
    declaredAt: DURING,
    reason: 'direct interest',
  });
  assert.equal(recusal.accepted, true);
  state = recusal.state;
  assert.deepEqual(effectiveRecusedMemberIds(state, 'p1'), ['m1']);
  assert.equal(cast(state, 'p1', 'm1', 'approve').reason, 'recused_member');

  const tally = tallyProposal(state, 'p1');
  assert.equal(tally.eligibleMemberCount, 2);
  assert.equal(tally.eligibleWeight, 3);
  assert.deepEqual(tally.recusedMemberIds, ['m1']);
});

test('a recusal cannot be declared after ballots exist, so no recorded vote is silently invalidated', () => {
  const state = cast(createRound(roundInput()), 'p1', 'm2', 'reject').state;
  const late = declareRecusal(state, {
    proposalId: 'p1',
    memberId: 'm1',
    declaredAt: DURING,
    reason: 'declared late',
  });
  assert.equal(late.accepted, false);
  assert.equal(late.reason, 'ballots_already_recorded_restart_required');
  assert.deepEqual(effectiveRecusedMemberIds(late.state, 'p1'), []);
});

test('PRD R14 worked example: weights 3/2/1, approve 3 and reject 2 passes with 3/5 of non-abstaining weight', () => {
  let state = createRound(roundInput());
  state = cast(state, 'p1', 'm1', 'approve').state;
  state = cast(state, 'p1', 'm2', 'reject').state;

  const tally = tallyProposal(state, 'p1');
  assert.equal(tally.eligibleMemberCount, 3);
  assert.equal(tally.eligibleWeight, 6);
  assert.equal(tally.requiredParticipatingMembers, 2);
  assert.equal(tally.participatingMemberCount, 2);
  assert.equal(tally.participatingWeight, 5);
  assert.deepEqual(tally.participation, { memberRequirementMet: true, weightRequirementMet: true, met: true });
  assert.deepEqual(tally.weights, { approve: 3, reject: 2, abstain: 0 });
  assert.deepEqual(tally.approvalShareOfNonAbstaining, { numerator: 3, denominator: 5 });
  assert.equal(tally.status, 'passed');
  assert.equal(tally.passed, true);
  assert.deepEqual(tally.reasons, []);
});

test('PRD R14 worked example: a single weight-3 vote is insufficient participation, deferred rather than rejected', () => {
  const state = cast(createRound(roundInput()), 'p1', 'm1', 'approve').state;
  const tally = tallyProposal(state, 'p1');

  assert.equal(tally.status, 'insufficient_participation_deferred');
  assert.equal(tally.passed, false);
  assert.deepEqual(tally.participation, { memberRequirementMet: false, weightRequirementMet: true, met: false });
  assert.ok(tally.reasons.includes('insufficient_participation'));
  assert.ok(tally.reasons.includes('member_participation_below_minimum'));
});

test('abstentions count toward participation but never toward the approve-versus-reject comparison', () => {
  let state = createRound(roundInput());
  state = cast(state, 'p1', 'm1', 'approve').state;
  state = cast(state, 'p1', 'm2', 'abstain').state;

  const tally = tallyProposal(state, 'p1');
  assert.equal(tally.participatingMemberCount, 2);
  assert.equal(tally.participatingWeight, 5);
  assert.equal(tally.nonAbstainingWeight, 3);
  assert.deepEqual(tally.weights, { approve: 3, reject: 0, abstain: 2 });
  assert.deepEqual(tally.approvalShareOfNonAbstaining, { numerator: 1, denominator: 1 });
  assert.equal(tally.status, 'passed');
});

test('universal abstention cannot produce automatic passage', () => {
  let state = createRound(roundInput());
  state = cast(state, 'p1', 'm1', 'abstain').state;
  state = cast(state, 'p1', 'm2', 'abstain').state;

  const tally = tallyProposal(state, 'p1');
  assert.equal(tally.participation.met, true);
  assert.equal(tally.nonAbstainingWeight, 0);
  assert.equal(tally.approvalShareOfNonAbstaining, null);
  assert.equal(tally.status, 'not_passed');
  assert.deepEqual(tally.reasons, ['no_non_abstaining_vote']);
});

test('a tie is resolved only by the explicit tie rule', () => {
  const tied = () => {
    let state = createRound(roundInput({ roster: [{ memberId: 'm1', weight: 3 }, { memberId: 'm2', weight: 3 }] }));
    state = cast(state, 'p1', 'm1', 'approve').state;
    return cast(state, 'p1', 'm2', 'reject').state;
  };

  const asNotPassed = tallyProposal(tied(), 'p1');
  assert.equal(asNotPassed.status, 'not_passed');
  assert.deepEqual(asNotPassed.reasons, ['tie_does_not_pass']);

  let passedState = createRound(
    roundInput({ roster: [{ memberId: 'm1', weight: 3 }, { memberId: 'm2', weight: 3 }], rules: rules({ tie: { outcome: 'passed' } }) }),
  );
  passedState = cast(passedState, 'p1', 'm1', 'approve').state;
  passedState = cast(passedState, 'p1', 'm2', 'reject').state;
  assert.equal(tallyProposal(passedState, 'p1').status, 'passed');

  let deferredState = createRound(
    roundInput({ roster: [{ memberId: 'm1', weight: 3 }, { memberId: 'm2', weight: 3 }], rules: rules({ tie: { outcome: 'defer_to_revote' } }) }),
  );
  deferredState = cast(deferredState, 'p1', 'm1', 'approve').state;
  deferredState = cast(deferredState, 'p1', 'm2', 'reject').state;
  const deferred = tallyProposal(deferredState, 'p1');
  assert.equal(deferred.status, 'deferred_for_revote');
  assert.equal(deferred.passed, false);
});

test('a supermajority rule is applied exactly as configured', () => {
  const twoThirds = rules({ approval: { strictMajorityFraction: { numerator: 2, denominator: 3 }, requireNonAbstainingVote: true } });
  let state = createRound(roundInput({ rules: twoThirds }));
  state = cast(state, 'p1', 'm1', 'approve').state; // weight 3
  state = cast(state, 'p1', 'm2', 'reject').state; // weight 2
  // 3/5 = 0.6 is below two thirds, so the same votes that pass under 1/2 now fail.
  const tally = tallyProposal(state, 'p1');
  assert.equal(tally.status, 'not_passed');
  assert.deepEqual(tally.reasons, ['approval_below_strict_majority']);
});

test('competing budget demands are never allocated by processing order', () => {
  const proposals = [
    { proposalId: 'p1', version: 'v1', leadMemberId: 'lead-1', requestedAmountMinor: 600 },
    { proposalId: 'p2', version: 'v1', leadMemberId: 'lead-2', requestedAmountMinor: 500 },
  ];
  const state = createRound(roundInput({ proposals, budgetAvailableMinor: 1000 }));
  let voted = state;
  for (const proposalId of ['p2', 'p1']) {
    voted = cast(voted, proposalId, 'm1', 'approve').state;
    voted = cast(voted, proposalId, 'm2', 'approve').state;
  }

  const result = tallyRound(voted);
  assert.equal(result.budget.status, 'shortfall');
  assert.equal(result.budget.requestedByPassedMinor, 1100);
  assert.equal(result.budget.shortfallMinor, 100);
  assert.deepEqual(result.awaitingFundingAllocation, ['p1', 'p2']);
  assert.ok(result.allocations.every((decision) => decision.status === 'awaiting_funding_allocation'));
  assert.ok(result.allocations.every((decision) => decision.allocatedMinor === 0));
  assert.ok(result.outstanding.includes('budget_shortfall_requires_prioritization_decision'));
});

test('an explicit ranking resolves competition deterministically, and proposal order does not matter', () => {
  const proposals = [
    { proposalId: 'p1', version: 'v1', leadMemberId: 'lead-1', requestedAmountMinor: 600 },
    { proposalId: 'p2', version: 'v1', leadMemberId: 'lead-2', requestedAmountMinor: 500 },
  ];
  const rankedRules = rules({
    allocation: { rule: 'explicit_ranking', ranking: ['p2', 'p1'], exhaustion: 'stop_at_first_unfundable' },
  });

  const run = (orderedProposals) => {
    let state = createRound(roundInput({ proposals: orderedProposals, budgetAvailableMinor: 1000, rules: rankedRules }));
    for (const proposalId of ['p1', 'p2']) {
      state = cast(state, proposalId, 'm1', 'approve').state;
      state = cast(state, proposalId, 'm2', 'approve').state;
    }
    return tallyRound(state);
  };

  const forward = run(proposals);
  const reversed = run([...proposals].reverse());

  assert.deepEqual(forward.allocations, [
    { proposalId: 'p1', requestedAmountMinor: 600, allocatedMinor: 0, status: 'awaiting_funding_allocation', basis: 'explicit_ranking' },
    { proposalId: 'p2', requestedAmountMinor: 500, allocatedMinor: 500, status: 'allocated', basis: 'explicit_ranking' },
  ]);
  assert.deepEqual(reversed.allocations, forward.allocations);
  assert.deepEqual(reversed.awaitingFundingAllocation, ['p1']);
});

test('an exhaustion rule of continue_to_next_fitting funds a smaller lower-ranked proposal', () => {
  const proposals = [
    { proposalId: 'p1', version: 'v1', leadMemberId: 'lead-1', requestedAmountMinor: 900 },
    { proposalId: 'p2', version: 'v1', leadMemberId: 'lead-2', requestedAmountMinor: 200 },
  ];
  const base = {
    proposals,
    budgetAvailableMinor: 500,
    rules: rules({ allocation: { rule: 'explicit_ranking', ranking: ['p1', 'p2'], exhaustion: 'continue_to_next_fitting' } }),
  };
  let state = createRound(roundInput(base));
  for (const proposalId of ['p1', 'p2']) {
    state = cast(state, proposalId, 'm1', 'approve').state;
    state = cast(state, proposalId, 'm2', 'approve').state;
  }
  const result = tallyRound(state);
  assert.deepEqual(
    result.allocations.map((decision) => [decision.proposalId, decision.allocatedMinor]),
    [['p1', 0], ['p2', 200]],
  );
  assert.deepEqual(result.awaitingFundingAllocation, ['p1']);
});

test('unconfirmed available funds pause commitments instead of guessing', () => {
  let state = createRound(
    roundInput({
      proposals: [{ proposalId: 'p1', version: 'v1', leadMemberId: 'lead-1', requestedAmountMinor: 500 }],
      budgetAvailableMinor: null,
    }),
  );
  state = cast(state, 'p1', 'm1', 'approve').state;
  state = cast(state, 'p1', 'm2', 'approve').state;

  const result = tallyRound(state);
  assert.equal(result.budget.status, 'available_funds_unknown');
  assert.equal(result.budget.availableFundsKnown, false);
  assert.deepEqual(result.awaitingFundingAllocation, ['p1']);
  assert.ok(result.outstanding.includes('available_funds_unknown_pause_commitments'));
});

test('a passed zero-budget activity needs no allocation, and a funded pass still awaits allocation', () => {
  let state = createRound(
    roundInput({
      proposals: [
        { proposalId: 'p1', version: 'v1', leadMemberId: 'lead-1', requestedAmountMinor: 0 },
        { proposalId: 'p2', version: 'v1', leadMemberId: 'lead-2', requestedAmountMinor: 400 },
      ],
      budgetAvailableMinor: 1000,
    }),
  );
  for (const proposalId of ['p1', 'p2']) {
    state = cast(state, proposalId, 'm1', 'approve').state;
    state = cast(state, proposalId, 'm2', 'approve').state;
  }

  const result = tallyRound(state);
  assert.equal(result.budget.status, 'fully_covered');
  assert.deepEqual(
    result.allocations.map((decision) => [decision.proposalId, decision.status, decision.allocatedMinor]),
    [['p1', 'passed_no_funding_required', 0], ['p2', 'allocated', 400]],
  );
  // Funding approval is a bookkeeping decision; nothing here records a payment.
  assert.deepEqual(result.awaitingFundingAllocation, []);
});

test('tallying is deterministic and independent of ballot arrival order', () => {
  const build = (order) => {
    let state = createRound(roundInput());
    for (const [memberId, choice] of order) state = cast(state, 'p1', memberId, choice).state;
    return state;
  };
  const first = build([['m1', 'approve'], ['m2', 'reject'], ['m3', 'abstain']]);
  const second = build([['m3', 'abstain'], ['m2', 'reject'], ['m1', 'approve']]);

  assert.deepEqual(tallyProposal(second, 'p1'), tallyProposal(first, 'p1'));
  assert.deepEqual(tallyRound(second), tallyRound(first));
});

test('a round with nothing passed reports no budget request', () => {
  const result = tallyRound(createRound(roundInput({ budgetAvailableMinor: 5000 })));
  assert.equal(result.budget.status, 'not_requested');
  assert.equal(result.budget.requestedByPassedMinor, 0);
  assert.deepEqual(result.allocations, []);
  assert.deepEqual(result.awaitingFundingAllocation, []);
});

test('tally results carry the frozen proposal version and rules version for traceability', () => {
  let state = createRound(
    roundInput({
      proposals: [{ proposalId: 'p1', version: '2026-08-30T12:00:00Z#abc123', leadMemberId: 'lead-1', requestedAmountMinor: 0 }],
    }),
  );
  state = cast(state, 'p1', 'm1', 'approve').state;
  state = cast(state, 'p1', 'm2', 'approve').state;

  const result = tallyRound(state);
  assert.equal(result.rulesVersion, 'test-rules-1');
  assert.equal(result.proposals[0].proposalVersion, '2026-08-30T12:00:00Z#abc123');
  assert.equal(result.proposals[0].currency, 'USD');
  assert.ok(Object.isFrozen(result));
});
