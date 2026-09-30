import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOversightCore,
  createOversightAuthorizer,
  createLedgerStore,
  AUTOMATION_CATEGORIES,
  OVERSIGHT_CAPABILITIES,
  OversightError,
} from '../plugins/rein-operations/oversight.ts';
import { createLedger } from '../plugins/rein-operations/ledger.ts';

const ADMIN = { id: 'admin-1', kind: 'human' };
const AGENT = { id: 'rein-agent', kind: 'agent' };
const LEAD = { id: 'lead-1', kind: 'human' };

const APPROVED_POLICY = {
  version: 'ops-policy-2026-09',
  approvedBy: 'board-2026-09-01',
  approvedAt: '2026-09-01T00:00:00Z',
  categories: [{ category: 'automation.reminder', handlerId: 'ops-admin-1' }],
};

function harness({ now = '2026-09-24T10:00:00Z', grants = [], policy = null, store } = {}) {
  let clock = now;
  const core = createOversightCore({
    now: () => clock,
    authorize: grants.length > 0 ? createOversightAuthorizer(grants) : undefined,
    store,
  });
  // Policy is never activated by construction; an authorized, audited call is the only path.
  if (policy) core.approvePolicy({ actor: ADMIN, policy });
  return { core, setClock: value => { clock = value; } };
}

function grantAll(actor, actions = OVERSIGHT_CAPABILITIES) {
  return actions.map(action => ({ actorId: actor.id, action }));
}

// Staff grants for the operational tests: the admin can read, pause, manage exceptions, approve
// policy and build summaries; the agent may dispatch automation but nothing else.
const STAFF_GRANTS = [...grantAll(ADMIN), { actorId: AGENT.id, action: 'automation.dispatch' }];

function item(itemId, extra = {}) {
  return { itemId, ...extra };
}

test('authorization is explicit actor/action/resource and denies everything without a grant', () => {
  const { core } = harness();
  assert.deepEqual(core.authorize({ actor: ADMIN, action: 'oversight.pause', resource: { kind: 'global' } }), { allowed: false, reason: 'no_authorizer_configured' });
  assert.throws(() => core.pauseAutomation({ actor: ADMIN, scope: 'all', reason: 'incident' }),
    error => error instanceof OversightError && error.code === 'unauthorized');
  assert.throws(() => core.recordException({ actor: ADMIN, kind: 'unanswered_follow_up', reason: 'no reply' }),
    error => error.code === 'unauthorized');

  // A category-scoped grant must not authorize a different resource.
  const scoped = harness({ grants: [{ actorId: ADMIN.id, action: 'oversight.pause', scope: 'category', category: 'automation.reminder' }] });
  assert.equal(scoped.core.authorize({ actor: ADMIN, action: 'oversight.pause', resource: { kind: 'category', category: 'automation.reminder' } }).allowed, true);
  assert.equal(scoped.core.authorize({ actor: ADMIN, action: 'oversight.pause', resource: { kind: 'global' } }).allowed, false);
  assert.equal(scoped.core.authorize({ actor: ADMIN, action: 'oversight.pause', resource: { kind: 'activity', activityId: 'activity-1' } }).allowed, false);
  assert.equal(scoped.core.authorize({ actor: LEAD, action: 'oversight.pause', resource: { kind: 'category', category: 'automation.reminder' } }).allowed, false);
});

