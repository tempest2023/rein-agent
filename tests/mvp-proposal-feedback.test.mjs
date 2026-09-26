import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FIELD_ORDER,
  MATERIAL_FIELD_CATEGORIES,
  MATERIAL_FIELDS,
  MINOR_FIELDS,
  MvpProposalFeedbackError,
  classifyRevision,
  decidePostVoteFeedback,
} from '../plugins/rein-operations/mvp-proposal-feedback.ts';

// Post-vote feedback tests. The core is a pure function over one snapshot, so every case shows which
// authority it consulted; no database, network or Slack call happens.

const LEAD = 'LEAD-1';
const BOARD = ['B1', 'B2'];
const DECIDED_AT = '2026-09-30T17:00:00Z';
const SUBMITTED_AT = '2026-10-01T12:00:00Z';

const FIELDS = Object.freeze({
  title: 'Intro to zero-knowledge proofs',
  summary: 'A beginner reading group.',
  agenda: 'Welcome, talk, discussion.',
  format: 'in_person',
  venue: 'Community room A',
  startAt: '2026-10-10T18:00:00-07:00',
  durationMinutes: 90,
  timeZone: 'America/Los_Angeles',
  leadMemberId: LEAD,
  personnelIds: ['CO-1'],
  runOfShow: ['doors', 'talk', 'qa'],
  expectedAttendance: 20,
  requestedAmountMinor: 25000,
  currency: 'USD',
});

/** One alternative value per field, so the same loops exercise every field. */
const CHANGES = Object.freeze({
  title: 'Intro to ZK proofs (beginner-friendly)',
  summary: 'A beginner reading group with paper discussion.',
  agenda: 'Welcome, talk, discussion, and wrap-up.',
  format: 'hybrid',
  venue: 'Community room B',
  startAt: '2026-10-11T18:00:00-07:00',
  durationMinutes: 120,
  timeZone: 'America/New_York',
  leadMemberId: 'CO-1',
  personnelIds: ['CO-1', 'CO-2'],
  runOfShow: ['doors', 'talk', 'qa', 'social'],
  expectedAttendance: 30,
  requestedAmountMinor: 40000,
  currency: 'EUR',
});

const snapshot = (overrides = {}) => ({
  proposalId: 'PR-0001',
  decision: { outcome: 'approved', decidedAt: DECIDED_AT },
  versions: [
    {
      version: 1,
      fields: { ...FIELDS },
      at: '2026-09-29T20:00:00Z',
      source: 'vote',
      changedFields: [],
      approvedBy: [],
    },
  ],
  verifiedBoardMemberIds: BOARD,
  audit: [
    { at: DECIDED_AT, action: 'comment_recorded', actorMemberId: 'B1', detail: { commentId: 'CM-0' } },
  ],
  ...overrides,
});

const revision = (overrides = {}) => ({
  revisionId: 'REV-1',
  actorMemberId: LEAD,
  at: SUBMITTED_AT,
  fields: {},
  approvals: [],
  ...overrides,
});

const request = (overrides = {}) => ({ revision: null, comments: [], ...overrides });
const patchOf = field => ({ [field]: CHANGES[field] });
const approve = (memberId, revisionId = 'REV-1') => ({ memberId, revisionId });

test('the field lists partition the field order and name every material category', () => {
  const minor = [...MINOR_FIELDS];
  const material = [...MATERIAL_FIELDS];
  assert.deepEqual([...minor, ...material].sort(), [...FIELD_ORDER].sort());
  assert.deepEqual(minor.filter(field => material.includes(field)), []);
  assert.deepEqual(Object.keys(MATERIAL_FIELD_CATEGORIES).sort(), [...material].sort());
  assert.deepEqual(Object.keys(CHANGES).sort(), [...FIELD_ORDER].sort());
  assert.deepEqual([...new Set(Object.values(MATERIAL_FIELD_CATEGORIES))].sort(), [
    'budget',
    'event_flow',
    'location',
    'personnel',
    'schedule',
  ]);
});

test('personnel lists compare as a set while the run of show keeps its order', () => {
  const setLike = classifyRevision(
    { ...FIELDS, personnelIds: ['CO-1', 'CO-2'] },
    { personnelIds: ['CO-2', 'CO-1'] },
  );
  assert.equal(setLike.classification, 'no_change');
  const ordered = classifyRevision(FIELDS, { runOfShow: ['talk', 'doors', 'qa'] });
  assert.equal(ordered.classification, 'material');
});

