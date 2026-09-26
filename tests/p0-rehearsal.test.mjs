// P0 cross-module rehearsals (PRD AC20; scenarios US02, US03, US04, US05, US06, US07, US15).
//
// These two rehearsals drive the real Rein modules end to end — the proposal core, the governance
// engine, the activity operations core and the local rehearsal ledger — instead of restating their
// unit tests. Each step names the module it crosses so the trace stays readable.
//
// They are deliberately honest about the missing production adapters. No chat platform, website or
// payment provider is connected, so every external effect stops as a pending outbox intent that a
// human must reconcile. The rehearsal never asserts that an external action succeeded when only an
// intent exists; those boundaries are recorded as assertions rather than prose.
//
// Run: node --test tests/p0-rehearsal.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLedger } from '../plugins/rein-operations/ledger.ts';
import { createProposalCore, createState } from '../plugins/rein-operations/proposals.ts';
import { createRound, castBallot, tallyProposal, tallyRound } from '../plugins/rein-operations/governance.ts';
import {
  createOperationsCore,
  createCapabilityAuthorizer,
  createLedgerStore,
  recommendedChecklist,
  CAPABILITIES,
  OperationsError,
} from '../plugins/rein-operations/activities.ts';
import { resolveTrustedRequester } from '../plugins/rein-operations/request-context.ts';

// The P0 chat platform is still undecided (docs/decisions.md). The rehearsal uses a synthetic label
// so it cannot be mistaken for an adopted platform choice.
const PLATFORM = 'rehearsal-chat';
const CHANNEL = 'rehearsal-ops-channel';

const T = {
  records: '2026-09-24T08:00:00Z',
  draft: '2026-09-24T09:00:00Z',
  confirm: '2026-09-24T09:30:00Z',
  submit: '2026-09-24T10:00:00Z',
  roundOpens: '2026-09-25T00:00:00Z',
  roundCloses: '2026-09-28T00:00:00Z',
  approve: '2026-09-29T09:00:00Z',
  prepare: '2026-11-06T16:00:00Z',
  held: '2026-11-07T21:00:00Z',
  review: '2026-11-10T09:00:00Z',
  settle: '2026-11-12T09:00:00Z',
  publish: '2026-11-13T09:00:00Z',
};

const ADMIN = { id: 'ops-admin', kind: 'human' };
const AGENT = { id: 'rein-agent', kind: 'agent' };
const FINANCE = { id: 'finance-1', kind: 'human' };

const grantAll = actor => CAPABILITIES.map(capability => ({ actorId: actor.id, capability }));

const ZERO_BUDGET_FIELDS = {
  title: 'Campus paper discussion: interpretability',
  eventType: 'paper_discussion',
  purpose: 'Read and discuss one interpretability paper together',
  audience: 'Students and local members',
  format: 'in_person',
  location: { venue: 'University library room 204', venueConfirmed: true },
  schedule: { startAt: '2026-10-20T18:00:00Z', timeZone: 'America/Los_Angeles', durationMinutes: 90 },
  capacity: { expectedAttendance: 15, registration: 'open_chat' },
  program: { agenda: ['welcome', 'paper walkthrough', 'discussion'] },
  risks: { notes: 'No photography without participant consent' },
  fees: { charged: false },
  budget: {
    requestedAmountMinor: 0,
    reimbursementExpected: false,
    hiddenCostsConfirmed: true,
    contractualCommitments: false,
  },
};

const FUNDED_FIELDS = {
  title: 'Hands-on agent safety workshop',
  eventType: 'workshop',
  purpose: 'Practical workshop on evaluating small agent systems',
  audience: 'Contributors and local students',
  format: 'in_person',
  location: { venue: 'Community center room B', venueConfirmed: true },
  schedule: { startAt: '2026-11-07T17:00:00Z', timeZone: 'America/Los_Angeles', durationMinutes: 180 },
  capacity: { expectedAttendance: 25, registration: 'open_chat' },
  program: { agenda: ['setup', 'guided exercise', 'group review'] },
  risks: { notes: 'Two facilitators required; no participant photos without consent' },
  fees: { charged: false },
  budget: {
    requestedAmountMinor: 18000,
    currency: 'USD',
    items: [
      { label: 'venue', amountMinor: 8000 },
      { label: 'printed materials', amountMinor: 6000 },
      { label: 'refreshments', amountMinor: 4000 },
    ],
    assumptions: 'Community-center quote plus local print-shop pricing',
    reimbursementExpected: false,
    contractualCommitments: false,
    hiddenCostsConfirmed: true,
  },
};

