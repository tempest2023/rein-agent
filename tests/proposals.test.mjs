import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCompleteness,
  createProposalCore,
  detectMaterialChanges,
  findDuplicateProposal,
  routeProcessingPath,
  validateSchedule,
} from '../plugins/rein-operations/proposals.ts';

const AT = '2026-09-23T00:00:00Z';
const CONTRIBUTOR = { platform: 'discord', accountId: 'u-contributor' };
const ORDINARY = { platform: 'discord', accountId: 'u-ordinary' };
const STRANGER = { platform: 'discord', accountId: 'u-stranger' };

const baseFields = () => ({
  title: 'Campus paper discussion',
  eventType: 'reading_group',
  purpose: 'Discuss alignment papers with students',
  audience: 'Students, open to the public',
  format: 'in_person',
  schedule: { startAt: '2026-10-10T18:00:00Z', timeZone: 'America/Los_Angeles', durationMinutes: 90 },
  location: { venue: 'Room 204', venueConfirmed: true },
  capacity: { expectedAttendance: 15, registration: 'open' },
  program: { agenda: 'Two papers, 45 minutes each' },
  fees: { charged: false },
  budget: {
    requestedAmountMinor: 0,
    reimbursementExpected: false,
    hiddenCostsConfirmed: true,
    contractualCommitments: false,
  },
  risks: { notes: 'No known risks' },
  deliverables: { summary: true, photoRestrictions: 'no_photos' },
});

const fundedFields = amountMinor => ({
  ...baseFields(),
  title: 'Funded workshop',
  eventType: 'workshop',
  budget: {
    requestedAmountMinor: amountMinor,
    currency: 'USD',
    items: ['venue 15000', 'materials 3000'],
    assumptions: 'Venue quote dated 2026-09-01; materials from a public price list',
    reimbursementExpected: false,
    hiddenCostsConfirmed: false,
    contractualCommitments: false,
  },
});

function setup() {
  const core = createProposalCore();
  core.recordMember({
    memberId: 'M-100',
    displayName: 'Maya Chen',
    roles: [{ role: 'contributor' }],
    recordedBy: 'admin',
    at: AT,
  });
  core.recordMember({ memberId: 'M-200', displayName: 'Lin Wei', roles: [], recordedBy: 'admin', at: AT });
  core.recordMember({
    memberId: 'M-300',
    displayName: 'Other Contributor',
    roles: [{ role: 'contributor' }],
    recordedBy: 'admin',
    at: AT,
  });
  return core;
}

function linkedSetup() {
  const core = setup();
  core.linkIdentity({
    ...CONTRIBUTOR,
    displayName: 'Maya Chen',
    memberId: 'M-100',
    verifiedBy: 'admin',
    verifiedAt: AT,
  });
  core.linkIdentity({
    ...ORDINARY,
    displayName: 'Lin Wei',
    memberId: 'M-200',
    verifiedBy: 'admin',
    verifiedAt: AT,
  });
  return core;
}

function draftConfirmSubmit(core, account, fields, { at = AT, idempotencyKey = null } = {}) {
  const draft = core.createDraft({ account, fields, at });
  const confirm = core.confirmLeadVersion({
    proposalId: draft.proposalId,
    account,
    version: draft.version,
    at,
    statement: 'I confirm this version as lead.',
  });
  const submit = core.submitForAssessment({ proposalId: draft.proposalId, account, at, idempotencyKey });
  return { draft, confirm, submit };
}