for (const field of MINOR_FIELDS) {
  test(`a minor change to ${field} is accepted by the Agent and becomes version 2`, () => {
    const classification = classifyRevision(FIELDS, patchOf(field));
    assert.equal(classification.classification, 'minor');
    assert.deepEqual(classification.minorFields, [field]);
    assert.deepEqual(classification.materialFields, []);

    const decision = decidePostVoteFeedback(
      snapshot(),
      request({ revision: revision({ fields: patchOf(field) }) }),
    );
    assert.equal(decision.status, 'minor_revision_effective');
    assert.equal(decision.accepted, true);
    assert.equal(decision.boardApprovalRequired, false);
    assert.deepEqual(decision.reasons, ['minor_change_accepted_by_agent']);
    assert.deepEqual(decision.approvedByMemberIds, []);
    assert.equal(decision.effectiveVersion, 2);
    assert.deepEqual(
      decision.versions.map(version => version.source),
      ['vote', 'minor_revision'],
    );
    assert.deepEqual(decision.versions[1].fields[field], CHANGES[field]);
    assert.deepEqual(decision.versions[1].approvedBy, []);
    assert.equal(decision.audit.length, 2, 'the existing audit entry is preserved');
    assert.equal(decision.audit[0].detail.commentId, 'CM-0');
    assert.deepEqual(
      [decision.audit[1].action, decision.audit[1].actorMemberId, decision.audit[1].detail.version],
      ['minor_revision_effective', LEAD, 2],
    );
    assert.equal(decision.movesMoney, false);
    assert.equal(decision.reservesFunds, false);
  });
}

for (const field of MATERIAL_FIELDS) {
  test(`a material change to ${field} needs one current verified Board approval`, () => {
    const classification = classifyRevision(FIELDS, patchOf(field));
    assert.equal(classification.classification, 'material');
    assert.deepEqual(classification.materialFields, [field]);
    assert.deepEqual(classification.minorFields, []);
    assert.equal(MATERIAL_FIELD_CATEGORIES[field].length > 0, true);

    const blocked = decidePostVoteFeedback(
      snapshot(),
      request({ revision: revision({ fields: patchOf(field) }) }),
    );
    assert.equal(blocked.status, 'material_revision_blocked');
    assert.equal(blocked.accepted, false);
    assert.equal(blocked.boardApprovalRequired, true);
    assert.equal(blocked.effectiveVersion, 1);
    assert.equal(blocked.versions.length, 1);
    assert.deepEqual(blocked.reasons, ['material_change_requires_current_verified_board_approval']);
    assert.equal(blocked.audit[blocked.audit.length - 1].action, 'material_revision_blocked');
    assert.equal(blocked.movesMoney, false);
    assert.equal(blocked.reservesFunds, false);

    const accepted = decidePostVoteFeedback(
      snapshot(),
      request({ revision: revision({ fields: patchOf(field), approvals: [approve('B1')] }) }),
    );
    assert.equal(accepted.status, 'material_revision_effective');
    assert.equal(accepted.accepted, true);
    assert.deepEqual(accepted.approvedByMemberIds, ['B1']);
    assert.equal(accepted.effectiveVersion, 2);
    assert.deepEqual(
      accepted.versions.map(version => version.source),
      ['vote', 'board_approved_revision'],
    );
    assert.deepEqual(accepted.versions[1].changedFields, [field]);
    assert.deepEqual(accepted.versions[1].approvedBy, ['B1']);
    assert.deepEqual(accepted.versions[1].fields[field], CHANGES[field]);
    assert.equal(accepted.audit[accepted.audit.length - 1].action, 'material_revision_effective');
    assert.equal(accepted.movesMoney, false);
    assert.equal(accepted.reservesFunds, false);
  });
}

test('a revision that mixes a minor field with a material field is material', () => {
  const fields = { title: CHANGES.title, venue: CHANGES.venue };
  const classification = classifyRevision(FIELDS, fields);
  assert.equal(classification.classification, 'material');
  assert.deepEqual(classification.materialFields, ['venue']);
  assert.deepEqual(classification.minorFields, ['title']);
  assert.deepEqual(classification.changedFields, ['title', 'venue']);
  const decision = decidePostVoteFeedback(snapshot(), request({ revision: revision({ fields }) }));
  assert.equal(decision.status, 'material_revision_blocked');
  assert.equal(decision.effectiveVersion, 1);
});

test('repeating the effective values changes nothing', () => {
  assert.equal(classifyRevision(FIELDS, { title: FIELDS.title }).classification, 'no_change');
  const decision = decidePostVoteFeedback(
    snapshot(),
    request({ revision: revision({ fields: { title: FIELDS.title } }) }),
  );
  assert.equal(decision.status, 'no_change');
  assert.equal(decision.accepted, false);
  assert.deepEqual(decision.reasons, ['revision_matches_effective_version']);
  assert.equal(decision.effectiveVersion, 1);
  assert.equal(decision.versions.length, 1);
});

