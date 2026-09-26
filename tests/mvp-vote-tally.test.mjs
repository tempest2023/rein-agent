import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MvpVoteTallyError,
  tallyMvpVote,
} from '../plugins/rein-operations/mvp-vote-tally.ts';

const ROSTER = ['m1', 'm2', 'm3', 'm4'];
const CANDIDATES = ['EV-012', 'EV-013'];
const MAX = 2;

function ballot(memberId, approvedProposalIds) {
  return { memberId, approvedProposalIds };
}

function tally(overrides = {}) {
  return tallyMvpVote({
    eligibleMemberIds: ROSTER,
    candidateProposalIds: CANDIDATES,
    maxApprovalsPerVoter: MAX,
    ballots: [],
    ...overrides,
  });
}

test('each approved candidate gains exactly one count per approving member', () => {
  const result = tally({
    ballots: [ballot('m1', ['EV-012', 'EV-013']), ballot('m2', ['EV-012']), ballot('m3', [])],
  });
  assert.equal(result.outcome, 'unique_winner');
  assert.equal(result.winner, 'EV-012');
  assert.deepEqual(result.counts, { 'EV-012': 2, 'EV-013': 1 });
  assert.equal(result.maxApprovalsPerVoter, 2);
  assert.deepEqual(result.tiedProposalIds, []);
  assert.deepEqual(result.reasons, ['unique_highest_count']);
  assert.deepEqual(result.rejectedBallots, []);
  assert.deepEqual(result.participation, {
    eligible: 4,
    participating: 3,
    abstained: 1,
    approving: 2,
    approvals: 3,
  });
});

test('one ballot approving several candidates is one ballot, not several votes', () => {
  // Two members each approve both candidates: every candidate gets one count per member, so the
  // round is a two-way tie rather than a win for whichever candidate was listed first.
  const result = tally({
    ballots: [ballot('m1', ['EV-012', 'EV-013']), ballot('m2', ['EV-013', 'EV-012'])],
  });
  assert.equal(result.outcome, 'tie');
  assert.equal(result.winner, null);
  assert.deepEqual(result.tiedProposalIds, ['EV-012', 'EV-013']);
  assert.deepEqual(result.counts, { 'EV-012': 2, 'EV-013': 2 });
  assert.deepEqual(result.participation, {
    eligible: 4,
    participating: 2,
    abstained: 0,
    approving: 2,
    approvals: 4,
  });
});

test('zero approvals is an abstention: participation that gives no candidate a count', () => {
  const result = tally({
    ballots: [ballot('m1', []), ballot('m2', ['EV-013'])],
  });
  assert.deepEqual(result.participation, {
    eligible: 4,
    participating: 2,
    abstained: 1,
    approving: 1,
    approvals: 1,
  });
  assert.deepEqual(result.counts, { 'EV-012': 0, 'EV-013': 1 });
  assert.equal(result.winner, 'EV-013');
  assert.deepEqual(result.rejectedBallots, []);
});

test('a candidate nobody approves keeps a zero count and never wins', () => {
  const result = tallyMvpVote({
    eligibleMemberIds: ROSTER,
    candidateProposalIds: ['EV-012', 'EV-013', 'EV-014'],
    maxApprovalsPerVoter: 3,
    ballots: [ballot('m1', ['EV-012'])],
  });
  assert.deepEqual(Object.keys(result.counts).sort(), ['EV-012', 'EV-013', 'EV-014']);
  assert.equal(result.counts['EV-014'], 0);
  assert.equal(result.winner, 'EV-012');
  assert.deepEqual(result.candidateProposalIds, ['EV-012', 'EV-013', 'EV-014']);
});

