// Rein-owned deterministic change coordinator (PRD R20, AC11; US09, US10).
//
// Scope: take the accepted instructions that `changes.ts` produced for one change or cancellation
// record and apply the subset the activities core actually owns an API for. Everything here is
// local and deterministic: no network calls, no timers, nothing published, no payment.
//
// What this module can and cannot guarantee, stated precisely:
// - There is no cross-core transaction. The change core and the activity core keep separate
//   durable records, so the coordinator cannot make "change accepted" and "activity updated"
//   atomic. It writes a durable dispatch marker before the core calls and rewrites it with the
//   per-operation result afterwards. If a run dies after the marker but before the final write,
//   the next attempt reports `uncertain` and refuses to re-apply, instead of risking a silent
//   double effect that only a human can distinguish from a single one.
// - Only instructions with a guarded activities-core API are applied: the cancellation
//   transition, pause, an explicit resume to `approved`/`preparing`, and a funding request and
//   ceiling from a recorded governance decision. Every other instruction (activity field edits, lead assignment,
//   reminder changes, registration changes, finance review/settlement, permission grants) is
//   retained with a reason code. Retained means not applied and never reported as propagated.
// - The coordinator never contacts a chat or website provider and never enqueues an outbox job.
//   Retained instructions stay pending with `externalDelivery: 'not_connected'`, so a plan is not
//   a notification and an accepted change is not a delivery.
// - Authorization is explicit actor/capability/resource and the default authorizer grants
//   nothing. `change.apply`/`change.read` are checked against the verified `change.activityId`
//   once the change is loaded, so an activity-scoped grant works and a grant for another activity
//   does not. The same actor must also hold `change.read` on the change core and the matching
//   `activity.transition`/`finance.approve` capability on the activity core, or the underlying
//   core refuses the call and the coordinator records a blocker.
// - Dispatch is idempotent per change, not only per key: a repeated key for a different change is
//   refused, and a different key for an already-dispatched change replays the recorded dispatch
//   instead of running the core calls again.
// - Execution fails stop. After the first supported operation is refused, the remaining supported
//   operations are recorded as not attempted for operator review, so a failed activity transition
//   can never be followed by an unrelated finance write in the same dispatch.
// - Handover plans live on the handover record, not on a change record, so this coordinator does
//   not dispatch them. Its instruction vocabulary still covers them for direct planning tests.
import { createHash } from 'node:crypto';
import { EXTERNAL_DELIVERY } from './changes.ts';

export { EXTERNAL_DELIVERY };

export const COORDINATOR_CAPABILITIES = ['change.apply', 'change.read'];

// `pending` is a durable marker: an attempt started and its outcome is unknown until the final
// write lands. The other states describe a finished dispatch.
export const COORDINATOR_STATES = ['pending', 'applied', 'partially_applied', 'retained_only', 'blocked'];

// Instruction namespaces in the order `changes.ts` emits them. An unknown namespace is retained,
// never dropped, so a future instruction type cannot disappear silently.
export const INSTRUCTION_NAMESPACES = ['activity', 'reminders', 'registration', 'finance', 'grants'];

// Instructions the coordinator can hand to a guarded activities-core method.
export const SUPPORTED_INSTRUCTION_ACTIONS = {
  activity: ['transition', 'pause', 'resume'],
  reminders: [],
  registration: [],
  finance: ['request_funding', 'set_approved_ceiling'],
  grants: [],
};