test('scoped pause/resume reports its scope and is idempotent', () => {
  const { core } = harness({ grants: grantAll(ADMIN) });
  const first = core.pauseAutomation({ actor: ADMIN, scope: 'category', category: 'automation.reminder', reason: 'duplicate reminder complaint' });
  assert.equal(first.deduplicated, false);
  assert.deepEqual(first.affected.categories, ['automation.reminder']);
  const again = core.pauseAutomation({ actor: ADMIN, scope: 'category', category: 'automation.reminder', reason: 'retry' });
  assert.equal(again.deduplicated, true);
  assert.equal(again.pause.id, first.pause.id);
  assert.equal(core.listPauses({ actor: ADMIN, state: 'active' }).length, 1);

  assert.equal(core.isAutomationPaused({ actor: ADMIN, category: 'automation.reminder' }).paused, true);
  assert.equal(core.isAutomationPaused({ actor: ADMIN, category: 'automation.publication' }).paused, false);
  assert.equal(core.isAutomationPaused({ actor: ADMIN, category: 'automation.publication', activityId: 'activity-1' }).paused, false);

  core.pauseAutomation({ actor: ADMIN, scope: 'all', reason: 'pilot incident review' });
  assert.equal(core.isAutomationPaused({ actor: ADMIN, category: 'automation.publication', activityId: 'activity-1' }).paused, true);
  assert.equal(core.isAutomationPaused({ actor: ADMIN, category: 'automation.publication', activityId: 'activity-1' }).scopes.length, 1);

  assert.throws(() => core.pauseAutomation({ actor: ADMIN, scope: 'category', category: 'automation.nope', reason: 'x' }),
    error => error.code === 'validation');
  assert.throws(() => core.pauseAutomation({ actor: ADMIN, scope: 'activity', reason: 'x' }),
    error => error.code === 'validation');
});

test('a pause stops dispatch, retains the work, and never blocks audit or human reads', () => {
  const { core } = harness({ grants: STAFF_GRANTS, policy: APPROVED_POLICY });
  const pause = core.pauseAutomation({ actor: ADMIN, scope: 'category', category: 'automation.reminder', reason: 'incident' });

  const result = core.dispatchAutomation({
    actor: AGENT,
    category: 'automation.reminder',
    items: [item('reminder-1', { idempotencyKey: 'reminder-1@2026-09-24', dueAt: '2026-09-24T09:00:00Z', summary: 'prep check' })],
  });
  assert.deepEqual(result.queued, []);
  assert.deepEqual(result.delivered, []);
  assert.equal(result.retained.length, 1);
  assert.equal(result.retained[0].itemId, 'reminder-1');
  assert.equal(result.retained[0].attempts, 1);
  assert.equal(result.externalDelivery, 'not_connected');
  assert.deepEqual(core.listDispatchIntents({ actor: ADMIN }), []);

  // Audit, exception work and the weekly summary stay available while automation is paused.
  assert.ok(core.listAuditEvents({ actor: ADMIN }).length > 0);
  const recorded = core.recordException({ actor: ADMIN, kind: 'unanswered_follow_up', reason: 'no response after 2 follow-ups', activityId: 'activity-1' });
  assert.equal(recorded.created, true);
  core.updateException({ actor: ADMIN, exceptionId: recorded.exception.id, handlerId: 'ops-admin-1', status: 'in_progress', deadline: '2026-09-26T10:00:00Z' });
  const summary = core.buildWeeklySummary({ actor: ADMIN, period: { start: '2026-09-18T00:00:00Z', end: '2026-09-24T23:59:59Z' } });
  assert.equal(summary.pausedAutomation.length, 1);
  assert.equal(summary.pausedAutomation[0].retainedCount, 1);
  assert.equal(summary.exceptions.outstanding.length, 1);

  const affected = core.listAffectedByPause({ actor: ADMIN, pauseId: pause.pause.id });
  assert.equal(affected.active, true);
  assert.equal(affected.retained.length, 1);
  assert.equal(affected.overdueTasksPreserved, true);
  assert.deepEqual(affected.overdue.map(entry => entry.itemId), ['reminder-1']);
});