test('comments continue after the win and never change the effective version', () => {
  const comments = [
    { commentId: 'CM-1', authorMemberId: 'B1', at: '2026-10-01T08:00:00Z', body: 'Loved it.' },
    { commentId: 'CM-2', authorMemberId: 'B2', at: '2026-10-01T08:30:00Z', body: 'Add a wrap-up.' },
  ];
  const decision = decidePostVoteFeedback(snapshot(), request({ comments }));
  assert.equal(decision.status, 'comments_only');
  assert.equal(decision.accepted, false);
  assert.deepEqual(decision.reasons, ['comments_recorded_after_decision']);
  assert.equal(decision.effectiveVersion, 1);
  assert.equal(decision.versions.length, 1);
  assert.deepEqual(decision.recordedComments, comments);
  assert.deepEqual(decision.rejectedComments, []);
  assert.deepEqual(
    decision.audit.slice(1).map(entry => [entry.action, entry.detail.commentId]),
    [
      ['comment_recorded', 'CM-1'],
      ['comment_recorded', 'CM-2'],
    ],
  );
  const empty = decidePostVoteFeedback(snapshot(), request());
  assert.equal(empty.status, 'comments_only');
  assert.deepEqual(empty.reasons, ['no_revision_submitted']);
});

test('comments before the decision, or repeated, are rejected', () => {
  const decision = decidePostVoteFeedback(
    snapshot(),
    request({
      comments: [
        { commentId: 'CM-1', authorMemberId: 'B1', at: '2026-09-30T16:00:00Z', body: 'Too early.' },
        { commentId: 'CM-2', authorMemberId: 'B1', at: '2026-10-01T08:00:00Z', body: 'Nice.' },
        { commentId: 'CM-2', authorMemberId: 'B1', at: '2026-10-01T08:06:00Z', body: 'Again.' },
      ],
    }),
  );
  assert.deepEqual(decision.rejectedComments, ['CM-1:before_decision', 'CM-2:duplicate_comment']);
  assert.deepEqual(
    decision.recordedComments.map(comment => comment.commentId),
    ['CM-2'],
  );
});

test('a revision is refused before the decision, without a win, or from someone without standing', () => {
  const fields = { title: CHANGES.title };
  const early = decidePostVoteFeedback(
    snapshot(),
    request({ revision: revision({ fields, at: '2026-09-30T10:00:00Z' }) }),
  );
  assert.deepEqual([early.status, early.reasons], ['revision_refused', ['revision_before_decision']]);

  const loser = decidePostVoteFeedback(
    snapshot({ decision: { outcome: 'no_winner', decidedAt: DECIDED_AT } }),
    request({
      revision: revision({ fields }),
      comments: [
        { commentId: 'CM-9', authorMemberId: LEAD, at: '2026-10-01T09:00:00Z', body: 'Next round.' },
      ],
    }),
  );
  assert.deepEqual([loser.status, loser.reasons], ['revision_refused', ['proposal_not_accepted']]);
  assert.deepEqual(
    loser.recordedComments.map(comment => comment.commentId),
    ['CM-9'],
    'comments are still recorded when the revision is refused',
  );
  assert.equal(loser.effectiveVersion, 1);

  const outsider = decidePostVoteFeedback(
    snapshot(),
    request({ revision: revision({ fields, actorMemberId: 'CO-2' }) }),
  );
  assert.deepEqual(outsider.reasons, ['actor_not_authorized_for_revision']);

  const boardMember = decidePostVoteFeedback(
    snapshot(),
    request({ revision: revision({ fields, actorMemberId: 'B2' }) }),
  );
  assert.equal(boardMember.status, 'minor_revision_effective');
});

test('no prompt, role label or boolean can stand in for a Board approval', () => {
  const fields = { venue: CHANGES.venue };
  assert.throws(
    () =>
      decidePostVoteFeedback(snapshot(), {
        ...request({ revision: revision({ fields }) }),
        boardApproved: true,
      }),
    error => error instanceof MvpProposalFeedbackError && error.code === 'invalid_input',
  );
  assert.throws(
    () =>
      decidePostVoteFeedback(
        snapshot(),
        request({ revision: { ...revision({ fields }), boardApproved: 'the Board agreed' } }),
      ),
    error => error instanceof MvpProposalFeedbackError && error.code === 'invalid_input',
  );

  const notBoardMember = decidePostVoteFeedback(
    snapshot(),
    request({ revision: revision({ fields, approvals: [approve('CO-2')] }) }),
  );
  assert.equal(notBoardMember.status, 'material_revision_blocked');
  assert.deepEqual(notBoardMember.approvedByMemberIds, []);
  assert.deepEqual(notBoardMember.rejectedApprovals, ['CO-2:not_current_board_member']);

  const otherRevision = decidePostVoteFeedback(
    snapshot(),
    request({ revision: revision({ fields, approvals: [approve('B1', 'REV-OTHER')] }) }),
  );
  assert.equal(otherRevision.status, 'material_revision_blocked');
  assert.deepEqual(otherRevision.rejectedApprovals, ['B1:approval_for_another_revision']);
});