// Every reason an instruction can be retained. Retained instructions are reported, not applied.
export const RETAINED_REASONS = {
  activity_field_update_not_supported: 'the activities core owns no field-edit API, so confirmed field values stay in the change record only',
  activity_readiness_recheck_not_supported: 'readiness recheck is a review action with no activities-core API',
  activity_transition_not_supported: 'only the cancellation transition is applied from a change record; other transitions need their own approved flow',
  lead_assignment_not_supported: 'the activities core cannot change a lead after creation; the handover record is the authority',
  resume_target_unspecified: 'resume needs an explicit approved or preparing target; the core will not guess the state to return to',
  reminder_cancellation_not_supported: 'the activities core exposes no reminder-cancel API; a cancellation transitions the activity, which cancels reminders in the core',
  reminder_reschedule_not_supported: 'rescheduling reminders needs concrete new times, which this plan does not carry',
  reminder_reassignment_not_supported: 'the activities core exposes no reminder-reassignment API',
  registration_state_not_owned_by_activity_core: 'the activities core owns no registration state; the registration owner must apply this',
  registration_page_update_not_supported: 'the activities core owns no registration page; a website adapter must apply this',
  finance_record_review_not_supported: 'reviewing a finance record is a finance-owner action with no activities-core API',
  finance_settlement_not_supported: 'settlement needs a finance-owner record with actual amounts; the coordinator does not enter money',
  grants_not_owned_by_activity_core: 'the activities core owns no permission grants',
  unclassified_instruction_namespace: 'this instruction namespace has no agreed handling in the coordinator',
  unknown_activity_action: 'this activity instruction action is not in the supported vocabulary',
  unknown_finance_action: 'this finance instruction action is not in the supported vocabulary',
};

export class ChangeCoordinatorError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ChangeCoordinatorError';
    this.code = code;
    this.details = details ?? {};
  }
}

function clone(value: any) { return structuredClone(value); }

function text(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) throw new ChangeCoordinatorError('validation', `${field} must be a non-empty string`);
  return value.trim();
}

function timestamp(value: unknown, field: string) {
  const iso = value instanceof Date ? value.toISOString() : text(value, field);
  if (!Number.isFinite(Date.parse(iso))) throw new ChangeCoordinatorError('validation', `${field} must be a timestamp`);
  return new Date(iso).toISOString();
}

function retained(namespace: string, index: number, instruction: any, code: string, message = RETAINED_REASONS[code]) {
  return { namespace, index, instruction: clone(instruction ?? null), code, message: message ?? code };
}

/**
 * Map one activity instruction onto an activities-core method, or state why it is retained. Pure.
 * The mapping is deliberately narrow: only transitions the core guards itself are used, so a wrong
 * plan is refused by the core instead of being forced through.
 */
function mapActivityInstruction(instruction: any, index: number, retainedItems: any[]) {
  const action = instruction?.action;
  if (action === 'transition') {
    if (instruction.to === 'canceled') {
      return { method: 'transitionActivity', args: { to: 'canceled', reason: instruction.reason ?? null } };
    }
    retainedItems.push(retained('activity', index, instruction, 'activity_transition_not_supported'));
    return null;
  }
  if (action === 'pause') {
    return { method: 'transitionActivity', args: { to: 'paused', reason: instruction.reason ?? null } };
  }
  if (action === 'resume') {
    if (instruction.to === 'approved' || instruction.to === 'preparing') {
      return { method: 'transitionActivity', args: { to: instruction.to, reason: instruction.reason ?? null } };
    }
    retainedItems.push(retained('activity', index, instruction, 'resume_target_unspecified'));
    return null;
  }
  if (action === 'update_fields') {
    retainedItems.push(retained('activity', index, instruction, 'activity_field_update_not_supported'));
    return null;
  }
  if (action === 'recheck_readiness') {
    retainedItems.push(retained('activity', index, instruction, 'activity_readiness_recheck_not_supported'));
    return null;
  }
  if (action === 'set_lead') {
    retainedItems.push(retained('activity', index, instruction, 'lead_assignment_not_supported'));
    return null;
  }
  retainedItems.push(retained('activity', index, instruction, 'unknown_activity_action'));
  return null;
}