test('resume requires reconciliation for overdue retained work, then releases it', () => {
  const { core } = harness({ grants: STAFF_GRANTS, policy: APPROVED_POLICY });
  const pause = core.pauseAutomation({ actor: ADMIN, scope: 'category', category: 'automation.reminder', reason: 'incident' });
  const payload = { actor: AGENT, category: 'automation.reminder', items: [item('reminder-1', { idempotencyKey: 'reminder-1@2026-09-24', dueAt: '2026-09-24T09:00:00Z' })] };
  core.dispatchAutomation(payload);

  assert.throws(() => core.resumeAutomation({ actor: ADMIN, pauseId: pause.pause.id }),
    error => error.code === 'reconciliation_required' && error.details.overdue.length === 1);
  assert.equal(core.listRetainedItems({ actor: ADMIN }).length, 1);

  const resumed = core.resumeAutomation({
    actor: ADMIN,
    pauseId: pause.pause.id,
    reconciliation: { acknowledgedOverdue: true, reviewedItemIds: ['reminder-1'], notes: 'resent one item only' },
  });
  assert.equal(resumed.alreadyResumed, false);
  assert.equal(resumed.resumePlan.overdueCount, 1);
  assert.equal(core.isAutomationPaused({ actor: ADMIN, category: 'automation.reminder' }).paused, false);
  assert.equal(core.resumeAutomation({ actor: ADMIN, pauseId: pause.pause.id }).alreadyResumed, true);

  const released = core.dispatchAutomation(payload);
  assert.equal(released.queued.length, 1);
  assert.equal(released.queued[0].intentState, 'pending_delivery');
  assert.equal(released.queued[0].deliveredAt, null);
  assert.deepEqual(released.delivered, []);
  assert.equal(released.retained.length, 0);
  assert.deepEqual(core.listRetainedItems({ actor: ADMIN }), []);
});

test('outbound automation is refused without an approved policy and handler', () => {
  const noPolicy = harness({ grants: STAFF_GRANTS });
  assert.throws(() => noPolicy.core.dispatchAutomation({ actor: AGENT, category: 'automation.reminder', items: [item('r1')] }),
    error => error.code === 'policy_not_approved');
  assert.equal(noPolicy.core.getAutomationReadiness({ actor: ADMIN }).ready, false);

  const partial = harness({ grants: STAFF_GRANTS, policy: { ...APPROVED_POLICY, categories: [] } });
  assert.throws(() => partial.core.dispatchAutomation({ actor: AGENT, category: 'automation.reminder', items: [item('r1')] }),
    error => error.code === 'automation_category_not_approved');
  assert.throws(() => partial.core.dispatchAutomation({ actor: AGENT, category: 'automation.publication', items: [item('p1')] }),
    error => error.code === 'automation_category_not_approved');

  // A policy entry without a responsible handler is rejected instead of becoming "approved".
  assert.throws(() => harness({ grants: STAFF_GRANTS, policy: { ...APPROVED_POLICY, categories: [{ category: 'automation.reminder', handlerId: '' }] } }),
    error => error.code === 'validation');
  const noHandler = harness({ grants: STAFF_GRANTS });
  assert.throws(() => noHandler.core.approvePolicy({ actor: ADMIN, policy: { ...APPROVED_POLICY, categories: [{ category: 'automation.reminder' }] } }),
    error => error.code === 'validation');
  assert.equal(noHandler.core.getAutomationReadiness({ actor: ADMIN }).blocked.length, AUTOMATION_CATEGORIES.length);

  const approved = harness({ grants: STAFF_GRANTS, policy: APPROVED_POLICY });
  const result = approved.core.dispatchAutomation({ actor: AGENT, category: 'automation.reminder', items: [item('r1', { idempotencyKey: 'r1' })] });
  assert.equal(result.queued.length, 1);
  assert.equal(result.queued[0].handlerId, 'ops-admin-1');
  assert.equal(result.queued[0].delivery, 'not_connected');
  assert.deepEqual(result.delivered, []);
  assert.match(result.note, /pending/);
  // The approved policy belongs to the admin's record; an ungranted actor still cannot dispatch.
  assert.throws(() => approved.core.dispatchAutomation({ actor: LEAD, category: 'automation.reminder', items: [item('r2')] }),
    error => error.code === 'unauthorized');
});

