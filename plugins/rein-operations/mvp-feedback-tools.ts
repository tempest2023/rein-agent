// MVP feedback tools: post-result comments and suggested revisions, the Board approval of a
// material revision, and the one guarded step that makes a revision the effective version.
//
// Scope: PRD C15 with decision D10: after a result, feedback may still change a proposal that
// passed, and a change to budget, location, personnel or the major event flow needs at least one
// current Board member's approval before the changed version takes effect. In this slice the voters
// are the Board, so the feedback call is a Board call: the sender must be a current director inside
// the approved Board channel, and no configured proposal channel or Contributor record is accepted
// as feedback authority. The database holds the effective-version rule: the
// `rein_mvp_approve_revision` RPC records one approval from a current director, and the trigger on
// the proposal row refuses an unapproved material revision by name (`revision_not_approved`).
//
// The two sides of the rule are deliberately asymmetric. A material revision has a hard gate: one
// current director's recorded approval before it can take effect. An ordinary revision - one that
// only moves the title or the summary - has no second approval step at all: `rein_mvp_revision_apply`
// is the Agent accepting a reasonable ordinary suggestion in the caller's turn, and no separate
// approval RPC exists for it. That call still requires a current director inside the Board channel,
// because the voters who may leave post-result feedback are the Board, and the Agent acts in their
// turn rather than on an unattributed request.
//
// This module registers only under the explicit `mvp` config block, exactly like `mvp-read-tools.ts`
// and `mvp-write-tools.ts`, and every wired path reaches only the writer methods
// `foundation-db-writer.ts` exposes.
//
// Trust boundary, matching the other MVP slices:
// - The acting account comes only from `ctx.requesterSenderId`, the approved channel only from
//   `ctx.nativeChannelId`. No tool argument is ever read as an actor, an author or a role, and the
//   known impersonation and policy arguments are refused before any database call.
// - `assertCurrentInvocation` is re-checked immediately before every write and before any answer
//   leaves the turn, so a cancelled or stale turn cannot commit or report.
// - Every refusal collapses to a fixed reason code. A Supabase URL, the Slack team id, a credential
//   and the private contact id resolved from the identity link never reach a result, a status or an
//   error message.
//
// Nothing here posts a message, moves, reserves or records money, or changes an identity or a vote
// weight: a comment is text, a revision is one append-only row, an approval is a director's own
// approval against the database, and applying a revision only rewrites the proposal's own fields.

import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { createFoundationDbReader } from './foundation-db-reader.ts';
import { createFoundationDbWriter } from './foundation-db-writer.ts';
import { assertCurrentInvocation } from './request-context.ts';
import type {
  FoundationDbWriter,
  ProposalRecord,
  ProposalRevisionRecord,
} from './foundation-db-writer.ts';
import type { SlackMemberResolution } from './foundation-db-reader.ts';

/** Names the caller must declare in the manifest and pass to `registerTool(..., { names })`. */
export const MVP_FEEDBACK_TOOL_NAMES = Object.freeze([
  'rein_mvp_proposal_comment_suggest',
  'rein_mvp_revision_approve',
  'rein_mvp_revision_apply',
]);

export class MvpFeedbackToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MvpFeedbackToolError';
    this.code = code;
  }
}

/** The one reader method this slice uses: resolve a trusted Slack sender to a community record. */
export interface MvpFeedbackToolReader {
  resolveSlackMember(slackUserId: string): Promise<SlackMemberResolution>;
}

export type MvpFeedbackToolWriter = Pick<
  FoundationDbWriter,
  | 'getProposal'
  | 'getRevision'
  | 'recordProposalRevision'
  | 'approveProposalRevision'
  | 'applyProposalRevision'
>;

export interface MvpFeedbackToolsOptions {
  /**
   * The `mvp` block of plugin config, read as untrusted input. The keys are the ones
   * `mvp-read-tools.ts` and `mvp-write-tools.ts` already validate, so one block configures all
   * three slices. Absent or `enabled: false` registers no tools.
   */
  config?: Record<string, unknown>;
  /** Server environment holding the referenced values. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injectable reader for tests and local rehearsal; skips the env-var lookups. */
  reader?: MvpFeedbackToolReader;
  /** Injectable writer for tests and local rehearsal; skips the env-var lookups. */
  writer?: MvpFeedbackToolWriter;
}

