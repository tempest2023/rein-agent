// Server-side writer for the Rein MVP governance tables: proposal intake, approval-only polls and
// ballots, as the sibling phase-2 migration
// `supabase/migrations/20260924095705_rein_mvp_proposals_polls_ballots.sql` defines them.
//
// Table contract, read-only from here:
//
//   public.<env>_rein_mvp_vote_types(vote_type, max_candidates, max_approvals_per_voter, updated_at)
//   public.<env>_rein_mvp_proposals(id, proposer_contact_id, title, summary, vote_type,
//     requested_minor, currency, location, schedule, personnel, event_flow, status, version,
//     effective_revision_id, created_at, updated_at)  -- status: submitted|selected|unselected|withdrawn
//   public.<env>_rein_mvp_polls(id, creator_contact_id, title, vote_type, candidate_proposal_ids,
//     candidate_limit, max_approvals_per_voter, status, opens_at, closes_at, created_at,
//     finalized_at, finalized_by_contact_id, winning_proposal_id)
//   public.<env>_rein_mvp_ballots(id, poll_id, voter_contact_id, approved_proposal_ids, cast_at)
//   public.<env>_rein_mvp_proposal_revisions(id, proposal_id, version, author_contact_id,
//     changed_fields, title, summary, requested_minor, currency, location, schedule, personnel,
//     event_flow, note, approved_by_contact_id, approved_at, recorded_at)
//
// The database is the authority for every governance rule: it freezes a poll's candidate limit and
// per-voter approval limit from the named vote type, refuses a candidate that does not belong to the
// poll, refuses a second or replaced ballot, and refuses writes from the Data API roles. This module
// shapes one request, records exactly one immutable row per call and collapses every failure to a
// fixed reason code.
//
// Access model: those tables enable RLS, grant nothing to `anon` or `authenticated` and are writable
// by `service_role` only, so this writer authenticates with the server-only secret key over
// PostgREST. The key is never logged, echoed, placed in a URL or returned to a caller, and a provider
// response body is never propagated.
//
// This module also reaches the two service-only deterministic RPCs the same migration defines:
// `<env>_rein_mvp_finalize_poll(p_poll_id uuid, p_actor_contact_id uuid)`, which counts the ballots,
// refuses a poll that is not past its deadline, closes it, and writes the outcome the database
// computed, and `<env>_rein_mvp_approve_revision(p_revision_id uuid, p_approver_contact_id uuid)`,
// which records one approval from a contact who is a current director. Post-vote feedback is
// append-only: a comment or suggested revision is one insert into the revisions table, and applying a
// revision is a single guarded update of the proposal row that the trigger verifies field by field.
// Those are the only RPC and update paths here, and no caller can hand the database an outcome, a
// tally, an approval or a version number: the database derives each one.
//
// What this module never does: no delete, no upsert, no payment, no reservation, no identity or
// weight escalation and no message to Slack. Recording a proposal is not a funding decision, so every
// proposal result reports `authorizesSpending: false`.

import type { FoundationEnvironment } from './foundation-db-reader.ts';