test('no policy is activated implicitly; only an authorized approvePolicy call takes effect', () => {
  // A stray constructor argument must not become an approved policy.
  const core = createOversightCore({
    now: () => '2026-09-24T10:00:00Z',
    authorize: createOversightAuthorizer(STAFF_GRANTS),
    policy: APPROVED_POLICY,
  });
  assert.equal(core.getPolicy({ actor: ADMIN }), null);
  assert.equal(core.getAutomationReadiness({ actor: ADMIN }).ready, false);
  assert.throws(() => core.dispatchAutomation({ actor: AGENT, category: 'automation.reminder', items: [item('r1')] }),
    error => error.code === 'policy_not_approved');

  core.approvePolicy({ actor: ADMIN, policy: APPROVED_POLICY });
  assert.equal(core.getPolicy({ actor: ADMIN }).version, APPROVED_POLICY.version);
  assert.deepEqual(core.listAuditEvents({ actor: ADMIN }).map(event => event.action), ['oversight.policy.approve']);
  assert.equal(core.dispatchAutomation({ actor: AGENT, category: 'automation.reminder', items: [item('r1')] }).queued.length, 1);
  // Approval itself needs its own capability.
  assert.throws(() => core.approvePolicy({ actor: LEAD, policy: APPROVED_POLICY }), error => error.code === 'unauthorized');
});

test('dispatch is idempotent per key and rejects a key reused for another target', () => {
  const { core } = harness({
    grants: STAFF_GRANTS,
    policy: { ...APPROVED_POLICY, categories: [...APPROVED_POLICY.categories, { category: 'automation.publication', handlerId: 'ops-admin-1' }] },
  });
  const first = core.dispatchAutomation({ actor: AGENT, category: 'automation.reminder', items: [item('r1', { idempotencyKey: 'key-1' })] });
  assert.equal(first.queued.length, 1);
  const retry = core.dispatchAutomation({ actor: AGENT, category: 'automation.reminder', items: [item('r1', { idempotencyKey: 'key-1' })] });
  assert.equal(retry.queued.length, 0);
  assert.equal(retry.deduplicated.length, 1);
  assert.equal(core.listDispatchIntents({ actor: ADMIN }).length, 1);

  const derivedA = core.dispatchAutomation({ actor: AGENT, category: 'automation.reminder', items: [item('r2')] });
  const derivedB = core.dispatchAutomation({ actor: AGENT, category: 'automation.reminder', items: [item('r2')] });
  assert.equal(derivedA.queued.length, 1);
  assert.equal(derivedB.deduplicated.length, 1);

  assert.throws(() => core.dispatchAutomation({
    actor: AGENT,
    category: 'automation.publication',
    activityId: 'activity-1',
    items: [item('p1', { idempotencyKey: 'key-1' })],
  }), error => error.code === 'idempotency_conflict');
});

test('recurring exceptions merge instead of producing duplicate alerts', () => {
  const { core } = harness({ grants: grantAll(ADMIN) });
  const first = core.recordException({ actor: ADMIN, kind: 'unanswered_follow_up', reason: 'no response after 2 follow-ups', activityId: 'activity-1' });
  assert.equal(first.created, true);
  const second = core.recordException({ actor: ADMIN, kind: 'unanswered_follow_up', reason: 'no response after 3 follow-ups', activityId: 'activity-1' });
  assert.equal(second.merged, true);
  assert.equal(second.exception.id, first.exception.id);
  assert.equal(second.exception.occurrences, 2);
  assert.equal(second.exception.events.length, 2);
  assert.equal(core.listExceptions({ actor: ADMIN }).length, 1);

  // A different activity or kind stays separate.
  core.recordException({ actor: ADMIN, kind: 'unanswered_follow_up', reason: 'no response after 2 follow-ups', activityId: 'activity-2' });
  core.recordException({ actor: ADMIN, kind: 'venue_unconfirmed', reason: 'venue unconfirmed', activityId: 'activity-1' });
  assert.equal(core.listExceptions({ actor: ADMIN }).length, 3);

  // An explicit dedupe key merges different wording for the same underlying problem.
  const keyedA = core.recordException({ actor: ADMIN, kind: 'funding', reason: 'budget unclear', activityId: 'activity-1', dedupeKey: 'activity-1:funding' });
  const keyedB = core.recordException({ actor: ADMIN, kind: 'funding', reason: 'available funds unknown', activityId: 'activity-1', dedupeKey: 'activity-1:funding' });
  assert.equal(keyedB.merged, true);
  assert.equal(keyedB.exception.id, keyedA.exception.id);
  assert.equal(keyedB.exception.reason, 'available funds unknown');
});

