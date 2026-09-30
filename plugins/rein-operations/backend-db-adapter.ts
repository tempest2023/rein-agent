import {
  type BackendProof,
  type BackendFailureReason,
  type BackendResponse,
  type BackendTransport,
} from './backend-transport.ts';
import type {
  AvailableFunds,
  AvailableFundsStatus,
  FoundationDbReader,
  SlackMemberResolution,
  SlackMemberStatus,
} from './foundation-db-reader.ts';
import type {
  AppliedProposalVersionResult,
  AppliedProposalVersionRecord,
  ApplyProposalRevisionInput,
  ApproveProposalRevisionInput,
  BallotRecord,
  BallotListResult,
  BallotSummary,
  BallotWriteResult,
  CandidateProposalListResult,
  CastBallotInput,
  CreatePollInput,
  FinalizePollInput,
  FoundationDbWriter,
  ListCandidateProposalsInput,
  PollFinalizationResult,
  PollFinalizationRecord,
  PollReadResult,
  PollRecord,
  PollWriteResult,
  ProposalReadResult,
  ProposalRecord,
  ProposalRevisionApprovalResult,
  ProposalRevisionRecord,
  ProposalRevisionReadResult,
  ProposalRevisionWriteResult,
  ProposalWriteResult,
  RecordProposalRevisionInput,
  SubmitProposalInput,
  VoteTypeListResult,
  VoteTypeReadResult,
  VoteTypeRecord,
  WriterStatus,
} from './foundation-db-writer.ts';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
type AdapterFailure = { ok: false; reason: BackendFailureReason; httpStatus: null };

const FAILURE_REASONS: readonly BackendFailureReason[] = Object.freeze([
  'invalid_request',
  'transport_error',
  'auth_error',
  'http_error',
  'response_malformed',
]);

const failureReason = (reason: string): BackendFailureReason =>
  (FAILURE_REASONS as readonly string[]).includes(reason)
    ? (reason as BackendFailureReason)
    : 'transport_error';

const closedFailure = (reason: string): AdapterFailure => ({
  ok: false,
  reason: failureReason(reason),
  httpStatus: null,
});

const proofFailure = (reason: string | undefined): AdapterFailure =>
  closedFailure(reason === 'invalid_request' ? 'invalid_request' : 'transport_error');

const WRITER_STATUSES: readonly string[] = Object.freeze([
  'found',
  'inserted',
  'updated',
  'existing',
  'conflict',
  'rejected',
  'unavailable',
  'invalid_request',
]);

const closedStatus = (reason: string): WriterStatus =>
  (reason === 'invalid_request' ? 'invalid_request' : 'unavailable') as WriterStatus;

const readStatus = (body: unknown, fallbackReason: string): { ok: boolean; status: WriterStatus; reason: string } => {
  if (!isPlainObject(body)) return { ok: false, status: closedStatus(fallbackReason), reason: fallbackReason };
  const status = typeof body.status === 'string' && WRITER_STATUSES.includes(body.status)
    ? (body.status as WriterStatus)
    : closedStatus(fallbackReason);
  const reason = typeof body.reason === 'string' && body.reason ? body.reason : fallbackReason;
  return { ok: body.ok === true, status, reason };
};

const payload = (body: unknown, key: string): unknown => (isPlainObject(body) ? body[key] ?? null : null);

export type BackendProofResolution =
  | { ok: true; proof: BackendProof }
  | { ok: false; reason: string };

export type ToolProofProvider = (ctx: unknown) => BackendProofResolution | null | undefined;

export interface BackendAdapterIdentity {
  platform: string;
  workspaceId: string;
  nativeChannelId: string;
}

export interface BackendReaderOptions extends BackendAdapterIdentity {
  transport: BackendTransport;
  getProof: () => BackendProofResolution;
}

export type BackendWriterOptions = BackendReaderOptions;

export const resolveInvocationProof = (
  provider: ToolProofProvider | undefined,
  ctx: unknown,
): BackendProofResolution => {
  if (typeof provider !== 'function') return { ok: false, reason: 'proof_unavailable' };
  let resolution: BackendProofResolution | null | undefined;
  try {
    resolution = provider(ctx);
  } catch {
    return { ok: false, reason: 'proof_unavailable' };
  }
  if (isPlainObject(resolution) && resolution.ok === true && isPlainObject(resolution.proof)) {
    return { ok: true, proof: resolution.proof as BackendProof };
  }
  const failed = resolution as { reason?: unknown } | null | undefined;
  const reason =
    isPlainObject(failed) && typeof failed.reason === 'string' && failed.reason
      ? failed.reason
      : 'proof_unavailable';
  return { ok: false, reason };
};

