import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOperationsCore,
  createCapabilityAuthorizer,
  createLedgerStore,
  recommendedChecklist,
  CAPABILITIES,
  OperationsError,
} from '../plugins/rein-operations/activities.ts';

const LEAD = { id: 'lead-1', kind: 'human' };
const AGENT = { id: 'rein-agent', kind: 'agent' };
const BOARD = { id: 'board-1', kind: 'human' };
const FINANCE = { id: 'finance-1', kind: 'human' };
const ADMIN = { id: 'admin-1', kind: 'human' };

function harness({ now = '2026-09-24T10:00:00Z', grants = [], verifyContributor = memberId => memberId === LEAD.id } = {}) {
  let clock = now;
  const core = createOperationsCore({
    now: () => clock,
    authorize: createCapabilityAuthorizer(grants),
    verifyContributor,
  });
  return { core, setClock: value => { clock = value; } };
}

function grantAll(actor, capabilities = CAPABILITIES, activityId) {
  return capabilities.map(capability => ({ actorId: actor.id, capability, activityId }));
}

function approvedActivity(core) {
  const activity = core.createActivity({ actor: ADMIN, title: 'Agent paper discussion', eventType: 'paper_discussion', leadId: LEAD.id });
  core.transitionActivity({ actor: ADMIN, activityId: activity.id, to: 'confirmed' });
  core.transitionActivity({ actor: ADMIN, activityId: activity.id, to: 'evaluating' });
  core.transitionActivity({ actor: ADMIN, activityId: activity.id, to: 'approved', basis: 'zero_budget_fast_track', reference: 'fast-track-2026-09-24' });
  return activity.id;
}

// A completed activity with a created event space and a published article whose link-return intent
// is still pending: the only state in which linkReturnedAt must stay empty until a receipt arrives.
function pendingArticleLink(core) {
  const activityId = approvedActivity(core);
  const space = core.requestActivitySpace({ actor: AGENT, activityId });
  core.recordExternalReceipt({
    actor: AGENT, jobId: space.job.id,
    receipt: { provider: 'chat', providerRef: 'space-1', url: 'https://chat.example.org/spaces/1' },
  });
  core.transitionActivity({ actor: ADMIN, activityId, to: 'preparing' });
  core.transitionActivity({ actor: ADMIN, activityId, to: 'completed' });
  const draft = core.createPublicationDraft({ actor: ADMIN, activityId, title: 'Recap', body: 'Facts.', channels: ['website'] });
  core.requestFactConfirmation({ actor: ADMIN, publicationId: draft.id });
  core.recordConsent({ actor: LEAD, activityId, channel: 'website', granted: true });
  core.confirmFacts({ actor: LEAD, publicationId: draft.id });
  const publishing = core.publishPublication({ actor: ADMIN, publicationId: draft.id });
  core.recordExternalReceipt({
    actor: ADMIN, jobId: publishing.job.id,
    receipt: { provider: 'website', url: 'https://example.org/events/9' },
  });
  const linkIntent = core.listExternalIntents({ actor: ADMIN, activityId }).find(job => job.kind === 'post_article_link');
  return { activityId, publicationId: draft.id, linkIntent };
}

test('authorization is explicit and denies everything without a grant', () => {
  const { core } = harness();
  assert.throws(() => core.createActivity({ actor: ADMIN, title: 't', eventType: 'meetup', leadId: 'lead-1' }),
    error => error instanceof OperationsError && error.code === 'unauthorized');
  assert.deepEqual(core.authorize({ actor: ADMIN, capability: 'activity.create' }), { allowed: false, reason: 'no_grant' });

  const scoped = harness({ grants: [
    { actorId: ADMIN.id, capability: 'activity.create' },
    { actorId: ADMIN.id, capability: 'activity.transition', activityId: 'activity-2' },
  ] });
  const first = scoped.core.createActivity({ actor: ADMIN, title: 't', eventType: 'meetup', leadId: 'lead-1' });
  assert.throws(() => scoped.core.transitionActivity({ actor: ADMIN, activityId: first.id, to: 'confirmed' }),
    error => error.code === 'unauthorized');
});

test('activity, finance and publication are three independent dimensions with guarded transitions', () => {
  const { core } = harness({ grants: [...grantAll(ADMIN), ...grantAll(LEAD), ...grantAll(FINANCE), ...grantAll(BOARD), ...grantAll(AGENT)] });
  const activityId = approvedActivity(core);

  const view = core.getActivityView({ activityId });
  assert.equal(view.activity.state, 'approved');
  assert.equal(view.finance.state, 'not_requested');
  assert.equal(view.publication, null);
  assert.deepEqual(view.notices, ['approved; event space pending']);

  assert.throws(() => core.transitionActivity({ actor: ADMIN, activityId, to: 'archived' }),
    error => error.code === 'invalid_transition');
  assert.throws(() => core.transitionActivity({ actor: ADMIN, activityId, to: 'completed' }),
    error => error.code === 'invalid_transition');

  const second = core.createActivity({ actor: ADMIN, title: 'second', eventType: 'meetup', leadId: LEAD.id });
  core.transitionActivity({ actor: ADMIN, activityId: second.id, to: 'confirmed' });
  core.transitionActivity({ actor: ADMIN, activityId: second.id, to: 'evaluating' });
  assert.throws(() => core.transitionActivity({ actor: ADMIN, activityId: second.id, to: 'approved', reference: 'x' }),
    error => error.code === 'approval_basis_required');
});

test('tasks and reminders support completion, snooze, mute and response', () => {
  const { core, setClock } = harness({ grants: [...grantAll(ADMIN), ...grantAll(AGENT)] });
  const activityId = approvedActivity(core);

  const task = core.addTask({ actor: ADMIN, activityId, title: 'venue', dueAt: '2026-09-26T00:00:00Z' });
  assert.equal(core.listTasks(activityId).length, 1);
  assert.equal(core.completeTask({ actor: ADMIN, taskId: task.id }).status, 'done');

  const reminder = core.scheduleReminder({ actor: ADMIN, activityId, dueAt: '2026-09-25T10:00:00Z' });
  assert.equal(core.snoozeReminder({ actor: ADMIN, reminderId: reminder.id, until: '2026-09-27T10:00:00Z' }).snoozeCount, 1);
  assert.equal(core.muteReminder({ actor: ADMIN, reminderId: reminder.id, reason: 'lead asked' }).status, 'muted');

  setClock('2026-09-28T10:00:00Z');
  const muted = core.dispatchDueReminders({ actor: AGENT, at: '2026-09-28T10:00:00Z', policy: { timezone: 'UTC' } });
  assert.deepEqual(muted.sent, []);
});

