// Governance read-only tools: a member's own identity status, the latest human-entered
// available-funds snapshot, the eligible proposals of one configured vote type, and the resolution
// of one spoken proposal-type phrase against the operator's own display names.
//
// Scope: PRD R02 (a chat account acts only after an explicit link to a community record, and a
// display name never establishes identity), R21 (a finance figure the Agent may only read), D05 (a
// funding approval is a decision record, not money movement) and D06 (only members with active
// Contributor status propose or lead; only eligible Board members vote). Every tool here answers
// through one authenticated Foundation backend: the status and funds reads through
// `backend-db-adapter.ts`, and the candidate listing and the configured type names through the
// read-only slice of the same adapter. The Agent opens no database connection and holds no database
// credential. None of them writes, reserves, approves or spends, none invents a figure the backend
// reported as unknown, and none selects, withdraws or votes on a proposal.
//
// The candidate listing names one vote type explicitly and never guesses one from prose; the phrase
// resolver matches only the display names and aliases the operator wrote into `foundationDb.voteTypeAliases`,
// by exact equality after normalization, reports several matches as ambiguous with no type chosen,
// and hands a type code back only when the stored type table already has it.
//
// Workspace resolution: OpenClaw's version-2 tool context carries the chat platform, the native
// channel id and the trusted sender id, but no workspace id. The platform is therefore the host's
// own `messageChannel`, and the workspace is the one approved `foundationDb.workspaces` entry whose
// platform equals it and whose native channel list contains the trusted channel. A call that
// matches no entry, a platform the operator did not configure, or a channel from another workspace
// is refused before any backend call.
//
// Trust boundary:
// - The acting platform user id comes only from `ctx.requesterSenderId`. No tool argument is read as
//   an actor, known impersonation arguments are rejected, and the caller must be inside an approved
//   native channel before any backend call happens.
// - `assertInvocationCurrent` is rechecked before any answer is returned, so a cancelled or stale
//   turn cannot read fresh member or funds data.
// - A refused caller and a failed lookup both collapse to a fixed reason code. Provider text, the
//   backend base URL, the workspace id and the Agent credential never reach a result, status or
//   error.
//
// Confidentiality: the private contact identifier resolved by the backend is deliberately dropped
// from every answer. Callers learn only whether the sender is linked, whether that record is an
// active Contributor and whether it is a director.

import { Type } from 'typebox';
import {
  createConfiguredTransport,
  createInvocationAdapters,
  parseBackendConfig,
  resolveTrustedWorkspace,
  type ResolvedBackendConfig,
} from './backend-config.ts';
import type { ToolProofProvider } from './backend-db-adapter.ts';
import type { AvailableFunds, SlackMemberResolution } from './foundation-db-reader.ts';
import type { FoundationDbWriter, ProposalRecord } from './foundation-db-writer.ts';
import type { BackendTransport } from './backend-transport.ts';
import { assertCurrentInvocation } from './request-context.ts';
import {
  VOTE_TYPE_PATTERN,
  displayNameForVoteType,
  normalizeVoteTypePhrase,
  parseVoteTypeLabelConfig,
  resolveVoteTypePhrase,
} from './vote-type-resolve.ts';
import type { VoteTypeLabelMap } from './vote-type-resolve.ts';

/** Names the caller must declare in the manifest and pass to `registerTool(..., { names })`. */
export const GOVERNANCE_READ_TOOL_NAMES = Object.freeze([
  'rein_member_status',
  'rein_funds',
  'rein_poll_candidates',
  'rein_vote_type_resolve',
]);

export class GovernanceReadToolError extends Error {
  readonly code: string;
  /** Extra facts a refusal may carry, such as the type names an operator did configure. */
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GovernanceReadToolError';
    this.code = code;
    this.details = details;
  }
}

/** The read-only methods these tools use, so a fake reader can stand in for the real one. */
export interface GovernanceReadToolReader {
  resolveSlackMember(slackUserId: string): Promise<SlackMemberResolution>;
  readAvailableFunds(currency: string): Promise<AvailableFunds>;
}

/** The two read-only writer methods the candidate listing and the resolver use. */
export type GovernanceReadToolWriter = Pick<FoundationDbWriter, 'listVoteTypes' | 'listCandidateProposals'>;

