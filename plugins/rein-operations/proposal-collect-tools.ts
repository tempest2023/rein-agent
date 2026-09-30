// Multi-turn proposal field collection for the proposal path (case 3).
//
// PRD §2.3 step 2 and `workspace/AGENTS.md` require a proposal to be written only once the required
// fields are present and their author has confirmed the exact version. Between the first vague
// message and that prepared version the fields trickle in, and until now that multi-turn collection
// had no tool at all: `rein_governance_proposal_submit` only constrains the write once every field is
// already known. This module adds the missing read-only step. It takes the fields the proposer has
// said so far, states which of them are still required before a submit, and returns a short prompt
// the agent can ask. It writes nothing and submits nothing, and it never fills a field the proposer
// did not give.
//
// Scope: PRD R04-R08 with D06 (only a currently active Contributor proposes) and the fail-closed
// posture of AC01/AC02/AC06.
//
// Trust boundary, shared with `governance-write-tools.ts`:
// - The acting account comes only from `ctx.requesterSenderId` and the approved channel only from
//   `ctx.nativeChannelId`. No argument is read as an actor, and known impersonation arguments are
//   refused.
// - The caller must be inside an approved proposal channel and their current community record must
//   be an active Contributor. A failed community read is reported as `identity_check_unavailable`,
//   never as an unlinked account.
// - `assertCurrentInvocation` runs before the answer leaves the turn, so a cancelled or stale turn
//   cannot return collected fields.
// - Every refusal collapses to a fixed reason code; no credential, backend base URL, workspace id
//   or private contact id reaches a result.
//
// Confidentiality. The token this tool mints is the same sealed-binding shape the prepare step of
// `rein_governance_proposal_submit` uses, but under its own purpose: `proposal-draft.ts` derives one
// AES-256-GCM key from the same server-only secret with different HKDF salt and label, and its own
// token prefix and version. The plaintext carries the proposer's own words and the private contact
// identifier, so no readable part of the token names the proposer or repeats the text, and the
// proposer binding travels as additional authenticated data: a token lifted onto another proposer
// fails authentication instead of decrypting. The draft domain and the confirmation domain are
// disjoint in both prefix and key, so a draft token is refused as a submit confirmation and a
// confirmation token is refused as a draft, and neither can be re-dated.
//
// Admission of an `approximateWhen`. The proposer's own "roughly next week" is not a stored field:
// the proposal table has no schedule column, so nothing here writes it and nothing here treats it as
// part of the stored request. It travels in the draft token so a later turn can carry it into the
// prepared summary, and the tool states in `summaryConfirmationRequired` that it has to be confirmed
// in the proposal summary the author reads back before submit. The tool never invents a date from it.

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
  COLLECT_DRAFT_TTL_MS,
  COLLECT_TOKEN_CAP,
  draftProposalId,
  draftPreview,
  issueProposalDraft,
  verifyProposalDraft,
} from './proposal-draft.ts';
import { assertCurrentInvocation } from './request-context.ts';
import type { DraftPayload, DraftTokenFailure } from './proposal-draft.ts';
import type { FoundationDbWriter } from './foundation-db-writer.ts';
import type { SlackMemberResolution } from './foundation-db-reader.ts';

/** Names the caller must declare in the manifest and pass to `registerTool(..., { names })`. */
export const GOVERNANCE_COLLECT_TOOL_NAMES = Object.freeze(['rein_proposal_collect']);

export class ProposalCollectToolError extends Error {
  readonly code: string;
  /** Extra facts a refusal may carry, such as which fields are still missing. */
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ProposalCollectToolError';
    this.code = code;
    this.details = details;
  }
}

/** The one reader method this tool uses: resolve a trusted Slack sender to a community record. */
export interface ProposalCollectToolReader {
  resolveSlackMember(slackUserId: string): Promise<SlackMemberResolution>;
}

/** The two read-only writer methods this tool uses: the configured type names and one proposal read. */
export type ProposalCollectToolWriter = Pick<FoundationDbWriter, 'listVoteTypes' | 'getProposal'>;