function activityHarness({ directory, grants, verifyContributor }) {
  const ledger = createLedger(join(directory, 'rehearsal.json'));
  const store = createLedgerStore(ledger, { key: 'p0-rehearsal', actor: 'rehearsal-runner' });
  let clock = T.records;
  const open = () =>
    createOperationsCore({
      now: () => clock,
      authorize: createCapabilityAuthorizer(grants),
      verifyContributor,
      store,
    });
  return {
    core: open(),
    at: () => clock,
    setClock: value => {
      clock = value;
    },
    restart: open,
  };
}

test('AC20 rehearsal A: zero-budget paper discussion from identity link to accepted outcome', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rein-p0-zero-budget-'));
  try {
    // ---- proposals core: authoritative records and verified identity links
    const proposals = createProposalCore(createState());
    proposals.recordMember({
      memberId: 'M-101',
      displayName: 'Maya',
      roles: [{ role: 'contributor', status: 'active' }],
      recordedBy: 'registrar-1',
      at: T.records,
    });
    proposals.recordMember({
      memberId: 'M-102',
      displayName: 'Lin',
      roles: [],
      recordedBy: 'registrar-1',
      at: T.records,
    });
    proposals.linkIdentity({
      platform: PLATFORM,
      accountId: 'chat-maya',
      memberId: 'M-101',
      verifiedBy: 'registrar-1',
      verifiedAt: T.records,
    });
    proposals.linkIdentity({
      platform: PLATFORM,
      accountId: 'chat-lin',
      memberId: 'M-102',
      verifiedBy: 'registrar-1',
      verifiedAt: T.records,
    });

    // ---- request-context: the actor comes from the host-supplied channel, not a tool argument
    const context = { messageChannel: PLATFORM, requesterSenderId: 'chat-maya', nativeChannelId: CHANNEL };
    const scope = {
      platform: PLATFORM,
      allowedNativeChannelIds: [CHANNEL],
      proposalState: proposals.state,
      at: T.draft,
    };
    assert.throws(
      () => resolveTrustedRequester(context, { ...scope, allowedNativeChannelIds: [] }),
      error => error.code === 'platform_scope_not_configured',
      'an unconfigured platform scope must fail closed',
    );
    const maya = resolveTrustedRequester(context, scope);
    assert.equal(maya.accountId, 'chat-maya');
    assert.equal(maya.memberId, 'M-101');
    assert.equal(maya.contributorEligible, true);

    const lin = resolveTrustedRequester({ ...context, requesterSenderId: 'chat-lin' }, scope);
    assert.equal(lin.memberId, 'M-102');
    assert.equal(lin.contributorEligible, false);
    assert.equal(lin.contributorReason, 'no_active_contributor_role');

    // ---- proposals core: US02 — an unlinked member may draft, but cannot confirm as lead
    const unlinked = { platform: PLATFORM, accountId: 'chat-visitor' };
    const visitorDraft = proposals.createDraft({
      account: unlinked,
      fields: { title: 'Idea from an unlinked member' },
      at: T.draft,
    });
    assert.equal(visitorDraft.state, 'draft');
    const unlinkedConfirm = proposals.confirmLeadVersion({
      proposalId: visitorDraft.proposalId,
      account: unlinked,
      version: visitorDraft.version,
      at: T.draft,
      statement: 'I confirm this draft',
    });
    assert.equal(unlinkedConfirm.ok, false);
    assert.equal(unlinkedConfirm.reason, 'identity_not_linked');

    const mayaAccount = { platform: PLATFORM, accountId: 'chat-maya' };

    // ---- proposals core: US15 — a repeated chat message does not create a second proposal
    const first = proposals.createDraft({
      account: mayaAccount,
      fields: ZERO_BUDGET_FIELDS,
      at: T.draft,
      idempotencyKey: 'chat-message-1',
    });
    const beforeReplay = proposals.state.counters.proposal;
    const replay = proposals.createDraft({
      account: mayaAccount,
      fields: ZERO_BUDGET_FIELDS,
      at: T.draft,
      idempotencyKey: 'chat-message-1',
    });
    assert.equal(replay.proposalId, first.proposalId);
    assert.equal(proposals.state.counters.proposal, beforeReplay, 'the replay created nothing');

    // ---- proposals core: R07 — an unconfirmed version is never routed, policy or not
    const beforePolicy = proposals.submitForAssessment({
      proposalId: first.proposalId,
      account: mayaAccount,
      at: T.submit,
    });
    assert.equal(beforePolicy.ok, false);
    assert.equal(beforePolicy.reason, 'unconfirmed_version', 'an unconfirmed version is never routed');

    proposals.authorizeZeroBudgetPolicy({
      policyVersion: 'zbp-2026-09-24',
      authorizedBy: 'board-chair',
      effectiveAt: T.records,
      allowedEventTypes: ['paper_discussion'],
      requireVenueConfirmed: true,
      maxExpectedAttendance: 30,
    });

    const confirmed = proposals.confirmLeadVersion({
      proposalId: first.proposalId,
      account: mayaAccount,
      version: first.version,
      at: T.confirm,
      statement: 'I confirm this version as submitted',
    });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.leadMemberId, 'M-101');

    const submitted = proposals.submitForAssessment({
      proposalId: first.proposalId,
      account: mayaAccount,
      at: T.submit,
      idempotencyKey: 'chat-message-2',
    });
    assert.equal(submitted.status, 'fast_track_eligible');
    assert.equal(submitted.approved, true);
    assert.equal(submitted.proposal.state, 'approved');
    assert.equal(submitted.approvalBasis.kind, 'zero_budget_fast_track');
    assert.equal(submitted.approvalBasis.policyVersion, 'zbp-2026-09-24');
    assert.equal(submitted.approvalBasis.authorizedBy, 'board-chair');

    // ---- proposals core: R08 — a zero-budget claim that expects later money is not zero-budget
    const expectsReimbursement = proposals.createDraft({
      account: mayaAccount,
      fields: {
        ...ZERO_BUDGET_FIELDS,
        title: 'Campus paper discussion: alignment',
        schedule: { ...ZERO_BUDGET_FIELDS.schedule, startAt: '2026-10-22T18:00:00Z' },
        budget: { ...ZERO_BUDGET_FIELDS.budget, reimbursementExpected: true },
      },
      at: T.draft,
    });
    proposals.confirmLeadVersion({
      proposalId: expectsReimbursement.proposalId,
      account: mayaAccount,
      version: expectsReimbursement.version,
      at: T.confirm,
      statement: 'I confirm this version',
    });
    const reimbursementSubmit = proposals.submitForAssessment({
      proposalId: expectsReimbursement.proposalId,
      account: mayaAccount,
      at: T.submit,
    });
    assert.equal(reimbursementSubmit.status, 'needs_information');
    assert.ok(
      reimbursementSubmit.blockers.some(blocker => blocker.code === 'funding_request_requires_amount'),
      'an expected reimbursement without an amount cannot take the zero-budget path',
    );

    // ---- proposals core: US04 — an event type outside the authorized scope is not fast-tracked
    const outsideScope = proposals.createDraft({
      account: mayaAccount,
      fields: {
        ...ZERO_BUDGET_FIELDS,
        title: 'Free-form social meetup',
        eventType: 'meetup',
        schedule: { ...ZERO_BUDGET_FIELDS.schedule, startAt: '2026-10-24T18:00:00Z' },
      },
      at: T.draft,
    });
    proposals.confirmLeadVersion({
      proposalId: outsideScope.proposalId,
      account: mayaAccount,
      version: outsideScope.version,
      at: T.confirm,
      statement: 'I confirm this version',
    });
    const outsideScopeSubmit = proposals.submitForAssessment({
      proposalId: outsideScope.proposalId,
      account: mayaAccount,
      at: T.submit,
    });
    assert.equal(outsideScopeSubmit.status, 'needs_exception');
    assert.equal(outsideScopeSubmit.reason, 'event_type_outside_authorized_scope');
    assert.equal(outsideScopeSubmit.approved, false);

    // ---- activities core: the approval basis carries over and preparation starts
    const lead = { id: 'M-101', kind: 'human' };
    const harness = activityHarness({
      directory,
      grants: [...grantAll(ADMIN), ...grantAll(AGENT), ...grantAll(lead)],
      verifyContributor: memberId => memberId === 'M-101',
    });
    const { core } = harness;
    harness.setClock(T.submit);
    const activity = core.createActivity({
      actor: ADMIN,
      title: first.proposal.fields.title,
      eventType: 'paper_discussion',
      leadId: 'M-101',
    });
    core.transitionActivity({ actor: ADMIN, activityId: activity.id, to: 'confirmed' });
    core.transitionActivity({ actor: ADMIN, activityId: activity.id, to: 'evaluating' });
    const approved = core.transitionActivity({
      actor: ADMIN,
      activityId: activity.id,
      to: 'approved',
      basis: 'zero_budget_fast_track',
      reference: first.proposalId,
    });
    assert.equal(approved.approval.basis, 'zero_budget_fast_track');
    assert.equal(approved.approval.reference, first.proposalId, 'the approval cites the proposal behind it');

    const checklist = recommendedChecklist('paper_discussion');
    assert.ok(checklist.some(item => item.title === 'venue'));
    assert.ok(checklist.some(item => item.title === 'outcome_collection'));

    // ---- activities core: US03 — the event space stays an intent; no chat adapter is connected
    const space = core.requestActivitySpace({ actor: lead, activityId: activity.id });
    assert.equal(space.job.kind, 'create_space');
    assert.equal(space.job.state, 'pending');
    assert.equal(space.job.delivered, false);
    assert.equal(space.job.providerReceipt, null);
    assert.equal(space.space.state, 'pending');
    assert.equal(space.created, false);
    assert.equal(core.getActivity(activity.id).space.state, 'pending', 'no adapter may report a created space');
    assert.ok(core.getActivityView({ activityId: activity.id }).notices.includes('approved; event space pending'));

    // ---- activities core: execution and outcome review
    harness.setClock(T.prepare);
    core.transitionActivity({ actor: lead, activityId: activity.id, to: 'preparing' });
    harness.setClock(T.held);
    core.transitionActivity({ actor: lead, activityId: activity.id, to: 'completed' });
    harness.setClock(T.review);
    const outcome = core.submitOutcome({
      actor: lead,
      activityId: activity.id,
      fields: {
        actualStartAt: '2026-10-20T18:05:00Z',
        actualEndAt: '2026-10-20T19:30:00Z',
        actualLocation: 'University library room 204',
        summary: 'Fourteen attendees discussed one interpretability paper.',
        attendance: { count: 14, basis: 'sign-in sheet' },
        actualExpensesMinor: 0,
      },
    });
    assert.equal(outcome.status, 'materials_complete');
    const reviewed = core.reviewOutcome({ actor: AGENT, activityId: activity.id, decision: 'accepted' });
    assert.equal(reviewed.review.decision, 'accepted');
    core.transitionActivity({ actor: lead, activityId: activity.id, to: 'accepted' });
    const archived = core.transitionActivity({ actor: ADMIN, activityId: activity.id, to: 'archived' });
    assert.equal(archived.state, 'archived');

    // ---- finance never engaged, and the chain survives a restart
    assert.equal(core.getFinance(activity.id).state, 'not_requested');
    const restarted = harness.restart();
    assert.equal(restarted.getActivity(activity.id).state, 'archived');
    assert.equal(restarted.getOutcome(activity.id).review.decision, 'accepted');
    assert.equal(restarted.getActivity(activity.id).approval.reference, first.proposalId);
    assert.ok(core.listAuditEvents({ actor: ADMIN, activityId: activity.id }).length >= 8);
    assert.ok(
      proposals.state.audit.some(
        entry => entry.action === 'submit_for_assessment' && entry.subject === first.proposalId,
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('AC20 rehearsal B: funded workshop from proposal through frozen round, finance records and outcome', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rein-p0-funded-'));
  try {
    // ---- proposals core: authoritative member records
    const proposals = createProposalCore(createState());
    const record = (memberId, role) =>
      proposals.recordMember({
        memberId,
        roles: role ? [{ role, status: 'active' }] : [],
        recordedBy: 'registrar-1',
        at: T.records,
      });
    record('M-201', 'contributor');
    record('M-299', null);
    record('B-1', 'board_member');
    record('B-2', 'board_member');
    record('B-3', 'board_member');
    proposals.linkIdentity({
      platform: PLATFORM,
      accountId: 'chat-chen',
      memberId: 'M-201',
      verifiedBy: 'registrar-1',
      verifiedAt: T.records,
    });
    const chenAccount = { platform: PLATFORM, accountId: 'chat-chen' };

    // ---- proposals core: US05 — currency and line items are preserved through submission
    const draft = proposals.createDraft({ account: chenAccount, fields: FUNDED_FIELDS, at: T.draft });
    proposals.confirmLeadVersion({
      proposalId: draft.proposalId,
      account: chenAccount,
      version: draft.version,
      at: T.confirm,
      statement: 'I confirm the budget as listed',
    });
    const submitted = proposals.submitForAssessment({
      proposalId: draft.proposalId,
      account: chenAccount,
      at: T.submit,
    });
    assert.equal(submitted.status, 'governance');
    assert.equal(submitted.queued, true);
    assert.equal(submitted.proposal.state, 'awaiting_governance');
    assert.equal(submitted.approved, false, 'the agent never approves funding on its own');
    const budget = submitted.proposal.fields.budget;
    assert.equal(budget.currency, 'USD');
    assert.equal(
      budget.items.reduce((total, item) => total + item.amountMinor, 0),
      budget.requestedAmountMinor,
    );

    // ---- governance engine: the roster comes from authoritative records plus explicit weights
    // Board weights remain an open decision (docs/decisions.md); the rehearsal states its input.
    const REHEARSAL_WEIGHTS = { 'B-1': 2, 'B-2': 1, 'B-3': 1 };
    const boardMembers = Object.values(proposals.state.members).filter(
      member =>
        member.status === 'active' &&
        (member.roles ?? []).some(role => role.role === 'board_member' && role.status === 'active'),
    );
    assert.deepEqual(boardMembers.map(member => member.memberId).sort(), Object.keys(REHEARSAL_WEIGHTS).sort());
    const roster = boardMembers.map(member => ({
      memberId: member.memberId,
      weight: REHEARSAL_WEIGHTS[member.memberId],
    }));

    const roundInput = {
      roundId: 'GR-2026-10',
      rules: {
        rulesVersion: 'rehearsal-rules-1',
        participation: {
          minMemberFraction: { numerator: 1, denominator: 2 },
          minWeightFraction: { numerator: 1, denominator: 2 },
        },
        approval: { strictMajorityFraction: { numerator: 1, denominator: 2 }, requireNonAbstainingVote: true },
        tie: { outcome: 'not_passed' },
        voteReplacement: { allowed: true },
        allocation: {
          rule: 'explicit_ranking',
          ranking: [draft.proposalId],
          exhaustion: 'stop_at_first_unfundable',
        },
      },
      opensAt: T.roundOpens,
      closesAt: T.roundCloses,
      currency: 'USD',
      budgetAvailableMinor: 30000,
      roster,
      proposals: [
        {
          proposalId: draft.proposalId,
          version: `${draft.proposalId}@v${draft.version}`,
          leadMemberId: 'M-201',
          requestedAmountMinor: budget.requestedAmountMinor,
          recusedMemberIds: [],
        },
      ],
    };

    // ---- governance engine: counting rules are required inputs, never implicit defaults
    assert.throws(() => createRound({ ...roundInput, rules: undefined }), error => error.code === 'rules_required');
    assert.throws(
      () => createRound({ ...roundInput, rules: { rulesVersion: 'partial' } }),
      error => error.code === 'rules_required',
    );
    assert.throws(
      () => createRound({ ...roundInput, rules: { ...roundInput.rules, allocation: { rule: 'explicit_ranking' } } }),
      error => error.code === 'invalid_rules',
      'an explicit ranking must be complete before any round freezes',
    );

    let round = createRound(roundInput);
    assert.equal(round.snapshot.proposals[0].requestedAmountMinor, 18000);
    assert.deepEqual(round.snapshot.warnings, []);

    const cast = (memberId, choice, castAt, idempotencyKey) => {
      const receipt = castBallot(round, { proposalId: draft.proposalId, memberId, choice, castAt, idempotencyKey });
      round = receipt.state;
      return receipt;
    };

    // ---- governance engine: US06/AC06 — ineligible, early and late ballots never become valid
    assert.equal(cast('B-1', 'approve', '2026-09-24T23:59:00Z').reason, 'outside_voting_window');
    assert.equal(cast('M-299', 'approve', T.roundOpens).reason, 'ineligible_voter');
    assert.equal(cast('B-1', 'approve', '2026-09-25T08:00:00Z', 'ballot-b1').accepted, true);
    assert.equal(cast('B-1', 'approve', '2026-09-25T08:05:00Z', 'ballot-b1').duplicated, true);
    assert.equal(cast('B-1', 'reject', '2026-09-25T08:10:00Z', 'ballot-b1').reason, 'idempotency_key_conflict');
    assert.equal(cast('B-2', 'approve', '2026-09-25T09:00:00Z').accepted, true);
    const original = cast('B-3', 'reject', '2026-09-25T10:00:00Z');
    assert.equal(original.accepted, true);
    const replacement = cast('B-3', 'abstain', '2026-09-26T10:00:00Z');
    assert.equal(replacement.accepted, true);
    assert.equal(replacement.replacedSequence, original.ballot.sequence, 'a pre-deadline change replaces the ballot');
    assert.equal(cast('B-2', 'approve', T.roundCloses).reason, 'outside_voting_window');

    const tally = tallyProposal(round, draft.proposalId);
    assert.equal(tally.status, 'passed');
    assert.equal(tally.passed, true);
    assert.deepEqual(tally.counts, { approve: 2, reject: 0, abstain: 1 });
    assert.deepEqual(tally.weights, { approve: 3, reject: 0, abstain: 1 });
    assert.equal(tally.eligibleMemberCount, 3);
    assert.equal(tally.eligibleWeight, 4);
    assert.equal(tally.requiredParticipatingMembers, 2);
    assert.equal(tally.participatingMemberCount, 3);
    assert.deepEqual(tally.participation, { memberRequirementMet: true, weightRequirementMet: true, met: true });
    assert.deepEqual(tally.approvalShareOfNonAbstaining, { numerator: 1, denominator: 1 });
    assert.ok(tally.reasons.includes('support_threshold_met_funding_still_requires_allocation'));

    // ---- governance engine: US07/AC08 — allocation is deterministic and never overcommits
    const result = tallyRound(round);
    assert.equal(result.budget.status, 'fully_covered');
    assert.equal(result.budget.requestedByPassedMinor, 18000);
    assert.equal(result.budget.shortfallMinor, null);
    assert.deepEqual(result.allocations, [
      {
        proposalId: draft.proposalId,
        requestedAmountMinor: 18000,
        allocatedMinor: 18000,
        status: 'allocated',
        basis: 'no_competition',
      },
    ]);
    assert.deepEqual(result.awaitingFundingAllocation, []);

    let openRound = createRound({ ...roundInput, roundId: 'GR-2026-11', budgetAvailableMinor: null });
    for (const ballot of round.ballots) {
      openRound = castBallot(openRound, {
        proposalId: ballot.proposalId,
        memberId: ballot.memberId,
        choice: ballot.choice,
        castAt: ballot.castAt,
        idempotencyKey: `open-${ballot.sequence}`,
      }).state;
    }
    const openResult = tallyRound(openRound);
    assert.equal(openResult.budget.status, 'available_funds_unknown');
    assert.equal(openResult.allocations[0].status, 'awaiting_funding_allocation');
    assert.equal(openResult.allocations[0].allocatedMinor, 0, 'unconfirmed funds are never committed');
    assert.ok(openResult.outstanding.includes('available_funds_unknown_pause_commitments'));

    // ---- activities core: approval cites the governance decision, and finance follows the allocation
    const allocation = result.allocations[0];
    const allocationReference = `${result.roundId}:${allocation.proposalId}`;
    const lead = { id: 'M-201', kind: 'human' };
    const harness = activityHarness({
      directory,
      grants: [...grantAll(ADMIN), ...grantAll(AGENT), ...grantAll(FINANCE), ...grantAll(lead)],
      verifyContributor: memberId => memberId === 'M-201',
    });
    const { core } = harness;
    harness.setClock(T.approve);
    const activity = core.createActivity({
      actor: ADMIN,
      title: submitted.proposal.fields.title,
      eventType: 'workshop',
      leadId: 'M-201',
    });
    core.transitionActivity({ actor: ADMIN, activityId: activity.id, to: 'confirmed' });
    core.transitionActivity({ actor: ADMIN, activityId: activity.id, to: 'evaluating' });
    assert.throws(
      () =>
        core.transitionActivity({
          actor: ADMIN,
          activityId: activity.id,
          to: 'approved',
          basis: 'looks_fine',
          reference: 'x',
        }),
      error => error.code === 'approval_basis_required',
      'approval needs an explicit basis, not an opinion',
    );
    core.transitionActivity({
      actor: ADMIN,
      activityId: activity.id,
      to: 'approved',
      basis: 'governance_decision',
      reference: allocationReference,
    });

    const requested = core.requestFunding({
      actor: lead,
      activityId: activity.id,
      amountMinor: budget.requestedAmountMinor,
      currency: budget.currency,
    });
    assert.equal(requested.state, 'requested');
    assert.equal(requested.requestedMinor, allocation.requestedAmountMinor, 'the agent does not inflate the request');
    assert.throws(
      () =>
        core.recordPayment({
          actor: FINANCE,
          activityId: activity.id,
          amountMinor: 9000,
          currency: 'USD',
          receiptReference: 'bank-transfer-early',
          paidBy: 'M-201',
        }),
      error => error.code === 'invalid_transition',
      'an unconfirmed payment is never recorded as paid',
    );

    const approvedFunding = core.approveFunding({
      actor: FINANCE,
      activityId: activity.id,
      ceilingMinor: allocation.allocatedMinor,
      currency: result.currency,
      allocationReference,
    });
    assert.equal(approvedFunding.state, 'awaiting_allocation');
    assert.equal(approvedFunding.approvedCeilingMinor, 18000);
    assert.equal(approvedFunding.allocationReference, allocationReference);
    core.reserveFunds({ actor: FINANCE, activityId: activity.id, amountMinor: 18000 });
    assert.equal(core.getFinance(activity.id).state, 'reserved');

    // ---- activities core: the event runs, and its outcome is reviewed
    harness.setClock(T.prepare);
    core.transitionActivity({ actor: lead, activityId: activity.id, to: 'preparing' });
    harness.setClock(T.held);
    core.transitionActivity({ actor: lead, activityId: activity.id, to: 'completed' });
    harness.setClock(T.review);
    const outcome = core.submitOutcome({
      actor: lead,
      activityId: activity.id,
      fields: {
        actualStartAt: '2026-11-07T17:05:00Z',
        actualEndAt: '2026-11-07T20:00:00Z',
        actualLocation: 'Community center room B',
        summary: 'Twenty-two attendees completed the evaluation exercise.',
        attendance: { count: 22, basis: 'registration desk count' },
        actualExpensesMinor: 16500,
      },
    });
    assert.equal(outcome.status, 'materials_complete');
    core.reviewOutcome({ actor: AGENT, activityId: activity.id, decision: 'accepted' });
    core.transitionActivity({ actor: lead, activityId: activity.id, to: 'accepted' });

    // ---- finance: after the event, payments are human-entered receipts, never provider calls
    harness.setClock(T.settle);
    assert.throws(
      () => core.enqueueExternalIntent({ actor: FINANCE, activityId: activity.id, kind: 'pay_invoice', payload: {} }),
      error => error instanceof OperationsError && error.code === 'payment_not_supported',
      'this core never initiates a payment',
    );
    core.recordPayment({
      actor: FINANCE,
      activityId: activity.id,
      amountMinor: 9000,
      currency: 'USD',
      receiptReference: 'bank-transfer-0001',
      paidBy: 'M-201',
    });
    assert.equal(core.getFinance(activity.id).state, 'partially_paid');
    core.recordPayment({
      actor: FINANCE,
      activityId: activity.id,
      amountMinor: 9000,
      currency: 'USD',
      receiptReference: 'bank-transfer-0002',
      paidBy: 'M-201',
    });
    assert.equal(core.getFinance(activity.id).state, 'paid');

    // ---- finance: AC15 — actual spend settles against the reservation; overspend needs review
    assert.throws(
      () => core.recordSettlement({ actor: FINANCE, activityId: activity.id, actualMinor: 20000, unusedReleasedMinor: 0 }),
      error => error.code === 'notes_required',
      'an overspend is not silently approved',
    );
    const settlement = core.recordSettlement({
      actor: FINANCE,
      activityId: activity.id,
      actualMinor: 16500,
      unusedReleasedMinor: 1500,
    });
    assert.equal(settlement.state, 'settled');
    assert.equal(settlement.actualMinor, 16500);
    assert.equal(settlement.unusedReleasedMinor, 1500);

    // ---- activities core: publication and its adapter boundary
    harness.setClock(T.publish);
    const publication = core.createPublicationDraft({
      actor: lead,
      activityId: activity.id,
      title: 'Workshop recap',
      body: 'Twenty-two attendees worked through the evaluation exercise.',
      channels: ['website', 'chat'],
    });
    core.requestFactConfirmation({ actor: lead, publicationId: publication.id });
    assert.throws(
      () => core.confirmFacts({ actor: { id: 'B-1', kind: 'human' }, publicationId: publication.id }),
      error => error.code === 'unauthorized',
      'only the activity lead confirms facts',
    );
    const blocked = core.confirmFacts({ actor: lead, publicationId: publication.id });
    assert.equal(blocked.confirmed, false);
    assert.deepEqual(blocked.missingConsents, ['website', 'chat']);
    core.recordConsent({ actor: lead, activityId: activity.id, channel: 'website', granted: true });
    core.recordConsent({ actor: lead, activityId: activity.id, channel: 'chat', granted: true });
    assert.equal(core.confirmFacts({ actor: lead, publicationId: publication.id }).confirmed, true);

    const publishAttempt = core.publishPublication({ actor: ADMIN, publicationId: publication.id });
    assert.equal(publishAttempt.published, false);
    assert.equal(publishAttempt.job.state, 'pending');
    const publishing = core.getPublication(publication.id);
    assert.equal(publishing.state, 'publishing');
    assert.equal(publishing.url, null);
    const publishJob = core
      .listExternalIntents({ actor: ADMIN, activityId: activity.id })
      .find(job => job.kind === 'publish_article');
    assert.equal(publishJob.delivered, false, 'no website adapter is connected');
    assert.equal(publishJob.providerReceipt, null);

    // ---- activities core: archive is blocked until the unresolved publication is withdrawn
    assert.throws(
      () => core.transitionActivity({ actor: ADMIN, activityId: activity.id, to: 'archived' }),
      error => error.code === 'archive_blocked',
    );
    core.withdrawPublication({
      actor: ADMIN,
      publicationId: publication.id,
      reason: 'rehearsal: no website adapter connected; publish intent left pending',
    });
    const archived = core.transitionActivity({ actor: ADMIN, activityId: activity.id, to: 'archived' });
    assert.equal(archived.state, 'archived');

    // ---- traceability across all four modules, surviving a restart
    const finance = core.getFinance(activity.id);
    assert.equal(finance.state, 'settled');
    assert.equal(finance.allocationReference, allocationReference);
    assert.deepEqual(
      finance.history.map(entry => entry.to),
      ['requested', 'awaiting_allocation', 'reserved', 'partially_paid', 'paid', 'settled'],
    );
    const restarted = harness.restart();
    assert.equal(restarted.getActivity(activity.id).state, 'archived');
    assert.equal(restarted.getActivity(activity.id).approval.reference, allocationReference);
    assert.equal(restarted.getFinance(activity.id).state, 'settled');
    assert.equal(restarted.getOutcome(activity.id).review.decision, 'accepted');
    assert.equal(restarted.getPublication(publication.id).state, 'withdrawn');
    assert.equal(restarted.getActivityView({ activityId: activity.id }).publication.state, 'withdrawn');
    assert.ok(
      proposals.state.audit.some(
        entry => entry.action === 'submit_for_assessment' && entry.subject === draft.proposalId,
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
