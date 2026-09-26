// OpenClaw v2 tool bridge for the Board voting surface (PRD R10-R16; AC05-AC08, AC16, AC17).
//
// It turns the deterministic governance store into three agent tools without owning the runtime
// registration: the caller supplies exactly one configured chat platform, the native Board channel
// ids that platform may act in, a durable governance store, and a synchronous getter for the
// current authoritative registry snapshot.
//
// Trust boundary:
// - The acting account comes only from the host tool context (`messageChannel`, `nativeChannelId`,
//   `requesterSenderId`). No tool argument is ever read as an actor, and known impersonation keys
//   are rejected outright.
// - Board eligibility is decided by the injected authoritative registry snapshot and the
//   `registry-snapshot.ts` check. The canonical `memberId` that check returns is the actor recorded
//   by the store; the platform account id is never persisted by this bridge.
// - `assertCurrentInvocation` runs immediately before the store mutation, so a revoked or stale
//   turn cannot commit.
// - Missing configuration registers no tools (`create` returns null).
//
// Deliberate scope limits:
// - No round creation, no policy default, no funding allocation, no external message. This module
//   never calls `openRound`, never applies `prdR14DiscussionDefaultRules`, never reserves or pays
//   money and never talks to a chat platform. Opening a frozen round, with its explicit approval
//   reference, stays an operator action.
// - The read-only round result reports the engine's counting and budget bookkeeping only. It omits
//   per-proposal allocation decisions, individual ballots, recusal reasons and platform account ids,
//   so it cannot announce a disbursement or expose how one member voted.
//
// Retry semantics (honest limit):
// - OpenClaw's v2 tool context carries no trusted inbound message or event id, only the `toolCallId`
//   handed to `execute`. A retried invocation replays through the store receipt key, which is scoped
//   to platform, canonical member, action, call id and an argument fingerprint. A caller that
//   invents a fresh call id is not stopped by this layer; the engine's own ballot rules (for example
//   `voteReplacement`) govern a genuinely new submission, and no exactly-once claim is made here.
// - Reusing one call id with changed ballot arguments is not silently accepted: the argument
//   fingerprint makes the retry a different store key, so it reaches the engine, where the
//   call-id-scoped ballot idempotency key turns a changed choice or proposal into a durable
//   `idempotency_key_conflict` rejection. A recusal has no engine idempotency key, so a reused call
//   id with a different recusal proposal or reason is decided by the recusal rules and stays visible
//   in the audit trail instead of being suppressed.

import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { assertCurrentInvocation } from './request-context.ts';
import { checkBoardEligibility as checkBoardEligibilityInSnapshot } from './registry-snapshot.ts';

/** Names the caller must declare in the manifest and pass to `registerTool(..., { names })`. */
export const GOVERNANCE_TOOL_NAMES = Object.freeze([
  'rein_governance_vote',
  'rein_governance_recuse',
  'rein_governance_round_result',
]);

export class GovernanceToolBridgeError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GovernanceToolBridgeError';
    this.code = code;
    this.details = details;
  }
}

export interface BoardEligibilityVerdict {
  eligible: boolean;
  reason: string;
  memberId: string | null;
}

/**
 * The bridge only depends on these three store methods, so the local rehearsal store
 * (`governance-store.ts`) or a future production store can satisfy it without changes here.
 */
export interface GovernanceToolStorePort {
  castBallot: (input: {
    roundId: string;
    ballot: { proposalId: string; memberId?: string | null; choice: string; idempotencyKey?: string | null };
    actor?: string;
    at?: string;
    idempotencyKey: string;
    context?: Record<string, unknown> | null;
  }) => Record<string, any>;
  declareRecusal: (input: {
    roundId: string;
    recusal: { proposalId: string; memberId?: string | null; reason: string };
    actor?: string;
    at?: string;
    idempotencyKey: string;
    context?: Record<string, unknown> | null;
  }) => Record<string, any>;
  tallyRound: (input: { roundId: string }) => Record<string, any>;
}

