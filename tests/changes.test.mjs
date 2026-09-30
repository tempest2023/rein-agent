import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from '../plugins/rein-operations/ledger.ts';
import {
  createChangeService,
  createChangeAuthorizer,
  createChangeStore,
  classifyChange,
  planChange,
  normalizeActivityView,
  CHANGE_CAPABILITIES,
  CHANGE_INTENT_KINDS,
  EXTERNAL_DELIVERY,
  ChangeError,
} from '../plugins/rein-operations/changes.ts';

const LEAD = { id: 'lead-1', memberId: 'member-lead' };
const NEXT = { id: 'next-1', memberId: 'member-next' };
const HANDLER = { id: 'handler-1', memberId: 'member-handler' };
const BOARD = { id: 'board-1', memberId: 'member-board' };
const AGENT = { id: 'rein-agent' };

const POLICY = { participantAudience: 'chat:event-participants', handlerRef: 'role:handlers', financeHandlerRef: 'role:finance' };

function view(overrides = {}) {
  return {
    id: 'activity-1',
    title: 'Agent paper discussion',
    leadId: 'member-lead',
    state: 'preparing',
    registration: { state: 'open', currentCount: 12 },
    scheduledReminderIds: ['reminder-1', 'reminder-2'],
    budget: { requestedAmountMinor: 0, currency: 'USD', approvedCeilingMinor: 0 },
    finance: { requestedMinor: 0, approvedCeilingMinor: 0, reservedMinor: 0, paidMinor: 0, actualMinor: null, currency: 'USD' },
    ...overrides,
  };
}

const FUNDED = view({
  budget: { requestedAmountMinor: 50000, currency: 'USD', approvedCeilingMinor: 50000 },
  finance: { requestedMinor: 50000, approvedCeilingMinor: 50000, reservedMinor: 50000, paidMinor: 20000, actualMinor: null, currency: 'USD' },
});

function harness({ grants = [], verifyContributor = () => true, activity = view(), policy = POLICY, store = null } = {}) {
  let clock = '2026-09-24T10:00:00Z';
  let current = activity;
  const service = createChangeService({
    now: () => clock,
    authorize: createChangeAuthorizer(grants),
    verifyContributor,
    getActivity: () => current,
    policy,
    store,
  });
  return { service, setClock: value => { clock = value; }, setActivity: value => { current = value; } };
}

const grant = (actor, capabilities = CHANGE_CAPABILITIES) => capabilities.map(capability => ({ actorId: actor.id, capability }));

test('change classes come from the field and an unknown field blocks instead of defaulting', () => {
  const ordinary = classifyChange({ fields: { 'program.agenda': 'Two papers instead of three' } });
  assert.deepEqual(ordinary.classes, ['ordinary']);
  assert.equal(ordinary.requiresLeadConfirmation, true);
  assert.equal(ordinary.requiresGovernance, false);

  const material = classifyChange({ fields: { 'schedule.startAt': '2026-10-02T18:00:00Z' } });
  assert.deepEqual(material.classes, ['material']);
  assert.ok(material.surfaces.includes('reminders'));
  assert.ok(material.surfaces.includes('registration_page'));

  const earlier = classifyChange({ fields: { 'schedule.durationMinutes': 45 } });
  assert.deepEqual(earlier.classes, ['material']);

  const capacity = classifyChange({ fields: { 'capacity.expectedAttendance': 40 } });
  assert.deepEqual(capacity.classes, ['material']);
  assert.ok(!capacity.surfaces.includes('reminders'));

  const nature = classifyChange({ fields: { format: 'hybrid' } });
  assert.equal(nature.requiresGovernance, true);
  assert.equal(nature.scopeReason, 'event_nature_change');

  const risk = classifyChange({ fields: { 'risks.notes': 'New accessibility requirement' } });
  assert.equal(risk.scopeReason, 'new_exception');

  const unknown = classifyChange({ fields: { 'venue.parking': 'free' } });
  assert.deepEqual(unknown.classes, ['unclassified']);
  assert.equal(unknown.blockers[0].code, 'unclassified_change_field');

  const funding = classifyChange({ fields: { 'budget.requestedAmountMinor': 80000 }, activity: view() });
  assert.equal(funding.requiresGovernance, true);
  assert.equal(funding.scopeReason, 'additional_funding');
  assert.deepEqual(funding.funding, { previousMinor: 0, requestedMinor: 80000, currency: 'USD' });

  const reduction = classifyChange({ fields: { 'budget.requestedAmountMinor': 30000 }, activity: FUNDED });
  assert.deepEqual(reduction.classes, ['material']);
  assert.equal(reduction.requiresGovernance, false);

  const noPrevious = classifyChange({ fields: { 'budget.requestedAmountMinor': 100 } });
  assert.deepEqual(noPrevious.blockers.map(blocker => blocker.code), ['previous_value_required']);

  assert.throws(() => classifyChange({ fields: { leadId: 'member-next' } }),
    error => error instanceof ChangeError && error.code === 'lead_change_requires_handover');
  assert.throws(() => classifyChange({ fields: {} }), error => error.code === 'validation');
});

