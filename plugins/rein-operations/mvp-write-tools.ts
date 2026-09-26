// MVP write tools: Contributor proposal intake, Board approval polls, one immutable ballot per
// director per poll, and the round result.
//
// Scope: PRD R02 (a chat account acts only after an explicit link to a community record, and a
// display name never establishes identity), R04-R08 with D04/D08/D09 (approval-only voting: one
// equal weight per eligible director, explicit approvals or abstain, no reject choice), C15 (a
// requested amount is a request, never an authorization) and the fail-closed posture of AC01/AC06.
// This module registers only under an explicit `mvp` config block, exactly like `mvp-read-tools.ts`.
//
// Trust boundary:
// - The acting account comes only from `ctx.requesterSenderId`, the approved channel only from
//   `ctx.nativeChannelId`. No tool argument is ever read as an actor, known impersonation and role
//   arguments are refused before any database call, and the caller must be inside an approved
//   native channel before any read or write happens.
// - `assertCurrentInvocation` is re-checked immediately before a write and before any answer leaves
//   the turn, so a cancelled or stale turn cannot commit or report.
// - Every refusal collapses to a fixed reason code. A Supabase URL, the Slack team id, a credential
//   and the private contact id resolved from the identity link never reach a result, a status or an
//   error message.
//
// Status of this module:
// - `rein_mvp_vote` is wired to `foundation-db-writer.ts`: it reads the stored poll, refuses a
//   closed or not-yet-open window, refuses an approval outside the poll's candidate list or above
//   the poll's own approval limit, re-checks the invocation guard and then records one immutable
//   ballot. The database stays the authority for every one of those rules.
// - `rein_mvp_proposal_submit` is wired: the only proposer is the trusted sender's own linked,
//   currently active Contributor record, the named vote type is validated as lower snake case and
//   then left to the database's type configuration and foreign key, a requested amount is stored as
//   a request, and the record identifier is minted once per turn and reused when the host retries
//   the same tool call in that turn.
// - `rein_mvp_poll_open` is wired: a current director opens one round of a named vote type, the tool
//   reads that type's own candidate cap, assembles the candidate pool from stored proposals
//   (offering recently unselected proposals too) and lets the database freeze the list. No caller
//   supplies candidates, a candidate limit or option labels, and a round needs at least one
//   candidate.
// - `rein_mvp_poll_result` is wired: before the deadline it returns the readable facts of the round
//   and answers `provisional` with no count and no winner; at or after the deadline it calls
//   `writer.finalizePoll` with the trusted sender's own director record, so the database closes the
//   round and the stored outcome is what comes back. A finalized round reports its own recorded
//   outcome on every later call rather than counting again, and a tie or an all-abstain round keeps
//   its `no_winner` outcome. This module never counts ballots into an outcome of its own and never
//   reads a caller-supplied weight.
// - Every wired path reaches only the writer methods `foundation-db-writer.ts` already exposes.
//
// Nothing in this module posts a message, and no tool here authorizes, moves or records money: a
// stored proposal is a request and a poll outcome is a decision record.

import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { createFoundationDbReader } from './foundation-db-reader.ts';
import { createFoundationDbWriter } from './foundation-db-writer.ts';
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
export const MVP_WRITE_TOOL_NAMES = Object.freeze([
  'rein_mvp_proposal_submit',
  'rein_mvp_poll_open',
  'rein_mvp_vote',
  'rein_mvp_poll_result',
]);

export class MvpWriteToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MvpWriteToolError';
    this.code = code;
  }
}

/** The one reader method this slice uses: resolve a trusted Slack sender to a community record. */
export interface MvpWriteToolReader {
  resolveSlackMember(slackUserId: string): Promise<SlackMemberResolution>;
}

/**
 * The writer methods this module calls: the proposal and poll writes, the stored poll and ballot
 * reads the ballot path and the result path perform, the vote type rule and candidate pool the
 * poll path assembles a round from, and the finalize RPC the result path submits after the
 * deadline. Every one of them keeps the database as the authority for the per-type caps, for the
 * frozen candidate list and for the counted outcome.
 */