export interface GovernanceToolBridgeOptions {
  /** Exactly one configured chat platform, for example the P0 platform once decided. */
  platform?: string;
  /** Native channel ids this platform may act in. Empty means unconfigured. */
  boardNativeChannelIds?: string[];
  /** Durable governance store implementing {@link GovernanceToolStorePort}. */
  store?: GovernanceToolStorePort;
  /**
   * Synchronous getter for the current authoritative registry snapshot. Required: without it the
   * bridge registers no tools, because it must never decide Board eligibility from a prompt.
   */
  getRegistrySnapshot?: () => unknown;
  /**
   * Board eligibility check. Defaults to `checkBoardEligibility` from `registry-snapshot.ts`; a
   * production adapter may inject its own provider-backed check with the same contract.
   */
  checkBoardEligibility?: (
    snapshot: unknown,
    args: { platform: string; accountId: string; at: string },
  ) => BoardEligibilityVerdict;
  /** Injectable clock for deterministic tests; defaults to the wall clock. */
  now?: () => string;
}

// Host-supplied identity keys a model must never be able to set. `roundId`, `proposalId`, `choice`
// and `reason` are legitimate tool arguments; these are not.
const IMPERSONATION_KEYS = Object.freeze([
  'actor',
  'account',
  'accountId',
  'member',
  'memberId',
  'voter',
  'voterId',
  'voterMemberId',
  'senderId',
  'requesterSenderId',
  'claimedActor',
  'platform',
  'weight',
  'role',
  'roles',
  'eligible',
  'isBoard',
  'castAt',
  'recordedAt',
]);

const clone = (value: any) => (value === undefined ? undefined : structuredClone(value));

const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 32);

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

interface ResolvedBridgeOptions {
  platform: string;
  boardNativeChannelIds: string[];
  store: GovernanceToolStorePort;
  getRegistrySnapshot: () => unknown;
  checkBoardEligibility: NonNullable<GovernanceToolBridgeOptions['checkBoardEligibility']>;
  now: () => string;
}

// Absent or incomplete configuration yields null so the caller registers no tools.
function normalizeOptions(options: unknown): ResolvedBridgeOptions | null {
  if (!options || typeof options !== 'object') return null;
  const source = options as GovernanceToolBridgeOptions;
  const platform = text(source.platform);
  const boardNativeChannelIds = Array.isArray(source.boardNativeChannelIds)
    ? source.boardNativeChannelIds.filter((id) => text(id)).map((id) => text(id) as string)
    : [];
  const store = source.store;
  const storeReady =
    Boolean(store) &&
    typeof (store as GovernanceToolStorePort).castBallot === 'function' &&
    typeof (store as GovernanceToolStorePort).declareRecusal === 'function' &&
    typeof (store as GovernanceToolStorePort).tallyRound === 'function';
  const getRegistrySnapshot = source.getRegistrySnapshot;
  const snapshotReady = typeof getRegistrySnapshot === 'function';
  if (!platform || boardNativeChannelIds.length === 0 || !storeReady || !snapshotReady) return null;
  const checkBoardEligibility =
    typeof source.checkBoardEligibility === 'function'
      ? source.checkBoardEligibility
      : (checkBoardEligibilityInSnapshot as unknown as ResolvedBridgeOptions['checkBoardEligibility']);
  const now = typeof source.now === 'function' ? source.now : () => new Date().toISOString();
  return {
    platform,
    boardNativeChannelIds,
    store: store as GovernanceToolStorePort,
    getRegistrySnapshot: getRegistrySnapshot as () => unknown,
    checkBoardEligibility,
    now,
  };
}

function assertNoImpersonationArgs(args: unknown) {
  if (!args || typeof args !== 'object') return;
  for (const key of IMPERSONATION_KEYS) {
    if (Object.hasOwn(args, key)) {
      throw new GovernanceToolBridgeError(
        'actor_argument_rejected',
        `The "${key}" argument is not accepted; the acting account comes only from the host context.`,
        { key },
      );
    }
  }
}

function requireToolCallId(toolCallId: unknown): string {
  if (typeof toolCallId !== 'string' || !toolCallId.trim()) {
    throw new GovernanceToolBridgeError(
      'tool_call_id_required',
      'The host tool call id is required to scope the retry key.',
    );
  }
  return toolCallId.trim();
}