test('exception handler, status, deadline and resolution are tracked, and recurrence links back', () => {
  const { core, setClock } = harness({ grants: grantAll(ADMIN) });
  const created = core.recordException({ actor: ADMIN, kind: 'unanswered_follow_up', reason: 'no response after 2 follow-ups', activityId: 'activity-1' }).exception;
  assert.equal(created.handlerId, null);
  assert.equal(created.status, 'open');
  assert.equal(created.deadline, null);

  const assigned = core.updateException({
    actor: ADMIN, exceptionId: created.id, handlerId: 'ops-admin-1', status: 'in_progress', deadline: '2026-09-26T10:00:00Z', recommendation: 'call the lead directly',
  });
  assert.equal(assigned.handlerId, 'ops-admin-1');
  assert.equal(assigned.status, 'in_progress');
  assert.equal(assigned.deadline, '2026-09-26T10:00:00.000Z');
  assert.equal(assigned.history.length, 1);
  assert.throws(() => core.updateException({ actor: ADMIN, exceptionId: created.id, status: 'resolved' }),
    error => error.code === 'validation');
  assert.throws(() => core.resolveException({ actor: ADMIN, exceptionId: created.id, resolution: '   ' }),
    error => error.code === 'validation');

  const resolved = core.resolveException({ actor: ADMIN, exceptionId: created.id, resolution: 'lead replied; reminder rescheduled', improvement: 'quiet hours were misconfigured' });
  assert.equal(resolved.exception.status, 'resolved');
  assert.equal(resolved.exception.improvement, 'quiet hours were misconfigured');
  assert.equal(core.resolveException({ actor: ADMIN, exceptionId: created.id, resolution: 'again' }).alreadyResolved, true);
  assert.equal(core.listExceptions({ actor: ADMIN, status: 'open' }).length, 0);

  setClock('2026-10-02T10:00:00Z');
  const recurrence = core.recordException({ actor: ADMIN, kind: 'unanswered_follow_up', reason: 'no response after 2 follow-ups', activityId: 'activity-1' });
  assert.equal(recurrence.created, true);
  assert.equal(recurrence.exception.previousId, created.id);
  assert.equal(core.listExceptions({ actor: ADMIN }).length, 2);
});