export interface ProposalCollectToolsOptions {
  /**
   * The `foundationDb` block of plugin config, read as untrusted input. Same keys as the read and
   * write slices: `enabled`, `platform`, `workspaces`, `proposalChannelIds`, `boardChannelIds`,
   * `voteTypeAliases`, and the environment variables naming the backend base URL, the Agent caller
   * ID, the Agent credential and the draft signing key. Absent or `enabled: false` registers no tool.
   */
  config?: Record<string, unknown>;
  /** Server environment holding the referenced values. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injectable backend transport for tests and local rehearsal; skips the env-var lookups. */
  transport?: BackendTransport;
  /** Runtime ingress proof for one tool invocation. Called at execution time, never at registration. */
  proofProvider?: ToolProofProvider;
  /** Injectable reader for tests and local rehearsal; skips the env-var lookups. */
  reader?: ProposalCollectToolReader;
  /** Injectable read-only writer for tests and local rehearsal; skips the env-var lookups. */
  writer?: ProposalCollectToolWriter;
  /**
   * Injectable signing key for the draft token. When omitted, the key is read from the server
   * environment variable named by `foundationDb.proposalConfirmationKeyEnvVar`, the same server-only secret
   * the confirmation token uses.
   */
  signingKey?: string;
  /** Injectable clock for deterministic rehearsal; defaults to the wall clock. */
  now?: () => Date;
}

export interface ResolvedProposalCollectConfig {
  config: ResolvedBackendConfig;
  proposalChannelIds: string[];
  transport: BackendTransport;
  proofProvider?: ToolProofProvider;
  reader?: ProposalCollectToolReader;
  writer?: ProposalCollectToolWriter;
  /** Server-only key that seals one draft token. Never leaves the process. */
  signingKey: string;
  now: () => Date;
}

const VOTE_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const MAX_TITLE_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 4000;
const MAX_LABEL_LENGTH = 120;
const MAX_CONFIGURED_VOTE_TYPES = 200;

/** The token cap this slice advertises in its schema: literally the draft module's own one cap. */
export const MAX_COLLECT_TOKEN_LENGTH = COLLECT_TOKEN_CAP;
/** How long a collected draft stays resumable, in the wording the answer reports. */
export const COLLECT_TTL_MS = COLLECT_DRAFT_TTL_MS;

// Host-supplied identity and role keys a model must never be able to set, shared with the write
// slice: a role or an actor that arrives as an argument would let a prompt grant authority.
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

// Governance parameters a model must never supply. This tool neither selects candidates nor sets a
// cap, but it accepts a `voteType` for validation, so the same policy keys stay refused here.
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

const asVoteType = (value: unknown): string | null =>
  typeof value === 'string' && VOTE_TYPE_PATTERN.test(value) ? value : null;

const asProposalId = (value: unknown): string | null =>
  typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;

function configError(message: string): never {
  throw new ProposalCollectToolError('foundation_db_config_invalid', `foundationDb proposal collect tool: ${message}`);
}

function envValueError(message: string): never {
  throw new ProposalCollectToolError('foundation_db_env_value_missing', `foundationDb proposal collect tool: ${message}`);
}

/**
 * Validate the operator configuration, mirroring the read and write slices. Returns null when the
 * block is absent or disabled; throws on an enabled-but-incomplete block.
 */
function resolveProposalCollectConfig(options?: ProposalCollectToolsOptions): ResolvedProposalCollectConfig | null {
  const config = parseBackendConfig({
    config: options?.config,
    env: options?.env,
    requireConfirmationKey: true,
    ...(options?.signingKey === undefined ? {} : { confirmationSigningKey: options.signingKey }),
    error: configError,
    envError: envValueError,
  });
  if (!config) return null;

  const proposalChannelIds = config.workspaces.flatMap(workspace => [...workspace.proposalChannelIds]);
  const transport = options?.transport ?? createConfiguredTransport(config);
  if (options?.reader && typeof options.reader.resolveSlackMember !== 'function') {
    configError('the injected reader must implement resolveSlackMember');
  }
  if (
    options?.writer &&
    (typeof options.writer.listVoteTypes !== 'function' || typeof options.writer.getProposal !== 'function')
  ) {
    configError('the injected writer must implement listVoteTypes and getProposal');
  }

  const now = typeof options?.now === 'function' ? options.now : () => new Date();
  return {
    config,
    proposalChannelIds,
    transport,
    ...(options?.proofProvider === undefined ? {} : { proofProvider: options.proofProvider }),
    ...(options?.reader === undefined ? {} : { reader: options.reader }),
    ...(options?.writer === undefined ? {} : { writer: options.writer }),
    signingKey: config.confirmationSigningKey as string,
    now,
  };
}

