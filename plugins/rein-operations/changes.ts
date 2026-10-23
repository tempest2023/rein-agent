// Rein-owned deterministic activity change core (PRD R20, AC11, US09, US10).
//
// Scope: classification and planning for ordinary, time, location, capacity, scope and funding
// changes, plus cancellation and lead handover for one activity. Everything here is local and
// deterministic: no network calls, no timers, nothing published.
//
// Boundaries, stated precisely:
// - This module does not own activities, reminders, finance or publications. It returns apply
//   instructions for the module that owns each record; it never rewrites those records itself.
// - It never contacts a chat or website provider. Every outbound effect is recorded as an
//   idempotent intent that stays `pending` with `externalDelivery: 'not_connected'` until an
//   adapter records a real provider receipt. A plan is not a notification.
// - Authorization is explicit actor/capability/resource and the default authorizer grants nothing.
//   The canonical member id must be supplied on the actor; a display name, channel label or the
//   tool-supplied actor id is never matched against the activity lead.
// - Nothing switches itself on. An unclassified field, a missing previous value, a missing
//   confirmation statement or an unconfigured audience produces a blocker or a notice rather than
//   a silent default.
import { createHash } from 'node:crypto';

export const CHANGE_CAPABILITIES = [
  'change.request',
  'change.confirm',
  'change.cancel',
  'change.cancel_as_handler',
  'change.handover',
  'change.handover_as_handler',
  'change.accept_handover',
  'change.record_governance_decision',
  'change.record_delivery',
  'change.read',
];

export const CHANGE_CLASSES = ['ordinary', 'material', 'scope', 'unclassified'];

export const CHANGE_INTENT_KINDS = [
  'update_standing_summary',
  'update_registration_page',
  'post_announcement',
  'adjust_reminders',
  'notify_participants',
  'close_registration',
  'pause_registration',
  'notify_handler',
  'update_finance_status',
  'update_lead_contact',
];

export const CHANGE_STATES = ['awaiting_lead_confirmation', 'awaiting_governance', 'applied', 'rejected'];
export const HANDOVER_STATES = ['awaiting_acceptance', 'accepted', 'declined', 'expired', 'canceled'];
export const REGISTRATION_STATES = ['not_started', 'open', 'paused', 'closed'];

// No chat or website adapter is connected in this repository. Intents record intent only.
export const EXTERNAL_DELIVERY = 'not_connected';

// Field -> handling. `surfaces` names what the change affects; the planner turns surfaces into
// intents and instructions. A path that is not listed here is `unclassified` and blocks.
const FIELD_POLICY = {
  title: { class: 'material', surfaces: ['registration_page', 'announcement', 'participants'] },
  audience: { class: 'material', surfaces: ['registration_page', 'announcement', 'participants'] },
  format: { class: 'scope', surfaces: ['registration_page', 'announcement', 'participants'], scopeReason: 'event_nature_change' },
  purpose: { class: 'scope', surfaces: ['registration_page', 'announcement', 'participants'], scopeReason: 'event_nature_change' },
};
const FIELD_NAMESPACES = {
  schedule: { class: 'material', surfaces: ['registration_page', 'announcement', 'reminders', 'participants', 'readiness'] },
  location: { class: 'material', surfaces: ['registration_page', 'announcement', 'participants', 'readiness'] },
  capacity: { class: 'material', surfaces: ['registration_page', 'announcement', 'participants'] },
  fees: { class: 'material', surfaces: ['registration_page', 'announcement', 'participants', 'finance'] },
  deliverables: { class: 'material', surfaces: ['announcement', 'participants'] },
  program: { class: 'ordinary', surfaces: ['standing_summary'] },
  risks: { class: 'scope', surfaces: ['readiness'], scopeReason: 'new_exception' },
  budget: { class: 'material', surfaces: ['finance'] },
};
// These paths compare against a previous value before the class can be decided.
const COMPARED_PATHS = new Set(['budget.requestedAmountMinor', 'budget.reimbursementExpected', 'budget.contractualCommitments']);

export class ChangeError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ChangeError';
    this.code = code;
    this.details = details ?? {};
  }
}

function clone(value: any) { return structuredClone(value); }

function text(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) throw new ChangeError('validation', `${field} must be a non-empty string`);
  return value.trim();
}

function timestamp(value: unknown, field: string) {
  const iso = value instanceof Date ? value.toISOString() : text(value, field);
  if (!Number.isFinite(Date.parse(iso))) throw new ChangeError('validation', `${field} must be a timestamp`);
  return new Date(iso).toISOString();
}