test('the weekly summary separates ordinary progress from outstanding exceptions', () => {
  const { core } = harness({ grants: grantAll(ADMIN) });
  const overdue = core.recordException({
    actor: ADMIN, kind: 'venue_unconfirmed', reason: 'venue unconfirmed', activityId: 'activity-1',
    handlerId: 'ops-admin-1', deadline: '2026-09-20T10:00:00Z', impact: 'event may be canceled', recommendation: 'confirm or cancel',
  }).exception;
  const unassigned = core.recordException({ actor: ADMIN, kind: 'funding', reason: 'available funds unknown', activityId: 'activity-2', deadline: '2026-09-30T10:00:00Z' }).exception;
  const tracked = core.recordException({ actor: ADMIN, kind: 'material', reason: 'photos pending', activityId: 'activity-3', handlerId: 'ops-admin-2', deadline: '2026-09-30T10:00:00Z' }).exception;
  core.updateException({ actor: ADMIN, exceptionId: tracked.id, status: 'in_progress' });

  const summary = core.buildWeeklySummary({
    actor: ADMIN,
    period: { start: '2026-09-18T00:00:00Z', end: '2026-09-24T23:59:59Z' },
    timezone: 'America/Los_Angeles',
    progress: [
      { section: 'events_this_week', summary: 'Agent safety reading group held', status: 'done', ownerId: 'lead-1' },
      { section: 'proposal_progress', summary: 'Two proposals await evaluation', status: 'pending' },
    ],
  });

  assert.deepEqual(summary.period, { start: '2026-09-18T00:00:00.000Z', end: '2026-09-24T23:59:59.000Z' });
  assert.equal(summary.timezone, 'America/Los_Angeles');
  assert.equal(summary.ordinaryProgress.events_this_week.length, 1);
  assert.equal(summary.ordinaryProgress.proposal_progress[0].status, 'pending');
  // No exception record leaks into ordinary progress.
  const serialized = JSON.stringify(summary.ordinaryProgress);
  for (const exception of [overdue, unassigned, tracked]) assert.equal(serialized.includes(exception.id), false);

  assert.equal(summary.exceptions.outstanding.length, 3);
  assert.deepEqual(summary.exceptions.overdue.map(entry => entry.id), [overdue.id]);
  assert.deepEqual(summary.exceptions.unassigned.map(entry => entry.id), [unassigned.id]);
  for (const entry of summary.exceptions.outstanding) {
    assert.ok(entry.status);
    assert.ok(entry.recommendation);
    assert.ok('handlerId' in entry);
  }
  // "What you need to do" first: overdue and unassigned, then still-open work.
  assert.deepEqual(summary.decisionsNeeded.map(entry => entry.id), [overdue.id, unassigned.id]);
  assert.equal(summary.decisionsNeeded[0].recommendation, 'confirm or cancel');
  assert.equal(summary.decisionsNeeded[1].recommendation, 'assign a responsible handler');

  // Absent data is reported as absent, never invented.
  const gaps = summary.dataGaps.map(gap => gap.section);
  assert.ok(gaps.includes('members') && gaps.includes('metrics'));
  assert.ok(!gaps.includes('events_this_week'));
  assert.equal(summary.automationReadiness.ready, false);
  assert.equal(summary.automationReadiness.policyVersion, null);
  // The report never claims delivery: recorded intents stay pending.
  assert.equal(summary.delivery.externalDelivery, 'not_connected');
  assert.equal(summary.delivery.adapterConnected, false);
  assert.equal(summary.delivery.pendingIntents, 0);

  assert.throws(() => core.buildWeeklySummary({
    actor: ADMIN,
    period: { start: '2026-09-18T00:00:00Z', end: '2026-09-24T23:59:59Z' },
    progress: [{ section: 'exceptions', summary: 'x', status: 'pending' }],
  }), error => error.code === 'validation');
});

test('summary and read access require their own capabilities', () => {
  const { core } = harness({ grants: [{ actorId: LEAD.id, action: 'oversight.read' }] });
  assert.throws(() => core.buildWeeklySummary({ actor: LEAD, period: { start: '2026-09-18T00:00:00Z', end: '2026-09-24T23:59:59Z' } }),
    error => error.code === 'unauthorized');
  assert.throws(() => core.recordException({ actor: LEAD, kind: 'x', reason: 'y' }), error => error.code === 'unauthorized');
  assert.deepEqual(core.listExceptions({ actor: LEAD }), []);
});

test('every mutation records an audit event with actor, action and resource', () => {
  const { core } = harness({ grants: grantAll(ADMIN) });
  core.pauseAutomation({ actor: ADMIN, scope: 'activity', activityId: 'activity-1', reason: 'safety review' });
  core.recordException({ actor: ADMIN, kind: 'safety', reason: 'unclear safety plan', activityId: 'activity-1' });
  const audit = core.listAuditEvents({ actor: ADMIN });
  assert.deepEqual(audit.map(event => event.action), ['oversight.pause', 'oversight.exception.record']);
  assert.equal(audit[0].actorId, ADMIN.id);
  assert.deepEqual(audit[0].resource, { kind: 'activity', activityId: 'activity-1' });
  assert.deepEqual(core.listAuditEvents({ actor: ADMIN, activityId: 'activity-1' }).length, 2);
  assert.deepEqual(core.listAuditEvents({ actor: ADMIN, activityId: 'activity-9' }), []);
});