export interface GovernanceReadToolsOptions {
  /**
   * The `foundationDb` block of plugin config, read as untrusted input. Expected keys: `enabled`,
   * `platform`, `workspaces` (each an `id` with a non-empty native channel ID list),
   * `proposalChannelIds`, `boardChannelIds`, the optional `voteTypeAliases` label map, and the
   * environment variables naming the backend base URL, the Agent caller ID and the Agent
   * credential. The environment-variable keys name server variables; no credential is ever read
   * from config. Absent or `enabled: false` registers no tools.
   */
  config?: Record<string, unknown>;
  /** Server environment holding the referenced values. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injectable backend transport for tests and local rehearsal; skips the env-var lookups. */
  transport?: BackendTransport;
  /** Runtime ingress proof for one tool invocation. Called at execution time, never at registration. */
  proofProvider?: ToolProofProvider;
  /** Injectable reader for tests and local rehearsal; replaces the backend-backed one. */
  reader?: GovernanceReadToolReader;
  /** Injectable writer for tests and local rehearsal; replaces the backend-backed one. */
  writer?: GovernanceReadToolWriter;
}

export interface ResolvedGovernanceReadConfig {
  config: ResolvedBackendConfig;
  proposalChannelIds: string[];
  boardChannelIds: string[];
  /** The operator's own display names and aliases, already validated; a phrase resolves only from these. */
  voteTypeLabels: VoteTypeLabelMap;
  transport: BackendTransport;
  proofProvider?: ToolProofProvider;
  reader?: GovernanceReadToolReader;
  writer?: GovernanceReadToolWriter;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
/** Longest phrase the resolver accepts; a person's own words are short, and this bounds the match. */
const MAX_RESOLVE_PHRASE_LENGTH = 200;
/** Page size the candidate listing asks the database for; the writer's own ceiling is 200. */
const DEFAULT_CANDIDATE_PAGE = 50;
const MAX_CANDIDATE_PAGE = 200;
const MAX_EXCLUDED_PROPOSAL_IDS = 200;
/** Upper bound on the type names one read returns; the table is operator configuration. */
const MAX_CONFIGURED_VOTE_TYPES = 200;
/** Proposal statuses a candidate listing may report, exactly as the stored column carries them. */
const CANDIDATE_STATUSES = Object.freeze(['submitted', 'unselected']);

// Host-supplied identity keys a model must never be able to set.
const IMPERSONATION_KEYS = Object.freeze([
  'actor',
  'account',
  'accountId',
  'contactId',
  'member',
  'memberId',
  'ownerAccount',
  'participant',
  'platform',
  'proposerContactId',
  'senderId',
  'requesterSenderId',
  'voterContactId',
  'role',
  'isDirector',
  'isActiveContributor',
  'claimedActor',
  'senderIsOwner',
]);

// Governance parameters that belong to operator configuration and to the database. A caller may
// name the type it is asking about; it may not supply the candidate cap, an approval limit, a
// status filter or a proposal identifier set, because those are not what "what can be voted on"
// means.
const POLICY_KEYS = Object.freeze([
  'candidateIds',
  'candidateLimit',
  'candidateProposalIds',
  'maxApprovalsPerVoter',
  'maxCandidates',
  'options',
  'proposalIds',
  'quorum',
  'status',
]);

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

function configError(message: string): never {
  throw new GovernanceReadToolError('foundation_db_config_invalid', `foundationDb read tools: ${message}`);
}

function envValueError(message: string): never {
  throw new GovernanceReadToolError('foundation_db_env_value_missing', `foundationDb read tools: ${message}`);
}

/**
 * A writer that answers `foundation_db_config_invalid` is the operator's own block, not a data
 * path, so an injected writer that fails its contract check is re-thrown as a configuration error
 * and never surfaces as a per-turn tool refusal.
 */
const isConfigFailure = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'foundation_db_config_invalid');

/**
 * Read the operator's optional display names for the configured vote types. Validated here so a
 * malformed label fails loudly at registration rather than silently making a member's own words
 * unresolvable later. An absent block is an empty map and resolves nothing.
 */