export interface FoundationDbWriterConfig {
  /** Supabase project URL, for example `https://<project-ref>.supabase.co`. */
  supabaseUrl: string;
  /** Server-only secret or legacy service_role key. Never sent to a caller. */
  serviceRoleKey: string;
  /** Selects the `<env>_` table prefix. */
  environment: FoundationEnvironment;
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

export type WriterStatus =
  | 'found'
  | 'inserted'
  | 'updated'
  | 'existing'
  | 'conflict'
  | 'rejected'
  | 'unavailable'
  | 'invalid_request';

export interface ProposalRecord {
  id: string;
  proposerContactId: string;
  title: string;
  summary: string | null;
  voteType: string;
  requestedMinor: number | null;
  currency: string | null;
  status: string;
  createdAt: string;
}

export interface PollRecord {
  id: string;
  creatorContactId: string;
  title: string;
  voteType: string;
  /** The proposal ids this poll approves among. Never empty and never repeated. */
  candidateProposalIds: readonly string[];
  /** Frozen from the vote type by the database at insert time, never by a caller. */
  candidateLimit: number;
  maxApprovalsPerVoter: number;
  status: string;
  opensAt: string;
  closesAt: string;
  createdAt: string;
}

export interface BallotRecord {
  id: string;
  pollId: string;
  voterContactId: string;
  /** Approved candidates. An empty list is the abstention. */
  approvedProposalIds: readonly string[];
  castAt: string;
}

export interface VoteTypeRecord {
  voteType: string;
  maxCandidates: number;
  maxApprovalsPerVoter: number;
  updatedAt: string;
}

export interface SubmitProposalInput {
  id: string;
  proposerContactId: string;
  title: string;
  summary?: string | null;
  voteType: string;
  requestedMinor?: number | null;
  currency?: string | null;
}

export interface CreatePollInput {
  id: string;
  creatorContactId: string;
  title: string;
  voteType?: string;
  candidateProposalIds?: readonly string[];
  opensAt: string;
  closesAt: string;
  /**
   * Deprecated pre-phase-2 field. A poll is defined by a vote type and candidate proposals, so an
   * options-only call is refused with `legacy_options_unsupported` instead of being written.
   */
  options?: readonly string[];
}

export interface CastBallotInput {
  pollId: string;
  voterContactId: string;
  /** Approved candidates. An empty list is the abstention. */
  approvedProposalIds?: readonly string[];
  /** Deprecated pre-phase-2 field: `abstain` maps to no approvals, a proposal id to one approval. */
  choice?: string;
  /** Server-side clock override for tests and rehearsal. Omitted means the database clock. */
  castAt?: string;
}

export interface ListCandidateProposalsInput {
  voteType: string;
  /** Page size, 1..200. Defaults to 50. */
  limit?: number;
  /** Proposal ids left out of the returned page, applied to the fetched page. */
  excludeProposalIds?: readonly string[];
  /** Only proposals created at or after this instant. Omitted means no lower bound. */
  submittedSince?: string;
  /**
   * Read the most recently created `unselected` proposals first and offer them before the older
   * submissions, so a proposal that lost one round is not pushed behind every stored proposal.
   */
  includeRecentlyUnselected?: boolean;
}

export interface ProposalWriteResult {
  ok: boolean;
  status: WriterStatus;
  reason: string;
  proposal: ProposalRecord | null;
  httpStatus: number | null;
  /** Always false: recording a proposal is not a funding decision. */
  authorizesSpending: false;
}

export interface PollWriteResult {
  ok: boolean;
  status: WriterStatus;
  reason: string;
  poll: PollRecord | null;
  httpStatus: number | null;
}

export interface PollReadResult {
  ok: boolean;
  status: WriterStatus;
  reason: string;
  poll: PollRecord | null;
  httpStatus: number | null;
}

export interface BallotSummary {
  pollId: string;
  voterContactId: string;
  approvedProposalIds: readonly string[];
}

export interface BallotWriteResult {
  ok: boolean;
  status: WriterStatus;
  reason: string;
  ballot: BallotSummary | null;
  httpStatus: number | null;
}

export interface BallotListResult {
  ok: boolean;
  status: WriterStatus;
  reason: string;
  ballots: readonly BallotRecord[] | null;
  httpStatus: number | null;
}

export interface VoteTypeReadResult {
  ok: boolean;
  status: WriterStatus;
  reason: string;
  voteType: VoteTypeRecord | null;
  httpStatus: number | null;
}

export interface CandidateProposalListResult {
  ok: boolean;
  status: WriterStatus;
  reason: string;
  proposals: readonly ProposalRecord[] | null;
  httpStatus: number | null;
}

/** One recorded comment or suggested revision. `version` is null until the row is applied. */
export interface ProposalRevisionRecord {
  id: string;
  proposalId: string;
  /** Null until the revision becomes effective; a comment is always null. */
  version: number | null;
  authorContactId: string;
  /** The fields the revision would move. Empty names a comment, which is never effective. */
  changedFields: readonly string[];
  title: string | null;
  summary: string | null;
  requestedMinor: number | null;
  currency: string | null;
  location: string | null;
  schedule: string | null;
  personnel: string | null;
  eventFlow: string | null;
  note: string | null;
  approvedByContactId: string | null;
  approvedAt: string | null;
  recordedAt: string;
}

export interface ProposalReadResult {
  ok: boolean;
  status: WriterStatus;
  reason: string;
  proposal: ProposalRecord | null;
  httpStatus: number | null;
}

export interface ProposalRevisionReadResult {
  ok: boolean;
  status: WriterStatus;
  reason: string;
  revision: ProposalRevisionRecord | null;
  httpStatus: number | null;
}

/** The proposal row after one revision became the effective version. */
export interface AppliedProposalVersionRecord {
  proposalId: string;
  status: string;
  /** The version this revision produced, assigned by the database. */
  version: number;
  effectiveRevisionId: string;
  title: string;
  summary: string | null;
  requestedMinor: number | null;
  currency: string | null;
  location: string | null;
  schedule: string | null;
  personnel: string | null;
  eventFlow: string | null;
}

/** One recorded approval count per candidate, from the finalize RPC's own tally evidence. */
export interface PollApprovalCount {
  proposalId: string;
  approvals: number;
}

/** The recorded outcome of one finalized poll, as the database computed and stored it. */
export interface PollFinalizationRecord {
  pollId: string;
  status: string;
  /** True when the poll was already finalized and this call returned the recorded outcome. */
  repeated: boolean;
  outcome: 'winner' | 'no_winner';
  winningProposalId: string | null;
  finalizedByContactId: string;
  candidates: readonly string[];
  proposalsRecorded: number;
  ballots: number;
  abstentions: number;
  approvals: readonly PollApprovalCount[];
}

export interface FinalizePollInput {
  pollId: string;
  /** The contact finalizing the poll. The database requires a current director. */
  actorContactId: string;
}

export interface PollFinalizationResult {
  ok: boolean;
  status: WriterStatus;
  reason: string;
  finalization: PollFinalizationRecord | null;
  httpStatus: number | null;
}

/**
 * One append-only feedback row. An empty `changedFields` is a comment and requires a `note`; a
 * non-empty list is a suggested revision and carries exactly the values of the fields it names.
 * Approval and the effective version are never taken from a caller.
 */
export interface RecordProposalRevisionInput {
  id: string;
  proposalId: string;
  authorContactId: string;
  /** Field names from `title`, `summary`, `budget`, `location`, `schedule`, `personnel`,
   * `event_flow`. Empty names a comment. */
  changedFields: readonly string[];
  /** Required when `title` is named, refused otherwise. */
  title?: string | null;
  /** Required when `summary` is named, refused otherwise. */
  summary?: string | null;
  /** Required together with `currency` when `budget` is named, refused otherwise. */
  requestedMinor?: number | null;
  /** Required together with `requestedMinor` when `budget` is named, refused otherwise. */
  currency?: string | null;
  location?: string | null;
  schedule?: string | null;
  personnel?: string | null;
  eventFlow?: string | null;
  /** Required for a comment, optional context for a suggested revision. */
  note?: string | null;
}

export interface ProposalRevisionWriteResult {
  ok: boolean;
  status: WriterStatus;
  reason: string;
  revision: ProposalRevisionRecord | null;
  httpStatus: number | null;
}

export interface ApproveProposalRevisionInput {
  revisionId: string;
  /** The approving contact. The database requires a current director. */
  approverContactId: string;
}

export interface ProposalRevisionApprovalResult {
  ok: boolean;
  status: WriterStatus;
  reason: string;
  revision: ProposalRevisionRecord | null;
  httpStatus: number | null;
}

export interface ApplyProposalRevisionInput {
  revisionId: string;
}

export interface AppliedProposalVersionResult {
  ok: boolean;
  status: WriterStatus;
  reason: string;
  version: AppliedProposalVersionRecord | null;
  httpStatus: number | null;
}

export interface FoundationDbWriter {
  readonly environment: FoundationEnvironment;
  readonly tablePrefix: string;
  /** Record one proposal. An identical replay reports the existing row instead of a second one. */
  submitProposal(input: SubmitProposalInput): Promise<ProposalWriteResult>;
  /** Open one approval poll over named proposals. The database freezes the limits. */
  createPoll(input: CreatePollInput): Promise<PollWriteResult>;
  /** Record one immutable ballot: an identical replay is `existing`, a changed one is `conflict`. */
  castBallot(input: CastBallotInput): Promise<BallotWriteResult>;
  /** Read one stored poll definition, or an explicit `poll_not_found`. */
  getPoll(id: string): Promise<PollReadResult>;
  /** Read one stored proposal definition, or an explicit `proposal_not_found`. */
  getProposal(id: string): Promise<ProposalReadResult>;
  /** Read the ballots already accepted for one poll, oldest first. This never returns a tally. */
  listBallots(pollId: string): Promise<BallotListResult>;
  /** Read one configured vote type, which carries the candidate and approval limits. */
  getVoteType(voteType: string): Promise<VoteTypeReadResult>;
  /** Read the proposals that may enter a new poll of one vote type. */
  listCandidateProposals(input: ListCandidateProposalsInput): Promise<CandidateProposalListResult>;
  /**
   * Close a poll after its deadline and record the outcome the database counts from the ballots, as
   * a current director. An already finalized poll returns its recorded outcome with `repeated`.
   */
  finalizePoll(input: FinalizePollInput): Promise<PollFinalizationResult>;
  /** Record one append-only comment or suggested revision. An identical replay is `existing`. */
  recordProposalRevision(input: RecordProposalRevisionInput): Promise<ProposalRevisionWriteResult>;
  /** Read one recorded revision, or an explicit `revision_not_found`. */
  getRevision(id: string): Promise<ProposalRevisionReadResult>;
  /** Record one approval of a revision from a current director. A second approval is refused. */
  approveProposalRevision(
    input: ApproveProposalRevisionInput,
  ): Promise<ProposalRevisionApprovalResult>;
  /** Apply one recorded revision as the proposal's effective version, verified by the database. */
  applyProposalRevision(input: ApplyProposalRevisionInput): Promise<AppliedProposalVersionResult>;
}

interface Failure {
  ok: false;
  kind: 'duplicate' | 'refused' | 'unavailable';
  reason: string;
  httpStatus: number | null;
}

interface Success {
  ok: true;
  httpStatus: number;
  rows: readonly unknown[];
}

type Outcome = Failure | Success;

interface Approvals {
  ok: true;
  value: string[];
}

interface ApprovalRefusal {
  ok: false;
  reason: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VOTE_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const PROPOSAL_STATUSES = Object.freeze(['submitted', 'selected', 'unselected', 'withdrawn']);
const CANDIDATE_STATUSES = Object.freeze(['submitted', 'unselected']);
const POLL_STATUSES = Object.freeze(['open', 'closed', 'cancelled']);
const MAX_TITLE_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 4000;
const MAX_REVISION_TEXT = 4000;
const MAX_NOTE_LENGTH = 2000;
const MAX_BALLOT_PAGE = 1000;
const MAX_CANDIDATE_PAGE = 200;
const DEFAULT_CANDIDATE_PAGE = 50;
/** The fields a revision may name. Empty names a comment. */
const REVISION_FIELDS = Object.freeze([
  'title',
  'summary',
  'budget',
  'location',
  'schedule',
  'personnel',
  'event_flow',
]);
/** A change to any of these takes effect only with a recorded approval from a current director. */
const MATERIAL_REVISION_FIELDS = Object.freeze([
  'budget',
  'location',
  'schedule',
  'personnel',
  'event_flow',
]);

const PROPOSAL_COLUMNS =
  'id,proposer_contact_id,title,summary,vote_type,requested_minor,currency,status,created_at';
const POLL_COLUMNS =
  'id,creator_contact_id,title,vote_type,candidate_proposal_ids,candidate_limit,max_approvals_per_voter,status,opens_at,closes_at,created_at';
const BALLOT_COLUMNS = 'id,poll_id,voter_contact_id,approved_proposal_ids,cast_at';
const VOTE_TYPE_COLUMNS = 'vote_type,max_candidates,max_approvals_per_voter,updated_at';
const REVISION_COLUMNS =
  'id,proposal_id,version,author_contact_id,changed_fields,title,summary,requested_minor,currency,location,schedule,personnel,event_flow,note,approved_by_contact_id,approved_at,recorded_at';
const APPLIED_PROPOSAL_COLUMNS =
  'id,status,version,effective_revision_id,title,summary,requested_minor,currency,location,schedule,personnel,event_flow';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asUuid = (value: unknown): string | null =>
  typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;

const asVoteType = (value: unknown): string | null =>
  typeof value === 'string' && VOTE_TYPE_PATTERN.test(value) ? value : null;

const asTitle = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length >= 1 && text.length <= MAX_TITLE_LENGTH ? text : null;
};

const asIsoInstant = (value: unknown): string | null =>
  typeof value === 'string' && ISO_INSTANT_PATTERN.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : null;

const asPositiveInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;

const asCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

/** `undefined` means present but malformed; `null` means the column is null. */
const optionalCount = (value: unknown): number | null | undefined => {
  if (value === null || value === undefined) return null;
  const count = asCount(value);
  return count === null ? undefined : count;
};

/** `undefined` means present but malformed; `null` means the column is null. */
const optionalText = (value: unknown): string | null | undefined => {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' && value.length <= MAX_SUMMARY_LENGTH ? value : undefined;
};

/** `undefined` means present but malformed; `null` means the column is null. */
const optionalCurrency = (value: unknown): string | null | undefined => {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' && CURRENCY_PATTERN.test(value) ? value : undefined;
};

/** `undefined` means present but malformed; `null` means the column is null. */
const optionalBoundedText = (value: unknown, max: number): string | null | undefined => {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' && value.length <= max ? value : undefined;
};

/** `undefined` means present but malformed; `null` means the column is null. */
const optionalUuid = (value: unknown): string | null | undefined => {
  if (value === null || value === undefined) return null;
  const id = asUuid(value);
  return id === null ? undefined : id;
};

/** `undefined` means present but malformed; `null` means the column is null. */
const optionalIsoInstant = (value: unknown): string | null | undefined => {
  if (value === null || value === undefined) return null;
  const instant = asIsoInstant(value);
  return instant === null ? undefined : instant;
};

/**
 * The fields a revision names, in order, or null when the value is not a list of unique known
 * names. An empty list is a valid comment.
 */
const asRevisionFields = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  const fields: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !REVISION_FIELDS.includes(entry)) return null;
    if (fields.includes(entry)) return null;
    fields.push(entry);
  }
  return fields;
};

