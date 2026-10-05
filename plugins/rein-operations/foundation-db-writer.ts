// Result contracts for the governance writes and their reads. This module holds types only: the
// Agent opens no database connection, holds no database credential and reaches no table or RPC
// directly, so every write is executed by the authenticated Foundation backend through
// `backend-db-adapter.ts`, which returns exactly these shapes. The backend stays the authority for
// every governance rule: it freezes a poll's candidate and per-voter approval limits from the named
// vote type, refuses a candidate that does not belong to the poll or already sits on an open round,
// refuses a second or replaced ballot, refuses a revision the database has not approved, and
// refuses writes from any role but its own service role.
//
// What this module never does: no delete, no upsert, no payment, no reservation, no identity or
// weight escalation and no message to Slack. Recording a proposal is not a funding decision, so
// every proposal result reports `authorizesSpending: false`.

import type { FoundationEnvironment } from './foundation-db-reader.ts';

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
  /** Frozen from the vote type by the backend at insert time, never by a caller. */
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

export interface VoteTypeListResult {
  ok: boolean;
  status: WriterStatus;
  reason: string;
  /** The configured type names, in stored order and never empty when `ok` is true. */
  voteTypes: readonly string[] | null;
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
  /** The version this revision produced, assigned by the backend. */
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

/** One recorded approval count per candidate, from the finalize outcome's own tally evidence. */
export interface PollApprovalCount {
  proposalId: string;
  approvals: number;
}

/** The recorded outcome of one finalized poll, as the backend computed and stored it. */
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
  /** The contact finalizing the poll. The backend requires a current director. */
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
  /** The approving contact. The backend requires a current director. */
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
  /** Open one approval poll over named proposals. The backend freezes the limits. */
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
  /**
   * List the configured vote type names, in stored order. That table is operator configuration, so
   * it is the only source from which a caller may name a type; the writer never invents one.
   */
  listVoteTypes(input?: { limit?: number | null }): Promise<VoteTypeListResult>;
  /**
   * Read the proposals that may enter a new poll of one vote type: the eligible submissions of that
   * type, minus every proposal already frozen by a currently open poll of any type, because the
   * backend refuses a candidate that is already on an open round.
   */
  listCandidateProposals(input: ListCandidateProposalsInput): Promise<CandidateProposalListResult>;
  /**
   * Close a poll after its deadline and record the outcome the backend counts from the ballots, as
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
  /** Apply one recorded revision as the proposal's effective version, verified by the backend. */
  applyProposalRevision(input: ApplyProposalRevisionInput): Promise<AppliedProposalVersionResult>;
}