function readVoteTypeLabels(value: unknown): VoteTypeLabelMap {
  try {
    return parseVoteTypeLabelConfig(value);
  } catch (error) {
    configError(`foundationDb.${describe(error)}`);
  }
}

/**
 * Validate the operator configuration. Returns null when the foundationDb block is absent or disabled so the
 * caller registers no tools; throws on an enabled-but-incomplete block so a misconfiguration fails
 * loudly instead of silently exposing nothing.
 */
function resolveGovernanceReadConfig(options: GovernanceReadToolsOptions | undefined): ResolvedGovernanceReadConfig | null {
  const config = parseBackendConfig({
    config: options?.config,
    env: options?.env,
    error: configError,
    envError: envValueError,
  });
  if (!config) return null;

  const voteTypeLabels = readVoteTypeLabels(config.voteTypeAliases);
  const proposalChannelIds = config.workspaces.flatMap(workspace => [...workspace.proposalChannelIds]);
  const boardChannelIds = config.workspaces.flatMap(workspace => [...workspace.boardChannelIds]);
  const transport = options?.transport ?? createConfiguredTransport(config);

  if (
    options?.reader &&
    (typeof options.reader.resolveSlackMember !== 'function' ||
      typeof options.reader.readAvailableFunds !== 'function')
  ) {
    configError('the injected reader must implement resolveSlackMember and readAvailableFunds');
  }
  if (
    options?.writer &&
    (typeof options.writer.listCandidateProposals !== 'function' ||
      typeof options.writer.listVoteTypes !== 'function')
  ) {
    configError('the injected writer must implement listVoteTypes and listCandidateProposals');
  }

  return {
    config,
    proposalChannelIds,
    boardChannelIds,
    voteTypeLabels,
    transport,
    ...(options?.proofProvider === undefined ? {} : { proofProvider: options.proofProvider }),
    ...(options?.reader === undefined ? {} : { reader: options.reader }),
    ...(options?.writer === undefined ? {} : { writer: options.writer }),
  };
}

function assertNoImpersonationArgs(args: unknown) {
  if (!args || typeof args !== 'object') return;
  for (const key of IMPERSONATION_KEYS) {
    if (Object.hasOwn(args, key)) {
      throw new GovernanceReadToolError(
        'actor_argument_rejected',
        `The "${key}" argument is not accepted; the acting account comes only from the host context.`,
      );
    }
  }
}

/**
 * Refuse a governance parameter that only operator configuration may set. A caller may name the
 * proposal type it is asking about; the candidate cap, the approval limit and the eligible
 * statuses come from that stored type and from the database.
 */
function assertNoPolicyArgs(args: unknown) {
  if (!args || typeof args !== 'object') return;
  for (const key of POLICY_KEYS) {
    if (Object.hasOwn(args, key)) {
      throw new GovernanceReadToolError(
        'policy_argument_rejected',
        `The "${key}" argument is not accepted; the stored vote type and the database decide it.`,
      );
    }
  }
}

const asVoteType = (value: unknown): string | null =>
  typeof value === 'string' && VOTE_TYPE_PATTERN.test(value) ? value : null;

const asIsoInstant = (value: unknown): string | null =>
  typeof value === 'string' && ISO_INSTANT_PATTERN.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : null;

/**
 * One candidate as this tool reports it: the stored identifier, title, status and type. The
 * proposer contact id, the summary and the amount stay in the database, because the question is
 * which proposals a round may consider and not who asked for what.
 */
function candidateListing(proposal: ProposalRecord) {
  return {
    proposalId: proposal.id,
    title: proposal.title,
    status: proposal.status,
    voteType: proposal.voteType,
    createdAt: proposal.createdAt,
  };
}

/**
 * The candidate source, or a refusal when this process has none. A caller that injected only a
 * reader has no candidate source, and that is reported as unavailable rather than as an empty pool,
 * so the two can never be confused.
 */
function requireWriter(writer: GovernanceReadToolWriter | null): GovernanceReadToolWriter {
  if (!writer || typeof writer.listCandidateProposals !== 'function' || typeof writer.listVoteTypes !== 'function') {
    throw new GovernanceReadToolError(
      'candidate_source_unavailable',
      'This installation has no candidate source configured, so no proposal list is available.',
    );
  }
  return writer;
}

