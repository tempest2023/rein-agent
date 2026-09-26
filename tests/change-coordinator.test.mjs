import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from '../plugins/rein-operations/ledger.ts';
import {
  createOperationsCore,
  createCapabilityAuthorizer,
  createLedgerStore,
  CAPABILITIES,
} from '../plugins/rein-operations/activities.ts';
import {
  createChangeService,
  createChangeAuthorizer,
  createChangeStore,
  CHANGE_CAPABILITIES,
} from '../plugins/rein-operations/changes.ts';
import {
  createChangeCoordinator,
  createCoordinatorAuthorizer,
  createCoordinatorStore,
  planChangeApplication,
  COORDINATOR_CAPABILITIES,
  RETAINED_REASONS,
  ChangeCoordinatorError,
} from '../plugins/rein-operations/change-coordinator.ts';

const NOW = '2026-09-24T10:00:00Z';
const ADMIN = { id: 'admin-1', kind: 'human' };
const LEAD = { id: 'lead-1', kind: 'human', memberId: 'member-lead' };
const BOARD = { id: 'board-1', kind: 'human' };
const COORD = { id: 'coordinator-1', kind: 'agent', memberId: 'member-coordinator' };
const POLICY = { participantAudience: 'chat:event-participants', handlerRef: 'role:handlers', financeHandlerRef: 'role:finance' };

const grantsFor = (actor, capabilities = CAPABILITIES) =>
  capabilities.map(capability => ({ actorId: actor.id, capability }));

function activityView(activityId, overrides = {}) {
  return {
    id: activityId,
    title: 'Community workshop',
    leadId: 'member-lead',
    state: 'preparing',
    registration: { state: 'open', currentCount: 12 },
    scheduledReminderIds: ['reminder-1'],
    budget: { requestedAmountMinor: 0, currency: 'USD', approvedCeilingMinor: 0 },
    finance: { requestedMinor: 0, approvedCeilingMinor: 0, reservedMinor: 0, paidMinor: 0, actualMinor: null, currency: 'USD' },
    ...overrides,
  };
}

// One harness over an optional shared ledger. The coordinator actor is deliberately granted the
// minimum: `change.read` on the change core, the guarded activity/finance capabilities on the
// activity core, and `change.apply`/`change.read` on the coordinator itself.
function harness({ ledger = null, crashOnSequence = null } = {}) {
  const now = () => NOW;
  const ops = createOperationsCore({
    now,
    authorize: createCapabilityAuthorizer([
      ...grantsFor(ADMIN),
      ...grantsFor(LEAD),
      ...grantsFor(BOARD),
      ...grantsFor(COORD, ['activity.transition', 'finance.request', 'finance.approve', 'audit.read']),
    ]),
    verifyContributor: memberId => memberId === 'member-lead',
    store: ledger ? createLedgerStore(ledger, { slot: 'reinOperations' }) : undefined,
  });
  const activity = ops.createActivity({ actor: ADMIN, title: 'Community workshop', eventType: 'workshop', leadId: 'member-lead' });
  ops.transitionActivity({ actor: ADMIN, activityId: activity.id, to: 'confirmed' });
  ops.transitionActivity({ actor: ADMIN, activityId: activity.id, to: 'evaluating' });
  ops.transitionActivity({ actor: ADMIN, activityId: activity.id, to: 'approved', basis: 'zero_budget_fast_track', reference: 'fast-track-2026-09-24' });
  ops.transitionActivity({ actor: ADMIN, activityId: activity.id, to: 'preparing' });

  const view = activityView(activity.id);
  const changes = createChangeService({
    now,
    authorize: createChangeAuthorizer([
      ...grantsFor(LEAD, CHANGE_CAPABILITIES),
      ...grantsFor(BOARD, CHANGE_CAPABILITIES),
      ...grantsFor(COORD, ['change.read']),
    ]),
    verifyContributor: memberId => memberId === 'member-lead',
    getActivity: () => view,
    policy: POLICY,
    store: ledger ? createChangeStore(ledger, { slot: 'reinChanges' }) : undefined,
  });

  const buildCoordinator = store => createChangeCoordinator({
    now,
    authorize: createCoordinatorAuthorizer(grantsFor(COORD, COORDINATOR_CAPABILITIES)),
    changes,
    operations: ops,
    store,
  });

  let store;
  if (ledger) {
    const base = createCoordinatorStore(ledger, { slot: 'reinChangeDispatch' });
    store = crashOnSequence === null
      ? base
      : {
          load: () => base.load(),
          save: state => {
            if (state.sequence === crashOnSequence) throw new Error('simulated crash before the final write');
            base.save(state);
          },
        };
  } else if (crashOnSequence !== null) {
    let saves = 0;
    store = {
      load: () => null,
      save: () => { saves += 1; if (saves === crashOnSequence) throw new Error('simulated crash before the final write'); },
    };
  }

  return { ops, changes, coordinator: buildCoordinator(store), buildCoordinator, activityId: activity.id, view };
}