function integer(value: unknown, field: string) {
  if (!Number.isInteger(value) || (value as number) < 0) throw new ChangeError('validation', `${field} must be a non-negative integer`);
  return value as number;
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

const memberIdOf = (actor: any) =>
  typeof actor?.memberId === 'string' && actor.memberId.trim() ? actor.memberId.trim() : null;

function fieldPolicy(path: string) {
  if (Object.hasOwn(FIELD_POLICY, path)) return FIELD_POLICY[path];
  const namespace = path.split('.')[0];
  return Object.hasOwn(FIELD_NAMESPACES, namespace) ? FIELD_NAMESPACES[namespace] : null;
}

/**
 * The caller must supply a truthful view of the activity it owns. Missing collections are rejected
 * instead of assumed empty, so "no reminders" has to be stated as `[]`.
 */
export function normalizeActivityView(value: any) {
  if (!value || typeof value !== 'object') throw new ChangeError('not_found', 'the activity view is missing');
  const id = text(value.id, 'activity.id');
  const leadId = text(value.leadId, 'activity.leadId');
  const state = text(value.state, 'activity.state');
  const registrationState = text(value.registration?.state, 'activity.registration.state');
  if (!REGISTRATION_STATES.includes(registrationState)) {
    throw new ChangeError('validation', `registration state ${registrationState} is not recognised`, { known: REGISTRATION_STATES });
  }
  if (!Array.isArray(value.scheduledReminderIds) || value.scheduledReminderIds.some(item => typeof item !== 'string' || !item.trim())) {
    throw new ChangeError('activity_view_incomplete', 'activity.scheduledReminderIds must be an array of reminder ids; use [] when none are scheduled');
  }
  const finance = value.finance ?? null;
  if (finance !== null) {
    if (typeof finance !== 'object' || Array.isArray(finance)) throw new ChangeError('validation', 'activity.finance must be an object or null');
    for (const field of ['requestedMinor', 'approvedCeilingMinor', 'reservedMinor', 'paidMinor']) integer(finance[field], `activity.finance.${field}`);
    if (finance.actualMinor !== null && finance.actualMinor !== undefined) integer(finance.actualMinor, 'activity.finance.actualMinor');
    const currency = finance.currency ?? null;
    if (currency !== null && !/^[A-Z]{3}$/.test(currency)) throw new ChangeError('validation', 'activity.finance.currency must be a three-letter code or null');
    if (currency === null && (finance.requestedMinor || finance.reservedMinor || finance.paidMinor)) {
      throw new ChangeError('validation', 'activity.finance.currency is required once an amount is non-zero');
    }
  }
  return {
    id,
    title: value.title ?? null,
    leadId,
    state,
    registration: { state: registrationState, currentCount: value.registration?.currentCount ?? null },
    scheduledReminderIds: [...value.scheduledReminderIds],
    budget: value.budget ? clone(value.budget) : null,
    finance: finance ? clone(finance) : null,
  };
}

/**
 * Decide what one proposed change requires. Pure: no state, no clock, no I/O. A funding increase, an
 * event-nature change or a new exception is a `scope` change that routes to governance and can never
 * be applied by the Agent on its own.
 */
export function classifyChange({ fields, previous = null, activity = null }: any) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length === 0) {
    throw new ChangeError('validation', 'change.fields must be a non-empty object of dotted field paths');
  }
  const entries = [];
  const blockers = [];
  for (const [path, nextValue] of Object.entries(fields)) {
    if (!path.trim() || /\s/.test(path)) throw new ChangeError('validation', `${JSON.stringify(path)} is not a dotted field path`);
    if (path === 'leadId') {
      throw new ChangeError('lead_change_requires_handover', 'a lead change must go through the handover flow with the replacement\'s explicit acceptance');
    }
    if (COMPARED_PATHS.has(path)) {
      const previousValue = previous?.[path] ?? activity?.budget?.[path.split('.')[1]] ?? undefined;
      if (previousValue === undefined) {
        blockers.push({ code: 'previous_value_required', path, message: `Changing ${path} needs the current value for comparison` });
        entries.push({ path, class: 'unclassified', surfaces: [], previousValue: null, nextValue });
        continue;
      }
      const raised = path === 'budget.requestedAmountMinor'
        ? integer(nextValue, path) > integer(previousValue, path)
        : nextValue === true && previousValue !== true;
      entries.push({
        path,
        class: raised ? 'scope' : 'material',
        surfaces: ['finance'],
        previousValue,
        nextValue,
        scopeReason: raised ? (path === 'budget.requestedAmountMinor' ? 'additional_funding' : 'new_funding_commitment') : null,
      });
      continue;
    }
    const policy = fieldPolicy(path);
    if (!policy) {
      entries.push({ path, class: 'unclassified', surfaces: [], previousValue: null, nextValue });
      blockers.push({ code: 'unclassified_change_field', path, message: `${path} has no agreed handling; an authorized person must classify it before the change can be applied` });
      continue;
    }
    entries.push({ path, class: policy.class, surfaces: [...policy.surfaces], previousValue: previous?.[path] ?? undefined, nextValue, scopeReason: policy.scopeReason ?? null });
  }
  const order = { unclassified: 0, scope: 1, material: 2, ordinary: 3 };
  const ranked = [...entries].sort((a, b) => order[a.class] - order[b.class]);
  const scopeEntries = entries.filter(entry => entry.class === 'scope');
  const fundingEntry = scopeEntries.find(entry => entry.path === 'budget.requestedAmountMinor');
  return {
    entries,
    classes: [...new Set(ranked.map(entry => entry.class))],
    surfaces: [...new Set(entries.flatMap(entry => entry.surfaces))],
    requiresLeadConfirmation: entries.some(entry => entry.class === 'ordinary' || entry.class === 'material'),
    requiresGovernance: scopeEntries.length > 0,
    scopeReason: scopeEntries[0]?.scopeReason ?? (scopeEntries.length ? 'scope_change' : null),
    funding: fundingEntry
      ? { previousMinor: fundingEntry.previousValue, requestedMinor: fundingEntry.nextValue, currency: fields['budget.currency'] ?? activity?.budget?.currency ?? null }
      : null,
    blockers,
  };
}

function participantIntent({ policy, activityId, subject, payload, notices }: any) {
  const audience = policy?.participantAudience ?? null;
  if (!audience) notices.push({ code: 'participant_audience_not_configured', message: 'No participant audience is configured, so this notification intent cannot be dispatched yet' });
  return {
    kind: 'notify_participants',
    key: derivedKey([activityId, subject, 'notify_participants']),
    payload: { ...payload, audience },
    dispatchBlockers: audience ? [] : ['audience_not_configured'],
  };
}

/**
 * Plan a change. Nothing is applied and no intent is created until the lead's explicit confirmation
 * is present and, for scope changes, a governance decision is recorded.
 */