test('identity comes from authoritative records, never from display names or platform labels', () => {
  const core = setup();

  // No link exists, even though the display name matches a real Contributor.
  assert.equal(core.snapshot().identities['discord:u-contributor'], undefined);
  assert.deepEqual(core.eligibilityFor({ ...CONTRIBUTOR, at: AT }), {
    eligible: false,
    reason: 'identity_not_linked',
    memberId: null,
  });

  // A link cannot be invented for a member that no authority recorded.
  assert.deepEqual(
    core.linkIdentity({
      ...CONTRIBUTOR,
      displayName: 'Maya Chen',
      memberId: 'M-999',
      verifiedBy: 'admin',
      verifiedAt: AT,
    }),
    { ok: false, reason: 'unknown_authoritative_member', memberId: 'M-999' },
  );

  // A platform role label is presentation only; the authoritative record has no Contributor role.
  const linked = core.linkIdentity({
    ...ORDINARY,
    displayName: 'Maya Chen',
    platformRoleLabel: 'Contributor',
    memberId: 'M-200',
    verifiedBy: 'admin',
    verifiedAt: AT,
  });
  assert.equal(linked.ok, true);
  assert.equal(linked.identity.platformRoleLabel, 'Contributor');
  assert.equal(core.eligibilityFor({ ...ORDINARY, at: AT }).reason, 'no_active_contributor_role');

  // A verified link to a member with an active Contributor role is eligible.
  core.linkIdentity({
    ...CONTRIBUTOR,
    displayName: 'Maya Chen',
    memberId: 'M-100',
    verifiedBy: 'admin',
    verifiedAt: AT,
  });
  assert.deepEqual(core.eligibilityFor({ ...CONTRIBUTOR, at: AT }), {
    eligible: true,
    reason: 'eligible_contributor',
    memberId: 'M-100',
  });
});

test('an account cannot be relinked, and extra accounts share one governance identity', () => {
  const core = linkedSetup();

  assert.deepEqual(
    core.linkIdentity({
      ...CONTRIBUTOR,
      displayName: 'Impostor',
      memberId: 'M-200',
      verifiedBy: 'admin',
      verifiedAt: AT,
    }),
    { ok: false, reason: 'account_already_linked', existingMemberId: 'M-100' },
  );

  const again = core.linkIdentity({
    ...CONTRIBUTOR,
    displayName: 'Maya Chen',
    memberId: 'M-100',
    verifiedBy: 'admin',
    verifiedAt: AT,
  });
  assert.equal(again.unchanged, true);

  const second = core.linkIdentity({
    platform: 'discord',
    accountId: 'u-contributor-2',
    displayName: 'maya',
    memberId: 'M-100',
    verifiedBy: 'admin',
    verifiedAt: AT,
  });
  assert.equal(second.additionalAccount, true);
  assert.deepEqual(core.memberAccounts('M-100'), [
    { platform: 'discord', accountId: 'u-contributor', status: 'verified' },
    { platform: 'discord', accountId: 'u-contributor-2', status: 'verified' },
  ]);
  assert.equal(core.eligibilityFor({ platform: 'discord', accountId: 'u-contributor-2', at: AT }).memberId, 'M-100');
});

test('eligibility follows revocation, expiry and member status', () => {
  const core = linkedSetup();

  core.revokeIdentity({ ...CONTRIBUTOR, revokedBy: 'admin', at: AT, reason: 'account change' });
  assert.equal(core.eligibilityFor({ ...CONTRIBUTOR, at: AT }).reason, 'identity_link_revoked');

  const expired = setup();
  expired.recordMember({
    memberId: 'M-100',
    displayName: 'Maya Chen',
    roles: [{ role: 'contributor', expiresAt: '2026-09-01T00:00:00Z' }],
    recordedBy: 'admin',
    at: AT,
  });
  expired.linkIdentity({ ...CONTRIBUTOR, memberId: 'M-100', verifiedBy: 'admin', verifiedAt: AT });
  assert.equal(expired.eligibilityFor({ ...CONTRIBUTOR, at: AT }).reason, 'contributor_role_expired');

  const revoked = linkedSetup();
  revoked.revokeMemberRole({ memberId: 'M-100', role: 'contributor', revokedBy: 'admin', at: AT });
  assert.equal(revoked.eligibilityFor({ ...CONTRIBUTOR, at: AT }).reason, 'no_active_contributor_role');

  const suspended = linkedSetup();
  suspended.recordMember({
    memberId: 'M-100',
    displayName: 'Maya Chen',
    status: 'suspended',
    roles: [{ role: 'contributor' }],
    recordedBy: 'admin',
    at: AT,
  });
  assert.equal(suspended.eligibilityFor({ ...CONTRIBUTOR, at: AT }).reason, 'member_status_suspended');
});

