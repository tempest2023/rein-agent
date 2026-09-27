// Rein-owned deterministic activity operations core (PRD R17-R27).
//
// Everything in this module is local and deterministic. It performs no network calls, starts no
// payments and publishes nothing. External effects are recorded as idempotent outbox intents; an
// adapter or human later records the provider receipt. Authorization is explicit: the default
// authorizer grants nothing, every mutation names an actor, and a manifest or prompt is never an
// authorization check. Activity, finance and publication state are three separate dimensions.
import { createHash } from 'node:crypto';

export const ACTIVITY_STATES = [
  'draft', 'confirmed', 'evaluating', 'awaiting_governance', 'needs_information',
  'approved', 'preparing', 'paused', 'completed', 'accepted', 'archived', 'canceled',
];

export const FINANCE_STATES = [
  'not_requested', 'requested', 'awaiting_allocation', 'reserved',
  'partially_paid', 'paid', 'awaiting_settlement', 'settled',
];

export const PUBLICATION_STATES = [
  'not_started', 'draft', 'awaiting_confirmation', 'ready', 'publishing', 'published', 'failed', 'withdrawn',
];

export const PUBLICATION_CHANNELS = ['website', 'chat', 'social'];

export const CAPABILITIES = [
  'activity.create', 'activity.transition',
  'task.manage', 'reminder.manage', 'reminder.dispatch',
  'material.submit', 'consent.record',
  'outcome.submit', 'outcome.review', 'outcome.verify',
  'publication.draft', 'publication.confirm_facts', 'publication.publish',
  'finance.request', 'finance.approve', 'finance.reserve', 'finance.record_payment', 'finance.record_settlement',
  'external.enqueue', 'external.read', 'external.record_receipt', 'external.retry', 'external.reconcile',
  'exception.resolve', 'audit.read',
];

export const EXTERNAL_INTENT_KINDS = [
  'create_space', 'invite_collaborator', 'post_standing_summary', 'publish_registration_page',
  'send_registration_notice', 'send_reminder', 'publish_article', 'send_correction_notice',
  'post_article_link',
];

// R17/R18: the checklist is a proposal the lead can edit, not an organizational rule.
const CHECKLIST_TEMPLATES = {
  paper_discussion: ['venue', 'speaker', 'agenda', 'publicity', 'registration', 'supplies', 'on_site', 'participant_support', 'outcome_collection'],
  workshop: ['venue', 'speaker', 'agenda', 'materials', 'publicity', 'registration', 'supplies', 'on_site', 'participant_support', 'outcome_collection'],
  meetup: ['venue', 'agenda', 'publicity', 'registration', 'supplies', 'on_site', 'outcome_collection'],
  default: ['venue', 'agenda', 'publicity', 'registration', 'supplies', 'on_site', 'outcome_collection'],
};

// R18 recommended reminder cadence. A proposal, not adopted policy: dispatch reports its source.
// `timezone` is deliberately unset: quiet hours and the daily cap are organization policy, so the
// core refuses to invent a default and rejects a dispatch that does not name an explicit zone.
export const DEFAULT_REMINDER_POLICY = {
  quietHoursStartMinute: 21 * 60,
  quietHoursEndMinute: 8 * 60,
  maxOrdinaryPerDay: 1,
  unansweredBeforeException: 2,
  timezone: null,
};

const OUTCOME_REQUIREMENTS = ['actualTime', 'actualLocation', 'summary', 'attendance', 'attendanceBasis', 'actualExpenses'];

const ACTIVITY_TRANSITIONS = {
  draft: ['confirmed', 'canceled'],
  confirmed: ['evaluating', 'canceled'],
  evaluating: ['awaiting_governance', 'needs_information', 'approved', 'canceled'],
  needs_information: ['evaluating', 'canceled'],
  awaiting_governance: ['approved', 'needs_information', 'canceled'],
  approved: ['preparing', 'paused', 'canceled'],
  preparing: ['completed', 'paused', 'canceled'],
  paused: ['approved', 'preparing', 'canceled'],
  completed: ['accepted', 'canceled'],
  accepted: ['archived'],
  archived: [],
  canceled: [],
};

const FINANCE_TRANSITIONS = {
  not_requested: ['requested'],
  requested: ['awaiting_allocation', 'not_requested'],
  awaiting_allocation: ['reserved', 'not_requested'],
  reserved: ['partially_paid', 'paid'],
  partially_paid: ['paid', 'awaiting_settlement', 'settled'],
  paid: ['awaiting_settlement', 'settled'],
  // An unresolved overspend may only leave `awaiting_settlement` through an authorized approval
  // plus its own reservation (see approveOverspend then reserveFunds), or by recording the payment
  // that the top-up reservation now covers. It never leaves by rewriting the recorded actual.
  awaiting_settlement: ['settled', 'partially_paid', 'paid'],
  settled: [],
};

export class OperationsError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'OperationsError';
    this.code = code;
    this.details = details ?? {};
  }
}

export function recommendedChecklist(eventType: string) {
  const template = CHECKLIST_TEMPLATES[eventType] ?? CHECKLIST_TEMPLATES.default;
  return template.map((title, index) => ({ title, order: index + 1 }));
}

export function createCapabilityAuthorizer(grants: { actorId: string; capability: string; activityId?: string }[]) {
  const list = grants.map(grant => ({ ...grant }));
  return ({ actor, capability, activityId }: { actor: { id: string }; capability: string; activityId?: string }) => {
    const match = list.find(grant =>
      grant.actorId === actor.id &&
      grant.capability === capability &&
      (grant.activityId === undefined || grant.activityId === activityId));
    return match ? { allowed: true, reason: 'granted' } : { allowed: false, reason: 'no_grant' };
  };
}