test('the plan applies only instructions the activities core can guard and retains the rest', () => {
  const plan = planChangeApplication({
    changeId: 'change-1',
    activityId: 'activity-1',
    instructions: {
      activity: [
        { action: 'update_fields', fields: { 'schedule.startAt': '2026-10-02T18:00:00Z' } },
        { action: 'recheck_readiness', fields: ['schedule.startAt'] },
        { action: 'resume', to: 'preparing', reason: 'governance_approved' },
      ],
      reminders: [{ action: 'reschedule', reminderIds: ['reminder-1'], reason: 'schedule_changed' }],
      registration: [{ action: 'update_page', fields: { 'schedule.startAt': '2026-10-02T18:00:00Z' } }],
      finance: [{ action: 'set_approved_ceiling', amountMinor: 50000, currency: 'USD', allocationReference: 'alloc-1' }],
      grants: [],
      mystery: [{ action: 'anything' }],
    },
  });
  assert.deepEqual(plan.operations.map(operation => `${operation.namespace}:${operation.method}`),
    ['activity:transitionActivity', 'finance:approveFunding']);
  assert.deepEqual(plan.operations[0].args, { to: 'preparing', reason: 'governance_approved' });
  assert.equal(plan.operations[1].args.ceilingMinor, 50000);
  assert.equal(plan.operations[1].args.allocationReference, 'alloc-1');
  const codes = plan.retained.map(item => item.code);
  for (const expected of [
    'activity_field_update_not_supported',
    'activity_readiness_recheck_not_supported',
    'reminder_reschedule_not_supported',
    'registration_page_update_not_supported',
    'unclassified_instruction_namespace',
  ]) assert.ok(codes.includes(expected), `missing retained code ${expected}`);
  assert.ok(plan.retained.every(item => typeof RETAINED_REASONS[item.code] === 'string'));
});

test('handover-shaped instructions retain the lead change and an unspecified resume', () => {
  const plan = planChangeApplication({
    changeId: 'handover-1',
    activityId: 'activity-1',
    instructions: {
      activity: [
        { action: 'set_lead', leadId: 'member-next', previousLeadId: 'member-lead' },
        { action: 'update_fields', fields: { leadId: 'member-next' } },
        { action: 'resume', reason: 'handover_accepted' },
      ],
      reminders: [{ action: 'reassign', reminderIds: ['reminder-1'] }],
      registration: [{ action: 'update_contact', contactMemberId: 'member-next' }],
      finance: [],
      grants: [{ action: 'revoke' }, { action: 'grant' }],
    },
  });
  assert.equal(plan.operations.length, 0);
  const codes = plan.retained.map(item => item.code);
  for (const expected of [
    'lead_assignment_not_supported',
    'resume_target_unspecified',
    'reminder_reassignment_not_supported',
    'registration_page_update_not_supported',
    'grants_not_owned_by_activity_core',
  ]) assert.ok(codes.includes(expected), `missing retained code ${expected}`);
});