test('an unlinked member can draft and revise but cannot confirm or lead (AC01, US02)', () => {
  const core = setup();
  const draft = core.createDraft({ account: ORDINARY, fields: baseFields(), at: AT });
  assert.equal(draft.ok, true);
  assert.equal(draft.state, 'draft');

  const revised = core.reviseDraft({
    proposalId: draft.proposalId,
    account: ORDINARY,
    patch: { capacity: { expectedAttendance: 20 } },
    at: AT,
  });
  assert.equal(revised.version, 2);
  assert.equal(revised.state, 'draft');

  const confirm = core.confirmLeadVersion({
    proposalId: draft.proposalId,
    account: ORDINARY,
    version: 2,
    at: AT,
    statement: 'I confirm.',
  });
  assert.equal(confirm.ok, false);
  assert.equal(confirm.reason, 'identity_not_linked');

  const submit = core.submitForAssessment({ proposalId: draft.proposalId, account: ORDINARY, at: AT });
  assert.equal(submit.ok, false);
  assert.equal(submit.reason, 'unconfirmed_version');

  const state = core.snapshot().proposals[draft.proposalId];
  assert.equal(state.leadMemberId, null);
  assert.equal(state.processingPath, null);
});

test('lead confirmation is version-bound, explicit and single-lead (R05)', () => {
  const core = linkedSetup();
  const draft = core.createDraft({ account: ORDINARY, fields: baseFields(), at: AT });

  assert.equal(
    core.confirmLeadVersion({ proposalId: draft.proposalId, account: CONTRIBUTOR, version: 1, at: AT, statement: '   ' }).reason,
    'explicit_confirmation_statement_required',
  );
  assert.equal(
    core.confirmLeadVersion({ proposalId: draft.proposalId, account: CONTRIBUTOR, version: 2, at: AT, statement: 'ok' }).reason,
    'stale_version',
  );

  const confirmed = core.confirmLeadVersion({
    proposalId: draft.proposalId,
    account: CONTRIBUTOR,
    version: 1,
    at: AT,
    statement: 'I confirm this version as the lead.',
  });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.leadMemberId, 'M-100');
  assert.equal(core.snapshot().proposals[draft.proposalId].confirmedVersion, 1);

  const repeat = core.confirmLeadVersion({
    proposalId: draft.proposalId,
    account: CONTRIBUTOR,
    version: 1,
    at: AT,
    statement: 'I confirm this version as the lead.',
  });
  assert.equal(repeat.unchanged, true);
  assert.equal(core.snapshot().proposals[draft.proposalId].confirmations.length, 1);

  const other = core.confirmLeadVersion({
    proposalId: draft.proposalId,
    account: { platform: 'discord', accountId: 'u-contributor-3' },
    version: 1,
    at: AT,
    statement: 'I will lead instead.',
  });
  assert.equal(other.reason, 'identity_not_linked');

  core.linkIdentity({
    platform: 'discord',
    accountId: 'u-contributor-3',
    memberId: 'M-300',
    verifiedBy: 'admin',
    verifiedAt: AT,
  });
  assert.equal(
    core.confirmLeadVersion({
      proposalId: draft.proposalId,
      account: { platform: 'discord', accountId: 'u-contributor-3' },
      version: 1,
      at: AT,
      statement: 'I will lead instead.',
    }).reason,
    'lead_conflict',
  );
});

test('editing a confirmed version forces re-confirmation, and material changes need acknowledgement', () => {
  const core = linkedSetup();
  const draft = core.createDraft({ account: ORDINARY, fields: baseFields(), at: AT });
  core.confirmLeadVersion({
    proposalId: draft.proposalId,
    account: CONTRIBUTOR,
    version: 1,
    at: AT,
    statement: 'Confirmed.',
  });

  const revised = core.reviseDraft({
    proposalId: draft.proposalId,
    account: CONTRIBUTOR,
    patch: { budget: { requestedAmountMinor: 2500, currency: 'USD', items: ['printing'], assumptions: 'shop quote' } },
    at: AT,
  });
  assert.equal(revised.state, 'needs_reconfirmation');
  assert.equal(revised.reconfirmationRequired, true);
  assert.deepEqual(revised.materialChanges, ['budget.requestedAmountMinor', 'budget.currency']);
  assert.equal(core.snapshot().proposals[draft.proposalId].confirmedVersion, null);

  const blocked = core.confirmLeadVersion({
    proposalId: draft.proposalId,
    account: CONTRIBUTOR,
    version: 2,
    at: AT,
    statement: 'Confirmed again.',
  });
  assert.equal(blocked.reason, 'material_changes_unacknowledged');
  assert.deepEqual(blocked.materialChanges, ['budget.requestedAmountMinor', 'budget.currency']);

  const accepted = core.confirmLeadVersion({
    proposalId: draft.proposalId,
    account: CONTRIBUTOR,
    version: 2,
    at: AT,
    statement: 'I confirm the higher amount.',
    acknowledgedMaterialChanges: true,
  });
  assert.equal(accepted.state, 'confirmed');
  const confirmation = core.snapshot().proposals[draft.proposalId].confirmations.at(-1);
  assert.equal(confirmation.version, 2);
  assert.equal(confirmation.acknowledgedMaterialChanges, true);

  const wording = core.reviseDraft({
    proposalId: draft.proposalId,
    account: CONTRIBUTOR,
    patch: { program: { agenda: 'Three papers' } },
    at: AT,
  });
  assert.equal(wording.state, 'needs_reconfirmation');
  assert.deepEqual(wording.materialChanges, []);
});