export type MvpWriteToolWriter = Pick<
  FoundationDbWriter,
  | 'submitProposal'
  | 'createPoll'
  | 'getPoll'
  | 'listBallots'
  | 'castBallot'
  | 'getVoteType'
  | 'listCandidateProposals'
  | 'finalizePoll'
>;

export interface MvpWriteToolsOptions {
  /**
   * The `mvp` block of plugin config, read as untrusted input. Expected keys: `enabled`, `platform`
   * (`slack`), `slackTeamId`, `environment` (`dev` or `prod`), `proposalChannelIds`,
   * `boardChannelIds`, `supabaseUrlEnvVar` and `supabaseServiceKeyEnvVar`. The last two name server
   * environment variables; no credential is ever read from config. Absent or `enabled: false`
   * registers no tools.
   */
  config?: Record<string, unknown>;
  /** Server environment holding the referenced values. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injectable reader for tests and local rehearsal; skips the env-var lookups. */
  reader?: MvpWriteToolReader;
  /** Injectable writer for tests and local rehearsal; skips the env-var lookups. */
  writer?: MvpWriteToolWriter;
  /** Injectable clock for deterministic rehearsal; defaults to the wall clock. */
  now?: () => Date;
}

interface ResolvedMvpWriteConfig {
  platform: 'slack';
  proposalChannelIds: string[];
  boardChannelIds: string[];
  reader: MvpWriteToolReader;
  writer: MvpWriteToolWriter;
  now: () => Date;
}

const SLACK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
/** Lower snake case, exactly the shape the vote type table stores. */
const VOTE_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_TITLE_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 4000;
const MAX_APPROVALS = 200;

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
  throw new MvpWriteToolError('mvp_config_invalid', `mvp write tools: ${message}`);
}

function readChannelIds(field: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    configError(`mvp.${field} must list at least one approved native channel ID`);
  }
  const channels = (value as unknown[]).map(id => (typeof id === 'string' ? id.trim() : ''));
  if (channels.some(id => !id)) {
    configError(`mvp.${field} must contain non-empty native channel ID strings`);
  }
  return channels;
}

/** Validate one environment-variable reference. Only the variable *name* is ever reported. */
function readEnvReference(reference: unknown, field: string): string {
  if (typeof reference !== 'string' || !ENV_VAR_NAME_PATTERN.test(reference.trim())) {
    configError(`mvp.${field} must name a server environment variable`);
  }
  return (reference as string).trim();
}

/** Resolve one referenced value from the server environment, or fail without echoing it. */
function readEnvValue(env: Record<string, string | undefined>, name: string, field: string): string {
  const value = env?.[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new MvpWriteToolError(
      'mvp_env_value_missing',
      `mvp write tools: server environment variable ${name} referenced by mvp.${field} is unset or empty`,
    );
  }
  return value.trim();
}

/**
 * Validate the operator configuration. Returns null when the MVP block is absent or disabled so the
 * caller registers no tools; throws on an enabled-but-incomplete block so a misconfiguration fails
 * loudly instead of silently exposing nothing. The same block configures the read slice, so the
 * checks and reason codes match `mvp-read-tools.ts`.
 */