test('reminder dispatch respects quiet hours, one ordinary follow-up per day, and exception escalation', () => {
  const { core } = harness({ grants: [...grantAll(ADMIN), ...grantAll(AGENT)] });
  const activityId = approvedActivity(core);
  const policy = { timezone: 'UTC' };

  const quietOne = core.scheduleReminder({ actor: ADMIN, activityId, dueAt: '2026-09-24T22:00:00Z' });
  const quiet = core.dispatchDueReminders({ actor: AGENT, at: '2026-09-24T22:00:00Z', policy });
  assert.deepEqual(quiet.deferred, [{ reminderId: quietOne.id, reason: 'quiet_hours' }]);
  assert.equal(quiet.policySource, 'provided');

  core.scheduleReminder({ actor: ADMIN, activityId, dueAt: '2026-09-25T10:00:00Z' });
  core.scheduleReminder({ actor: ADMIN, activityId, dueAt: '2026-09-25T11:00:00Z' });
  const day1 = core.dispatchDueReminders({ actor: AGENT, at: '2026-09-25T12:00:00Z', policy });
  assert.deepEqual(day1.sent, [{ reminderId: quietOne.id, activityId, kind: 'ordinary' }]);
  assert.deepEqual(day1.deferred.map(item => item.reason), ['daily_limit', 'daily_limit']);

  const day2 = core.dispatchDueReminders({ actor: AGENT, at: '2026-09-26T12:00:00Z', policy });
  assert.equal(day2.sent.length, 1);
  assert.equal(day2.suppressed.length, 1, 'the next follow-up becomes one exception instead of another reminder');
  assert.equal(day2.exceptionsCreated.length, 1);
  assert.equal(core.getActivity(activityId).consecutiveUnanswered, 2);

  core.scheduleReminder({ actor: ADMIN, activityId, dueAt: '2026-09-27T10:00:00Z' });
  core.scheduleReminder({ actor: ADMIN, activityId, dueAt: '2026-09-27T11:00:00Z' });
  const day3 = core.dispatchDueReminders({ actor: AGENT, at: '2026-09-27T12:00:00Z', policy });
  assert.deepEqual(day3.sent, []);
  assert.equal(day3.suppressed.length, 2);
  assert.equal(day3.exceptionsCreated.length, 0, 'the open exception is reused, never duplicated');
  assert.equal(core.listExceptions({ actor: ADMIN, activityId }).length, 1);

  const response = core.recordReminderResponse({ actor: ADMIN, reminderId: quietOne.id, note: 'lead replied' });
  assert.equal(response.status, 'answered');
  assert.equal(core.getActivity(activityId).consecutiveUnanswered, 0);
});

test('materials carry per-channel consent that is denied by default and revocable', () => {
  const { core } = harness({ grants: grantAll(ADMIN) });
  const activityId = approvedActivity(core);

  const material = core.submitMaterial({ actor: ADMIN, activityId, kind: 'photo', description: 'group photo with permission', reference: 'media/1.jpg' });
  assert.equal(core.listMaterials(activityId).length, 1);
  assert.deepEqual(core.channelConsent(activityId, 'website'), { granted: false, reason: 'no_explicit_consent' });

  core.recordConsent({ actor: ADMIN, activityId, channel: 'website', granted: true, note: 'participants agreed' });
  assert.equal(core.channelConsent(activityId, 'website').granted, true);
  assert.equal(core.channelConsent(activityId, 'social').granted, false);

  core.recordConsent({ actor: ADMIN, activityId, channel: 'website', materialId: material.id, granted: true });
  core.recordConsent({ actor: ADMIN, activityId, channel: 'website', granted: false, note: 'withdrawn' });
  assert.equal(core.channelConsent(activityId, 'website').granted, false);
  assert.throws(() => core.recordConsent({ actor: ADMIN, activityId, channel: 'print', granted: true }),
    error => error.code === 'validation');
});

test('outcome review separates materials complete from verified facts and keeps the agent in bounds', () => {
  const { core } = harness({ grants: [...grantAll(ADMIN), ...grantAll(AGENT)] });
  const activityId = approvedActivity(core);

  const photosOnly = core.submitOutcome({
    actor: ADMIN, activityId,
    fields: { photos: ['media/1.jpg'], actualStartAt: '2026-09-24T09:00:00Z', actualEndAt: '2026-09-24T11:00:00Z', actualLocation: 'Room 101', summary: 'discussion', actualExpensesMinor: 0 },
  });
  assert.equal(photosOnly.status, 'incomplete');
  assert.ok(photosOnly.missing.includes('attendance') && photosOnly.missing.includes('attendanceBasis'), 'photos alone never establish attendance');
  assert.throws(() => core.reviewOutcome({ actor: AGENT, activityId, decision: 'accepted' }),
    error => error.code === 'materials_incomplete');

  const complete = core.submitOutcome({
    actor: ADMIN, activityId,
    fields: {
      actualStartAt: '2026-09-24T09:00:00Z', actualEndAt: '2026-09-24T11:00:00Z', actualLocation: 'Room 101',
      summary: 'paper discussion', attendance: { count: 18, basis: 'sign-in sheet' }, actualExpensesMinor: 0,
      permittedAlternatives: ['anonymous feedback'], photos: ['media/1.jpg'],
    },
  });
  assert.equal(complete.status, 'materials_complete');
  assert.equal(complete.verification, 'unverified');

  const accepted = core.reviewOutcome({ actor: AGENT, activityId, decision: 'accepted', notes: 'routine' });
  assert.equal(accepted.review.decision, 'accepted');
  assert.equal(accepted.verification, 'unverified', 'acceptance is not independent verification');
  assert.equal(core.recordVerification({ actor: ADMIN, activityId, verified: true, notes: 'sign-in sheet checked' }).verification, 'verified');

  core.transitionActivity({ actor: ADMIN, activityId, to: 'preparing' });
  core.transitionActivity({ actor: ADMIN, activityId, to: 'completed' });
  core.transitionActivity({ actor: ADMIN, activityId, to: 'accepted' });
  assert.equal(core.getActivity(activityId).state, 'accepted');
});

test('a conflicting outcome stays pending verification and cannot be auto-accepted', () => {
  const { core } = harness({ grants: [...grantAll(ADMIN), ...grantAll(AGENT)] });
  const activityId = approvedActivity(core);
  core.submitOutcome({
    actor: ADMIN, activityId,
    fields: {
      actualStartAt: '2026-09-24T09:00:00Z', actualEndAt: '2026-09-24T11:00:00Z', actualLocation: 'Room 101',
      summary: 'discussion', attendance: { count: 18, basis: 'sign-in sheet' }, actualExpensesMinor: 12000,
      discrepancies: ['receipt total differs from the summary'],
    },
  });
  assert.equal(core.getOutcome(activityId).status, 'pending_verification');
  assert.throws(() => core.reviewOutcome({ actor: AGENT, activityId, decision: 'accepted' }),
    error => error.code === 'agent_review_out_of_authority');
  const reviewed = core.reviewOutcome({ actor: ADMIN, activityId, decision: 'needs_verification', notes: 'asking the lead' });
  assert.equal(reviewed.review.decision, 'needs_verification');
});