function mapFinanceInstruction(instruction: any, index: number, retainedItems: any[]) {
  if (instruction?.action === 'request_funding') {
    return {
      method: 'requestFunding',
      args: { amountMinor: instruction.amountMinor, currency: instruction.currency },
    };
  }
  if (instruction?.action === 'set_approved_ceiling') {
    return {
      method: 'approveFunding',
      args: {
        ceilingMinor: instruction.amountMinor,
        currency: instruction.currency,
        allocationReference: instruction.allocationReference,
      },
    };
  }
  if (instruction?.action === 'review_finance_record') {
    retainedItems.push(retained('finance', index, instruction, 'finance_record_review_not_supported'));
    return null;
  }
  if (instruction?.action === 'settle_incurred_costs') {
    retainedItems.push(retained('finance', index, instruction, 'finance_settlement_not_supported'));
    return null;
  }
  retainedItems.push(retained('finance', index, instruction, 'unknown_finance_action'));
  return null;
}

const RETAINED_ONLY = {
  reminders: {
    cancel: 'reminder_cancellation_not_supported',
    reschedule: 'reminder_reschedule_not_supported',
    reassign: 'reminder_reassignment_not_supported',
  },
  registration: {
    close: 'registration_state_not_owned_by_activity_core',
    pause: 'registration_state_not_owned_by_activity_core',
    update_page: 'registration_page_update_not_supported',
    update_contact: 'registration_page_update_not_supported',
  },
  grants: {
    grant: 'grants_not_owned_by_activity_core',
    revoke: 'grants_not_owned_by_activity_core',
  },
};

function retainedCode(namespace: string, action: unknown) {
  return RETAINED_ONLY[namespace]?.[action] ?? 'unclassified_instruction_namespace';
}

/**
 * Split accepted change instructions into the operations the activities core can apply and the
 * instructions that must be retained. Pure: no state, no clock, no I/O. A retained instruction is
 * reported with a reason code and is never turned into an operation.
 */
export function planChangeApplication({ changeId = null, activityId, instructions }: any = {}) {
  if (!instructions || typeof instructions !== 'object' || Array.isArray(instructions)) {
    throw new ChangeCoordinatorError('change_plan_unavailable', 'accepted change instructions must be an object of instruction namespaces');
  }
  const id = text(activityId, 'activityId');
  const operations: any[] = [];
  const retainedItems: any[] = [];
  const namespaces = [...INSTRUCTION_NAMESPACES, ...Object.keys(instructions).filter(key => !INSTRUCTION_NAMESPACES.includes(key)).sort()];
  for (const namespace of namespaces) {
    const list = instructions[namespace];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) throw new ChangeCoordinatorError('validation', `instructions.${namespace} must be an array`);
    list.forEach((instruction: any, index: number) => {
      let mapping = null;
      if (namespace === 'activity') mapping = mapActivityInstruction(instruction, index, retainedItems);
      else if (namespace === 'finance') mapping = mapFinanceInstruction(instruction, index, retainedItems);
      else retainedItems.push(retained(namespace, index, instruction, retainedCode(namespace, instruction?.action)));
      if (mapping) {
        operations.push({
          id: `op-${operations.length + 1}`,
          namespace,
          index,
          instruction: clone(instruction),
          method: mapping.method,
          args: clone(mapping.args),
        });
      }
    });
  }
  return {
    changeId: changeId === null ? null : text(changeId, 'changeId'),
    activityId: id,
    operations,
    retained: retainedItems,
    counts: { operations: operations.length, retained: retainedItems.length, total: operations.length + retainedItems.length },
  };
}

/** Explicit actor/capability/resource authorizer for the coordinator. A grant without `activityId` covers every activity. */
export function createCoordinatorAuthorizer(grants: { actorId: string; capability: string; activityId?: string }[] = []) {
  const list = grants.map(grant => ({ ...grant }));
  return ({ actor, capability, activityId }: any) => {
    const match = list.find(grant =>
      grant.actorId === actor?.id && grant.capability === capability &&
      (grant.activityId === undefined || grant.activityId === activityId));
    return match ? { allowed: true, reason: 'granted' } : { allowed: false, reason: 'no_grant' };
  };
}

