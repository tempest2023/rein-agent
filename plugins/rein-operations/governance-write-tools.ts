// governance write tools: Contributor proposal intake, Board approval polls, one immutable ballot per
// director per poll, and the round result.
//
// Scope: PRD R02 (a chat account acts only after an explicit link to a community record, and a
// display name never establishes identity), R04-R08 with D04/D08/D09 (approval-only voting: one
// equal weight per eligible director, explicit approvals or abstain, no reject choice), C15 (a
// requested amount is a request, never an authorization) and the fail-closed posture of AC01/AC06.
// This module registers only under an explicit `foundationDb` config block, exactly like `governance-read-tools.ts`.
//
// Trust boundary:
// - The acting account comes only from `ctx.requesterSenderId`, the approved channel only from
//   `ctx.nativeChannelId`. No tool argument is ever read as an actor, known impersonation and role
//   arguments are refused before any database call, and the caller must be inside an approved
//   native channel before any read or write happens.
// - `assertCurrentInvocation` is re-checked immediately before a write and before any answer leaves
//   the turn, so a cancelled or stale turn cannot commit or report.
// - A confirmation token is honoured only by a later host turn than the one that minted it. One
//   `buildTools` factory instance is one host turn, so a token this instance minted is refused by
//   this instance before any write; only a fresh instance may verify it.
// - Every refusal collapses to a fixed reason code. A Supabase URL, the Slack team id, a credential
//   and the private contact id resolved from the identity link never reach a result, a status or an
//   error message.
//
// Status of this module:
// - `rein_poll_vote` is wired to `foundation-db-writer.ts`: it reads the stored poll, refuses a
//   closed or not-yet-open window, refuses an approval outside the poll's candidate list or above
//   the poll's own approval limit, re-checks the invocation guard and then records one immutable
//   ballot. The database stays the authority for every one of those rules.
// - `rein_governance_proposal_submit` is wired: the only proposer is the trusted sender's own linked,
//   currently active Contributor record, the named vote type is validated as lower snake case and
//   then left to the database's type configuration and foreign key, a requested amount is stored as
//   a request, and the record identifier is minted once per turn and reused when the host retries
//   the same tool call in that turn.
// - `rein_poll_open` is wired: a current director opens one round of a named vote type, the tool
//   reads that type's own candidate cap, assembles the candidate pool from stored proposals
//   (offering recently unselected proposals too, and leaving out every proposal an open round of any
//   type already froze) and lets the database freeze the list. No caller supplies candidates, a
//   candidate limit or option labels, and a round needs at least one candidate. The answer names the
//   frozen identifiers together with their stored titles, so a spoken proposal name is resolved
//   against the round's own frozen list instead of being guessed.
// - `rein_poll_result` is wired: before the deadline it returns the readable facts of the round,
//   which are the stored window and the round's frozen candidates with their stored titles, and
//   answers `provisional` with no count, no winner, no participation total and no voter identity; the
//   frozen list is what a later director turn maps a spoken name against. At or after the deadline
//   it calls `writer.finalizePoll` with the trusted sender's own director record, so the database
//   closes the round and the stored outcome is what comes back.
//   A finalized round reports its own recorded outcome on every later call rather than counting
//   again, and a tie or an all-abstain round keeps its `no_winner` outcome. This module never counts
//   ballots into an outcome of its own and never reads a caller-supplied weight.
// - Both result branches carry a small `narration` object: the outcome, the winning proposal title,
//   the participation total and the abstention count of a closed round, and nothing outcome-shaped
//   while the round is open. `delivery: 'model_relayed'` is transport metadata, not a claim a reply
//   should repeat and not a delivery guarantee: this module posts nothing to a channel and never
//   reads one back. `finalized` and `settled` are the database's own record, never a statement that
//   the organization adopted the outcome as a governance rule. `note` holds the short user-facing
//   wording, and it names no implementation term.
// - The candidate titles are read from the proposals table, never assumed to sit on the poll row.
//   A title the database cannot answer for stays null and the answer says so, and two frozen
//   candidates that share one title are named as ambiguous, so a caller asks which one is meant
//   instead of this module mapping a spoken name onto an identifier.
// - Every wired path reaches only the writer methods the backend adapter exposes.
//
// Nothing in this module posts a message, and no tool here authorizes, moves or records money: a
// stored proposal is a request and a poll outcome is a decision record.

import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import {
  createConfiguredTransport,
  createInvocationAdapters,
  parseBackendConfig,
  resolveTrustedWorkspace,
  type ResolvedBackendConfig,
} from './backend-config.ts';
import type { ToolProofProvider } from './backend-db-adapter.ts';
import type { BackendTransport } from './backend-transport.ts';
import {
  MAX_CONFIRMATION_TOKEN_LENGTH,
  confirmationPreview,
  issueProposalConfirmation,
  proposalIdForConfirmation,
  verifyProposalConfirmation,
} from './proposal-confirmation.ts';
import { assertCurrentInvocation } from './request-context.ts';
import type {
  FoundationDbWriter,
  PollRecord,
  PollFinalizationRecord,
  ProposalRecord,
  VoteTypeRecord,
} from './foundation-db-writer.ts';
import type { SlackMemberResolution } from './foundation-db-reader.ts';

/** Names the caller must declare in the manifest and pass to `registerTool(..., { names })`. */
export const GOVERNANCE_WRITE_TOOL_NAMES = Object.freeze([
  'rein_governance_proposal_submit',
  'rein_poll_open',
  'rein_poll_vote',
  'rein_poll_result',
]);

export class GovernanceWriteToolError extends Error {
  readonly code: string;
  /** Extra facts a refusal may carry, such as the names an operator did configure. */
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GovernanceWriteToolError';
    this.code = code;
    this.details = details;
  }
}

/** The one reader method this slice uses: resolve a trusted Slack sender to a community record. */
export interface GovernanceWriteToolReader {
  resolveSlackMember(slackUserId: string): Promise<SlackMemberResolution>;
}

/**
 * The writer methods this module calls: the proposal and poll writes, the stored poll and ballot
 * reads the ballot path and the result path perform, the vote type rule and candidate pool the
 * poll path assembles a round from, and the finalize RPC the result path submits after the
 * deadline. Every one of them keeps the database as the authority for the per-type caps, for the
 * frozen candidate list and for the counted outcome.
 */
export type GovernanceWriteToolWriter = Pick<
  FoundationDbWriter,
  | 'submitProposal'
  | 'createPoll'
  | 'getPoll'
  | 'getProposal'
  | 'listBallots'
  | 'castBallot'
  | 'getVoteType'
  | 'listVoteTypes'
  | 'listCandidateProposals'
  | 'finalizePoll'
>;

export interface GovernanceWriteToolsOptions {
  /**
   * The `foundationDb` block of plugin config, read as untrusted input. Expected keys: `enabled`, `platform`
   * `workspaces`, `proposalChannelIds`, `boardChannelIds`, `voteTypeAliases`, and the environment
   * variables naming the backend base URL, the Agent caller ID, the Agent credential and the
   * proposal-confirmation signing key. The environment-variable keys name server variables; no
   * credential is ever read from config. Absent or `enabled: false` registers no tools.
   */
  config?: Record<string, unknown>;
  /** Server environment holding the referenced values. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injectable backend transport for tests and local rehearsal; skips the env-var lookups. */
  transport?: BackendTransport;
  /** Runtime ingress proof for one tool invocation. Called at execution time, never at registration. */
  proofProvider?: ToolProofProvider;
  /** Injectable reader for tests and local rehearsal; skips the env-var lookups. */
  reader?: GovernanceWriteToolReader;
  /** Injectable writer for tests and local rehearsal; skips the env-var lookups. */
  writer?: GovernanceWriteToolWriter;
  /**
   * Injectable confirmation signing key for tests and local rehearsal. When omitted, the key is
   * read from the server environment variable named by `foundationDb.proposalConfirmationKeyEnvVar`.
   */
  confirmationSigningKey?: string;
  /** Injectable clock for deterministic rehearsal; defaults to the wall clock. */
  now?: () => Date;
}

