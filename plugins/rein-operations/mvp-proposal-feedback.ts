/**
 * Post-vote proposal feedback core (PRD C15 / decision D10, revision rules R05).
 *
 * After a win, comments continue. The Agent may accept a minor revision (wording, notes, expected
 * scale) on its own, and it becomes the effective version. A material revision — budget, location,
 * personnel composition, major event flow, or a date/time commitment — is refused unless the turn
 * carries an approval from a member of the snapshot's verified Board roster naming that revision.
 * Only that typed, roster-checked approval counts, so no prompt, role label or boolean flag grants
 * Board authority. Pure: no I/O, timers, generated ids or tool registration, and no money movement.
 */

export class MvpProposalFeedbackError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MvpProposalFeedbackError';
    this.code = code;
  }
}

const fail = (code: string, message: string): never => {
  throw new MvpProposalFeedbackError(code, message);
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** An unknown property is a caller bug: a flag this core never reads must not look effective. */
function allowKeys(raw: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) fail('invalid_input', `${path} has an unknown property: ${key}`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export type ProposalFormat = 'online' | 'in_person' | 'hybrid';
export type MaterialCategory = 'budget' | 'location' | 'personnel' | 'event_flow' | 'schedule';
export type RevisionClassification = 'minor' | 'material' | 'no_change';
export type VersionSource = 'vote' | 'minor_revision' | 'board_approved_revision';
export type AuditAction = 'comment_recorded' | 'minor_revision_effective'
  | 'material_revision_effective' | 'material_revision_blocked' | 'revision_refused';

/** Every field of one version. A revision patch replaces the fields it names. */
export interface ProposalFields {
  title: string; summary: string; agenda: string;
  format: ProposalFormat; venue: string | null;
  startAt: string; durationMinutes: number; timeZone: string;
  leadMemberId: string; personnelIds: readonly string[]; runOfShow: readonly string[];
  expectedAttendance: number; requestedAmountMinor: number; currency: string;
}

/** Wording and expected scale: the Agent may accept these without Board approval (R05). */
export const MINOR_FIELDS = Object.freeze(['title', 'summary', 'agenda', 'expectedAttendance'] as const);

/** C15 budget, location, personnel and major event flow, plus the R05 date and time commitment. */
export const MATERIAL_FIELDS = Object.freeze([
  'requestedAmountMinor', 'currency', 'format', 'venue', 'startAt', 'durationMinutes', 'timeZone',
  'leadMemberId', 'personnelIds', 'runOfShow',
] as const);

/** The C15 rule each material field enforces, for refusal messages in the tool layer. */
export const MATERIAL_FIELD_CATEGORIES: Readonly<Record<string, MaterialCategory>> = Object.freeze({
  requestedAmountMinor: 'budget', currency: 'budget', format: 'location', venue: 'location',
  startAt: 'schedule', durationMinutes: 'schedule', timeZone: 'schedule',
  leadMemberId: 'personnel', personnelIds: 'personnel', runOfShow: 'event_flow',
});

/** Canonical field order; every list in a result follows it, so a run is reproducible. */
export const FIELD_ORDER = Object.freeze([...MINOR_FIELDS, ...MATERIAL_FIELDS] as const);

export interface ProposalVersion {
  version: number; fields: ProposalFields; at: string; source: VersionSource;
  /** Material fields this version changed; empty for the vote and for a minor revision. */
  changedFields: readonly string[];
  /** Verified Board member ids counted for this version, sorted. */
  approvedBy: readonly string[];
}

export interface FeedbackAuditEntry {
  at: string; action: AuditAction; actorMemberId: string | null;
  detail: Readonly<Record<string, string | number | readonly string[] | null>>;
}

/** What one decision reads: the effective version, its history, the roster and the audit trail. */
export interface FeedbackSnapshot {
  proposalId: string;
  decision: { outcome: 'approved' | 'no_winner'; decidedAt: string };
  /** Oldest first; the last record is the effective version. */
  versions: readonly ProposalVersion[];
  /** Current verified Board roster; the only source of Board approval authority. */
  verifiedBoardMemberIds: readonly string[];
  audit: readonly FeedbackAuditEntry[];
}

export interface FeedbackRequest {
  /** Comments may continue after the win; they never change the effective version. */
  comments?: readonly { commentId: string; authorMemberId: string; at: string; body: string }[];
  revision?: {
    revisionId: string; at: string;
    /** Must be the effective version's lead or a member of the verified Board roster. */
    actorMemberId: string;
    fields: Partial<ProposalFields>;
    approvals?: readonly { memberId: string; revisionId: string }[];
  } | null;
}

export interface FeedbackDecision {
  status: string; accepted: boolean;
  classification: RevisionClassification; materialFields: readonly string[];
  boardApprovalRequired: boolean; approvedByMemberIds: readonly string[];
  /** Comments recorded this turn, after the decision only. */
  recordedComments: readonly { commentId: string; authorMemberId: string; at: string; body: string }[];
  /** Refused approvals and comments this turn, as `id:reason`. */
  rejectedApprovals: readonly string[]; rejectedComments: readonly string[];
  reasons: readonly string[]; effectiveVersion: number;
  /** Full version history and audit trail with this turn's entries appended. */
  versions: readonly ProposalVersion[]; audit: readonly FeedbackAuditEntry[];
  /** A budget revision is a record change only: this core never reserves or moves money (D05). */
  reservesFunds: false; movesMoney: false;
}

const NUMBER_FIELDS = new Set(['durationMinutes', 'expectedAttendance', 'requestedAmountMinor']);
const LIST_FIELDS = new Set(['personnelIds', 'runOfShow']);
const SOURCES = ['vote', 'minor_revision', 'board_approved_revision'];
const MATERIAL_SET: ReadonlySet<string> = new Set(MATERIAL_FIELDS);

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.length) fail('invalid_input', `${path} must be a non-empty string`);
  return value;
}