const identityInput = (
  identity: BackendAdapterIdentity,
  extra: Record<string, unknown>,
): Record<string, unknown> => ({
  platform: identity.platform,
  workspaceId: identity.workspaceId,
  channelId: identity.nativeChannelId,
  ...extra,
});

const unwrapOperationResult = (response: BackendResponse): BackendResponse => {
  if (!response.ok) return response;
  const body = response.body;
  if (!isPlainObject(body) || body.ok !== true || !isPlainObject(body.result)) {
    return { ok: false, reason: 'response_malformed', httpStatus: response.httpStatus };
  }
  return { ok: true, body: body.result, httpStatus: response.httpStatus };
};

/**
 * `/api/identity/resolve` answers with the resolution directly, so only `ok` has to be checked.
 */
const unwrapIdentity = (response: BackendResponse): BackendResponse => {
  if (!response.ok) return response;
  const body = response.body;
  if (!isPlainObject(body) || body.ok !== true) {
    return { ok: false, reason: 'response_malformed', httpStatus: response.httpStatus };
  }
  return response;
};

const IDENTITY_STATUSES: readonly string[] = Object.freeze([
  'resolved',
  'identity_not_linked',
  'identity_revoked',
  'identity_expired',
]);

const identityStatus = (value: unknown): SlackMemberStatus =>
  typeof value === 'string' && IDENTITY_STATUSES.includes(value)
    ? (value as SlackMemberStatus)
    : 'unavailable';

export function createBackendReader(options: BackendReaderOptions): FoundationDbReader {
  const { transport, getProof, ...identity } = options;
  if (!identity.platform || !identity.workspaceId || !identity.nativeChannelId) {
    throw new Error('backend adapter config: a resolved platform, workspace and channel are required');
  }

  const call = async (operation: string, input: unknown): Promise<BackendResponse | AdapterFailure> => {
    const proof = getProof();
    if (!proof?.ok) return proofFailure(proof?.reason);
    return transport.operations(operation, identityInput(identity, isPlainObject(input) ? input : {}), proof.proof);
  };

  const resolve = async (): Promise<BackendResponse | AdapterFailure> => {
    const proof = getProof();
    if (!proof?.ok) return proofFailure(proof?.reason);
    return unwrapIdentity(await transport.resolveIdentity(proof.proof));
  };

  const resolveSlackMember = async (platformUserId: string): Promise<SlackMemberResolution> => {
    const id = typeof platformUserId === 'string' ? platformUserId.trim() : '';
    if (!id) {
      return {
        status: 'invalid_request',
        reason: 'platform_user_id_invalid',
        contactId: null,
        matchedBy: null,
        isActiveContributor: false,
        isDirector: false,
        httpStatus: null,
      };
    }
    const response = await resolve();
    if (!response.ok) {
      return {
        status: 'unavailable',
        reason: response.reason,
        contactId: null,
        matchedBy: null,
        isActiveContributor: false,
        isDirector: false,
        httpStatus: response.httpStatus,
      };
    }
    const body = response.body as Record<string, unknown>;
    const status = identityStatus(body.status);
    const resolved = status === 'resolved';
    return {
      status,
      reason: status,
      contactId: resolved && typeof body.contact_id === 'string' ? body.contact_id : null,
      matchedBy: resolved ? 'platform_link' : null,
      isActiveContributor: resolved && body.is_active_contributor === true,
      isDirector: resolved && body.is_director === true,
      httpStatus: response.httpStatus,
    };
  };

  const readAvailableFunds = async (currency: string): Promise<AvailableFunds> => {
    const code = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
    const closed = (status: AvailableFundsStatus, reason: string, httpStatus: number | null): AvailableFunds => ({
      status,
      reason,
      currency: code || null,
      availableMinor: null,
      recordedAt: null,
      recordedBy: null,
      sourceNote: null,
      httpStatus,
      authorizesSpending: false,
    });
    const response = unwrapOperationResult(await call('available_funds', { currency: code }));
    if (!response.ok) {
      return closed('unavailable', response.reason, response.httpStatus);
    }
    const body = response.body as Record<string, unknown>;
    const status = typeof body.status === 'string' ? (body.status as AvailableFundsStatus) : 'unavailable';
    return {
      status,
      reason: typeof body.reason === 'string' ? body.reason : 'unavailable',
      currency: typeof body.currency === 'string' ? body.currency : code || null,
      availableMinor: typeof body.availableMinor === 'number' ? body.availableMinor : null,
      recordedAt: typeof body.recordedAt === 'string' ? body.recordedAt : null,
      recordedBy: typeof body.recordedBy === 'string' ? body.recordedBy : null,
      sourceNote: typeof body.sourceNote === 'string' ? body.sourceNote : null,
      httpStatus: response.httpStatus,
      authorizesSpending: false,
    };
  };

  return Object.freeze({
    environment: 'dev' as const,
    tablePrefix: 'backend_',
    resolveSlackMember,
    readAvailableFunds,
  });
}