function assertNoImpersonationArgs(args: unknown) {
  if (!args || typeof args !== 'object') return;
  for (const key of IMPERSONATION_KEYS) {
    if (Object.hasOwn(args, key)) {
      throw new ProposalCollectToolError(
        'actor_argument_rejected',
        `The "${key}" argument is not accepted; the acting account comes only from the host context.`,
      );
    }
  }
}

function assertNoPolicyArgs(args: unknown) {
  if (!args || typeof args !== 'object') return;
  for (const key of POLICY_KEYS) {
    if (Object.hasOwn(args, key)) {
      throw new ProposalCollectToolError(
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

function buildTools(config: ResolvedProposalCollectConfig, ctx: any) {
  const { proposalChannelIds, signingKey, now } = config;

  const nativeChannelId = typeof ctx?.nativeChannelId === 'string' ? ctx.nativeChannelId.trim() : '';
  const senderId = typeof ctx?.requesterSenderId === 'string' ? ctx.requesterSenderId.trim() : '';

  // Trusted platform plus channel pick one approved workspace; this call's reader and read-only
  // writer are built against the backend with a per-call proof, resolved on every backend call.
  const workspace = resolveTrustedWorkspace(config.config, ctx);
  const bound = createInvocationAdapters({
    transport: config.transport,
    identity: workspace,
    ...(config.proofProvider === undefined ? {} : { proofProvider: config.proofProvider }),
    ctx,
  });
  const reader: ProposalCollectToolReader | null = config.reader ?? bound?.reader ?? null;
  const writer: ProposalCollectToolWriter | null = config.writer ?? bound?.writer ?? null;

  const requester = (): Promise<SlackMemberResolution> => {
    if (typeof ctx?.messageChannel !== 'string' || !ctx.messageChannel.trim()) {
      throw new ProposalCollectToolError('platform_out_of_scope', 'The host did not supply a chat platform.');
    }
    if (workspace === null) {
      if (/^[a-z][a-z0-9_-]{1,31}$/.test(String(ctx.messageChannel).trim()) &&
          config.config.workspaces.some(item => item.platform === String(ctx.messageChannel).trim())) {
        throw new ProposalCollectToolError(
          'channel_out_of_scope',
          'This channel is outside the approved proposal workspace channels.',
        );
      }
      throw new ProposalCollectToolError('platform_out_of_scope', 'This platform is not an approved governance surface.');
    }
    if (!senderId) {
      throw new ProposalCollectToolError('trusted_requester_unavailable', 'The host did not supply a sender ID.');
    }
    if (!nativeChannelId || !proposalChannelIds.includes(nativeChannelId)) {
      throw new ProposalCollectToolError(
        'channel_out_of_scope',
        'This tool is limited to its approved proposal channel.',
      );
    }
    if (!reader) {
      throw new ProposalCollectToolError(
        'identity_source_unavailable',
        'This installation has no backend workspace configured for this channel, so no member record is available.',
      );
    }
    const resolved: ProposalCollectToolReader = reader;
    return resolved.resolveSlackMember(senderId);
  };

  /**
   * Collecting fields for a proposal needs a linked record that is currently an active Contributor
   * (D06, R02), exactly as the submit path does. A read outage is reported as an unavailable identity
   * check rather than as an unlinked account, so a failure never reads as "you are not linked".
   */
  const collectRequester = async (): Promise<SlackMemberResolution & { contactId: string }> => {
    const member = await requester();
    if (member.status === 'unavailable') {
      throw new ProposalCollectToolError(
        'identity_check_unavailable',
        'The community record for your Slack account could not be read, so this tool refuses instead of treating the failed lookup as an unlinked account.',
      );
    }
    if (member.status !== 'resolved' || !member.contactId) {
      throw new ProposalCollectToolError(
        'identity_link_required',
        'This tool requires a verified link between your Slack account and a community record.',
      );
    }
    if (member.isActiveContributor !== true) {
      throw new ProposalCollectToolError(
        'contributor_status_required',
        'Collecting proposal fields requires a currently active Contributor record for your Slack account.',
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
      throw new ProposalCollectToolError('clock_invalid', `The configured clock failed: ${describe(error)}`);
    }
    if (!ISO_INSTANT_PATTERN.test(iso)) {
      throw new ProposalCollectToolError('clock_invalid', 'The configured clock did not return a valid instant.');
    }
    return iso;
  };

  /** Read the configured type names so a supplied type is checked against the operator's own table. */
  const readConfiguredVoteTypes = async (): Promise<string[]> => {
    if (!writer) {
      throw new ProposalCollectToolError(
        'vote_type_configuration_unavailable',
        'The configured proposal types could not be read, so no type could be checked.',
      );
    }
    const result = await requireWriter().listVoteTypes({ limit: MAX_CONFIGURED_VOTE_TYPES });
    if (!result.ok || !result.voteTypes) {
      throw new ProposalCollectToolError(
        'vote_type_configuration_unavailable',
        'The configured proposal types could not be read, so no type could be checked.',
      );
    }
    return [...result.voteTypes];
  };

  /** A title is required, trimmed and bounded; a whitespace-only title is not a title. */
  const resolveTitle = (value: unknown): string => {
    const title = typeof value === 'string' ? value.trim() : '';
    if (title.length < 1 || title.length > MAX_TITLE_LENGTH) {
      throw new ProposalCollectToolError(
        'title_invalid',
        `title must be ${MAX_TITLE_LENGTH} characters or fewer and not empty.`,
      );
    }
    return title;
  };

  /** An absent summary stays absent; an empty one is carried as no summary rather than as text. */
  const resolveSummary = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.length > MAX_SUMMARY_LENGTH) {
      throw new ProposalCollectToolError(
        'summary_invalid',
        `summary must be text of at most ${MAX_SUMMARY_LENGTH} characters.`,
      );
    }
    const text = value.trim();
    return text.length === 0 ? null : text;
  };

  /**
   * The read-only backend surface, or a refusal when this invocation has no configured workspace.
   * A missing workspace is reported as its own unavailable source, never as an empty configuration.
   */
  const requireWriter = (): ProposalCollectToolWriter => {
    if (!writer) {
      throw new ProposalCollectToolError(
        'candidate_source_unavailable',
        'This installation has no backend workspace configured for this channel, so no stored proposal type could be read.',
      );
    }
    return writer;
  };

  /**
   * The requested amount and its currency are one pair: carried together or not at all, exactly as
   * the submit path records them. A bare number is refused here rather than guessed into a currency.
   */
  const resolveRequest = (
    requestedMinorValue: unknown,
    currencyValue: unknown,
  ): { requestedMinor: number | null; currency: string | null } => {
    const hasAmount = requestedMinorValue !== undefined && requestedMinorValue !== null;
    const hasCurrency = currencyValue !== undefined && currencyValue !== null;
    if (!hasAmount && !hasCurrency) return { requestedMinor: null, currency: null };
    if (hasAmount !== hasCurrency) {
      throw new ProposalCollectToolError(
        'proposal_request_incomplete',
        'A requested amount and its currency are recorded together or not at all.',
      );
    }
    if (
      typeof requestedMinorValue !== 'number' ||
      !Number.isInteger(requestedMinorValue) ||
      requestedMinorValue < 0
    ) {
      throw new ProposalCollectToolError(
        'proposal_requested_minor_invalid',
        'requestedMinor must be a whole number of minor units, zero or more.',
      );
    }
    const currency = typeof currencyValue === 'string' ? currencyValue.trim().toUpperCase() : '';
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new ProposalCollectToolError(
        'proposal_currency_invalid',
        'currency must be one ISO 4217 code such as USD.',
      );
    }
    return { requestedMinor: requestedMinorValue, currency };
  };

  /** A supplied proposal type must be lower snake case and configured; a guess is never made. */
  const resolveVoteType = (value: unknown, configured: readonly string[]): string => {
    const voteType = asVoteType(value);
    if (voteType === null) {
      throw new ProposalCollectToolError(
        'vote_type_invalid',
        configured.length === 0
          ? 'voteType must be one configured lower snake case proposal type; no type is configured yet.'
          : `voteType must be one configured lower snake case proposal type such as ${configured[0]}.`,
      );
    }
    if (!configured.includes(voteType)) {
      throw new ProposalCollectToolError(
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
   * The proposer's rough timing is carried as their own words, not parsed into a date and not stored:
   * the proposal table has no schedule column, so a date invented here would be a guess about a
   * commitment the proposer never made.
   */
  const resolveApproximateWhen = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.length > MAX_LABEL_LENGTH) {
      throw new ProposalCollectToolError(
        'approximate_when_invalid',
        `approximateWhen must be the proposer's own wording of roughly when, at most ${MAX_LABEL_LENGTH} characters.`,
      );
    }
    const text = value.trim();
    return text.length === 0 ? null : text;
  };

  /**
   * Which fields a submit still requires, in a stable order. The two required values are the title
   * and the configured vote type; the amount and its currency count as one entry because they are
   * recorded together or not at all. An unconfigured draft carries no `voteType`, so it is missing.
   */
  const missingFieldsFor = (payload: {
    title: string | null;
    voteType: string | null;
    requestedMinor: number | null;
    currency: string | null;
  }): string[] => {
    const missing: string[] = [];
    if (payload.title === null) missing.push('title');
    if (payload.voteType === null) missing.push('voteType');
    if (payload.requestedMinor === null || payload.currency === null) missing.push('requestedMinor+currency');
    return missing;
  };

  /** Advisory gaps that do not block a submit but are still worth asking the proposer for. */
  const advisoryMissingFieldsFor = (payload: { approximateWhen: string | null }): string[] =>
    payload.approximateWhen === null ? ['approximateWhen'] : [];

  /**
   * The next question to ask, in the proposer's own language and never naming a tool, a field or an
   * implementation term. Each line asks only for something still missing and never fills it in.
   */
  const promptsFor = (missing: readonly string[], advisory: readonly string[]): string[] => {
    const prompts: string[] = [];
    const required = new Set(missing);
    if (required.has('title')) prompts.push('这个提案叫什么名字？给我一个简短的标题就行。');
    if (required.has('voteType')) {
      prompts.push('这属于哪一类提案？类型由运营配置决定，如果你不确定，我先说明可选的范围再一起选一个。');
    }
    if (required.has('requestedMinor+currency')) {
      prompts.push('大概需要多少经费、用什么货币？金额和币种请一起告诉我，方便我如实记录。');
    }
    if (advisory.includes('approximateWhen')) {
      prompts.push('大致打算什么时候办？先给我一个粗略时间就行，细节可以稍后再定。');
    }
    return prompts;
  };

  /**
   * Merge the fresh arguments over the carried draft. An explicit argument wins; a field the caller
   * sent as null or an empty string clears the carried value, so a correction is possible without a
   * new draft. Nothing is filled in that was not carried or given.
   */
  const merge = (given: unknown, carried: string | null): string | null => {
    if (given === undefined) return carried;
    if (given === null) return null;
    const text = String(given).trim();
    return text.length === 0 ? null : text;
  };

  return [
    {
      name: 'rein_proposal_collect',
      description:
        "Collect the fields of one proposal across several turns without writing anything. Pass the fields the proposer has already given; receive the collected public fields, the missingFields that still block a submit, the advisory gaps worth asking about, and a short nextPrompt to ask in the proposer's own language. The caller must be the trusted sender inside an approved proposal channel and their current record must make them an active Contributor; the proposer is never taken from an argument. Nothing is stored or submitted: even when every required field is present this tool does not submit, and the caller prepares and confirms the proposal separately through rein_governance_proposal_submit. An optional draftToken carries the collected fields in one sealed value so a later turn can continue from them; it is bound to the proposer and to the exact fields and expiry, cannot be re-dated or moved to another proposer, and is not a submit confirmation. A rough timing the proposer gave in their own words is carried as advice and must be confirmed inside the proposal summary before submit, because the stored request has no schedule field.",
      parameters: Type.Object(
        {
          title: Type.Optional(
            Type.String({ minLength: 1, maxLength: 200, description: 'Proposal title the proposer has given' }),
          ),
          summary: Type.Optional(
            Type.String({ maxLength: 4000, description: 'What the request covers, as the proposer described it' }),
          ),
          voteType: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 64,
              description: 'Configured proposal type, lower snake case, such as event_budget',
            }),
          ),
          requestedMinor: Type.Optional(
            Type.Integer({
              minimum: 0,
              description: 'Requested amount in integer minor units, carried together with its currency',
            }),
          ),
          currency: Type.Optional(
            Type.String({
              minLength: 3,
              maxLength: 3,
              description: 'ISO 4217 currency code of the requested amount',
            }),
          ),
          approximateWhen: Type.Optional(
            Type.String({
              maxLength: 120,
              description:
                "The proposer's own rough wording of when, carried as advice and never stored as a date",
            }),
          ),
          draftToken: Type.Optional(
            Type.String({
              minLength: 1,
              // The token is an AES-256-GCM ciphertext of the canonical draft document, so it is
              // larger than the text it carries. The cap is the measured worst case for the longest
              // legal draft, counting characters rather than bytes: one code point can be several
              // UTF-8 bytes. `proposal-draft.ts` refuses to mint a token longer than this.
              maxLength: MAX_COLLECT_TOKEN_LENGTH,
              description:
                'Token returned by an earlier collect call; echo it unchanged to resume the same draft',
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId: unknown, args: any) {
        try {
          assertNoImpersonationArgs(args);
          assertNoPolicyArgs(args);
          const member = await collectRequester();
          const at = instant();

          let carriedPayload: DraftPayload | null = null;
          let verificationIsCurrent = false;
          if (args?.draftToken !== undefined && args?.draftToken !== null) {
            const verification = verifyProposalDraft(args.draftToken, member.contactId, signingKey, new Date(at));
            if (!verification.ok) {
              const reason: DraftTokenFailure = verification.reason;
              throw new ProposalCollectToolError(
                reason,
                reason === 'draft_token_expired'
                  ? 'The draft token has expired; start the draft again and re-read the fields back.'
                  : reason === 'draft_token_mismatch'
                    ? 'The carried fields differ from the draft token; send the token unchanged with the same fields.'
                    : 'The draft token is missing or was not issued by this server.',
              );
            }
            carriedPayload = verification.payload;
            verificationIsCurrent = true;
          }

          const rawTitle = merge(args?.title, carriedPayload?.title ?? null);
          const rawSummary = merge(args?.summary, carriedPayload?.summary ?? null);
          const rawVoteType = merge(args?.voteType, carriedPayload?.voteType ?? null);
          const rawWhen = merge(args?.approximateWhen, carriedPayload?.approximateWhen ?? null);
          // A carried `proposalId` names a prepared-but-unsubmitted proposal whose exact version
          // already exists; a title the backend can answer for is reported, never invented.
          const carriedProposalId = !verificationIsCurrent
            ? null
            : draftProposalId(args?.draftToken, member.contactId, signingKey, new Date(at));
          const proposalId = carriedProposalId === null ? null : asProposalId(carriedProposalId);
          const hasFreshRequest = args?.requestedMinor !== undefined || args?.currency !== undefined;

          let request: { requestedMinor: number | null; currency: string | null };
          if (hasFreshRequest) {
            request = resolveRequest(args?.requestedMinor, args?.currency);
          } else {
            request = {
              requestedMinor: carriedPayload?.requestedMinor ?? null,
              currency: carriedPayload?.currency ?? null,
            };
          }

          // The type is checked against the operator's own table, exactly as the submit path does.
          // A carried type is already configured, so it needs no second read of the table.
          const carriedVoteType = carriedPayload?.voteType ?? null;
          const configuredVoteTypes =
            rawVoteType !== null && rawVoteType === carriedVoteType ? [] : await readConfiguredVoteTypes();
          const voteType = rawVoteType === null ? null : resolveVoteType(rawVoteType, configuredVoteTypes);

          const title = rawTitle === null ? null : resolveTitle(rawTitle);
          const summary = rawSummary === null ? null : resolveSummary(rawSummary);
          const approximateWhen = resolveApproximateWhen(rawWhen);

          const payload: DraftPayload = {
            proposerContactId: member.contactId,
            title,
            summary,
            voteType,
            requestedMinor: request.requestedMinor,
            currency: request.currency,
            approximateWhen,
          };

          let preparedTitle: string | null = null;
          if (proposalId !== null) {
            const read = await requireWriter().getProposal(proposalId);
            preparedTitle = read.ok && read.proposal ? read.proposal.title : null;
          }

          const missingFields = missingFieldsFor({
            title,
            voteType,
            requestedMinor: request.requestedMinor,
            currency: request.currency,
          });
          const advisoryMissingFields = advisoryMissingFieldsFor({ approximateWhen });

          const issued = issueProposalDraft(payload, proposalId, signingKey, new Date(at));
          if (!issued.ok) {
            throw new ProposalCollectToolError(
              issued.reason,
              `The collected fields are too long to seal into one draft token (${issued.documentBytes} bytes); shorten the summary and try again.`,
            );
          }

          assertCurrentInvocation(ctx);

          const summaryConfirmationRequired =
            approximateWhen === null
              ? null
              : 'The rough timing the proposer gave is not a stored field: put it into the proposal summary and confirm that wording with the proposer before submit, because the stored request has no schedule column.';

          const details = {
            tool: 'rein_proposal_collect',
            ok: true,
            status: 'collecting' as const,
            collected: draftPreview(payload),
            missingFields,
            advisoryMissingFields,
            readyForSubmit: missingFields.length === 0,
            nextPrompt: promptsFor(missingFields, advisoryMissingFields),
            // A carried rough timing is advice, not a stored field; state plainly that it must be
            // confirmed inside the summary before submit, and never turn it into a date here.
            summaryConfirmationRequired,
            // The identifier of a carried prepared proposal, or null; a fresh collect creates none.
            proposalId,
            preparedTitle,
            // Never true here: collecting fields is not submitting, and every required field being
            // present still leaves the two-turn prepare/confirm submit to the caller.
            submitted: false,
            recorded: false,
            draftToken: issued.token,
            draftTokenExpiresAt: issued.expiresAt,
            note: 'These fields are held in the draft token only. Nothing is stored or submitted yet, and a proposal is submitted separately once every required field is present and the proposer confirms the prepared version.',
            // Collecting fields neither approves nor spends anything.
            authorizesSpending: false as const,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
        } catch (error) {
          return errorResult('rein_proposal_collect', error);
        }
      },
    },
  ];
}

/**
 * Build the v2 tool factory for the proposal collection tool. Register it as
 * `api.registerTool(createProposalCollectToolRegistration({ config }), { names: GOVERNANCE_COLLECT_TOOL_NAMES })`.
 * When the foundationDb block is absent or disabled, `create` returns null and no tool is registered.
 */
export function createProposalCollectToolRegistration(options?: ProposalCollectToolsOptions) {
  const config = resolveProposalCollectConfig(options);
  return {
    contextVersion: 2 as const,
    create(ctx: any) {
      if (!config) return null;
      return buildTools(config, ctx);
    },
  };
}