function instant(value: unknown, path: string): string {
  const at = text(value, path);
  if (!Number.isFinite(Date.parse(at))) fail('invalid_input', `${path} must be an ISO timestamp`);
  return at;
}

/** Known fields with plausible values; a wrong JavaScript type is a caller bug and throws. */
function assertPatch(raw: unknown): Partial<ProposalFields> {
  if (!isObject(raw)) fail('invalid_input', 'revision.fields must be an object');
  for (const [key, value] of Object.entries(raw)) {
    if (!FIELD_ORDER.includes(key as (typeof FIELD_ORDER)[number])) {
      fail('invalid_input', `revision.fields has an unknown field: ${key}`);
    }
    const ok = NUMBER_FIELDS.has(key)
      ? typeof value === 'number' && Number.isFinite(value)
      : key === 'venue'
        ? value === null || (typeof value === 'string' && value.length > 0)
        : key === 'format'
          ? ['online', 'in_person', 'hybrid'].includes(value as string)
          : LIST_FIELDS.has(key)
            ? Array.isArray(value) && value.every(entry => typeof entry === 'string' && entry.length > 0)
            : typeof value === 'string' && value.length > 0;
    if (!ok) fail('invalid_input', `revision.fields.${key} has the wrong type`);
  }
  return raw as Partial<ProposalFields>;
}

/** Personnel lists compare as a set; every other field, including the run of show, keeps its order. */
function sameValue(key: string, a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b;
  const list = (value: readonly unknown[]) => [...(value as readonly string[])];
  const next = key === 'personnelIds' ? list(a).sort() : list(a);
  const prev = key === 'personnelIds' ? list(b).sort() : list(b);
  return next.join('\u0000') === prev.join('\u0000');
}

/**
 * Classify one revision patch against the effective version. A named field already equal to the
 * effective value is not a change; any changed material field makes the whole revision material.
 */
export function classifyRevision(previousFields: ProposalFields, patch: Partial<ProposalFields>): {
  classification: RevisionClassification; changedFields: readonly string[];
  materialFields: readonly string[]; minorFields: readonly string[];
} {
  const changed = assertPatch(patch);
  const changedFields: string[] = [];
  const materialFields: string[] = [];
  const minorFields: string[] = [];
  for (const key of FIELD_ORDER) {
    if (!(key in changed)) continue;
    if (sameValue(key, changed[key as keyof ProposalFields], previousFields[key as keyof ProposalFields])) continue;
    changedFields.push(key);
    (MATERIAL_SET.has(key) ? materialFields : minorFields).push(key);
  }
  return deepFreeze({
    classification: changedFields.length === 0 ? 'no_change' : materialFields.length > 0 ? 'material' : 'minor',
    changedFields,
    materialFields,
    minorFields,
  });
}