test('the activity view has to be truthful; missing collections are rejected', () => {
  assert.throws(() => normalizeActivityView({ id: 'a', leadId: 'm', state: 'preparing', registration: { state: 'open' } }),
    error => error.code === 'activity_view_incomplete');
  assert.throws(() => normalizeActivityView(view({ registration: { state: 'maybe' } })), error => error.code === 'validation');
  assert.throws(() => normalizeActivityView(view({ scheduledReminderIds: ['ok', ' '] })), error => error.code === 'activity_view_incomplete');
  assert.throws(() => normalizeActivityView(view({ finance: { requestedMinor: 10, approvedCeilingMinor: 0, reservedMinor: 0, paidMinor: 0, currency: null } })),
    error => error.code === 'validation');
  assert.ok(normalizeActivityView(view()).finance.currency === 'USD');
});

test('nothing is authorized without an explicit grant', () => {
  const { service } = harness();
  assert.deepEqual(service.authorize({ actor: LEAD, capability: 'change.request' }), { allowed: false, reason: 'no_grant' });
  assert.throws(() => service.requestChange({ actor: LEAD, activityId: 'activity-1', fields: { 'program.agenda': 'x' }, idempotencyKey: 'k1' }),
    error => error.code === 'unauthorized');
  const noSource = createChangeService({ authorize: () => ({ allowed: true }), verifyContributor: () => true });
  assert.throws(() => noSource.requestChange({ actor: LEAD, activityId: 'activity-1', fields: { 'program.agenda': 'x' }, idempotencyKey: 'k1' }),
    error => error.code === 'activity_source_unavailable');
});

test('a time change requested by someone other than the lead waits for the lead and notifies nobody', () => {
  const { service } = harness({ grants: [...grant(AGENT, ['change.request']), ...grant(HANDLER, ['change.read'])] });
  const result = service.requestChange({
    actor: AGENT, activityId: 'activity-1', fields: { 'schedule.startAt': '2026-10-02T18:00:00Z' },
    reason: 'Venue unavailable that evening', idempotencyKey: 'message-1',
  });
  assert.equal(result.replayed, false);
  assert.equal(result.change.state, 'awaiting_lead_confirmation');
  assert.deepEqual(result.intents, []);
  assert.deepEqual(result.instructions, { activity: [], reminders: [], registration: [], finance: [], grants: [] });
  assert.ok(result.blockers.some(blocker => blocker.code === 'lead_confirmation_required'));
  assert.deepEqual(service.listIntents({ actor: HANDLER, activityId: 'activity-1' }), []);
});