/** A distinct list of canonical uuids, or null when the value is not one. */
const uuidList = (value: unknown, allowEmpty: boolean): string[] | null => {
  if (!Array.isArray(value)) return null;
  if (!allowEmpty && value.length === 0) return null;
  const ids: string[] = [];
  for (const entry of value) {
    const id = asUuid(entry);
    if (id === null || ids.includes(id)) return null;
    ids.push(id);
  }
  return ids;
};

const sameApprovals = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((id, index) => id === b[index]);
};

/** Compare a stored revision with the body that would be re-inserted, fields named in order. */
const sameRevisionContent = (
  existing: ProposalRevisionRecord,
  body: Record<string, unknown>,
): boolean => {
  const fields = body.changed_fields;
  if (!Array.isArray(fields) || existing.changedFields.length !== fields.length) return false;
  if (!existing.changedFields.every((name, index) => name === fields[index])) return false;
  const text = (key: string): string | null => {
    const raw = body[key];
    return typeof raw === 'string' ? raw : null;
  };
  const count = (key: string): number | null => {
    const raw = body[key];
    return typeof raw === 'number' ? raw : null;
  };
  return (
    existing.proposalId === body.proposal_id &&
    existing.authorContactId === body.author_contact_id &&
    existing.title === text('title') &&
    existing.summary === text('summary') &&
    existing.requestedMinor === count('requested_minor') &&
    existing.currency === text('currency') &&
    existing.location === text('location') &&
    existing.schedule === text('schedule') &&
    existing.personnel === text('personnel') &&
    existing.eventFlow === text('event_flow') &&
    existing.note === text('note')
  );
};

interface RevisionBody {
  ok: true;
  value: Record<string, unknown>;
}

type RevisionBodyOutcome = RevisionBody | ApprovalRefusal;

/**
 * Shape one feedback row. An empty `changedFields` is a comment and requires a note; a non-empty
 * list carries exactly the values of the fields it names, so a caller cannot smuggle an unnamed
 * change past the trigger. The version, the approval and the recording time are never sent: the
 * database fills each one.
 */
const resolveRevisionBody = (input: RecordProposalRevisionInput): RevisionBodyOutcome => {
  const id = asUuid(input?.id);
  if (id === null) return { ok: false, reason: 'revision_id_invalid' };
  const proposalId = asUuid(input?.proposalId);
  if (proposalId === null) return { ok: false, reason: 'revision_proposal_id_invalid' };
  const authorContactId = asUuid(input?.authorContactId);
  if (authorContactId === null) {
    return { ok: false, reason: 'revision_author_contact_id_invalid' };
  }
  const changedFields = asRevisionFields(input?.changedFields);
  if (changedFields === null) {
    return { ok: false, reason: 'revision_changed_fields_invalid' };
  }
  const named = new Set(changedFields);
  const value: Record<string, unknown> = {
    id,
    proposal_id: proposalId,
    author_contact_id: authorContactId,
    changed_fields: changedFields,
  };

  const title = input?.title ?? null;
  if (named.has('title')) {
    const parsed = asTitle(title);
    if (parsed === null) return { ok: false, reason: 'revision_title_invalid' };
    value.title = parsed;
  } else if (title !== null) {
    return { ok: false, reason: 'revision_title_unexpected' };
  }

  const summary = input?.summary ?? null;
  if (named.has('summary')) {
    if (typeof summary !== 'string' || summary.length > MAX_SUMMARY_LENGTH) {
      return { ok: false, reason: 'revision_summary_invalid' };
    }
    value.summary = summary;
  } else if (summary !== null) {
    return { ok: false, reason: 'revision_summary_unexpected' };
  }

  const requestedMinor = input?.requestedMinor ?? null;
  const currency = input?.currency ?? null;
  if (named.has('budget')) {
    const amount = asCount(requestedMinor);
    const code = typeof currency === 'string' && CURRENCY_PATTERN.test(currency) ? currency : null;
    if (amount === null || code === null) {
      return { ok: false, reason: 'revision_budget_invalid' };
    }
    value.requested_minor = amount;
    value.currency = code;
  } else if (requestedMinor !== null || currency !== null) {
    // Naming one half of a budget is incomplete; naming neither half is an unexpected value.
    const half = (requestedMinor === null) !== (currency === null);
    return { ok: false, reason: half ? 'revision_budget_incomplete' : 'revision_budget_unexpected' };
  }

  const contentFields: ReadonlyArray<readonly [string, unknown]> = [
    ['location', input?.location],
    ['schedule', input?.schedule],
    ['personnel', input?.personnel],
    ['event_flow', input?.eventFlow],
  ];
  for (const [name, raw] of contentFields) {
    const text = raw ?? null;
    if (named.has(name)) {
      if (typeof text !== 'string' || text.length > MAX_REVISION_TEXT) {
        return { ok: false, reason: `revision_${name}_invalid` };
      }
      value[name] = text;
    } else if (text !== null) {
      return { ok: false, reason: `revision_${name}_unexpected` };
    }
  }

  // A comment is the row with no fields, and the database requires its note.
  const rawNote = input?.note ?? null;
  if (changedFields.length === 0 && typeof rawNote !== 'string') {
    return { ok: false, reason: 'revision_note_required' };
  }
  if (rawNote !== null) {
    if (typeof rawNote !== 'string') return { ok: false, reason: 'revision_note_invalid' };
    const note = rawNote.trim();
    if (note.length < 1 || note.length > MAX_NOTE_LENGTH) {
      return { ok: false, reason: 'revision_note_invalid' };
    }
    value.note = note;
  }
  return { ok: true, value };
};

/**
 * Read one ballot's approvals from an input. The phase-2 field is the authority; the deprecated
 * `choice` field is accepted only so an unconverted caller fails with a named reason instead of an
 * accidental write.
 */
const resolveApprovals = (input: CastBallotInput): Approvals | ApprovalRefusal => {
  if (input?.approvedProposalIds !== undefined) {
    const ids = uuidList(input.approvedProposalIds, true);
    if (ids === null) return { ok: false, reason: 'ballot_approved_proposal_ids_invalid' };
    return { ok: true, value: ids };
  }
  const choice = typeof input?.choice === 'string' ? input.choice.trim() : '';
  if (choice === 'abstain') return { ok: true, value: [] };
  const proposalId = asUuid(choice);
  if (proposalId !== null) return { ok: true, value: [proposalId] };
  return { ok: false, reason: 'ballot_approved_proposal_ids_invalid' };
};

const proposalFromRow = (value: unknown): ProposalRecord | null => {
  if (!isPlainObject(value)) return null;
  const id = asUuid(value.id);
  const proposerContactId = asUuid(value.proposer_contact_id);
  const title = asTitle(value.title);
  const voteType = asVoteType(value.vote_type);
  const status =
    typeof value.status === 'string' && PROPOSAL_STATUSES.includes(value.status) ? value.status : null;
  const createdAt = asIsoInstant(value.created_at);
  if (id === null || proposerContactId === null || title === null || voteType === null) return null;
  if (status === null || createdAt === null) return null;
  const summary = optionalText(value.summary);
  if (summary === undefined) return null;
  const requestedMinor = optionalCount(value.requested_minor);
  if (requestedMinor === undefined) return null;
  const currency = optionalCurrency(value.currency);
  if (currency === undefined) return null;
  // The database keeps these two together; a row that separates them is not a proposal.
  if ((requestedMinor === null) !== (currency === null)) return null;
  return {
    id,
    proposerContactId,
    title,
    summary,
    voteType,
    requestedMinor,
    currency,
    status,
    createdAt,
  };
};

const pollFromRow = (value: unknown): PollRecord | null => {
  if (!isPlainObject(value)) return null;
  const id = asUuid(value.id);
  const creatorContactId = asUuid(value.creator_contact_id);
  const title = asTitle(value.title);
  const voteType = asVoteType(value.vote_type);
  const candidateProposalIds = uuidList(value.candidate_proposal_ids, false);
  const candidateLimit = asPositiveInteger(value.candidate_limit);
  const maxApprovalsPerVoter = asPositiveInteger(value.max_approvals_per_voter);
  const status =
    typeof value.status === 'string' && POLL_STATUSES.includes(value.status) ? value.status : null;
  const opensAt = asIsoInstant(value.opens_at);
  const closesAt = asIsoInstant(value.closes_at);
  const createdAt = asIsoInstant(value.created_at);
  if (id === null || creatorContactId === null || title === null || voteType === null) return null;
  if (candidateProposalIds === null || candidateLimit === null) return null;
  if (maxApprovalsPerVoter === null || maxApprovalsPerVoter > candidateLimit) return null;
  if (status === null || opensAt === null || closesAt === null || createdAt === null) return null;
  if (Date.parse(closesAt) <= Date.parse(opensAt)) return null;
  return {
    id,
    creatorContactId,
    title,
    voteType,
    candidateProposalIds,
    candidateLimit,
    maxApprovalsPerVoter,
    status,
    opensAt,
    closesAt,
    createdAt,
  };
};