interface ResolvedMvpFeedbackConfig {
  platform: 'slack';
  boardChannelIds: string[];
  reader: MvpFeedbackToolReader;
  writer: MvpFeedbackToolWriter;
}

const SLACK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** `title` and `summary` are the ordinary revision; the rest of the list is the material gate. */
const MINOR_FIELDS = Object.freeze(['title', 'summary'] as const);
/**
 * The fields the database treats as material: their revision takes effect only with a recorded
 * approval from a current director. `schedule` covers a date or time commitment, `personnel` a
 * change of the people involved and `event_flow` a change to the agreed run of the event.
 */
const MATERIAL_FIELDS = Object.freeze([
  'budget',
  'location',
  'schedule',
  'personnel',
  'event_flow',
] as const);
/** Every field name a revision row may carry, six plus one, in the order the sibling writer accepts. */
const REVISION_FIELDS = Object.freeze([...MINOR_FIELDS, ...MATERIAL_FIELDS] as const);

const MAX_TITLE_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 4000;
const MAX_REVISION_TEXT = 4000;
const MAX_NOTE_LENGTH = 2000;

// Host-supplied identity or role keys a model must never be able to set. An author, a role or an
// approval flag arriving as an argument would let a prompt write its own authority, which R02
// refuses outright.
const IMPERSONATION_KEYS = Object.freeze([
  'account',
  'accountId',
  'actor',
  'approverContactId',
  'author',
  'authorContactId',
  'commenterContactId',
  'contactId',
  'creatorContactId',
  'isActiveContributor',
  'isDirector',
  'member',
  'memberId',
  'participant',
  'platform',
  'requesterSenderId',
  'revisionAuthorContactId',
  'role',
  'senderId',
  'senderIsOwner',
  'voterContactId',
  'weight',
  'weights',
]);

// Governance parameters a model must never supply. The effective version is assigned by the
// database, and the material gate is decided by the recorded field names together with the recorded
// approval, so an argument that pre-approves a revision, labels itself ordinary or names a version
// would let a prompt write its own rule.
const POLICY_KEYS = Object.freeze([
  'approvalRequired',
  'approved',
  'approvedBy',
  'approvedFields',
  'classification',
  'effectiveVersion',
  'isMaterial',
  'material',
  'minor',
  'skipApproval',
  'version',
]);

/**
 * How an ordinary revision becomes effective, reported on every result so a caller never has to infer
 * which rule applied. The Agent accepts a reasonable ordinary suggestion in the caller's turn, so an
 * ordinary revision needs no approval RPC; a material revision still needs one recorded director
 * approval before anything can apply it.
 */
const ORDINARY_REVISION_APPLICATION_DECISION = 'agent_accepts_ordinary' as const;
/**
 * The mirror of the same rule on the material side: a material revision cannot take effect until a
 * current director's approval is recorded.
 */
const MATERIAL_REVISION_APPROVAL_GATE = 'director_approval_required' as const;

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

const asUuid = (value: unknown): string | null =>
  typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;

function configError(message: string): never {
  throw new MvpFeedbackToolError('mvp_config_invalid', `mvp feedback tools: ${message}`);
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
    throw new MvpFeedbackToolError(
      'mvp_env_value_missing',
      `mvp feedback tools: server environment variable ${name} referenced by mvp.${field} is unset or empty`,
    );
  }
  return value.trim();
}

/**
 * Validate the operator configuration exactly as the two sibling slices do, so one block enables all
 * three. Returns null when the MVP block is absent or disabled; throws on an enabled-but-incomplete
 * block so a misconfiguration fails loudly.
 */