test('publication needs explicit lead fact confirmation, channel consent, and a recorded receipt', () => {
  const { core } = harness({ grants: [...grantAll(ADMIN), ...grantAll(LEAD), ...grantAll(AGENT)] });
  const activityId = approvedActivity(core);
  core.transitionActivity({ actor: ADMIN, activityId, to: 'preparing' });
  core.transitionActivity({ actor: ADMIN, activityId, to: 'completed' });

  const draft = core.createPublicationDraft({ actor: ADMIN, activityId, title: 'Discussion recap', body: 'We discussed agents.', channels: ['website'] });
  assert.equal(draft.state, 'draft');
  assert.equal(core.getPublication(draft.id).state, 'draft');
  core.requestFactConfirmation({ actor: ADMIN, publicationId: draft.id });
  assert.equal(core.getPublication(draft.id).state, 'awaiting_confirmation');

  assert.throws(() => core.confirmFacts({ actor: BOARD, publicationId: draft.id }),
    error => error.code === 'unauthorized');
  const blocked = core.confirmFacts({ actor: LEAD, publicationId: draft.id });
  assert.equal(blocked.confirmed, false);
  assert.deepEqual(blocked.missingConsents, ['website']);
  assert.equal(core.getPublication(draft.id).state, 'awaiting_confirmation', 'silence and missing consent never publish');

  core.recordConsent({ actor: LEAD, activityId, channel: 'website', granted: true });
  assert.equal(core.confirmFacts({ actor: LEAD, publicationId: draft.id }).confirmed, true);
  assert.equal(core.getPublication(draft.id).state, 'ready');

  const published = core.publishPublication({ actor: ADMIN, publicationId: draft.id });
  assert.equal(published.published, false);
  assert.equal(published.job.state, 'pending');
  assert.equal(core.getPublication(draft.id).state, 'publishing');

  core.recordExternalReceipt({ actor: ADMIN, jobId: published.job.id, receipt: { provider: 'foundation-website', url: 'https://example.org/events/1' } });
  const live = core.getPublication(draft.id);
  assert.equal(live.state, 'published');
  assert.equal(live.url, 'https://example.org/events/1');

  const withdrawn = core.withdrawPublication({ actor: ADMIN, publicationId: draft.id, reason: 'attendee asked for removal' });
  assert.equal(withdrawn.state, 'withdrawn');
  assert.equal(withdrawn.corrections.length, 1);
});

test('lead fact confirmation fails closed without authoritative Contributor verification', () => {
  const grants = [...grantAll(ADMIN), ...grantAll(LEAD)];
  const core = createOperationsCore({ now: () => '2026-09-24T10:00:00Z', authorize: createCapabilityAuthorizer(grants) });
  const activityId = approvedActivity(core);
  core.transitionActivity({ actor: ADMIN, activityId, to: 'preparing' });
  core.transitionActivity({ actor: ADMIN, activityId, to: 'completed' });
  const draft = core.createPublicationDraft({ actor: ADMIN, activityId, title: 'Recap', body: 'Facts', channels: ['website'] });
  core.requestFactConfirmation({ actor: ADMIN, publicationId: draft.id });
  assert.throws(() => core.confirmFacts({ actor: LEAD, publicationId: draft.id, contributorStatus: 'active' }),
    error => error.code === 'lead_not_active_contributor');
  assert.equal(core.getPublication(draft.id).state, 'awaiting_confirmation');
});

test('funding approval, reservation, payment and settlement stay strictly distinct', () => {
  const { core } = harness({ grants: [...grantAll(ADMIN), ...grantAll(LEAD), ...grantAll(FINANCE), ...grantAll(BOARD)] });
  const activityId = approvedActivity(core);

  const requested = core.requestFunding({ actor: LEAD, activityId, amountMinor: 50000, currency: 'usd' });
  assert.equal(requested.state, 'requested');
  assert.throws(() => core.recordPayment({ actor: FINANCE, activityId, amountMinor: 50000, currency: 'USD', receiptReference: 'r-1', paidBy: 'lead-1' }),
    error => error.code === 'invalid_transition', 'approval is never a payment');

  const approved = core.approveFunding({ actor: BOARD, activityId, ceilingMinor: 50000, currency: 'USD', allocationReference: 'round-2026-09-24#p3' });
  assert.equal(approved.state, 'awaiting_allocation');
  assert.equal(approved.paidMinor, 0);

  assert.throws(() => core.reserveFunds({ actor: FINANCE, activityId, amountMinor: 60000 }),
    error => error.code === 'ceiling_exceeded');
  const reserved = core.reserveFunds({ actor: FINANCE, activityId, amountMinor: 50000 });
  assert.equal(reserved.state, 'reserved');
  assert.equal(reserved.reservedMinor, 50000);
  assert.equal(reserved.paidMinor, 0);

  assert.throws(() => core.recordPayment({ actor: FINANCE, activityId, amountMinor: 60000, currency: 'USD', receiptReference: 'r-1', paidBy: 'lead-1' }),
    error => error.code === 'payment_exceeds_reservation');
  const partial = core.recordPayment({ actor: FINANCE, activityId, amountMinor: 20000, currency: 'USD', receiptReference: 'r-1', paidBy: 'lead-1' });
  assert.equal(partial.state, 'partially_paid');
  const paid = core.recordPayment({ actor: FINANCE, activityId, amountMinor: 30000, currency: 'USD', receiptReference: 'r-2', paidBy: 'lead-1' });
  assert.equal(paid.state, 'paid');

  assert.throws(() => core.recordSettlement({ actor: FINANCE, activityId, actualMinor: 45000, unusedReleasedMinor: 4000 }),
    error => error.code === 'settlement_mismatch');
  const settled = core.recordSettlement({ actor: FINANCE, activityId, actualMinor: 45000, unusedReleasedMinor: 5000, notes: 'receipts filed' });
  assert.equal(settled.state, 'settled');
  assert.equal(settled.approved, true);
});

test('overspend is recorded as pending settlement, never silently approved', () => {
  const { core } = harness({ grants: [...grantAll(ADMIN), ...grantAll(LEAD), ...grantAll(FINANCE), ...grantAll(BOARD)] });
  const activityId = approvedActivity(core);
  core.requestFunding({ actor: LEAD, activityId, amountMinor: 10000, currency: 'USD' });
  core.approveFunding({ actor: BOARD, activityId, ceilingMinor: 10000, currency: 'USD', allocationReference: 'round#1' });
  core.reserveFunds({ actor: FINANCE, activityId, amountMinor: 10000 });
  core.recordPayment({ actor: FINANCE, activityId, amountMinor: 10000, currency: 'USD', receiptReference: 'r-1', paidBy: 'lead-1' });
  assert.throws(() => core.recordSettlement({ actor: FINANCE, activityId, actualMinor: 13000, unusedReleasedMinor: 0 }),
    error => error.code === 'notes_required');
  const flagged = core.recordSettlement({ actor: FINANCE, activityId, actualMinor: 13000, unusedReleasedMinor: 0, notes: 'taxi receipt arrived late' });
  assert.equal(flagged.overspend, true);
  assert.equal(flagged.approved, false);
  assert.equal(flagged.state, 'awaiting_settlement');
  assert.equal(flagged.pendingSettlementMinor, 3000);
});