test('a round with only abstentions or no ballots yields no winner', () => {
  const allAbstain = tally({ ballots: [ballot('m1', []), ballot('m2', [])] });
  assert.equal(allAbstain.outcome, 'no_winner');
  assert.equal(allAbstain.winner, null);
  assert.deepEqual(allAbstain.reasons, ['no_approvals_cast']);
  assert.deepEqual(allAbstain.counts, { 'EV-012': 0, 'EV-013': 0 });
  assert.deepEqual(allAbstain.tiedProposalIds, []);
  assert.deepEqual(allAbstain.participation, {
    eligible: 4,
    participating: 2,
    abstained: 2,
    approving: 0,
    approvals: 0,
  });

  const empty = tally();
  assert.equal(empty.outcome, 'no_winner');
  assert.equal(empty.winner, null);
  assert.deepEqual(empty.participation, {
    eligible: 4,
    participating: 0,
    abstained: 0,
    approving: 0,
    approvals: 0,
  });

  // Zero for every candidate is not a tie; nobody approved a proposal.
  assert.notEqual(empty.outcome, 'tie');
  assert.notEqual(allAbstain.outcome, 'tie');
});

test('a highest-count tie yields no official winner and names the tied candidates', () => {
  const result = tally({
    ballots: [ballot('m1', ['EV-012']), ballot('m2', ['EV-013']), ballot('m3', [])],
  });
  assert.equal(result.outcome, 'tie');
  assert.equal(result.winner, null);
  assert.deepEqual(result.tiedProposalIds, ['EV-012', 'EV-013']);
  assert.deepEqual(result.reasons, ['tie_at_highest_count']);
  assert.deepEqual(result.counts, { 'EV-012': 1, 'EV-013': 1 });
  assert.equal(result.participation.participating, 3);
});

test('a member may approve up to the limit, and a generous limit is not an error', () => {
  const atLimit = tally({ ballots: [ballot('m1', ['EV-012', 'EV-013'])] });
  assert.deepEqual(atLimit.rejectedBallots, []);
  assert.deepEqual(atLimit.counts, { 'EV-012': 1, 'EV-013': 1 });
  assert.equal(atLimit.outcome, 'tie');

  const generous = tallyMvpVote({
    eligibleMemberIds: ROSTER,
    candidateProposalIds: CANDIDATES,
    maxApprovalsPerVoter: 5,
    ballots: [ballot('m1', ['EV-012', 'EV-013']), ballot('m2', ['EV-013'])],
  });
  assert.deepEqual(generous.rejectedBallots, []);
  assert.equal(generous.winner, 'EV-013');
});

test('approving more candidates than the limit is rejected and never counted', () => {
  const result = tally({
    maxApprovalsPerVoter: 1,
    ballots: [ballot('m1', ['EV-012', 'EV-013']), ballot('m2', ['EV-012'])],
  });
  assert.deepEqual(result.rejectedBallots, [
    { memberId: 'm1', approvedProposalIds: ['EV-012', 'EV-013'], reason: 'too_many_approvals' },
  ]);
  assert.deepEqual(result.counts, { 'EV-012': 1, 'EV-013': 0 });
  assert.equal(result.winner, 'EV-012');
  assert.deepEqual(result.participation, {
    eligible: 4,
    participating: 1,
    abstained: 0,
    approving: 1,
    approvals: 1,
  });
});

test('a repeated candidate inside one ballot is rejected', () => {
  const result = tally({ ballots: [ballot('m1', ['EV-012', 'EV-012'])] });
  assert.deepEqual(result.rejectedBallots, [
    { memberId: 'm1', approvedProposalIds: ['EV-012', 'EV-012'], reason: 'duplicate_approval' },
  ]);
  assert.deepEqual(result.counts, { 'EV-012': 0, 'EV-013': 0 });
  assert.equal(result.outcome, 'no_winner');
  assert.equal(result.participation.participating, 0);
});