/**
 * The type-table read the resolver needs, or a refusal when this process has none. A caller that
 * injected only a reader has no stored type table, and that is reported as unavailable rather than
 * as "nothing is configured", so the two can never be confused.
 */
function requireVoteTypeWriter(writer: GovernanceReadToolWriter | null): GovernanceReadToolWriter {
  if (!writer || typeof writer.listVoteTypes !== 'function') {
    throw new GovernanceReadToolError(
      'vote_type_source_unavailable',
      'This installation has no vote type source configured, so no configured type could be checked.',
    );
  }
  return writer;
}

/**
 * The configured type names, read from the operator's own table. A read that fails is reported as
 * unavailable rather than as "nothing is configured", so a caller never reads an outage as an empty
 * configuration. An empty table is its own answer: there is no type to choose at all.
 */
async function readConfiguredVoteTypes(
  writer: GovernanceReadToolWriter,
): Promise<{ status: string; reason: string; voteTypes: string[] }> {
  const listed = await writer.listVoteTypes({ limit: MAX_CONFIGURED_VOTE_TYPES });
  if (!listed.ok || !listed.voteTypes) {
    throw new GovernanceReadToolError(
      'vote_type_configuration_unavailable',
      'The configured proposal types could not be read, so no type could be checked.',
    );
  }
  return {
    status: listed.status,
    reason: listed.reason,
    voteTypes: [...listed.voteTypes],
  };
}

