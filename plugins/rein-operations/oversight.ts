// Rein-owned deterministic oversight core (PRD §9.2, R18, AC18, AC19).
//
// Scope: scoped pause/resume of proactive automation, exception intake with deduplication, and the
// weekly summary that separates ordinary progress from outstanding exceptions.
//
// Local and deterministic: no network calls, nothing delivered externally. `dispatchAutomation`
// records idempotent outbound intents and reports `externalDelivery: 'not_connected'`.
// Authorization is explicit actor/action/resource; a prompt, a manifest declaration or a
// caller-supplied actor id is never an authorization check. A pause stops proactive dispatch only:
// audit reads, human exception handling and the weekly summary keep working, and stopped work is
// retained instead of disappearing.
import { createHash } from 'node:crypto';

export const AUTOMATION_CATEGORIES = [
  'automation.welcome',
  'automation.reminder',
  'automation.event_space',
  'automation.registration_notice',
  'automation.outcome_follow_up',
  'automation.publication',
  'automation.weekly_summary',
];

export const OVERSIGHT_CAPABILITIES = [
  'oversight.read',
  'oversight.exception.manage',
  'oversight.pause',
  'oversight.policy.approve',
  'oversight.summary.read',
  'automation.dispatch',
];

export const PAUSE_SCOPES = ['all', 'category', 'activity'];
export const EXCEPTION_STATUSES = ['open', 'in_progress', 'resolved'];
export const PROGRESS_STATUSES = ['on_track', 'at_risk', 'blocked', 'done', 'pending', 'no_data'];

// Ordinary progress sections of the weekly summary (PRD §9.2). Outstanding exceptions are reported
// separately and never inside these sections.
export const SUMMARY_SECTIONS = [
  'members',
  'contributor_progress',
  'events_this_week',
  'plans_next_two_weeks',
  'proposal_progress',
  'funding_commitments',
  'completion_reviews',
  'published_outcomes',
];

// No chat or website adapter is connected in this repository. Dispatch records intent only.
export const EXTERNAL_DELIVERY = 'not_connected';

const MAX_DISPATCH_ITEMS = 200;

export class OversightError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'OversightError';
    this.code = code;
    this.details = details ?? {};
  }
}

function clone(value: any) { return structuredClone(value); }