function errorResult(action: string, error: unknown) {
  const cause = error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined;
  const causeCode =
    cause && typeof cause === 'object' && typeof (cause as { code?: unknown }).code === 'string'
      ? (cause as { code: string }).code
      : null;
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'tool_failed';
  const details: Record<string, unknown> = {
    action,
    ok: false as const,
    error: code,
    message: describe(error),
  };
  if (error instanceof GovernanceToolBridgeError) Object.assign(details, error.details);
  if (causeCode) details.causeCode = causeCode;
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
}

/**
 * Resolve the acting Board member from the host context and the injected authoritative registry
 * snapshot. Anything unresolved fails closed with a specific reason instead of guessing an actor.
 */
function resolveBoardRequester(ctx: any, config: ResolvedBridgeOptions, at: string) {
  const { platform, boardNativeChannelIds, getRegistrySnapshot, checkBoardEligibility } = config;
  if (!ctx || ctx.messageChannel !== platform) {
    throw new GovernanceToolBridgeError(
      'trusted_requester_unavailable',
      'The host context does not carry the configured chat platform.',
    );
  }
  const accountId = text(ctx.requesterSenderId);
  const nativeChannelId = text(ctx.nativeChannelId);
  if (!accountId || !nativeChannelId) {
    throw new GovernanceToolBridgeError(
      'trusted_requester_unavailable',
      'The host context carries no trusted sender or native channel.',
    );
  }
  if (!boardNativeChannelIds.includes(nativeChannelId)) {
    throw new GovernanceToolBridgeError(
      'channel_out_of_scope',
      `Channel ${nativeChannelId} is outside the configured Board channel scope.`,
      { nativeChannelId },
    );
  }

  let snapshot: unknown;
  try {
    snapshot = getRegistrySnapshot();
  } catch (error) {
    throw new GovernanceToolBridgeError(
      'registry_snapshot_unavailable',
      `The authoritative registry snapshot could not be read: ${describe(error)}`,
    );
  }
  const snapshotShape = snapshot as Record<string, any> | null | undefined;
  if (
    !snapshotShape ||
    typeof snapshotShape !== 'object' ||
    typeof snapshotShape.generatedAtMs !== 'number' ||
    typeof snapshotShape.maxAgeMs !== 'number' ||
    !snapshotShape.members ||
    typeof snapshotShape.members !== 'object' ||
    Array.isArray(snapshotShape.members) ||
    !snapshotShape.links ||
    typeof snapshotShape.links !== 'object' ||
    Array.isArray(snapshotShape.links)
  ) {
    throw new GovernanceToolBridgeError(
      'registry_snapshot_unavailable',
      'The authoritative registry getter did not return a validated registry snapshot.',
    );
  }

  let verdict: BoardEligibilityVerdict | null = null;
  try {
    verdict = checkBoardEligibility(snapshot, { platform, accountId, at });
  } catch (error) {
    throw new GovernanceToolBridgeError(
      'registry_check_failed',
      `The Board eligibility check could not be completed: ${describe(error)}`,
    );
  }
  if (!verdict || typeof verdict !== 'object') {
    throw new GovernanceToolBridgeError(
      'registry_check_failed',
      'The Board eligibility check returned no verdict.',
    );
  }
  const reason = text(verdict.reason) ?? 'board_eligibility_unresolved';
  if (verdict.eligible !== true) {
    throw new GovernanceToolBridgeError('board_eligibility_required', reason, { reason });
  }
  const memberId = text(verdict.memberId);
  if (!memberId) {
    throw new GovernanceToolBridgeError(
      'board_eligibility_required',
      'The Board eligibility check returned no canonical member id.',
      { reason },
    );
  }
  return Object.freeze({ platform, accountId, nativeChannelId, memberId });
}

const voteArguments = (args: any) => ({
  roundId: text(args?.roundId),
  proposalId: text(args?.proposalId),
  choice: text(args?.choice),
});

const recusalArguments = (args: any) => ({
  roundId: text(args?.roundId),
  proposalId: text(args?.proposalId),
  reason: text(args?.reason),
});

