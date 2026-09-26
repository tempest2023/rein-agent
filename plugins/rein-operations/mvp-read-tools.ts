// MVP read-only Slack tools: a member's own identity status and the latest human-entered
// available-funds snapshot.
//
// Scope: PRD R02 (a chat account acts only after an explicit link to a community record, and a
// display name never establishes identity), R21 (a finance figure the Agent may only read), D05 (a
// funding approval is a decision record, not money movement) and D06 (only members with active
// Contributor status propose or lead; only eligible Board members vote). Both tools answer from the
// authoritative database through `foundation-db-reader.ts`. Neither writes, reserves, approves or
// spends, and neither invents a figure that the reader reported as unknown.
//
// Single-workspace installation requirement: OpenClaw's version-2 tool context carries the chat
// platform, the native channel id and the trusted sender id, but no Slack team id. The team is
// therefore fixed operator configuration, and one installation must serve exactly one Slack
// workspace/team. Pointing one installation at several workspaces would resolve senders against the
// wrong community records, so the tools register only when the operator names that one team.
//
// Trust boundary:
// - The acting Slack user id comes only from `ctx.requesterSenderId`. No tool argument is read as an
//   actor, known impersonation arguments are rejected, and the caller must be inside an approved
//   native channel before any database read happens.
// - `assertInvocationCurrent` is rechecked before any answer is returned, so a cancelled or stale
//   turn cannot read fresh member or funds data.
// - A refused caller and a failed lookup both collapse to a fixed reason code. Provider text, the
//   Supabase URL, the Slack team id and the service key never reach a result, status or error.
//
// Confidentiality: the private `community_contacts` identifier resolved from the identity link is
// deliberately dropped from every answer. Callers learn only whether the sender is linked, whether
// that record is an active Contributor and whether it is a director.

import { Type } from 'typebox';
import { createFoundationDbReader } from './foundation-db-reader.ts';
import type { AvailableFunds, FoundationEnvironment, SlackMemberResolution } from './foundation-db-reader.ts';
import { assertCurrentInvocation } from './request-context.ts';

/** Names the caller must declare in the manifest and pass to `registerTool(..., { names })`. */
export const MVP_READ_TOOL_NAMES = Object.freeze(['rein_mvp_my_status', 'rein_mvp_funds']);

export class MvpReadToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MvpReadToolError';
    this.code = code;
  }
}

/** The two read-only methods these tools use, so a fake reader can stand in for the real one. */
export interface MvpReadToolReader {
  resolveSlackMember(slackUserId: string): Promise<SlackMemberResolution>;
  readAvailableFunds(currency: string): Promise<AvailableFunds>;
}

export interface MvpReadToolsOptions {
  /**
   * The `mvp` block of plugin config, read as untrusted input. Expected keys: `enabled`,
   * `platform` (`slack`), `slackTeamId`, `environment` (`dev` or `prod`), `proposalChannelIds`,
   * `boardChannelIds`, `supabaseUrlEnvVar` and `supabaseServiceKeyEnvVar`. The last two name server
   * environment variables; no credential is ever read from config. Absent or `enabled: false`
   * registers no tools.
   */
  config?: Record<string, unknown>;
  /** Server environment holding the referenced values. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injectable reader for tests and local rehearsal; skips the env-var lookups. */
  reader?: MvpReadToolReader;
}

interface ResolvedMvpReadConfig {
  platform: 'slack';
  proposalChannelIds: string[];
  boardChannelIds: string[];
  reader: MvpReadToolReader;
}

const SLACK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Host-supplied identity keys a model must never be able to set.
const IMPERSONATION_KEYS = Object.freeze([
  'actor',
  'account',
  'accountId',
  'member',
  'memberId',
  'ownerAccount',
  'platform',
  'senderId',
  'requesterSenderId',
  'claimedActor',
  'senderIsOwner',
]);

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

function configError(message: string): never {
  throw new MvpReadToolError('mvp_config_invalid', `mvp read tools: ${message}`);
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
    throw new MvpReadToolError(
      'mvp_env_value_missing',
      `mvp read tools: server environment variable ${name} referenced by mvp.${field} is unset or empty`,
    );
  }
  return value.trim();
}

/**
 * Validate the operator configuration. Returns null when the MVP block is absent or disabled so the
 * caller registers no tools; throws on an enabled-but-incomplete block so a misconfiguration fails
 * loudly instead of silently exposing nothing.
 */