/**
 * Persistence port for the shared local ledger, compatible with the other cores' stores. Every
 * save states the sequence it was derived from; a state another writer already advanced past is
 * refused instead of silently overwriting the newer dispatch records.
 */
export function createCoordinatorStore(ledger: { snapshot: () => any; transact: (input: any) => any }, options: { key?: string; actor?: string; slot?: string } = {}) {
  const slot = options.slot ?? 'reinChangeDispatch';
  return {
    load() { return ledger.snapshot()?.records?.[slot] ?? null; },
    save(state: any) {
      const fingerprint = createHash('sha256').update(JSON.stringify(state)).digest('hex');
      ledger.transact({
        key: `${options.key ?? 'rein-change-dispatch'}:${state.sequence}:${fingerprint}`,
        actor: options.actor ?? 'change-coordinator',
        action: 'persist',
        at: state.audit.at(-1)?.at ?? new Date().toISOString(),
        apply(records: any) {
          const previousSequence = records[slot]?.sequence ?? 0;
          if (previousSequence !== state.sequence - 1) {
            throw new ChangeCoordinatorError('storage_conflict', 'dispatch state changed in another process; reload before retrying', {
              expectedSequence: state.sequence - 1,
              actualSequence: previousSequence,
            });
          }
          records[slot] = state;
        },
      });
    },
  };
}

/**
 * Durable handoff between the change core and the activity core. `changes` must expose
 * `getChange({ actor, changeId })`; `operations` is the activities core. Only accepted
 * (`applied`) change records are dispatched. The coordinator applies supported operations one at a
 * time through the core's guarded methods and records the outcome per operation.
 */