test('external effects are idempotent intents that never claim success and never pay', () => {
  const { core } = harness({ grants: [...grantAll(ADMIN), ...grantAll(AGENT)] });
  const activityId = approvedActivity(core);

  const space = core.requestActivitySpace({ actor: AGENT, activityId });
  assert.equal(space.created, false);
  assert.equal(space.job.state, 'pending');
  assert.equal(core.getActivityView({ activityId }).notices.includes('approved; event space pending'), true);

  const again = core.requestActivitySpace({ actor: AGENT, activityId });
  assert.equal(again.deduplicated, true);
  assert.equal(again.job.id, space.job.id, 'one event space per activity');

  const first = core.enqueueExternalIntent({ actor: AGENT, activityId, kind: 'send_registration_notice', payload: { audience: 'public' } });
  const duplicate = core.enqueueExternalIntent({ actor: AGENT, activityId, kind: 'send_registration_notice', payload: { audience: 'public' } });
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.job.id, first.job.id);

  const keyed = core.enqueueExternalIntent({ actor: AGENT, activityId, kind: 'post_standing_summary', payload: { version: 1 }, idempotencyKey: 'summary-1' });
  const keyedAgain = core.enqueueExternalIntent({ actor: AGENT, activityId, kind: 'post_standing_summary', payload: { version: 2 }, idempotencyKey: 'summary-1' });
  assert.equal(keyedAgain.job.id, keyed.job.id);

  assert.throws(() => core.recordExternalReceipt({ actor: AGENT, jobId: space.job.id, receipt: {} }),
    error => error.code === 'receipt_required');
  assert.throws(() => core.recordExternalReceipt({ actor: AGENT, jobId: space.job.id, receipt: { providerRef: 'space-x', key: 'wrong-key' } }),
    error => error.code === 'receipt_key_mismatch');
  assert.equal(core.getActivity(activityId).space.state, 'pending');

  core.markExternalIntentFailed({ actor: AGENT, jobId: first.job.id, error: 'channel unavailable' });
  const retried = core.retryExternalIntent({ actor: AGENT, jobId: first.job.id });
  assert.equal(retried.retried, true);
  assert.equal(retried.attempts, 1);
  core.markExternalIntentUncertain({ actor: AGENT, jobId: first.job.id, note: 'timeout after send' });
  assert.throws(() => core.retryExternalIntent({ actor: AGENT, jobId: first.job.id }),
    error => error.code === 'reconcile_required');
  assert.throws(() => core.reconcileExternalIntent({ actor: AGENT, jobId: first.job.id, resolution: 'delivered', receipt: { provider: 'chat' } }),
    error => error.code === 'receipt_required');
  assert.equal(core.reconcileExternalIntent({ actor: AGENT, jobId: first.job.id, resolution: 'delivered', receipt: { provider: 'chat', providerRef: 'message-1' } }).state, 'delivered');
  assert.throws(() => core.markExternalIntentFailed({ actor: AGENT, jobId: first.job.id, error: 'late network error' }),
    error => error.code === 'invalid_transition');
  assert.throws(() => core.markExternalIntentUncertain({ actor: AGENT, jobId: first.job.id, note: 'late timeout' }),
    error => error.code === 'invalid_transition');

  core.markExternalIntentUncertain({ actor: AGENT, jobId: space.job.id, note: 'space creation timed out' });
  core.reconcileExternalIntent({ actor: AGENT, jobId: space.job.id, resolution: 'delivered', receipt: { provider: 'chat', providerRef: 'space-1', url: 'https://example.org/space/1' } });
  assert.equal(core.getActivity(activityId).space.state, 'created');

  assert.throws(() => core.enqueueExternalIntent({ actor: AGENT, activityId, kind: 'payment_transfer', payload: { amountMinor: 1 } }),
    error => error.code === 'payment_not_supported');
  assert.throws(() => core.enqueueExternalIntent({ actor: AGENT, activityId, kind: 'launch_missiles' }),
    error => error.code === 'validation');
});

test('archive waits for settlement and publication, and the audit trail records every mutation', () => {
  const { core } = harness({ grants: [...grantAll(ADMIN), ...grantAll(LEAD), ...grantAll(FINANCE), ...grantAll(BOARD), ...grantAll(AGENT)] });
  const activityId = approvedActivity(core);
  core.requestFunding({ actor: LEAD, activityId, amountMinor: 1000, currency: 'USD' });
  core.approveFunding({ actor: BOARD, activityId, ceilingMinor: 1000, currency: 'USD', allocationReference: 'round#1' });
  core.reserveFunds({ actor: FINANCE, activityId, amountMinor: 1000 });
  core.recordPayment({ actor: FINANCE, activityId, amountMinor: 1000, currency: 'USD', receiptReference: 'r-1', paidBy: 'lead-1' });

  core.transitionActivity({ actor: ADMIN, activityId, to: 'preparing' });
  core.transitionActivity({ actor: ADMIN, activityId, to: 'completed' });
  core.submitOutcome({
    actor: ADMIN, activityId,
    fields: {
      actualStartAt: '2026-09-24T09:00:00Z', actualEndAt: '2026-09-24T11:00:00Z', actualLocation: 'Room 101',
      summary: 'discussion', attendance: { count: 10, basis: 'sign-in sheet' }, actualExpensesMinor: 1000,
    },
  });
  core.reviewOutcome({ actor: AGENT, activityId, decision: 'accepted' });
  core.transitionActivity({ actor: ADMIN, activityId, to: 'accepted' });

  assert.throws(() => core.transitionActivity({ actor: ADMIN, activityId, to: 'archived' }),
    error => error.code === 'archive_blocked' && error.details.blockers.includes('finance:paid'));

  core.recordSettlement({ actor: FINANCE, activityId, actualMinor: 1000, unusedReleasedMinor: 0 });
  assert.equal(core.transitionActivity({ actor: ADMIN, activityId, to: 'archived' }).state, 'archived');

  const audit = core.listAuditEvents({ actor: ADMIN, activityId });
  assert.equal(audit.at(-1).action, 'activity.transition');
  assert.equal(audit.every(event => typeof event.at === 'string' && typeof event.actorId === 'string'), true);
});

test('a rejected mutation changes neither state nor audit', () => {
  const { core } = harness({ grants: grantAll(ADMIN) });
  const activityId = approvedActivity(core);
  const before = core.snapshot();
  assert.throws(() => core.transitionActivity({ actor: ADMIN, activityId, to: 'completed' }), error => error.code === 'invalid_transition');
  assert.deepEqual(core.snapshot(), before);
});