test('an accepted cancellation is applied to the activity core and the rest is retained', () => {
  const { ops, changes, coordinator, activityId } = harness();
  const requested = changes.cancelActivity({ actor: LEAD, activityId, reason: 'venue lost', idempotencyKey: 'cancel-1' });
  assert.equal(requested.change.state, 'applied');

  const dispatch = coordinator.apply({ actor: COORD, changeId: requested.change.id, idempotencyKey: 'dispatch-cancel-1' });
  assert.equal(dispatch.outcome, 'applied');
  assert.equal(dispatch.state, 'applied');
  assert.equal(dispatch.replayed, false);
  assert.equal(dispatch.applied.length, 1);
  assert.equal(dispatch.applied[0].method, 'transitionActivity');
  assert.equal(dispatch.applied[0].result.state, 'canceled');
  assert.equal(ops.getActivity(activityId).state, 'canceled');

  const codes = dispatch.retained.map(item => item.code);
  assert.ok(codes.includes('reminder_cancellation_not_supported'));
  assert.ok(codes.includes('registration_state_not_owned_by_activity_core'));
  assert.ok(dispatch.blocked.length === 0);
});

test('an accepted change with no core API is retained only and leaves the activity untouched', () => {
  const { ops, changes, coordinator, activityId } = harness();
  const requested = changes.requestChange({
    actor: LEAD,
    activityId,
    fields: { 'schedule.startAt': '2026-10-02T18:00:00Z' },
    confirmation: { statement: 'I confirm the new start time' },
    idempotencyKey: 'change-schedule-1',
  });
  assert.equal(requested.change.state, 'applied');

  const dispatch = coordinator.apply({ actor: COORD, changeId: requested.change.id, idempotencyKey: 'dispatch-schedule-1' });
  assert.equal(dispatch.outcome, 'retained_only');
  assert.equal(dispatch.applied.length, 0);
  assert.ok(dispatch.retained.length >= 3);
  assert.equal(ops.getActivity(activityId).state, 'preparing');
});

test('a duplicate retry replays the recorded dispatch without touching the activity core', () => {
  const { ops, changes, coordinator, activityId } = harness();
  const requested = changes.cancelActivity({ actor: LEAD, activityId, reason: 'venue lost', idempotencyKey: 'cancel-2' });
  const first = coordinator.apply({ actor: COORD, changeId: requested.change.id, idempotencyKey: 'dispatch-cancel-2' });
  assert.equal(first.replayed, false);
  const sequenceAfterFirst = ops.snapshot().sequence;

  const second = coordinator.apply({ actor: COORD, changeId: requested.change.id, idempotencyKey: 'dispatch-cancel-2' });
  assert.equal(second.replayed, true);
  assert.equal(second.outcome, 'applied');
  assert.equal(second.id, first.id);
  assert.equal(ops.snapshot().sequence, sequenceAfterFirst);
  assert.equal(ops.getActivity(activityId).state, 'canceled');

  assert.throws(() => coordinator.apply({ actor: COORD, changeId: requested.change.id, idempotencyKey: '' }),
    error => error instanceof ChangeCoordinatorError && error.code === 'validation');
});