export interface ResolvedGovernanceWriteConfig {
  config: ResolvedBackendConfig;
  proposalChannelIds: string[];
  boardChannelIds: string[];
  transport: BackendTransport;
  proofProvider?: ToolProofProvider;
  reader?: GovernanceWriteToolReader;
  writer?: GovernanceWriteToolWriter;
  /** Server-only key that signs one proposal confirmation token. Never leaves the process. */
  confirmationSigningKey: string;
  now: () => Date;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
/** Lower snake case, exactly the shape the vote type table stores. */
const VOTE_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_TITLE_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 4000;
const MAX_APPROVALS = 200;
/** Upper bound on the type names one read returns; the table is operator configuration. */
const MAX_CONFIGURED_VOTE_TYPES = 200;

// Host-supplied identity and role keys a model must never be able to set. A role or an actor that
// arrives as an argument would let a prompt grant Board authority, which R02 refuses outright.
const IMPERSONATION_KEYS = Object.freeze([
  'actor',
  'account',
  'accountId',
  'contactId',
  'creatorContactId',
  'member',
  'memberId',
  'participant',
  'platform',
  'proposerContactId',
  'requesterSenderId',
  'role',
  'senderId',
  'claimedActor',
  'senderIsOwner',
  'isDirector',
  'isActiveContributor',
  'eligibleMemberIds',
  'voterContactId',
  'weight',
  'weights',
]);

// Governance parameters a model must never supply. The vote type decides the candidate cap and the
// approval limit and the Agent assembles the candidate pool, so an argument that names candidates, a
// limit or an option label would let a prompt write its own round definition (D08, D09).
const POLICY_KEYS = Object.freeze([
  'candidateIds',
  'candidateLimit',
  'candidateProposalIds',
  'maxApprovalsPerVoter',
  'maxCandidates',
  'limit',
  'opensAt',
  'options',
  'proposalIds',
  'quorum',
]);

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

const asUuid = (value: unknown): string | null =>
  typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;

const asVoteType = (value: unknown): string | null =>
  typeof value === 'string' && VOTE_TYPE_PATTERN.test(value) ? value : null;

const asIsoInstant = (value: unknown): string | null =>
  typeof value === 'string' && ISO_INSTANT_PATTERN.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : null;

function configError(message: string): never {
  throw new GovernanceWriteToolError('foundation_db_config_invalid', `foundationDb write tools: ${message}`);
}

function envValueError(message: string): never {
  throw new GovernanceWriteToolError('foundation_db_env_value_missing', `foundationDb write tools: ${message}`);
}

/**
 * Validate the operator configuration. Returns null when the foundationDb block is absent or disabled so the
 * caller registers no tools; throws on an enabled-but-incomplete block so a misconfiguration fails
 * loudly instead of silently exposing nothing. The same block configures the read slice, so the
 * checks and reason codes match `governance-read-tools.ts`.
 */
function resolveGovernanceWriteConfig(options?: GovernanceWriteToolsOptions): ResolvedGovernanceWriteConfig | null {
  const config = parseBackendConfig({
    config: options?.config,
    env: options?.env,
    requireConfirmationKey: true,
    ...(options?.confirmationSigningKey === undefined
      ? {}
      : { confirmationSigningKey: options.confirmationSigningKey }),
    error: configError,
    envError: envValueError,
  });
  if (!config) return null;

  const proposalChannelIds = config.workspaces.flatMap(workspace => [...workspace.proposalChannelIds]);
  const boardChannelIds = config.workspaces.flatMap(workspace => [...workspace.boardChannelIds]);
  const transport = options?.transport ?? createConfiguredTransport(config);

  if (
    options?.reader &&
    typeof options.reader.resolveSlackMember !== 'function'
  ) {
    configError('the injected reader must implement resolveSlackMember');
  }
  if (
    options?.writer &&
    (typeof options.writer.submitProposal !== 'function' ||
      typeof options.writer.createPoll !== 'function' ||
      typeof options.writer.getPoll !== 'function' ||
      typeof options.writer.listBallots !== 'function' ||
      typeof options.writer.castBallot !== 'function' ||
      typeof options.writer.getVoteType !== 'function' ||
      typeof options.writer.listVoteTypes !== 'function' ||
      typeof options.writer.listCandidateProposals !== 'function' ||
      typeof options.writer.finalizePoll !== 'function')
  ) {
    configError(
      'the injected writer must implement submitProposal, createPoll, getPoll, listBallots, castBallot, getVoteType, listVoteTypes, listCandidateProposals and finalizePoll',
    );
  }

  const now = typeof options?.now === 'function' ? options.now : () => new Date();
  return {
    config,
    proposalChannelIds,
    boardChannelIds,
    transport,
    ...(options?.proofProvider === undefined ? {} : { proofProvider: options.proofProvider }),
    ...(options?.reader === undefined ? {} : { reader: options.reader }),
    ...(options?.writer === undefined ? {} : { writer: options.writer }),
    confirmationSigningKey: config.confirmationSigningKey as string,
    now,
  };
}

function assertNoImpersonationArgs(args: unknown) {
  if (!args || typeof args !== 'object') return;
  for (const key of IMPERSONATION_KEYS) {
    if (Object.hasOwn(args, key)) {
      throw new GovernanceWriteToolError(
        'actor_argument_rejected',
        `The "${key}" argument is not accepted; the acting account comes only from the host context.`,
      );
    }
  }
}

/**
 * Refuse a governance parameter that only operator configuration or the Agent's own assembly may
 * set. The candidate cap belongs to the stored vote type and the candidate pool is read from the
 * database, so a caller cannot widen a round or pick its own candidates.
 */
function assertNoPolicyArgs(args: unknown) {
  if (!args || typeof args !== 'object') return;
  for (const key of POLICY_KEYS) {
    if (Object.hasOwn(args, key)) {
      throw new GovernanceWriteToolError(
        'policy_argument_rejected',
        `The "${key}" argument is not accepted; the stored vote type and the database decide it.`,
      );
    }
  }
}

function errorResult(tool: string, error: unknown) {
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'tool_failed';
  const extra =
    error && typeof error === 'object' && (error as { details?: unknown }).details
      ? ((error as { details: Record<string, unknown> }).details ?? {})
      : {};
  const details = { tool, ok: false as const, error: code, message: describe(error), ...extra };
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
}

/**
 * One frozen candidate as an answer reports it: the identifier the stored poll row holds and the
 * stored title of that proposal. The title is null when the database could not answer for the
 * identifier, which is stated rather than filled in.
 */
export interface CandidateProposalTitle {
  proposalId: string;
  title: string | null;
}

/**
 * How two stored titles compare when deciding whether a spoken name is ambiguous. Case and inner
 * whitespace are not what a person means by a different proposal, so two frozen candidates whose
 * titles compare equal cannot be told apart by name.
 */
function comparableTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Shape the ordered frozen candidate list of one round, and name every title that more than one
 * frozen candidate carries. The identifiers are always the ones demanded from the stored poll row,
 * so this never turns a spoken name into an identifier and never invents a title: an unresolved
 * title stays null and `candidateTitlesResolved` says so, and a shared title is listed so the caller
 * asks which one is meant instead of picking one.
 */
function candidateTitleList(entries: readonly CandidateProposalTitle[]) {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.title === null) continue;
    const key = comparableTitle(entry.title);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ambiguous: string[] = [];
  for (const entry of entries) {
    if (entry.title === null) continue;
    if ((counts.get(comparableTitle(entry.title)) ?? 0) > 1 && !ambiguous.includes(entry.title)) {
      ambiguous.push(entry.title);
    }
  }
  return {
    candidateProposals: entries.map(entry => ({ proposalId: entry.proposalId, title: entry.title })),
    candidateTitlesResolved: entries.every(entry => entry.title !== null),
    ambiguousCandidateTitles: ambiguous,
  };
}