// Duck-typed persistence port. `createLedgerStore` adapts the shared local ledger without
// importing it, so this module keeps working if that file moves.
export function createLedgerStore(ledger: { snapshot: () => any; transact: (input: any) => any }, options: { key?: string; actor?: string; slot?: string } = {}) {
  const slot = options.slot ?? 'reinOperations';
  return {
    load() {
      const records = ledger.snapshot()?.records ?? {};
      return records[slot] ?? null;
    },
    save(state: any) {
      const fingerprint = createHash('sha256').update(JSON.stringify(state)).digest('hex');
      ledger.transact({
        key: `${options.key ?? 'rein-operations'}:${state.sequence}:${fingerprint}`,
        actor: options.actor ?? 'operations-core',
        action: 'persist',
        at: state.audit.at(-1)?.at ?? new Date().toISOString(),
        apply(records: any) {
          const previousSequence = records[slot]?.sequence ?? 0;
          if (previousSequence !== state.sequence - 1) {
            throw new OperationsError('storage_conflict', 'operations state changed in another process; reload before retrying', {
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

function clone(value: any) { return structuredClone(value); }

function canonicalize(value: any): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function derivedKey(kind: string, activityId: string, payload: unknown) {
  return `derived-${createHash('sha256').update(`${kind}|${activityId}|${canonicalize(payload)}`).digest('hex').slice(0, 24)}`;
}

function text(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OperationsError('validation', `${field} must be a non-empty string`);
  }
  return value.trim();
}

function timestamp(value: unknown, field: string) {
  const iso = value instanceof Date ? value.toISOString() : text(value, field);
  if (!Number.isFinite(Date.parse(iso))) throw new OperationsError('validation', `${field} must be a timestamp`);
  return new Date(iso).toISOString();
}

function money(amountMinor: unknown, currency: unknown, field: string) {
  if (!Number.isInteger(amountMinor) || (amountMinor as number) < 0) {
    throw new OperationsError('validation', `${field} must be an integer amount in minor units`);
  }
  const code = text(currency, `${field}.currency`).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new OperationsError('validation', `${field}.currency must be a three-letter code`);
  return { amountMinor: amountMinor as number, currency: code };
}

function isQuietHour(minuteOfDay: number, start: number, end: number) {
  return start <= end ? minuteOfDay >= start && minuteOfDay < end : minuteOfDay >= start || minuteOfDay < end;
}

function isTimeZone(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// Local wall-clock parts for one instant in an explicitly configured IANA timezone. Quiet hours
// and the daily counter are calendar facts in the organization's zone, so the core never derives
// them from UTC or from the host clock.
function zonedParts(instant: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: string) => parts.find(entry => entry.type === type)?.value ?? '00';
  // Some locales render midnight as hour 24 with hour12 disabled; normalise to 0.
  const hour = Number(part('hour')) % 24;
  return { day: `${part('year')}-${part('month')}-${part('day')}`, minuteOfDay: hour * 60 + Number(part('minute')) };
}

// AC14: an activity has at most one canonical article. Withdrawn and failed records no longer
// represent a live publication, so a later revision may supersede them.
const TERMINAL_PUBLICATION_STATES = ['withdrawn', 'failed'];

function publicationsFor(draft: any, activityId: string) {
  return Object.values(draft.publications).filter((item: any) => item.activityId === activityId) as any[];
}

function canonicalPublication(draft: any, activityId: string) {
  return publicationsFor(draft, activityId).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).at(-1) ?? null;
}

export function createOperationsCore(options: {
  now?: () => string | Date;
  authorize?: (request: { actor: any; capability: string; activityId?: string }) => { allowed: boolean; reason?: string };
  verifyContributor?: (memberId: string, at: string) => boolean;
  store?: { load: () => any; save: (state: any) => void };
} = {}) {
  const now = () => {
    const value = options.now ? options.now() : new Date();
    return value instanceof Date ? value.toISOString() : timestamp(value, 'now');
  };
  const authorize = options.authorize ?? (() => ({ allowed: false, reason: 'no_authorizer_configured' }));
  const verifyContributor = options.verifyContributor ?? (() => false);
  const store = options.store;

  const emptyState = () => ({
    sequence: 0,
    idCounters: {},
    activities: {},
    tasks: {},
    reminders: {},
    reminderCounters: {},
    materials: {},
    consents: {},
    outcomes: {},
    publications: {},
    finances: {},
    jobs: {},
    jobKeys: {},
    exceptions: {},
    audit: [],
  });

  let state = (store?.load && store.load()) ?? emptyState();

  function requireCapability(actor: any, capability: string, activityId?: string) {
    if (!actor || typeof actor.id !== 'string' || !actor.id.trim()) {
      throw new OperationsError('unauthorized', 'an actor with an id is required', { capability });
    }
    const decision = authorize({ actor, capability, activityId });
    if (!decision?.allowed) {
      throw new OperationsError('unauthorized', `actor ${actor.id} lacks ${capability}`, { capability, reason: decision?.reason ?? 'denied' });
    }
    return actor;
  }

  function commit(action: string, actor: any, activityId: string | undefined, mutate: (draft: any) => any) {
    const draft = clone(state);
    const result = mutate(draft);
    const event = { seq: draft.sequence + 1, at: now(), actorId: actor.id, action, activityId: activityId ?? null };
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

  function activity(draft: any, activityId: unknown) {
    const id = text(activityId, 'activityId');
    const found = draft.activities[id];
    if (!found) throw new OperationsError('not_found', `activity ${id} does not exist`);
    return found;
  }

  function financeOf(draft: any, activityId: string) {
    draft.finances[activityId] ??= {
      activityId,
      state: 'not_requested',
      currency: null,
      requestedMinor: 0,
      approvedCeilingMinor: 0,
      reservedMinor: 0,
      paidMinor: 0,
      actualMinor: null,
      unusedReleasedMinor: 0,
      pendingSettlementMinor: 0,
      // An authorized but not yet reserved overspend. Approval raises the ceiling; it reserves
      // nothing, so this counter is what the finance reservation path consumes.
      pendingOverspendAuthorization: null,
      allocationReference: null,
      history: [],
      updatedAt: null,
    };
    return draft.finances[activityId];
  }

  function moveFinance(draft: any, record: any, to: string, detail: any, at: string) {
    const allowed = FINANCE_TRANSITIONS[record.state] ?? [];
    if (!allowed.includes(to)) {
      throw new OperationsError('invalid_transition', `finance ${record.state} cannot become ${to}`, { from: record.state, to });
    }
    record.history.push({ from: record.state, to, at, ...detail });
    record.state = to;
    record.updatedAt = at;
  }

  function jobView(job: any) {
    return { ...clone(job), delivered: job.state === 'delivered', providerReceipt: job.receipt ?? null };
  }

  function exceptionFor(draft: any, activityId: string, kind: string, reason: string, at: string) {
    const open = Object.values(draft.exceptions).find((item: any) => item.activityId === activityId && item.status === 'open');
    if (open) return { record: open, created: false };
    const id = nextId(draft, 'exception');
    const record = { id, activityId, kind, reason, status: 'open', createdAt: at, resolvedAt: null, resolution: null };
    draft.exceptions[id] = record;
    return { record, created: true };
  }

  function consentRecord(draft: any, activityId: string, channel: string, materialId?: string) {
    return Object.values(draft.consents)
      .filter((item: any) => item.activityId === activityId && item.channel === channel && (item.materialId ?? null) === (materialId ?? null))
      .sort((a: any, b: any) => a.seq - b.seq)
      .at(-1);
  }

  function missingConsents(draft: any, activityId: string, channels: string[], materialIds: string[]) {
    return channels.filter(channel =>
      consentRecord(draft, activityId, channel)?.granted !== true ||
      materialIds.some(materialId => consentRecord(draft, activityId, channel, materialId)?.granted !== true));
  }

  function enqueueIntent(draft: any, actor: any, activityId: string, kind: string, payload: any, idempotencyKey: string | undefined, at: string) {
    if (!EXTERNAL_INTENT_KINDS.includes(kind)) {
      if (/pay|transfer|payout|reimburse|refund|invoice/i.test(kind)) {
        throw new OperationsError('payment_not_supported', `external intent ${kind} is not supported: this core never initiates payments`);
      }
      throw new OperationsError('validation', `external intent ${kind} is not a known kind`, { known: EXTERNAL_INTENT_KINDS });
    }
    const key = idempotencyKey ? text(idempotencyKey, 'idempotencyKey') : derivedKey(kind, activityId, payload ?? null);
    const existingId = draft.jobKeys[key];
    if (existingId) return { job: jobView(draft.jobs[existingId]), deduplicated: true };
    const id = nextId(draft, 'job');
    const job = {
      id, key, kind, activityId,
      payload: clone(payload ?? null),
      state: 'pending',
      attempts: 0,
      createdAt: at,
      updatedAt: at,
      receipt: null,
      note: null,
      requestedBy: actor.id,
    };
    draft.jobs[id] = job;
    draft.jobKeys[key] = id;
    return { job: jobView(job), deduplicated: false };
  }

  // R27: the published link is returned to the event space as its own external effect. The core
  // records an explicit, idempotent intent and never reports the link as delivered until a
  // provider receipt confirms it. With no created event space there is nowhere to return the
  // link, so no intent is fabricated.
  function enqueueArticleLink(draft: any, actor: any, activityId: string, publication: any, url: string, at: string) {
    if (publication.linkJobId && draft.jobs[publication.linkJobId]) {
      return { job: jobView(draft.jobs[publication.linkJobId]), deduplicated: true };
    }
    if (draft.activities[activityId]?.space?.state !== 'created') return null;
    const result = enqueueIntent(draft, actor, activityId, 'post_article_link', {
      audience: 'chat.event_space',
      publicationId: publication.id,
      url,
    }, `article_link:${publication.id}`, at);
    publication.linkJobId = result.job.id;
    return result;
  }

  // R27: the link counts as returned only when its own intent is delivered. The delivery paths
  // stamp the publication with that receipt time, so persisted state and the read model agree and
  // no publication claims a return before a provider receipt exists.
  function markArticleLinkReturned(draft: any, linkJob: any, at: string) {
    const publication = Object.values(draft.publications).find((item: any) => item.linkJobId === linkJob.id) as any;
    if (publication) publication.linkReturnedAt = at;
  }

  return {
    // ---------------------------------------------------------------- authorization and audit
    authorize(request: { actor: any; capability: string; activityId?: string }) {
      if (!request?.actor?.id) throw new OperationsError('unauthorized', 'an actor with an id is required');
      const decision = authorize(request);
      return { allowed: Boolean(decision?.allowed), reason: decision?.reason ?? 'denied' };
    },
    listAuditEvents({ actor, activityId }: any = {}) {
      requireCapability(actor, 'audit.read', activityId);
      return state.audit.filter((event: any) => !activityId || event.activityId === activityId).map(clone);
    },

    // ---------------------------------------------------------------------------- activities
    createActivity({ actor, title, eventType, leadId }: any) {
      requireCapability(actor, 'activity.create');
      return commit('activity.create', actor, undefined, draft => {
        const id = nextId(draft, 'activity');
        const at = now();
        const record = {
          id,
          title: text(title, 'title'),
          eventType: text(eventType, 'eventType'),
          leadId: text(leadId, 'leadId'),
          state: 'draft',
          approval: null,
          cancellation: null,
          space: { state: 'not_requested', jobId: null, url: null },
          consecutiveUnanswered: 0,
          createdAt: at,
          updatedAt: at,
          history: [],
        };
        draft.activities[id] = record;
        return clone(record);
      });
    },
    transitionActivity({ actor, activityId, to, reason, basis, reference }: any) {
      requireCapability(actor, 'activity.transition', activityId);
      return commit('activity.transition', actor, activityId, draft => {
        const record = activity(draft, activityId);
        const target = text(to, 'to');
        if (!(ACTIVITY_TRANSITIONS[record.state] ?? []).includes(target)) {
          throw new OperationsError('invalid_transition', `activity ${record.state} cannot become ${target}`, { from: record.state, to: target });
        }
        const at = now();
        if (target === 'approved') {
          if (!['zero_budget_fast_track', 'governance_decision'].includes(basis)) {
            throw new OperationsError('approval_basis_required', 'approval needs an explicit basis: zero_budget_fast_track or governance_decision');
          }
          record.approval = { basis, reference: text(reference, 'reference'), at, actorId: actor.id };
        }
        if (target === 'accepted' && draft.outcomes[record.id]?.review?.decision !== 'accepted') {
          throw new OperationsError('outcome_not_accepted', 'an activity is accepted only after an accepted completion review');
        }
        if (target === 'archived') {
          const finance = financeOf(draft, record.id);
          const blockers = [];
          if (!['not_requested', 'settled'].includes(finance.state)) blockers.push(`finance:${finance.state}`);
          // Every publication for the activity counts, not just the first: an unresolved second
          // draft must not be invisible to the archive gate (AC14).
          for (const publication of publicationsFor(draft, record.id)) {
            if (!['not_started', 'published', 'withdrawn'].includes(publication.state)) {
              blockers.push(`publication:${publication.state}`);
            }
          }
          if (blockers.length) {
            throw new OperationsError('archive_blocked', 'archive only after every required item is complete', { blockers });
          }
        }
        if (target === 'canceled') {
          const why = text(reason, 'reason');
          record.cancellation = { reason: why, at, actorId: actor.id };
          const finance = financeOf(draft, record.id);
          if (['requested', 'awaiting_allocation', 'reserved'].includes(finance.state)) {
            moveFinance(draft, finance, 'not_requested', { reason: 'released_on_cancellation', note: why }, at);
          }
          for (const reminder of Object.values(draft.reminders) as any[]) {
            if (reminder.activityId === record.id && ['scheduled', 'snoozed'].includes(reminder.status)) reminder.status = 'canceled';
          }
        }
        record.history.push({ from: record.state, to: target, at, actorId: actor.id, reason: reason ?? null });
        record.state = target;
        record.updatedAt = at;
        return clone(record);
      });
    },
    getActivity(activityId: unknown) { return clone(activity(state, activityId)); },
    getActivityView({ activityId }: any) {
      const record = activity(state, activityId);
      const finance = clone(financeOf(clone(state), record.id));
      const publication = clone(canonicalPublication(state, record.id));
      const outcome = clone(state.outcomes[record.id] ?? null);
      const openExceptions = Object.values(state.exceptions).filter((item: any) => item.activityId === record.id && item.status === 'open').length;
      const notices = [];
      if (record.state === 'approved' && record.space.state !== 'created') notices.push('approved; event space pending');
      if (openExceptions) notices.push(`exceptions_open:${openExceptions}`);
      if (outcome && outcome.status === 'incomplete') notices.push(`outcome_materials_incomplete:${outcome.missing.join('|')}`);
      if (finance.state === 'awaiting_settlement') notices.push('settlement_pending');
      if (publication && publication.state === 'awaiting_confirmation') notices.push('publication_awaiting_lead_confirmation');
      return {
        activity: { id: record.id, title: record.title, eventType: record.eventType, leadId: record.leadId, state: record.state, space: clone(record.space) },
        finance,
        publication,
        outcome,
        notices,
      };
    },

    // --------------------------------------------------------------------------------- tasks
    addTask({ actor, activityId, title, dueAt, assigneeId }: any) {
      requireCapability(actor, 'task.manage', activityId);
      return commit('task.add', actor, activityId, draft => {
        const record = activity(draft, activityId);
        const id = nextId(draft, 'task');
        const at = now();
        const task = {
          id, activityId: record.id,
          title: text(title, 'title'),
          dueAt: dueAt ? timestamp(dueAt, 'dueAt') : null,
          assigneeId: assigneeId ? text(assigneeId, 'assigneeId') : null,
          status: 'open',
          createdAt: at,
          updatedAt: at,
        };
        draft.tasks[id] = task;
        return clone(task);
      });
    },
    completeTask({ actor, taskId }: any) {
      const id = text(taskId, 'taskId');
      const task = state.tasks[id];
      if (!task) throw new OperationsError('not_found', `task ${taskId} does not exist`);
      requireCapability(actor, 'task.manage', task.activityId);
      return commit('task.complete', actor, task.activityId, draft => {
        const record = draft.tasks[id];
        const at = now();
        record.status = 'done';
        record.updatedAt = at;
        // R18/US08: a completed task is not chased. Future reminders whose purpose was to chase
        // this task are canceled here so a later dispatch pass cannot send them.
        const canceledReminders: string[] = [];
        for (const reminder of Object.values(draft.reminders) as any[]) {
          if (reminder.taskId === id && ['scheduled', 'snoozed'].includes(reminder.status)) {
            reminder.status = 'canceled';
            reminder.reason = 'task_completed';
            canceledReminders.push(reminder.id);
          }
        }
        return { ...clone(record), canceledReminders };
      });
    },
    listTasks(activityId: unknown) {
      return Object.values(state.tasks).filter((task: any) => task.activityId === activityId).map(clone);
    },

    // ----------------------------------------------------------------------------- reminders
    scheduleReminder({ actor, activityId, dueAt, kind = 'ordinary', taskId = null, note = null }: any) {
      requireCapability(actor, 'reminder.manage', activityId);
      return commit('reminder.schedule', actor, activityId, draft => {
        const record = activity(draft, activityId);
        const id = nextId(draft, 'reminder');
        const at = now();
        const reminder = {
          id, activityId: record.id,
          kind: kind === 'urgent' ? 'urgent' : 'ordinary',
          dueAt: timestamp(dueAt, 'dueAt'),
          taskId: taskId ? text(taskId, 'taskId') : null,
          note,
          status: 'scheduled',
          snoozeCount: 0,
          createdAt: at,
          sentAt: null,
          answeredAt: null,
          reason: null,
        };
        draft.reminders[id] = reminder;
        return clone(reminder);
      });
    },
    snoozeReminder({ actor, reminderId, until }: any) {
      const reminder = state.reminders[text(reminderId, 'reminderId')];
      if (!reminder) throw new OperationsError('not_found', `reminder ${reminderId} does not exist`);
      requireCapability(actor, 'reminder.manage', reminder.activityId);
      return commit('reminder.snooze', actor, reminder.activityId, draft => {
        const record = draft.reminders[reminderId];
        if (!['scheduled', 'snoozed'].includes(record.status)) {
          throw new OperationsError('invalid_transition', `reminder ${record.status} cannot be snoozed`);
        }
        record.dueAt = timestamp(until, 'until');
        record.status = 'snoozed';
        record.snoozeCount += 1;
        return clone(record);
      });
    },
    muteReminder({ actor, reminderId, reason = null }: any) {
      const reminder = state.reminders[text(reminderId, 'reminderId')];
      if (!reminder) throw new OperationsError('not_found', `reminder ${reminderId} does not exist`);
      requireCapability(actor, 'reminder.manage', reminder.activityId);
      return commit('reminder.mute', actor, reminder.activityId, draft => {
        const record = draft.reminders[reminderId];
        if (['muted', 'canceled'].includes(record.status)) return clone(record);
        record.status = 'muted';
        record.reason = reason;
        return clone(record);
      });
    },
    recordReminderResponse({ actor, reminderId, note = null }: any) {
      const reminder = state.reminders[text(reminderId, 'reminderId')];
      if (!reminder) throw new OperationsError('not_found', `reminder ${reminderId} does not exist`);
      requireCapability(actor, 'reminder.manage', reminder.activityId);
      return commit('reminder.response', actor, reminder.activityId, draft => {
        const record = draft.reminders[reminderId];
        record.status = 'answered';
        record.answeredAt = now();
        record.reason = note;
        activity(draft, record.activityId).consecutiveUnanswered = 0;
        return clone(record);
      });
    },
    dispatchDueReminders({ actor, at, policy }: any) {
      requireCapability(actor, 'reminder.dispatch');
      const effective = { ...DEFAULT_REMINDER_POLICY, ...(policy ?? {}) };
      const policySource = policy ? 'provided' : 'default_recommendation';
      // F5: quiet hours and the daily cap are organization policy. Without an explicit IANA zone
      // the core would be inventing an organizational default, so it refuses to dispatch at all.
      if (!isTimeZone(effective.timezone)) {
        throw new OperationsError('timezone_required', 'reminder dispatch needs an explicitly configured IANA timezone; the core has no organization default', {
          timezone: effective.timezone ?? null,
        });
      }
      const timeZone = effective.timezone as string;
      return commit('reminder.dispatch', actor, undefined, draft => {
        const when = timestamp(at ?? now(), 'at');
        const { day, minuteOfDay } = zonedParts(when, timeZone);
        const sent = [];
        const deferred = [];
        const suppressed = [];
        const exceptionsCreated = [];
        const due = Object.values(draft.reminders)
          .filter((reminder: any) => ['scheduled', 'snoozed'].includes(reminder.status) && Date.parse(reminder.dueAt) <= Date.parse(when))
          .sort((a: any, b: any) => a.id.localeCompare(b.id));
        for (const reminder of due) {
          const owner = activity(draft, reminder.activityId);
          // R18: a reminder that exists to chase a completed task is canceled, never sent.
          if (reminder.taskId && draft.tasks[reminder.taskId]?.status === 'done') {
            reminder.status = 'canceled';
            reminder.reason = 'task_completed';
            continue;
          }
          if (['canceled', 'archived', 'completed', 'accepted'].includes(owner.state)) {
            reminder.status = 'canceled';
            reminder.reason = `activity_${owner.state}`;
            continue;
          }
          if (owner.state === 'paused') {
            deferred.push({ reminderId: reminder.id, reason: 'activity_paused' });
            continue;
          }
          if (owner.consecutiveUnanswered >= effective.unansweredBeforeException) {
            const exception = exceptionFor(draft, owner.id, 'unanswered_follow_up', `no response after ${owner.consecutiveUnanswered} follow-ups`, when);
            if (exception.created) exceptionsCreated.push(clone(exception.record));
            reminder.status = 'suppressed';
            reminder.reason = 'exception_created';
            suppressed.push({ reminderId: reminder.id, exceptionId: exception.record.id });
            continue;
          }
          if (reminder.kind === 'ordinary') {
            if (isQuietHour(minuteOfDay, effective.quietHoursStartMinute, effective.quietHoursEndMinute)) {
              deferred.push({ reminderId: reminder.id, reason: 'quiet_hours' });
              continue;
            }
            const counterKey = `${owner.id}:${day}`;
            if ((draft.reminderCounters[counterKey] ?? 0) >= effective.maxOrdinaryPerDay) {
              deferred.push({ reminderId: reminder.id, reason: 'daily_limit' });
              continue;
            }
            draft.reminderCounters[counterKey] = (draft.reminderCounters[counterKey] ?? 0) + 1;
          }
          reminder.status = 'sent';
          reminder.sentAt = when;
          owner.consecutiveUnanswered += 1;
          sent.push({ reminderId: reminder.id, activityId: owner.id, kind: reminder.kind });
        }
        return { at: when, policySource, sent, deferred, suppressed, exceptionsCreated };
      });
    },
    listReminders(activityId: unknown) {
      return Object.values(state.reminders).filter((reminder: any) => reminder.activityId === activityId).map(clone);
    },

    // -------------------------------------------------------------------- materials and consent
    submitMaterial({ actor, activityId, kind, description, reference = null }: any) {
      requireCapability(actor, 'material.submit', activityId);
      return commit('material.submit', actor, activityId, draft => {
        const owner = activity(draft, activityId);
        const id = nextId(draft, 'material');
        const at = now();
        const material = {
          id, activityId: owner.id,
          kind: text(kind, 'kind'),
          description: text(description, 'description'),
          reference,
          submittedBy: actor.id,
          submittedAt: at,
        };
        draft.materials[id] = material;
        return clone(material);
      });
    },
    recordConsent({ actor, activityId, channel, granted, materialId = null, note = null }: any) {
      requireCapability(actor, 'consent.record', activityId);
      return commit('consent.record', actor, activityId, draft => {
        activity(draft, activityId);
        const target = text(channel, 'channel');
        if (!PUBLICATION_CHANNELS.includes(target)) {
          throw new OperationsError('validation', `channel ${target} is not a publication channel`, { known: PUBLICATION_CHANNELS });
        }
        const id = nextId(draft, 'consent');
        const at = now();
        const record = {
          id, activityId, channel: target,
          materialId: materialId ? text(materialId, 'materialId') : null,
          granted: granted === true,
          note,
          seq: draft.sequence + 1,
          recordedBy: actor.id,
          at,
        };
        draft.consents[id] = record;
        return clone(record);
      });
    },
    channelConsent(activityId: unknown, channel: unknown) {
      const record = consentRecord(clone(state), text(activityId, 'activityId'), text(channel, 'channel'));
      return record ? clone(record) : { granted: false, reason: 'no_explicit_consent' };
    },
    listMaterials(activityId: unknown) {
      return Object.values(state.materials).filter((material: any) => material.activityId === activityId).map(clone);
    },

    // ------------------------------------------------------------------------------ outcomes
    submitOutcome({ actor, activityId, fields }: any) {
      requireCapability(actor, 'outcome.submit', activityId);
      return commit('outcome.submit', actor, activityId, draft => {
        const owner = activity(draft, activityId);
        const input = fields ?? {};
        const attendance = input.attendance ?? {};
        const missing = [];
        if (!input.actualStartAt || !input.actualEndAt) missing.push('actualTime');
        if (!input.actualLocation) missing.push('actualLocation');
        if (!input.summary) missing.push('summary');
        if (!Number.isInteger(attendance.count)) missing.push('attendance');
        if (!attendance.basis) missing.push('attendanceBasis');
        if (!Number.isInteger(input.actualExpensesMinor)) missing.push('actualExpenses');
        const discrepancies = Array.isArray(input.discrepancies) ? input.discrepancies.map(String) : [];
        const status = missing.length ? 'incomplete' : (discrepancies.length ? 'pending_verification' : 'materials_complete');
        const at = now();
        const record = {
          activityId: owner.id,
          status,
          missing,
          discrepancies,
          verification: draft.outcomes[owner.id]?.verification ?? 'unverified',
          review: null,
          materials: {
            actualStartAt: input.actualStartAt ?? null,
            actualEndAt: input.actualEndAt ?? null,
            actualLocation: input.actualLocation ?? null,
            summary: input.summary ?? null,
            attendance: Number.isInteger(attendance.count) ? { count: attendance.count, basis: attendance.basis ?? null } : null,
            photos: Array.isArray(input.photos) ? input.photos.map(String) : [],
            permittedAlternatives: Array.isArray(input.permittedAlternatives) ? input.permittedAlternatives.map(String) : [],
            actualExpensesMinor: Number.isInteger(input.actualExpensesMinor) ? input.actualExpensesMinor : null,
            issues: input.issues ?? null,
            improvements: input.improvements ?? null,
          },
          requiredItems: [...OUTCOME_REQUIREMENTS],
          submittedBy: actor.id,
          submittedAt: at,
          updatedAt: at,
        };
        draft.outcomes[owner.id] = record;
        return clone(record);
      });
    },
    reviewOutcome({ actor, activityId, decision, notes = null }: any) {
      requireCapability(actor, 'outcome.review', activityId);
      return commit('outcome.review', actor, activityId, draft => {
        const owner = activity(draft, activityId);
        const outcome = draft.outcomes[owner.id];
        if (!outcome) throw new OperationsError('not_found', `activity ${owner.id} has no submitted outcome`);
        const choice = text(decision, 'decision');
        if (!['accepted', 'needs_verification', 'rejected'].includes(choice)) {
          throw new OperationsError('validation', `decision ${choice} is not a review outcome`);
        }
        if (choice === 'accepted' && outcome.missing.length) {
          throw new OperationsError('materials_incomplete', 'materials complete is required before acceptance', { missing: outcome.missing });
        }
        if (actor.kind === 'agent') {
          const openExceptions = Object.values(draft.exceptions).some((item: any) => item.activityId === owner.id && item.status === 'open');
          const routine = choice === 'accepted' && !outcome.discrepancies.length && !openExceptions;
          if (!routine) {
            throw new OperationsError('agent_review_out_of_authority', 'the agent reviews only routine, complete and undisputed outcomes', {
              decision: choice, discrepancies: outcome.discrepancies.length, openExceptions,
            });
          }
        }
        const at = now();
        outcome.review = { decision: choice, by: actor.id, at, notes };
        outcome.status = choice === 'needs_verification' ? 'pending_verification' : outcome.status;
        outcome.updatedAt = at;
        return clone(outcome);
      });
    },
    recordVerification({ actor, activityId, verified, notes = null }: any) {
      requireCapability(actor, 'outcome.verify', activityId);
      return commit('outcome.verify', actor, activityId, draft => {
        const owner = activity(draft, activityId);
        const outcome = draft.outcomes[owner.id];
        if (!outcome) throw new OperationsError('not_found', `activity ${owner.id} has no submitted outcome`);
        outcome.verification = verified === true ? 'verified' : 'disputed';
        outcome.verificationNotes = notes;
        outcome.updatedAt = now();
        return clone(outcome);
      });
    },
    getOutcome(activityId: unknown) { return clone(state.outcomes[text(activityId, 'activityId')] ?? null); },

    // -------------------------------------------------------------------------- publications
    createPublicationDraft({ actor, activityId, title, body, channels, materialIds = [] }: any) {
      requireCapability(actor, 'publication.draft', activityId);
      return commit('publication.draft', actor, activityId, draft => {
        const owner = activity(draft, activityId);
        if (!['completed', 'accepted'].includes(owner.state)) {
          throw new OperationsError('invalid_transition', `publication drafts start after the activity is completed, not in ${owner.state}`);
        }
        const requested = (Array.isArray(channels) ? channels : []).map(channel => text(channel, 'channel'));
        if (!requested.length) throw new OperationsError('validation', 'at least one publication channel is required');
        for (const channel of requested) {
          if (!PUBLICATION_CHANNELS.includes(channel)) {
            throw new OperationsError('validation', `channel ${channel} is not a publication channel`, { known: PUBLICATION_CHANNELS });
          }
        }
        // AC14: one activity has a single canonical article. A live record (draft, awaiting
        // confirmation, ready, publishing or published) must be withdrawn or fail first, so
        // repeated confirmation or a fresh draft cannot produce two articles for one event.
        const live = publicationsFor(draft, owner.id).find(item => !TERMINAL_PUBLICATION_STATES.includes(item.state));
        if (live) {
          throw new OperationsError('publication_exists', 'one activity has a single canonical article; withdraw the existing publication before drafting another', {
            publicationId: live.id, state: live.state,
          });
        }
        const id = nextId(draft, 'publication');
        const at = now();
        const record = {
          id, activityId: owner.id,
          seq: draft.sequence + 1,
          title: text(title, 'title'),
          body: text(body, 'body'),
          channels: requested,
          materialIds: (Array.isArray(materialIds) ? materialIds : []).map(value => text(value, 'materialId')),
          state: 'draft',
          factConfirmation: { requestedAt: null, confirmedAt: null, by: null },
          missingConsents: requested,
          jobId: null,
          linkJobId: null,
          linkReturnedAt: null,
          url: null,
          corrections: [],
          createdAt: at,
          updatedAt: at,
        };
        draft.publications[id] = record;
        return clone(record);
      });
    },
    requestFactConfirmation({ actor, publicationId }: any) {
      const publication = state.publications[text(publicationId, 'publicationId')];
      if (!publication) throw new OperationsError('not_found', `publication ${publicationId} does not exist`);
      requireCapability(actor, 'publication.draft', publication.activityId);
      return commit('publication.request_confirmation', actor, publication.activityId, draft => {
        const record = draft.publications[publicationId];
        if (record.state !== 'draft') throw new OperationsError('invalid_transition', `publication ${record.state} cannot request confirmation`);
        const at = now();
        record.state = 'awaiting_confirmation';
        record.factConfirmation.requestedAt = at;
        record.updatedAt = at;
        return clone(record);
      });
    },
    confirmFacts({ actor, publicationId }: any) {
      const publication = state.publications[text(publicationId, 'publicationId')];
      if (!publication) throw new OperationsError('not_found', `publication ${publicationId} does not exist`);
      const owner = activity(state, publication.activityId);
      const isLead = actor?.id === owner.leadId;
      if (!isLead) throw new OperationsError('unauthorized', 'only the activity lead can confirm facts');
      requireCapability(actor, 'publication.confirm_facts', owner.id);
      return commit('publication.confirm_facts', actor, owner.id, draft => {
        const record = draft.publications[publicationId];
        if (record.state !== 'awaiting_confirmation') {
          throw new OperationsError('invalid_transition', `publication ${record.state} is not awaiting confirmation`);
        }
        if (verifyContributor(actor.id, now()) !== true) {
          throw new OperationsError('lead_not_active_contributor', 'fact confirmation requires verified active Contributor status');
        }
        const missing = missingConsents(draft, owner.id, record.channels, record.materialIds);
        record.missingConsents = missing;
        const at = now();
        if (missing.length) {
          record.updatedAt = at;
          return { confirmed: false, state: record.state, missingConsents: missing };
        }
        record.state = 'ready';
        record.factConfirmation.confirmedAt = at;
        record.factConfirmation.by = actor.id;
        record.updatedAt = at;
        return { confirmed: true, state: record.state, missingConsents: [] };
      });
    },
    publishPublication({ actor, publicationId }: any) {
      const publication = state.publications[text(publicationId, 'publicationId')];
      if (!publication) throw new OperationsError('not_found', `publication ${publicationId} does not exist`);
      requireCapability(actor, 'publication.publish', publication.activityId);
      return commit('publication.publish', actor, publication.activityId, draft => {
        const record = draft.publications[publicationId];
        if (record.state !== 'ready') {
          throw new OperationsError('invalid_transition', `publication ${record.state} is not ready to publish`);
        }
        const missing = missingConsents(draft, record.activityId, record.channels, record.materialIds);
        if (missing.length) throw new OperationsError('consent_required', 'channel consent is required before publication', { missingConsents: missing });
        const at = now();
        const { job } = enqueueIntent(draft, actor, record.activityId, 'publish_article', { publicationId: record.id, channels: record.channels }, `publish:${record.id}`, at);
        record.jobId = job.id;
        record.state = 'publishing';
        record.updatedAt = at;
        return { publication: clone(record), job, published: false };
      });
    },
    withdrawPublication({ actor, publicationId, reason }: any) {
      const publication = state.publications[text(publicationId, 'publicationId')];
      if (!publication) throw new OperationsError('not_found', `publication ${publicationId} does not exist`);
      requireCapability(actor, 'publication.publish', publication.activityId);
      return commit('publication.withdraw', actor, publication.activityId, draft => {
        const record = draft.publications[publicationId];
        const at = now();
        record.corrections.push({ reason: text(reason, 'reason'), at, by: actor.id });
        record.state = 'withdrawn';
        record.updatedAt = at;
        return clone(record);
      });
    },
    getPublication(publicationId: unknown) {
      const record = state.publications[text(publicationId, 'publicationId')] ?? null;
      if (!record) return null;
      // The link is "returned" only once its own event-space intent is delivered; the publication
      // record never claims the return on its own (R27). The delivery paths stamp that receipt time
      // into `linkReturnedAt`, so the persisted record and this view agree.
      const linkJob = record.linkJobId ? state.jobs[record.linkJobId] : null;
      return {
        ...clone(record),
        linkReturned: Boolean(linkJob && linkJob.state === 'delivered'),
        linkDeliveryState: linkJob ? linkJob.state : (record.linkJobId ? 'unknown' : 'not_queued'),
      };
    },

    // ------------------------------------------------------------------------------- finance
    requestFunding({ actor, activityId, amountMinor, currency }: any) {
      requireCapability(actor, 'finance.request', activityId);
      const amount = money(amountMinor, currency, 'amountMinor');
      return commit('finance.request', actor, activityId, draft => {
        const owner = activity(draft, activityId);
        const finance = financeOf(draft, owner.id);
        const at = now();
        moveFinance(draft, finance, 'requested', { amountMinor: amount.amountMinor }, at);
        finance.requestedMinor = amount.amountMinor;
        finance.currency = amount.currency;
        return clone(finance);
      });
    },
    approveFunding({ actor, activityId, ceilingMinor, currency, allocationReference }: any) {
      requireCapability(actor, 'finance.approve', activityId);
      const ceiling = money(ceilingMinor, currency, 'ceilingMinor');
      // F6: an approval that lands in a later state edits an existing commitment rather than
      // granting a new one, so it is recorded under a distinct audit action.
      const targetId = text(activityId, 'activityId');
      const priorState = state.finances[targetId]?.state ?? 'not_requested';
      const adjustment = !['not_requested', 'requested', 'awaiting_allocation'].includes(priorState);
      return commit(adjustment ? 'finance.approve_adjust' : 'finance.approve', actor, activityId, draft => {
        const owner = activity(draft, activityId);
        const finance = financeOf(draft, owner.id);
        const at = now();
        const reference = text(allocationReference, 'allocationReference');
        if (finance.state === 'not_requested') {
          throw new OperationsError('invalid_transition', 'funding approval requires a funding request first');
        }
        if (finance.currency && finance.currency !== ceiling.currency) {
          throw new OperationsError('currency_mismatch', 'an approved allocation cannot change the currency of committed funds', {
            currency: finance.currency, requested: ceiling.currency,
          });
        }
        // Once funds are reserved or paid, an edit must not silently drop the ceiling below what
        // is already committed to the activity.
        const committedFloor = Math.max(finance.reservedMinor, finance.paidMinor);
        if (!['requested', 'awaiting_allocation'].includes(finance.state) && ceiling.amountMinor < committedFloor) {
          throw new OperationsError('ceiling_below_committed', 'an approval edit cannot drop the ceiling below funds already reserved or paid', {
            ceilingMinor: ceiling.amountMinor, reservedMinor: finance.reservedMinor, paidMinor: finance.paidMinor,
          });
        }
        if (finance.state === 'requested') moveFinance(draft, finance, 'awaiting_allocation', { ceilingMinor: ceiling.amountMinor, allocationReference: reference }, at);
        if (finance.approvedAt && finance.approvedCeilingMinor !== ceiling.amountMinor) {
          finance.history.push({
            from: finance.state, to: finance.state, at, event: 'ceiling_adjusted',
            fromCeilingMinor: finance.approvedCeilingMinor, ceilingMinor: ceiling.amountMinor,
            allocationReference: reference, actorId: actor.id,
          });
        }
        finance.approvedCeilingMinor = ceiling.amountMinor;
        finance.currency = ceiling.currency;
        finance.allocationReference = reference;
        finance.approvedAt = at;
        finance.approvedBy = actor.id;
        return clone(finance);
      });
    },
    reserveFunds({ actor, activityId, amountMinor }: any) {
      requireCapability(actor, 'finance.reserve', activityId);
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new OperationsError('validation', 'amountMinor must be a positive integer');
      return commit('finance.reserve', actor, activityId, draft => {
        const owner = activity(draft, activityId);
        const finance = financeOf(draft, owner.id);
        const at = now();
        if (!finance.allocationReference) throw new OperationsError('allocation_required', 'reservation requires an approved allocation reference');
        if (!['requested', 'awaiting_allocation', 'reserved', 'awaiting_settlement'].includes(finance.state)) {
          throw new OperationsError('invalid_transition', `finance ${finance.state} cannot reserve funds`);
        }
        // Top-up reservation for a recorded overspend. It needs the same reservation capability and
        // the same allocation reference as any other commitment, and it is bounded by the
        // authorization the Board granted in approveOverspend plus the approved ceiling.
        const topUp = finance.state === 'awaiting_settlement';
        if (topUp) {
          const authorized = finance.pendingOverspendAuthorization ?? null;
          if (!authorized) {
            throw new OperationsError('overspend_authorization_required', 'an unresolved overspend can only be reserved after an authorized approval', {
              pendingSettlementMinor: finance.pendingSettlementMinor,
            });
          }
          if (amountMinor > authorized.amountMinor) {
            throw new OperationsError('overspend_authorization_exceeded', 'a reservation cannot exceed the authorized overspend', {
              authorizedMinor: authorized.amountMinor, amountMinor,
            });
          }
        }
        if (finance.reservedMinor + amountMinor > finance.approvedCeilingMinor) {
          throw new OperationsError('ceiling_exceeded', 'reservation exceeds the approved ceiling', {
            ceilingMinor: finance.approvedCeilingMinor, reservedMinor: finance.reservedMinor, requestedMinor: amountMinor,
          });
        }
        if (!['reserved', 'awaiting_settlement'].includes(finance.state)) moveFinance(draft, finance, 'reserved', { amountMinor }, at);
        if (topUp) {
          const remaining = finance.pendingOverspendAuthorization.amountMinor - amountMinor;
          finance.pendingOverspendAuthorization = remaining > 0
            ? { ...finance.pendingOverspendAuthorization, amountMinor: remaining }
            : null;
          finance.history.push({
            from: finance.state, to: finance.state, at, event: 'overspend_reserved',
            amountMinor, approvedCeilingMinor: finance.approvedCeilingMinor, actorId: actor.id,
          });
        }
        finance.reservedMinor += amountMinor;
        // The overspend stays unresolved until the reservation actually covers the recorded
        // actual; a partial top-up leaves the settlement gate closed.
        finance.pendingSettlementMinor = Math.max(0, (finance.actualMinor ?? 0) - finance.reservedMinor);
        return clone(finance);
      });
    },
    recordPayment({ actor, activityId, amountMinor, currency, receiptReference, paidBy }: any) {
      requireCapability(actor, 'finance.record_payment', activityId);
      const amount = money(amountMinor, currency, 'amountMinor');
      return commit('finance.record_payment', actor, activityId, draft => {
        const owner = activity(draft, activityId);
        const finance = financeOf(draft, owner.id);
        const at = now();
        const reference = text(receiptReference, 'receiptReference');
        const payer = text(paidBy, 'paidBy');
        if (amount.amountMinor <= 0) throw new OperationsError('validation', 'a payment record needs a positive amount');
        if (!['reserved', 'partially_paid', 'awaiting_settlement'].includes(finance.state)) {
          throw new OperationsError('invalid_transition', `finance ${finance.state} cannot record a payment`);
        }
        if (finance.paidMinor + amount.amountMinor > finance.reservedMinor) {
          throw new OperationsError('payment_exceeds_reservation', 'a payment record cannot exceed the reserved amount', {
            reservedMinor: finance.reservedMinor, paidMinor: finance.paidMinor, requestedMinor: amount.amountMinor,
          });
        }
        finance.paidMinor += amount.amountMinor;
        moveFinance(draft, finance, finance.paidMinor >= finance.reservedMinor ? 'paid' : 'partially_paid', {
          amountMinor: amount.amountMinor, receiptReference: reference, paidBy: payer, recordedBy: actor.id,
        }, at);
        return clone(finance);
      });
    },
    recordSettlement({ actor, activityId, actualMinor, unusedReleasedMinor, notes = null }: any) {
      requireCapability(actor, 'finance.record_settlement', activityId);
      return commit('finance.settle', actor, activityId, draft => {
        const owner = activity(draft, activityId);
        const finance = financeOf(draft, owner.id);
        const at = now();
        if (!Number.isInteger(actualMinor) || actualMinor < 0) throw new OperationsError('validation', 'actualMinor must be a non-negative integer');
        if (!Number.isInteger(unusedReleasedMinor) || unusedReleasedMinor < 0) throw new OperationsError('validation', 'unusedReleasedMinor must be a non-negative integer');
        if (!['paid', 'partially_paid', 'awaiting_settlement'].includes(finance.state)) {
          throw new OperationsError('invalid_transition', `finance ${finance.state} cannot settle`);
        }
        // F1: a recorded overspend is frozen. A second settlement call must not rewrite the
        // recorded actual to escape it; only an authorized overspend approval can clear it.
        if (finance.state === 'awaiting_settlement' && finance.pendingSettlementMinor > 0) {
          throw new OperationsError('overspend_unresolved', 'settle the pending overspend through an authorized approval before recording settlement', {
            pendingSettlementMinor: finance.pendingSettlementMinor, recordedActualMinor: finance.actualMinor,
          });
        }
        finance.actualMinor = actualMinor;
        finance.unusedReleasedMinor = unusedReleasedMinor;
        if (actualMinor > finance.reservedMinor) {
          finance.pendingSettlementMinor = actualMinor - finance.reservedMinor;
          if (!notes) throw new OperationsError('notes_required', 'overspend is not automatically approved; settlement needs an explanation');
          moveFinance(draft, finance, 'awaiting_settlement', { actualMinor, overspend: true, notes }, at);
          return { ...clone(finance), overspend: true, approved: false };
        }
        // F7: settlement closes obligations. It cannot run while the actual expense is not yet
        // covered by recorded payments, which would settle a still-unpaid obligation.
        if (finance.paidMinor < actualMinor) {
          throw new OperationsError('unpaid_obligation', 'actual expenses exceed recorded payments; record the payment before settling', {
            paidMinor: finance.paidMinor, actualMinor,
          });
        }
        if (unusedReleasedMinor !== finance.reservedMinor - actualMinor) {
          throw new OperationsError('settlement_mismatch', 'unused funds must equal reserved minus actual expense', {
            reservedMinor: finance.reservedMinor, actualMinor, unusedReleasedMinor,
          });
        }
        finance.pendingSettlementMinor = 0;
        moveFinance(draft, finance, 'settled', { actualMinor, unusedReleasedMinor, notes }, at);
        return { ...clone(finance), overspend: false, approved: true };
      });
    },
    // F1 recovery, step 1 of 2: authorize an overspend. This is a Board-style decision under
    // `finance.approve` and it only raises the approved ceiling and records the authorization. It
    // reserves nothing, pays nothing, moves no finance state and never rewrites the recorded
    // actual. The money is committed later by `reserveFunds` under `finance.reserve`, so approval
    // and reservation keep distinct actors, capabilities, references and audit events.
    //
    // Organization-wide availability is deliberately out of scope here. `governance.tallyRound` is
    // the authoritative availability gate: with `budgetAvailableMinor === null` it returns
    // `awaiting_funding_allocation` and commits nothing. This core consumes the resulting
    // allocation reference and ceiling; it does not query a funds pool of its own, and the
    // currency/available-funds source for a real deployment is still unresolved in
    // docs/decisions.md. Approval therefore raises an authorized ceiling only.
    approveOverspend({ actor, activityId, amountMinor, currency, allocationReference, notes = null }: any) {
      requireCapability(actor, 'finance.approve', activityId);
      const amount = money(amountMinor, currency, 'amountMinor');
      return commit('finance.approve_overspend', actor, activityId, draft => {
        const owner = activity(draft, activityId);
        const finance = financeOf(draft, owner.id);
        const at = now();
        const reference = text(allocationReference, 'allocationReference');
        if (finance.state !== 'awaiting_settlement' || finance.pendingSettlementMinor <= 0) {
          throw new OperationsError('invalid_transition', `finance ${finance.state} has no pending overspend to approve`);
        }
        if (finance.pendingOverspendAuthorization) {
          throw new OperationsError('overspend_already_authorized', 'the pending overspend already has an authorization awaiting reservation', {
            authorizedMinor: finance.pendingOverspendAuthorization.amountMinor,
          });
        }
        if (amount.amountMinor !== finance.pendingSettlementMinor) {
          throw new OperationsError('overspend_mismatch', 'the approval must cover exactly the recorded pending overspend', {
            pendingSettlementMinor: finance.pendingSettlementMinor, amountMinor: amount.amountMinor,
          });
        }
        if (finance.currency && finance.currency !== amount.currency) {
          throw new OperationsError('currency_mismatch', 'the overspend approval must use the committed currency', {
            currency: finance.currency, requested: amount.currency,
          });
        }
        finance.approvedCeilingMinor += amount.amountMinor;
        finance.allocationReference = reference;
        finance.pendingOverspendAuthorization = { amountMinor: amount.amountMinor, allocationReference: reference, notes, by: actor.id, at };
        finance.history.push({
          from: finance.state, to: finance.state, at, event: 'overspend_authorized',
          overspendMinor: amount.amountMinor, approvedCeilingMinor: finance.approvedCeilingMinor,
          allocationReference: reference, actorId: actor.id,
        });
        return { ...clone(finance), overspendAuthorized: true, reserved: false };
      });
    },
    getFinance(activityId: unknown) { return clone(financeOf(clone(state), text(activityId, 'activityId'))); },

    // ---------------------------------------------------------------------- external intents
    enqueueExternalIntent({ actor, activityId, kind, payload = null, idempotencyKey }: any) {
      requireCapability(actor, 'external.enqueue', activityId);
      return commit('external.enqueue', actor, activityId, draft => {
        const owner = activity(draft, activityId);
        return enqueueIntent(draft, actor, owner.id, text(kind, 'kind'), payload, idempotencyKey, now());
      });
    },
    requestActivitySpace({ actor, activityId }: any) {
      requireCapability(actor, 'external.enqueue', activityId);
      return commit('activity.request_space', actor, activityId, draft => {
        const owner = activity(draft, activityId);
        if (owner.state !== 'approved') {
          throw new OperationsError('invalid_transition', `an event space is created after approval, not in ${owner.state}`);
        }
        const at = now();
        const result = enqueueIntent(draft, actor, owner.id, 'create_space', { activityId: owner.id }, `create_space:${owner.id}`, at);
        owner.space = { state: result.deduplicated ? owner.space.state : 'pending', jobId: result.job.id, url: owner.space.url };
        return { ...result, space: clone(owner.space), created: false };
      });
    },
    retryExternalIntent({ actor, jobId }: any) {
      const job = state.jobs[text(jobId, 'jobId')];
      if (!job) throw new OperationsError('not_found', `intent ${jobId} does not exist`);
      requireCapability(actor, 'external.retry', job.activityId);
      return commit('external.retry', actor, job.activityId, draft => {
        const record = draft.jobs[jobId];
        if (record.state === 'uncertain') {
          throw new OperationsError('reconcile_required', 'reconcile an uncertain outcome before retrying');
        }
        if (record.state === 'delivered') return { ...jobView(record), retried: false, reason: 'already_delivered' };
        if (!['pending', 'failed'].includes(record.state)) {
          throw new OperationsError('invalid_transition', `intent ${record.state} cannot be retried`);
        }
        record.attempts += 1;
        record.state = 'pending';
        record.updatedAt = now();
        return { ...jobView(record), retried: true };
      });
    },
    markExternalIntentFailed({ actor, jobId, error }: any) {
      const job = state.jobs[text(jobId, 'jobId')];
      if (!job) throw new OperationsError('not_found', `intent ${jobId} does not exist`);
      requireCapability(actor, 'external.retry', job.activityId);
      return commit('external.failed', actor, job.activityId, draft => {
        const record = draft.jobs[jobId];
        if (!['pending', 'uncertain', 'failed'].includes(record.state)) {
          throw new OperationsError('invalid_transition', `intent ${record.state} cannot be marked failed`);
        }
        record.state = 'failed';
        record.note = text(error, 'error');
        record.updatedAt = now();
        return jobView(record);
      });
    },
    markExternalIntentUncertain({ actor, jobId, note }: any) {
      const job = state.jobs[text(jobId, 'jobId')];
      if (!job) throw new OperationsError('not_found', `intent ${jobId} does not exist`);
      requireCapability(actor, 'external.reconcile', job.activityId);
      return commit('external.uncertain', actor, job.activityId, draft => {
        const record = draft.jobs[jobId];
        if (!['pending', 'uncertain'].includes(record.state)) {
          throw new OperationsError('invalid_transition', `intent ${record.state} cannot be marked uncertain`);
        }
        record.state = 'uncertain';
        record.note = text(note, 'note');
        record.updatedAt = now();
        return jobView(record);
      });
    },
    reconcileExternalIntent({ actor, jobId, resolution, receipt = null }: any) {
      const job = state.jobs[text(jobId, 'jobId')];
      if (!job) throw new OperationsError('not_found', `intent ${jobId} does not exist`);
      requireCapability(actor, 'external.reconcile', job.activityId);
      return commit('external.reconcile', actor, job.activityId, draft => {
        const record = draft.jobs[jobId];
        if (record.state !== 'uncertain') throw new OperationsError('invalid_transition', `intent ${record.state} is not awaiting reconciliation`);
        const choice = text(resolution, 'resolution');
        const at = now();
        if (choice === 'delivered') {
          if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
              ![receipt.providerRef, receipt.id, receipt.url].some(item => typeof item === 'string' && item.trim())) {
            throw new OperationsError('receipt_required', 'a provider resource reference is required before reconciling delivery');
          }
          if (receipt.key !== undefined && receipt.key !== record.key) {
            throw new OperationsError('receipt_key_mismatch', 'provider receipt key does not match the external intent');
          }
          if (record.kind === 'publish_article' && (typeof receipt.url !== 'string' || !receipt.url.trim())) {
            throw new OperationsError('publication_url_required', 'publication needs a canonical URL before it is marked delivered');
          }
          record.state = 'delivered';
          record.receipt = { ...clone(receipt), reconciledBy: actor.id, at };
          if (record.kind === 'create_space') {
            const owner = activity(draft, record.activityId);
            owner.space = { state: 'created', jobId: record.id, url: receipt.url ?? null };
          }
          if (record.kind === 'publish_article') {
            const publication = Object.values(draft.publications).find((item: any) => item.jobId === record.id) as any;
            if (publication) {
              publication.state = 'published';
              const url = text(receipt.url, 'receipt.url');
              publication.url = url;
              publication.updatedAt = at;
              enqueueArticleLink(draft, actor, record.activityId, publication, url, at);
            }
          }
          if (record.kind === 'post_article_link') markArticleLinkReturned(draft, record, at);
        } else if (choice === 'failed') {
          record.state = 'failed';
        } else {
          throw new OperationsError('validation', `resolution ${choice} must be delivered or failed`);
        }
        record.updatedAt = at;
        return jobView(record);
      });
    },
    recordExternalReceipt({ actor, jobId, receipt }: any) {
      const job = state.jobs[text(jobId, 'jobId')];
      if (!job) throw new OperationsError('not_found', `intent ${jobId} does not exist`);
      requireCapability(actor, 'external.record_receipt', job.activityId);
      return commit('external.receipt', actor, job.activityId, draft => {
        const record = draft.jobs[jobId];
        if (record.state === 'delivered') return { ...jobView(record), recorded: false };
        if (!['pending', 'failed', 'uncertain'].includes(record.state)) {
          throw new OperationsError('invalid_transition', `intent ${record.state} cannot record a receipt`);
        }
        const at = now();
        const value = receipt;
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            ![value.providerRef, value.id, value.url].some(item => typeof item === 'string' && item.trim())) {
          throw new OperationsError('receipt_required', 'a provider resource reference is required before recording delivery');
        }
        if (value.key !== undefined && value.key !== record.key) {
          throw new OperationsError('receipt_key_mismatch', 'provider receipt key does not match the external intent');
        }
        if (record.kind === 'publish_article' && (typeof value.url !== 'string' || !value.url.trim())) {
          throw new OperationsError('publication_url_required', 'publication needs a canonical URL before it is marked delivered');
        }
        record.state = 'delivered';
        record.receipt = { ...clone(value), recordedBy: actor.id, at };
        record.attempts += 1;
        record.updatedAt = at;
        if (record.kind === 'publish_article') {
          const publication = Object.values(draft.publications).find((item: any) => item.jobId === record.id) as any;
          if (publication) {
            const url = text(value.url, 'receipt.url');
            publication.state = 'published';
            publication.url = url;
            publication.updatedAt = at;
            enqueueArticleLink(draft, actor, record.activityId, publication, url, at);
          }
        }
        if (record.kind === 'create_space') {
          const owner = activity(draft, record.activityId);
          owner.space = { state: 'created', jobId: record.id, url: value.url ?? null };
        }
        if (record.kind === 'post_article_link') markArticleLinkReturned(draft, record, at);
        return { ...jobView(record), recorded: true };
      });
    },
    listExternalIntents({ actor, activityId }: any = {}) {
      requireCapability(actor, 'external.read', activityId);
      return Object.values(state.jobs).filter((job: any) => !activityId || job.activityId === activityId).map(jobView);
    },
    getExternalIntent({ actor, jobId }: any) {
      const job = state.jobs[text(jobId, 'jobId')];
      if (!job) throw new OperationsError('not_found', `intent ${jobId} does not exist`);
      requireCapability(actor, 'external.read', job.activityId);
      return jobView(job);
    },

    // ---------------------------------------------------------------------------- exceptions
    listExceptions({ actor, activityId }: any = {}) {
      requireCapability(actor, 'audit.read', activityId);
      return Object.values(state.exceptions).filter((item: any) => !activityId || item.activityId === activityId).map(clone);
    },
    resolveException({ actor, exceptionId, resolution }: any) {
      const exception = state.exceptions[text(exceptionId, 'exceptionId')];
      if (!exception) throw new OperationsError('not_found', `exception ${exceptionId} does not exist`);
      requireCapability(actor, 'exception.resolve', exception.activityId);
      return commit('exception.resolve', actor, exception.activityId, draft => {
        const record = draft.exceptions[exceptionId];
        if (record.status === 'resolved') return clone(record);
        record.status = 'resolved';
        record.resolvedAt = now();
        record.resolution = text(resolution, 'resolution');
        return clone(record);
      });
    },

    // Read-only helpers used by adapters and tests.
    snapshot() { return clone(state); },
  };
}