test('a rejected or not-yet-accepted change is refused and records no dispatch', () => {
  const { changes, coordinator, activityId } = harness();

  const scope = changes.requestChange({ actor: LEAD, activityId, fields: { format: 'hybrid' }, idempotencyKey: 'change-scope-1' });
  assert.equal(scope.change.state, 'awaiting_governance');
  const rejected = changes.recordGovernanceDecision({
    actor: BOARD, changeId: scope.change.id, decision: 'rejected', reference: 'board-2026-09-24', idempotencyKey: 'gov-reject-1',
  });
  assert.equal(rejected.change.state, 'rejected');
  assert.throws(() => coordinator.apply({ actor: COORD, changeId: scope.change.id, idempotencyKey: 'dispatch-scope-1' }),
    error => error instanceof ChangeCoordinatorError && error.code === 'change_rejected');

  const pending = changes.requestChange({ actor: LEAD, activityId, fields: { 'schedule.startAt': '2026-10-03T18:00:00Z' }, idempotencyKey: 'change-pending-1' });
  assert.equal(pending.change.state, 'awaiting_lead_confirmation');
  assert.throws(() => coordinator.apply({ actor: COORD, changeId: pending.change.id, idempotencyKey: 'dispatch-pending-1' }),
    error => error instanceof ChangeCoordinatorError && error.code === 'change_not_accepted');
  assert.throws(() => coordinator.plan({ actor: COORD, changeId: pending.change.id }),
    error => error instanceof ChangeCoordinatorError && error.code === 'change_not_accepted');

  assert.deepEqual(coordinator.listDispatches({ actor: COORD }), []);
});

test('an already-preparing activity does not fail a redundant governance resume before funding', () => {
  const { ops, changes, coordinator, activityId } = harness();
  const funding = changes.requestChange({
    actor: LEAD,
    activityId,
    fields: { 'budget.requestedAmountMinor': 50000 },
    previous: { 'budget.requestedAmountMinor': 0 },
    idempotencyKey: 'change-funding-1',
  });
  assert.equal(funding.change.state, 'awaiting_governance');
  const approved = changes.recordGovernanceDecision({
    actor: BOARD, changeId: funding.change.id, decision: 'approved', reference: 'board-2026-09-24',
    approvedCeilingMinor: 50000, approvedCurrency: 'USD', allocationReference: 'alloc-1', idempotencyKey: 'gov-approve-1',
  });
  assert.equal(approved.change.state, 'applied');

  const dispatch = coordinator.apply({ actor: COORD, changeId: funding.change.id, idempotencyKey: 'dispatch-funding-1' });
  assert.equal(dispatch.outcome, 'applied');
  assert.equal(dispatch.applied.length, 3);
  assert.equal(dispatch.applied[0].result.unchanged, true);
  assert.equal(dispatch.blocked.length, 0);
  assert.equal(ops.getActivity(activityId).state, 'preparing');
  assert.equal(ops.getFinance(activityId).approvedCeilingMinor, 50000);
});

test('a matching pre-existing funding request is preserved before applying the approved ceiling', () => {
  const { ops, changes, coordinator, activityId } = harness();
  ops.requestFunding({ actor: LEAD, activityId, amountMinor: 50000, currency: 'USD' });
  const funding = changes.requestChange({
    actor: LEAD, activityId,
    fields: { 'budget.requestedAmountMinor': 50000 },
    previous: { 'budget.requestedAmountMinor': 0 },
    idempotencyKey: 'change-existing-request',
  });
  changes.recordGovernanceDecision({
    actor: BOARD, changeId: funding.change.id, decision: 'approved', reference: 'board-existing-request',
    approvedCeilingMinor: 50000, approvedCurrency: 'USD', allocationReference: 'allocation-existing',
    idempotencyKey: 'governance-existing-request',
  });
  const dispatch = coordinator.apply({ actor: COORD, changeId: funding.change.id, idempotencyKey: 'dispatch-existing-request' });
  assert.equal(dispatch.outcome, 'applied');
  assert.equal(dispatch.applied.find(item => item.action === 'request_funding').result.unchanged, true);
  assert.equal(ops.getFinance(activityId).approvedCeilingMinor, 50000);
});