/**
 * Report a round that is still open, or one that holds no record yet. The stored poll is the fact
 * behind this answer, but no count, no winner, no participation total and no voter identity is
 * published and nothing is finalized, so `ok` stays false: a provisional read is not an outcome.
 */
function provisionalResult(
  tool: string,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  const pollId = extra.pollId;
  const details = {
    tool,
    ok: false as const,
    status: 'provisional' as const,
    error: 'provisional',
    reason,
    ...extra,
    message,
    authorizesSpending: false as const,
    narration: {
      kind: 'provisional' as const,
      // Transport metadata about the narration itself, not a claim about the round and not something
      // a reply is supposed to repeat: this module posts nothing to a channel and never reads one
      // back, so a spoken reply is the agent's own prose. See `details.narration.note` for the short
      // user-facing wording of the provisional read.
      delivery: 'model_relayed' as const,
      // One stored record only: `finalized` says the database closed this round, and `settled` says a
      // decision record exists. Neither says the organization adopted this outcome as a governance
      // rule, and the tie rule in particular is still unconfirmed.
      finalized: false as const,
      settled: false as const,
      record: 'provisional' as const,
      pollId: typeof pollId === 'string' ? pollId : null,
      candidateProposals: Array.isArray(extra.candidateProposals) ? extra.candidateProposals : [],
      candidateTitlesResolved: extra.candidateTitlesResolved === true,
      ambiguousCandidateTitles: Array.isArray(extra.ambiguousCandidateTitles)
        ? extra.ambiguousCandidateTitles
        : [],
      outcome: null,
      winner: null,
      winnerTitle: null,
      counts: null,
      totalBallots: null,
      abstainCount: null,
      authorizesSpending: false as const,
      // Short, user-safe wording with no implementation vocabulary: it can be said as it stands and
      // still publishes no winner, no tally, no participation total and no voter identity.
      note: '本轮还没有结束，所以还没有结果：现在没有赢家，也没有票数与参与人数。',
    },
  };
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
}