const ballotFromRow = (value: unknown): BallotRecord | null => {
  if (!isPlainObject(value)) return null;
  const id = asUuid(value.id);
  const pollId = asUuid(value.poll_id);
  const voterContactId = asUuid(value.voter_contact_id);
  const approvedProposalIds = uuidList(value.approved_proposal_ids, true);
  const castAt = asIsoInstant(value.cast_at);
  if (id === null || pollId === null || voterContactId === null) return null;
  if (approvedProposalIds === null || castAt === null) return null;
  return { id, pollId, voterContactId, approvedProposalIds, castAt };
};

const voteTypeFromRow = (value: unknown): VoteTypeRecord | null => {
  if (!isPlainObject(value)) return null;
  const voteType = asVoteType(value.vote_type);
  const maxCandidates = asPositiveInteger(value.max_candidates);
  const maxApprovalsPerVoter = asPositiveInteger(value.max_approvals_per_voter);
  const updatedAt = asIsoInstant(value.updated_at);
  if (voteType === null || maxCandidates === null || maxApprovalsPerVoter === null) return null;
  if (maxApprovalsPerVoter > maxCandidates || updatedAt === null) return null;
  return { voteType, maxCandidates, maxApprovalsPerVoter, updatedAt };
};

const revisionFromRow = (value: unknown): ProposalRevisionRecord | null => {
  if (!isPlainObject(value)) return null;
  const id = asUuid(value.id);
  const proposalId = asUuid(value.proposal_id);
  const authorContactId = asUuid(value.author_contact_id);
  const changedFields = asRevisionFields(value.changed_fields);
  const recordedAt = asIsoInstant(value.recorded_at);
  if (id === null || proposalId === null || authorContactId === null) return null;
  if (changedFields === null || recordedAt === null) return null;
  let version: number | null;
  if (value.version === null || value.version === undefined) {
    version = null;
  } else {
    const parsed = asPositiveInteger(value.version);
    if (parsed === null) return null;
    version = parsed;
  }
  const title = optionalBoundedText(value.title, MAX_TITLE_LENGTH);
  const summary = optionalBoundedText(value.summary, MAX_SUMMARY_LENGTH);
  const location = optionalBoundedText(value.location, MAX_REVISION_TEXT);
  const schedule = optionalBoundedText(value.schedule, MAX_REVISION_TEXT);
  const personnel = optionalBoundedText(value.personnel, MAX_REVISION_TEXT);
  const eventFlow = optionalBoundedText(value.event_flow, MAX_REVISION_TEXT);
  const note = optionalBoundedText(value.note, MAX_NOTE_LENGTH);
  if (title === undefined || summary === undefined || location === undefined) return null;
  if (schedule === undefined || personnel === undefined || eventFlow === undefined) return null;
  if (note === undefined) return null;
  const requestedMinor = optionalCount(value.requested_minor);
  if (requestedMinor === undefined) return null;
  const currency = optionalCurrency(value.currency);
  if (currency === undefined) return null;
  // The database keeps these invariants: a named field carries a value, an unnamed one does not,
  // and a budget is an amount together with its currency.
  if ((requestedMinor === null) !== (currency === null)) return null;
  if (changedFields.includes('title') !== (title !== null)) return null;
  if (changedFields.includes('summary') !== (summary !== null)) return null;
  if (changedFields.includes('budget') !== (requestedMinor !== null)) return null;
  if (changedFields.includes('location') !== (location !== null)) return null;
  if (changedFields.includes('schedule') !== (schedule !== null)) return null;
  if (changedFields.includes('personnel') !== (personnel !== null)) return null;
  if (changedFields.includes('event_flow') !== (eventFlow !== null)) return null;
  // A comment is the one row with no fields, and it always carries its note.
  if (changedFields.length === 0 && note === null) return null;
  const approvedByContactId = optionalUuid(value.approved_by_contact_id);
  const approvedAt = optionalIsoInstant(value.approved_at);
  if (approvedByContactId === undefined || approvedAt === undefined) return null;
  if ((approvedByContactId === null) !== (approvedAt === null)) return null;
  return {
    id,
    proposalId,
    version,
    authorContactId,
    changedFields,
    title,
    summary,
    requestedMinor,
    currency,
    location,
    schedule,
    personnel,
    eventFlow,
    note,
    approvedByContactId,
    approvedAt,
    recordedAt,
  };
};

const appliedProposalFromRow = (value: unknown): AppliedProposalVersionRecord | null => {
  if (!isPlainObject(value)) return null;
  const proposalId = asUuid(value.id);
  const status =
    typeof value.status === 'string' && PROPOSAL_STATUSES.includes(value.status) ? value.status : null;
  const version = asPositiveInteger(value.version);
  const effectiveRevisionId = asUuid(value.effective_revision_id);
  const title = asTitle(value.title);
  if (proposalId === null || status === null || version === null) return null;
  if (effectiveRevisionId === null || title === null) return null;
  const summary = optionalText(value.summary);
  if (summary === undefined) return null;
  const requestedMinor = optionalCount(value.requested_minor);
  if (requestedMinor === undefined) return null;
  const currency = optionalCurrency(value.currency);
  if (currency === undefined) return null;
  if ((requestedMinor === null) !== (currency === null)) return null;
  const location = optionalBoundedText(value.location, MAX_REVISION_TEXT);
  const schedule = optionalBoundedText(value.schedule, MAX_REVISION_TEXT);
  const personnel = optionalBoundedText(value.personnel, MAX_REVISION_TEXT);
  const eventFlow = optionalBoundedText(value.event_flow, MAX_REVISION_TEXT);
  if (location === undefined || schedule === undefined) return null;
  if (personnel === undefined || eventFlow === undefined) return null;
  return {
    proposalId,
    status,
    version,
    effectiveRevisionId,
    title,
    summary,
    requestedMinor,
    currency,
    location,
    schedule,
    personnel,
    eventFlow,
  };
};

const finalizationFromPayload = (payload: unknown): PollFinalizationRecord | null => {
  if (!isPlainObject(payload)) return null;
  const pollId = asUuid(payload.poll_id);
  const status =
    typeof payload.status === 'string' && POLL_STATUSES.includes(payload.status) ? payload.status : null;
  const repeated = typeof payload.repeated === 'boolean' ? payload.repeated : null;
  const outcome =
    payload.outcome === 'winner' || payload.outcome === 'no_winner' ? payload.outcome : null;
  const finalizedByContactId = asUuid(payload.finalized_by_contact_id);
  const candidates = uuidList(payload.candidates, false);
  const proposalsRecorded = asCount(payload.proposals_recorded);
  const ballots = asCount(payload.ballots);
  const abstentions = asCount(payload.abstentions);
  if (pollId === null || status === null || repeated === null || outcome === null) return null;
  if (finalizedByContactId === null || candidates === null) return null;
  if (proposalsRecorded === null || ballots === null || abstentions === null) return null;
  const winningProposalId = optionalUuid(payload.winning_proposal_id);
  if (winningProposalId === undefined) return null;
  if ((outcome === 'winner') !== (winningProposalId !== null)) return null;
  if (winningProposalId !== null && !candidates.includes(winningProposalId)) return null;
  if (abstentions > ballots) return null;
  if (!isPlainObject(payload.approvals)) return null;
  const approvals: PollApprovalCount[] = [];
  for (const [key, raw] of Object.entries(payload.approvals)) {
    const proposalId = asUuid(key);
    const count = asPositiveInteger(raw);
    if (proposalId === null || count === null || !candidates.includes(proposalId)) return null;
    approvals.push({ proposalId, approvals: count });
  }
  approvals.sort(
    (left, right) => right.approvals - left.approvals || left.proposalId.localeCompare(right.proposalId),
  );
  return {
    pollId,
    status,
    repeated,
    outcome,
    winningProposalId,
    finalizedByContactId,
    candidates,
    proposalsRecorded,
    ballots,
    abstentions,
    approvals,
  };
};

/** A 409 is the one status that may mean an exact duplicate, so it is kept apart from a refusal. */
const classify = (status: number): Failure['kind'] => {
  if (status === 409) return 'duplicate';
  if (status >= 500) return 'unavailable';
  return 'refused';
};

const configError = (message: string): Error => new Error(`foundation db writer config: ${message}`);

/**
 * Build a writer bound to one Supabase environment.
 *
 * Throws only for invalid configuration, which is an operator error and not a data path. Every
 * database outcome resolves to a closed result instead, so a caller cannot mistake an error for a
 * stored decision.
 */