test('a store port keeps ids, audit and state across cores', () => {
  const grants = grantAll(ADMIN);
  const store = { data: null, load() { return this.data; }, save(state) { this.data = structuredClone(state); } };
  const first = createOperationsCore({ now: () => '2026-09-24T10:00:00Z', authorize: createCapabilityAuthorizer(grants), store });
  const activityId = approvedActivity(first);
  first.addTask({ actor: ADMIN, activityId, title: 'venue' });

  const second = createOperationsCore({ now: () => '2026-09-24T11:00:00Z', authorize: createCapabilityAuthorizer(grants), store });
  assert.equal(second.getActivity(activityId).state, 'approved');
  assert.equal(second.listTasks(activityId).length, 1);
  assert.equal(second.addTask({ actor: ADMIN, activityId, title: 'speaker' }).id, 'task-2', 'ids continue after reload');
  assert.equal(second.listAuditEvents({ actor: ADMIN }).length, 6);
});

test('the shared ledger adapts through createLedgerStore when present', async t => {
  const ledgerModule = await import('../plugins/rein-operations/ledger.ts').catch(() => null);
  if (!ledgerModule?.createLedger) {
    t.skip('shared ledger module is not available');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'rein-activities-'));
  try {
    const file = join(dir, 'state.json');
    const grants = grantAll(ADMIN);
    const storeFor = () => createLedgerStore(ledgerModule.createLedger(file), { key: 'activities' });
    const first = createOperationsCore({ now: () => '2026-09-24T10:00:00Z', authorize: createCapabilityAuthorizer(grants), store: storeFor() });
    const activityId = approvedActivity(first);
    first.addTask({ actor: ADMIN, activityId, title: 'venue' });

    const second = createOperationsCore({ now: () => '2026-09-24T11:00:00Z', authorize: createCapabilityAuthorizer(grants), store: storeFor() });
    assert.equal(second.getActivity(activityId).state, 'approved');
    assert.equal(second.listTasks(activityId).length, 1);
    assert.equal(second.addTask({ actor: ADMIN, activityId, title: 'speaker' }).id, 'task-2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two stale operations cores cannot silently overwrite each other in the ledger', async () => {
  const { createLedger } = await import('../plugins/rein-operations/ledger.ts');
  const dir = mkdtempSync(join(tmpdir(), 'rein-activities-conflict-'));
  try {
    const file = join(dir, 'state.json');
    const grants = grantAll(ADMIN);
    const makeCore = () => createOperationsCore({
      now: () => '2026-09-24T10:00:00Z', authorize: createCapabilityAuthorizer(grants),
      store: createLedgerStore(createLedger(file), { key: 'activities' }),
    });
    const first = makeCore();
    const stale = makeCore();
    const created = first.createActivity({ actor: ADMIN, title: 'First', eventType: 'meetup', leadId: LEAD.id });
    assert.throws(() => stale.createActivity({ actor: ADMIN, title: 'Second', eventType: 'meetup', leadId: LEAD.id }),
      error => error.code === 'storage_conflict');
    assert.equal(makeCore().getActivity(created.id).title, 'First');
    assert.equal(stale.snapshot().sequence, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F4: completing a task cancels its linked future reminders', () => {
  const { core } = harness({ grants: [...grantAll(ADMIN), ...grantAll(AGENT)] });
  const activityId = approvedActivity(core);
  const task = core.addTask({ actor: ADMIN, activityId, title: 'agenda', dueAt: '2026-09-26T00:00:00Z' });
  const linked = core.scheduleReminder({ actor: ADMIN, activityId, dueAt: '2026-09-25T10:00:00Z', taskId: task.id });
  const snoozed = core.scheduleReminder({ actor: ADMIN, activityId, dueAt: '2026-09-27T10:00:00Z', taskId: task.id });
  core.snoozeReminder({ actor: ADMIN, reminderId: snoozed.id, until: '2026-09-28T10:00:00Z' });
  const unlinked = core.scheduleReminder({ actor: ADMIN, activityId, dueAt: '2026-09-25T11:00:00Z' });

  const completed = core.completeTask({ actor: ADMIN, taskId: task.id });
  assert.equal(completed.status, 'done');
  assert.deepEqual([...completed.canceledReminders].sort(), [linked.id, snoozed.id].sort());
  const reminders = core.listReminders(activityId);
  assert.equal(reminders.find(item => item.id === linked.id).status, 'canceled');
  assert.equal(reminders.find(item => item.id === linked.id).reason, 'task_completed');
  assert.equal(reminders.find(item => item.id === snoozed.id).status, 'canceled');
  assert.equal(reminders.find(item => item.id === unlinked.id).status, 'scheduled', 'an unlinked reminder is untouched');

  const dispatch = core.dispatchDueReminders({ actor: AGENT, at: '2026-09-30T12:00:00Z', policy: { timezone: 'UTC' } });
  assert.deepEqual(dispatch.sent.map(item => item.reminderId), [unlinked.id]);
});

test('F5: reminder dispatch needs an explicit timezone and applies it to quiet hours', () => {
  const { core } = harness({ grants: [...grantAll(ADMIN), ...grantAll(AGENT)] });
  const activityId = approvedActivity(core);
  core.scheduleReminder({ actor: ADMIN, activityId, dueAt: '2026-09-25T02:00:00Z' });

  assert.throws(() => core.dispatchDueReminders({ actor: AGENT, at: '2026-09-25T02:00:00Z' }),
    error => error.code === 'timezone_required', 'there is no implicit organization timezone');
  assert.throws(() => core.dispatchDueReminders({ actor: AGENT, at: '2026-09-25T02:00:00Z', policy: { timezone: 'Mars/Olympus_Mons' } }),
    error => error.code === 'timezone_required');

  // 02:00Z is inside 21:00-08:00 quiet hours in UTC, but 19:00 local in Los Angeles.
  const utc = core.dispatchDueReminders({ actor: AGENT, at: '2026-09-25T02:00:00Z', policy: { timezone: 'UTC' } });
  assert.deepEqual(utc.deferred.map(item => item.reason), ['quiet_hours']);
  assert.deepEqual(utc.sent, []);
  const pacific = core.dispatchDueReminders({ actor: AGENT, at: '2026-09-25T02:00:00Z', policy: { timezone: 'America/Los_Angeles' } });
  assert.deepEqual(pacific.deferred, []);
  assert.equal(pacific.sent.length, 1);
});

test('F2: one canonical article per activity, and archive sees every pending publication', () => {
  const { core } = harness({ grants: [...grantAll(ADMIN), ...grantAll(LEAD), ...grantAll(AGENT)] });
  const activityId = approvedActivity(core);
  core.transitionActivity({ actor: ADMIN, activityId, to: 'preparing' });
  core.transitionActivity({ actor: ADMIN, activityId, to: 'completed' });

  const first = core.createPublicationDraft({ actor: ADMIN, activityId, title: 'Recap', body: 'First.', channels: ['website'] });
  assert.throws(() => core.createPublicationDraft({ actor: ADMIN, activityId, title: 'Recap v2', body: 'Second.', channels: ['website'] }),
    error => error.code === 'publication_exists', 'a live publication blocks a second draft');
  core.withdrawPublication({ actor: ADMIN, publicationId: first.id, reason: 'superseded' });

  const second = core.createPublicationDraft({ actor: ADMIN, activityId, title: 'Recap v2', body: 'Second.', channels: ['website'] });
  core.requestFactConfirmation({ actor: ADMIN, publicationId: second.id });
  core.recordConsent({ actor: LEAD, activityId, channel: 'website', granted: true });
  assert.equal(core.confirmFacts({ actor: LEAD, publicationId: second.id }).confirmed, true);

  core.submitOutcome({
    actor: ADMIN, activityId,
    fields: {
      actualStartAt: '2026-09-24T09:00:00Z', actualEndAt: '2026-09-24T11:00:00Z', actualLocation: 'Room 101',
      summary: 'discussion', attendance: { count: 10, basis: 'sign-in sheet' }, actualExpensesMinor: 0,
    },
  });
  core.reviewOutcome({ actor: AGENT, activityId, decision: 'accepted' });
  core.transitionActivity({ actor: ADMIN, activityId, to: 'accepted' });
  assert.throws(() => core.transitionActivity({ actor: ADMIN, activityId, to: 'archived' }),
    error => error.code === 'archive_blocked' && error.details.blockers.includes('publication:ready'),
    'a second pending publication is not invisible to archive');
  assert.equal(core.getActivityView({ activityId }).publication.id, second.id, 'the view reports the canonical publication');

  core.withdrawPublication({ actor: ADMIN, publicationId: second.id, reason: 'held back' });
  assert.equal(core.transitionActivity({ actor: ADMIN, activityId, to: 'archived' }).state, 'archived');
});

test('F3: a published link returns to the event space as its own pending intent', () => {
  const { core } = harness({ grants: [...grantAll(ADMIN), ...grantAll(LEAD), ...grantAll(AGENT)] });
  const activityId = approvedActivity(core);
  const space = core.requestActivitySpace({ actor: AGENT, activityId });
  core.recordExternalReceipt({ actor: AGENT, jobId: space.job.id, receipt: { provider: 'chat', providerRef: 'space-1', url: 'https://chat.example.org/spaces/1' } });
  assert.equal(core.getActivity(activityId).space.state, 'created');

  core.transitionActivity({ actor: ADMIN, activityId, to: 'preparing' });
  core.transitionActivity({ actor: ADMIN, activityId, to: 'completed' });
  const draft = core.createPublicationDraft({ actor: ADMIN, activityId, title: 'Recap', body: 'Facts.', channels: ['website'] });
  core.requestFactConfirmation({ actor: ADMIN, publicationId: draft.id });
  core.recordConsent({ actor: LEAD, activityId, channel: 'website', granted: true });
  assert.equal(core.confirmFacts({ actor: LEAD, publicationId: draft.id }).confirmed, true);
  const publishing = core.publishPublication({ actor: ADMIN, publicationId: draft.id });
  core.recordExternalReceipt({ actor: ADMIN, jobId: publishing.job.id, receipt: { provider: 'website', url: 'https://example.org/events/9' } });

  const live = core.getPublication(draft.id);
  assert.equal(live.state, 'published');
  assert.equal(live.url, 'https://example.org/events/9');
  assert.equal(live.linkReturned, false, 'the core never claims the link reached the event space');
  assert.equal(live.linkDeliveryState, 'pending');
  const linkIntent = core.listExternalIntents({ actor: ADMIN, activityId }).find(job => job.kind === 'post_article_link');
  assert.equal(linkIntent.state, 'pending');
  assert.equal(linkIntent.delivered, false);
  assert.deepEqual(linkIntent.payload, { audience: 'chat.event_space', publicationId: draft.id, url: 'https://example.org/events/9' });

  core.recordExternalReceipt({ actor: AGENT, jobId: linkIntent.id, receipt: { provider: 'chat', providerRef: 'message-9' } });
  assert.equal(core.getPublication(draft.id).linkReturned, true);
  assert.equal(core.getPublication(draft.id).linkDeliveryState, 'delivered');
});

test('F3: linkReturnedAt is stamped from the delivered link receipt, never earlier', () => {
  const { core, setClock } = harness({ grants: [...grantAll(ADMIN), ...grantAll(LEAD), ...grantAll(AGENT)] });
  const { publicationId, linkIntent } = pendingArticleLink(core);
  assert.equal(core.getPublication(publicationId).linkReturned, false);
  assert.equal(core.getPublication(publicationId).linkReturnedAt, null, 'a pending link intent has returned nothing');
  assert.equal(core.getPublication(publicationId).linkDeliveryState, 'pending');
  assert.equal(core.snapshot().publications[publicationId].linkReturnedAt, null, 'persisted state stays empty before the receipt');

  setClock('2026-09-24T11:15:00.000Z');
  core.recordExternalReceipt({ actor: AGENT, jobId: linkIntent.id, receipt: { provider: 'chat', providerRef: 'message-11' } });
  const returned = core.getPublication(publicationId);
  assert.equal(returned.linkReturned, true);
  assert.equal(returned.linkReturnedAt, '2026-09-24T11:15:00.000Z');
  assert.equal(returned.linkReturnedAt, core.getExternalIntent({ actor: ADMIN, jobId: linkIntent.id }).providerReceipt.at);
  assert.equal(core.snapshot().publications[publicationId].linkReturnedAt, '2026-09-24T11:15:00.000Z', 'persisted state carries the receipt time');
});

test('F3: uncertain reconciliation stamps linkReturnedAt only when delivery is proven', () => {
  const { core, setClock } = harness({ grants: [...grantAll(ADMIN), ...grantAll(LEAD), ...grantAll(AGENT)] });
  const { publicationId, linkIntent } = pendingArticleLink(core);

  setClock('2026-09-24T12:00:00Z');
  core.markExternalIntentUncertain({ actor: AGENT, jobId: linkIntent.id, note: 'chat timed out after send' });
  assert.equal(core.getPublication(publicationId).linkReturned, false);
  assert.equal(core.getPublication(publicationId).linkReturnedAt, null, 'an uncertain link intent has returned nothing');
  assert.equal(core.getPublication(publicationId).linkDeliveryState, 'uncertain');
  assert.throws(() => core.reconcileExternalIntent({ actor: AGENT, jobId: linkIntent.id, resolution: 'delivered', receipt: { provider: 'chat' } }),
    error => error.code === 'receipt_required');
  assert.equal(core.getPublication(publicationId).linkReturnedAt, null, 'a rejected reconciliation stamps nothing');

  setClock('2026-09-24T12:05:00.000Z');
  core.reconcileExternalIntent({ actor: AGENT, jobId: linkIntent.id, resolution: 'delivered', receipt: { provider: 'chat', providerRef: 'message-12' } });
  const returned = core.getPublication(publicationId);
  assert.equal(returned.linkReturned, true);
  assert.equal(returned.linkReturnedAt, '2026-09-24T12:05:00.000Z');
  assert.equal(core.snapshot().publications[publicationId].linkReturnedAt, '2026-09-24T12:05:00.000Z');
});

test('F3: a failed reconciliation never stamps linkReturnedAt', () => {
  const { core, setClock } = harness({ grants: [...grantAll(ADMIN), ...grantAll(LEAD), ...grantAll(AGENT)] });
  const { publicationId, linkIntent } = pendingArticleLink(core);

  setClock('2026-09-24T13:00:00Z');
  core.markExternalIntentUncertain({ actor: AGENT, jobId: linkIntent.id, note: 'timeout' });
  core.reconcileExternalIntent({ actor: AGENT, jobId: linkIntent.id, resolution: 'failed' });
  assert.equal(core.getPublication(publicationId).linkReturned, false);
  assert.equal(core.getPublication(publicationId).linkReturnedAt, null);
  assert.equal(core.getPublication(publicationId).linkDeliveryState, 'failed');
  assert.equal(core.snapshot().publications[publicationId].linkReturnedAt, null);
});

test('F3: no event space means no fabricated link intent', () => {
  const { core } = harness({ grants: [...grantAll(ADMIN), ...grantAll(LEAD)] });
  const activityId = approvedActivity(core);
  core.transitionActivity({ actor: ADMIN, activityId, to: 'preparing' });
  core.transitionActivity({ actor: ADMIN, activityId, to: 'completed' });
  const draft = core.createPublicationDraft({ actor: ADMIN, activityId, title: 'Recap', body: 'Facts.', channels: ['website'] });
  core.requestFactConfirmation({ actor: ADMIN, publicationId: draft.id });
  core.recordConsent({ actor: LEAD, activityId, channel: 'website', granted: true });
  core.confirmFacts({ actor: LEAD, publicationId: draft.id });
  const publishing = core.publishPublication({ actor: ADMIN, publicationId: draft.id });
  core.recordExternalReceipt({ actor: ADMIN, jobId: publishing.job.id, receipt: { provider: 'website', url: 'https://example.org/events/10' } });

  assert.equal(core.getPublication(draft.id).state, 'published');
  assert.equal(core.getPublication(draft.id).linkDeliveryState, 'not_queued');
  assert.equal(core.listExternalIntents({ actor: ADMIN, activityId }).some(job => job.kind === 'post_article_link'), false);
});

test('F6: approval edits cannot silently drop below reserved or paid, and are audited', () => {
  const { core } = harness({ grants: [...grantAll(ADMIN), ...grantAll(LEAD), ...grantAll(FINANCE), ...grantAll(BOARD)] });
  const activityId = approvedActivity(core);
  core.requestFunding({ actor: LEAD, activityId, amountMinor: 10000, currency: 'USD' });
  core.approveFunding({ actor: BOARD, activityId, ceilingMinor: 10000, currency: 'USD', allocationReference: 'round#1' });
  core.reserveFunds({ actor: FINANCE, activityId, amountMinor: 10000 });
  core.recordPayment({ actor: FINANCE, activityId, amountMinor: 4000, currency: 'USD', receiptReference: 'r-1', paidBy: 'lead-1' });

  assert.throws(() => core.approveFunding({ actor: BOARD, activityId, ceilingMinor: 3000, currency: 'USD', allocationReference: 'round#1-revised' }),
    error => error.code === 'ceiling_below_committed', 'a later approval cannot drop below reserved or paid');
  assert.throws(() => core.approveFunding({ actor: BOARD, activityId, ceilingMinor: 12000, currency: 'EUR', allocationReference: 'round#1-revised' }),
    error => error.code === 'currency_mismatch');

  const raised = core.approveFunding({ actor: BOARD, activityId, ceilingMinor: 12000, currency: 'USD', allocationReference: 'round#1-revised' });
  assert.equal(raised.approvedCeilingMinor, 12000);
  assert.equal(raised.reservedMinor, 10000, 'a ceiling edit never touches the reservation');
  const adjustment = raised.history.find(entry => entry.event === 'ceiling_adjusted');
  assert.deepEqual({ from: adjustment.fromCeilingMinor, to: adjustment.ceilingMinor }, { from: 10000, to: 12000 });
  assert.equal(core.listAuditEvents({ actor: ADMIN, activityId }).some(event => event.action === 'finance.approve_adjust'), true);
});

test('F1: an overspend is frozen, then authorized and reserved by separate actors', () => {
  const APPROVER = { id: 'board-approver', kind: 'human' };
  const RESERVER = { id: 'finance-reserver', kind: 'human' };
  const { core } = harness({
    grants: [
      ...grantAll(ADMIN),
      { actorId: LEAD.id, capability: 'finance.request' },
      { actorId: APPROVER.id, capability: 'finance.approve' },
      { actorId: RESERVER.id, capability: 'finance.reserve' },
      { actorId: RESERVER.id, capability: 'finance.record_payment' },
      { actorId: RESERVER.id, capability: 'finance.record_settlement' },
    ],
  });
  const activityId = approvedActivity(core);
  core.requestFunding({ actor: LEAD, activityId, amountMinor: 10000, currency: 'USD' });
  core.approveFunding({ actor: APPROVER, activityId, ceilingMinor: 10000, currency: 'USD', allocationReference: 'round#1' });
  core.reserveFunds({ actor: RESERVER, activityId, amountMinor: 10000 });
  core.recordPayment({ actor: RESERVER, activityId, amountMinor: 10000, currency: 'USD', receiptReference: 'r-1', paidBy: 'lead-1' });
  const flagged = core.recordSettlement({ actor: RESERVER, activityId, actualMinor: 13000, unusedReleasedMinor: 0, notes: 'late taxi receipt' });
  assert.equal(flagged.state, 'awaiting_settlement');
  assert.equal(flagged.pendingSettlementMinor, 3000);
  assert.equal(core.getFinance(activityId).actualMinor, 13000);

  assert.throws(() => core.recordSettlement({ actor: RESERVER, activityId, actualMinor: 10000, unusedReleasedMinor: 0, notes: 'pretend it was fine' }),
    error => error.code === 'overspend_unresolved', 'a second settlement may not rewrite the recorded actual');
  assert.equal(core.getFinance(activityId).actualMinor, 13000, 'the recorded actual is never falsified');

  // Approval stays a Board decision: the finance reserver cannot authorize an overspend.
  assert.throws(() => core.approveOverspend({ actor: RESERVER, activityId, amountMinor: 3000, currency: 'USD', allocationReference: 'round#1-topup' }),
    error => error.code === 'unauthorized', 'a reserve-only actor cannot authorize an overspend');
  assert.throws(() => core.approveOverspend({ actor: APPROVER, activityId, amountMinor: 5000, currency: 'USD', allocationReference: 'round#1-topup' }),
    error => error.code === 'overspend_mismatch');

  const authorized = core.approveOverspend({ actor: APPROVER, activityId, amountMinor: 3000, currency: 'USD', allocationReference: 'round#1-topup', notes: 'Board approved the overrun' });
  assert.equal(authorized.overspendAuthorized, true);
  assert.equal(authorized.state, 'awaiting_settlement', 'approval alone does not move the finance state');
  assert.equal(authorized.approvedCeilingMinor, 13000, 'approval raises the authorized ceiling');
  assert.equal(authorized.reservedMinor, 10000, 'approval reserves nothing');
  assert.equal(authorized.pendingSettlementMinor, 3000, 'the overspend stays pending until it is reserved');
  assert.throws(() => core.approveOverspend({ actor: APPROVER, activityId, amountMinor: 3000, currency: 'USD', allocationReference: 'round#1-again' }),
    error => error.code === 'overspend_already_authorized', 'one authorization per pending overspend');

  // Reservation stays a finance action: the approver cannot reserve, and nothing is payable yet.
  assert.throws(() => core.reserveFunds({ actor: APPROVER, activityId, amountMinor: 3000 }),
    error => error.code === 'unauthorized', 'the Board approver cannot reserve funds');
  assert.throws(() => core.recordPayment({ actor: RESERVER, activityId, amountMinor: 3000, currency: 'USD', receiptReference: 'r-2', paidBy: 'lead-1' }),
    error => error.code === 'payment_exceeds_reservation', 'nothing can be paid before it is reserved');
  assert.throws(() => core.recordSettlement({ actor: RESERVER, activityId, actualMinor: 13000, unusedReleasedMinor: 0, notes: 'still unfunded' }),
    error => error.code === 'overspend_unresolved', 'an authorized but unreserved overspend is still unresolved');

  const reserved = core.reserveFunds({ actor: RESERVER, activityId, amountMinor: 3000 });
  assert.equal(reserved.reservedMinor, 13000);
  assert.equal(reserved.pendingSettlementMinor, 0, 'the pending overspend clears only once it is reserved');
  assert.equal(reserved.pendingOverspendAuthorization, null);

  assert.throws(() => core.recordSettlement({ actor: RESERVER, activityId, actualMinor: 13000, unusedReleasedMinor: 0, notes: 'not paid yet' }),
    error => error.code === 'unpaid_obligation', 'a reservation is not a payment');
  core.recordPayment({ actor: RESERVER, activityId, amountMinor: 3000, currency: 'USD', receiptReference: 'r-2', paidBy: 'lead-1' });
  assert.equal(core.getFinance(activityId).state, 'paid');
  const settled = core.recordSettlement({ actor: RESERVER, activityId, actualMinor: 13000, unusedReleasedMinor: 0, notes: 'reimbursed' });
  assert.equal(settled.state, 'settled');
  assert.equal(settled.actualMinor, 13000);

  const audit = core.listAuditEvents({ actor: ADMIN, activityId });
  assert.equal(audit.some(event => event.action === 'finance.approve_overspend'), true);
  assert.equal(audit.filter(event => event.action === 'finance.reserve').length, 2, 'the top-up is its own reservation');
});

test('F1: a reservation cannot exceed the authorized overspend', () => {
  const APPROVER = { id: 'board-approver', kind: 'human' };
  const RESERVER = { id: 'finance-reserver', kind: 'human' };
  const { core } = harness({
    grants: [
      ...grantAll(ADMIN),
      { actorId: LEAD.id, capability: 'finance.request' },
      { actorId: APPROVER.id, capability: 'finance.approve' },
      { actorId: RESERVER.id, capability: 'finance.reserve' },
      { actorId: RESERVER.id, capability: 'finance.record_payment' },
      { actorId: RESERVER.id, capability: 'finance.record_settlement' },
    ],
  });
  const activityId = approvedActivity(core);
  core.requestFunding({ actor: LEAD, activityId, amountMinor: 10000, currency: 'USD' });
  core.approveFunding({ actor: APPROVER, activityId, ceilingMinor: 10000, currency: 'USD', allocationReference: 'round#1' });
  core.reserveFunds({ actor: RESERVER, activityId, amountMinor: 10000 });
  core.recordPayment({ actor: RESERVER, activityId, amountMinor: 10000, currency: 'USD', receiptReference: 'r-1', paidBy: 'lead-1' });
  core.recordSettlement({ actor: RESERVER, activityId, actualMinor: 13000, unusedReleasedMinor: 0, notes: 'late taxi receipt' });

  assert.throws(() => core.reserveFunds({ actor: RESERVER, activityId, amountMinor: 3000 }),
    error => error.code === 'overspend_authorization_required', 'an unresolved overspend must be authorized before it is reserved');
  core.approveOverspend({ actor: APPROVER, activityId, amountMinor: 3000, currency: 'USD', allocationReference: 'round#1-topup' });
  assert.throws(() => core.reserveFunds({ actor: RESERVER, activityId, amountMinor: 5000 }),
    error => error.code === 'overspend_authorization_exceeded');

  const partial = core.reserveFunds({ actor: RESERVER, activityId, amountMinor: 1000 });
  assert.equal(partial.reservedMinor, 11000);
  assert.equal(partial.pendingSettlementMinor, 2000, 'a partial top-up leaves settlement blocked');
  assert.equal(partial.pendingOverspendAuthorization.amountMinor, 2000);
  assert.throws(() => core.recordSettlement({ actor: RESERVER, activityId, actualMinor: 13000, unusedReleasedMinor: 0, notes: 'partially funded' }),
    error => error.code === 'overspend_unresolved');
});

test('F7: settlement cannot close an obligation that is still unpaid', () => {
  const { core } = harness({ grants: [...grantAll(ADMIN), ...grantAll(LEAD), ...grantAll(FINANCE), ...grantAll(BOARD)] });
  const activityId = approvedActivity(core);
  core.requestFunding({ actor: LEAD, activityId, amountMinor: 10000, currency: 'USD' });
  core.approveFunding({ actor: BOARD, activityId, ceilingMinor: 10000, currency: 'USD', allocationReference: 'round#1' });
  core.reserveFunds({ actor: FINANCE, activityId, amountMinor: 10000 });
  core.recordPayment({ actor: FINANCE, activityId, amountMinor: 4000, currency: 'USD', receiptReference: 'r-1', paidBy: 'lead-1' });
  assert.equal(core.getFinance(activityId).state, 'partially_paid');

  assert.throws(() => core.recordSettlement({ actor: FINANCE, activityId, actualMinor: 10000, unusedReleasedMinor: 0 }),
    error => error.code === 'unpaid_obligation', 'the unpaid part of the reservation is still an obligation');
  assert.throws(() => core.recordSettlement({ actor: FINANCE, activityId, actualMinor: 6000, unusedReleasedMinor: 4000 }),
    error => error.code === 'unpaid_obligation');
  assert.equal(core.getFinance(activityId).state, 'partially_paid', 'a rejected settlement changes nothing');

  const settled = core.recordSettlement({ actor: FINANCE, activityId, actualMinor: 4000, unusedReleasedMinor: 6000, notes: 'partial spend' });
  assert.equal(settled.state, 'settled');
  assert.equal(settled.paidMinor, 4000);
});

test('the recommended checklist is a proposal the lead can edit', () => {
  assert.deepEqual(recommendedChecklist('paper_discussion').map(item => item.title), [
    'venue', 'speaker', 'agenda', 'publicity', 'registration', 'supplies', 'on_site', 'participant_support', 'outcome_collection',
  ]);
  assert.ok(recommendedChecklist('unknown-type').length > 0);
});