/** Validate the snapshot shape and the effective version; the store owns the history it hands over. */
function readSnapshot(snapshot: unknown): {
  proposalId: string; outcome: string; decidedAt: string;
  versions: ProposalVersion[]; effective: ProposalVersion; board: Set<string>;
} {
  if (!isObject(snapshot)) fail('invalid_input', 'snapshot must be an object');
  allowKeys(snapshot, ['proposalId', 'decision', 'versions', 'verifiedBoardMemberIds', 'audit'], 'snapshot');
  if (!isObject(snapshot.decision)) fail('invalid_input', 'snapshot.decision must be an object');
  const outcome = text(snapshot.decision.outcome, 'snapshot.decision.outcome');
  if (outcome !== 'approved' && outcome !== 'no_winner') {
    fail('invalid_input', 'snapshot.decision.outcome must be approved or no_winner');
  }
  if (!Array.isArray(snapshot.versions) || !snapshot.versions.length) {
    fail('invalid_input', 'snapshot.versions must be a non-empty array');
  }
  const versions = (snapshot.versions as readonly unknown[]).map((raw, index) => {
    const path = `versions[${index}]`;
    if (!isObject(raw) || !isObject(raw.fields)) fail('invalid_input', `${path} needs fields`);
    if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) {
      fail('invalid_input', `${path}.version must be a positive integer`);
    }
    if (!SOURCES.includes(raw.source as string)) fail('invalid_input', `${path}.source is unknown`);
    return {
      version: raw.version,
      fields: raw.fields as unknown as ProposalFields,
      at: instant(raw.at, `${path}.at`),
      source: raw.source as VersionSource,
      changedFields: (raw.changedFields ?? []) as readonly string[],
      approvedBy: [...((raw.approvedBy ?? []) as readonly string[])].sort(),
    };
  });
  if (!Array.isArray(snapshot.verifiedBoardMemberIds)) {
    fail('invalid_input', 'snapshot.verifiedBoardMemberIds must be an array');
  }
  const board = new Set(
    (snapshot.verifiedBoardMemberIds as readonly unknown[]).map(entry =>
      text(entry, 'snapshot.verifiedBoardMemberIds entry'),
    ),
  );
  if (!board.size) fail('invalid_input', 'snapshot.verifiedBoardMemberIds must name a Board member');
  if (!Array.isArray(snapshot.audit)) fail('invalid_input', 'snapshot.audit must be an array');
  return {
    proposalId: text(snapshot.proposalId, 'snapshot.proposalId'),
    outcome,
    decidedAt: instant(snapshot.decision.decidedAt, 'snapshot.decision.decidedAt'),
    versions,
    effective: versions[versions.length - 1],
    board,
  };
}

/**
 * Decide one post-vote feedback turn: record comments and accept or refuse one revision.
 *
 * Comments after the decision are always recorded and never change the effective version. A revision
 * is refused when it arrives before the decision, the vote did not accept the proposal, the actor is
 * neither the effective version's lead nor a current Board member, or nothing changed. A material
 * revision without a counted approval is refused and the effective version stays in place.
 *
 * A malformed snapshot or a structurally invalid request throws {@link MvpProposalFeedbackError}
 * with code `invalid_input`; a valid request always returns a readable decision.
 */