function resolveMvpReadConfig(options: MvpReadToolsOptions | undefined): ResolvedMvpReadConfig | null {
  const config = options?.config;
  if (!config || typeof config !== 'object' || config.enabled !== true) return null;

  // P0 uses exactly one chat platform, and this slice is Slack-only.
  if (config.platform !== 'slack') {
    configError('mvp.platform must be "slack"; these tools read Slack host context only');
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
  // no reader was injected, so a rehearsal or test can supply its own reader without credentials.
  const urlReference = readEnvReference(config.supabaseUrlEnvVar, 'supabaseUrlEnvVar');
  const keyReference = readEnvReference(config.supabaseServiceKeyEnvVar, 'supabaseServiceKeyEnvVar');

  let reader: MvpReadToolReader | undefined = options?.reader;
  if (!reader) {
    const env = options?.env ?? process.env;
    const supabaseUrl = readEnvValue(env, urlReference, 'supabaseUrlEnvVar');
    const serviceRoleKey = readEnvValue(env, keyReference, 'supabaseServiceKeyEnvVar');
    reader = createFoundationDbReader({
      supabaseUrl,
      serviceRoleKey,
      environment: environment as FoundationEnvironment,
      slackTeamId,
    });
  }
  if (
    typeof reader.resolveSlackMember !== 'function' ||
    typeof reader.readAvailableFunds !== 'function'
  ) {
    configError('the injected reader must implement resolveSlackMember and readAvailableFunds');
  }

  return { platform: 'slack', proposalChannelIds, boardChannelIds, reader };
}

function assertNoImpersonationArgs(args: unknown) {
  if (!args || typeof args !== 'object') return;
  for (const key of IMPERSONATION_KEYS) {
    if (Object.hasOwn(args, key)) {
      throw new MvpReadToolError(
        'actor_argument_rejected',
        `The "${key}" argument is not accepted; the acting account comes only from the host context.`,
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

function buildTools(config: ResolvedMvpReadConfig, ctx: any) {
  const { proposalChannelIds, boardChannelIds, reader } = config;

  const nativeChannelId = typeof ctx?.nativeChannelId === 'string' ? ctx.nativeChannelId.trim() : '';
  const senderId = typeof ctx?.requesterSenderId === 'string' ? ctx.requesterSenderId.trim() : '';

  // Resolve the trusted sender, or refuse before any database read. `audience` narrows which
  // approved channels may call this tool; the acting user is never taken from arguments.
  const requester = (audience: string, scoped: string[]) => {
    if (ctx?.messageChannel !== 'slack') {
      throw new MvpReadToolError('platform_out_of_scope', 'These tools answer Slack host context only.');
    }
    if (!senderId) {
      throw new MvpReadToolError('trusted_requester_unavailable', 'The host did not supply a sender ID.');
    }
    if (!nativeChannelId || !scoped.includes(nativeChannelId)) {
      throw new MvpReadToolError(
        'channel_out_of_scope',
        `This tool is limited to its approved ${audience} channel.`,
      );
    }
    return reader.resolveSlackMember(senderId);
  };

  return [
    {
      name: 'rein_mvp_my_status',
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
            tool: 'rein_mvp_my_status',
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
          return errorResult('rein_mvp_my_status', error);
        }
      },
    },
    {
      name: 'rein_mvp_funds',
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
          if (member.status !== 'resolved' || member.isDirector !== true) {
            throw new MvpReadToolError(
              'board_membership_required',
              'Reading available funds requires a currently verified director link for your Slack account.',
            );
          }
          const currency = typeof args?.currency === 'string' ? args.currency.trim().toUpperCase() : '';
          const funds = await reader.readAvailableFunds(currency);
          // Final authority check before the answer leaves the turn.
          assertCurrentInvocation(ctx);
          const details = {
            tool: 'rein_mvp_funds',
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
          return errorResult('rein_mvp_funds', error);
        }
      },
    },
  ];
}

/**
 * Build the v2 tool factory for the MVP read tools. Register it as
 * `api.registerTool(createMvpReadToolRegistration({ config }), { names: MVP_READ_TOOL_NAMES })`.
 * When the MVP block is absent or disabled, `create` returns null and no tool is registered.
 */
export function createMvpReadToolRegistration(options?: MvpReadToolsOptions) {
  const config = resolveMvpReadConfig(options);
  return {
    contextVersion: 2 as const,
    create(ctx: any) {
      if (!config) return null;
      return buildTools(config, ctx);
    },
  };
}