export function planChange({ activity, change, now, requesterMemberId = null, confirmation = null, policy = null, governanceApproved = false, isActiveContributor = () => false }: any) {
  const view = normalizeActivityView(activity);
  const at = timestamp(now, 'now');
  const classification = classifyChange({ fields: change.fields, previous: change.previous ?? null, activity: view });
  const blockers = [...classification.blockers];
  const notices = [];
  const isLead = Boolean(requesterMemberId) && requesterMemberId === view.leadId;
  let confirmationSatisfied = false;
  if (confirmation) {
    if (!isLead) blockers.push({ code: 'confirmation_by_non_lead', message: 'Only the current activity lead can confirm this change' });
    else if (typeof confirmation.statement !== 'string' || !confirmation.statement.trim()) blockers.push({ code: 'confirmation_statement_required', message: 'Silence is not consent; the lead must state the confirmation explicitly' });
    else if (isActiveContributor(view.leadId, at) !== true) blockers.push({ code: 'lead_not_active_contributor', message: 'The lead\'s current Contributor status must be verified before confirming a change' });
    else confirmationSatisfied = true;
  }
  const confirmationRequired = classification.requiresLeadConfirmation || (classification.requiresGovernance && !isLead);
  if (confirmationRequired && !confirmationSatisfied) {
    blockers.push({ code: 'lead_confirmation_required', message: 'The lead must explicitly confirm this change' });
  }
  if (classification.requiresGovernance) {
    if (governanceApproved) notices.push({ code: 'governance_decision_recorded', message: 'A recorded governance decision covers this change' });
    else blockers.push({ code: 'governance_required', message: 'This change is paused and must go through the approval rules; the Agent cannot authorize it' });
  }
  const applicable = blockers.length === 0;
  const pauses = [];
  if (classification.requiresGovernance && !governanceApproved) {
    pauses.push(classification.scopeReason === 'additional_funding' || classification.scopeReason === 'new_funding_commitment'
      ? { action: 'hold_additional_commitments', reason: classification.scopeReason, fields: classification.entries.map(entry => entry.path) }
      : { action: 'pause_activity', reason: classification.scopeReason, fields: classification.entries.map(entry => entry.path) });
  }
  const instructions = { activity: [], reminders: [], registration: [], finance: [], grants: [] };
  const intents = [];
  if (applicable) {
    const paths = classification.entries.map(entry => entry.path);
    instructions.activity.push({ action: 'update_fields', fields: clone(change.fields) });
    intents.push({ kind: 'update_standing_summary', key: derivedKey([view.id, change.subject ?? null, 'summary']), payload: { activityId: view.id, fields: clone(change.fields), reason: change.reason ?? null }, dispatchBlockers: [] });
    if (classification.surfaces.includes('registration_page')) {
      instructions.registration.push({ action: 'update_page', fields: clone(change.fields) });
      intents.push({ kind: 'update_registration_page', key: derivedKey([view.id, change.subject ?? null, 'registration']), payload: { activityId: view.id, fields: clone(change.fields) }, dispatchBlockers: [] });
    }
    if (classification.surfaces.includes('announcement')) {
      intents.push({ kind: 'post_announcement', key: derivedKey([view.id, change.subject ?? null, 'announcement']), payload: { activityId: view.id, fields: clone(change.fields), reason: change.reason ?? null }, dispatchBlockers: [] });
    }
    if (classification.surfaces.includes('reminders')) {
      instructions.reminders.push({ action: 'reschedule', reminderIds: [...view.scheduledReminderIds], reason: 'schedule_changed' });
      intents.push({ kind: 'adjust_reminders', key: derivedKey([view.id, change.subject ?? null, 'reminders']), payload: { activityId: view.id, reminderIds: [...view.scheduledReminderIds] }, dispatchBlockers: [] });
    }
    if (classification.surfaces.includes('readiness')) instructions.activity.push({ action: 'recheck_readiness', fields: paths });
    if (classification.surfaces.includes('finance')) {
      instructions.finance.push({ action: 'review_finance_record', fields: paths });
      const financeHandler = policy?.financeHandlerRef ?? null;
      if (financeHandler) {
        intents.push({ kind: 'update_finance_status', key: derivedKey([view.id, change.subject ?? null, 'finance']), payload: { activityId: view.id, fields: paths, audience: financeHandler }, dispatchBlockers: [] });
      } else {
        notices.push({ code: 'finance_handler_not_configured', message: 'No finance handler is configured to receive the financial status update' });
      }
      if (classification.funding) {
        instructions.finance.push({
          action: 'request_funding',
          amountMinor: integer(classification.funding.requestedMinor, 'requestedMinor'),
          currency: text(change.approvedCurrency ?? classification.funding.currency, 'approvedCurrency'),
        });
        instructions.finance.push({
          action: 'set_approved_ceiling',
          amountMinor: integer(change.approvedCeilingMinor, 'approvedCeilingMinor'),
          currency: text(change.approvedCurrency ?? classification.funding.currency, 'approvedCurrency'),
          allocationReference: text(change.allocationReference, 'allocationReference'),
        });
      }
    }
    if (classification.surfaces.includes('participants')) {
      intents.push(participantIntent({
        policy, activityId: view.id, subject: change.subject ?? null, notices,
        payload: { activityId: view.id, fields: clone(change.fields), reason: change.reason ?? null },
      }));
    }
    if (governanceApproved && classification.requiresGovernance) {
      instructions.activity.push({ action: 'resume', to: view.state, reason: 'governance_approved' });
    }
  }
  return {
    activityId: view.id,
    at,
    subject: change.subject ?? null,
    classification,
    pauses,
    blockers,
    notices,
    applicable,
    confirmationRequired,
    confirmationSatisfied,
    instructions,
    intents,
    applyFields: applicable ? clone(change.fields) : null,
  };
}

/**
 * Plan cancellation (R20, US10). Reminders stop, registration closes, and money already paid or
 * incurred stays an obligation: only the unused part of a reservation is releasable.
 */