test('completeness names the exact missing information and zero-budget confirmations (R04)', () => {
  const empty = checkCompleteness({});
  assert.equal(empty.complete, false);
  const missingPaths = empty.problems.filter(problem => problem.code === 'missing_field').map(problem => problem.path);
  for (const path of ['title', 'schedule.startAt', 'budget.requestedAmountMinor']) assert.ok(missingPaths.includes(path));

  const noVenue = checkCompleteness({ ...baseFields(), location: { venueConfirmed: true } });
  assert.ok(noVenue.problems.some(problem => problem.code === 'missing_field' && problem.path === 'location.venue'));

  const unconfirmed = checkCompleteness({
    ...baseFields(),
    budget: { requestedAmountMinor: 0 },
  });
  const codes = unconfirmed.problems.map(problem => problem.code);
  assert.ok(codes.includes('zero_budget_reimbursement_unconfirmed'));
  assert.ok(codes.includes('zero_budget_hidden_costs_unconfirmed'));
  assert.ok(codes.includes('zero_budget_commitments_unconfirmed'));

  const funded = checkCompleteness({
    ...baseFields(),
    budget: { requestedAmountMinor: 500, reimbursementExpected: false },
  });
  const fundedPaths = funded.problems.map(problem => problem.path);
  assert.ok(fundedPaths.includes('budget.currency'));
  assert.ok(fundedPaths.includes('budget.items'));
  assert.ok(fundedPaths.includes('budget.assumptions'));

  assert.ok(
    checkCompleteness({ ...baseFields(), budget: { requestedAmountMinor: -1 } }).problems.some(
      problem => problem.code === 'invalid_requested_amount',
    ),
  );
  assert.ok(
    checkCompleteness({ ...baseFields(), fees: { charged: true } }).problems.some(
      problem => problem.path === 'fees.amountMinor',
    ),
  );
  assert.equal(checkCompleteness(baseFields()).complete, true);
});

test('date and time-zone checks keep stale or ambiguous proposals out of the queue (R05)', () => {
  assert.equal(validateSchedule(baseFields(), { now: AT }).valid, true);

  const past = validateSchedule({ ...baseFields(), schedule: { startAt: '2026-09-01T18:00:00Z', timeZone: 'UTC', durationMinutes: 60 } }, { now: AT });
  assert.deepEqual(past.problems.map(problem => problem.code), ['event_date_passed']);

  const badZone = validateSchedule({ ...baseFields(), schedule: { startAt: '2026-10-10T18:00:00Z', timeZone: 'Mars/Base', durationMinutes: 60 } }, { now: AT });
  assert.deepEqual(badZone.problems.map(problem => problem.code), ['invalid_timezone']);

  const noZone = validateSchedule({ ...baseFields(), schedule: { startAt: '2026-10-10T18:00:00Z', durationMinutes: 60 } }, { now: AT });
  assert.deepEqual(noZone.problems.map(problem => problem.code), ['missing_timezone']);

  const noDuration = validateSchedule({ ...baseFields(), schedule: { startAt: '2026-10-10T18:00:00Z', timeZone: 'UTC' } }, { now: AT });
  assert.deepEqual(noDuration.problems.map(problem => problem.code), ['invalid_duration']);
});