function errorResult(tool: string, error: unknown) {
  if (isConfigFailure(error)) throw error;
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

function buildTools(config: ResolvedGovernanceReadConfig, ctx: any) {
  const { proposalChannelIds, boardChannelIds, voteTypeLabels } = config;

  const nativeChannelId = typeof ctx?.nativeChannelId === 'string' ? ctx.nativeChannelId.trim() : '';
  const senderId = typeof ctx?.requesterSenderId === 'string' ? ctx.requesterSenderId.trim() : '';

  // The trusted platform and channel pick exactly one approved workspace, and the reader and writer
  // for that call are built against the backend with a per-call proof. Building them here keeps the
  // proof lazy: it is resolved again on every backend call, never snapshotted while the host's
  // pre-tool attestation may not have run yet.
  const workspace = resolveTrustedWorkspace(config.config, ctx);
  const bound = createInvocationAdapters({
    transport: config.transport,
    identity: workspace,
    ...(config.proofProvider === undefined ? {} : { proofProvider: config.proofProvider }),
    ctx,
  });
  const reader: GovernanceReadToolReader | null = config.reader ?? bound?.reader ?? null;
  const writer: GovernanceReadToolWriter | null = config.writer ?? bound?.writer ?? null;

  // Resolve the trusted sender, or refuse before any database read. `audience` narrows which
  // approved channels may call this tool; the acting user is never taken from arguments.
  const requester = (audience: string, scoped: string[]) => {
    if (typeof ctx?.messageChannel !== 'string' || !ctx.messageChannel.trim()) {
      throw new GovernanceReadToolError('platform_out_of_scope', 'The host did not supply a chat platform.');
    }
    // The trusted platform and channel must select exactly one enrolled workspace. A channel that no
    // workspace of this platform carries is a different scope, not an unlinked account.
    if (workspace === null) {
      if (/^[a-z][a-z0-9_-]{1,31}$/.test(String(ctx.messageChannel).trim()) &&
          config.config.workspaces.some(item => item.platform === String(ctx.messageChannel).trim())) {
        throw new GovernanceReadToolError(
          'channel_out_of_scope',
          `This channel is outside the approved ${audience} workspace channels.`,
        );
      }
      throw new GovernanceReadToolError('platform_out_of_scope', 'This platform is not an approved governance surface.');
    }
    if (!senderId) {
      throw new GovernanceReadToolError('trusted_requester_unavailable', 'The host did not supply a sender ID.');
    }
    if (!nativeChannelId || !scoped.includes(nativeChannelId)) {
      throw new GovernanceReadToolError(
        'channel_out_of_scope',
        `This tool is limited to its approved ${audience} channel.`,
      );
    }
    if (!reader) {
      throw new GovernanceReadToolError(
        'identity_source_unavailable',
        'This installation has no backend workspace configured for this channel, so no member record is available.',
      );
    }
    const resolved: GovernanceReadToolReader = reader;
    return resolved.resolveSlackMember(senderId);
  };

  /**
   * A read outage is not a governance answer. When the community record itself could not be read,
   * every read tool reports an unavailable identity check instead of reading the failed lookup as an
   * unlinked or unauthorized account; no member status or role is disclosed either way.
   */
  const identityCheckUnavailable = (audience: string) =>
    new GovernanceReadToolError(
      'identity_check_unavailable',
      `The community record for your Slack account could not be read, so this ${audience} tool refuses instead of treating the failed lookup as an unlinked account.`,
    );

  return [
    {
      name: 'rein_member_status',
      description:
        'Report whether your own Slack account is linked to a community record, and whether that record is an active Contributor or a director. Answers about the trusted sender only, from the organization database, and never returns the private contact ID. Read-only: it grants no role and authorizes no spending.',
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_toolCallId: unknown, args: unknown) {
        try {
          assertNoImpersonationArgs(args);
          const member = await requester('proposal or Board', [...proposalChannelIds, ...boardChannelIds]);
          // Final authority check before the answer leaves the turn.
          assertCurrentInvocation(ctx);
          const linked = member.status === 'resolved';
          const details = {
            tool: 'rein_member_status',
            ok: true,
            linked,
            status: member.status,
            reason: member.reason,
            isActiveContributor: member.isActiveContributor,
            isDirector: member.isDirector,
            authorizesSpending: false,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
        } catch (error) {
          return errorResult('rein_member_status', error);
        }
      },
    },
    {
      name: 'rein_funds',
      description:
        'Read the latest human-entered available-funds snapshot for one currency, or report it as explicitly unknown when no usable snapshot exists. Limited to the trusted Board channel and to senders whose current community record is a director. Read-only: the figure never authorizes, reserves or releases spending.',
      parameters: Type.Object(
        {
          currency: Type.String({
            minLength: 1,
            maxLength: 8,
            description: 'ISO 4217 currency code of the snapshot to read, for example USD',
          }),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId: unknown, args: any) {
        try {
          assertNoImpersonationArgs(args);
          // Channel scope first: a non-Board channel is refused before any database read.
          const member = await requester('Board', boardChannelIds);
          if (member.status === 'unavailable') throw identityCheckUnavailable('Board');
          if (member.status !== 'resolved' || member.isDirector !== true) {
            throw new GovernanceReadToolError(
              'board_membership_required',
              'Reading available funds requires a currently verified director link for your Slack account.',
            );
          }
          const currency = typeof args?.currency === 'string' ? args.currency.trim().toUpperCase() : '';
          const funds = await (reader as GovernanceReadToolReader).readAvailableFunds(currency);
          // Final authority check before the answer leaves the turn.
          assertCurrentInvocation(ctx);
          const details = {
            tool: 'rein_funds',
            ok: funds.status === 'snapshot',
            status: funds.status,
            reason: funds.reason,
            currency: funds.currency,
            availableMinor: funds.availableMinor,
            recordedAt: funds.recordedAt,
            recordedBy: funds.recordedBy,
            sourceNote: funds.sourceNote,
            // Always false: a snapshot is an operator-entered figure, not a payment instruction.
            authorizesSpending: false,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
        } catch (error) {
          return errorResult('rein_funds', error);
        }
      },
    },
    {
      name: 'rein_poll_candidates',
      description:
        'List the stored proposals one configured vote type may currently consider, with each stored identifier, title, status and type: the eligible submissions of that type minus every proposal a currently open round of any type already froze, which is the same free pool a new round is opened over. The caller must be the trusted sender inside the approved Board channel and their current record must make them a director, and the vote type must be named explicitly and already exist in the operator configuration. Read-only: no proposal is created, selected, withdrawn or voted on, and an identifier from this answer is not an approval.',
      parameters: Type.Object(
        {
          voteType: Type.String({
            minLength: 1,
            maxLength: 64,
            description: 'Configured vote type to list candidates for, such as event_single',
          }),
          limit: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: MAX_CANDIDATE_PAGE,
              description: 'Optional page size; defaults to 50 and never exceeds 200',
            }),
          ),
          submittedSince: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 40,
              description: 'Optional ISO instant; only proposals stored at or after it are listed',
            }),
          ),
          excludeProposalIds: Type.Optional(
            Type.Array(Type.String({ minLength: 36, maxLength: 36 }), {
              maxItems: MAX_EXCLUDED_PROPOSAL_IDS,
              description: 'Optional proposal identifiers to leave out of the answer',
            }),
          ),
          includeRecentlyUnselected: Type.Optional(
            Type.Boolean({
              description:
                'Optional; when true, the most recently unselected proposals are listed before the older submissions',
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId: unknown, args: any) {
        try {
          assertNoImpersonationArgs(args);
          assertNoPolicyArgs(args);
          // Shape first: the type must be named and well formed before any read happens, and a name
          // that is not lower snake case is refused instead of being normalized into one.
          const voteType = asVoteType(args?.voteType);
          if (voteType === null) {
            throw new GovernanceReadToolError(
              'vote_type_invalid',
              'voteType must be one configured lower snake case proposal type such as event_single.',
            );
          }
          const limit =
            args?.limit === undefined || args?.limit === null
              ? DEFAULT_CANDIDATE_PAGE
              : typeof args.limit === 'number' && Number.isInteger(args.limit)
                ? args.limit
                : Number.NaN;
          if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CANDIDATE_PAGE) {
            throw new GovernanceReadToolError(
              'candidate_limit_invalid',
              `limit must be a whole number between 1 and ${MAX_CANDIDATE_PAGE}.`,
            );
          }
          let submittedSince: string | null = null;
          if (args?.submittedSince !== undefined && args?.submittedSince !== null) {
            submittedSince = asIsoInstant(args.submittedSince);
            if (submittedSince === null) {
              throw new GovernanceReadToolError(
                'submitted_since_invalid',
                'submittedSince must be one ISO instant such as 2026-09-01T00:00:00Z.',
              );
            }
          }
          let excludeProposalIds: string[] = [];
          if (args?.excludeProposalIds !== undefined && args?.excludeProposalIds !== null) {
            if (!Array.isArray(args.excludeProposalIds) || args.excludeProposalIds.length > MAX_EXCLUDED_PROPOSAL_IDS) {
              throw new GovernanceReadToolError(
                'candidate_exclude_ids_invalid',
                `excludeProposalIds must be an array of at most ${MAX_EXCLUDED_PROPOSAL_IDS} proposal identifiers.`,
              );
            }
            excludeProposalIds = args.excludeProposalIds.map((value: unknown) =>
              typeof value === 'string' && UUID_PATTERN.test(value) ? value : '',
            );
            if (excludeProposalIds.some(value => !value)) {
              throw new GovernanceReadToolError(
                'candidate_exclude_ids_invalid',
                'excludeProposalIds must contain proposal identifiers only.',
              );
            }
          }
          const includeRecentlyUnselected =
            args?.includeRecentlyUnselected === undefined || args?.includeRecentlyUnselected === null
              ? false
              : args.includeRecentlyUnselected;
          if (typeof includeRecentlyUnselected !== 'boolean') {
            throw new GovernanceReadToolError(
              'candidate_buckets_invalid',
              'includeRecentlyUnselected must be true or false.',
            );
          }
          // Only then the acting account and the approved channel, and only then the operator's own
          // type table: a caller outside the Board learns nothing about what is configured.
          const member = await requester('Board', boardChannelIds);
          if (member.status === 'unavailable') throw identityCheckUnavailable('Board');
          if (member.status !== 'resolved' || member.isDirector !== true) {
            throw new GovernanceReadToolError(
              'board_membership_required',
              'Listing the proposals a round may consider requires a currently verified director link for your Slack account.',
            );
          }
          // The candidate source is required for this tool only. A process given a reader but no
          // writer reports the source as unavailable instead of an empty pool.
          const candidateWriter = requireWriter(writer);
          const configured = (await readConfiguredVoteTypes(candidateWriter)).voteTypes;
          if (!configured.includes(voteType)) {
            throw new GovernanceReadToolError(
              'vote_type_not_configured',
              'That proposal type is not configured; the type and its limits are operator configuration.',
              {
                voteType,
                configuredVoteTypes: [...configured],
                nextStep: 'ask_an_operator_to_configure_the_vote_type',
              },
            );
          }
          const listed = await candidateWriter.listCandidateProposals({
            voteType,
            limit,
            ...(excludeProposalIds.length === 0 ? {} : { excludeProposalIds }),
            ...(submittedSince === null ? {} : { submittedSince }),
            includeRecentlyUnselected,
          });
          if (!listed.ok || !listed.proposals) {
            // A failed read carries no proposal and no count at all: an outage is never reported as
            // an empty pool, so a caller cannot mistake it for "nothing can be voted on".
            throw new GovernanceReadToolError(
              'candidate_pool_unavailable',
              'The eligible proposals of this type could not be read.',
            );
          }
          // Final authority check before the answer leaves the turn.
          assertCurrentInvocation(ctx);
          const candidates = listed.proposals.map(candidateListing);
          const details = {
            tool: 'rein_poll_candidates',
            ok: true,
            status: listed.status,
            reason: listed.reason,
            voteType,
            candidates,
            candidateCount: candidates.length,
            filters: {
              limit,
              submittedSince,
              excludeProposalIds: [...excludeProposalIds],
              includeRecentlyUnselected,
              eligibleStatuses: [...CANDIDATE_STATUSES],
            },
            // The stored statuses this listing reports; anything else is not a candidate.
            eligibleStatuses: [...CANDIDATE_STATUSES],
            // Always false: an identifier read here is not an approval and no round is opened.
            authorizesSpending: false as const,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
        } catch (error) {
          return errorResult('rein_poll_candidates', error);
        }
      },
    },
    {
      name: 'rein_vote_type_resolve',
      description:
        'Resolve one spoken proposal-type phrase to a configured vote type, using only the display names and aliases the operator wrote in configuration. The phrase is normalized (trimmed, internal whitespace collapsed, case folded) and matched by exact equality: one configured match resolves, several are reported as ambiguous with no type chosen, and none is reported as unmapped. A resolved type is returned only after the operator\'s stored type table is read and already has it. Limited to the trusted sender inside an approved proposal or Board channel; a proposal channel requires a currently active Contributor and a Board channel a current director. Read-only: it lists no proposal, reports no candidate count and writes nothing.',
      parameters: Type.Object(
        {
          phrase: Type.String({
            minLength: 1,
            maxLength: MAX_RESOLVE_PHRASE_LENGTH,
            description: 'The proposal type phrase as the person wrote it, in their own words',
          }),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId: unknown, args: any) {
        try {
          assertNoImpersonationArgs(args);
          assertNoPolicyArgs(args);
          // Shape first: a phrase that is not usable text is refused before any identity read, and
          // nothing about the approved channels or the operator's labels is disclosed to it.
          const phrase = typeof args?.phrase === 'string' ? args.phrase : null;
          if (phrase === null || phrase.length > MAX_RESOLVE_PHRASE_LENGTH || !normalizeVoteTypePhrase(phrase)) {
            throw new GovernanceReadToolError(
              'vote_type_phrase_invalid',
              `phrase must be one text phrase of at most ${MAX_RESOLVE_PHRASE_LENGTH} characters with at least one non-whitespace character.`,
            );
          }
          // The acting account comes only from host context, and the channel decides which current
          // standing the caller must have. A channel approved for both audiences takes the stricter
          // Board requirement.
          const member = await requester('proposal or Board', [...proposalChannelIds, ...boardChannelIds]);
          const linkRequired = new GovernanceReadToolError(
            'identity_link_required',
            'Resolving a proposal type requires a verified link between your Slack account and a community record.',
          );
          if (boardChannelIds.includes(nativeChannelId)) {
            if (member.status === 'unavailable') throw identityCheckUnavailable('Board');
            if (member.status !== 'resolved' || !member.contactId) throw linkRequired;
            if (member.isDirector !== true) {
              throw new GovernanceReadToolError(
                'board_membership_required',
                'Resolving a proposal type from the Board channel requires a currently verified director link for your Slack account.',
              );
            }
          } else {
            if (member.status === 'unavailable') throw identityCheckUnavailable('proposal');
            if (member.status !== 'resolved' || !member.contactId) throw linkRequired;
            if (member.isActiveContributor !== true) {
              throw new GovernanceReadToolError(
                'contributor_status_required',
                'Resolving a proposal type before submitting requires a currently active Contributor record for your Slack account.',
              );
            }
          }
          // The operator's own labels decide every match. An ambiguous phrase hands back no type at
          // all, so the two candidates reach the caller as a question and never as a guess.
          const resolution = resolveVoteTypePhrase(phrase, voteTypeLabels);
          if (resolution.status === 'invalid') {
            throw new GovernanceReadToolError(
              'vote_type_phrase_invalid',
              'phrase must be one text phrase with at least one non-whitespace character.',
            );
          }
          if (resolution.status === 'ambiguous') {
            assertCurrentInvocation(ctx);
            const details = {
              tool: 'rein_vote_type_resolve',
              ok: true,
              status: 'ambiguous',
              phrase: normalizeVoteTypePhrase(phrase),
              matches: resolution.matches.map(label => ({
                voteType: label.voteType,
                displayName: label.displayName,
              })),
              // Named explicitly so a caller cannot read the list above as a chosen type.
              chosenVoteType: null,
              nextStep: 'ask_the_requester_which_of_these_types_they_mean',
              // Always false: resolving a name is not an approval of anything.
              authorizesSpending: false as const,
            };
            return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
          }
          // Both remaining outcomes name the operator's stored types, so the table is read here and
          // a failed read is an outage rather than an empty configuration.
          const typeWriter = requireVoteTypeWriter(writer);
          const configuredRead = await readConfiguredVoteTypes(typeWriter);
          const configured = configuredRead.voteTypes;
          if (resolution.status === 'unmapped') {
            assertCurrentInvocation(ctx);
            const details = {
              tool: 'rein_vote_type_resolve',
              ok: true,
              status: 'unmapped',
              reason: configuredRead.reason,
              phrase: normalizeVoteTypePhrase(phrase),
              // The operator's own words for the types that do exist, and null where the operator
              // wrote no display name; the caller asks rather than inventing one.
              configuredTypes: configured.map(voteType => ({
                voteType,
                displayName: displayNameForVoteType(voteTypeLabels, voteType),
              })),
              chosenVoteType: null,
              nextStep: 'ask_the_requester_which_configured_type_they_mean',
              authorizesSpending: false as const,
            };
            return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
          }
          // Exactly one operator label matched. It is handed back only when the stored type table
          // already has that code, so a stale label can never become a type the write tools reject.
          if (!configured.includes(resolution.voteType)) {
            throw new GovernanceReadToolError(
              'vote_type_alias_not_configured',
              'The configured name for that phrase points at a proposal type the operator has not stored, so no type is handed back.',
              {
                voteType: resolution.voteType,
                displayName: resolution.displayName,
                configuredVoteTypes: [...configured],
                nextStep: 'ask_an_operator_to_configure_the_vote_type',
              },
            );
          }
          // Final authority check before the answer leaves the turn.
          assertCurrentInvocation(ctx);
          const details = {
            tool: 'rein_vote_type_resolve',
            ok: true,
            status: 'resolved',
            reason: configuredRead.reason,
            phrase: normalizeVoteTypePhrase(phrase),
            voteType: resolution.voteType,
            displayName: resolution.displayName,
            // Always false: a resolved type is a configuration answer, not an approval.
            authorizesSpending: false as const,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
        } catch (error) {
          return errorResult('rein_vote_type_resolve', error);
        }
      },
    },
  ];
}

/**
 * Build the v2 tool factory for the governance read tools. Register it as
 * `api.registerTool(createGovernanceReadToolRegistration({ config }), { names: GOVERNANCE_READ_TOOL_NAMES })`.
 * When the foundationDb block is absent or disabled, `create` returns null and no tool is registered.
 */
export function createGovernanceReadToolRegistration(options?: GovernanceReadToolsOptions) {
  const config = resolveGovernanceReadConfig(options);
  return {
    contextVersion: 2 as const,
    create(ctx: any) {
      if (!config) return null;
      return buildTools(config, ctx);
    },
  };
}