export function planCancellation({ activity, reason, now, policy = null, incurredMinor = null, currency = null }: any) {
  const view = normalizeActivityView(activity);
  const at = timestamp(now, 'now');
  const why = text(reason, 'reason');
  const notices = [];
  const intents = [];
  const instructions = { activity: [{ action: 'transition', to: 'canceled', reason: why }], reminders: [], registration: [], finance: [], grants: [] };
  if (view.state === 'canceled') throw new ChangeError('already_canceled', 'this activity is already canceled');
  if (view.state === 'archived') throw new ChangeError('invalid_transition', 'an archived activity cannot be canceled');
  if (view.scheduledReminderIds.length) {
    instructions.reminders.push({ action: 'cancel', reminderIds: [...view.scheduledReminderIds], reason: why });
  }
  if (view.registration.state === 'open' || view.registration.state === 'paused') {
    instructions.registration.push({ action: 'close', reason: why });
    intents.push({ kind: 'close_registration', key: derivedKey([view.id, 'cancel', 'close_registration']), payload: { activityId: view.id, reason: why }, dispatchBlockers: [] });
  }
  const finance = view.finance
    ? {
        status: 'reconciled',
        currency: view.finance.currency ?? currency ?? null,
        requestedMinor: view.finance.requestedMinor,
        approvedCeilingMinor: view.finance.approvedCeilingMinor,
        reservedMinor: view.finance.reservedMinor,
        paidMinor: view.finance.paidMinor,
        actualMinor: view.finance.actualMinor ?? null,
        incurredMinor: incurredMinor === null ? null : integer(incurredMinor, 'incurredMinor'),
        releasableMinor: Math.max(0, view.finance.reservedMinor - view.finance.paidMinor),
        paidFundsAreReleasable: false,
      }
    : {
        status: 'unverifiable',
        currency: currency ?? null,
        requestedMinor: null,
        approvedCeilingMinor: null,
        reservedMinor: null,
        paidMinor: null,
        actualMinor: null,
        incurredMinor: incurredMinor === null ? null : integer(incurredMinor, 'incurredMinor'),
        releasableMinor: null,
        paidFundsAreReleasable: false,
      };
  const settlementRequired = finance.status === 'unverifiable'
    || (finance.paidMinor ?? 0) > 0
    || (finance.actualMinor ?? 0) > 0
    || (finance.incurredMinor ?? 0) > 0;
  if (finance.status === 'unverifiable') {
    notices.push({ code: 'finance_view_unavailable', message: 'No finance view was supplied, so no amount can be released or settled without manual review' });
  }
  if (settlementRequired) {
    instructions.finance.push({ action: 'settle_incurred_costs', paidMinor: finance.paidMinor, actualMinor: finance.actualMinor, incurredMinor: finance.incurredMinor });
    const handler = policy?.financeHandlerRef ?? null;
    if (handler) {
      intents.push({ kind: 'update_finance_status', key: derivedKey([view.id, 'cancel', 'finance']), payload: { activityId: view.id, reason: why, paidMinor: finance.paidMinor, incurredMinor: finance.incurredMinor, audience: handler }, dispatchBlockers: [] });
    } else {
      notices.push({ code: 'finance_handler_not_configured', message: 'Cancellation keeps a settlement obligation but no finance handler is configured to receive it' });
    }
  }
  intents.push(participantIntent({
    policy, activityId: view.id, subject: 'cancel', notices,
    payload: { activityId: view.id, reason: why, cancellation: true },
  }));
  return {
    activityId: view.id,
    at,
    reason: why,
    finance,
    outcomeRequired: settlementRequired,
    instructions,
    intents,
    notices,
    blockers: [],
    applyFields: null,
  };
}

/**
 * Plan a lead handover (R20, US09). The replacement must currently be a Contributor; nobody is
 * transferred silently, and while the handover waits the activity pauses and its reminders stop
 * chasing the departing lead.
 */
export function planHandover({ activity, toMemberId, reason, now, policy = null, isActiveContributor = () => false }: any) {
  const view = normalizeActivityView(activity);
  const at = timestamp(now, 'now');
  const target = text(toMemberId, 'toMemberId');
  const why = text(reason, 'reason');
  const blockers = [];
  const notices = [];
  if (isActiveContributor(target, at) !== true) {
    blockers.push({ code: 'handover_target_not_contributor', message: `${target} does not currently hold Contributor status` });
  }
  const instructions = {
    activity: [{ action: 'pause', reason: 'lead_handover_pending' }],
    reminders: view.scheduledReminderIds.length ? [{ action: 'cancel', reminderIds: [...view.scheduledReminderIds], reason: 'lead_handover_pending' }] : [],
    registration: [],
    finance: [],
    grants: [],
  };
  const intents = [];
  const handler = policy?.handlerRef ?? null;
  if (handler) {
    intents.push({ kind: 'notify_handler', key: derivedKey([view.id, 'handover', target, 'notify']), payload: { activityId: view.id, toMemberId: target, reason: why, audience: handler }, dispatchBlockers: [] });
  } else {
    notices.push({ code: 'handover_handler_not_configured', message: 'No designated handler is configured to receive the pending handover' });
  }
  return { activityId: view.id, at, toMemberId: target, previousLeadId: view.leadId, reason: why, instructions, intents, notices, blockers };
}

/** Plan the effects of an accepted handover: permissions and future reminders follow the lead. */
export function planHandoverAcceptance({ activity, handover, now, policy = null }: any) {
  const view = normalizeActivityView(activity);
  const at = timestamp(now, 'now');
  const instructions = {
    activity: [
      { action: 'set_lead', leadId: handover.toMemberId, previousLeadId: handover.previousLeadId },
      { action: 'update_fields', fields: { leadId: handover.toMemberId } },
      { action: 'resume', reason: 'handover_accepted' },
    ],
    reminders: view.scheduledReminderIds.length
      ? [{ action: 'reassign', reminderIds: [...view.scheduledReminderIds], fromMemberId: handover.previousLeadId, toMemberId: handover.toMemberId, reason: 'lead_handover' }]
      : [],
    registration: [{ action: 'update_contact', contactMemberId: handover.toMemberId }],
    finance: [],
    grants: [
      { action: 'revoke', memberId: handover.previousLeadId, scope: 'activity', activityId: view.id },
      { action: 'grant', memberId: handover.toMemberId, scope: 'activity', activityId: view.id },
    ],
  };
  const notices = [];
  const intents = [
    { kind: 'update_standing_summary', key: derivedKey([view.id, 'handover', handover.toMemberId, 'summary']), payload: { activityId: view.id, leadId: handover.toMemberId }, dispatchBlockers: [] },
    { kind: 'update_registration_page', key: derivedKey([view.id, 'handover', handover.toMemberId, 'registration']), payload: { activityId: view.id, contactMemberId: handover.toMemberId }, dispatchBlockers: [] },
    { kind: 'update_lead_contact', key: derivedKey([view.id, 'handover', handover.toMemberId, 'lead_contact']), payload: { activityId: view.id, leadId: handover.toMemberId }, dispatchBlockers: [] },
    { kind: 'post_announcement', key: derivedKey([view.id, 'handover', handover.toMemberId, 'announcement']), payload: { activityId: view.id, leadId: handover.toMemberId }, dispatchBlockers: [] },
    participantIntent({ policy, activityId: view.id, subject: `handover:${handover.toMemberId}`, notices, payload: { activityId: view.id, leadId: handover.toMemberId } }),
  ];
  return { activityId: view.id, at, instructions, intents, notices, blockers: [] };
}