// The round result is projected field by field so a later engine field cannot leak a ballot, a
// recusal reason, a platform account id or an allocation decision through this tool.
const projectProposalTally = (proposal: any) => ({
  proposalId: proposal?.proposalId ?? null,
  proposalVersion: proposal?.proposalVersion ?? null,
  leadMemberId: proposal?.leadMemberId ?? null,
  requestedAmountMinor: proposal?.requestedAmountMinor ?? null,
  recusedMemberIds: Array.isArray(proposal?.recusedMemberIds) ? [...proposal.recusedMemberIds] : [],
  eligibleMemberCount: proposal?.eligibleMemberCount ?? null,
  eligibleWeight: proposal?.eligibleWeight ?? null,
  requiredParticipatingMembers: proposal?.requiredParticipatingMembers ?? null,
  requiredParticipatingWeight: proposal?.requiredParticipatingWeight ?? null,
  participatingMemberCount: proposal?.participatingMemberCount ?? null,
  participatingWeight: proposal?.participatingWeight ?? null,
  participation: proposal?.participation ? { ...proposal.participation } : null,
  counts: proposal?.counts ? { ...proposal.counts } : null,
  weights: proposal?.weights ? { ...proposal.weights } : null,
  nonAbstainingWeight: proposal?.nonAbstainingWeight ?? null,
  approvalShareOfNonAbstaining: proposal?.approvalShareOfNonAbstaining ?? null,
  status: proposal?.status ?? null,
  passed: proposal?.passed === true,
  reasons: Array.isArray(proposal?.reasons) ? [...proposal.reasons] : [],
});

const projectRoundResult = (round: any) => ({
  roundId: round?.roundId ?? null,
  rulesVersion: round?.rulesVersion ?? null,
  currency: round?.currency ?? null,
  proposals: Array.isArray(round?.proposals) ? round.proposals.map(projectProposalTally) : [],
  budget: round?.budget ? { ...round.budget } : null,
  awaitingFundingAllocation: Array.isArray(round?.awaitingFundingAllocation)
    ? [...round.awaitingFundingAllocation]
    : [],
  outstanding: Array.isArray(round?.outstanding) ? [...round.outstanding] : [],
});