test('a zero-budget proposal is not approved while no policy is authorized (AC03)', () => {
  const core = linkedSetup();
  const { submit } = draftConfirmSubmit(core, CONTRIBUTOR, baseFields());
  assert.equal(submit.status, 'needs_exception');
  assert.equal(submit.reason, 'zero_budget_policy_not_authorized');
  assert.equal(submit.approved, false);
  assert.equal(submit.queued, false);
  assert.equal(submit.proposal.state, 'needs_exception');
  assert.equal(submit.proposal.approvalBasis, null);
  assert.equal(submit.blockers[0].code, 'zero_budget_policy_not_authorized');
});

test('the zero-budget fast track runs only inside an explicitly authorized scope (R07)', () => {
  const core = linkedSetup();
  core.authorizeZeroBudgetPolicy({
    policyVersion: 'P-2026-01',
    authorizedBy: 'board-chair',
    effectiveAt: AT,
    allowedEventTypes: ['reading_group'],
    maxExpectedAttendance: 30,
  });

  const approved = draftConfirmSubmit(core, CONTRIBUTOR, baseFields());
  assert.equal(approved.submit.status, 'fast_track_eligible');
  assert.equal(approved.submit.approved, true);
  assert.equal(approved.submit.queued, false);
  assert.equal(approved.submit.proposal.state, 'approved');
  assert.equal(approved.submit.approvalBasis.kind, 'zero_budget_fast_track');
  assert.equal(approved.submit.approvalBasis.policyVersion, 'P-2026-01');

  const wrongType = draftConfirmSubmit(core, CONTRIBUTOR, { ...baseFields(), title: 'Campus workshop', eventType: 'workshop' });
  assert.equal(wrongType.submit.reason, 'event_type_outside_authorized_scope');

  const unconfirmedVenue = draftConfirmSubmit(core, CONTRIBUTOR, {
    ...baseFields(),
    title: 'Outdoor reading group',
    location: { venue: 'City park', venueConfirmed: false },
  });
  assert.equal(unconfirmedVenue.submit.reason, 'venue_not_confirmed');

  const tooBig = draftConfirmSubmit(core, CONTRIBUTOR, {
    ...baseFields(),
    title: 'Large reading group',
    capacity: { expectedAttendance: 120, registration: 'open' },
  });
  assert.equal(tooBig.submit.reason, 'scale_exceeds_authorized_limit');

  const flagged = draftConfirmSubmit(core, CONTRIBUTOR, {
    ...baseFields(),
    title: 'Partner reading group',
    exceptions: ['partner_endorsement_unconfirmed', 'conduct_concern'],
  });
  assert.equal(flagged.submit.reason, 'unresolved_exceptions');
  assert.deepEqual(flagged.submit.blockers.map(blocker => blocker.code), [
    'partner_endorsement_unconfirmed',
    'conduct_concern',
  ]);

  core.revokeZeroBudgetPolicy({ revokedBy: 'board-chair', at: AT, reason: 'scope review' });
  const afterRevoke = draftConfirmSubmit(core, CONTRIBUTOR, { ...baseFields(), title: 'Late reading group' });
  assert.equal(afterRevoke.submit.reason, 'zero_budget_policy_not_authorized');
});