/** Explicit actor/capability/resource authorizer. A grant without `activityId` covers every activity. */
export function createChangeAuthorizer(grants: { actorId: string; capability: string; activityId?: string }[] = []) {
  const list = grants.map(grant => ({ ...grant }));
  return ({ actor, capability, activityId }: any) => {
    const match = list.find(grant =>
      grant.actorId === actor?.id && grant.capability === capability &&
      (grant.activityId === undefined || grant.activityId === activityId));
    return match ? { allowed: true, reason: 'granted' } : { allowed: false, reason: 'no_grant' };
  };
}

/**
 * Persistence port for the shared local ledger, compatible with the activity module's
 * `createLedgerStore`. Every save states the sequence it was derived from; a state that another
 * writer already advanced past is refused instead of silently overwriting the newer records.
 */
export function createChangeStore(ledger: { snapshot: () => any; transact: (input: any) => any }, options: { key?: string; actor?: string; slot?: string } = {}) {
  const slot = options.slot ?? 'reinChanges';
  return {
    load() { return ledger.snapshot()?.records?.[slot] ?? null; },
    save(state: any) {
      const fingerprint = createHash('sha256').update(JSON.stringify(state)).digest('hex');
      ledger.transact({
        key: `${options.key ?? 'rein-changes'}:${state.sequence}:${fingerprint}`,
        actor: options.actor ?? 'change-core',
        action: 'persist',
        at: state.audit.at(-1)?.at ?? new Date().toISOString(),
        apply(records: any) {
          const previousSequence = records[slot]?.sequence ?? 0;
          if (previousSequence !== state.sequence - 1) {
            throw new ChangeError('storage_conflict', 'change state changed in another process; reload before retrying', {
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

export function createChangeService(options: {
  now?: () => string | Date;
  authorize?: (request: { actor: any; capability: string; activityId?: string }) => { allowed: boolean; reason?: string };
  verifyContributor?: (memberId: string, at: string) => boolean;
  getActivity?: (activityId: string) => any;
  policy?: any;
  store?: { load: () => any; save: (state: any) => void };
} = {}) {
  const now = () => {
    const value = options.now ? options.now() : new Date();
    return value instanceof Date ? value.toISOString() : timestamp(value, 'now');
  };
  const authorize = options.authorize ?? (() => ({ allowed: false, reason: 'no_authorizer_configured' }));
  const verifyContributor = options.verifyContributor ?? (() => false);
  const getActivity = options.getActivity;
  const policy = options.policy ?? null;
  const store = options.store;

  const emptyState = () => ({ sequence: 0, idCounters: {}, changes: {}, handovers: {}, cancellations: {}, intents: {}, intentKeys: {}, receipts: {}, audit: [] });
  let state = (store?.load && store.load()) ?? emptyState();

  function requireCapability(actor: any, capability: string, activityId?: string) {
    if (!actor || typeof actor.id !== 'string' || !actor.id.trim()) {
      throw new ChangeError('unauthorized', 'an actor with an id is required', { capability });
    }
    const decision = authorize({ actor, capability, activityId });
    if (!decision?.allowed) {
      throw new ChangeError('unauthorized', `actor ${actor.id} lacks ${capability}`, { capability, reason: decision?.reason ?? 'denied' });
    }
    return actor;
  }

  function readView(activityId: unknown) {
    if (!getActivity) throw new ChangeError('activity_source_unavailable', 'no activity source is configured; this core does not own activity records');
    const id = text(activityId, 'activityId');
    const value = getActivity(id);
    if (!value) throw new ChangeError('not_found', `activity ${id} does not exist`);
    return normalizeActivityView(value);
  }

  function commit(action: string, actor: any, activityId: string | null, mutate: (draft: any) => any, receiptKey: unknown = null) {
    const draft = clone(state);
    const result = mutate(draft);
    draft.sequence += 1;
    draft.audit.push({ seq: draft.sequence, at: now(), actorId: actor.id, action, activityId });
    if (receiptKey !== null && receiptKey !== undefined) {
      draft.receipts[text(receiptKey, 'idempotencyKey')] = { action, result: clone(result) };
    }
    store?.save(draft);
    state = draft;
    return result;
  }

  function nextId(draft: any, prefix: string) {
    draft.idCounters[prefix] = (draft.idCounters[prefix] ?? 0) + 1;
    return `${prefix}-${draft.idCounters[prefix]}`;
  }

  function idempotent(key: unknown, action: string, compute: () => any) {
    const value = text(key, 'idempotencyKey');
    const existing = state.receipts[value];
    if (existing) {
      if (existing.action !== action) throw new ChangeError('idempotency_key_reused', `idempotency key ${value} was already used for ${existing.action}`, { key: value });
      return { ...clone(existing.result), replayed: true };
    }
    return { ...compute(), replayed: false };
  }

  function recordIntents(draft: any, actor: any, activityId: string, intents: any[], at: string) {
    const created = [];
    for (const intent of intents) {
      const existingId = draft.intentKeys[intent.key];
      if (existingId) { created.push({ ...clone(draft.intents[existingId]), deduplicated: true }); continue; }
      const id = nextId(draft, 'intent');
      const record = {
        id, key: intent.key, kind: intent.kind, activityId,
        payload: clone(intent.payload ?? null),
        dispatchBlockers: [...(intent.dispatchBlockers ?? [])],
        state: 'pending', delivery: EXTERNAL_DELIVERY,
        attempts: 0, receipt: null, requestedBy: actor.id, createdAt: at, updatedAt: at,
      };
      draft.intents[id] = record;
      draft.intentKeys[intent.key] = id;
      created.push({ ...clone(record), deduplicated: false });
    }
    return created;
  }

  function plannedState(plan: any) {
    if (plan.applicable) return 'applied';
    if (plan.blockers.some((blocker: any) => blocker.code === 'governance_required')) return 'awaiting_governance';
    return 'awaiting_lead_confirmation';
  }

  function settleHandover(handover: any, actor: any, outcome: string, note: string, idempotencyKey: unknown) {
    const at = now();
    const view = readView(handover.activityId);
    const notices = [];
    const intents = [];
    const registrationPaused = view.registration.state === 'open';
    if (registrationPaused) {
      intents.push({ kind: 'pause_registration', key: derivedKey([view.id, 'handover', handover.id, 'pause_registration']), payload: { activityId: view.id, reason: `handover_${outcome}` }, dispatchBlockers: [] });
    }
    const handler = policy?.handlerRef ?? null;
    if (handler) intents.push({ kind: 'notify_handler', key: derivedKey([view.id, 'handover', handover.id, outcome]), payload: { activityId: view.id, outcome, note, audience: handler }, dispatchBlockers: [] });
    else notices.push({ code: 'handover_handler_not_configured', message: 'No designated handler is configured to receive the unaccepted handover' });
    const action = `change.handover.${outcome}`;
    return commit(action, actor, view.id, draft => {
      const record = draft.handovers[handover.id];
      record.state = outcome;
      record[outcome === 'declined' ? 'decline' : 'expiry'] = { by: actor.id, note, at };
      record.updatedAt = at;
      record.history.push({ to: outcome, at, actorId: actor.id, note });
      const created = recordIntents(draft, actor, view.id, intents, at);
      return {
        handover: clone(record),
        intents: created,
        instructions: {
          activity: [{ action: 'pause', reason: `handover_${outcome}` }],
          reminders: [],
          registration: registrationPaused ? [{ action: 'pause', reason: `handover_${outcome}` }] : [],
          finance: [], grants: [],
        },
        blockers: [],
        notices,
      };
    }, idempotencyKey);
  }

  return {
    authorize(request: { actor: any; capability: string; activityId?: string }) {
      if (!request?.actor?.id) throw new ChangeError('unauthorized', 'an actor with an id is required');
      const decision = authorize(request);
      return { allowed: Boolean(decision?.allowed), reason: decision?.reason ?? 'denied' };
    },

    // ------------------------------------------------------ requests, confirmation, governance
    requestChange({ actor, activityId, fields, reason = null, previous = null, confirmation = null, idempotencyKey }: any) {
      requireCapability(actor, 'change.request', activityId);
      return idempotent(idempotencyKey, 'change.request', () => {
        const view = readView(activityId);
        const at = now();
        const subject = derivedKey([view.id, fields, reason]);
        const plan = planChange({
          activity: view, change: { fields, previous, reason, subject }, now: at,
          requesterMemberId: memberIdOf(actor), confirmation, policy, isActiveContributor: verifyContributor,
        });
        return commit('change.request', actor, view.id, draft => {
          const id = nextId(draft, 'change');
          const record = {
            id, activityId: view.id, kind: 'change', state: plannedState(plan),
            subject, fields: clone(fields), reason, plan,
            requesterId: actor.id, requesterMemberId: memberIdOf(actor),
            confirmation: plan.confirmationSatisfied ? { by: actor.id, memberId: memberIdOf(actor), statement: confirmation?.statement ?? null, at } : null,
            governance: null, history: [{ to: 'requested', at, actorId: actor.id }],
            createdAt: at, updatedAt: at,
          };
          draft.changes[id] = record;
          const intents = plan.applicable ? recordIntents(draft, actor, view.id, plan.intents, at) : [];
          return { change: clone(record), intents, instructions: plan.instructions, pauses: plan.pauses, blockers: plan.blockers, notices: plan.notices };
        }, idempotencyKey);
      });
    },
    confirmChange({ actor, changeId, statement, idempotencyKey }: any) {
      const change = state.changes[text(changeId, 'changeId')];
      if (!change) throw new ChangeError('not_found', `change ${changeId} does not exist`);
      requireCapability(actor, 'change.confirm', change.activityId);
      return idempotent(idempotencyKey, 'change.confirm', () => {
        const at = now();
        const view = readView(change.activityId);
        if (change.state !== 'awaiting_lead_confirmation') {
          return commit('change.confirm', actor, view.id, () => ({
            change: clone(change), intents: [], instructions: change.plan.instructions, pauses: [],
            blockers: [], notices: [{ code: 'already_confirmed', message: `change is already ${change.state}` }],
          }), idempotencyKey);
        }
        if (memberIdOf(actor) !== view.leadId) throw new ChangeError('not_activity_lead', 'only the current activity lead can confirm this change');
        const plan = planChange({
          activity: view, change: { fields: change.fields, reason: change.reason, subject: change.subject }, now: at,
          requesterMemberId: memberIdOf(actor), confirmation: { statement }, policy, isActiveContributor: verifyContributor,
        });
        const hard = plan.blockers.filter((blocker: any) => blocker.code !== 'governance_required');
        if (hard.length) throw new ChangeError('confirmation_rejected', 'the change cannot be confirmed yet', { blockers: hard });
        return commit('change.confirm', actor, view.id, draft => {
          const record = draft.changes[change.id];
          record.state = plannedState(plan);
          record.confirmation = { by: actor.id, memberId: memberIdOf(actor), statement: text(statement, 'statement'), at };
          record.plan = clone(plan);
          record.updatedAt = at;
          record.history.push({ to: record.state, at, actorId: actor.id });
          const intents = plan.applicable ? recordIntents(draft, actor, view.id, plan.intents, at) : [];
          return { change: clone(record), intents, instructions: plan.instructions, pauses: plan.pauses, blockers: plan.blockers, notices: plan.notices };
        }, idempotencyKey);
      });
    },
    recordGovernanceDecision({ actor, changeId, decision, reference, approvedCeilingMinor = null, approvedCurrency = null, allocationReference = null, idempotencyKey }: any) {
      const change = state.changes[text(changeId, 'changeId')];
      if (!change) throw new ChangeError('not_found', `change ${changeId} does not exist`);
      requireCapability(actor, 'change.record_governance_decision', change.activityId);
      return idempotent(idempotencyKey, 'change.governance', () => {
        if (change.state !== 'awaiting_governance') {
          throw new ChangeError('invalid_transition', `change ${change.state} has no pending governance decision`, { state: change.state });
        }
        const at = now();
        const view = readView(change.activityId);
        const outcome = text(decision, 'decision');
        if (!['approved', 'rejected'].includes(outcome)) throw new ChangeError('validation', 'decision must be approved or rejected');
        const basis = text(reference, 'reference');
        if (outcome === 'rejected') {
          return commit('change.governance', actor, view.id, draft => {
            const record = draft.changes[change.id];
            record.state = 'rejected';
            record.governance = { decision: outcome, reference: basis, at, actorId: actor.id };
            record.updatedAt = at;
            record.history.push({ to: 'rejected', at, actorId: actor.id, reference: basis });
            return { change: clone(record), intents: [], instructions: record.plan.instructions, blockers: [], notices: [{ code: 'change_rejected', message: 'The change was not applied; the existing confirmed plan stands' }] };
          }, idempotencyKey);
        }
        const funding = change.plan.classification.funding;
        if (funding && approvedCeilingMinor === null) throw new ChangeError('approved_ceiling_required', 'approving additional funding requires the approved ceiling that goes with the decision');
        if (funding && !allocationReference) throw new ChangeError('allocation_reference_required', 'an approval that commits funds needs its allocation reference');
        const plan = planChange({
          activity: view,
          change: {
            fields: change.fields, reason: change.reason, subject: change.subject,
            approvedCeilingMinor, approvedCurrency: approvedCurrency ?? funding?.currency ?? null, allocationReference,
          },
          now: at,
          requesterMemberId: change.requesterMemberId,
          confirmation: change.confirmation ? { statement: change.confirmation.statement } : null,
          policy, governanceApproved: true, isActiveContributor: verifyContributor,
        });
        if (plan.blockers.length) throw new ChangeError('governance_decision_blocked', 'the approved change still has unresolved blockers', { blockers: plan.blockers });
        return commit('change.governance', actor, view.id, draft => {
          const record = draft.changes[change.id];
          record.state = 'applied';
          record.governance = { decision: outcome, reference: basis, approvedCeilingMinor, allocationReference, at, actorId: actor.id };
          record.plan = clone(plan);
          record.updatedAt = at;
          record.history.push({ to: 'applied', at, actorId: actor.id, reference: basis });
          const intents = recordIntents(draft, actor, view.id, plan.intents, at);
          return { change: clone(record), intents, instructions: plan.instructions, blockers: plan.blockers, notices: plan.notices };
        }, idempotencyKey);
      });
    },

    // ---------------------------------------------------------------------------------- cancellation
    cancelActivity({ actor, activityId, reason, incurredMinor = null, currency = null, idempotencyKey }: any) {
      requireCapability(actor, 'change.cancel', activityId);
      return idempotent(idempotencyKey, 'change.cancel', () => {
        const view = readView(activityId);
        if (memberIdOf(actor) !== view.leadId) requireCapability(actor, 'change.cancel_as_handler', view.id);
        const existing = state.cancellations[view.id];
        if (existing) {
          return commit('change.cancel', actor, view.id, () => ({
            change: clone(existing), intents: [], instructions: existing.plan.instructions, blockers: [],
            notices: [...existing.plan.notices, { code: 'already_canceled', message: 'this activity already has a recorded cancellation' }],
          }), idempotencyKey);
        }
        const at = now();
        const plan = planCancellation({ activity: view, reason, now: at, policy, incurredMinor, currency });
        return commit('change.cancel', actor, view.id, draft => {
          const id = nextId(draft, 'change');
          const record = {
            id, activityId: view.id, kind: 'cancellation', state: 'applied', reason: plan.reason,
            outcomeRequired: plan.outcomeRequired, finance: plan.finance, plan,
            requesterId: actor.id, confirmation: null, governance: null,
            history: [{ to: 'canceled', at, actorId: actor.id, reason: plan.reason }],
            createdAt: at, updatedAt: at,
          };
          draft.changes[id] = record;
          draft.cancellations[view.id] = record;
          const intents = recordIntents(draft, actor, view.id, plan.intents, at);
          return { change: clone(record), intents, instructions: plan.instructions, blockers: plan.blockers, notices: plan.notices };
        }, idempotencyKey);
      });
    },

    // ------------------------------------------------------------------------------------- handover
    requestHandover({ actor, activityId, toMemberId, reason, idempotencyKey }: any) {
      requireCapability(actor, 'change.handover', activityId);
      return idempotent(idempotencyKey, 'change.handover.request', () => {
        const view = readView(activityId);
        if (memberIdOf(actor) !== view.leadId) requireCapability(actor, 'change.handover_as_handler', view.id);
        const pending: any = Object.values(state.handovers).find((item: any) => item.activityId === view.id && item.state === 'awaiting_acceptance');
        if (pending) throw new ChangeError('handover_already_pending', 'this activity already has a handover awaiting acceptance', { handoverId: pending.id });
        const at = now();
        const plan = planHandover({ activity: view, toMemberId, reason, now: at, policy, isActiveContributor: verifyContributor });
        if (plan.blockers.length) throw new ChangeError('handover_rejected', 'the handover cannot be requested yet', { blockers: plan.blockers });
        return commit('change.handover.request', actor, view.id, draft => {
          const id = nextId(draft, 'handover');
          const record = {
            id, activityId: view.id, state: 'awaiting_acceptance', toMemberId: plan.toMemberId,
            previousLeadId: plan.previousLeadId, reason: plan.reason, plan,
            requestedBy: actor.id, history: [{ to: 'awaiting_acceptance', at, actorId: actor.id }],
            createdAt: at, updatedAt: at, acceptance: null, decline: null, expiry: null,
          };
          draft.handovers[id] = record;
          const intents = recordIntents(draft, actor, view.id, plan.intents, at);
          return { handover: clone(record), intents, instructions: plan.instructions, blockers: plan.blockers, notices: plan.notices };
        }, idempotencyKey);
      });
    },
    acceptHandover({ actor, handoverId, statement, idempotencyKey }: any) {
      const handover = state.handovers[text(handoverId, 'handoverId')];
      if (!handover) throw new ChangeError('not_found', `handover ${handoverId} does not exist`);
      requireCapability(actor, 'change.accept_handover', handover.activityId);
      return idempotent(idempotencyKey, 'change.handover.accept', () => {
        if (handover.state !== 'awaiting_acceptance') {
          throw new ChangeError('invalid_transition', `handover ${handover.state} cannot be accepted`, { state: handover.state });
        }
        if (memberIdOf(actor) !== handover.toMemberId) throw new ChangeError('not_handover_target', 'only the named replacement can accept this handover');
        const at = now();
        const accepted = text(statement, 'statement');
        if (verifyContributor(handover.toMemberId, at) !== true) {
          throw new ChangeError('handover_target_not_contributor', `${handover.toMemberId} does not currently hold Contributor status`);
        }
        const view = readView(handover.activityId);
        if (view.leadId !== handover.previousLeadId) {
          throw new ChangeError('lead_changed', 'the activity lead changed while this handover was pending', { leadId: view.leadId });
        }
        const plan = planHandoverAcceptance({ activity: view, handover, now: at, policy });
        return commit('change.handover.accept', actor, view.id, draft => {
          const record = draft.handovers[handover.id];
          record.state = 'accepted';
          record.acceptance = { by: actor.id, memberId: handover.toMemberId, statement: accepted, at };
          record.updatedAt = at;
          record.history.push({ to: 'accepted', at, actorId: actor.id });
          record.plan = clone(plan);
          const intents = recordIntents(draft, actor, view.id, plan.intents, at);
          return { handover: clone(record), intents, instructions: plan.instructions, blockers: [], notices: plan.notices };
        }, idempotencyKey);
      });
    },
    declineHandover({ actor, handoverId, note, idempotencyKey }: any) {
      const handover = state.handovers[text(handoverId, 'handoverId')];
      if (!handover) throw new ChangeError('not_found', `handover ${handoverId} does not exist`);
      requireCapability(actor, 'change.accept_handover', handover.activityId);
      return idempotent(idempotencyKey, 'change.handover.declined', () => {
        if (handover.state !== 'awaiting_acceptance') {
          throw new ChangeError('invalid_transition', `handover ${handover.state} cannot be declined`, { state: handover.state });
        }
        if (memberIdOf(actor) !== handover.toMemberId) requireCapability(actor, 'change.handover_as_handler', handover.activityId);
        return settleHandover(handover, actor, 'declined', text(note, 'note'), idempotencyKey);
      });
    },
    expireHandover({ actor, handoverId, reason, idempotencyKey }: any) {
      const handover = state.handovers[text(handoverId, 'handoverId')];
      if (!handover) throw new ChangeError('not_found', `handover ${handoverId} does not exist`);
      requireCapability(actor, 'change.handover_as_handler', handover.activityId);
      return idempotent(idempotencyKey, 'change.handover.expired', () => {
        if (handover.state !== 'awaiting_acceptance') {
          throw new ChangeError('invalid_transition', `handover ${handover.state} cannot expire`, { state: handover.state });
        }
        return settleHandover(handover, actor, 'expired', text(reason, 'reason'), idempotencyKey);
      });
    },

    // -------------------------------------------------------------------------------------- intents
    recordIntentReceipt({ actor, intentId, receipt }: any) {
      const intent = state.intents[text(intentId, 'intentId')];
      if (!intent) throw new ChangeError('not_found', `intent ${intentId} does not exist`);
      requireCapability(actor, 'change.record_delivery', intent.activityId);
      return commit('change.intent.receipt', actor, intent.activityId, draft => {
        const record = draft.intents[intentId];
        if (record.state === 'delivered') return { ...clone(record), recorded: false };
        if (record.dispatchBlockers.length) {
          throw new ChangeError('intent_not_dispatchable', 'this intent cannot be delivered until its configuration blockers are cleared', { dispatchBlockers: record.dispatchBlockers });
        }
        const reference = text(receipt?.reference, 'receipt.reference');
        const at = now();
        record.state = 'delivered';
        record.receipt = { ...clone(receipt), reference, recordedBy: actor.id, at };
        record.attempts += 1;
        record.updatedAt = at;
        return { ...clone(record), recorded: true };
      });
    },
    listIntents({ actor, activityId }: any = {}) {
      requireCapability(actor, 'change.read', activityId);
      return Object.values(state.intents)
        .filter((intent: any) => !activityId || intent.activityId === activityId)
        .map(intent => clone(intent));
    },
    listChanges({ actor, activityId }: any = {}) {
      requireCapability(actor, 'change.read', activityId);
      return Object.values(state.changes)
        .filter((change: any) => !activityId || change.activityId === activityId)
        .map(change => clone(change));
    },
    getChange({ actor, changeId }: any) {
      const change = state.changes[text(changeId, 'changeId')];
      if (!change) throw new ChangeError('not_found', `change ${changeId} does not exist`);
      requireCapability(actor, 'change.read', change.activityId);
      return clone(change);
    },
    getHandover({ actor, handoverId }: any) {
      const handover = state.handovers[text(handoverId, 'handoverId')];
      if (!handover) throw new ChangeError('not_found', `handover ${handoverId} does not exist`);
      requireCapability(actor, 'change.read', handover.activityId);
      return clone(handover);
    },
    snapshot() { return clone(state); },
  };
}