test('the ledger store keeps pauses, exceptions and idempotency across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rein-oversight-'));
  try {
    const ledger = createLedger(join(dir, 'ledger.json'));
    const first = harness({ grants: STAFF_GRANTS, policy: APPROVED_POLICY, store: createLedgerStore(ledger, { actor: ADMIN.id }) });
    const pause = first.core.pauseAutomation({ actor: ADMIN, scope: 'category', category: 'automation.reminder', reason: 'incident' });
    first.core.dispatchAutomation({ actor: AGENT, category: 'automation.reminder', items: [item('r1', { idempotencyKey: 'key-1', dueAt: '2026-09-24T09:00:00Z' })] });
    first.core.recordException({ actor: ADMIN, kind: 'unanswered_follow_up', reason: 'no response after 2 follow-ups', activityId: 'activity-1' });

    const second = harness({ grants: STAFF_GRANTS, store: createLedgerStore(ledger, { actor: ADMIN.id }) });
    assert.equal(second.core.isAutomationPaused({ actor: ADMIN, category: 'automation.reminder' }).paused, true);
    assert.equal(second.core.listRetainedItems({ actor: ADMIN }).length, 1);
    assert.equal(second.core.listExceptions({ actor: ADMIN }).length, 1);
    assert.equal(second.core.getPolicy({ actor: ADMIN }).version, APPROVED_POLICY.version);
    assert.throws(() => second.core.resumeAutomation({ actor: ADMIN, pauseId: pause.pause.id }),
      error => error.code === 'reconciliation_required');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale core cannot silently drop a write, and an identical retry stays idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rein-oversight-conflict-'));
  try {
    const ledger = createLedger(join(dir, 'ledger.json'));
    const storeA = createLedgerStore(ledger, { actor: 'core-a' });
    const storeB = createLedgerStore(ledger, { actor: 'core-b' });
    // Both cores load the same empty revision before either writes.
    const a = harness({ grants: STAFF_GRANTS, store: storeA });
    const b = harness({ grants: STAFF_GRANTS, store: storeB });

    a.core.recordException({ actor: ADMIN, kind: 'venue_unconfirmed', reason: 'venue unconfirmed', activityId: 'activity-1' });
    assert.throws(
      () => b.core.recordException({ actor: ADMIN, kind: 'funding', reason: 'available funds unknown', activityId: 'activity-2' }),
      error => error instanceof OversightError && error.code === 'storage_conflict'
        && error.details.expectedSequence === 0 && error.details.storedSequence === 1,
    );

    // The first write survives; the conflicting write left no trace.
    const reloaded = harness({ grants: STAFF_GRANTS, store: createLedgerStore(ledger, { actor: 'core-a' }) });
    assert.deepEqual(reloaded.core.listExceptions({ actor: ADMIN }).map(entry => entry.activityId), ['activity-1']);
    assert.equal(reloaded.core.snapshot().sequence, 1);

    // Replaying the exact same revision through the writing store is a retry, not a conflict.
    const revision = reloaded.core.snapshot();
    storeA.save(revision);
    assert.equal(reloaded.core.snapshot().sequence, 1);
    assert.equal(createLedger(join(dir, 'ledger.json')).snapshot().audit.length, 1);

    // A persistence inconsistency still surfaces as one typed error, never as a raw failure: the
    // same revision written under another actor name cannot be treated as a silent retry.
    assert.throws(() => createLedgerStore(ledger, { actor: 'core-d' }).save(revision),
      error => error instanceof OversightError && error.code === 'storage_conflict');

    // A stale revision written into an empty slot is a conflict too, not a fresh first write.
    const fresh = createLedgerStore(createLedger(join(dir, 'other.json')), { actor: 'core-e' });
    assert.throws(() => fresh.save({ sequence: 3, audit: [{ at: '2026-09-24T10:00:00Z' }] }),
      error => error.code === 'storage_conflict' && error.details.expectedSequence === 2 && error.details.storedSequence === null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