test('an approval for a candidate outside the frozen list is rejected', () => {
  const result = tally({
    ballots: [ballot('m1', ['EV-012']), ballot('m2', ['EV-999']), ballot('m3', ['EV-013', 'EV-999'])],
  });
  assert.deepEqual(result.rejectedBallots, [
    { memberId: 'm2', approvedProposalIds: ['EV-999'], reason: 'unknown_proposal' },
    { memberId: 'm3', approvedProposalIds: ['EV-013', 'EV-999'], reason: 'unknown_proposal' },
  ]);
  // A ballot naming an unknown proposal contributes nothing, not even its known approval.
  assert.deepEqual(result.counts, { 'EV-012': 1, 'EV-013': 0 });
  assert.equal(result.winner, 'EV-012');
  assert.equal(result.participation.participating, 1);
});

test('an ineligible member is rejected and never counted', () => {
  const result = tally({
    ballots: [ballot('m1', ['EV-012']), ballot('outsider', ['EV-013']), ballot('outsider', ['EV-012'])],
  });
  assert.deepEqual(result.rejectedBallots, [
    { memberId: 'outsider', approvedProposalIds: ['EV-013'], reason: 'ineligible_member' },
    { memberId: 'outsider', approvedProposalIds: ['EV-012'], reason: 'ineligible_member' },
  ]);
  assert.equal(result.winner, 'EV-012');
  assert.equal(result.participation.participating, 1);
});

test('each member counts at most once: later ballots become duplicate rejections', () => {
  const result = tally({
    ballots: [ballot('m1', ['EV-012']), ballot('m1', ['EV-013']), ballot('m1', [])],
  });
  assert.deepEqual(result.counts, { 'EV-012': 1, 'EV-013': 0 });
  assert.deepEqual(result.participation, {
    eligible: 4,
    participating: 1,
    abstained: 0,
    approving: 1,
    approvals: 1,
  });
  assert.deepEqual(result.rejectedBallots, [
    { memberId: 'm1', approvedProposalIds: ['EV-013'], reason: 'duplicate_ballot' },
    { memberId: 'm1', approvedProposalIds: [], reason: 'duplicate_ballot' },
  ]);
  assert.equal(result.winner, 'EV-012');
});

test('a rejected first ballot does not consume the member one ballot', () => {
  const result = tally({
    ballots: [ballot('m1', ['EV-999']), ballot('m1', ['EV-012'])],
  });
  assert.deepEqual(result.rejectedBallots, [
    { memberId: 'm1', approvedProposalIds: ['EV-999'], reason: 'unknown_proposal' },
  ]);
  assert.deepEqual(result.counts, { 'EV-012': 1, 'EV-013': 0 });
  assert.equal(result.winner, 'EV-012');
  assert.equal(result.participation.participating, 1);
});

test('malformed ballots are reported rather than thrown', () => {
  const result = tallyMvpVote({
    eligibleMemberIds: ROSTER,
    candidateProposalIds: CANDIDATES,
    maxApprovalsPerVoter: MAX,
    ballots: [
      null,
      'm1',
      { memberId: 'm1' },
      { memberId: '', approvedProposalIds: [] },
      { memberId: 'm2', approvedProposalIds: 7 },
      { memberId: 'm2', approvedProposalIds: 'EV-012' },
      { memberId: 'm2', approvedProposalIds: ['EV-012', 7] },
      { memberId: 'm2', approvedProposalIds: [''] },
    ],
  });
  assert.equal(result.outcome, 'no_winner');
  assert.deepEqual(result.rejectedBallots, [
    { memberId: null, approvedProposalIds: null, reason: 'invalid_ballot' },
    { memberId: null, approvedProposalIds: null, reason: 'invalid_ballot' },
    { memberId: 'm1', approvedProposalIds: null, reason: 'invalid_ballot' },
    { memberId: '', approvedProposalIds: [], reason: 'invalid_ballot' },
    { memberId: 'm2', approvedProposalIds: null, reason: 'invalid_ballot' },
    { memberId: 'm2', approvedProposalIds: null, reason: 'invalid_ballot' },
    { memberId: 'm2', approvedProposalIds: null, reason: 'invalid_ballot' },
    { memberId: 'm2', approvedProposalIds: [''], reason: 'invalid_ballot' },
  ]);
  assert.equal(result.participation.participating, 0);
  assert.deepEqual(result.counts, { 'EV-012': 0, 'EV-013': 0 });
});