export function decidePostVoteFeedback(snapshot: FeedbackSnapshot, request: FeedbackRequest): FeedbackDecision {
  const state = readSnapshot(snapshot);
  if (!isObject(request)) fail('invalid_input', 'request must be an object');
  allowKeys(request, ['revision', 'comments'], 'request');
  const audit: FeedbackAuditEntry[] = snapshot.audit.map(entry => ({ ...entry }));
  const versions = state.versions.map(version => ({ ...version }));
  const recordedComments: { commentId: string; authorMemberId: string; at: string; body: string }[] = [];
  const rejectedComments: string[] = [];
  const seen = new Set<string>();
  for (const comment of request.comments ?? []) {
    if (!isObject(comment)) fail('invalid_input', 'each comment must be an object');
    const entry = {
      commentId: text(comment.commentId, 'comment.commentId'),
      authorMemberId: text(comment.authorMemberId, 'comment.authorMemberId'),
      at: instant(comment.at, 'comment.at'),
      body: text(comment.body, 'comment.body'),
    };
    if (Date.parse(entry.at) < Date.parse(state.decidedAt)) rejectedComments.push(`${entry.commentId}:before_decision`);
    else if (seen.has(entry.commentId)) rejectedComments.push(`${entry.commentId}:duplicate_comment`);
    else {
      seen.add(entry.commentId);
      recordedComments.push(entry);
      audit.push({ at: entry.at, action: 'comment_recorded', actorMemberId: entry.authorMemberId, detail: { commentId: entry.commentId } });
    }
  }

  const emit = (parts: Partial<FeedbackDecision> & { status: string; reasons: readonly string[] }) =>
    deepFreeze({
      status: parts.status, accepted: false, classification: 'no_change' as RevisionClassification,
      materialFields: [] as readonly string[], boardApprovalRequired: false,
      approvedByMemberIds: [] as readonly string[], rejectedApprovals: [] as readonly string[],
      recordedComments, rejectedComments, reasons: parts.reasons,
      effectiveVersion: state.effective.version,
      versions, audit, reservesFunds: false as const, movesMoney: false as const,
      ...parts,
    } as FeedbackDecision);

  if (request.revision === undefined || request.revision === null) {
    return emit({
      status: 'comments_only',
      reasons: [recordedComments.length ? 'comments_recorded_after_decision' : 'no_revision_submitted'],
    });
  }

  const revision = request.revision;
  allowKeys(revision as Record<string, unknown>, ['revisionId', 'actorMemberId', 'at', 'fields', 'approvals'], 'revision');
  const revisionId = text(revision.revisionId, 'revision.revisionId');
  const actorMemberId = text(revision.actorMemberId, 'revision.actorMemberId');
  const submittedAt = instant(revision.at, 'revision.at');
  const classification = classifyRevision(state.effective.fields, revision.fields);
  const refuse = (reason: string, action: AuditAction = 'revision_refused', extra: Partial<FeedbackDecision> = {}) => {
    audit.push({ at: submittedAt, action, actorMemberId, detail: { reason, revisionId } });
    return emit({
      status: action === 'material_revision_blocked' ? 'material_revision_blocked' : 'revision_refused',
      reasons: [reason], classification: classification.classification,
      materialFields: classification.materialFields,
      boardApprovalRequired: classification.classification === 'material',
      ...extra,
    });
  };

  if (Date.parse(submittedAt) < Date.parse(state.decidedAt)) return refuse('revision_before_decision');
  if (state.outcome !== 'approved') return refuse('proposal_not_accepted');
  if (state.effective.fields.leadMemberId !== actorMemberId && !state.board.has(actorMemberId)) {
    return refuse('actor_not_authorized_for_revision');
  }
  if (classification.classification === 'no_change') {
    return emit({ status: 'no_change', reasons: ['revision_matches_effective_version'] });
  }

  const approvedByMemberIds: string[] = [];
  const rejectedApprovals: string[] = [];
  for (const approval of revision.approvals ?? []) {
    const reason = !state.board.has(approval.memberId) ? 'not_current_board_member'
      : approval.revisionId !== revisionId ? 'approval_for_another_revision'
        : approvedByMemberIds.includes(approval.memberId) ? 'duplicate_approval'
          : null;
    if (reason === null) approvedByMemberIds.push(approval.memberId);
    else rejectedApprovals.push(`${approval.memberId}:${reason}`);
  }
  approvedByMemberIds.sort();

  const material = classification.classification === 'material';
  if (material && !approvedByMemberIds.length) {
    return refuse('material_change_requires_current_verified_board_approval', 'material_revision_blocked', { rejectedApprovals });
  }

  const next: ProposalVersion = {
    version: state.effective.version + 1,
    fields: { ...state.effective.fields, ...revision.fields },
    at: submittedAt,
    source: material ? 'board_approved_revision' : 'minor_revision',
    changedFields: classification.materialFields,
    approvedBy: approvedByMemberIds,
  };
  versions.push(next);
  const reason = material ? 'current_verified_board_approval_recorded' : 'minor_change_accepted_by_agent';
  audit.push({
    at: submittedAt,
    action: material ? 'material_revision_effective' : 'minor_revision_effective',
    actorMemberId,
    detail: { reason, revisionId, version: next.version, changedFields: classification.materialFields },
  });
  return emit({
    status: material ? 'material_revision_effective' : 'minor_revision_effective',
    reasons: [reason], accepted: true, classification: classification.classification,
    materialFields: classification.materialFields, boardApprovalRequired: material,
    approvedByMemberIds, rejectedApprovals, effectiveVersion: next.version,
  });
}