function resolveMvpFeedbackConfig(options?: MvpFeedbackToolsOptions): ResolvedMvpFeedbackConfig | null {
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
  // The proposal channel is validated because one block configures every MVP slice, but it is not
  // the feedback scope: C15 feedback comes from the voters, who act in the Board channel.
  readChannelIds('proposalChannelIds', config.proposalChannelIds);
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

  let reader: MvpFeedbackToolReader | undefined = options?.reader;
  let writer: MvpFeedbackToolWriter | undefined = options?.writer;
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
    typeof writer.getProposal !== 'function' ||
    typeof writer.getRevision !== 'function' ||
    typeof writer.recordProposalRevision !== 'function' ||
    typeof writer.approveProposalRevision !== 'function' ||
    typeof writer.applyProposalRevision !== 'function'
  ) {
    configError(
      'the injected writer must implement getProposal, getRevision, recordProposalRevision, approveProposalRevision and applyProposalRevision',
    );
  }

  // Neither scope is a new operator field: a comment, a suggested revision, an approval and an
  // apply are all Board calls, so the approved Board channel is the one channel this slice reads.
  return {
    platform: 'slack',
    boardChannelIds,
    reader,
    writer,
  };
}

function assertNoImpersonationArgs(args: unknown) {
  if (!args || typeof args !== 'object') return;
  for (const key of IMPERSONATION_KEYS) {
    if (Object.hasOwn(args, key)) {
      throw new MvpFeedbackToolError(
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
      throw new MvpFeedbackToolError(
        'policy_argument_rejected',
        `The "${key}" argument is not accepted; the recorded fields and the database decide the gate.`,
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

function buildTools(config: ResolvedMvpFeedbackConfig, ctx: any) {
  const { boardChannelIds, reader, writer } = config;

  const nativeChannelId = typeof ctx?.nativeChannelId === 'string' ? ctx.nativeChannelId.trim() : '';
  const senderId = typeof ctx?.requesterSenderId === 'string' ? ctx.requesterSenderId.trim() : '';

  // Resolve the trusted sender, or refuse before any database call. The acting account is never
  // taken from arguments.
  const requester = (audience: string, scoped: string[]) => {
    if (ctx?.messageChannel !== 'slack') {
      throw new MvpFeedbackToolError('platform_out_of_scope', 'These tools act on Slack host context only.');
    }
    if (!senderId) {
      throw new MvpFeedbackToolError('trusted_requester_unavailable', 'The host did not supply a sender ID.');
    }
    if (!nativeChannelId || !scoped.includes(nativeChannelId)) {
      throw new MvpFeedbackToolError(
        'channel_out_of_scope',
        `This tool is limited to its approved ${audience} channel.`,
      );
    }
    return reader.resolveSlackMember(senderId);
  };

  const linkRequired = (audience: string) =>
    new MvpFeedbackToolError(
      'identity_link_required',
      `This ${audience} tool requires a verified link between your Slack account and a community record.`,
    );

  /**
   * Feedback is a Board call: the voters are the directors, so the author of a comment or a
   * suggested revision must be a linked record that is currently a director, inside the approved
   * Board channel. A Contributor record grants nothing here, and no separate feedback audience is
   * accepted from a caller.
   */
  const boardRequester = async (): Promise<SlackMemberResolution & { contactId: string }> => {
    const member = await requester('Board', boardChannelIds);
    if (member.status !== 'resolved' || !member.contactId) throw linkRequired('Board');
    if (member.isDirector !== true) {
      throw new MvpFeedbackToolError(
        'board_membership_required',
        'Feedback on a proposal is limited to current directors, who are the voters.',
      );
    }
    return { ...member, contactId: member.contactId };
  };

  /** One known field name per entry, in order, without repeats. */
  const resolveChangedFields = (value: unknown): string[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      throw new MvpFeedbackToolError(
        'changed_fields_invalid',
        `changedFields must be an array of field names from ${REVISION_FIELDS.join(', ')}.`,
      );
    }
    if (value.length > REVISION_FIELDS.length) {
      throw new MvpFeedbackToolError(
        'changed_fields_invalid',
        `changedFields accepts at most ${REVISION_FIELDS.length} entries.`,
      );
    }
    const fields: string[] = [];
    for (const entry of value as unknown[]) {
      if (typeof entry !== 'string' || !REVISION_FIELDS.includes(entry as (typeof REVISION_FIELDS)[number])) {
        throw new MvpFeedbackToolError(
          'changed_fields_invalid',
          `Every changed field must be one of ${REVISION_FIELDS.join(', ')}.`,
        );
      }
      if (fields.includes(entry)) {
        throw new MvpFeedbackToolError(
          'changed_fields_invalid',
          'Every changed field must be named once, without repeats.',
        );
      }
      fields.push(entry);
    }
    return fields;
  };

  /**
   * A named field carries its new value and an unnamed field carries nothing, so a caller cannot
   * smuggle an unnamed change past the trigger. Absent, null and empty all mean "this revision does
   * not move that field", which is what makes a one-field suggestion explicit.
   */
  const resolveFieldText = (
    args: any,
    field: string,
    key: string,
    maxLength: number,
    named: boolean,
  ): string | null => {
    const raw = args?.[key];
    const present = raw !== undefined && raw !== null && !(typeof raw === 'string' && raw.trim() === '');
    if (!present) {
      if (named) {
        throw new MvpFeedbackToolError(
          'revision_field_value_required',
          `changedFields names "${field}", so ${key} must carry its new value.`,
        );
      }
      return null;
    }
    if (typeof raw !== 'string' || raw.length > maxLength) {
      throw new MvpFeedbackToolError(
        'revision_field_value_invalid',
        `${key} must be text of at most ${maxLength} characters.`,
      );
    }
    if (!named) {
      throw new MvpFeedbackToolError(
        'revision_field_value_unexpected',
        `A value for "${field}" is only accepted when changedFields names "${field}".`,
      );
    }
    return raw.trim();
  };

  /**
   * The budget is an amount together with its currency, written together or not at all. `schedule`
   * and `eventFlow` are stored as the free text the trigger accepts, because the phase-2 proposal row
   * has no separate date or agenda column.
   */
  const resolveRevisionValues = (args: any, named: Set<string>) => {
    const amountRaw = args?.requestedMinor;
    const currencyRaw = args?.currency;
    const budgetSupplied =
      (amountRaw !== undefined && amountRaw !== null) || (currencyRaw !== undefined && currencyRaw !== null);
    let requestedMinor: number | null = null;
    let currency: string | null = null;
    if (named.has('budget')) {
      if (typeof amountRaw !== 'number' || !Number.isInteger(amountRaw) || amountRaw < 0) {
        throw new MvpFeedbackToolError(
          'revision_budget_invalid',
          'A budget revision records requestedMinor as a whole number of minor units, zero or more.',
        );
      }
      const code = typeof currencyRaw === 'string' ? currencyRaw.trim().toUpperCase() : '';
      if (!CURRENCY_PATTERN.test(code)) {
        throw new MvpFeedbackToolError(
          'revision_budget_invalid',
          'A budget revision records its amount together with one ISO 4217 code such as USD.',
        );
      }
      requestedMinor = amountRaw;
      currency = code;
    } else if (budgetSupplied) {
      throw new MvpFeedbackToolError(
        'revision_budget_unexpected',
        'requestedMinor and currency are only accepted when changedFields names "budget".',
      );
    }
    return {
      title: resolveFieldText(args, 'title', 'title', MAX_TITLE_LENGTH, named.has('title')),
      summary: resolveFieldText(args, 'summary', 'summary', MAX_SUMMARY_LENGTH, named.has('summary')),
      requestedMinor,
      currency,
      location: resolveFieldText(args, 'location', 'location', MAX_REVISION_TEXT, named.has('location')),
      schedule: resolveFieldText(args, 'schedule', 'schedule', MAX_REVISION_TEXT, named.has('schedule')),
      personnel: resolveFieldText(args, 'personnel', 'personnel', MAX_REVISION_TEXT, named.has('personnel')),
      eventFlow: resolveFieldText(args, 'event_flow', 'eventFlow', MAX_REVISION_TEXT, named.has('event_flow')),
      note: resolveFieldText(args, 'note', 'note', MAX_NOTE_LENGTH, true),
    };
  };

  /**
   * One record identifier per fresh turn and per tool call, exactly as the sibling write slice mints
   * its proposal and poll ids. The host may retry the same invocation inside one `create(ctx)`, and
   * such a retry has to meet the row it already wrote, so the identifier is remembered by the tool
   * call id. A later turn starts from an empty map.
   */
  const mintedIds = new Map<string, string>();
  const recordId = (toolCallId: unknown): string => {
    if (typeof toolCallId !== 'string' || !toolCallId.trim()) {
      throw new MvpFeedbackToolError(
        'tool_call_id_required',
        'The host must supply the tool call id; it is what makes a retry the same record.',
      );
    }
    const key = `revision:${toolCallId.trim()}`;
    const known = mintedIds.get(key);
    if (known) return known;
    const minted = randomUUID();
    mintedIds.set(key, minted);
    return minted;
  };

  /**
   * Read one stored proposal. An unavailable provider is never reported as a missing proposal, so a
   * caller cannot mistake an outage for a record that was never written.
   */
  const readProposal = async (proposalId: string): Promise<ProposalRecord> => {
    const result = await writer.getProposal(proposalId);
    if (!result.ok || !result.proposal) {
      if (result.reason === 'proposal_not_found') {
        throw new MvpFeedbackToolError('proposal_not_found', 'No stored proposal has that identifier.');
      }
      throw new MvpFeedbackToolError('proposal_lookup_unavailable', 'The stored proposal could not be read.');
    }
    return result.proposal;
  };

  /** Read one recorded revision, with the same refusal shapes as the proposal read. */
  const readRevision = async (revisionId: string): Promise<ProposalRevisionRecord> => {
    const result = await writer.getRevision(revisionId);
    if (!result.ok || !result.revision) {
      if (result.reason === 'revision_not_found') {
        throw new MvpFeedbackToolError('revision_not_found', 'No recorded revision has that identifier.');
      }
      throw new MvpFeedbackToolError('revision_lookup_unavailable', 'The recorded revision could not be read.');
    }
    return result.revision;
  };

  /**
   * Read a revision together with the proposal it belongs to. Feedback exists only on a proposal
   * that passed, so a revision against anything else is refused by name before a write. The database
   * keeps the same invariant; this read only avoids a pointless write and names the real state.
   */
  const readFeedbackTarget = async (
    revisionId: string,
  ): Promise<{ revision: ProposalRevisionRecord; proposal: ProposalRecord }> => {
    const revision = await readRevision(revisionId);
    const proposal = await readProposal(revision.proposalId);
    if (proposal.status !== 'selected') {
      throw new MvpFeedbackToolError(
        'proposal_not_selected',
        'Feedback applies to a proposal that passed; this proposal is not in its effective accepted state.',
      );
    }
    return { revision, proposal };
  };

  /**
   * The material fields a revision names, in the stored order. The database refuses the same set until
   * a current director's approval is recorded, so this only names the gate for the caller.
   */
  const materialFields = (fields: readonly string[]): string[] =>
    fields.filter(field => MATERIAL_FIELDS.includes(field as (typeof MATERIAL_FIELDS)[number]));

  return [
    {
      name: 'rein_mvp_proposal_comment_suggest',
      description:
        'Record one comment or one suggested revision on a proposal that passed, after its result. Feedback is limited to the approved Board channel and to senders whose current community record is a director, which is who voted; the author is your own linked record and never an argument. Name the fields the suggestion would move in changedFields and give exactly their new values; an empty changedFields with a note is a comment. A suggested title or summary change is an ordinary revision: the Agent may accept a reasonable one and make it effective on its own, with no further approval, by calling rein_mvp_revision_apply. A suggested budget, location, schedule, personnel or major event-flow change is material, and it cannot take effect until a current director records an approval through rein_mvp_revision_approve; the result names that gate in approvalRequired and in approvalGate. Recording a suggestion applies nothing by itself. A retry of the same tool call in this turn is the same record.',
      parameters: Type.Object(
        {
          proposalId: Type.String({ minLength: 1, maxLength: 64, description: 'Stored proposal identifier' }),
          changedFields: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 32 }), {
              maxItems: REVISION_FIELDS.length,
              description: `Fields this revision would move, from ${REVISION_FIELDS.join(', ')}; empty means a comment`,
            }),
          ),
          title: Type.Optional(
            Type.String({ maxLength: 200, description: 'New title when changedFields names "title"' }),
          ),
          summary: Type.Optional(
            Type.String({ maxLength: 4000, description: 'New summary when changedFields names "summary"' }),
          ),
          requestedMinor: Type.Optional(
            Type.Integer({ minimum: 0, description: 'New requested amount when changedFields names "budget"' }),
          ),
          currency: Type.Optional(
            Type.String({ minLength: 3, maxLength: 3, description: 'Currency code of the new amount' }),
          ),
          location: Type.Optional(
            Type.String({ maxLength: 4000, description: 'New location when changedFields names "location"' }),
          ),
          schedule: Type.Optional(
            Type.String({
              maxLength: 4000,
              description: 'New date or time commitment when changedFields names "schedule"',
            }),
          ),
          personnel: Type.Optional(
            Type.String({
              maxLength: 4000,
              description: 'Changed people involved when changedFields names "personnel"',
            }),
          ),
          eventFlow: Type.Optional(
            Type.String({
              maxLength: 4000,
              description: 'Changed run of the event when changedFields names "event_flow"',
            }),
          ),
          note: Type.String({
            minLength: 1,
            maxLength: 2000,
            description: 'Your comment text, and the reason for a suggested revision',
          }),
        },
        { additionalProperties: false },
      ),
      async execute(toolCallId: unknown, args: any) {
        try {
          assertNoImpersonationArgs(args);
          assertNoPolicyArgs(args);
          const proposalId = asUuid(args?.proposalId);
          if (proposalId === null) {
            throw new MvpFeedbackToolError(
              'proposal_id_invalid',
              'proposalId must be one stored proposal identifier.',
            );
          }
          const changedFields = resolveChangedFields(args?.changedFields);
          const named = new Set(changedFields);
          const values = resolveRevisionValues(args, named);
          const member = await boardRequester();
          // Feedback follows a result, so the named proposal must be a stored, currently selected
          // one: this is the only proposal a comment or suggestion may name, and the database holds
          // the same invariant plus the foreign key.
          const proposal = await readProposal(proposalId);
          if (proposal.status !== 'selected') {
            throw new MvpFeedbackToolError(
              'proposal_not_selected',
              'Feedback applies to a proposal that passed; this proposal is not in its effective accepted state.',
            );
          }
          const id = recordId(toolCallId);
          // Final authority check immediately before the write: a stale turn cannot commit.
          assertCurrentInvocation(ctx);
          const written = await writer.recordProposalRevision({
            id,
            proposalId,
            authorContactId: member.contactId,
            changedFields,
            ...(named.has('title') ? { title: values.title } : {}),
            ...(named.has('summary') ? { summary: values.summary } : {}),
            ...(named.has('budget')
              ? { requestedMinor: values.requestedMinor, currency: values.currency }
              : {}),
            ...(named.has('location') ? { location: values.location } : {}),
            ...(named.has('schedule') ? { schedule: values.schedule } : {}),
            ...(named.has('personnel') ? { personnel: values.personnel } : {}),
            ...(named.has('event_flow') ? { eventFlow: values.eventFlow } : {}),
            note: values.note,
          });
          const material = materialFields(changedFields);
          const details = {
            tool: 'rein_mvp_proposal_comment_suggest',
            ok: written.ok,
            status: written.status,
            reason: written.reason,
            ...(written.ok ? {} : { error: written.reason }),
            revisionId: id,
            proposalId,
            kind: changedFields.length === 0 ? ('comment' as const) : ('suggestion' as const),
            changedFields,
            materialFields: material,
            // The gate named for the caller: a named material field needs a recorded current-director
            // approval before any apply can take effect. A comment and an ordinary revision do not.
            approvalRequired: material.length > 0,
            recorded: written.ok,
            applied: false,
            // An ordinary revision needs no approval and a material one does; both rules are named
            // so a caller never has to infer which one the stored fields fall under.
            ordinaryRevisionApplicationDecision: ORDINARY_REVISION_APPLICATION_DECISION,
            approvalGate: material.length > 0 ? MATERIAL_REVISION_APPROVAL_GATE : null,
            // A revision moves no money: a budget suggestion is a request, never an authorization.
            authorizesSpending: false as const,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
        } catch (error) {
          return errorResult('rein_mvp_proposal_comment_suggest', error);
        }
      },
    },
    {
      name: 'rein_mvp_revision_approve',
      description:
        'Record your one approval of a recorded suggested revision on a proposal that passed, limited to the approved Board channel and to senders whose current community record is a director. This is the hard gate on a material revision: one that moves budget, location, schedule, personnel or the major event flow cannot take effect until at least one current director has recorded this approval. An ordinary revision that only moves the title or the summary has no such gate and does not need this call, because the Agent may accept a reasonable ordinary suggestion on its own. The approver is your own current director record, never an argument; an approval already recorded by another director is reported, never replaced, and the database re-checks that the approver is a current director. An approval moves no money and posts no message.',
      parameters: Type.Object(
        { revisionId: Type.String({ minLength: 1, maxLength: 64, description: 'Stored revision identifier' }) },
        { additionalProperties: false },
      ),
      async execute(_toolCallId: unknown, args: any) {
        try {
          assertNoImpersonationArgs(args);
          assertNoPolicyArgs(args);
          const revisionId = asUuid(args?.revisionId);
          if (revisionId === null) {
            throw new MvpFeedbackToolError(
              'revision_id_invalid',
              'revisionId must be one recorded revision identifier.',
            );
          }
          const member = await boardRequester();
          // Read first, so a comment, a revision on a proposal that did not pass, an applied
          // revision or an unknown one is refused by name instead of through a provider error.
          const { revision } = await readFeedbackTarget(revisionId);
          if (revision.changedFields.length === 0) {
            throw new MvpFeedbackToolError(
              'revision_is_comment',
              'This record is a comment, so it carries nothing to approve.',
            );
          }
          if (revision.version !== null) {
            throw new MvpFeedbackToolError(
              'revision_already_applied',
              'This revision is already the effective version, so no further approval is recorded.',
            );
          }
          // Final authority check immediately before the write: a stale turn cannot approve.
          assertCurrentInvocation(ctx);
          const written = await writer.approveProposalRevision({
            revisionId,
            approverContactId: member.contactId,
          });
          if (!written.ok || !written.revision) {
            throw new MvpFeedbackToolError(
              written.reason || 'revision_approval_failed',
              'The approval could not be recorded.',
            );
          }
          const stored = written.revision;
          const material = materialFields(stored.changedFields);
          const details = {
            tool: 'rein_mvp_revision_approve',
            ok: true,
            status: written.status,
            reason: written.reason,
            revisionId,
            proposalId: stored.proposalId,
            changedFields: [...stored.changedFields],
            materialFields: material,
            approvalRequired: material.length > 0,
            approved: stored.approvedByContactId !== null,
            approvedAt: stored.approvedAt,
            ordinaryRevisionApplicationDecision: ORDINARY_REVISION_APPLICATION_DECISION,
            approvalGate: material.length > 0 ? MATERIAL_REVISION_APPROVAL_GATE : null,
            // A repeat by the same director answers with the recorded approval, never a second one.
            repeated: written.status === 'existing',
            recorded: true,
            applied: stored.version !== null,
            authorizesSpending: false as const,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
        } catch (error) {
          return errorResult('rein_mvp_revision_approve', error);
        }
      },
    },
    {
      name: 'rein_mvp_revision_apply',
      description:
        'Make one recorded suggested revision the effective version of a proposal that passed. This call is the Agent accepting a reasonable ordinary suggestion in the caller\'s turn: a revision that only moves the title or the summary becomes effective here, and no separate Board approval is required for it. A material revision that moves budget, location, schedule, personnel or the major event flow is a different path: it is refused with the approval gate until a current director has recorded an approval through rein_mvp_revision_approve, and the database decides which fields are material and which recorded approval counts. Limited to the approved Board channel and to senders whose current community record is a director, because the voters who may leave post-result feedback are the Board. A comment is never applied, a revision that is already effective is reported instead of applied twice, and the database assigns the new version. Applying a revision moves no money.',
      parameters: Type.Object(
        { revisionId: Type.String({ minLength: 1, maxLength: 64, description: 'Stored revision identifier' }) },
        { additionalProperties: false },
      ),
      async execute(_toolCallId: unknown, args: any) {
        try {
          assertNoImpersonationArgs(args);
          assertNoPolicyArgs(args);
          const revisionId = asUuid(args?.revisionId);
          if (revisionId === null) {
            throw new MvpFeedbackToolError(
              'revision_id_invalid',
              'revisionId must be one recorded revision identifier.',
            );
          }
          const member = await boardRequester();
          const { revision } = await readFeedbackTarget(revisionId);
          // The gate is named before the write. Only the database decides the effective-version rules,
          // so this refusal reproduces the two stored states it refuses by name instead of deciding
          // them here.
          if (revision.changedFields.length === 0) {
            throw new MvpFeedbackToolError(
              'revision_is_comment',
              'This record is a comment, so it carries nothing to make effective.',
            );
          }
          if (revision.version !== null) {
            throw new MvpFeedbackToolError(
              'revision_already_applied',
              'This revision is already the effective version, so there is nothing to apply.',
            );
          }
          const material = materialFields(revision.changedFields);
          if (material.length > 0 && revision.approvedByContactId === null) {
            const details = {
              tool: 'rein_mvp_revision_apply',
              ok: false as const,
              status: 'refused' as const,
              error: 'revision_not_approved',
              reason: 'revision_not_approved',
              revisionId,
              proposalId: revision.proposalId,
              changedFields: [...revision.changedFields],
              materialFields: material,
              applied: false,
              approvalRequired: true,
              approvalRecorded: false,
              ordinaryRevisionApplicationDecision: ORDINARY_REVISION_APPLICATION_DECISION,
              approvalGate: MATERIAL_REVISION_APPROVAL_GATE,
              message:
                'This revision moves a material field, so it cannot become effective until a current director records an approval for it.',
              authorizesSpending: false as const,
            };
            return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
          }
          // Final authority check immediately before the write: a stale turn cannot apply.
          assertCurrentInvocation(ctx);
          const written = await writer.applyProposalRevision({ revisionId });
          if (!written.ok || !written.version) {
            throw new MvpFeedbackToolError(
              written.reason || 'revision_apply_failed',
              'The revision could not be applied.',
            );
          }
          const applied = written.version;
          const details = {
            tool: 'rein_mvp_revision_apply',
            ok: true,
            status: written.status,
            reason: written.reason,
            revisionId,
            proposalId: applied.proposalId,
            proposalStatus: applied.status,
            changedFields: [...revision.changedFields],
            materialFields: material,
            // The version, the effective revision and the stored field values are the database's, not
            // a caller's and not this module's.
            version: applied.version,
            effectiveRevisionId: applied.effectiveRevisionId,
            approved: revision.approvedByContactId !== null,
            approvalRequired: material.length > 0,
            // This call is the Agent accepting the suggestion in the caller's turn: an ordinary
            // revision becomes effective here with no further approval, while a material one only
            // reaches this point once a director's approval is recorded.
            acceptedBy: material.length > 0 ? ('director_approved' as const) : ('agent' as const),
            ordinaryRevisionApplicationDecision: ORDINARY_REVISION_APPLICATION_DECISION,
            approvalGate: material.length > 0 ? MATERIAL_REVISION_APPROVAL_GATE : null,
            applied: true as const,
            appliedFields: {
              title: applied.title,
              summary: applied.summary,
              requestedMinor: applied.requestedMinor,
              currency: applied.currency,
              location: applied.location,
              schedule: applied.schedule,
              personnel: applied.personnel,
              eventFlow: applied.eventFlow,
            },
            authorizesSpending: false as const,
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
        } catch (error) {
          return errorResult('rein_mvp_revision_apply', error);
        }
      },
    },
  ];
}

/**
 * Build the v2 tool factory for the MVP feedback tools. Register it as
 * `api.registerTool(createMvpFeedbackToolRegistration({ config }), { names: MVP_FEEDBACK_TOOL_NAMES })`.
 * When the MVP block is absent or disabled, `create` returns null and no tool is registered.
 */
export function createMvpFeedbackToolRegistration(options?: MvpFeedbackToolsOptions) {
  const config = resolveMvpFeedbackConfig(options);
  return {
    contextVersion: 2 as const,
    create(ctx: any) {
      if (!config) return null;
      return buildTools(config, ctx);
    },
  };
}