test('rejection precedence is shape, eligibility, duplicate, limit, unknown, then voter', () => {
  // Shape is decided first: an unreadable approval list is not an eligibility problem.
  assert.deepEqual(
    tally({ ballots: [{ memberId: 'outsider', approvedProposalIds: 7 }] }).rejectedBallots,
    [{ memberId: 'outsider', approvedProposalIds: null, reason: 'invalid_ballot' }],
  );

  // Eligibility is decided before the rest of the ballot is inspected.
  assert.deepEqual(
    tally({ ballots: [{ memberId: 'outsider', approvedProposalIds: ['EV-012', 'EV-012'] }] })
      .rejectedBallots,
    [{ memberId: 'outsider', approvedProposalIds: ['EV-012', 'EV-012'], reason: 'ineligible_member' }],
  );

  // A repeated approval is reported as such even when it also breaks the limit.
  assert.deepEqual(
    tally({ maxApprovalsPerVoter: 1, ballots: [ballot('m1', ['EV-012', 'EV-012'])] })
      .rejectedBallots,
    [{ memberId: 'm1', approvedProposalIds: ['EV-012', 'EV-012'], reason: 'duplicate_approval' }],
  );

  // Too many approvals is decided before the candidate list is checked.
  assert.deepEqual(
    tally({ maxApprovalsPerVoter: 1, ballots: [ballot('m1', ['EV-012', 'EV-999'])] })
      .rejectedBallots,
    [{ memberId: 'm1', approvedProposalIds: ['EV-012', 'EV-999'], reason: 'too_many_approvals' }],
  );

  // An unknown candidate is reported as such even on a repeated member.
  const repeated = tally({ ballots: [ballot('m1', ['EV-012']), ballot('m1', ['EV-999'])] });
  assert.deepEqual(repeated.rejectedBallots, [
    { memberId: 'm1', approvedProposalIds: ['EV-999'], reason: 'unknown_proposal' },
  ]);
  assert.equal(repeated.participation.participating, 1);
});

test('the count does not depend on ballot order or approval order', () => {
  const order = [ballot('m1', ['EV-012']), ballot('m2', ['EV-013']), ballot('m3', []), ballot('m4', ['EV-012'])];
  const forward = tally({ ballots: order });
  const backward = tally({ ballots: [...order].reverse() });
  assert.deepEqual(forward.counts, backward.counts);
  assert.deepEqual(forward.participation, backward.participation);
  assert.equal(forward.winner, backward.winner);
  assert.equal(forward.outcome, backward.outcome);
  assert.deepEqual(forward.tiedProposalIds, backward.tiedProposalIds);

  const flipped = tally({
    ballots: [ballot('m1', ['EV-013', 'EV-012']), ballot('m2', ['EV-012'])],
  });
  const unflipped = tally({
    ballots: [ballot('m1', ['EV-012', 'EV-013']), ballot('m2', ['EV-012'])],
  });
  assert.deepEqual(flipped, unflipped);

  // The frozen candidate list names the same candidates in a different order.
  const reordered = tally({ candidateProposalIds: ['EV-013', 'EV-012'], ballots: order });
  assert.deepEqual(reordered.counts, forward.counts);
  assert.equal(reordered.winner, forward.winner);
});