function resolveMvpWriteConfig(options?: MvpWriteToolsOptions): ResolvedMvpWriteConfig | null {
  const config = options?.config;
  if (!config || typeof config !== 'object' || config.enabled !== true) return null;

  // P0 uses exactly one chat platform, and this slice is Slack-only.
  if (config.platform !== 'slack') {
    configError('mvp.platform must be "slack"; these tools act on Slack host context only');
  }
  const slackTeamId = typeof config.slackTeamId === 'string' ? config.slackTeamId.trim() : '';
  if (!SLACK_ID_PATTERN.test(slackTeamId)) {
    configError('mvp.slackTeamId must be one Slack team ID such as T01234567 (one workspace per installation)');
  }
  const proposalChannelIds = readChannelIds('proposalChannelIds', config.proposalChannelIds);
  const boardChannelIds = readChannelIds('boardChannelIds', config.boardChannelIds);
  const environment = config.environment;
  if (environment !== 'dev' && environment !== 'prod') {
    configError("mvp.environment must be 'dev' or 'prod'; it chooses the database table set");
  }

  // The configuration always names the server environment variables; the values are only read when
  // the caller injected neither a reader nor a writer, so a rehearsal can supply its own without
  // credentials.
  const urlReference = readEnvReference(config.supabaseUrlEnvVar, 'supabaseUrlEnvVar');
  const keyReference = readEnvReference(config.supabaseServiceKeyEnvVar, 'supabaseServiceKeyEnvVar');

  let reader: MvpWriteToolReader | undefined = options?.reader;
  let writer: MvpWriteToolWriter | undefined = options?.writer;
  if (!reader || !writer) {
    const env = options?.env ?? process.env;
    const supabaseUrl = readEnvValue(env, urlReference, 'supabaseUrlEnvVar');
    const serviceRoleKey = readEnvValue(env, keyReference, 'supabaseServiceKeyEnvVar');
    if (!reader) {
      reader = createFoundationDbReader({ supabaseUrl, serviceRoleKey, environment, slackTeamId });
    }
    if (!writer) {
      writer = createFoundationDbWriter({ supabaseUrl, serviceRoleKey, environment });
    }
  }
  if (!reader || typeof reader.resolveSlackMember !== 'function') {
    configError('the injected reader must implement resolveSlackMember');
  }
  if (
    !writer ||
    typeof writer.submitProposal !== 'function' ||
    typeof writer.createPoll !== 'function' ||
    typeof writer.getPoll !== 'function' ||
    typeof writer.listBallots !== 'function' ||
    typeof writer.castBallot !== 'function' ||
    typeof writer.getVoteType !== 'function' ||
    typeof writer.listCandidateProposals !== 'function' ||
    typeof writer.finalizePoll !== 'function'
  ) {
    configError(
      'the injected writer must implement submitProposal, createPoll, getPoll, listBallots, castBallot, getVoteType, listCandidateProposals and finalizePoll',
    );
  }

  const now = typeof options?.now === 'function' ? options.now : () => new Date();
  return { platform: 'slack', proposalChannelIds, boardChannelIds, reader, writer, now };
}