test('every funding request enters Board selection and is never approved by the Agent (AC04)', () => {
  const core = linkedSetup();

  const tiny = draftConfirmSubmit(core, CONTRIBUTOR, fundedFields(1));
  assert.equal(tiny.submit.status, 'governance');
  assert.equal(tiny.submit.queued, true);
  assert.equal(tiny.submit.approved, false);
  assert.equal(tiny.submit.proposal.state, 'awaiting_governance');
  assert.equal(tiny.submit.proposal.approvalBasis, null);

  const modest = draftConfirmSubmit(core, CONTRIBUTOR, { ...fundedFields(18000), title: 'Second funded workshop' });
  assert.equal(modest.submit.status, 'governance');

  // An expected reimbursement or contract without a stated amount is incomplete rather than
  // zero-budget: it can neither be fast-tracked nor take a voting slot (R08).
  const reimbursement = draftConfirmSubmit(core, CONTRIBUTOR, {
    ...baseFields(),
    title: 'Reimbursed reading group',
    budget: { requestedAmountMinor: 0, reimbursementExpected: true, hiddenCostsConfirmed: true, contractualCommitments: false },
  });
  assert.equal(reimbursement.submit.status, 'needs_information');
  assert.equal(reimbursement.submit.approved, false);
  assert.equal(reimbursement.submit.queued, false);
  assert.deepEqual(reimbursement.submit.blockers.map(blocker => blocker.code), ['funding_request_requires_amount']);

  const contract = draftConfirmSubmit(core, CONTRIBUTOR, {
    ...baseFields(),
    title: 'Contracted reading group',
    budget: { requestedAmountMinor: 0, reimbursementExpected: false, hiddenCostsConfirmed: true, contractualCommitments: true },
  });
  assert.equal(contract.submit.status, 'needs_information');
  assert.deepEqual(contract.submit.blockers.map(blocker => blocker.code), ['funding_request_requires_amount']);

  // A queued version is frozen: it cannot be silently re-scoped or re-confirmed.
  assert.equal(
    core.reviseDraft({ proposalId: tiny.draft.proposalId, account: CONTRIBUTOR, patch: { title: 'Changed' }, at: AT }).reason,
    'frozen_for_governance',
  );
  assert.equal(
    core.confirmLeadVersion({ proposalId: tiny.draft.proposalId, account: CONTRIBUTOR, version: 1, at: AT, statement: 'again' }).reason,
    'version_frozen',
  );
});

test('duplicate submissions surface the existing record instead of queueing twice (R05)', () => {
  const core = linkedSetup();
  const first = draftConfirmSubmit(core, CONTRIBUTOR, fundedFields(18000));
  const second = draftConfirmSubmit(core, CONTRIBUTOR, { ...fundedFields(18000), title: '  FUNDED   workshop!! ' });

  assert.equal(second.submit.status, 'duplicate');
  assert.equal(second.submit.duplicateOf, first.draft.proposalId);
  assert.equal(second.submit.queued, false);
  assert.equal(second.submit.proposal.state, 'duplicate');

  const queued = Object.values(core.snapshot().proposals).filter(proposal => proposal.state === 'awaiting_governance');
  assert.equal(queued.length, 1);

  // A different event date is a different proposal, not a duplicate.
  const other = draftConfirmSubmit(core, CONTRIBUTOR, {
    ...fundedFields(18000),
    title: 'Funded workshop',
    schedule: { startAt: '2026-11-14T18:00:00Z', timeZone: 'America/Los_Angeles', durationMinutes: 90 },
  });
  assert.equal(other.submit.status, 'governance');
  assert.equal(findDuplicateProposal(core.state, baseFields()), null);
});

test('retries and copies do not duplicate records (US15, US16)', () => {
  const core = linkedSetup();
  const first = core.createDraft({ account: ORDINARY, fields: baseFields(), at: AT, idempotencyKey: 'msg-1' });
  const retry = core.createDraft({ account: ORDINARY, fields: baseFields(), at: AT, idempotencyKey: 'msg-1' });
  assert.equal(retry.proposalId, first.proposalId);
  assert.equal(core.state.counters.proposal, 1);
  assert.throws(
    () => core.reviseDraft({ proposalId: first.proposalId, account: ORDINARY, patch: {}, at: AT, idempotencyKey: 'msg-1' }),
    /already used for create_draft/,
  );

  const { submit } = draftConfirmSubmit(core, CONTRIBUTOR, fundedFields(18000));
  const replay = core.submitForAssessment({
    proposalId: submit.proposalId,
    account: CONTRIBUTOR,
    at: AT,
    idempotencyKey: 'submit-1',
  });
  const replayAgain = core.submitForAssessment({
    proposalId: submit.proposalId,
    account: CONTRIBUTOR,
    at: AT,
    idempotencyKey: 'submit-1',
  });
  assert.deepEqual(replayAgain, replay);
  assert.equal(replay.status, 'governance');

  const copy = core.copyProposal({ proposalId: submit.proposalId, account: CONTRIBUTOR, at: AT });
  assert.equal(copy.state, 'draft');
  assert.equal(copy.copiedFrom, submit.proposalId);
  const copied = core.snapshot().proposals[copy.proposalId];
  assert.equal(copied.confirmedVersion, null);
  assert.equal(copied.approvalBasis, null);
  assert.equal(copied.leadMemberId, null);
});