test('arbitrary identifiers work, including a single candidate and unicode ids', () => {
  const single = tallyMvpVote({
    eligibleMemberIds: ['a', 'b'],
    candidateProposalIds: ['only-proposal'],
    maxApprovalsPerVoter: 1,
    ballots: [ballot('a', ['only-proposal']), ballot('b', [])],
  });
  assert.equal(single.outcome, 'unique_winner');
  assert.equal(single.winner, 'only-proposal');
  assert.equal(single.participation.abstained, 1);
  assert.deepEqual(single.counts, { 'only-proposal': 1 });

  const unicode = tallyMvpVote({
    eligibleMemberIds: ['成员-1', '成员-2'],
    candidateProposalIds: ['方案甲', '方案乙'],
    maxApprovalsPerVoter: 2,
    ballots: [ballot('成员-1', ['方案乙']), ballot('成员-2', ['方案乙', '方案甲'])],
  });
  assert.equal(unicode.winner, '方案乙');
  assert.deepEqual(unicode.counts, { 方案甲: 1, 方案乙: 2 });
});

test('malformed configuration throws invalid_input', () => {
  assert.throws(() => tallyMvpVote(null), (error) => {
    assert.ok(error instanceof MvpVoteTallyError);
    assert.equal(error.code, 'invalid_input');
    assert.equal(error.name, 'MvpVoteTallyError');
    return true;
  });
  assert.throws(() => tally({ eligibleMemberIds: [] }), { code: 'invalid_input' });
  assert.throws(() => tally({ eligibleMemberIds: ['m1', 'm1'] }), { code: 'invalid_input' });
  assert.throws(() => tally({ eligibleMemberIds: [''] }), { code: 'invalid_input' });
  assert.throws(() => tally({ eligibleMemberIds: 'm1' }), { code: 'invalid_input' });
  assert.throws(() => tally({ candidateProposalIds: [] }), { code: 'invalid_input' });
  assert.throws(() => tally({ candidateProposalIds: ['EV-012', 'EV-012'] }), { code: 'invalid_input' });
  assert.throws(() => tally({ candidateProposalIds: [''] }), { code: 'invalid_input' });
  assert.throws(() => tally({ candidateProposalIds: 'EV-012' }), { code: 'invalid_input' });
  for (const max of [0, -1, 1.5, '2', Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
    assert.throws(
      () => tally({ maxApprovalsPerVoter: max }),
      { code: 'invalid_input' },
      `maxApprovalsPerVoter=${String(max)}`,
    );
  }
  assert.throws(() => tally({ ballots: 'none' }), { code: 'invalid_input' });
});

test('the result is deeply frozen and the inputs are not mutated', () => {
  const eligibleMemberIds = [...ROSTER];
  const candidateProposalIds = [...CANDIDATES];
  const inputBallots = [
    ballot('m1', ['EV-012']),
    ballot('m2', ['EV-999']),
    ballot('m3', []),
    ballot('m4', []),
  ];
  const snapshot = structuredClone({ eligibleMemberIds, candidateProposalIds, inputBallots });

  const result = tallyMvpVote({
    eligibleMemberIds,
    candidateProposalIds,
    maxApprovalsPerVoter: MAX,
    ballots: inputBallots,
  });

  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.counts));
  assert.ok(Object.isFrozen(result.participation));
  assert.ok(Object.isFrozen(result.rejectedBallots));
  assert.ok(Object.isFrozen(result.rejectedBallots[0]));
  assert.ok(Object.isFrozen(result.candidateProposalIds));
  assert.ok(Object.isFrozen(result.tiedProposalIds));
  assert.ok(Object.isFrozen(result.rejectedBallots[0].approvedProposalIds));
  assert.throws(() => { result.counts['EV-012'] = 99; }, TypeError);
  assert.throws(() => { result.rejectedBallots[0].reason = 'invalid_ballot'; }, TypeError);

  assert.deepEqual({ eligibleMemberIds, candidateProposalIds, inputBallots }, snapshot);
  assert.ok(
    !Object.isFrozen(inputBallots[1].approvedProposalIds),
    'the tally must not freeze an array the caller still owns',
  );
});