function assertNoImpersonationArgs(args: unknown) {
  if (!args || typeof args !== 'object') return;
  for (const key of IMPERSONATION_KEYS) {
    if (Object.hasOwn(args, key)) {
      throw new MvpWriteToolError(
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
      throw new MvpWriteToolError(
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
  const details = { tool, ok: false as const, error: code, message: describe(error) };
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
}

/**
 * Report a round that is still open, or one that holds no record yet. The stored poll and the
 * readable ballots are real facts, but no count and no winner is published and nothing is finalized,
 * so `ok` stays false: a provisional read is not an outcome.
 */
function provisionalResult(
  tool: string,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  const details = {
    tool,
    ok: false as const,
    status: 'provisional' as const,
    error: 'provisional',
    reason,
    ...extra,
    message,
    authorizesSpending: false as const,
  };
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
}

function buildTools(config: ResolvedMvpWriteConfig, ctx: any) {
  const { proposalChannelIds, boardChannelIds, reader, writer, now } = config;

  const nativeChannelId = typeof ctx?.nativeChannelId === 'string' ? ctx.nativeChannelId.trim() : '';
  const senderId = typeof ctx?.requesterSenderId === 'string' ? ctx.requesterSenderId.trim() : '';

  // Resolve the trusted sender, or refuse before any database call. `audience` narrows which
  // approved channels may call this tool; the acting account is never taken from arguments.
  const requester = (audience: string, scoped: string[]) => {
    if (ctx?.messageChannel !== 'slack') {
      throw new MvpWriteToolError('platform_out_of_scope', 'These tools act on Slack host context only.');
    }
    if (!senderId) {
      throw new MvpWriteToolError('trusted_requester_unavailable', 'The host did not supply a sender ID.');
    }
    if (!nativeChannelId || !scoped.includes(nativeChannelId)) {
      throw new MvpWriteToolError(
        'channel_out_of_scope',
        `This tool is limited to its approved ${audience} channel.`,
      );
    }
    return reader.resolveSlackMember(senderId);
  };

  const linkRequired = (audience: string) =>
    new MvpWriteToolError(
      'identity_link_required',
      `This ${audience} tool requires a verified link between your Slack account and a community record.`,
    );

  /** Proposal intake needs a linked record that is currently an active Contributor (D06, R02). */
  const proposalRequester = async (): Promise<SlackMemberResolution & { contactId: string }> => {
    const member = await requester('proposal', proposalChannelIds);
    if (member.status !== 'resolved' || !member.contactId) throw linkRequired('proposal');
    if (member.isActiveContributor !== true) {
      throw new MvpWriteToolError(
        'contributor_status_required',
        'Submitting a proposal requires a currently active Contributor record for your Slack account.',
      );
    }
    return { ...member, contactId: member.contactId };
  };

  /** Board tools need a linked record that is currently a director, in an approved Board channel. */
  const boardRequester = async (): Promise<SlackMemberResolution & { contactId: string }> => {
    const member = await requester('Board', boardChannelIds);
    if (member.status !== 'resolved' || !member.contactId) throw linkRequired('Board');
    if (member.isDirector !== true) {
      throw new MvpWriteToolError(
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
      throw new MvpWriteToolError('clock_invalid', `The configured clock failed: ${describe(error)}`);
    }
    if (!ISO_INSTANT_PATTERN.test(iso)) {
      throw new MvpWriteToolError('clock_invalid', 'The configured clock did not return a valid instant.');
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
      throw new MvpWriteToolError(
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

  /** A title is required, trimmed and bounded; a whitespace-only title is not a title. */
  const resolveTitle = (value: unknown): string => {
    const title = typeof value === 'string' ? value.trim() : '';
    if (title.length < 1 || title.length > MAX_TITLE_LENGTH) {
      throw new MvpWriteToolError(
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
      throw new MvpWriteToolError(
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
      throw new MvpWriteToolError(
        'proposal_request_incomplete',
        'A requested amount and its currency are recorded together or not at all.',
      );
    }
    if (
      typeof requestedMinorValue !== 'number' ||
      !Number.isInteger(requestedMinorValue) ||
      requestedMinorValue < 0
    ) {
      throw new MvpWriteToolError(
        'proposal_requested_minor_invalid',
        'requestedMinor must be a whole number of minor units, zero or more.',
      );
    }
    const currency = typeof currencyValue === 'string' ? currencyValue.trim().toUpperCase() : '';
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new MvpWriteToolError(
        'proposal_currency_invalid',
        'currency must be one ISO 4217 code such as USD.',
      );
    }
    return { requestedMinor: requestedMinorValue, currency };
  };

  /** One lower snake case proposal type name, or a fixed refusal before any database call. */
  const resolveVoteType = (value: unknown): string => {
    const voteType = asVoteType(value);
    if (voteType === null) {
      throw new MvpWriteToolError(
        'vote_type_invalid',
        'voteType must be one configured lower snake case proposal type such as event_budget.',
      );
    }
    return voteType;
  };

  /**
   * Read one stored poll. An unavailable provider is never reported as a missing poll, so a caller
   * cannot mistake an outage for a decision that was never made.
   */
  const readPoll = async (pollId: string): Promise<PollRecord> => {
    const result = await writer.getPoll(pollId);
    if (!result.ok || !result.poll) {
      if (result.reason === 'poll_not_found') {
        throw new MvpWriteToolError('poll_not_found', 'No stored poll has that identifier.');
      }
      throw new MvpWriteToolError('poll_lookup_unavailable', 'The stored poll could not be read.');
    }
    return result.poll;
  };

  /**
   * Read the operator-configured rule of one vote type. Its candidate cap and approval limit are the
   * round's own limits; an unknown type is refused by name and an outage is never read as one.
   */
  const readVoteType = async (voteType: string): Promise<VoteTypeRecord> => {
    const result = await writer.getVoteType(voteType);
    if (!result.ok || !result.voteType) {
      if (result.reason === 'vote_type_not_found') {
        throw new MvpWriteToolError(
          'vote_type_not_found',
          'No configured vote type has that name; the type and its limits are operator configuration.',
        );
      }
      throw new MvpWriteToolError('vote_type_lookup_unavailable', 'The configured vote type could not be read.');
    }
    return result.voteType;
  };

  /**
   * Read the proposals a round of this type may consider. The pool is the database's answer: it
   * already excludes proposals that were selected or withdrawn, offers recently unselected ones
   * first, and never returns another type's proposals.
   */
  const readCandidatePool = async (
    voteType: string,
    limit: number,
    submittedSince: string | null,
  ): Promise<ProposalRecord[]> => {
    const listed = await writer.listCandidateProposals({
      voteType,
      limit,
      ...(submittedSince === null ? {} : { submittedSince }),
      includeRecentlyUnselected: true,
    });
    if (!listed.ok || !listed.proposals) {
      throw new MvpWriteToolError(
        'candidate_pool_unavailable',
        'The eligible proposals of this type could not be read.',
      );
    }
    return [...listed.proposals];
  };

  /**
   * Normalize one ballot's approvals. Approving nothing is the abstention and is always allowed.
   * The database re-checks all of this, so a refusal here only avoids a pointless write.
   */
  const resolveApprovals = (value: unknown, poll: PollRecord): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new MvpWriteToolError(
        'approved_proposal_ids_invalid',
        'approvedProposalIds must be an array of candidate proposal identifiers.',
      );
    }
    if (value.length > MAX_APPROVALS) {
      throw new MvpWriteToolError(
        'approved_proposal_ids_invalid',
        `approvedProposalIds accepts at most ${MAX_APPROVALS} entries.`,
      );
    }
    const approved: string[] = [];
    for (const entry of value as unknown[]) {
      const id = asUuid(entry);
      if (id === null || approved.includes(id)) {
        throw new MvpWriteToolError(
          'approved_proposal_ids_invalid',
          'Every entry must be one canonical proposal identifier, without repeats.',
        );
      }
      approved.push(id);
    }
    if (approved.length > poll.maxApprovalsPerVoter) {
      throw new MvpWriteToolError(
        'too_many_approvals',
        `This poll counts at most ${poll.maxApprovalsPerVoter} approvals per voter.`,
      );
    }
    for (const id of approved) {
      if (!poll.candidateProposalIds.includes(id)) {
        throw new MvpWriteToolError(
          'approved_proposal_not_in_poll',
          'Every approved proposal must be a candidate of this poll.',
        );
      }
    }
    return approved;
  };

  return [
    {
      name: 'rein_mvp_proposal_submit',
      description:
        'Submit a funding request as your own linked community record. The caller must be the trusted sender inside an approved proposal channel and their current record must make them an active Contributor; the proposer is never taken from an argument. The request is stored against one configured proposal type, and a requested amount is recorded as a request that no one has approved. A retry of the same tool call in this turn is the same record.',
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
        },
        { additionalProperties: false },
      ),
      async execute(toolCallId: unknown, args: any) {
        try {
          assertNoImpersonationArgs(args);
          assertNoPolicyArgs(args);
          const voteType = resolveVoteType(args?.voteType);
          const title = resolveTitle(args?.title);
          const summary = resolveSummary(args?.summary);
          const request = resolveRequest(args?.requestedMinor, args?.currency);
          const member = await proposalRequester();
          const id = recordId('proposal', toolCallId);
          // Final authority check immediately before the write: a stale turn cannot commit.
          assertCurrentInvocation(ctx);
          // The vote type is stored as given: the database holds the type table and the foreign key,
          // so an unconfigured type is refused there rather than guessed here.
          const written = await writer.submitProposal({
            id,
            proposerContactId: member.contactId,
            title,
            summary,
            voteType,
            requestedMinor: request.requestedMinor,
            currency: request.currency,
          });
          const details = {
            tool: 'rein_mvp_proposal_submit',
            ok: written.ok,
            status: written.status,
            reason: written.reason,
            ...(written.ok ? {} : { error: written.reason }),
            proposalId: id,
            voteType,
            requestedMinor: request.requestedMinor,
            currency: request.currency,
            recorded: written.ok,
            // A stored request is not a funding decision and no tool here approves spending.
            authorizesSpending: false as const,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
        } catch (error) {
          return errorResult('rein_mvp_proposal_submit', error);
        }
      },
    },
    {
      name: 'rein_mvp_poll_open',
      description:
        'Open one Board approval round over the stored proposals of one configured vote type, with an explicit closing time. The caller must be the trusted sender inside the approved Board channel and their current record must make them a director. The round takes its candidate cap from that stored type and the Agent reads the candidate pool itself, so no candidate list, cap or label is accepted from the caller. The database freezes the candidate list and the limits, and a round needs at least one candidate. A retry of the same tool call in this turn is the same round.',
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
          const voteType = resolveVoteType(args?.voteType);
          const title = resolveTitle(args?.title);
          const closesAt = asIsoInstant(args?.closesAt);
          if (closesAt === null) {
            throw new MvpWriteToolError(
              'poll_closes_at_invalid',
              'closesAt must be one ISO instant such as 2026-09-26T18:00:00Z.',
            );
          }
          const submittedSince =
            args?.submittedSince === undefined || args?.submittedSince === null
              ? null
              : asIsoInstant(args.submittedSince);
          if (args?.submittedSince !== undefined && args?.submittedSince !== null && submittedSince === null) {
            throw new MvpWriteToolError(
              'submitted_since_invalid',
              'submittedSince must be one ISO instant such as 2026-09-01T00:00:00Z.',
            );
          }
          const member = await boardRequester();
          const rule = await readVoteType(voteType);
          const opensAt = instant();
          if (Date.parse(closesAt) <= Date.parse(opensAt)) {
            throw new MvpWriteToolError(
              'poll_window_invalid',
              'closesAt must be later than the current time, because a round opens now.',
            );
          }
          // The type's own cap bounds the pool, and the first candidates the database returns are
          // the ones the round is opened over.
          const pool = await readCandidatePool(voteType, rule.maxCandidates, submittedSince);
          const candidateProposalIds = pool.slice(0, rule.maxCandidates).map(proposal => proposal.id);
          if (candidateProposalIds.length === 0) {
            throw new MvpWriteToolError(
              'no_candidate_proposals',
              'No stored proposal of this type is available, so no round is opened.',
            );
          }
          const id = recordId('poll', toolCallId);
          // Final authority check immediately before the write: a stale turn cannot open a round.
          assertCurrentInvocation(ctx);
          // No cap and no approval limit travels with this call: the database freezes both from the
          // stored vote type, and it freezes the candidate list it accepts.
          const written = await writer.createPoll({
            id,
            creatorContactId: member.contactId,
            title,
            voteType,
            candidateProposalIds,
            opensAt,
            closesAt,
          });
          const storedCandidates = written.poll?.candidateProposalIds ?? candidateProposalIds;
          const details = {
            tool: 'rein_mvp_poll_open',
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
            candidateLimit: rule.maxCandidates,
            maxApprovalsPerVoter: rule.maxApprovalsPerVoter,
            recorded: written.ok,
            authorizesSpending: false as const,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
        } catch (error) {
          return errorResult('rein_mvp_poll_open', error);
        }
      },
    },
    {
      name: 'rein_mvp_vote',
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
            throw new MvpWriteToolError('poll_id_invalid', 'pollId must be one stored poll identifier.');
          }
          const member = await boardRequester();
          const poll = await readPoll(pollId);
          // The recorded poll window decides, not the caller. A cancelled poll is never reopened.
          if (poll.status === 'cancelled') {
            throw new MvpWriteToolError('poll_cancelled', 'This poll was cancelled, so no ballot is recorded.');
          }
          if (poll.status !== 'open') {
            throw new MvpWriteToolError('poll_closed', 'This poll is closed, so no ballot is recorded.');
          }
          const at = instant();
          if (Date.parse(at) < Date.parse(poll.opensAt)) {
            throw new MvpWriteToolError('poll_not_open', 'This poll has not opened yet.');
          }
          if (Date.parse(at) >= Date.parse(poll.closesAt)) {
            throw new MvpWriteToolError('poll_closed', 'This poll closed before this ballot arrived.');
          }
          const approvedProposalIds = resolveApprovals(args?.approvedProposalIds, poll);
          // Final authority check immediately before the write: a stale turn cannot commit.
          assertCurrentInvocation(ctx);
          const written = await writer.castBallot({
            pollId,
            voterContactId: member.contactId,
            approvedProposalIds,
          });
          const details = {
            tool: 'rein_mvp_vote',
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
          return errorResult('rein_mvp_vote', error);
        }
      },
    },
    {
      name: 'rein_mvp_poll_result',
      description:
        'Report the result of one stored poll. Before the deadline this is provisional: it returns the readable facts of the round and publishes no count and no winner. At or after the deadline the database closes the round and counts the recorded ballots at one equal weight per director; the stored outcome is what comes back, so a tie or an all-abstain round reports no winner and an already finalized round reports its recorded outcome unchanged. Limited to the trusted Board channel and to senders whose current community record is a director. A decision record moves no money.',
      parameters: Type.Object(
        { pollId: Type.String({ minLength: 1, maxLength: 64, description: 'Stored poll identifier' }) },
        { additionalProperties: false },
      ),
      async execute(_toolCallId: unknown, args: any) {
        try {
          assertNoImpersonationArgs(args);
          const pollId = asUuid(args?.pollId);
          if (pollId === null) {
            throw new MvpWriteToolError('poll_id_invalid', 'pollId must be one stored poll identifier.');
          }
          const member = await boardRequester();
          const poll = await readPoll(pollId);
          const at = instant();
          // The stored window decides, exactly as it does for a ballot. A cancelled round is never
          // reopened and is never finalized, so its provisional read names no outcome.
          const closed = poll.status !== 'open' || Date.parse(at) >= Date.parse(poll.closesAt);
          if (!closed) {
            const recorded = await writer.listBallots(pollId);
            if (!recorded.ok || !recorded.ballots) {
              throw new MvpWriteToolError('result_unavailable', 'The recorded ballots could not be read.');
            }
            // A provisional read is not an outcome: the ballots are counted as a readable fact and
            // no tally and no winner is published. The database is the only counter of an outcome.
            assertCurrentInvocation(ctx);
            return provisionalResult(
              'rein_mvp_poll_result',
              'poll_still_open',
              'This poll is still open, so no outcome exists yet. The recorded ballots are readable, but no count and no winner is published and nothing is finalized before the deadline.',
              {
                pollId,
                pollStatus: poll.status,
                closesAt: poll.closesAt,
                closed: false,
                official: false,
                outcome: null,
                winner: null,
                counts: null,
                totalBallots: recorded.ballots.length,
                finalized: false,
              },
            );
          }
          if (poll.status !== 'open') {
            if (poll.status === 'cancelled') {
              // A cancelled round is over but holds no outcome: it is read back as provisional, never
              // finalized and never re-counted.
              assertCurrentInvocation(ctx);
              return provisionalResult(
                'rein_mvp_poll_result',
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
          const written = await writer.finalizePoll({ pollId, actorContactId: member.contactId });
          if (!written.ok || !written.finalization) {
            throw new MvpWriteToolError(written.reason || 'finalize_failed', 'The outcome could not be finalized.');
          }
          const finalization = written.finalization;
          const details = {
            tool: 'rein_mvp_poll_result',
            ok: true,
            status: written.status,
            reason: written.reason,
            pollId,
            pollStatus: finalization.status,
            closesAt: poll.closesAt,
            closed: true,
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
            finalized: true,
            // An already finalized round answers with the record it stored, so a repeat reports the
            // same outcome instead of counting the ballots a second time.
            repeated: finalization.repeated,
            authorizesSpending: false as const,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
        } catch (error) {
          return errorResult('rein_mvp_poll_result', error);
        }
      },
    },
  ];
}

/**
 * Build the v2 tool factory for the MVP write tools. Register it as
 * `api.registerTool(createMvpWriteToolRegistration({ config }), { names: MVP_WRITE_TOOL_NAMES })`.
 * When the MVP block is absent or disabled, `create` returns null and no tool is registered.
 */
export function createMvpWriteToolRegistration(options?: MvpWriteToolsOptions) {
  const config = resolveMvpWriteConfig(options);
  return {
    contextVersion: 2 as const,
    create(ctx: any) {
      if (!config) return null;
      return buildTools(config, ctx);
    },
  };
}