function buildTools(config: ResolvedGovernanceWriteConfig, ctx: any) {
  const { proposalChannelIds, boardChannelIds, confirmationSigningKey, now } = config;

  const nativeChannelId = typeof ctx?.nativeChannelId === 'string' ? ctx.nativeChannelId.trim() : '';
  const senderId = typeof ctx?.requesterSenderId === 'string' ? ctx.requesterSenderId.trim() : '';

  // Trusted platform plus channel pick one approved workspace; the reader and writer for this call
  // are built against the backend with a per-call proof, resolved again on every backend call.
  const workspace = resolveTrustedWorkspace(config.config, ctx);
  const bound = createInvocationAdapters({
    transport: config.transport,
    identity: workspace,
    ...(config.proofProvider === undefined ? {} : { proofProvider: config.proofProvider }),
    ctx,
  });
  const reader: GovernanceWriteToolReader | null = config.reader ?? bound?.reader ?? null;
  const writer: GovernanceWriteToolWriter | null = config.writer ?? bound?.writer ?? null;

  // Resolve the trusted sender, or refuse before any database call. `audience` narrows which
  // approved channels may call this tool; the acting account is never taken from arguments.
  const requester = (audience: string, scoped: string[]) => {
    if (typeof ctx?.messageChannel !== 'string' || !ctx.messageChannel.trim()) {
      throw new GovernanceWriteToolError('platform_out_of_scope', 'The host did not supply a chat platform.');
    }
    if (workspace === null) {
      if (/^[a-z][a-z0-9_-]{1,31}$/.test(String(ctx.messageChannel).trim()) &&
          config.config.workspaces.some(item => item.platform === String(ctx.messageChannel).trim())) {
        throw new GovernanceWriteToolError(
          'channel_out_of_scope',
          `This channel is outside the approved ${audience} workspace channels.`,
        );
      }
      throw new GovernanceWriteToolError('platform_out_of_scope', 'This platform is not an approved governance surface.');
    }
    if (!senderId) {
      throw new GovernanceWriteToolError('trusted_requester_unavailable', 'The host did not supply a sender ID.');
    }
    if (!nativeChannelId || !scoped.includes(nativeChannelId)) {
      throw new GovernanceWriteToolError(
        'channel_out_of_scope',
        `This tool is limited to its approved ${audience} channel.`,
      );
    }
    if (!reader) {
      throw new GovernanceWriteToolError(
        'identity_source_unavailable',
        'This installation has no backend workspace configured for this channel, so no member record is available.',
      );
    }
    const resolved: GovernanceWriteToolReader = reader;
    return resolved.resolveSlackMember(senderId);
  };

  const linkRequired = (audience: string) =>
    new GovernanceWriteToolError(
      'identity_link_required',
      `This ${audience} tool requires a verified link between your Slack account and a community record.`,
    );

  /**
   * The write surface, or a refusal when this invocation has no configured backend workspace. A
   * missing workspace is reported as its own unavailable source instead of an empty or failed write.
   */
  const requireWriter = (): GovernanceWriteToolWriter => {
    if (!writer) {
      throw new GovernanceWriteToolError(
        'write_source_unavailable',
        'This installation has no backend workspace configured for this channel, so no governance write is available.',
      );
    }
    return writer;
  };

  /**
   * A read outage is not a governance answer. When the community record itself could not be read,
   * report an unavailable identity check rather than reading the failed lookup as an unlinked or
   * unauthorized account; no member status or role is disclosed either way.
   */
  const identityCheckUnavailable = (audience: string) =>
    new GovernanceWriteToolError(
      'identity_check_unavailable',
      `The community record for your Slack account could not be read, so this ${audience} tool refuses instead of treating the failed lookup as an unlinked account.`,
    );

  /** Proposal intake needs a linked record that is currently an active Contributor (D06, R02). */
  const proposalRequester = async (): Promise<SlackMemberResolution & { contactId: string }> => {
    const member = await requester('proposal', proposalChannelIds);
    if (member.status === 'unavailable') throw identityCheckUnavailable('proposal');
    if (member.status !== 'resolved' || !member.contactId) throw linkRequired('proposal');
    if (member.isActiveContributor !== true) {
      throw new GovernanceWriteToolError(
        'contributor_status_required',
        'Submitting a proposal requires a currently active Contributor record for your Slack account.',
      );
    }
    return { ...member, contactId: member.contactId };
  };

  /** Board tools need a linked record that is currently a director, in an approved Board channel. */
  const boardRequester = async (): Promise<SlackMemberResolution & { contactId: string }> => {
    const member = await requester('Board', boardChannelIds);
    if (member.status === 'unavailable') throw identityCheckUnavailable('Board');
    if (member.status !== 'resolved' || !member.contactId) throw linkRequired('Board');
    if (member.isDirector !== true) {
      throw new GovernanceWriteToolError(
        'board_membership_required',
        'This Board tool requires a currently verified director link for your Slack account.',
      );
    }
    return { ...member, contactId: member.contactId };
  };

  /** One instant from the injected clock, or a fixed refusal instead of an unusable timestamp. */
  const instant = () => {
    let iso: string;
    try {
      const value: unknown = now();
      iso = value instanceof Date ? value.toISOString() : new Date(value as string).toISOString();
    } catch (error) {
      throw new GovernanceWriteToolError('clock_invalid', `The configured clock failed: ${describe(error)}`);
    }
    if (!ISO_INSTANT_PATTERN.test(iso)) {
      throw new GovernanceWriteToolError('clock_invalid', 'The configured clock did not return a valid instant.');
    }
    return iso;
  };

  /**
   * One record identifier per fresh turn and per tool call. The host may retry the same invocation
   * inside one `create(ctx)`, and such a retry has to meet the record it already wrote, so the
   * identifier is remembered by the tool call id. A later turn starts from an empty map and mints a
   * new identifier, so a reset call id can never collide with an earlier record.
   */
  const mintedIds = new Map<string, string>();
  const recordId = (kind: 'proposal' | 'poll', toolCallId: unknown): string => {
    if (typeof toolCallId !== 'string' || !toolCallId.trim()) {
      throw new GovernanceWriteToolError(
        'tool_call_id_required',
        'The host must supply the tool call id; it is what makes a retry the same record.',
      );
    }
    const key = `${kind}:${toolCallId.trim()}`;
    const known = mintedIds.get(key);
    if (known) return known;
    const minted = randomUUID();
    mintedIds.set(key, minted);
    return minted;
  };

  /**
   * Every confirmation token this factory instance minted, held for the life of the instance. The
   * host resolves one `create(ctx)` per inbound turn, so this set is exactly "the tokens this turn
   * issued": a caller that prepares a proposal and then echoes the token back inside the same turn
   * never had the author confirm the server's own prepared text. The confirm phase therefore refuses
   * a token in this set before any write, and only a fresh instance, which starts empty, may verify
   * it. Verification is unchanged: the token still has to be the one the server signed, still bound
   * to the same proposer and payload, still inside its own time window.
   */
  const issuedConfirmationTokens = new Set<string>();

  /** A title is required, trimmed and bounded; a whitespace-only title is not a title. */
  const resolveTitle = (value: unknown): string => {
    const title = typeof value === 'string' ? value.trim() : '';
    if (title.length < 1 || title.length > MAX_TITLE_LENGTH) {
      throw new GovernanceWriteToolError(
        'title_invalid',
        `title must be ${MAX_TITLE_LENGTH} characters or fewer and not empty.`,
      );
    }
    return title;
  };

  /** An absent summary stays absent; an empty one is stored as no summary rather than as text. */
  const resolveSummary = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.length > MAX_SUMMARY_LENGTH) {
      throw new GovernanceWriteToolError(
        'summary_invalid',
        `summary must be text of at most ${MAX_SUMMARY_LENGTH} characters.`,
      );
    }
    const text = value.trim();
    return text.length === 0 ? null : text;
  };

  /**
   * A requested amount is a request: it is recorded with its currency, and it authorizes nothing.
   * The pair is stored together or not at all, so a bare number is refused instead of being scaled
   * into a currency the author never named.
   */
  const resolveRequest = (
    requestedMinorValue: unknown,
    currencyValue: unknown,
  ): { requestedMinor: number | null; currency: string | null } => {
    const hasAmount = requestedMinorValue !== undefined && requestedMinorValue !== null;
    const hasCurrency = currencyValue !== undefined && currencyValue !== null;
    if (!hasAmount && !hasCurrency) return { requestedMinor: null, currency: null };
    if (hasAmount !== hasCurrency) {
      throw new GovernanceWriteToolError(
        'proposal_request_incomplete',
        'A requested amount and its currency are recorded together or not at all.',
      );
    }
    if (
      typeof requestedMinorValue !== 'number' ||
      !Number.isInteger(requestedMinorValue) ||
      requestedMinorValue < 0
    ) {
      throw new GovernanceWriteToolError(
        'proposal_requested_minor_invalid',
        'requestedMinor must be a whole number of minor units, zero or more.',
      );
    }
    const currency = typeof currencyValue === 'string' ? currencyValue.trim().toUpperCase() : '';
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new GovernanceWriteToolError(
        'proposal_currency_invalid',
        'currency must be one ISO 4217 code such as USD.',
      );
    }
    return { requestedMinor: requestedMinorValue, currency };
  };

  /**
   * The configured type names, read from the operator's own table. A read that fails is reported as
   * unavailable rather than as "nothing is configured", so a caller never reads an outage as an
   * empty configuration. An empty table is its own answer: there is no type to choose at all.
   */
  const readConfiguredVoteTypes = async (): Promise<string[]> => {
    const result = await requireWriter().listVoteTypes({ limit: MAX_CONFIGURED_VOTE_TYPES });
    if (!result.ok || !result.voteTypes) {
      throw new GovernanceWriteToolError(
        'vote_type_configuration_unavailable',
        'The configured proposal types could not be read, so no type could be checked.',
      );
    }
    return [...result.voteTypes];
  };

  /**
   * Resolve one proposal type against the operator's configured list. The type is never guessed and
   * never defaulted: a name that is not configured is refused by name, and the refusal carries the
   * names that do exist so the caller can ask for the right one instead of inventing a synonym such
   * as a shorter umbrella name for a configured type.
   */
  const requireConfiguredVoteType = (value: unknown, configured: readonly string[]): string => {
    const voteType = asVoteType(value);
    if (voteType === null) {
      throw new GovernanceWriteToolError(
        'vote_type_invalid',
        configured.length === 0
          ? 'voteType must be one configured lower snake case proposal type; no type is configured yet.'
          : `voteType must be one configured lower snake case proposal type such as ${configured[0]}.`,
      );
    }
    if (!configured.includes(voteType)) {
      throw new GovernanceWriteToolError(
        'vote_type_not_configured',
        'That proposal type is not configured; the type and its limits are operator configuration.',
        {
          voteType,
          configuredVoteTypes: [...configured],
          nextStep: 'ask_an_operator_to_configure_the_vote_type',
        },
      );
    }
    return voteType;
  };

  /**
   * Read one stored poll. An unavailable provider is never reported as a missing poll, so a caller
   * cannot mistake an outage for a decision that was never made.
   */
  const readPoll = async (pollId: string): Promise<PollRecord> => {
    const result = await requireWriter().getPoll(pollId);
    if (!result.ok || !result.poll) {
      if (result.reason === 'poll_not_found') {
        throw new GovernanceWriteToolError('poll_not_found', 'No stored poll has that identifier.');
      }
      throw new GovernanceWriteToolError('poll_lookup_unavailable', 'The stored poll could not be read.');
    }
    return result.poll;
  };

  /**
   * Read the operator-configured rule of one vote type. Its candidate cap and approval limit are the
   * round's own limits; an unknown type is refused by name and an outage is never read as one.
   */
  const readVoteType = async (voteType: string): Promise<VoteTypeRecord> => {
    const result = await requireWriter().getVoteType(voteType);
    if (!result.ok || !result.voteType) {
      if (result.reason === 'vote_type_not_found') {
        throw new GovernanceWriteToolError(
          'vote_type_not_found',
          'No configured vote type has that name; the type and its limits are operator configuration.',
        );
      }
      throw new GovernanceWriteToolError('vote_type_lookup_unavailable', 'The configured vote type could not be read.');
    }
    return result.voteType;
  };

  /**
   * Read the proposals a round of this type may consider. The pool is the database's answer: it
   * already excludes proposals that were selected or withdrawn, offers recently unselected ones
   * first, never returns another type's proposals, and leaves out every candidate an open round
   * already froze, whatever that round's type. An unreadable or truncated open-round inventory is
   * reported rather than answered with a pool that may not be free.
   */
  const readCandidatePool = async (
    voteType: string,
    limit: number,
    submittedSince: string | null,
  ): Promise<ProposalRecord[]> => {
    const listed = await requireWriter().listCandidateProposals({
      voteType,
      limit,
      ...(submittedSince === null ? {} : { submittedSince }),
      includeRecentlyUnselected: true,
    });
    if (!listed.ok || !listed.proposals) {
      throw new GovernanceWriteToolError(
        'candidate_pool_unavailable',
        'The eligible proposals of this type could not be read.',
      );
    }
    return [...listed.proposals];
  };

  /**
   * Read the stored title of each frozen candidate of one round, in the round's own candidate
   * order. The identifiers come from the stored poll row, so nothing here turns a spoken name into
   * an identifier; a spoken name is matched against the stored titles by the caller, and this module
   * only reports them. A title the proposals table cannot answer for stays null so the caller asks
   * rather than guesses, and an injected writer that cannot read one proposal by identifier leaves
   * the titles unresolved instead of failing the round: the frozen identifiers are still the
   * auditable fact.
   */
  const resolveCandidateProposals = async (
    candidateProposalIds: readonly string[],
    knownTitles: ReadonlyMap<string, string> = new Map(),
  ): Promise<CandidateProposalTitle[]> => {
    const canReadOneProposal = typeof (writer as { getProposal?: unknown }).getProposal === 'function';
    const entries: CandidateProposalTitle[] = [];
    for (const proposalId of candidateProposalIds) {
      const known = knownTitles.get(proposalId);
      if (typeof known === 'string') {
        entries.push({ proposalId, title: known });
        continue;
      }
      if (!canReadOneProposal) {
        entries.push({ proposalId, title: null });
        continue;
      }
      const read = await requireWriter().getProposal(proposalId);
      entries.push({ proposalId, title: read.ok && read.proposal ? read.proposal.title : null });
    }
    return entries;
  };

  /**
   * Normalize one ballot's approvals. Approving nothing is the abstention and is always allowed.
   * The database re-checks all of this, so a refusal here only avoids a pointless write.
   */
  const resolveApprovals = (value: unknown, poll: PollRecord): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new GovernanceWriteToolError(
        'approved_proposal_ids_invalid',
        'approvedProposalIds must be an array of candidate proposal identifiers.',
      );
    }
    if (value.length > MAX_APPROVALS) {
      throw new GovernanceWriteToolError(
        'approved_proposal_ids_invalid',
        `approvedProposalIds accepts at most ${MAX_APPROVALS} entries.`,
      );
    }
    const approved: string[] = [];
    for (const entry of value as unknown[]) {
      const id = asUuid(entry);
      if (id === null || approved.includes(id)) {
        throw new GovernanceWriteToolError(
          'approved_proposal_ids_invalid',
          'Every entry must be one canonical proposal identifier, without repeats.',
        );
      }
      approved.push(id);
    }
    if (approved.length > poll.maxApprovalsPerVoter) {
      throw new GovernanceWriteToolError(
        'too_many_approvals',
        `This poll counts at most ${poll.maxApprovalsPerVoter} approvals per voter.`,
      );
    }
    for (const id of approved) {
      if (!poll.candidateProposalIds.includes(id)) {
        throw new GovernanceWriteToolError(
          'approved_proposal_not_in_poll',
          'Every approved proposal must be a candidate of this poll.',
        );
      }
    }
    return approved;
  };

  return [
    {
      name: 'rein_governance_proposal_submit',
      description:
        'Submit a funding request as your own linked community record, in two steps. Call it once without a confirmation token to prepare: the server writes nothing and returns the canonical proposal text plus a short-lived confirmation token. Then show that text to the proposer and call it again with the token returned unchanged and confirmPronouncedByAuthor set to true only after the proposer explicitly agrees. The caller must be the trusted sender inside an approved proposal channel and their current record must make them an active Contributor; the proposer is never taken from an argument. The request is stored against one configured proposal type, and a requested amount is recorded as a request that no one has approved. A token is bound to the exact payload and the proposer, so changing any field invalidates it, and resubmitting the same confirmed payload is the same record rather than a second proposal.',
      parameters: Type.Object(
        {
          voteType: Type.String({
            minLength: 1,
            maxLength: 64,
            description: 'Configured proposal type, lower snake case, such as event_budget',
          }),
          title: Type.String({ minLength: 1, maxLength: 200, description: 'Short proposal title' }),
          summary: Type.Optional(
            Type.String({ maxLength: 4000, description: 'What the request covers' }),
          ),
          requestedMinor: Type.Optional(
            Type.Integer({
              minimum: 0,
              description: 'Requested amount in integer minor units, recorded together with its currency',
            }),
          ),
          currency: Type.Optional(
            Type.String({
              minLength: 3,
              maxLength: 3,
              description: 'ISO 4217 currency code of the requested amount',
            }),
          ),
          confirmationToken: Type.Optional(
            Type.String({
              minLength: 1,
              // The token is an AES-256-GCM ciphertext of the canonical proposal document, so it is
              // larger than the text it carries. The cap is the measured worst case for the longest
              // legal payload, counting characters rather than bytes: one summary code point can be
              // several UTF-8 bytes. `proposal-confirmation.ts` refuses to mint a token longer
              // than this instead of returning one the schema would reject.
              maxLength: MAX_CONFIRMATION_TOKEN_LENGTH,
              description:
                'Token returned by the prepare call; echo it unchanged once the proposer confirms the prepared text',
            }),
          ),
          confirmPronouncedByAuthor: Type.Optional(
            Type.Boolean({
              description:
                'Set true only after the proposer explicitly confirms the prepared version; required together with the token',
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(toolCallId: unknown, args: any) {
        try {
          assertNoImpersonationArgs(args);
          assertNoPolicyArgs(args);
          const title = resolveTitle(args?.title);
          const summary = resolveSummary(args?.summary);
          const request = resolveRequest(args?.requestedMinor, args?.currency);
          const member = await proposalRequester();
          // The type is read back from the operator's own configuration before the write, so a name
          // the table does not carry is refused by name here instead of surfacing only as a foreign
          // key violation later. The tool still guesses nothing: the list comes from the table.
          const voteType = requireConfiguredVoteType(args?.voteType, await readConfiguredVoteTypes());
          const payload = {
            proposerContactId: member.contactId,
            title,
            summary,
            voteType,
            requestedMinor: request.requestedMinor,
            currency: request.currency,
          };

          // Phase 1, prepare: no token yet, so nothing is written. The caller gets the canonical
          // text to read back to the proposer and one short-lived token that binds this exact text.
          // The token is also remembered here, so this same turn cannot turn around and confirm it.
          if (args?.confirmationToken === undefined) {
            if (args?.confirmPronouncedByAuthor === true) {
              throw new GovernanceWriteToolError(
                'proposal_confirmation_required',
                'A confirmation needs the token returned by the prepare call; prepare first, then confirm.',
              );
            }
            const issued = issueProposalConfirmation(payload, confirmationSigningKey, now());
            // A document too large to seal into a legal token is refused here, before anything is
            // handed back: a caller never receives a token the confirm phase would have to reject.
            if (!issued.ok) {
              throw new GovernanceWriteToolError(
                issued.reason,
                `The prepared proposal text is too long to seal into one confirmation token (${issued.documentBytes} bytes); shorten the summary and prepare it again.`,
              );
            }
            issuedConfirmationTokens.add(issued.token);
            const details = {
              tool: 'rein_governance_proposal_submit',
              ok: true,
              status: 'prepared' as const,
              reason: 'awaiting_author_confirmation',
              prepared: confirmationPreview(payload),
              confirmationToken: issued.token,
              expiresAt: issued.expiresAt,
              recorded: false,
              // A prepared request is not a stored proposal and no tool here approves spending.
              authorizesSpending: false as const,
            };
            return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
          }

          // Phase 2, confirm: the token must verify against the proposer and this exact payload,
          // and the caller must state that the author confirmed it. A token without that statement,
          // a token that has expired, and a token whose payload moved all stop before any write.
          if (args?.confirmPronouncedByAuthor !== true) {
            throw new GovernanceWriteToolError(
              'proposal_confirmation_required',
              'confirmPronouncedByAuthor must be true: the proposer has to confirm the prepared version explicitly.',
            );
          }
          // A turn that prepared this very token cannot be the turn that confirms it. The proposer
          // has to have seen the prepared text and answered it, which is a later inbound turn: one
          // host turn resolves one factory instance, so a token this instance minted proves the
          // confirmation and the preparation came out of a single turn. The check runs before the
          // signature check so a same-turn echo is never even treated as a valid candidate.
          if (
            typeof args.confirmationToken === 'string' &&
            issuedConfirmationTokens.has(args.confirmationToken)
          ) {
            throw new GovernanceWriteToolError(
              'proposal_confirmation_next_turn_required',
              'The confirmation has to come in a later turn than the preparation: show the prepared text to the proposer and confirm only the token they answer.',
            );
          }
          const verified = verifyProposalConfirmation(
            args.confirmationToken,
            payload,
            confirmationSigningKey,
            now(),
          );
          if (!verified.ok) {
            throw new GovernanceWriteToolError(
              verified.reason,
              verified.reason === 'proposal_confirmation_expired'
                ? 'The confirmation token has expired; prepare the proposal again and re-read it to the proposer.'
                : verified.reason === 'proposal_confirmation_mismatch'
                  ? 'The submitted fields differ from the prepared version; prepare again and confirm the exact text.'
                  : 'The confirmation token is missing or was not issued by this server.',
            );
          }
          // The identifier is derived from the confirmed binding, so re-confirming the same text
          // addresses the same row instead of inserting a second proposal. The per-turn record id
          // is kept for the host retry path that repeats one tool call inside a single turn.
          const id = recordId('proposal', toolCallId);
          const confirmedId = proposalIdForConfirmation(verified.payload, confirmationSigningKey);
          // Final authority check immediately before the write: a stale turn cannot commit.
          assertCurrentInvocation(ctx);
          // The vote type is stored as given and the database keeps the foreign key as the final
          // authority, so an unconfigured type is still refused there rather than guessed here.
          const written = await requireWriter().submitProposal({
            id: confirmedId,
            proposerContactId: verified.payload.proposerContactId,
            title: verified.payload.title,
            summary: verified.payload.summary,
            voteType: verified.payload.voteType,
            requestedMinor: verified.payload.requestedMinor,
            currency: verified.payload.currency,
          });
          const details = {
            tool: 'rein_governance_proposal_submit',
            ok: written.ok,
            status: written.status,
            reason: written.reason,
            ...(written.ok ? {} : { error: written.reason }),
            proposalId: confirmedId,
            voteType: verified.payload.voteType,
            requestedMinor: verified.payload.requestedMinor,
            currency: verified.payload.currency,
            authorConfirmed: true as const,
            recorded: written.ok,
            // A stored request is not a funding decision and no tool here approves spending.
            authorizesSpending: false as const,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
        } catch (error) {
          return errorResult('rein_governance_proposal_submit', error);
        }
      },
    },
    {
      name: 'rein_poll_open',
      description:
        'Open one Board approval round over the stored proposals of one configured vote type, with an explicit closing time. The caller must be the trusted sender inside the approved Board channel and their current record must make them a director. The round takes its candidate cap from that stored type and the Agent reads the candidate pool itself, so no candidate list, cap or label is accepted from the caller; the pool leaves out every proposal a currently open round of any type already froze, which is the same free pool the read-only candidate listing reports. The database freezes the candidate list and the limits, and a round needs at least one candidate. The answer lists those frozen candidates in order as proposalId and title pairs read from the stored proposals, which is the list a spoken proposal name is matched against later. A retry of the same tool call in this turn is the same round.',
      parameters: Type.Object(
        {
          voteType: Type.String({
            minLength: 1,
            maxLength: 64,
            description: 'Configured vote type whose own candidate cap defines this round',
          }),
          title: Type.String({ minLength: 1, maxLength: 200, description: 'Short poll title' }),
          closesAt: Type.String({
            minLength: 1,
            maxLength: 40,
            description: 'ISO instant at which the round closes, later than the current time',
          }),
          submittedSince: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 40,
              description: 'Optional ISO instant; only proposals stored at or after it enter the pool',
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(toolCallId: unknown, args: any) {
        try {
          assertNoImpersonationArgs(args);
          assertNoPolicyArgs(args);
          const voteType = requireConfiguredVoteType(args?.voteType, await readConfiguredVoteTypes());
          const title = resolveTitle(args?.title);
          const closesAt = asIsoInstant(args?.closesAt);
          if (closesAt === null) {
            throw new GovernanceWriteToolError(
              'poll_closes_at_invalid',
              'closesAt must be one ISO instant such as 2026-09-26T18:00:00Z.',
            );
          }
          const submittedSince =
            args?.submittedSince === undefined || args?.submittedSince === null
              ? null
              : asIsoInstant(args.submittedSince);
          if (args?.submittedSince !== undefined && args?.submittedSince !== null && submittedSince === null) {
            throw new GovernanceWriteToolError(
              'submitted_since_invalid',
              'submittedSince must be one ISO instant such as 2026-09-01T00:00:00Z.',
            );
          }
          const member = await boardRequester();
          const rule = await readVoteType(voteType);
          const opensAt = instant();
          if (Date.parse(closesAt) <= Date.parse(opensAt)) {
            throw new GovernanceWriteToolError(
              'poll_window_invalid',
              'closesAt must be later than the current time, because a round opens now.',
            );
          }
          // The type's own cap bounds the pool, and the first candidates the database returns are
          // the ones the round is opened over.
          const pool = await readCandidatePool(voteType, rule.maxCandidates, submittedSince);
          const candidateProposalIds = pool.slice(0, rule.maxCandidates).map(proposal => proposal.id);
          if (candidateProposalIds.length === 0) {
            throw new GovernanceWriteToolError(
              'no_candidate_proposals',
              'No stored proposal of this type is available, so no round is opened.',
            );
          }
          const id = recordId('poll', toolCallId);
          // Final authority check immediately before the write: a stale turn cannot open a round.
          assertCurrentInvocation(ctx);
          // No cap and no approval limit travels with this call: the database freezes both from the
          // stored vote type, and it freezes the candidate list it accepts.
          const written = await requireWriter().createPoll({
            id,
            creatorContactId: member.contactId,
            title,
            voteType,
            candidateProposalIds,
            opensAt,
            closesAt,
          });
          const storedCandidates = written.poll?.candidateProposalIds ?? candidateProposalIds;
          // The frozen identifiers are the stored row's own. Their titles come from the proposals
          // table: the pool read already holds the title of every identifier it returned, and an
          // identifier it did not answer for is read by identifier alone.
          const candidateProposals = await resolveCandidateProposals(
            storedCandidates,
            new Map<string, string>(pool.map(proposal => [proposal.id, proposal.title] as const)),
          );
          const details = {
            tool: 'rein_poll_open',
            ok: written.ok,
            status: written.status,
            reason: written.reason,
            ...(written.ok ? {} : { error: written.reason }),
            pollId: id,
            voteType,
            opensAt,
            closesAt,
            candidateProposalIds: storedCandidates,
            candidateCount: storedCandidates.length,
            ...candidateTitleList(candidateProposals),
            candidateLimit: rule.maxCandidates,
            maxApprovalsPerVoter: rule.maxApprovalsPerVoter,
            recorded: written.ok,
            authorizesSpending: false as const,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
        } catch (error) {
          return errorResult('rein_poll_open', error);
        }
      },
    },
    {
      name: 'rein_poll_vote',
      description:
        'Record your one immutable ballot on a stored, open poll: up to the poll approval limit of its candidate proposals, or an empty list to abstain. Limited to the trusted Board channel and to senders whose current community record is a director. A repeated identical ballot is the same record; a changed one is refused. A vote decision record moves no money.',
      parameters: Type.Object(
        {
          pollId: Type.String({ minLength: 1, maxLength: 64, description: 'Stored poll identifier' }),
          approvedProposalIds: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
              maxItems: MAX_APPROVALS,
              description: 'Candidate proposals you approve; an empty list abstains',
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId: unknown, args: any) {
        try {
          assertNoImpersonationArgs(args);
          const pollId = asUuid(args?.pollId);
          if (pollId === null) {
            throw new GovernanceWriteToolError('poll_id_invalid', 'pollId must be one stored poll identifier.');
          }
          const member = await boardRequester();
          const poll = await readPoll(pollId);
          // The recorded poll window decides, not the caller. A cancelled poll is never reopened.
          if (poll.status === 'cancelled') {
            throw new GovernanceWriteToolError('poll_cancelled', 'This poll was cancelled, so no ballot is recorded.');
          }
          if (poll.status !== 'open') {
            throw new GovernanceWriteToolError('poll_closed', 'This poll is closed, so no ballot is recorded.');
          }
          const at = instant();
          if (Date.parse(at) < Date.parse(poll.opensAt)) {
            throw new GovernanceWriteToolError('poll_not_open', 'This poll has not opened yet.');
          }
          if (Date.parse(at) >= Date.parse(poll.closesAt)) {
            throw new GovernanceWriteToolError('poll_closed', 'This poll closed before this ballot arrived.');
          }
          const approvedProposalIds = resolveApprovals(args?.approvedProposalIds, poll);
          // Final authority check immediately before the write: a stale turn cannot commit.
          assertCurrentInvocation(ctx);
          const written = await requireWriter().castBallot({
            pollId,
            voterContactId: member.contactId,
            approvedProposalIds,
          });
          const details = {
            tool: 'rein_poll_vote',
            ok: written.ok,
            status: written.status,
            reason: written.reason,
            ...(written.ok ? {} : { error: written.reason }),
            pollId,
            approvalCount: approvedProposalIds.length,
            abstained: approvedProposalIds.length === 0,
            recorded: written.ok,
            // The endpoint never replaces a recorded ballot, so a changed one stays refused.
            replaced: false,
            authorizesSpending: false,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
        } catch (error) {
          return errorResult('rein_poll_vote', error);
        }
      },
    },
    {
      name: 'rein_poll_result',
      description:
        'Report the result of one stored poll, addressed by its identifier. Before the deadline this is provisional: the readable facts of the round are the stored window and the frozen candidates in order as proposalId and title pairs read from the stored proposals, and it publishes no count, no winner, no participation total and no voter identity, so the recorded ballots are not read for it. At or after the deadline the database closes the round and counts the recorded ballots at one equal weight per director; the stored outcome is what comes back, so a tie or an all-abstain round reports no winner and an already finalized round reports its recorded outcome unchanged. The stored record is the database\'s own; it is a decision record and never a statement that the organization adopted the outcome, and the tie rule is still unconfirmed. Read `narration.note` for the short user-facing wording and answer with that wording, never with a field name. Limited to the trusted Board channel and to senders whose current community record is a director. A decision record moves no money.',
      parameters: Type.Object(
        { pollId: Type.String({ minLength: 1, maxLength: 64, description: 'Stored poll identifier' }) },
        { additionalProperties: false },
      ),
      async execute(_toolCallId: unknown, args: any) {
        try {
          assertNoImpersonationArgs(args);
          const pollId = asUuid(args?.pollId);
          if (pollId === null) {
            throw new GovernanceWriteToolError('poll_id_invalid', 'pollId must be one stored poll identifier.');
          }
          const member = await boardRequester();
          const poll = await readPoll(pollId);
          const at = instant();
          // The stored window decides, exactly as it does for a ballot. A cancelled round is never
          // reopened and is never finalized, so its provisional read names no outcome.
          const closed = poll.status !== 'open' || Date.parse(at) >= Date.parse(poll.closesAt);
          if (!closed) {
            // A provisional read is not an outcome, and it publishes no participation figure: the
            // ballot rows are deliberately not read here, so neither a total nor a voter can be
            // inferred from this answer. The database is the only counter of an outcome. The frozen
            // candidates travel with their stored titles, which is what a later director turn maps a
            // spoken proposal name against; a title no row answers for stays null.
            const candidateProposals = await resolveCandidateProposals(poll.candidateProposalIds);
            assertCurrentInvocation(ctx);
            return provisionalResult(
              'rein_poll_result',
              'poll_still_open',
              'This poll is still open, so no outcome exists yet. Before the deadline only the round window and the frozen candidates are published: no count, no winner, no participation total and no voter identity, and nothing is finalized.',
              {
                pollId,
                pollStatus: poll.status,
                closesAt: poll.closesAt,
                closed: false,
                official: false,
                outcome: null,
                winner: null,
                counts: null,
                // Kept as a stable field for callers, but withheld before the deadline: an open round
                // publishes no participation total and no voter identity.
                totalBallots: null,
                finalized: false,
                ...candidateTitleList(candidateProposals),
              },
            );
          }
          if (poll.status !== 'open') {
            if (poll.status === 'cancelled') {
              // A cancelled round is over but holds no outcome: it is read back as provisional, never
              // finalized and never re-counted.
              const candidateProposals = await resolveCandidateProposals(poll.candidateProposalIds);
              assertCurrentInvocation(ctx);
              return provisionalResult(
                'rein_poll_result',
                'poll_not_open',
                'This poll was cancelled, so it holds no outcome; no result is published and nothing is finalized.',
                {
                  pollId,
                  pollStatus: poll.status,
                  closesAt: poll.closesAt,
                  closed: true,
                  official: false,
                  outcome: null,
                  winner: null,
                  counts: null,
                  totalBallots: null,
                  finalized: false,
                  ...candidateTitleList(candidateProposals),
                },
              );
            }
            // A `closed` row is one a successful finalization already wrote, so the recorded outcome
            // has to be replayed rather than refused.
          }
          // Past the deadline, and on a round a finalization already closed, only the database names
          // the outcome. This call carries the poll and the trusted sender's own director record and
          // nothing else, so no caller can hand the database an outcome, a count or a weight.
          // `finalizePoll` is idempotent: a repeat against a closed row returns the stored record
          // instead of writing a second one, which is what makes a closed round readable here.
          assertCurrentInvocation(ctx);
          const written = await requireWriter().finalizePoll({ pollId, actorContactId: member.contactId });
          if (!written.ok || !written.finalization) {
            throw new GovernanceWriteToolError(written.reason || 'finalize_failed', 'The outcome could not be finalized.');
          }
          const finalization = written.finalization;
          // The recorded candidates of the closed round, with the stored title behind each
          // identifier, so the outcome can be read by proposal name as well as by identifier.
          const candidateProposals = await resolveCandidateProposals(finalization.candidates);
          const titleList = candidateTitleList(candidateProposals);
          const winningTitle =
            finalization.winningProposalId === null
              ? null
              : (titleList.candidateProposals.find(
                  entry => entry.proposalId === finalization.winningProposalId,
                )?.title ?? null);
          const details = {
            tool: 'rein_poll_result',
            ok: true,
            narration: null as Record<string, unknown> | null,
            status: written.status,
            reason: written.reason,
            pollId,
            pollStatus: finalization.status,
            closesAt: poll.closesAt,
            closed: true,
            // Kept for compatibility, deliberately narrow: this says the database has one stored
            // result for this round and the call is the recorded one - not that the organization
            // adopted the outcome as a governance rule. A tie rule is still unconfirmed.
            official: true as const,
            // The stored outcome, not a count this module made: `no_winner` covers both a tie and an
            // all-abstain round, and the approvals below are the recorded per-proposal counts.
            outcome: finalization.outcome,
            winner: finalization.winningProposalId,
            counts: Object.fromEntries(
              finalization.approvals.map(approval => [approval.proposalId, approval.approvals]),
            ),
            totalBallots: finalization.ballots,
            abstainCount: finalization.abstentions,
            proposalsRecorded: finalization.proposalsRecorded,
            candidates: [...finalization.candidates],
            ...titleList,
            finalized: true,
            // An already finalized round answers with the record it stored, so a repeat reports the
            // same outcome instead of counting the ballots a second time.
            repeated: finalization.repeated,
            authorizesSpending: false as const,
          };
          // The outcome-shaped facts of the closed round, in one small object a relay can read. The
          // winning title is null when there is no winner or when no stored row answers for the
          // identifier, and a `no_winner` outcome never carries one: a tie and an all-abstain round
          // are reported as the recorded no-winner outcome, not as a winner.
          //
          // The spoken sentence is built here, from the recorded counts, so no reply has to assemble
          // one. A `no_winner` round states only what the record holds, "no winner", and never why:
          // the stored finalization carries no tie reason, so a tie and an all-abstain round are
          // indistinguishable from the record and a sentence naming a cause would be a guess about
          // the ballots. The rule that a tie ends as no winner is itself unconfirmed, so the
          // no-winner sentence says the rule is not settled and never reads as an adopted rule.
          const recordedCounts = Object.fromEntries(
            finalization.approvals.map(approval => [approval.proposalId, approval.approvals]),
          );
          // The count the winner took, read from the recorded per-proposal counts. It is an
          // *approval* count, not a ballot figure: a proposal type may allow more than one
          // approval per voter, so the winner's approvals can exceed the number of directors who
          // participated, and calling them ballots would misstate the record. A record that cannot
          // answer for the winner's own count leaves the count null and the sentence says only that
          // the count is on record, so no figure is ever invented here.
          const winnerApprovals =
            finalization.winningProposalId === null
              ? null
              : (recordedCounts[finalization.winningProposalId] ?? null);
          const winnerCountSentence =
            typeof winnerApprovals === 'number'
              ? `本轮该候选人获得赞成 ${winnerApprovals} 票。`
              : '本轮该候选人获得赞成票数已记录在案。';
          const ballotSentence =
            `本轮有 ${finalization.ballots} 位董事参与投票，其中 ${finalization.abstentions} 位弃权。`;
          const finalNote =
            finalization.outcome === 'no_winner'
              ? '本轮投票已结束，记录的结果是无赢家，票数已按规则记录在案。' +
                ballotSentence +
                '请注意：平票如何处理的规则尚未确认，这条记录不代表组织已经通过或采纳了任何规则。' +
                '这是一条决策记录，不移动任何资金。'
              : '本轮投票已结束，最高赞成票的候选人是：' +
                (winningTitle ?? '（标题未能读取）') +
                '。' +
                winnerCountSentence +
                ballotSentence +
                '这是一条决策记录，不移动任何资金。';
          details.narration = {
            kind: 'final' as const,
            // Transport metadata only: this module posts nothing to a channel, so the spoken reply is
            // the agent's own prose. The user-facing wording is `note`.
            delivery: 'model_relayed' as const,
            // `finalized` is the database's own closure of this round; `settled` says one decision
            // record exists. Both are records, not an adopted governance rule - a tie is recorded as
            // no winner under an unconfirmed rule, so no field here claims otherwise.
            finalized: true as const,
            settled: true as const,
            record: 'decided' as const,
            pollId,
            candidateProposals: titleList.candidateProposals,
            candidateTitlesResolved: titleList.candidateTitlesResolved,
            ambiguousCandidateTitles: titleList.ambiguousCandidateTitles,
            outcome: finalization.outcome,
            winner: finalization.winningProposalId,
            winnerTitle: winningTitle,
            counts: recordedCounts,
            totalBallots: finalization.ballots,
            abstainCount: finalization.abstentions,
            authorizesSpending: false as const,
            note: finalNote,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
        } catch (error) {
          return errorResult('rein_poll_result', error);
        }
      },
    },
  ];
}

/**
 * Build the v2 tool factory for the governance write tools. Register it as
 * `api.registerTool(createGovernanceWriteToolRegistration({ config }), { names: GOVERNANCE_WRITE_TOOL_NAMES })`.
 * When the foundationDb block is absent or disabled, `create` returns null and no tool is registered.
 */
export function createGovernanceWriteToolRegistration(options?: GovernanceWriteToolsOptions) {
  const config = resolveGovernanceWriteConfig(options);
  return {
    contextVersion: 2 as const,
    create(ctx: any) {
      if (!config) return null;
      return buildTools(config, ctx);
    },
  };
}