test('a distinct key cannot dispatch the same change twice', () => {
  const { ops, changes, coordinator, activityId } = harness();
  const requested = changes.cancelActivity({ actor: LEAD, activityId, reason: 'venue lost', idempotencyKey: 'cancel-dedupe-1' });
  const first = coordinator.apply({ actor: COORD, changeId: requested.change.id, idempotencyKey: 'dispatch-dedupe-a' });
  assert.equal(first.replayed, false);
  assert.equal(first.deduplicated, false);
  const sequenceAfterFirst = ops.snapshot().sequence;

  const second = coordinator.apply({ actor: COORD, changeId: requested.change.id, idempotencyKey: 'dispatch-dedupe-b' });
  assert.equal(second.replayed, true);
  assert.equal(second.deduplicated, true);
  assert.equal(second.id, first.id);
  assert.equal(second.outcome, 'applied');
  assert.equal(ops.snapshot().sequence, sequenceAfterFirst);

  // The deduplicated key is now bound to the same dispatch, so a third call is a plain replay.
  const third = coordinator.apply({ actor: COORD, changeId: requested.change.id, idempotencyKey: 'dispatch-dedupe-b' });
  assert.equal(third.replayed, true);
  assert.equal(third.deduplicated, false);
  assert.equal(third.id, first.id);
  assert.equal(coordinator.listDispatches({ actor: COORD, activityId }).length, 1);
});

test('an idempotency key bound to another change is refused', () => {
  const { changes, coordinator, activityId } = harness();
  const first = changes.cancelActivity({ actor: LEAD, activityId, reason: 'venue lost', idempotencyKey: 'cancel-mismatch-1' });
  const second = changes.requestChange({
    actor: LEAD, activityId, fields: { 'program.agenda': 'Two papers' }, confirmation: { statement: 'I confirm' }, idempotencyKey: 'change-mismatch-1',
  });
  assert.notEqual(first.change.id, second.change.id);

  coordinator.apply({ actor: COORD, changeId: first.change.id, idempotencyKey: 'dispatch-shared-1' });
  assert.throws(() => coordinator.apply({ actor: COORD, changeId: second.change.id, idempotencyKey: 'dispatch-shared-1' }),
    error => error instanceof ChangeCoordinatorError && error.code === 'idempotency_key_reused');
  assert.equal(coordinator.listDispatches({ actor: COORD, activityId }).length, 1);
});

test('the coordinator never fabricates external delivery', () => {
  const { ops, changes, coordinator, activityId } = harness();
  const requested = changes.cancelActivity({ actor: LEAD, activityId, reason: 'venue lost', idempotencyKey: 'cancel-3' });
  const dispatch = coordinator.apply({ actor: COORD, changeId: requested.change.id, idempotencyKey: 'dispatch-cancel-3' });

  assert.equal(dispatch.delivered, false);
  assert.equal(dispatch.externalDelivery, 'not_connected');
  assert.ok(dispatch.retained.every(item => typeof item.code === 'string' && item.code.length > 0));
  assert.deepEqual(ops.listExternalIntents({ actor: ADMIN }), []);
  assert.deepEqual(ops.snapshot().jobs, {});
});

test('an interrupted run is not retried and reports an uncertain dispatch', () => {
  const { ops, changes, coordinator, activityId } = harness({ crashOnSequence: 2 });
  const requested = changes.cancelActivity({ actor: LEAD, activityId, reason: 'venue lost', idempotencyKey: 'cancel-4' });
  assert.throws(() => coordinator.apply({ actor: COORD, changeId: requested.change.id, idempotencyKey: 'dispatch-cancel-4' }),
    error => error.message === 'simulated crash before the final write');
  const sequenceAfterCrash = ops.snapshot().sequence;

  const retry = coordinator.apply({ actor: COORD, changeId: requested.change.id, idempotencyKey: 'dispatch-cancel-4' });
  assert.equal(retry.replayed, true);
  assert.equal(retry.outcome, 'uncertain');
  assert.equal(retry.state, 'pending');
  assert.equal(ops.snapshot().sequence, sequenceAfterCrash);
});