export function createFoundationDbWriter(config: FoundationDbWriterConfig): FoundationDbWriter {
  const rawUrl = typeof config?.supabaseUrl === 'string' ? config.supabaseUrl.trim() : '';
  if (!rawUrl) throw configError('supabaseUrl is required');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw configError('supabaseUrl must be an absolute URL');
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw configError('supabaseUrl must use http or https');
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw configError('supabaseUrl must be a bare project URL without credentials, query or fragment');
  }
  const baseUrl = rawUrl.replace(/\/+$/, '');

  const serviceRoleKey = typeof config?.serviceRoleKey === 'string' ? config.serviceRoleKey.trim() : '';
  if (!serviceRoleKey) throw configError('serviceRoleKey is required');

  const environment = config?.environment;
  if (environment !== 'dev' && environment !== 'prod') {
    throw configError("environment must be 'dev' or 'prod'");
  }

  const fetchImpl = config?.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw configError('a fetch implementation is required');

  const tablePrefix = `${environment}_`;

  const request = async (
    method: 'GET' | 'POST' | 'PATCH',
    table: string,
    params: Record<string, string>,
    body?: unknown,
  ): Promise<Outcome> => {
    const query = new URLSearchParams(params).toString();
    const headers: Record<string, string> = {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      accept: 'application/json',
    };
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers,
    };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      headers.prefer = 'return=representation';
      init.body = JSON.stringify(body ?? {});
    }
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/rest/v1/${table}?${query}`, init);
    } catch {
      return { ok: false, kind: 'unavailable', reason: 'transport_error', httpStatus: null };
    }
    const httpStatus = typeof response?.status === 'number' ? response.status : null;
    if (!response || response.ok !== true) {
      if (httpStatus === null) {
        return { ok: false, kind: 'unavailable', reason: 'http_error', httpStatus: null };
      }
      return { ok: false, kind: classify(httpStatus), reason: 'http_error', httpStatus };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, kind: 'unavailable', reason: 'response_malformed', httpStatus };
    }
    if (!Array.isArray(payload)) {
      return { ok: false, kind: 'unavailable', reason: 'response_malformed', httpStatus };
    }
    return { ok: true, httpStatus, rows: payload };
  };

  /**
   * Call one service-only RPC. A scalar-returning function answers with the bare JSON value and a
   * void function answers with no body, so neither is required to be a list. Any refusal below 500
   * is a governance refusal and is collapsed to a fixed reason; a 5xx or a transport failure stays
   * unavailable so a caller never reads an outage as a decision.
   */
  const rpc = async (name: string, body: Record<string, unknown>): Promise<Outcome> => {
    const headers: Record<string, string> = {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      accept: 'application/json',
      'content-type': 'application/json',
    };
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, kind: 'unavailable', reason: 'transport_error', httpStatus: null };
    }
    const httpStatus = typeof response?.status === 'number' ? response.status : null;
    if (!response || response.ok !== true) {
      if (httpStatus === null) {
        return { ok: false, kind: 'unavailable', reason: 'http_error', httpStatus: null };
      }
      if (httpStatus >= 500) {
        return { ok: false, kind: 'unavailable', reason: 'http_error', httpStatus };
      }
      return { ok: false, kind: 'refused', reason: 'rpc_refused', httpStatus };
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      return { ok: false, kind: 'unavailable', reason: 'response_malformed', httpStatus };
    }
    const trimmed = text.trim();
    if (trimmed === '') return { ok: true, httpStatus, rows: [] };
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return { ok: false, kind: 'unavailable', reason: 'response_malformed', httpStatus };
    }
    return { ok: true, httpStatus, rows: [payload] };
  };

  const proposalFailure = (
    status: WriterStatus,
    reason: string,
    httpStatus: number | null,
  ): ProposalWriteResult => ({
    ok: false,
    status,
    reason,
    proposal: null,
    httpStatus,
    authorizesSpending: false,
  });

  const pollFailure = (
    status: WriterStatus,
    reason: string,
    httpStatus: number | null,
  ): PollReadResult => ({ ok: false, status, reason, poll: null, httpStatus });

  const ballotWriteFailure = (
    status: WriterStatus,
    reason: string,
    httpStatus: number | null,
  ): BallotWriteResult => ({ ok: false, status, reason, ballot: null, httpStatus });

  const ballotListFailure = (
    status: WriterStatus,
    reason: string,
    httpStatus: number | null,
  ): BallotListResult => ({ ok: false, status, reason, ballots: null, httpStatus });

  const voteTypeFailure = (
    status: WriterStatus,
    reason: string,
    httpStatus: number | null,
  ): VoteTypeReadResult => ({ ok: false, status, reason, voteType: null, httpStatus });

  const candidateFailure = (
    status: WriterStatus,
    reason: string,
    httpStatus: number | null,
  ): CandidateProposalListResult => ({ ok: false, status, reason, proposals: null, httpStatus });

  const finalizationFailure = (
    status: WriterStatus,
    reason: string,
    httpStatus: number | null,
  ): PollFinalizationResult => ({ ok: false, status, reason, finalization: null, httpStatus });

  const revisionWriteFailure = (
    status: WriterStatus,
    reason: string,
    httpStatus: number | null,
  ): ProposalRevisionWriteResult => ({ ok: false, status, reason, revision: null, httpStatus });

  const revisionReadFailure = (
    status: WriterStatus,
    reason: string,
    httpStatus: number | null,
  ): ProposalRevisionReadResult => ({ ok: false, status, reason, revision: null, httpStatus });

  const revisionApprovalFailure = (
    status: WriterStatus,
    reason: string,
    httpStatus: number | null,
  ): ProposalRevisionApprovalResult => ({ ok: false, status, reason, revision: null, httpStatus });

  const appliedVersionFailure = (
    status: WriterStatus,
    reason: string,
    httpStatus: number | null,
  ): AppliedProposalVersionResult => ({ ok: false, status, reason, version: null, httpStatus });

  const submitProposal = async (input: SubmitProposalInput): Promise<ProposalWriteResult> => {
    const id = asUuid(input?.id);
    if (id === null) return proposalFailure('invalid_request', 'proposal_id_invalid', null);
    const proposerContactId = asUuid(input?.proposerContactId);
    if (proposerContactId === null) {
      return proposalFailure('invalid_request', 'proposer_contact_id_invalid', null);
    }
    const title = asTitle(input?.title);
    if (title === null) return proposalFailure('invalid_request', 'proposal_title_invalid', null);
    // The vote type is operator configuration, never a default and never a caller's guess: an
    // absent or malformed one is refused before any request is made.
    const voteType = asVoteType(input?.voteType);
    if (voteType === null) return proposalFailure('invalid_request', 'proposal_vote_type_invalid', null);
    const summary = optionalText(input?.summary);
    if (summary === undefined) return proposalFailure('invalid_request', 'proposal_summary_invalid', null);
    const requestedMinor = optionalCount(input?.requestedMinor);
    if (requestedMinor === undefined) {
      return proposalFailure('invalid_request', 'proposal_requested_minor_invalid', null);
    }
    const currency = optionalCurrency(input?.currency);
    if (currency === undefined) return proposalFailure('invalid_request', 'proposal_currency_invalid', null);
    if ((requestedMinor === null) !== (currency === null)) {
      return proposalFailure('invalid_request', 'proposal_request_incomplete', null);
    }

    const table = `${tablePrefix}rein_mvp_proposals`;
    const body = {
      id,
      proposer_contact_id: proposerContactId,
      title,
      summary,
      vote_type: voteType,
      requested_minor: requestedMinor,
      currency,
    };
    const written = await request('POST', table, { select: PROPOSAL_COLUMNS }, body);
    if (written.ok) {
      const stored = written.rows.length === 1 ? proposalFromRow(written.rows[0]) : null;
      if (stored === null) {
        return proposalFailure('unavailable', 'response_malformed', written.httpStatus);
      }
      return {
        ok: true,
        status: 'inserted',
        reason: 'inserted',
        proposal: stored,
        httpStatus: written.httpStatus,
        authorizesSpending: false,
      };
    }
    if (written.kind === 'refused') {
      return proposalFailure('rejected', 'proposal_rejected', written.httpStatus);
    }
    if (written.kind === 'unavailable') {
      return proposalFailure('unavailable', written.reason, written.httpStatus);
    }
    // A duplicate id: the stored row decides whether this is the same submission or a conflict.
    const reread = await request('GET', table, { select: PROPOSAL_COLUMNS, id: `eq.${id}`, limit: '2' });
    if (!reread.ok) return proposalFailure('unavailable', reread.reason, reread.httpStatus);
    if (reread.rows.length === 0) {
      return proposalFailure('rejected', 'proposal_rejected', written.httpStatus);
    }
    if (reread.rows.length > 1) {
      return proposalFailure('unavailable', 'response_malformed', reread.httpStatus);
    }
    const existing = proposalFromRow(reread.rows[0]);
    if (existing === null) {
      return proposalFailure('unavailable', 'response_malformed', reread.httpStatus);
    }
    const identical =
      existing.proposerContactId === proposerContactId &&
      existing.title === title &&
      existing.summary === summary &&
      existing.voteType === voteType &&
      existing.requestedMinor === requestedMinor &&
      existing.currency === currency;
    if (identical) {
      return {
        ok: true,
        status: 'existing',
        reason: 'existing_identical',
        proposal: existing,
        httpStatus: written.httpStatus,
        authorizesSpending: false,
      };
    }
    return proposalFailure('conflict', 'proposal_conflict', written.httpStatus);
  };

  const createPoll = async (input: CreatePollInput): Promise<PollWriteResult> => {
    const id = asUuid(input?.id);
    if (id === null) return pollFailure('invalid_request', 'poll_id_invalid', null);
    const creatorContactId = asUuid(input?.creatorContactId);
    if (creatorContactId === null) {
      return pollFailure('invalid_request', 'creator_contact_id_invalid', null);
    }
    const title = asTitle(input?.title);
    if (title === null) return pollFailure('invalid_request', 'poll_title_invalid', null);
    const opensAt = asIsoInstant(input?.opensAt);
    if (opensAt === null) return pollFailure('invalid_request', 'poll_opens_at_invalid', null);
    const closesAt = asIsoInstant(input?.closesAt);
    if (closesAt === null) return pollFailure('invalid_request', 'poll_closes_at_invalid', null);
    if (Date.parse(closesAt) <= Date.parse(opensAt)) {
      return pollFailure('invalid_request', 'poll_window_invalid', null);
    }
    // A phase-1 options list has no representation in the phase-2 schema, so it is refused by name
    // rather than written as a candidate list.
    if (input?.options !== undefined && input?.candidateProposalIds === undefined) {
      return pollFailure('invalid_request', 'legacy_options_unsupported', null);
    }
    const voteType = asVoteType(input?.voteType);
    if (voteType === null) return pollFailure('invalid_request', 'poll_vote_type_invalid', null);
    const candidateProposalIds = uuidList(input?.candidateProposalIds, false);
    if (candidateProposalIds === null) {
      return pollFailure('invalid_request', 'poll_candidate_proposal_ids_invalid', null);
    }

    const table = `${tablePrefix}rein_mvp_polls`;
    // `candidate_limit` and `max_approvals_per_voter` are deliberately absent: the database freezes
    // them from the vote type, so a caller cannot widen its own poll.
    const body = {
      id,
      creator_contact_id: creatorContactId,
      title,
      vote_type: voteType,
      candidate_proposal_ids: candidateProposalIds,
      opens_at: opensAt,
      closes_at: closesAt,
    };
    const written = await request('POST', table, { select: POLL_COLUMNS }, body);
    if (written.ok) {
      const stored = written.rows.length === 1 ? pollFromRow(written.rows[0]) : null;
      if (stored === null) return pollFailure('unavailable', 'response_malformed', written.httpStatus);
      return { ok: true, status: 'inserted', reason: 'inserted', poll: stored, httpStatus: written.httpStatus };
    }
    if (written.kind === 'refused') {
      return pollFailure('rejected', 'poll_rejected', written.httpStatus);
    }
    if (written.kind === 'unavailable') {
      return pollFailure('unavailable', written.reason, written.httpStatus);
    }
    const reread = await request('GET', table, { select: POLL_COLUMNS, id: `eq.${id}`, limit: '2' });
    if (!reread.ok) return pollFailure('unavailable', reread.reason, reread.httpStatus);
    if (reread.rows.length === 0) return pollFailure('rejected', 'poll_rejected', written.httpStatus);
    if (reread.rows.length > 1) {
      return pollFailure('unavailable', 'response_malformed', reread.httpStatus);
    }
    const existing = pollFromRow(reread.rows[0]);
    if (existing === null) {
      return pollFailure('unavailable', 'response_malformed', reread.httpStatus);
    }
    const identical =
      existing.creatorContactId === creatorContactId &&
      existing.title === title &&
      existing.voteType === voteType &&
      existing.candidateProposalIds.length === candidateProposalIds.length &&
      existing.candidateProposalIds.every((candidate, index) => candidate === candidateProposalIds[index]) &&
      existing.opensAt === opensAt &&
      existing.closesAt === closesAt;
    if (identical) {
      return { ok: true, status: 'existing', reason: 'existing_identical', poll: existing, httpStatus: written.httpStatus };
    }
    return pollFailure('conflict', 'poll_conflict', written.httpStatus);
  };

  const castBallot = async (input: CastBallotInput): Promise<BallotWriteResult> => {
    const pollId = asUuid(input?.pollId);
    if (pollId === null) return ballotWriteFailure('invalid_request', 'poll_id_invalid', null);
    const voterContactId = asUuid(input?.voterContactId);
    if (voterContactId === null) {
      return ballotWriteFailure('invalid_request', 'voter_contact_id_invalid', null);
    }
    const approvals = resolveApprovals(input);
    if (!approvals.ok) return ballotWriteFailure('invalid_request', approvals.reason, null);
    // The database clock is the default; an override exists only for a deterministic test.
    const castAt = input?.castAt === undefined ? null : asIsoInstant(input.castAt);
    if (input?.castAt !== undefined && castAt === null) {
      return ballotWriteFailure('invalid_request', 'ballot_cast_at_invalid', null);
    }

    const table = `${tablePrefix}rein_mvp_ballots`;
    const body: Record<string, unknown> = {
      poll_id: pollId,
      voter_contact_id: voterContactId,
      approved_proposal_ids: approvals.value,
    };
    if (castAt !== null) body.cast_at = castAt;
    const written = await request('POST', table, { select: BALLOT_COLUMNS }, body);
    if (written.ok) {
      const stored = written.rows.length === 1 ? ballotFromRow(written.rows[0]) : null;
      if (stored === null) {
        return ballotWriteFailure('unavailable', 'response_malformed', written.httpStatus);
      }
      return {
        ok: true,
        status: 'inserted',
        reason: 'inserted',
        ballot: {
          pollId: stored.pollId,
          voterContactId: stored.voterContactId,
          approvedProposalIds: stored.approvedProposalIds,
        },
        httpStatus: written.httpStatus,
      };
    }
    if (written.kind === 'refused') {
      return ballotWriteFailure('rejected', 'ballot_rejected', written.httpStatus);
    }
    if (written.kind === 'unavailable') {
      return ballotWriteFailure('unavailable', written.reason, written.httpStatus);
    }
    // One ballot per (poll, voter): only an exact replay is `existing`, and a changed list is a
    // conflict that never replaces the recorded ballot.
    const reread = await request('GET', table, {
      select: BALLOT_COLUMNS,
      poll_id: `eq.${pollId}`,
      voter_contact_id: `eq.${voterContactId}`,
      limit: '2',
    });
    if (!reread.ok) return ballotWriteFailure('unavailable', reread.reason, reread.httpStatus);
    if (reread.rows.length === 0) {
      return ballotWriteFailure('rejected', 'ballot_rejected', written.httpStatus);
    }
    if (reread.rows.length > 1) {
      return ballotWriteFailure('unavailable', 'response_malformed', reread.httpStatus);
    }
    const existing = ballotFromRow(reread.rows[0]);
    if (existing === null) {
      return ballotWriteFailure('unavailable', 'response_malformed', reread.httpStatus);
    }
    if (sameApprovals(existing.approvedProposalIds, approvals.value)) {
      return {
        ok: true,
        status: 'existing',
        reason: 'existing_identical',
        ballot: {
          pollId: existing.pollId,
          voterContactId: existing.voterContactId,
          approvedProposalIds: existing.approvedProposalIds,
        },
        httpStatus: written.httpStatus,
      };
    }
    return ballotWriteFailure('conflict', 'ballot_conflict', written.httpStatus);
  };

  const getProposal = async (id: string): Promise<ProposalReadResult> => {
    const proposalId = asUuid(id);
    if (proposalId === null) return proposalFailure('invalid_request', 'proposal_id_invalid', null);
    const read = await request('GET', `${tablePrefix}rein_mvp_proposals`, {
      select: PROPOSAL_COLUMNS,
      id: `eq.${proposalId}`,
      limit: '2',
    });
    if (!read.ok) return proposalFailure('unavailable', read.reason, read.httpStatus);
    if (read.rows.length === 0) return proposalFailure('rejected', 'proposal_not_found', read.httpStatus);
    if (read.rows.length > 1) return proposalFailure('rejected', 'response_malformed', read.httpStatus);
    const proposal = proposalFromRow(read.rows[0]);
    if (proposal === null) return proposalFailure('rejected', 'response_malformed', read.httpStatus);
    return { ok: true, status: 'found', reason: 'proposal', proposal, httpStatus: read.httpStatus };
  };

  const getPoll = async (id: string): Promise<PollReadResult> => {
    const pollId = asUuid(id);
    if (pollId === null) return pollFailure('invalid_request', 'poll_id_invalid', null);
    const read = await request('GET', `${tablePrefix}rein_mvp_polls`, {
      select: POLL_COLUMNS,
      id: `eq.${pollId}`,
      limit: '2',
    });
    if (!read.ok) return pollFailure('unavailable', read.reason, read.httpStatus);
    if (read.rows.length === 0) return pollFailure('rejected', 'poll_not_found', read.httpStatus);
    if (read.rows.length > 1) return pollFailure('rejected', 'response_malformed', read.httpStatus);
    const poll = pollFromRow(read.rows[0]);
    if (poll === null) return pollFailure('rejected', 'response_malformed', read.httpStatus);
    return { ok: true, status: 'found', reason: 'poll', poll, httpStatus: read.httpStatus };
  };

  const listBallots = async (pollId: string): Promise<BallotListResult> => {
    const id = asUuid(pollId);
    if (id === null) return ballotListFailure('invalid_request', 'poll_id_invalid', null);
    const read = await request('GET', `${tablePrefix}rein_mvp_ballots`, {
      select: BALLOT_COLUMNS,
      poll_id: `eq.${id}`,
      order: 'cast_at.asc,id.asc',
      // One extra row proves a truncated page instead of silently returning a partial ballot set.
      limit: String(MAX_BALLOT_PAGE + 1),
    });
    if (!read.ok) return ballotListFailure('unavailable', read.reason, read.httpStatus);
    if (read.rows.length > MAX_BALLOT_PAGE) {
      return ballotListFailure('rejected', 'ballots_truncated', read.httpStatus);
    }
    const ballots: BallotRecord[] = [];
    for (const row of read.rows) {
      const ballot = ballotFromRow(row);
      if (ballot === null) return ballotListFailure('rejected', 'response_malformed', read.httpStatus);
      ballots.push(ballot);
    }
    return { ok: true, status: 'found', reason: 'ballots', ballots, httpStatus: read.httpStatus };
  };

  const getVoteType = async (voteType: string): Promise<VoteTypeReadResult> => {
    const name = asVoteType(voteType);
    if (name === null) return voteTypeFailure('invalid_request', 'vote_type_invalid', null);
    const read = await request('GET', `${tablePrefix}rein_mvp_vote_types`, {
      select: VOTE_TYPE_COLUMNS,
      vote_type: `eq.${name}`,
      limit: '2',
    });
    if (!read.ok) return voteTypeFailure('unavailable', read.reason, read.httpStatus);
    if (read.rows.length === 0) return voteTypeFailure('rejected', 'vote_type_not_found', read.httpStatus);
    if (read.rows.length > 1) {
      return voteTypeFailure('rejected', 'response_malformed', read.httpStatus);
    }
    const stored = voteTypeFromRow(read.rows[0]);
    if (stored === null) return voteTypeFailure('rejected', 'response_malformed', read.httpStatus);
    return { ok: true, status: 'found', reason: 'vote_type', voteType: stored, httpStatus: read.httpStatus };
  };

  const listCandidateProposals = async (
    input: ListCandidateProposalsInput,
  ): Promise<CandidateProposalListResult> => {
    const voteType = asVoteType(input?.voteType);
    if (voteType === null) return candidateFailure('invalid_request', 'vote_type_invalid', null);
    const requested = input?.limit === undefined ? DEFAULT_CANDIDATE_PAGE : input.limit;
    const limit = asPositiveInteger(requested);
    if (limit === null || limit > MAX_CANDIDATE_PAGE) {
      return candidateFailure('invalid_request', 'candidate_limit_invalid', null);
    }
    const excluded = new Set<string>();
    if (input?.excludeProposalIds !== undefined) {
      const ids = uuidList(input.excludeProposalIds, true);
      if (ids === null) {
        return candidateFailure('invalid_request', 'candidate_exclude_ids_invalid', null);
      }
      for (const id of ids) excluded.add(id);
    }
    const submittedSince =
      input?.submittedSince === undefined ? null : asIsoInstant(input.submittedSince);
    if (input?.submittedSince !== undefined && submittedSince === null) {
      return candidateFailure('invalid_request', 'submitted_since_invalid', null);
    }
    const recentlyUnselected = input?.includeRecentlyUnselected ?? false;
    if (typeof recentlyUnselected !== 'boolean') {
      return candidateFailure('invalid_request', 'candidate_buckets_invalid', null);
    }
    // The exclusion is applied to the fetched page, so the page is widened by the number of
    // excluded ids rather than by guessing how many rows they would have occupied.
    const pageSize = Math.min(limit + excluded.size, MAX_CANDIDATE_PAGE);
    // The most recent unselected proposals are read first: a second round may legitimately re-offer
    // a proposal that lost, and the pool would otherwise hide it behind every older submission.
    const recent: ProposalRecord[] = [];
    if (recentlyUnselected) {
      const unselected = await request('GET', `${tablePrefix}rein_mvp_proposals`, {
        select: PROPOSAL_COLUMNS,
        vote_type: `eq.${voteType}`,
        status: 'eq.unselected',
        order: 'created_at.desc,id.desc',
        limit: String(pageSize),
      });
      if (!unselected.ok) {
        return candidateFailure('unavailable', unselected.reason, unselected.httpStatus);
      }
      for (const row of unselected.rows) {
        const proposal = proposalFromRow(row);
        if (proposal === null || proposal.voteType !== voteType) {
          return candidateFailure('rejected', 'response_malformed', unselected.httpStatus);
        }
        recent.push(proposal);
      }
    }
    const baseParams: Record<string, string> = {
      select: PROPOSAL_COLUMNS,
      vote_type: `eq.${voteType}`,
      status: `in.(${CANDIDATE_STATUSES.join(',')})`,
      order: 'created_at.asc,id.asc',
      limit: String(pageSize),
    };
    if (submittedSince !== null) baseParams.created_at = `gte.${submittedSince}`;
    const read = await request('GET', `${tablePrefix}rein_mvp_proposals`, baseParams);
    if (!read.ok) return candidateFailure('unavailable', read.reason, read.httpStatus);
    const fetched: ProposalRecord[] = [];
    for (const row of read.rows) {
      const proposal = proposalFromRow(row);
      // Every row must still carry the queried vote type: a mismatched row is not a candidate.
      if (proposal === null || proposal.voteType !== voteType) {
        return candidateFailure('rejected', 'response_malformed', read.httpStatus);
      }
      fetched.push(proposal);
    }
    const proposals: ProposalRecord[] = [];
    const seen = new Set<string>();
    for (const proposal of [...recent, ...fetched]) {
      if (seen.has(proposal.id) || excluded.has(proposal.id)) continue;
      seen.add(proposal.id);
      proposals.push(proposal);
      if (proposals.length === limit) break;
    }
    return { ok: true, status: 'found', reason: 'candidates', proposals, httpStatus: read.httpStatus };
  };

  const finalizePoll = async (input: FinalizePollInput): Promise<PollFinalizationResult> => {
    const pollId = asUuid(input?.pollId);
    if (pollId === null) return finalizationFailure('invalid_request', 'poll_id_invalid', null);
    const actorContactId = asUuid(input?.actorContactId);
    if (actorContactId === null) {
      return finalizationFailure('invalid_request', 'actor_contact_id_invalid', null);
    }
    // The outcome, the winner and the version are the database's: this call carries only the poll
    // and the director who finalizes it.
    const called = await rpc(`${tablePrefix}rein_mvp_finalize_poll`, {
      p_poll_id: pollId,
      p_actor_contact_id: actorContactId,
    });
    if (!called.ok) {
      if (called.kind === 'refused') {
        return finalizationFailure('rejected', 'finalize_rejected', called.httpStatus);
      }
      return finalizationFailure('unavailable', called.reason, called.httpStatus);
    }
    if (called.rows.length !== 1) {
      return finalizationFailure('unavailable', 'response_malformed', called.httpStatus);
    }
    const finalization = finalizationFromPayload(called.rows[0]);
    if (finalization === null) {
      return finalizationFailure('unavailable', 'response_malformed', called.httpStatus);
    }
    return {
      ok: true,
      status: finalization.repeated ? 'existing' : 'inserted',
      reason: finalization.repeated ? 'existing_finalized' : 'finalized',
      finalization,
      httpStatus: called.httpStatus,
    };
  };

  const recordProposalRevision = async (
    input: RecordProposalRevisionInput,
  ): Promise<ProposalRevisionWriteResult> => {
    const resolved = resolveRevisionBody(input);
    if (!resolved.ok) return revisionWriteFailure('invalid_request', resolved.reason, null);
    const body = resolved.value;
    const id = body.id as string;
    const table = `${tablePrefix}rein_mvp_proposal_revisions`;
    const written = await request('POST', table, { select: REVISION_COLUMNS }, body);
    if (written.ok) {
      const stored = written.rows.length === 1 ? revisionFromRow(written.rows[0]) : null;
      if (stored === null) {
        return revisionWriteFailure('unavailable', 'response_malformed', written.httpStatus);
      }
      return {
        ok: true,
        status: 'inserted',
        reason: 'inserted',
        revision: stored,
        httpStatus: written.httpStatus,
      };
    }
    if (written.kind === 'refused') {
      return revisionWriteFailure('rejected', 'revision_rejected', written.httpStatus);
    }
    if (written.kind === 'unavailable') {
      return revisionWriteFailure('unavailable', written.reason, written.httpStatus);
    }
    // A duplicate id: only an exact replay is `existing`, and a changed row is a conflict that never
    // replaces the recorded feedback.
    const reread = await request('GET', table, { select: REVISION_COLUMNS, id: `eq.${id}`, limit: '2' });
    if (!reread.ok) return revisionWriteFailure('unavailable', reread.reason, reread.httpStatus);
    if (reread.rows.length === 0) {
      return revisionWriteFailure('rejected', 'revision_rejected', written.httpStatus);
    }
    if (reread.rows.length > 1) {
      return revisionWriteFailure('unavailable', 'response_malformed', reread.httpStatus);
    }
    const existing = revisionFromRow(reread.rows[0]);
    if (existing === null) {
      return revisionWriteFailure('unavailable', 'response_malformed', reread.httpStatus);
    }
    if (sameRevisionContent(existing, body)) {
      return {
        ok: true,
        status: 'existing',
        reason: 'existing_identical',
        revision: existing,
        httpStatus: written.httpStatus,
      };
    }
    return revisionWriteFailure('conflict', 'revision_conflict', written.httpStatus);
  };

  const getRevision = async (id: string): Promise<ProposalRevisionReadResult> => {
    const revisionId = asUuid(id);
    if (revisionId === null) return revisionReadFailure('invalid_request', 'revision_id_invalid', null);
    const read = await request('GET', `${tablePrefix}rein_mvp_proposal_revisions`, {
      select: REVISION_COLUMNS,
      id: `eq.${revisionId}`,
      limit: '2',
    });
    if (!read.ok) return revisionReadFailure('unavailable', read.reason, read.httpStatus);
    if (read.rows.length === 0) {
      return revisionReadFailure('rejected', 'revision_not_found', read.httpStatus);
    }
    if (read.rows.length > 1) {
      return revisionReadFailure('rejected', 'response_malformed', read.httpStatus);
    }
    const revision = revisionFromRow(read.rows[0]);
    if (revision === null) return revisionReadFailure('rejected', 'response_malformed', read.httpStatus);
    return { ok: true, status: 'found', reason: 'revision', revision, httpStatus: read.httpStatus };
  };

  const approveProposalRevision = async (
    input: ApproveProposalRevisionInput,
  ): Promise<ProposalRevisionApprovalResult> => {
    const revisionId = asUuid(input?.revisionId);
    if (revisionId === null) {
      return revisionApprovalFailure('invalid_request', 'revision_id_invalid', null);
    }
    const approverContactId = asUuid(input?.approverContactId);
    if (approverContactId === null) {
      return revisionApprovalFailure('invalid_request', 'approver_contact_id_invalid', null);
    }
    // The approver and the recording time are the database's: this call carries only the revision
    // and the contact claiming to be a current director. An approval is final and never replaced.
    const called = await rpc(`${tablePrefix}rein_mvp_approve_revision`, {
      p_revision_id: revisionId,
      p_approver_contact_id: approverContactId,
    });
    const table = `${tablePrefix}rein_mvp_proposal_revisions`;
    if (called.ok) {
      const read = await request('GET', table, {
        select: REVISION_COLUMNS,
        id: `eq.${revisionId}`,
        limit: '2',
      });
      if (!read.ok) return revisionApprovalFailure('unavailable', read.reason, read.httpStatus);
      if (read.rows.length !== 1) {
        return revisionApprovalFailure('unavailable', 'response_malformed', read.httpStatus);
      }
      const stored = revisionFromRow(read.rows[0]);
      if (stored === null) {
        return revisionApprovalFailure('unavailable', 'response_malformed', read.httpStatus);
      }
      return {
        ok: true,
        status: 'updated',
        reason: 'approved',
        revision: stored,
        httpStatus: called.httpStatus,
      };
    }
    if (called.kind === 'unavailable') {
      return revisionApprovalFailure('unavailable', called.reason, called.httpStatus);
    }
    // A refusal below 500. The provider text is never propagated; one confirming read names which
    // recorded state explains the refusal.
    const read = await request('GET', table, {
      select: REVISION_COLUMNS,
      id: `eq.${revisionId}`,
      limit: '2',
    });
    if (!read.ok) return revisionApprovalFailure('unavailable', read.reason, read.httpStatus);
    if (read.rows.length === 0) {
      return revisionApprovalFailure('rejected', 'revision_not_found', called.httpStatus);
    }
    if (read.rows.length > 1) {
      return revisionApprovalFailure('unavailable', 'response_malformed', read.httpStatus);
    }
    const existing = revisionFromRow(read.rows[0]);
    if (existing === null) {
      return revisionApprovalFailure('unavailable', 'response_malformed', read.httpStatus);
    }
    if (existing.approvedByContactId === approverContactId) {
      return {
        ok: true,
        status: 'existing',
        reason: 'existing_approved',
        revision: existing,
        httpStatus: called.httpStatus,
      };
    }
    if (existing.approvedByContactId !== null) {
      return revisionApprovalFailure('conflict', 'revision_already_approved', called.httpStatus);
    }
    return revisionApprovalFailure('rejected', 'revision_approval_rejected', called.httpStatus);
  };

  const applyProposalRevision = async (
    input: ApplyProposalRevisionInput,
  ): Promise<AppliedProposalVersionResult> => {
    const revisionId = asUuid(input?.revisionId);
    if (revisionId === null) {
      return appliedVersionFailure('invalid_request', 'revision_id_invalid', null);
    }
    const table = `${tablePrefix}rein_mvp_proposal_revisions`;
    const read = await request('GET', table, {
      select: REVISION_COLUMNS,
      id: `eq.${revisionId}`,
      limit: '2',
    });
    if (!read.ok) return appliedVersionFailure('unavailable', read.reason, read.httpStatus);
    if (read.rows.length === 0) {
      return appliedVersionFailure('rejected', 'revision_not_found', read.httpStatus);
    }
    if (read.rows.length > 1) {
      return appliedVersionFailure('unavailable', 'response_malformed', read.httpStatus);
    }
    const revision = revisionFromRow(read.rows[0]);
    if (revision === null) {
      return appliedVersionFailure('unavailable', 'response_malformed', read.httpStatus);
    }
    if (revision.changedFields.length === 0) {
      return appliedVersionFailure('rejected', 'revision_is_comment', read.httpStatus);
    }
    if (revision.version !== null) {
      return appliedVersionFailure('rejected', 'revision_already_applied', read.httpStatus);
    }
    // A material revision without a recorded approval is refused here by name; a recorded approval
    // from a contact who is no longer a current director is refused by the trigger instead.
    const material = revision.changedFields.some((name) => MATERIAL_REVISION_FIELDS.includes(name));
    if (material && revision.approvedByContactId === null) {
      return appliedVersionFailure('rejected', 'revision_not_approved', read.httpStatus);
    }
    // The patch reproduces exactly the recorded values of exactly the named fields, and the trigger
    // assigns the new version: a caller never numbers or widens one.
    const patch: Record<string, unknown> = { effective_revision_id: revision.id };
    if (revision.changedFields.includes('title')) patch.title = revision.title;
    if (revision.changedFields.includes('summary')) patch.summary = revision.summary;
    if (revision.changedFields.includes('budget')) {
      patch.requested_minor = revision.requestedMinor;
      patch.currency = revision.currency;
    }
    if (revision.changedFields.includes('location')) patch.location = revision.location;
    if (revision.changedFields.includes('schedule')) patch.schedule = revision.schedule;
    if (revision.changedFields.includes('personnel')) patch.personnel = revision.personnel;
    if (revision.changedFields.includes('event_flow')) patch.event_flow = revision.eventFlow;
    const written = await request(
      'PATCH',
      `${tablePrefix}rein_mvp_proposals`,
      { select: APPLIED_PROPOSAL_COLUMNS, id: `eq.${revision.proposalId}` },
      patch,
    );
    if (!written.ok) {
      if (written.kind === 'unavailable') {
        return appliedVersionFailure('unavailable', written.reason, written.httpStatus);
      }
      return appliedVersionFailure('rejected', 'revision_apply_rejected', written.httpStatus);
    }
    if (written.rows.length === 0) {
      return appliedVersionFailure('rejected', 'proposal_not_found', written.httpStatus);
    }
    if (written.rows.length > 1) {
      return appliedVersionFailure('unavailable', 'response_malformed', written.httpStatus);
    }
    const applied = appliedProposalFromRow(written.rows[0]);
    if (applied === null) {
      return appliedVersionFailure('unavailable', 'response_malformed', written.httpStatus);
    }
    return {
      ok: true,
      status: 'updated',
      reason: 'revision_applied',
      version: applied,
      httpStatus: written.httpStatus,
    };
  };

  return Object.freeze({
    environment,
    tablePrefix,
    submitProposal,
    createPoll,
    castBallot,
    getPoll,
    getProposal,
    listBallots,
    getVoteType,
    listCandidateProposals,
    finalizePoll,
    recordProposalRevision,
    getRevision,
    approveProposalRevision,
    applyProposalRevision,
  });
}