test('approved and withdrawn proposals are protected from silent change', () => {
  const core = linkedSetup();
  core.authorizeZeroBudgetPolicy({
    policyVersion: 'P-2026-01',
    authorizedBy: 'board-chair',
    effectiveAt: AT,
    allowedEventTypes: ['reading_group'],
  });
  const approved = draftConfirmSubmit(core, CONTRIBUTOR, baseFields());
  assert.equal(approved.submit.approved, true);
  assert.equal(
    core.reviseDraft({ proposalId: approved.draft.proposalId, account: CONTRIBUTOR, patch: { title: 'sneaky' }, at: AT }).reason,
    'approved_version_is_immutable',
  );

  const withdrawn = draftConfirmSubmit(core, CONTRIBUTOR, { ...baseFields(), title: 'Withdrawn reading group' });
  assert.equal(
    core.withdrawProposal({ proposalId: withdrawn.draft.proposalId, account: STRANGER, at: AT }).reason,
    'not_owner_or_lead',
  );
  assert.equal(core.withdrawProposal({ proposalId: withdrawn.draft.proposalId, account: CONTRIBUTOR, at: AT }).state, 'withdrawn');
  assert.equal(
    core.submitForAssessment({ proposalId: withdrawn.draft.proposalId, account: CONTRIBUTOR, at: AT }).reason,
    'proposal_withdrawn',
  );
});

test('hold and resume re-check validity instead of rejecting a proposal permanently (R05)', () => {
  const core = linkedSetup();
  const draft = core.createDraft({ account: ORDINARY, fields: baseFields(), at: AT });
  core.confirmLeadVersion({ proposalId: draft.proposalId, account: CONTRIBUTOR, version: 1, at: AT, statement: 'Confirmed.' });

  assert.equal(core.holdProposal({ proposalId: draft.proposalId, account: CONTRIBUTOR, at: AT }).state, 'on_hold');
  const resumed = core.resumeProposal({ proposalId: draft.proposalId, at: '2026-10-20T00:00:00Z' });
  assert.equal(resumed.state, 'needs_information');
  assert.deepEqual(resumed.scheduleProblems.map(problem => problem.code), ['event_date_passed']);
  assert.equal(core.resumeProposal({ proposalId: draft.proposalId, at: AT }).reason, 'not_on_hold');
});

test('routing is a pure decision over completeness, schedule and policy', () => {
  const fields = baseFields();
  const completeness = checkCompleteness(fields);
  const schedule = validateSchedule(fields, { now: AT });
  assert.equal(routeProcessingPath({ fields, completeness, schedule }).path, 'needs_exception');
  assert.equal(
    routeProcessingPath({ fields: fundedFields(500), completeness: checkCompleteness(fundedFields(500)), schedule }).path,
    'governance',
  );
  assert.equal(
    routeProcessingPath({
      fields,
      completeness,
      schedule,
      policy: { active: true, policyVersion: 'P', authorizedBy: 'b', effectiveAt: AT, allowedEventTypes: ['reading_group'] },
    }).path,
    'fast_track_eligible',
  );
  // Routing treats any funding signal as a Board matter even before the amount is known.
  assert.equal(
    routeProcessingPath({
      fields: {
        ...baseFields(),
        budget: { requestedAmountMinor: 0, reimbursementExpected: true, hiddenCostsConfirmed: true, contractualCommitments: false },
      },
      completeness: { complete: true, problems: [] },
      schedule,
      policy: { active: true, policyVersion: 'P', authorizedBy: 'b', effectiveAt: AT, allowedEventTypes: ['reading_group'] },
    }).path,
    'governance',
  );
  assert.deepEqual(detectMaterialChanges(baseFields(), { capacity: { expectedAttendance: 20 } }), ['capacity.expectedAttendance']);
  assert.deepEqual(detectMaterialChanges(baseFields(), { risks: { notes: 'updated' } }), []);
  assert.equal(coreAudit(), 1);
});

function coreAudit() {
  const core = linkedSetup();
  draftConfirmSubmit(core, CONTRIBUTOR, baseFields());
  const actions = core.state.audit.map(entry => entry.action);
  for (const action of ['record_member', 'link_identity', 'create_draft', 'confirm_lead_version', 'submit_for_assessment']) {
    assert.ok(actions.includes(action), `audit is missing ${action}`);
  }
  return 1;
}