function buildTools(config: ResolvedBridgeOptions, ctx: any) {
  const { platform, store, now } = config;

  const guard = (action: string, args: unknown, handler: () => unknown) => {
    try {
      assertNoImpersonationArgs(args);
      return handler();
    } catch (error) {
      return errorResult(action, error);
    }
  };

  const write = ({
    action,
    toolCallId,
    args,
    run,
  }: {
    action: 'cast_ballot' | 'declare_recusal';
    toolCallId: unknown;
    args: any;
    run: (input: {
      requester: { platform: string; accountId: string; nativeChannelId: string; memberId: string };
      at: string;
      callId: string;
      receiptKey: string;
      ballotKey: string;
    }) => Record<string, any>;
  }) => {
    const at = now();
    const requester = resolveBoardRequester(ctx, config, at);
    const callId = requireToolCallId(toolCallId);
    const normalized = action === 'cast_ballot' ? voteArguments(args) : recusalArguments(args);
    // The argument fingerprint is part of the receipt key so a reused call id with different
    // arguments cannot replay the stored receipt; it reaches the engine instead, which rejects the
    // conflict. The engine ballot key stays scoped to the call id alone so it can see the conflict.
    const receiptKey = `${platform}:${requester.memberId}:${action}:${callId}:${fingerprint(normalized)}`;
    const ballotKey = `governance-tool:${platform}:${requester.memberId}:${callId}`;

    // The current-invocation guard is the last step before the store mutation.
    assertCurrentInvocation(ctx);
    const result = run({ requester, at, callId, receiptKey, ballotKey });

    const accepted = result?.accepted === true;
    const reason = typeof result?.reason === 'string' ? result.reason : null;
    const replacedSequence = Number.isInteger(result?.replacedSequence) ? result.replacedSequence : null;
    const details: Record<string, unknown> = {
      action: action === 'cast_ballot' ? 'vote' : 'recuse',
      ok: accepted,
      roundId: normalized.roundId,
      proposalId: normalized.proposalId,
      accepted,
      duplicated: result?.duplicated === true,
      replacedSequence,
      replaced: replacedSequence !== null,
      reason,
      recordedAt: at,
      replayed: result?.replayed === true,
      revision: typeof result?.revision === 'number' ? result.revision : null,
      result: clone(result),
    };
    if (action === 'cast_ballot') details.choice = normalized.choice;
    return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
  };

  return [
    {
      name: 'rein_governance_vote',
      label: 'Record a Board vote',
      description:
        'Record your own approve, reject or abstain ballot on one frozen round proposal. Board eligibility and the voting window are enforced from the authoritative record; the acting account and canonical member come only from the host context, never from arguments.',
      parameters: Type.Object(
        {
          roundId: Type.String({ minLength: 1, maxLength: 64 }),
          proposalId: Type.String({ minLength: 1, maxLength: 64 }),
          choice: Type.Union([Type.Literal('approve'), Type.Literal('reject'), Type.Literal('abstain')]),
        },
        { additionalProperties: false },
      ),
      async execute(toolCallId: unknown, args: any) {
        return guard('vote', args, () =>
          write({
            action: 'cast_ballot',
            toolCallId,
            args,
            run: ({ requester, at, callId, receiptKey, ballotKey }) =>
              store.castBallot({
                roundId: args?.roundId,
                // The trusted requester is the voter, and the recorded actor is the canonical
                // member id, so the store's actor/member check cannot be satisfied by an argument.
                actor: requester.memberId,
                ballot: {
                  proposalId: args?.proposalId,
                  memberId: requester.memberId,
                  choice: args?.choice,
                  idempotencyKey: ballotKey,
                },
                at,
                idempotencyKey: receiptKey,
                context: {
                  platform: requester.platform,
                  nativeChannelId: requester.nativeChannelId,
                  toolCallId: callId,
                },
              }),
          }),
        );
      },
    },
    {
      name: 'rein_governance_recuse',
      label: 'Declare a Board recusal',
      description:
        'Declare your own recusal from one proposal in a frozen round, with a reason. A recusal is refused once a ballot exists for that proposal, and it is refused for a member who is not currently eligible.',
      parameters: Type.Object(
        {
          roundId: Type.String({ minLength: 1, maxLength: 64 }),
          proposalId: Type.String({ minLength: 1, maxLength: 64 }),
          reason: Type.String({ minLength: 1, maxLength: 1000 }),
        },
        { additionalProperties: false },
      ),
      async execute(toolCallId: unknown, args: any) {
        return guard('recuse', args, () =>
          write({
            action: 'declare_recusal',
            toolCallId,
            args,
            run: ({ requester, at, callId, receiptKey }) =>
              store.declareRecusal({
                roundId: args?.roundId,
                actor: requester.memberId,
                recusal: {
                  proposalId: args?.proposalId,
                  memberId: requester.memberId,
                  reason: args?.reason,
                },
                at,
                idempotencyKey: receiptKey,
                context: {
                  platform: requester.platform,
                  nativeChannelId: requester.nativeChannelId,
                  toolCallId: callId,
                },
              }),
          }),
        );
      },
    },
    {
      name: 'rein_governance_round_result',
      label: 'Read a Board round result',
      description:
        'Read the counting and budget summary of one frozen round for the current Board. Read-only: it never opens a round, allocates funds or sends a message, and it reports aggregate counts, weights, participation, recusals and outstanding items without individual ballots or recusal reasons.',
      parameters: Type.Object(
        { roundId: Type.String({ minLength: 1, maxLength: 64 }) },
        { additionalProperties: false },
      ),
      async execute(_toolCallId: unknown, args: any) {
        return guard('round_result', args, () => {
          const at = now();
          const requester = resolveBoardRequester(ctx, config, at);
          const round = store.tallyRound({ roundId: args?.roundId });
          const details: Record<string, unknown> = {
            action: 'round_result',
            ok: true,
            roundId: args?.roundId,
            readAt: at,
            readBy: requester.memberId,
            result: clone(projectRoundResult(round)),
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
        });
      },
    },
  ];
}

/**
 * Build a v2 tool factory for the Board voting surface. Register it as
 * `api.registerTool(createGovernanceToolRegistration(options), { names: GOVERNANCE_TOOL_NAMES })`.
 * When configuration is absent, `create` returns null and the runtime registers no tools.
 */
export function createGovernanceToolRegistration(options?: GovernanceToolBridgeOptions) {
  const config = normalizeOptions(options);
  return {
    contextVersion: 2 as const,
    create(ctx: any) {
      if (!config) return null;
      return buildTools(config, ctx);
    },
  };
}