test('a repeated approval counts once and two Board members both count', () => {
  const fields = { venue: CHANGES.venue };
  const repeated = decidePostVoteFeedback(
    snapshot(),
    request({ revision: revision({ fields, approvals: [approve('B1'), approve('B1')] }) }),
  );
  assert.equal(repeated.status, 'material_revision_effective');
  assert.deepEqual(repeated.approvedByMemberIds, ['B1']);
  assert.deepEqual(repeated.rejectedApprovals, ['B1:duplicate_approval']);

  const both = decidePostVoteFeedback(
    snapshot(),
    request({ revision: revision({ fields, approvals: [approve('B2'), approve('B1')] }) }),
  );
  assert.deepEqual(both.approvedByMemberIds, ['B1', 'B2']);
  assert.deepEqual(both.versions[1].approvedBy, ['B1', 'B2']);
});

test('accepted revisions stack on the effective version and preserve earlier records', () => {
  const first = decidePostVoteFeedback(
    snapshot(),
    request({ revision: revision({ fields: { summary: CHANGES.summary } }) }),
  );
  const second = decidePostVoteFeedback(
    snapshot({ versions: first.versions, audit: first.audit }),
    request({
      revision: revision({
        revisionId: 'REV-2',
        fields: { venue: CHANGES.venue },
        approvals: [approve('B1', 'REV-2')],
      }),
    }),
  );
  assert.equal(second.status, 'material_revision_effective');
  assert.equal(second.effectiveVersion, 3);
  assert.deepEqual(second.versions.map(version => version.version), [1, 2, 3]);
  assert.deepEqual(
    second.versions.map(version => version.source),
    ['vote', 'minor_revision', 'board_approved_revision'],
  );
  assert.equal(second.versions[2].fields.venue, CHANGES.venue);
  assert.equal(second.versions[2].fields.summary, CHANGES.summary);
  assert.equal(second.audit[0].detail.commentId, 'CM-0', 'earlier audit entries survive');
});

test('the decision is deterministic, frozen, and leaves the snapshot untouched', () => {
  const input = snapshot();
  const before = JSON.stringify(input);
  const argument = request({
    revision: revision({ fields: { venue: CHANGES.venue }, approvals: [approve('B1')] }),
    comments: [
      { commentId: 'CM-5', authorMemberId: 'B1', at: '2026-10-01T09:00:00Z', body: 'Go ahead.' },
    ],
  });
  const first = decidePostVoteFeedback(input, argument);
  assert.deepEqual(first, decidePostVoteFeedback(input, argument));
  assert.equal(JSON.stringify(input), before);
  assert.equal(Object.isFrozen(input.versions), false);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.versions[1].fields));
  assert.ok(Object.isFrozen(first.audit[first.audit.length - 1].detail));
  assert.throws(() => {
    first.recordedComments[0].body = 'changed';
  }, TypeError);
});

test('malformed snapshots and requests throw invalid_input', () => {
  const invalid = [
    () => decidePostVoteFeedback({ ...snapshot(), versions: [] }, request()),
    () => decidePostVoteFeedback({ ...snapshot(), verifiedBoardMemberIds: [] }, request()),
    () => decidePostVoteFeedback(snapshot({ decision: { outcome: 'maybe', decidedAt: DECIDED_AT } }), request()),
    () => decidePostVoteFeedback(snapshot(), request({ revision: revision({ fields: { attendees: 3 } }) })),
    () => decidePostVoteFeedback(snapshot(), request({ revision: revision({ fields: { title: '' } }) })),
    () => decidePostVoteFeedback(snapshot(), request({ revision: revision({ fields: { durationMinutes: 'ninety' } }) })),
    () => decidePostVoteFeedback(snapshot(), request({ revision: revision({ fields: { format: 'outdoor' } }) })),
    () => decidePostVoteFeedback(snapshot(), request({ revision: revision({ fields: { title: 'x' }, at: 'yesterday' }) })),
  ];
  for (const call of invalid) {
    assert.throws(call, error => error instanceof MvpProposalFeedbackError && error.code === 'invalid_input');
  }
});

test('the module is pure: it imports nothing at all', () => {
  const source = readFileSync(
    new URL('../plugins/rein-operations/mvp-proposal-feedback.ts', import.meta.url),
    'utf8',
  );
  assert.deepEqual([...source.matchAll(/^import .*$/gm)].map(match => match[0]), []);
  assert.equal(/require\(/.test(source), false);
});