test('the lead confirms a time change and every effect stays a pending, undelivered intent', () => {
  const grants = [...grant(AGENT, ['change.request', 'change.read']), ...grant(LEAD, ['change.confirm', 'change.read', 'change.record_delivery'])];
  const { service } = harness({ grants });
  const requested = service.requestChange({
    actor: AGENT, activityId: 'activity-1', fields: { 'schedule.startAt': '2026-10-02T18:00:00Z' },
    reason: 'Venue unavailable that evening', idempotencyKey: 'message-1',
  });
  const confirmed = service.confirmChange({
    actor: LEAD, changeId: requested.change.id, statement: 'I confirm the new start time as the activity lead', idempotencyKey: 'message-2',
  });
  assert.equal(confirmed.change.state, 'applied');
  assert.deepEqual(confirmed.change.plan.applyFields, { 'schedule.startAt': '2026-10-02T18:00:00Z' });
  assert.deepEqual(confirmed.intents.map(intent => intent.kind).sort(), [
    'adjust_reminders', 'notify_participants', 'post_announcement', 'update_registration_page', 'update_standing_summary',
  ]);
  assert.ok(confirmed.intents.every(intent => intent.state === 'pending' && intent.delivery === EXTERNAL_DELIVERY && intent.receipt === null));
  assert.ok(confirmed.intents.every(intent => CHANGE_INTENT_KINDS.includes(intent.kind)));
  assert.deepEqual(confirmed.instructions.reminders, [{ action: 'reschedule', reminderIds: ['reminder-1', 'reminder-2'], reason: 'schedule_changed' }]);
  assert.equal(confirmed.instructions.registration[0].action, 'update_page');
  assert.deepEqual(confirmed.instructions.activity[0], { action: 'update_fields', fields: { 'schedule.startAt': '2026-10-02T18:00:00Z' } });
  const stored = service.listIntents({ actor: AGENT, activityId: 'activity-1' });
  assert.equal(stored.length, 5);

  // An intent is not a notification until an adapter records a real provider receipt.
  assert.throws(() => service.recordIntentReceipt({ actor: LEAD, intentId: stored[0].id, receipt: {} }), error => error.code === 'validation');
  const recorded = service.recordIntentReceipt({ actor: LEAD, intentId: stored[0].id, receipt: { reference: 'chat-message-99' } });
  assert.equal(recorded.state, 'delivered');
  assert.equal(recorded.receipt.reference, 'chat-message-99');
});