test('a dispatch pending in the shared ledger stays uncertain after a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rein-coordinator-'));
  try {
    const ledger = createLedger(join(dir, 'ledger.json'));
    const first = harness({ ledger, crashOnSequence: 2 });
    const requested = first.changes.cancelActivity({ actor: LEAD, activityId: first.activityId, reason: 'venue lost', idempotencyKey: 'cancel-5' });
    assert.throws(() => first.coordinator.apply({ actor: COORD, changeId: requested.change.id, idempotencyKey: 'dispatch-cancel-5' }));

    // A fresh coordinator over the same ledger stands in for a restarted process.
    const restarted = first.buildCoordinator(createCoordinatorStore(ledger, { slot: 'reinChangeDispatch' }));
    const retry = restarted.apply({ actor: COORD, changeId: requested.change.id, idempotencyKey: 'dispatch-cancel-5' });
    assert.equal(retry.replayed, true);
    assert.equal(retry.outcome, 'uncertain');
    assert.equal(retry.state, 'pending');

    const dispatches = restarted.listDispatches({ actor: COORD, activityId: first.activityId });
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].outcome, 'uncertain');
    assert.equal(dispatches[0].delivered, false);
    assert.equal(dispatches[0].externalDelivery, 'not_connected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('authorization is explicit and the default authorizer grants nothing', () => {
  const { changes, coordinator, activityId } = harness();
  const requested = changes.cancelActivity({ actor: LEAD, activityId, reason: 'venue lost', idempotencyKey: 'cancel-6' });

  const closed = createChangeCoordinator({ now: () => NOW, changes, operations: {} });
  assert.deepEqual(closed.authorize({ actor: COORD, capability: 'change.apply' }), { allowed: false, reason: 'no_authorizer_configured' });
  assert.throws(() => closed.apply({ actor: COORD, changeId: requested.change.id, idempotencyKey: 'dispatch-closed-1' }),
    error => error instanceof ChangeCoordinatorError && error.code === 'unauthorized');

  // A grant for a different activity must not authorize this change: the check uses the verified
  // activity id, not a caller-supplied one.
  const scoped = createChangeCoordinator({
    now: () => NOW,
    authorize: createCoordinatorAuthorizer([
      { actorId: COORD.id, capability: 'change.apply', activityId: 'some-other-activity' },
      { actorId: COORD.id, capability: 'change.read', activityId: 'some-other-activity' },
    ]),
    changes,
    operations: {},
  });
  assert.throws(() => scoped.apply({ actor: COORD, changeId: requested.change.id, idempotencyKey: 'dispatch-scoped-1' }),
    error => error instanceof ChangeCoordinatorError && error.code === 'unauthorized');
  assert.throws(() => scoped.plan({ actor: COORD, changeId: requested.change.id }),
    error => error instanceof ChangeCoordinatorError && error.code === 'unauthorized');

  assert.throws(() => coordinator.apply({ actor: { id: '' }, changeId: requested.change.id, idempotencyKey: 'dispatch-anon-1' }),
    error => error instanceof ChangeCoordinatorError && error.code === 'unauthorized');
  assert.equal(coordinator.snapshot().dispatches ? Object.keys(coordinator.snapshot().dispatches).length : 0, 0);
});

test('an activity-scoped grant authorizes the change for its own activity', () => {
  const { ops, changes, activityId } = harness();
  const requested = changes.cancelActivity({ actor: LEAD, activityId, reason: 'venue lost', idempotencyKey: 'cancel-scoped-1' });
  const coordinator = createChangeCoordinator({
    now: () => NOW,
    authorize: createCoordinatorAuthorizer([
      { actorId: COORD.id, capability: 'change.apply', activityId },
      { actorId: COORD.id, capability: 'change.read', activityId },
    ]),
    changes,
    operations: ops,
  });
  const plan = coordinator.plan({ actor: COORD, changeId: requested.change.id });
  assert.equal(plan.activityId, activityId);
  const dispatch = coordinator.apply({ actor: COORD, changeId: requested.change.id, idempotencyKey: 'dispatch-scoped-2' });
  assert.equal(dispatch.outcome, 'applied');
  assert.equal(ops.getActivity(activityId).state, 'canceled');
});