export function createChangeCoordinator(options: {
  now?: () => string | Date;
  authorize?: (request: { actor: any; capability: string; activityId?: string }) => { allowed: boolean; reason?: string };
  changes?: { getChange: (input: { actor: any; changeId: string }) => any };
  operations?: Record<string, (input: any) => any>;
  store?: { load: () => any; save: (state: any) => void };
} = {}) {
  const now = () => {
    const value = options.now ? options.now() : new Date();
    return value instanceof Date ? value.toISOString() : timestamp(value, 'now');
  };
  const authorize = options.authorize ?? (() => ({ allowed: false, reason: 'no_authorizer_configured' }));
  const changes = options.changes;
  const operations = options.operations;
  const store = options.store;

  const emptyState = () => ({ sequence: 0, idCounters: {}, dispatches: {}, keys: {}, audit: [] });
  let state = (store?.load && store.load()) ?? emptyState();

  function requireCapability(actor: any, capability: string, activityId?: string | null) {
    requireActor(actor, capability);
    const decision = authorize({ actor, capability, activityId: activityId ?? undefined });
    if (!decision?.allowed) {
      throw new ChangeCoordinatorError('unauthorized', `actor ${actor.id} lacks ${capability}`, { capability, reason: decision?.reason ?? 'denied' });
    }
    return actor;
  }

  function requireActor(actor: any, capability?: string) {
    if (!actor || typeof actor.id !== 'string' || !actor.id.trim()) {
      throw new ChangeCoordinatorError('unauthorized', 'an actor with an id is required', capability ? { capability } : {});
    }
    return actor;
  }

  function commit(action: string, actor: any, activityId: string | null, mutate: (draft: any) => any) {
    const draft = clone(state);
    const result = mutate(draft);
    draft.sequence += 1;
    draft.audit.push({ seq: draft.sequence, at: now(), actorId: actor.id, action, activityId });
    store?.save(draft);
    state = draft;
    return result;
  }

  function nextId(draft: any, prefix: string) {
    draft.idCounters[prefix] = (draft.idCounters[prefix] ?? 0) + 1;
    return `${prefix}-${draft.idCounters[prefix]}`;
  }

  function outcomeOf(record: any) {
    return record.state === 'pending' ? 'uncertain' : record.state;
  }

  function readChange(actor: any, changeId: unknown) {
    if (!changes?.getChange) {
      throw new ChangeCoordinatorError('change_source_unavailable', 'no change source is configured; the coordinator cannot verify an accepted change');
    }
    const value = changes.getChange({ actor, changeId: text(changeId, 'changeId') });
    if (!value) throw new ChangeCoordinatorError('not_found', `change ${changeId} does not exist`);
    return value;
  }

  // The change is loaded first so its activity id can scope the coordinator's own capability
  // check; `getChange` still authorizes the read on the change core.
  function loadAcceptedChange(actor: any, changeId: unknown) {
    const change = readChange(actor, changeId);
    if (change.state === 'rejected') {
      throw new ChangeCoordinatorError('change_rejected', 'the governance decision rejected this change; nothing is applied', { changeId: change.id });
    }
    if (change.state !== 'applied') {
      throw new ChangeCoordinatorError('change_not_accepted', `change ${change.state} has no accepted instructions to apply`, { changeId: change.id, state: change.state });
    }
    const instructions = change.plan?.instructions;
    if (!instructions) {
      throw new ChangeCoordinatorError('change_plan_unavailable', `change ${change.id} has no accepted instruction plan`, { changeId: change.id });
    }
    return change;
  }

  function executeOperation(operation: any, actor: any, activityId: string) {
    if (operation.instruction?.action === 'resume' && typeof operations?.getActivity === 'function') {
      const current = operations.getActivity(activityId);
      if (current?.state === operation.args?.to) {
        return { state: current.state, unchanged: true, reason: 'already_in_resume_target' };
      }
    }
    if (operation.instruction?.action === 'request_funding' && typeof operations?.getFinance === 'function') {
      const current = operations.getFinance(activityId);
      if (current?.state !== 'not_requested') {
        if (current?.requestedMinor === operation.args?.amountMinor && current?.currency === operation.args?.currency) {
          return { state: current.state, unchanged: true, reason: 'matching_funding_request_exists' };
        }
        throw new ChangeCoordinatorError('finance_request_conflict', 'an existing funding request differs from the approved change', {
          requestedMinor: current?.requestedMinor,
          currency: current?.currency,
        });
      }
    }
    const method = operations?.[operation.method];
    if (typeof method !== 'function') {
      throw new ChangeCoordinatorError('operations_method_missing', `the activities core does not expose ${operation.method}`, { method: operation.method });
    }
    return method.call(operations, { actor, activityId, ...clone(operation.args) });
  }

  return {
    authorize(request: { actor: any; capability: string; activityId?: string }) {
      if (!request?.actor?.id) throw new ChangeCoordinatorError('unauthorized', 'an actor with an id is required');
      const decision = authorize(request);
      return { allowed: Boolean(decision?.allowed), reason: decision?.reason ?? 'denied' };
    },

    /** Read-only plan for one accepted change. Requires `change.read` on the coordinator and the change core. */
    plan({ actor, changeId }: any) {
      requireActor(actor, 'change.read');
      const change = loadAcceptedChange(actor, changeId);
      requireCapability(actor, 'change.read', change.activityId);
      return planChangeApplication({ changeId: change.id, activityId: change.activityId, instructions: change.plan.instructions });
    },

    /**
     * Apply one accepted change. Dispatch is idempotent per change: a repeat with the same key
     * replays the recorded dispatch, and a different key for the same change replays it too, so no
     * second dispatch or core call happens. A key bound to another change is refused. A dispatch
     * left `pending` by an interrupted run is reported as `uncertain` and is not retried
     * automatically.
     */
    apply({ actor, changeId, idempotencyKey }: any) {
      const key = text(idempotencyKey, 'idempotencyKey');
      requireActor(actor, 'change.apply');
      const change = loadAcceptedChange(actor, changeId);
      requireCapability(actor, 'change.apply', change.activityId);
      const existingId = state.keys[key];
      if (existingId) {
        const existing = state.dispatches[existingId];
        if (existing.action !== 'change.apply' || existing.changeId !== change.id) {
          throw new ChangeCoordinatorError('idempotency_key_reused', `idempotency key ${key} was already used for ${existing.action} on ${existing.changeId}`, { key, changeId: existing.changeId });
        }
        return { ...clone(existing), replayed: true, deduplicated: false, outcome: outcomeOf(existing) };
      }
      const priorId = Object.keys(state.dispatches).find(id => state.dispatches[id].changeId === change.id);
      if (priorId) {
        const prior = commit('coordinator.dedupe', actor, change.activityId, draft => {
          draft.keys[key] = priorId;
          return clone(draft.dispatches[priorId]);
        });
        return { ...prior, replayed: true, deduplicated: true, outcome: outcomeOf(prior) };
      }
      const plan = planChangeApplication({ changeId: change.id, activityId: change.activityId, instructions: change.plan.instructions });

      // Durable marker before any core call: a crash here leaves an honest `pending` dispatch.
      const pending = commit('coordinator.pending', actor, change.activityId, draft => {
        const id = nextId(draft, 'dispatch');
        const at = now();
        const record = {
          id, action: 'change.apply', changeId: change.id, activityId: change.activityId,
          state: 'pending', idempotencyKey: key,
          plan: clone(plan), applied: [], blocked: [], retained: clone(plan.retained),
          stoppedAt: null,
          externalDelivery: EXTERNAL_DELIVERY, delivered: false,
          requestedBy: actor.id, createdAt: at, updatedAt: at,
        };
        draft.dispatches[id] = record;
        draft.keys[key] = id;
        return clone(record);
      });

      const applied: any[] = [];
      const blocked: any[] = [];
      let stoppedAt: string | null = null;
      for (const operation of plan.operations) {
        if (stoppedAt !== null) {
          blocked.push({
            operationId: operation.id, namespace: operation.namespace, action: operation.instruction.action,
            code: 'not_attempted_after_earlier_failure',
            message: `execution stopped at ${stoppedAt}; this operation was not attempted and needs operator review`,
          });
          continue;
        }
        try {
          const result = executeOperation(operation, actor, change.activityId);
          applied.push({
            operationId: operation.id, namespace: operation.namespace,
            action: operation.instruction.action, method: operation.method, result: clone(result ?? null),
          });
        } catch (error: any) {
          blocked.push({
            operationId: operation.id, namespace: operation.namespace, action: operation.instruction.action,
            code: error?.code ?? 'operations_error', message: error?.message ?? String(error),
          });
          stoppedAt = operation.id;
        }
      }
      const outcome = plan.operations.length === 0 ? 'retained_only'
        : blocked.length === 0 ? 'applied'
          : applied.length === 0 ? 'blocked' : 'partially_applied';

      return commit('coordinator.apply', actor, change.activityId, draft => {
        const record = draft.dispatches[pending.id];
        record.state = outcome;
        record.applied = applied;
        record.blocked = blocked;
        record.stoppedAt = stoppedAt;
        record.updatedAt = now();
        return { ...clone(record), replayed: false, deduplicated: false, outcome };
      });
    },

    getDispatch({ actor, dispatchId }: any) {
      const record = state.dispatches[text(dispatchId, 'dispatchId')];
      if (!record) throw new ChangeCoordinatorError('not_found', `dispatch ${dispatchId} does not exist`);
      requireCapability(actor, 'change.read', record.activityId);
      return { ...clone(record), outcome: outcomeOf(record) };
    },
    listDispatches({ actor, changeId, activityId }: any = {}) {
      requireCapability(actor, 'change.read', activityId ?? null);
      return Object.values(state.dispatches)
        .filter((record: any) => (!changeId || record.changeId === changeId) && (!activityId || record.activityId === activityId))
        .map((record: any) => ({ ...clone(record), outcome: outcomeOf(record) }));
    },
    snapshot() { return clone(state); },
  };
}