test('a repeated request with the same idempotency key replays instead of duplicating effects', () => {
  const grants = [...grant(AGENT, ['change.request', 'change.read']), ...grant(LEAD, ['change.confirm'])];
  const { service } = harness({ grants });
  const first = service.requestChange({ actor: AGENT, activityId: 'activity-1', fields: { 'location.venue': 'Room 305' }, idempotencyKey: 'message-7' });
  const replay = service.requestChange({ actor: AGENT, activityId: 'activity-1', fields: { 'location.venue': 'Room 305' }, idempotencyKey: 'message-7' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.change.id, first.change.id);
  assert.equal(service.listChanges({ actor: AGENT, activityId: 'activity-1' }).length, 1);
  assert.throws(() => service.confirmChange({ actor: LEAD, changeId: first.change.id, statement: 'x', idempotencyKey: 'message-7' }),
    error => error.code === 'idempotency_key_reused');
  assert.throws(() => service.requestChange({ actor: AGENT, activityId: 'activity-1', fields: { 'location.venue': 'Room 305' } }),
    error => error.code === 'validation');
});

test('confirmation fails without a statement, from a non-lead, or when the lead is not a Contributor', () => {
  const grants = [...grant(AGENT, ['change.request']), ...grant(LEAD, ['change.confirm']), ...grant(HANDLER, ['change.confirm'])];
  const { service } = harness({ grants });
  const requested = service.requestChange({ actor: AGENT, activityId: 'activity-1', fields: { 'capacity.expectedAttendance': 40 }, idempotencyKey: 'm1' });
  assert.throws(() => service.confirmChange({ actor: LEAD, changeId: requested.change.id, statement: '   ', idempotencyKey: 'm2' }),
    error => error.code === 'confirmation_rejected' && error.details.blockers.some(blocker => blocker.code === 'confirmation_statement_required'));
  assert.throws(() => service.confirmChange({ actor: HANDLER, changeId: requested.change.id, statement: 'sure', idempotencyKey: 'm3' }),
    error => error.code === 'not_activity_lead');
  const lapsed = harness({ grants: [...grant(AGENT, ['change.request']), ...grant(LEAD, ['change.confirm'])], verifyContributor: () => false });
  const viaAgent = lapsed.service.requestChange({ actor: AGENT, activityId: 'activity-1', fields: { 'capacity.expectedAttendance': 40 }, idempotencyKey: 'm4' });
  assert.throws(() => lapsed.service.confirmChange({ actor: LEAD, changeId: viaAgent.change.id, statement: 'I confirm', idempotencyKey: 'm5' }),
    error => error.code === 'confirmation_rejected' && error.details.blockers.some(blocker => blocker.code === 'lead_not_active_contributor'));
});

test('an ordinary agenda change updates records only', () => {
  const { service } = harness({ grants: [...grant(LEAD, ['change.request'])] });
  const result = service.requestChange({
    actor: LEAD, activityId: 'activity-1', fields: { 'program.agenda': 'Two papers, longer discussion' },
    reason: 'Agenda shortened', confirmation: { statement: 'I confirm this agenda change' }, idempotencyKey: 'm1',
  });
  assert.equal(result.change.state, 'applied');
  assert.deepEqual(result.intents.map(intent => intent.kind), ['update_standing_summary']);
  assert.deepEqual(result.instructions.reminders, []);
  assert.deepEqual(result.instructions.registration, []);
  assert.deepEqual(result.instructions.activity, [{ action: 'update_fields', fields: { 'program.agenda': 'Two papers, longer discussion' } }]);
});

test('additional funding pauses the change, requires a recorded decision and is never approved by the Agent', () => {
  const grants = [...grant(LEAD, ['change.request', 'change.read']), ...grant(AGENT, ['change.read']), ...grant(BOARD, ['change.record_governance_decision', 'change.read'])];
  const { service } = harness({ grants });
  const requested = service.requestChange({
    actor: LEAD, activityId: 'activity-1', fields: { 'budget.requestedAmountMinor': 80000 }, reason: 'Larger venue needed', idempotencyKey: 'm1',
  });
  assert.equal(requested.change.state, 'awaiting_governance');
  assert.deepEqual(requested.intents, []);
  assert.deepEqual(requested.pauses, [{ action: 'hold_additional_commitments', reason: 'additional_funding', fields: ['budget.requestedAmountMinor'] }]);
  assert.ok(requested.blockers.some(blocker => blocker.code === 'governance_required'));
  assert.deepEqual(requested.change.plan.classification.funding, { previousMinor: 0, requestedMinor: 80000, currency: 'USD' });

  assert.throws(() => service.recordGovernanceDecision({ actor: AGENT, changeId: requested.change.id, decision: 'approved', reference: 'board-minute-1' }),
    error => error.code === 'unauthorized');
  assert.throws(() => service.recordGovernanceDecision({ actor: BOARD, changeId: requested.change.id, decision: 'approved', idempotencyKey: 'm2' }),
    error => error.code === 'validation');
  assert.throws(() => service.recordGovernanceDecision({ actor: BOARD, changeId: requested.change.id, decision: 'approved', reference: 'board-minute-1', idempotencyKey: 'm3' }),
    error => error.code === 'approved_ceiling_required');
  assert.throws(() => service.recordGovernanceDecision({ actor: BOARD, changeId: requested.change.id, decision: 'approved', reference: 'board-minute-1', approvedCeilingMinor: 80000, idempotencyKey: 'm4' }),
    error => error.code === 'allocation_reference_required');

  const approved = service.recordGovernanceDecision({
    actor: BOARD, changeId: requested.change.id, decision: 'approved', reference: 'board-minute-1',
    approvedCeilingMinor: 80000, allocationReference: 'allocation-2026-09', idempotencyKey: 'm5',
  });
  assert.equal(approved.change.state, 'applied');
  assert.equal(approved.change.governance.decision, 'approved');
  assert.deepEqual(approved.intents.map(intent => intent.kind).sort(), ['update_finance_status', 'update_standing_summary']);
  assert.deepEqual(approved.instructions.finance, [
    { action: 'review_finance_record', fields: ['budget.requestedAmountMinor'] },
    { action: 'request_funding', amountMinor: 80000, currency: 'USD' },
    { action: 'set_approved_ceiling', amountMinor: 80000, currency: 'USD', allocationReference: 'allocation-2026-09' },
  ]);
  assert.deepEqual(approved.instructions.activity, [
    { action: 'update_fields', fields: { 'budget.requestedAmountMinor': 80000 } },
    { action: 'resume', to: 'preparing', reason: 'governance_approved' },
  ]);
  assert.equal(service.listChanges({ actor: AGENT, activityId: 'activity-1' })[0].governance.approvedCeilingMinor, 80000);
});

test('an approved nature change resumes the paused activity and tells participants', () => {
  const { service } = harness({ grants: [...grant(LEAD, ['change.request']), ...grant(BOARD, ['change.record_governance_decision'])] });
  const requested = service.requestChange({ actor: LEAD, activityId: 'activity-1', fields: { format: 'hybrid' }, idempotencyKey: 's1' });
  assert.equal(requested.change.state, 'awaiting_governance');
  assert.deepEqual(requested.pauses, [{ action: 'pause_activity', reason: 'event_nature_change', fields: ['format'] }]);
  const approved = service.recordGovernanceDecision({ actor: BOARD, changeId: requested.change.id, decision: 'approved', reference: 'board-minute-3', idempotencyKey: 's2' });
  assert.equal(approved.change.state, 'applied');
  assert.deepEqual(approved.instructions.activity, [
    { action: 'update_fields', fields: { format: 'hybrid' } },
    { action: 'resume', to: 'preparing', reason: 'governance_approved' },
  ]);
  assert.ok(approved.intents.some(intent => intent.kind === 'notify_participants'));
});

test('a rejected governance decision leaves the confirmed plan standing and notifies nobody', () => {
  const { service } = harness({ grants: [...grant(LEAD, ['change.request']), ...grant(BOARD, ['change.record_governance_decision'])] });
  const requested = service.requestChange({ actor: LEAD, activityId: 'activity-1', fields: { purpose: 'Recruit new members' }, idempotencyKey: 'r1' });
  assert.equal(requested.change.state, 'awaiting_governance');
  const rejected = service.recordGovernanceDecision({ actor: BOARD, changeId: requested.change.id, decision: 'rejected', reference: 'board-minute-2', idempotencyKey: 'r2' });
  assert.equal(rejected.change.state, 'rejected');
  assert.deepEqual(rejected.intents, []);
  assert.equal(rejected.notices[0].code, 'change_rejected');
});

test('cancellation stops reminders and registration while preserving already incurred costs', () => {
  const { service } = harness({ activity: FUNDED, grants: [...grant(LEAD, ['change.cancel', 'change.read'])] });
  const result = service.cancelActivity({ actor: LEAD, activityId: 'activity-1', reason: 'Speaker withdrew', idempotencyKey: 'c1' });
  assert.deepEqual(result.instructions.activity, [{ action: 'transition', to: 'canceled', reason: 'Speaker withdrew' }]);
  assert.deepEqual(result.instructions.reminders, [{ action: 'cancel', reminderIds: ['reminder-1', 'reminder-2'], reason: 'Speaker withdrew' }]);
  assert.equal(result.instructions.registration[0].action, 'close');
  assert.deepEqual(result.intents.map(intent => intent.kind).sort(), ['close_registration', 'notify_participants', 'update_finance_status']);
  assert.equal(result.change.finance.paidMinor, 20000);
  assert.equal(result.change.finance.releasableMinor, 30000);
  assert.equal(result.change.finance.paidFundsAreReleasable, false);
  assert.equal(result.change.outcomeRequired, true);
  assert.deepEqual(result.instructions.finance, [{ action: 'settle_incurred_costs', paidMinor: 20000, actualMinor: null, incurredMinor: null }]);

  const again = service.cancelActivity({ actor: LEAD, activityId: 'activity-1', reason: 'same reason again', idempotencyKey: 'c2' });
  assert.deepEqual(again.intents, []);
  assert.equal(again.change.id, result.change.id);
  assert.ok(again.notices.some(notice => notice.code === 'already_canceled'));
  assert.equal(service.listIntents({ actor: LEAD, activityId: 'activity-1' }).length, 3);
});

test('cancellation without a finance view reports that it cannot release or settle anything', () => {
  const { service } = harness({ activity: view({ finance: null, state: 'approved' }), grants: [...grant(LEAD, ['change.cancel'])] });
  const result = service.cancelActivity({ actor: LEAD, activityId: 'activity-1', reason: 'Weather', idempotencyKey: 'c1' });
  assert.equal(result.change.finance.status, 'unverifiable');
  assert.equal(result.change.finance.releasableMinor, null);
  assert.equal(result.change.outcomeRequired, true);
  assert.ok(result.notices.some(notice => notice.code === 'finance_view_unavailable'));
  assert.ok(result.notices.some(notice => notice.code === 'finance_handler_not_configured') === false);
});

test('cancellation by someone other than the lead needs the explicit handler capability', () => {
  const { service } = harness({ grants: [...grant(AGENT, ['change.cancel'])] });
  assert.throws(() => service.cancelActivity({ actor: AGENT, activityId: 'activity-1', reason: 'not mine', idempotencyKey: 'c1' }),
    error => error.code === 'unauthorized' && error.details.capability === 'change.cancel_as_handler');
  const { service: withHandler } = harness({ grants: [...grant(AGENT, ['change.cancel', 'change.cancel_as_handler'])] });
  assert.equal(withHandler.cancelActivity({ actor: AGENT, activityId: 'activity-1', reason: 'handler decision', idempotencyKey: 'c2' }).change.state, 'applied');
  assert.throws(() => withHandler.cancelActivity({ actor: AGENT, activityId: 'activity-1', reason: 'no key' }), error => error.code === 'validation');
  const { service: cancellingLead } = harness({ grants: [...grant(LEAD, ['change.cancel'])] });
  assert.throws(() => cancellingLead.cancelActivity({ actor: LEAD, activityId: 'activity-1', reason: 'already canceled activity' }),
    error => error.code === 'validation');
});

test('the lead field is reachable only through handover', () => {
  const { service } = harness({ grants: [...grant(HANDLER, ['change.request'])] });
  assert.throws(() => service.requestChange({ actor: HANDLER, activityId: 'activity-1', fields: { leadId: 'member-next' }, idempotencyKey: 'h0' }),
    error => error.code === 'lead_change_requires_handover');
});

test('handover requires a current Contributor and pauses the activity while it waits', () => {
  const strict = harness({ grants: [...grant(HANDLER, ['change.handover', 'change.handover_as_handler'])], verifyContributor: id => id === 'member-lead' });
  assert.throws(() => strict.service.requestHandover({ actor: HANDLER, activityId: 'activity-1', toMemberId: 'member-next', reason: 'lead unavailable', idempotencyKey: 'h1' }),
    error => error.code === 'handover_rejected' && error.details.blockers[0].code === 'handover_target_not_contributor');

  const { service } = harness({ grants: [...grant(LEAD, ['change.handover'])] });
  const requested = service.requestHandover({ actor: LEAD, activityId: 'activity-1', toMemberId: 'member-next', reason: 'personal schedule', idempotencyKey: 'h1' });
  assert.equal(requested.handover.state, 'awaiting_acceptance');
  assert.deepEqual(requested.instructions.activity, [{ action: 'pause', reason: 'lead_handover_pending' }]);
  assert.deepEqual(requested.instructions.reminders, [{ action: 'cancel', reminderIds: ['reminder-1', 'reminder-2'], reason: 'lead_handover_pending' }]);
  assert.deepEqual(requested.intents.map(intent => intent.kind), ['notify_handler']);
  assert.throws(() => service.requestHandover({ actor: LEAD, activityId: 'activity-1', toMemberId: 'member-next', reason: 'again', idempotencyKey: 'h2' }),
    error => error.code === 'handover_already_pending');

  const { service: unconfigured } = harness({ grants: [...grant(LEAD, ['change.handover'])], policy: null });
  const lonely = unconfigured.requestHandover({ actor: LEAD, activityId: 'activity-1', toMemberId: 'member-next', reason: 'personal schedule', idempotencyKey: 'h3' });
  assert.deepEqual(lonely.intents, []);
  assert.equal(lonely.notices[0].code, 'handover_handler_not_configured');
});

test('an accepted handover moves permissions, contact details and reminders to the replacement', () => {
  const { service } = harness({
    grants: [...grant(LEAD, ['change.handover']), ...grant(NEXT, ['change.accept_handover']), ...grant(HANDLER, ['change.accept_handover'])],
    verifyContributor: id => id === 'member-lead' || id === 'member-next',
  });
  const requested = service.requestHandover({ actor: LEAD, activityId: 'activity-1', toMemberId: 'member-next', reason: 'personal schedule', idempotencyKey: 'h1' });
  assert.throws(() => service.acceptHandover({ actor: HANDLER, handoverId: requested.handover.id, statement: 'I take it', idempotencyKey: 'h2' }),
    error => error.code === 'not_handover_target');
  assert.throws(() => service.acceptHandover({ actor: NEXT, handoverId: requested.handover.id, statement: '   ', idempotencyKey: 'h3' }),
    error => error.code === 'validation');
  const accepted = service.acceptHandover({ actor: NEXT, handoverId: requested.handover.id, statement: 'I accept the lead role for this event', idempotencyKey: 'h4' });
  assert.equal(accepted.handover.state, 'accepted');
  assert.deepEqual(accepted.instructions.activity, [
    { action: 'set_lead', leadId: 'member-next', previousLeadId: 'member-lead' },
    { action: 'update_fields', fields: { leadId: 'member-next' } },
    { action: 'resume', reason: 'handover_accepted' },
  ]);
  assert.deepEqual(accepted.instructions.reminders, [{ action: 'reassign', reminderIds: ['reminder-1', 'reminder-2'], fromMemberId: 'member-lead', toMemberId: 'member-next', reason: 'lead_handover' }]);
  assert.deepEqual(accepted.instructions.grants, [
    { action: 'revoke', memberId: 'member-lead', scope: 'activity', activityId: 'activity-1' },
    { action: 'grant', memberId: 'member-next', scope: 'activity', activityId: 'activity-1' },
  ]);
  assert.deepEqual(accepted.instructions.registration, [{ action: 'update_contact', contactMemberId: 'member-next' }]);
  assert.deepEqual(accepted.intents.map(intent => intent.kind).sort(), [
    'notify_participants', 'post_announcement', 'update_lead_contact', 'update_registration_page', 'update_standing_summary',
  ]);
  assert.ok(accepted.intents.every(intent => intent.state === 'pending'));
  assert.throws(() => service.acceptHandover({ actor: NEXT, handoverId: requested.handover.id, statement: 'again', idempotencyKey: 'h5' }),
    error => error.code === 'invalid_transition');
});

test('an unaccepted handover pauses registration and tells the handler', () => {
  const grants = [...grant(LEAD, ['change.handover']), ...grant(NEXT, ['change.accept_handover']), ...grant(HANDLER, ['change.handover_as_handler'])];
  const { service } = harness({ grants, verifyContributor: id => id === 'member-lead' || id === 'member-next' });
  const first = service.requestHandover({ actor: LEAD, activityId: 'activity-1', toMemberId: 'member-next', reason: 'schedule', idempotencyKey: 'h1' });
  const declined = service.declineHandover({ actor: NEXT, handoverId: first.handover.id, note: 'I am travelling', idempotencyKey: 'h2' });
  assert.equal(declined.handover.state, 'declined');
  assert.deepEqual(declined.intents.map(intent => intent.kind).sort(), ['notify_handler', 'pause_registration']);
  assert.deepEqual(declined.instructions.activity, [{ action: 'pause', reason: 'handover_declined' }]);
  assert.deepEqual(declined.instructions.registration, [{ action: 'pause', reason: 'handover_declined' }]);
  assert.throws(() => service.declineHandover({ actor: NEXT, handoverId: first.handover.id, note: 'again', idempotencyKey: 'h3' }),
    error => error.code === 'invalid_transition');

  const second = service.requestHandover({ actor: LEAD, activityId: 'activity-1', toMemberId: 'member-next', reason: 'schedule', idempotencyKey: 'h4' });
  assert.equal(second.handover.state, 'awaiting_acceptance');
  assert.throws(() => service.expireHandover({ actor: NEXT, handoverId: second.handover.id, reason: 'timeout', idempotencyKey: 'h5' }),
    error => error.code === 'unauthorized');
  const expired = service.expireHandover({ actor: HANDLER, handoverId: second.handover.id, reason: 'no acceptance within the agreed window', idempotencyKey: 'h6' });
  assert.equal(expired.handover.state, 'expired');
  assert.deepEqual(expired.intents.map(intent => intent.kind).sort(), ['notify_handler', 'pause_registration']);
});

test('a candidate whose Contributor status lapses before accepting cannot take over', () => {
  let active = true;
  const { service } = harness({
    grants: [...grant(LEAD, ['change.handover']), ...grant(NEXT, ['change.accept_handover'])],
    verifyContributor: id => (id === 'member-lead' || id === 'member-next') && active,
  });
  const requested = service.requestHandover({ actor: LEAD, activityId: 'activity-1', toMemberId: 'member-next', reason: 'schedule', idempotencyKey: 'h1' });
  active = false;
  assert.throws(() => service.acceptHandover({ actor: NEXT, handoverId: requested.handover.id, statement: 'I accept', idempotencyKey: 'h2' }),
    error => error.code === 'handover_target_not_contributor');
});

test('a change to an unmapped field is blocked and applies nothing', () => {
  const { service } = harness({ grants: [...grant(LEAD, ['change.request'])] });
  const result = service.requestChange({
    actor: LEAD, activityId: 'activity-1', fields: { 'venue.parking': 'free' },
    confirmation: { statement: 'I confirm' }, idempotencyKey: 'u1',
  });
  assert.equal(result.change.state, 'awaiting_lead_confirmation');
  assert.deepEqual(result.intents, []);
  assert.deepEqual(result.pauses, []);
  assert.ok(result.blockers.some(blocker => blocker.code === 'unclassified_change_field'));
  assert.equal(result.change.plan.applicable, false);
  assert.equal(result.change.plan.applyFields, null);
});

test('an intent that still needs configuration refuses a delivery receipt', () => {
  const { service } = harness({ grants: [...grant(LEAD, ['change.request', 'change.record_delivery'])], policy: null });
  const result = service.requestChange({
    actor: LEAD, activityId: 'activity-1', fields: { 'capacity.expectedAttendance': 30 },
    confirmation: { statement: 'I confirm the capacity change' }, idempotencyKey: 'd1',
  });
  assert.equal(result.change.state, 'applied');
  const notify = result.intents.find(intent => intent.kind === 'notify_participants');
  assert.deepEqual(notify.dispatchBlockers, ['audience_not_configured']);
  assert.throws(() => service.recordIntentReceipt({ actor: LEAD, intentId: notify.id, receipt: { reference: 'chat-1' } }),
    error => error.code === 'intent_not_dispatchable');
  const page = result.intents.find(intent => intent.kind === 'update_registration_page');
  assert.equal(service.recordIntentReceipt({ actor: LEAD, intentId: page.id, receipt: { reference: 'site-1' } }).state, 'delivered');
});

test('the change log, its intents and the audit survive a restart and stay idempotent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rein-changes-'));
  try {
    const ledger = createLedger(join(directory, 'ledger.json'));
    const store = createChangeStore(ledger, { actor: 'change-test' });
    const grants = [...grant(AGENT, ['change.request', 'change.read']), ...grant(LEAD, ['change.confirm', 'change.read'])];
    const first = harness({ grants, store });
    const requested = first.service.requestChange({
      actor: AGENT, activityId: 'activity-1', fields: { 'schedule.startAt': '2026-10-02T18:00:00Z' }, reason: 'Venue move', idempotencyKey: 'p1',
    });
    first.service.confirmChange({ actor: LEAD, changeId: requested.change.id, statement: 'I confirm the new time', idempotencyKey: 'p2' });

    const second = harness({ grants, store });
    const replay = second.service.requestChange({
      actor: AGENT, activityId: 'activity-1', fields: { 'schedule.startAt': '2026-10-02T18:00:00Z' }, reason: 'Venue move', idempotencyKey: 'p1',
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.change.id, requested.change.id);
    assert.equal(second.service.listIntents({ actor: AGENT, activityId: 'activity-1' }).length, 5);
    const audit = second.service.snapshot().audit;
    assert.deepEqual(audit.map(entry => entry.action), ['change.request', 'change.confirm']);
    assert.deepEqual(audit.map(entry => entry.actorId), [AGENT.id, LEAD.id]);
    assert.equal(ledger.snapshot().records.reinChanges.sequence, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a stale writer is refused instead of overwriting a newer change state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rein-changes-conflict-'));
  try {
    const ledger = createLedger(join(directory, 'ledger.json'));
    const store = createChangeStore(ledger, { actor: 'change-test' });
    const grants = [...grant(AGENT, ['change.request', 'change.read'])];
    // Both services load the same empty state before either of them writes.
    const first = harness({ grants, store });
    const stale = harness({ grants, store });
    const committed = first.service.requestChange({ actor: AGENT, activityId: 'activity-1', fields: { 'location.venue': 'Room 101' }, idempotencyKey: 'w1' });
    assert.equal(committed.change.state, 'awaiting_lead_confirmation');
    assert.throws(() => stale.service.requestChange({ actor: AGENT, activityId: 'activity-1', fields: { 'location.venue': 'Room 202' }, idempotencyKey: 'w2' }),
      error => error instanceof ChangeError && error.code === 'storage_conflict' && error.details.actualSequence === 1);
    // The refused write changed nothing: the ledger still holds exactly the committed revision.
    assert.equal(ledger.snapshot().records.reinChanges.sequence, 1);
    assert.equal(ledger.snapshot().records.reinChanges.changes['change-1'].fields['location.venue'], 'Room 101');
    assert.equal(first.service.snapshot().sequence, 1);
    const reloaded = harness({ grants, store });
    assert.equal(reloaded.service.listChanges({ actor: AGENT, activityId: 'activity-1' }).length, 1);
    reloaded.service.requestChange({ actor: AGENT, activityId: 'activity-1', fields: { 'location.venue': 'Room 202' }, idempotencyKey: 'w3' });
    assert.equal(ledger.snapshot().records.reinChanges.sequence, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