const ACTOR_FIELD_PATTERN = /ContactId$|contact_id$|actor|caller|proof|assertion|credential|senderId|memberId/;

export const stripActorFields = (input: unknown): Record<string, unknown> => {
  if (!isPlainObject(input)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (ACTOR_FIELD_PATTERN.test(key)) continue;
    out[key] = value;
  }
  return out;
};

export function createBackendWriter(options: BackendWriterOptions): FoundationDbWriter {
  const { transport, getProof, ...identity } = options;
  if (!identity.platform || !identity.workspaceId || !identity.nativeChannelId) {
    throw new Error('backend adapter config: a resolved platform, workspace and channel are required');
  }

  const call = async (
    operation: string,
    input: unknown,
  ): Promise<BackendResponse | AdapterFailure> => {
    const proof = getProof();
    if (!proof?.ok) return proofFailure(proof?.reason);
    return transport.operations(operation, identityInput(identity, stripActorFields(input)), proof.proof);
  };

  const envelope = (
    response: BackendResponse | AdapterFailure,
    key: string,
  ): { ok: boolean; status: WriterStatus; reason: string; value: unknown; httpStatus: number | null } => {
    if (!response.ok) {
      return {
        ok: false,
        status: closedStatus(response.reason),
        reason: response.reason,
        value: null,
        httpStatus: response.httpStatus,
      };
    }
    const state = readStatus(response.body, 'response_malformed');
    return { ...state, value: payload(response.body, key), httpStatus: response.httpStatus };
  };

  const submitProposal = async (input: SubmitProposalInput): Promise<ProposalWriteResult> => {
    const r = envelope(unwrapOperationResult(await call('submit_proposal', input)), 'proposal');
    return {
      ok: r.ok,
      status: r.status,
      reason: r.reason,
      proposal: r.value as ProposalRecord | null,
      httpStatus: r.httpStatus,
      authorizesSpending: false,
    };
  };
  const createPoll = async (input: CreatePollInput): Promise<PollWriteResult> => {
    const r = envelope(unwrapOperationResult(await call('create_poll', input)), 'poll');
    return { ok: r.ok, status: r.status, reason: r.reason, poll: r.value as PollRecord | null, httpStatus: r.httpStatus };
  };
  const castBallot = async (input: CastBallotInput): Promise<BallotWriteResult> => {
    const r = envelope(unwrapOperationResult(await call('cast_ballot', input)), 'ballot');
    return {
      ok: r.ok,
      status: r.status,
      reason: r.reason,
      ballot: r.value as BallotSummary | null,
      httpStatus: r.httpStatus,
    };
  };
  const getPoll = async (id: string): Promise<PollReadResult> => {
    const r = envelope(unwrapOperationResult(await call('get_poll', { id })), 'poll');
    return { ok: r.ok, status: r.status, reason: r.reason, poll: r.value as PollRecord | null, httpStatus: r.httpStatus };
  };
  const getProposal = async (id: string): Promise<ProposalReadResult> => {
    const r = envelope(unwrapOperationResult(await call('get_proposal', { id })), 'proposal');
    return {
      ok: r.ok,
      status: r.status,
      reason: r.reason,
      proposal: r.value as ProposalRecord | null,
      httpStatus: r.httpStatus,
    };
  };
  const listBallots = async (pollId: string): Promise<BallotListResult> => {
    const r = envelope(unwrapOperationResult(await call('list_ballots', { pollId })), 'ballots');
    return {
      ok: r.ok,
      status: r.status,
      reason: r.reason,
      ballots: r.value as readonly BallotRecord[] | null,
      httpStatus: r.httpStatus,
    };
  };
  const getVoteType = async (voteType: string): Promise<VoteTypeReadResult> => {
    const r = envelope(unwrapOperationResult(await call('get_vote_type', { voteType })), 'voteType');
    return {
      ok: r.ok,
      status: r.status,
      reason: r.reason,
      voteType: r.value as VoteTypeRecord | null,
      httpStatus: r.httpStatus,
    };
  };
  const listVoteTypes = async (input?: { limit?: number | null }): Promise<VoteTypeListResult> => {
    const r = envelope(unwrapOperationResult(await call('list_vote_types', input ?? {})), 'voteTypes');
    return {
      ok: r.ok,
      status: r.status,
      reason: r.reason,
      voteTypes: r.value as readonly string[] | null,
      httpStatus: r.httpStatus,
    };
  };
  const listCandidateProposals = async (
    input: ListCandidateProposalsInput,
  ): Promise<CandidateProposalListResult> => {
    const r = envelope(unwrapOperationResult(await call('list_candidate_proposals', input)), 'proposals');
    return {
      ok: r.ok,
      status: r.status,
      reason: r.reason,
      proposals: r.value as readonly ProposalRecord[] | null,
      httpStatus: r.httpStatus,
    };
  };
  const finalizePoll = async (input: FinalizePollInput): Promise<PollFinalizationResult> => {
    const r = envelope(unwrapOperationResult(await call('finalize_poll', { pollId: input.pollId })), 'finalization');
    return {
      ok: r.ok,
      status: r.status,
      reason: r.reason,
      finalization: r.value as PollFinalizationRecord | null,
      httpStatus: r.httpStatus,
    };
  };
  const recordProposalRevision = async (
    input: RecordProposalRevisionInput,
  ): Promise<ProposalRevisionWriteResult> => {
    const r = envelope(unwrapOperationResult(await call('record_proposal_revision', input)), 'revision');
    return {
      ok: r.ok,
      status: r.status,
      reason: r.reason,
      revision: r.value as ProposalRevisionRecord | null,
      httpStatus: r.httpStatus,
    };
  };
  const getRevision = async (id: string): Promise<ProposalRevisionReadResult> => {
    const r = envelope(unwrapOperationResult(await call('get_revision', { id })), 'revision');
    return {
      ok: r.ok,
      status: r.status,
      reason: r.reason,
      revision: r.value as ProposalRevisionRecord | null,
      httpStatus: r.httpStatus,
    };
  };
  const approveProposalRevision = async (
    input: ApproveProposalRevisionInput,
  ): Promise<ProposalRevisionApprovalResult> => {
    const r = envelope(unwrapOperationResult(await call('approve_proposal_revision', { revisionId: input.revisionId })), 'revision');
    return {
      ok: r.ok,
      status: r.status,
      reason: r.reason,
      revision: r.value as ProposalRevisionRecord | null,
      httpStatus: r.httpStatus,
    };
  };
  const applyProposalRevision = async (
    input: ApplyProposalRevisionInput,
  ): Promise<AppliedProposalVersionResult> => {
    const r = envelope(unwrapOperationResult(await call('apply_proposal_revision', { revisionId: input.revisionId })), 'version');
    return {
      ok: r.ok,
      status: r.status,
      reason: r.reason,
      version: r.value as AppliedProposalVersionRecord | null,
      httpStatus: r.httpStatus,
    };
  };

  return Object.freeze({
    environment: 'dev' as const,
    tablePrefix: 'backend_',
    submitProposal,
    createPoll,
    castBallot,
    getPoll,
    getProposal,
    listBallots,
    getVoteType,
    listVoteTypes,
    listCandidateProposals,
    finalizePoll,
    recordProposalRevision,
    getRevision,
    approveProposalRevision,
    applyProposalRevision,
  });
}