function text(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OversightError('validation', `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string) {
  return value === undefined || value === null ? null : text(value, field);
}

function timestamp(value: unknown, field: string) {
  const iso = value instanceof Date ? value.toISOString() : text(value, field);
  if (!Number.isFinite(Date.parse(iso))) throw new OversightError('validation', `${field} must be a timestamp`);
  return new Date(iso).toISOString();
}

function canonicalize(value: any): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function derivedKey(parts: unknown[]) {
  return `derived-${createHash('sha256').update(canonicalize(parts)).digest('hex').slice(0, 24)}`;
}

// Recurring exceptions merge instead of producing a stream of duplicate alerts (PRD §9.2), so the
// derived key ignores volatile numbers such as "no response after 2 follow-ups".
function normalizeReason(reason: string) {
  return reason.toLowerCase().replace(/\s+/g, ' ').replace(/\d+/g, '#').trim();
}

/**
 * Explicit actor/action/resource authorizer. A grant without `scope` covers every resource for that
 * action; `scope: 'category'` and `scope: 'activity'` narrow it to one target.
 */
export function createOversightAuthorizer(grants: { actorId: string; action: string; scope?: 'all' | 'category' | 'activity'; category?: string; activityId?: string }[] = []) {
  const list = grants.map(grant => ({ ...grant }));
  return ({ actor, action, resource }: { actor: any; action: string; resource: any }) => {
    const match = list.find(grant => grant.actorId === actor?.id && grant.action === action && grantCovers(grant, resource));
    return match ? { allowed: true, reason: 'granted' } : { allowed: false, reason: 'no_grant' };
  };
}

function grantCovers(grant: any, resource: any) {
  if (grant.scope === undefined || grant.scope === 'all') return true;
  if (grant.scope === 'category') return resource?.kind === 'category' && grant.category === resource.category;
  if (grant.scope === 'activity') return resource?.kind === 'activity' && grant.activityId === resource.activityId;
  return false;
}

// Duck-typed persistence port. `createLedgerStore` adapts the shared local ledger without importing
// it, so this module keeps working if that file moves.
export function createLedgerStore(ledger: { snapshot: () => any; transact: (input: any) => any }, options: { key?: string; actor?: string; slot?: string } = {}) {
  const slot = options.slot ?? 'reinOversight';
  const actor = options.actor ?? 'oversight-core';
  const prefix = options.key ?? 'rein-oversight';
  return {
    load() {
      const records = ledger.snapshot()?.records ?? {};
      return records[slot] ?? null;
    },
    save(state: any) {
      // The idempotency key is a fingerprint of the written revision, never its sequence number.
      // Two cores that both start from the same revision would otherwise collide on `${sequence}`
      // and the ledger would return the first receipt while silently dropping the second write.
      try {
        ledger.transact({
          key: `${prefix}:${createHash('sha256').update(canonicalize(state)).digest('hex')}`,
          actor,
          action: 'persist',
          at: state.audit.at(-1)?.at ?? new Date().toISOString(),
          apply(records: any) {
            // An identical revision is a genuine retry and is deduplicated by the key above. Any
            // other stored revision must be exactly the one this write was computed from.
            const stored = records[slot];
            const actual = stored?.sequence ?? 0;
            if (actual !== state.sequence - 1) {
              throw new OversightError('storage_conflict', 'the stored oversight revision changed under this core', {
                slot,
                expectedSequence: state.sequence - 1,
                storedSequence: stored ? stored.sequence : null,
              });
            }
            records[slot] = state;
          },
        });
      } catch (error) {
        if (error instanceof OversightError) throw error;
        // The shared ledger refuses to reuse a key for another operation; report one typed storage
        // conflict instead of leaking a raw Error to the caller.
        throw new OversightError('storage_conflict', error instanceof Error ? error.message : String(error), { slot });
      }
    },
  };
}

export function createOversightCore(options: {
  now?: () => string | Date;
  authorize?: (request: { actor: any; action: string; resource: any }) => { allowed: boolean; reason?: string };
  store?: { load: () => any; save: (state: any) => void };
} = {}) {
  const now = () => {
    const value = options.now ? options.now() : new Date();
    return value instanceof Date ? value.toISOString() : timestamp(value, 'now');
  };
  const authorize = options.authorize ?? (() => ({ allowed: false, reason: 'no_authorizer_configured' }));
  const store = options.store;

  const emptyState = () => ({
    sequence: 0,
    idCounters: {},
    policy: null,
    pauses: {},
    pauseTargets: {},
    retained: {},
    receipts: {},
    exceptions: {},
    exceptionKeys: {},
    audit: [],
  });

  let state = (store?.load && store.load()) ?? emptyState();
  // There is deliberately no construction-time policy activation: an approved policy only becomes
  // effective through the authorized, audited `approvePolicy` call, and a persisted policy is never
  // overwritten by a constructor argument.

  function requireCapability(actor: any, action: string, resource: any) {
    if (!actor || typeof actor.id !== 'string' || !actor.id.trim()) {
      throw new OversightError('unauthorized', 'an actor with an id is required', { action });
    }
    const decision = authorize({ actor, action, resource });
    if (!decision?.allowed) {
      throw new OversightError('unauthorized', `actor ${actor.id} lacks ${action}`, { action, resource, reason: decision?.reason ?? 'denied' });
    }
    return actor;
  }

  function commit(action: string, actor: any, resource: any, mutate: (draft: any) => any) {
    const draft = clone(state);
    const result = mutate(draft);
    const event = { seq: draft.sequence + 1, at: now(), actorId: actor.id, action, resource: clone(resource ?? { kind: 'global' }) };
    draft.sequence = event.seq;
    draft.audit.push(event);
    store?.save(draft);
    state = draft;
    return result;
  }

  function nextId(draft: any, prefix: string) {
    draft.idCounters[prefix] = (draft.idCounters[prefix] ?? 0) + 1;
    return `${prefix}-${draft.idCounters[prefix]}`;
  }

  // ------------------------------------------------------------------------ pause scope helpers
  function scopeTarget(scope: unknown, input: any) {
    const kind = text(scope, 'scope');
    if (!PAUSE_SCOPES.includes(kind)) throw new OversightError('validation', `scope ${kind} is not a pause scope`, { known: PAUSE_SCOPES });
    if (kind === 'all') return { scope: kind, category: null, activityId: null, targetKey: 'all' };
    if (kind === 'category') {
      const category = text(input?.category, 'category');
      if (!AUTOMATION_CATEGORIES.includes(category)) {
        throw new OversightError('validation', `category ${category} is not an automation category`, { known: AUTOMATION_CATEGORIES });
      }
      return { scope: kind, category, activityId: null, targetKey: `category:${category}` };
    }
    return { scope: kind, category: null, activityId: text(input?.activityId, 'activityId'), targetKey: `activity:${text(input?.activityId, 'activityId')}` };
  }

  function resourceOf(target: any) {
    if (target.scope === 'all') return { kind: 'global' };
    if (target.scope === 'category') return { kind: 'category', category: target.category };
    return { kind: 'activity', activityId: target.activityId };
  }

  function pauseMatches(pause: any, category: any, activityId: any) {
    if (pause.scope === 'all') return true;
    if (pause.scope === 'category') return category !== null && category !== undefined && pause.category === category;
    return activityId !== null && activityId !== undefined && pause.activityId === activityId;
  }

  function activePauses() {
    return (Object.values(state.pauses) as any[]).filter(pause => pause.state === 'active');
  }

  function pauseStateFor(category: any, activityId: any) {
    const matches = activePauses().filter(pause => pauseMatches(pause, category, activityId)).sort((a, b) => a.id.localeCompare(b.id));
    return {
      paused: matches.length > 0,
      scopes: matches.map(pause => ({ id: pause.id, scope: pause.scope, category: pause.category, activityId: pause.activityId, reason: pause.reason, pausedAt: pause.pausedAt, pausedBy: pause.pausedBy })),
    };
  }

  function retainedInScope(pause: any) {
    return (Object.values(state.retained) as any[]).filter(item => pauseMatches(pause, item.category, item.activityId)).map(clone);
  }

  function affectedCategories(pause: any) {
    // A category pause blocks one category; an activity pause blocks every proactive category for
    // that activity; a global pause blocks all of them.
    if (pause.scope === 'category') return [pause.category];
    return [...AUTOMATION_CATEGORIES];
  }

  // ---------------------------------------------------------------- automation policy readiness
  function validatePolicy(raw: any, at: string) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OversightError('validation', 'policy must be an object');
    const categories = (Array.isArray(raw.categories) ? raw.categories : []).map((entry: any, index: number) => {
      const category = text(entry?.category, `policy.categories[${index}].category`);
      if (!AUTOMATION_CATEGORIES.includes(category)) {
        throw new OversightError('validation', `policy category ${category} is not an automation category`, { known: AUTOMATION_CATEGORIES });
      }
      return { category, handlerId: text(entry?.handlerId, `policy.categories[${index}].handlerId`) };
    });
    const seen = new Set<string>();
    for (const entry of categories) {
      if (seen.has(entry.category)) throw new OversightError('validation', `policy lists ${entry.category} twice`);
      seen.add(entry.category);
    }
    return {
      version: text(raw.version, 'policy.version'),
      approvedBy: text(raw.approvedBy, 'policy.approvedBy'),
      approvedAt: timestamp(raw.approvedAt, 'policy.approvedAt'),
      categories,
      recordedAt: at,
    };
  }

  // Refuses outbound automatic actions unless an approved policy names the category and its
  // responsible handler (PRD §11, R18). No default policy is activated implicitly.
  function policyGate(category: string) {
    if (!state.policy) return { ready: false, reason: 'policy_not_approved', handlerId: null };
    const entry = state.policy.categories.find((item: any) => item.category === category);
    if (!entry) return { ready: false, reason: 'automation_category_not_approved', handlerId: null };
    if (!entry.handlerId) return { ready: false, reason: 'handler_not_configured', handlerId: null };
    return { ready: true, reason: 'approved', handlerId: entry.handlerId, policyVersion: state.policy.version };
  }

  function policySummary() {
    const approvedCategories = state.policy ? state.policy.categories.map((entry: any) => entry.category) : [];
    const blocked = AUTOMATION_CATEGORIES
      .filter(category => !approvedCategories.includes(category))
      .map(category => ({ category, reason: state.policy ? 'automation_category_not_approved' : 'policy_not_approved' }));
    return {
      policyVersion: state.policy?.version ?? null,
      approvedBy: state.policy?.approvedBy ?? null,
      approvedAt: state.policy?.approvedAt ?? null,
      approvedCategories,
      ready: blocked.length === 0,
      blocked,
    };
  }

  // ------------------------------------------------------------------------ exception center
  function exceptionView(record: any, at: string) {
    const overdue = record.status !== 'resolved' && record.deadline !== null && Date.parse(record.deadline) <= Date.parse(at);
    const recommendation = record.recommendation
      ?? (!record.handlerId ? 'assign a responsible handler' : overdue ? 'review and resolve before the next cycle' : 'track until resolved');
    return {
      id: record.id,
      kind: record.kind,
      activityId: record.activityId,
      status: record.status,
      handlerId: record.handlerId,
      handlerAssigned: Boolean(record.handlerId),
      deadline: record.deadline,
      overdue,
      occurrences: record.occurrences,
      impact: record.impact,
      recommendation,
      firstSeenAt: record.firstSeenAt,
      lastSeenAt: record.lastSeenAt,
      previousId: record.previousId,
      needsDecision: overdue || !record.handlerId || record.status === 'open',
    };
  }

  function findException(exceptionId: unknown) {
    const id = text(exceptionId, 'exceptionId');
    const found = state.exceptions[id];
    if (!found) throw new OversightError('not_found', `exception ${id} does not exist`);
    return found;
  }

  function exceptionResource(record: any) {
    return record.activityId ? { kind: 'activity', activityId: record.activityId } : { kind: 'global' };
  }

  return {
    // ------------------------------------------------------------- authorization and audit reads
    authorize(request: { actor: any; action: string; resource: any }) {
      if (!request?.actor?.id) throw new OversightError('unauthorized', 'an actor with an id is required');
      const decision = authorize(request);
      return { allowed: Boolean(decision?.allowed), reason: decision?.reason ?? 'denied' };
    },
    listAuditEvents({ actor, activityId = null }: any = {}) {
      requireCapability(actor, 'oversight.read', activityId ? { kind: 'activity', activityId } : { kind: 'global' });
      return state.audit.filter((event: any) => !activityId || event.resource?.activityId === activityId).map(clone);
    },

    // ------------------------------------------------------------------------ automation policy
    approvePolicy({ actor, policy }: any) {
      requireCapability(actor, 'oversight.policy.approve', { kind: 'global' });
      return commit('oversight.policy.approve', actor, { kind: 'global' }, draft => {
        draft.policy = validatePolicy(policy, now());
        return clone(draft.policy);
      });
    },
    getPolicy({ actor }: any = {}) {
      requireCapability(actor, 'oversight.read', { kind: 'global' });
      return clone(state.policy);
    },
    getAutomationReadiness({ actor }: any = {}) {
      requireCapability(actor, 'oversight.read', { kind: 'global' });
      return policySummary();
    },

    // ------------------------------------------------------------------------------ pause/resume
    pauseAutomation({ actor, scope, category = null, activityId = null, reason }: any) {
      const target = scopeTarget(scope, { category, activityId });
      requireCapability(actor, 'oversight.pause', resourceOf(target));
      const existingId = state.pauseTargets[target.targetKey];
      const existing = existingId ? state.pauses[existingId] : null;
      if (existing && existing.state === 'active') {
        return {
          pause: clone(existing),
          deduplicated: true,
          affected: { scope: target.scope, category: target.category, activityId: target.activityId, categories: affectedCategories(existing), retained: retainedInScope(existing).length },
        };
      }
      const pauseReason = text(reason, 'reason');
      return commit('oversight.pause', actor, resourceOf(target), draft => {
        const at = now();
        const id = nextId(draft, 'pause');
        const record = {
          id,
          scope: target.scope,
          category: target.category,
          activityId: target.activityId,
          targetKey: target.targetKey,
          state: 'active',
          reason: pauseReason,
          pausedBy: actor.id,
          pausedAt: at,
          resumedBy: null,
          resumedAt: null,
          resumePlan: null,
          history: [{ at, by: actor.id, action: 'pause', reason: pauseReason }],
        };
        draft.pauses[id] = record;
        draft.pauseTargets[target.targetKey] = id;
        return {
          pause: clone(record),
          deduplicated: false,
          affected: { scope: record.scope, category: record.category, activityId: record.activityId, categories: affectedCategories(record), retained: retainedInScope(record).length },
        };
      });
    },
    resumeAutomation({ actor, pauseId, reconciliation = null }: any) {
      const found = state.pauses[text(pauseId, 'pauseId')];
      if (!found) throw new OversightError('not_found', `pause ${pauseId} does not exist`);
      requireCapability(actor, 'oversight.pause', resourceOf(found));
      if (found.state !== 'active') {
        return { pause: clone(found), alreadyResumed: true, resumePlan: clone(found.resumePlan) };
      }
      const when = now();
      const retained = retainedInScope(found);
      const overdue = retained.filter((item: any) => item.dueAt !== null && Date.parse(item.dueAt) <= Date.parse(when));
      // PRD §9.2: reconcile overdue tasks before resuming to prevent a burst of accumulated
      // notifications. Retained work is never dropped and never released without acknowledgement.
      if (overdue.length > 0 && reconciliation?.acknowledgedOverdue !== true) {
        throw new OversightError('reconciliation_required', 'review overdue retained items before resuming', {
          pauseId: found.id,
          overdue: overdue.map((item: any) => ({ itemId: item.itemId, category: item.category, activityId: item.activityId, dueAt: item.dueAt, summary: item.summary })),
        });
      }
      return commit('oversight.resume', actor, resourceOf(found), draft => {
        const at = now();
        const record = draft.pauses[found.id];
        const resumePlan = {
          scope: record.scope,
          category: record.category,
          activityId: record.activityId,
          retainedCount: retained.length,
          overdueCount: overdue.length,
          recommendation: overdue.length > 0
            ? 'dispatch or reschedule each overdue item deliberately; do not replay the backlog at once'
            : 'resume normal dispatch; no overdue retained work',
        };
        record.state = 'resumed';
        record.resumedBy = actor.id;
        record.resumedAt = at;
        record.resumePlan = resumePlan;
        record.history.push({
          at,
          by: actor.id,
          action: 'resume',
          note: optionalText(reconciliation?.notes, 'reconciliation.notes'),
          acknowledgedOverdue: reconciliation?.acknowledgedOverdue === true,
          reviewedItemIds: Array.isArray(reconciliation?.reviewedItemIds) ? reconciliation.reviewedItemIds.map(String) : [],
        });
        delete draft.pauseTargets[record.targetKey];
        return { pause: clone(record), alreadyResumed: false, resumePlan: clone(resumePlan) };
      });
    },
    listPauses({ actor, state: wanted = null }: any = {}) {
      requireCapability(actor, 'oversight.read', { kind: 'global' });
      return (Object.values(state.pauses) as any[]).filter(pause => !wanted || pause.state === wanted).map(clone);
    },
    isAutomationPaused({ actor, category = null, activityId = null }: any) {
      requireCapability(actor, 'oversight.read', activityId ? { kind: 'activity', activityId } : { kind: 'global' });
      return pauseStateFor(category, activityId);
    },
    listAffectedByPause({ actor, pauseId }: any) {
      const found = state.pauses[text(pauseId, 'pauseId')];
      if (!found) throw new OversightError('not_found', `pause ${pauseId} does not exist`);
      requireCapability(actor, 'oversight.read', resourceOf(found));
      const when = now();
      const retained = retainedInScope(found);
      return {
        pause: clone(found),
        active: found.state === 'active',
        scope: { scope: found.scope, category: found.category, activityId: found.activityId },
        affectedCategories: affectedCategories(found),
        retained,
        overdue: retained.filter((item: any) => item.dueAt !== null && Date.parse(item.dueAt) <= Date.parse(when)),
        overdueTasksPreserved: true,
      };
    },

    // ------------------------------------------------------------------ exception center (AC18)
    recordException({ actor, kind, reason, activityId = null, dedupeKey = null, handlerId = null, deadline = null, impact = null, recommendation = null }: any) {
      const resource = activityId ? { kind: 'activity', activityId: text(activityId, 'activityId') } : { kind: 'global' };
      requireCapability(actor, 'oversight.exception.manage', resource);
      const exceptionKind = text(kind, 'kind');
      const exceptionReason = text(reason, 'reason');
      const key = dedupeKey
        ? text(dedupeKey, 'dedupeKey')
        : `${exceptionKind}|${resource.activityId ?? 'global'}|${normalizeReason(exceptionReason)}`;
      const existingId = state.exceptionKeys[key];
      const existing = existingId ? state.exceptions[existingId] : null;
      const handler = optionalText(handlerId, 'handlerId');
      const due = deadline === undefined || deadline === null ? null : timestamp(deadline, 'deadline');
      if (existing && existing.status !== 'resolved') {
        return commit('oversight.exception.merge', actor, resource, draft => {
          const record = draft.exceptions[existing.id];
          const at = now();
          record.occurrences += 1;
          record.lastSeenAt = at;
          record.reason = exceptionReason;
          record.events.push({ at, actorId: actor.id, reason: exceptionReason });
          if (handler) record.handlerId = handler;
          if (due) record.deadline = due;
          if (impact !== null && impact !== undefined) record.impact = text(impact, 'impact');
          if (recommendation !== null && recommendation !== undefined) record.recommendation = text(recommendation, 'recommendation');
          return { exception: clone(record), merged: true, created: false };
        });
      }
      return commit('oversight.exception.record', actor, resource, draft => {
        const at = now();
        const id = nextId(draft, 'exception');
        const record = {
          id,
          dedupeKey: key,
          kind: exceptionKind,
          activityId: resource.activityId ?? null,
          reason: exceptionReason,
          impact: optionalText(impact, 'impact'),
          recommendation: optionalText(recommendation, 'recommendation'),
          handlerId: handler,
          deadline: due,
          status: 'open',
          occurrences: 1,
          firstSeenAt: at,
          lastSeenAt: at,
          previousId: existing ? existing.id : null,
          resolvedAt: null,
          resolvedBy: null,
          resolution: null,
          improvement: null,
          events: [{ at, actorId: actor.id, reason: exceptionReason }],
          history: [],
        };
        draft.exceptions[id] = record;
        draft.exceptionKeys[key] = id;
        return { exception: clone(record), merged: false, created: true };
      });
    },
    updateException({ actor, exceptionId, handlerId, deadline, status, impact, recommendation, note = null }: any) {
      const found = findException(exceptionId);
      requireCapability(actor, 'oversight.exception.manage', exceptionResource(found));
      return commit('oversight.exception.update', actor, exceptionResource(found), draft => {
        const record = draft.exceptions[found.id];
        const changes: any = {};
        if (handlerId !== undefined) {
          const handler = optionalText(handlerId, 'handlerId');
          if (record.handlerId !== handler) { record.handlerId = handler; changes.handlerId = handler; }
        }
        if (deadline !== undefined) {
          const due = deadline === null ? null : timestamp(deadline, 'deadline');
          if (record.deadline !== due) { record.deadline = due; changes.deadline = due; }
        }
        if (impact !== undefined) {
          const value = optionalText(impact, 'impact');
          if (record.impact !== value) { record.impact = value; changes.impact = value; }
        }
        if (recommendation !== undefined) {
          const value = optionalText(recommendation, 'recommendation');
          if (record.recommendation !== value) { record.recommendation = value; changes.recommendation = value; }
        }
        if (status !== undefined) {
          const next = text(status, 'status');
          if (!['open', 'in_progress'].includes(next)) {
            throw new OversightError('validation', 'use resolveException to close an exception', { status: next, known: EXCEPTION_STATUSES });
          }
          if (record.status !== next) { record.status = next; changes.status = next; }
        }
        record.history.push({ at: now(), by: actor.id, action: 'update', changes, note: optionalText(note, 'note') });
        return clone(record);
      });
    },
    resolveException({ actor, exceptionId, resolution, improvement = null }: any) {
      const found = findException(exceptionId);
      requireCapability(actor, 'oversight.exception.manage', exceptionResource(found));
      const resolutionText = text(resolution, 'resolution');
      if (found.status === 'resolved') return { exception: clone(found), alreadyResolved: true };
      return commit('oversight.exception.resolve', actor, exceptionResource(found), draft => {
        const record = draft.exceptions[found.id];
        const at = now();
        record.status = 'resolved';
        record.resolvedAt = at;
        record.resolvedBy = actor.id;
        record.resolution = resolutionText;
        record.improvement = optionalText(improvement, 'improvement');
        record.history.push({ at, by: actor.id, action: 'resolve', resolution: resolutionText, improvement: record.improvement });
        return { exception: clone(record), alreadyResolved: false };
      });
    },
    listExceptions({ actor, activityId = null, status = null }: any = {}) {
      requireCapability(actor, 'oversight.read', activityId ? { kind: 'activity', activityId } : { kind: 'global' });
      const at = now();
      return (Object.values(state.exceptions) as any[])
        .filter(record => (!activityId || record.activityId === activityId) && (!status || record.status === status))
        .map(record => exceptionView(record, at));
    },
    getException({ actor, exceptionId }: any) {
      const found = findException(exceptionId);
      requireCapability(actor, 'oversight.read', exceptionResource(found));
      return exceptionView(found, now());
    },

    // ------------------------------------------------------------------ outbound automation gate
    dispatchAutomation({ actor, category, activityId = null, items }: any) {
      const automationCategory = text(category, 'category');
      if (!AUTOMATION_CATEGORIES.includes(automationCategory)) {
        throw new OversightError('validation', `category ${automationCategory} is not an automation category`, { known: AUTOMATION_CATEGORIES });
      }
      const activity = activityId === null || activityId === undefined ? null : text(activityId, 'activityId');
      const resource = activity ? { kind: 'activity', activityId: activity } : { kind: 'category', category: automationCategory };
      requireCapability(actor, 'automation.dispatch', resource);
      const gate = policyGate(automationCategory);
      if (!gate.ready) {
        throw new OversightError(gate.reason, `outbound automation is refused: ${gate.reason}`, { category: automationCategory, activityId: activity });
      }
      if (!Array.isArray(items) || items.length === 0) throw new OversightError('validation', 'items must be a non-empty array');
      if (items.length > MAX_DISPATCH_ITEMS) throw new OversightError('validation', `items must contain at most ${MAX_DISPATCH_ITEMS} entries`);
      const normalized = items.map((raw: any, index: number) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OversightError('validation', `items[${index}] must be an object`);
        return {
          itemId: text(raw.itemId, `items[${index}].itemId`),
          idempotencyKey: optionalText(raw.idempotencyKey, `items[${index}].idempotencyKey`),
          dueAt: raw.dueAt === undefined || raw.dueAt === null ? null : timestamp(raw.dueAt, `items[${index}].dueAt`),
          summary: optionalText(raw.summary, `items[${index}].summary`),
        };
      });
      return commit('automation.dispatch', actor, resource, draft => {
        const at = now();
        const pause = pauseStateFor(automationCategory, activity);
        if (pause.paused) {
          const retained = normalized.map((item: any) => {
            const itemKey = `${activity ?? 'global'}:${item.itemId}`;
            const record = draft.retained[itemKey] ?? {
              itemKey,
              itemId: item.itemId,
              category: automationCategory,
              activityId: activity,
              dueAt: item.dueAt,
              summary: item.summary,
              firstRetainedAt: at,
              attempts: 0,
            };
            record.lastRetainedAt = at;
            record.attempts += 1;
            record.blockedBy = pause.scopes.map((scope: any) => scope.id);
            draft.retained[itemKey] = record;
            return clone(record);
          });
          return {
            queued: [],
            retained,
            deduplicated: [],
            delivered: [],
            pause,
            externalDelivery: EXTERNAL_DELIVERY,
            adapterConnected: false,
            note: 'nothing was sent: these items are retained until the pause is resumed',
          };
        }
        const queued = [];
        const deduplicated = [];
        for (const item of normalized) {
          const key = item.idempotencyKey ?? derivedKey(['dispatch', automationCategory, activity, item.itemId]);
          const existing = draft.receipts[key];
          if (existing) {
            if (existing.category !== automationCategory || existing.activityId !== activity) {
              throw new OversightError('idempotency_conflict', `idempotency key ${key} was used for another dispatch`, { key, category: automationCategory, activityId: activity });
            }
            deduplicated.push({ itemId: item.itemId, key, recordedAt: existing.recordedAt });
            continue;
          }
          // A recorded intent, not a delivery: no adapter is connected, so `deliveredAt` stays null
          // until a provider receipt is recorded.
          const intent = {
            key,
            itemId: item.itemId,
            category: automationCategory,
            activityId: activity,
            handlerId: gate.handlerId,
            policyVersion: gate.policyVersion ?? null,
            intentState: 'pending_delivery',
            recordedAt: at,
            deliveredAt: null,
            delivery: EXTERNAL_DELIVERY,
          };
          draft.receipts[key] = intent;
          delete draft.retained[`${activity ?? 'global'}:${item.itemId}`];
          queued.push(clone(intent));
        }
        return {
          queued,
          retained: [],
          deduplicated,
          delivered: [],
          pause: null,
          externalDelivery: EXTERNAL_DELIVERY,
          adapterConnected: false,
          note: 'queued intents are pending: no chat message, publication or payment was sent',
        };
      });
    },
    listRetainedItems({ actor, activityId = null, category = null }: any = {}) {
      requireCapability(actor, 'oversight.read', activityId ? { kind: 'activity', activityId } : { kind: 'global' });
      return (Object.values(state.retained) as any[])
        .filter(item => (!activityId || item.activityId === activityId) && (!category || item.category === category))
        .map(clone);
    },
    listDispatchIntents({ actor, activityId = null, category = null }: any = {}) {
      requireCapability(actor, 'oversight.read', activityId ? { kind: 'activity', activityId } : { kind: 'global' });
      return (Object.values(state.receipts) as any[])
        .filter(item => (!activityId || item.activityId === activityId) && (!category || item.category === category))
        .map(clone);
    },

    // ------------------------------------------------------------------ weekly summary (AC18)
    buildWeeklySummary({ actor, period, progress = [], metrics = null, timezone = null }: any) {
      requireCapability(actor, 'oversight.summary.read', { kind: 'global' });
      const start = timestamp(period?.start, 'period.start');
      const end = timestamp(period?.end, 'period.end');
      if (Date.parse(start) > Date.parse(end)) throw new OversightError('validation', 'period.start must not be after period.end');
      const at = now();
      const entries = (Array.isArray(progress) ? progress : []).map((raw: any, index: number) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OversightError('validation', `progress[${index}] must be an object`);
        const section = text(raw.section, `progress[${index}].section`);
        if (!SUMMARY_SECTIONS.includes(section)) {
          throw new OversightError('validation', `progress[${index}].section ${section} is not a summary section`, { known: SUMMARY_SECTIONS });
        }
        const status = text(raw.status, `progress[${index}].status`);
        if (!PROGRESS_STATUSES.includes(status)) {
          throw new OversightError('validation', `progress[${index}].status ${status} is not a progress status`, { known: PROGRESS_STATUSES });
        }
        return {
          section,
          summary: text(raw.summary, `progress[${index}].summary`),
          status,
          ownerId: optionalText(raw.ownerId, `progress[${index}].ownerId`),
          reference: optionalText(raw.reference, `progress[${index}].reference`),
        };
      });

      // Ordinary progress is reported section by section and never contains exception records.
      const ordinaryProgress: Record<string, any[]> = {};
      for (const section of SUMMARY_SECTIONS) ordinaryProgress[section] = [];
      for (const entry of entries) {
        ordinaryProgress[entry.section].push({
          summary: entry.summary,
          status: entry.status,
          ownerId: entry.ownerId,
          reference: entry.reference,
        });
      }

      const outstanding = (Object.values(state.exceptions) as any[])
        .filter(record => record.status !== 'resolved')
        .map(record => exceptionView(record, at));
      const decisionsNeeded = outstanding
        .filter(item => item.needsDecision)
        .sort((a, b) => {
          if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
          if (a.handlerAssigned !== b.handlerAssigned) return a.handlerAssigned ? 1 : -1;
          return a.firstSeenAt.localeCompare(b.firstSeenAt);
        });

      const pausedAutomation = activePauses().sort((a, b) => a.id.localeCompare(b.id)).map(pause => {
        const retained = retainedInScope(pause);
        return {
          id: pause.id,
          scope: pause.scope,
          category: pause.category,
          activityId: pause.activityId,
          reason: pause.reason,
          pausedAt: pause.pausedAt,
          pausedBy: pause.pausedBy,
          affectedCategories: affectedCategories(pause),
          retainedCount: retained.length,
          overdueCount: retained.filter((item: any) => item.dueAt !== null && Date.parse(item.dueAt) <= Date.parse(at)).length,
        };
      });

      const dataGaps = SUMMARY_SECTIONS
        .filter(section => ordinaryProgress[section].length === 0)
        .map(section => ({ section, value: 'no data yet' }));
      const metricEntries = Array.isArray(metrics) && metrics.length > 0
        ? metrics.map((raw: any, index: number) => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OversightError('validation', `metrics[${index}] must be an object`);
          return {
            name: text(raw.name, `metrics[${index}].name`),
            value: text(raw.value, `metrics[${index}].value`),
            basis: optionalText(raw.basis, `metrics[${index}].basis`),
          };
        })
        : null;
      if (metricEntries === null) dataGaps.push({ section: 'metrics', value: 'no data yet' });

      return {
        // "What you need to do" first, then routine status, then the exception center (PRD §9.2).
        period: { start, end },
        timezone: optionalText(timezone, 'timezone'),
        generatedAt: at,
        generatedBy: actor.id,
        decisionsNeeded,
        exceptions: {
          outstanding,
          overdue: outstanding.filter(item => item.overdue),
          unassigned: outstanding.filter(item => !item.handlerAssigned),
          resolvedCount: (Object.values(state.exceptions) as any[]).filter(record => record.status === 'resolved').length,
        },
        ordinaryProgress,
        metrics: metricEntries,
        pausedAutomation,
        delivery: {
          externalDelivery: EXTERNAL_DELIVERY,
          adapterConnected: false,
          pendingIntents: (Object.values(state.receipts) as any[]).filter(intent => intent.deliveredAt === null).length,
          note: 'recorded automation intents are pending; nothing was sent, published or paid',
        },
        automationReadiness: policySummary(),
        dataGaps,
      };
    },

    // Read-only helper used by adapters and tests.
    snapshot() { return clone(state); },
  };
}
