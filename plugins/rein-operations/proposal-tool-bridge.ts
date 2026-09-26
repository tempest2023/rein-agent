// Platform-neutral OpenClaw v2 tool bridge for the proposal lifecycle (PRD R04-R08, US15).
//
// This module turns the deterministic proposal core into agent tools without owning the runtime
// registration: the caller supplies one explicitly configured chat platform, the native channel ids
// that platform is allowed to act in, and a durable proposal store. Nothing here registers tools,
// approves policy, moves money or verifies identity by prompt.
//
// Trust boundary:
// - The acting account comes only from the host tool context (`messageChannel`, `nativeChannelId`,
//   `requesterSenderId`). No tool argument is ever read as an actor, and known impersonation keys are
//   rejected outright.
// - `assertCurrentInvocation` is called inside the final synchronous store transaction, immediately
//   before the write, so a revoked or stale turn cannot commit.
// - Missing configuration registers no tools (`create` returns null); a misconfigured context fails
//   closed through `resolveTrustedRequester` instead of guessing an actor.
//
// Retry semantics (honest limit):
// - v2 tool context carries no trusted inbound message or event id, only the `toolCallId` passed to
//   `execute`. The retry key is therefore derived from the tool call id, scoped to platform, account
//   and action. That makes a retried *invocation* idempotent; it is not an exactly-once guarantee
//   across distinct tool calls, and a caller that invents a fresh call id can submit again. The
//   proposal core's own duplicate detection is what protects selection from repeated submissions.
// - Reusing one call id with different arguments fails loudly instead of silently repeating or
//   creating a second action: the argument fingerprint is part of the store action label, so the
//   ledger refuses the key/action mismatch.

import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { assertCurrentInvocation, resolveTrustedRequester } from './request-context.ts';
import { createState, resolveMemberForAccount } from './proposals.ts';

/** Names the caller must declare in the manifest and pass to `registerTool(..., { names })`. */
export const PROPOSAL_TOOL_NAMES = Object.freeze([
  'rein_proposal_create',
  'rein_proposal_revise',
  'rein_proposal_confirm',
  'rein_proposal_submit',
]);

export class ProposalToolBridgeError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ProposalToolBridgeError';
    this.code = code;
    this.details = details;
  }
}

/**
 * The bridge only depends on these two store methods, so the local rehearsal store
 * (`proposal-store.ts`) or a future production store can satisfy it without changes here.
 */
export interface ProposalToolStorePort {
  snapshot: () => { revision: number; state: unknown };
  transact: (input: {
    action: string;
    at: string;
    idempotencyKey: string;
    actor?: string;
    expectedRevision?: number | null;
    run: (core: any, current: { revision: number; state: any }) => unknown;
  }) => { revision: number; result: unknown; receipt?: unknown; replayed: boolean };
}

export interface ProposalToolBridgeOptions {
  /** Exactly one configured chat platform, for example the P0 platform once decided. */
  platform?: string;
  /** Native channel ids this platform may act in. Empty means unconfigured. */
  allowedNativeChannelIds?: string[];
  /** Durable proposal store implementing {@link ProposalToolStorePort}. */
  store?: ProposalToolStorePort;
  /** Injectable clock for deterministic tests; defaults to the wall clock. */
  now?: () => string;
  /** Production adapter must check a current authoritative registry for every formal action. */
  authorizeFormalAction?: (input: { platform: string; accountId: string; at: string }) => { eligible: boolean; reason: string; memberId: string | null };
}

// Host-supplied identity keys a model must never be able to set. `proposalId` and the field names
// below are legitimate tool arguments; these are not.
const IMPERSONATION_KEYS = Object.freeze([
  'actor',
  'account',
  'accountId',
  'member',
  'memberId',
  'leadMemberId',
  'ownerAccount',
  'platform',
  'senderId',
  'requesterSenderId',
  'claimedActor',
  'senderIsOwner',
]);

const clone = (value: any) => (value === undefined ? undefined : structuredClone(value));

const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 32);

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

const proposalFieldsSchema = Type.Object(
  {
    title: Type.Optional(Type.String({ maxLength: 300 })),
    eventType: Type.Optional(Type.String({ maxLength: 80 })),
    purpose: Type.Optional(Type.String({ maxLength: 4000 })),
    audience: Type.Optional(Type.String({ maxLength: 2000 })),
    format: Type.Optional(
      Type.Union([Type.Literal('in_person'), Type.Literal('online'), Type.Literal('hybrid')]),
    ),
    collaborators: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 50 })),
    schedule: Type.Optional(
      Type.Object(
        {
          startAt: Type.Optional(Type.String({ maxLength: 40 })),
          timeZone: Type.Optional(Type.String({ maxLength: 80 })),
          durationMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
        },
        { additionalProperties: false },
      ),
    ),
    location: Type.Optional(
      Type.Object(
        {
          venue: Type.Optional(Type.String({ maxLength: 300 })),
          venueConfirmed: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
    capacity: Type.Optional(
      Type.Object(
        {
          expectedAttendance: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
          registration: Type.Optional(Type.String({ maxLength: 200 })),
        },
        { additionalProperties: false },
      ),
    ),
    program: Type.Optional(
      Type.Object(
        {
          agenda: Type.Optional(Type.String({ maxLength: 4000 })),
          speakers: Type.Optional(Type.String({ maxLength: 2000 })),
          materials: Type.Optional(Type.String({ maxLength: 2000 })),
        },
        { additionalProperties: false },
      ),
    ),
    fees: Type.Optional(
      Type.Object(
        {
          charged: Type.Optional(Type.Boolean()),
          amountMinor: Type.Optional(Type.Integer({ minimum: 0 })),
          currency: Type.Optional(Type.String({ maxLength: 12 })),
        },
        { additionalProperties: false },
      ),
    ),
    budget: Type.Optional(
      Type.Object(
        {
          requestedAmountMinor: Type.Optional(Type.Integer({ minimum: 0 })),
          currency: Type.Optional(Type.String({ maxLength: 12 })),
          items: Type.Optional(Type.String({ maxLength: 4000 })),
          assumptions: Type.Optional(Type.String({ maxLength: 4000 })),
          reimbursementExpected: Type.Optional(Type.Boolean()),
          contractualCommitments: Type.Optional(Type.Boolean()),
          hiddenCostsConfirmed: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
    resources: Type.Optional(
      Type.Object(
        {
          freeVenue: Type.Optional(Type.Boolean()),
          suppliedMaterials: Type.Optional(Type.String({ maxLength: 2000 })),
          externalSupport: Type.Optional(Type.String({ maxLength: 2000 })),
          leadSpending: Type.Optional(Type.String({ maxLength: 2000 })),
        },
        { additionalProperties: false },
      ),
    ),
    risks: Type.Optional(
      Type.Object(
        {
          notes: Type.Optional(Type.String({ maxLength: 4000 })),
          responses: Type.Optional(Type.String({ maxLength: 4000 })),
        },
        { additionalProperties: false },
      ),
    ),
    deliverables: Type.Optional(
      Type.Object(
        {
          summary: Type.Optional(Type.Boolean()),
          feedback: Type.Optional(Type.Boolean()),
          publishableMaterials: Type.Optional(Type.String({ maxLength: 2000 })),
          photoRestrictions: Type.Optional(Type.String({ maxLength: 1000 })),
        },
        { additionalProperties: false },
      ),
    ),
    exceptions: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 50 })),
  },
  { additionalProperties: false },
);

interface ResolvedBridgeOptions {
  platform: string;
  allowedNativeChannelIds: string[];
  store: ProposalToolStorePort;
  now: () => string;
  authorizeFormalAction?: ProposalToolBridgeOptions['authorizeFormalAction'];
}

// Absent or incomplete configuration yields null so the caller registers no tools. Anything that
// reaches a tool then fails closed in `resolveTrustedRequester`.
function normalizeOptions(options: unknown): ResolvedBridgeOptions | null {
  if (!options || typeof options !== 'object') return null;
  const source = options as ProposalToolBridgeOptions;
  const platform = typeof source.platform === 'string' && source.platform.trim() ? source.platform.trim() : null;
  const allowed = Array.isArray(source.allowedNativeChannelIds)
    ? source.allowedNativeChannelIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim())
    : [];
  const store = source.store;
  const storeReady =
    Boolean(store) &&
    typeof (store as ProposalToolStorePort).snapshot === 'function' &&
    typeof (store as ProposalToolStorePort).transact === 'function';
  if (!platform || allowed.length === 0 || !storeReady) return null;
  const now = typeof source.now === 'function' ? source.now : () => new Date().toISOString();
  return { platform, allowedNativeChannelIds: allowed, store: store as ProposalToolStorePort, now, authorizeFormalAction: source.authorizeFormalAction };
}

function assertNoImpersonationArgs(args: unknown) {
  if (!args || typeof args !== 'object') return;
  for (const key of IMPERSONATION_KEYS) {
    if (Object.hasOwn(args, key)) {
      throw new ProposalToolBridgeError(
        'actor_argument_rejected',
        `The "${key}" argument is not accepted; the acting account comes only from the host context.`,
        { key },
      );
    }
  }
}

function requireToolCallId(toolCallId: unknown): string {
  if (typeof toolCallId !== 'string' || !toolCallId.trim()) {
    throw new ProposalToolBridgeError(
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
  const details = {
    action,
    ok: false as const,
    error: code,
    message: describe(error),
    ...(causeCode ? { causeCode } : {}),
  };
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
}

function buildTools(config: ResolvedBridgeOptions, ctx: any) {
  const { platform, allowedNativeChannelIds, store, now, authorizeFormalAction } = config;

  const requesterFor = (at: string) => {
    // A fresh store has no persisted state yet. Identity lookup must still work so the first
    // unlinked sender can draft (AC01/R02): an empty registry simply yields no member and no
    // Contributor eligibility instead of throwing `identity_registry_unavailable`.
    const state = store.snapshot().state ?? createState();
    return resolveTrustedRequester(ctx, { platform, allowedNativeChannelIds, proposalState: state, at });
  };

  // One write path for every action: derive the account from the host context, run the domain
  // mutation inside the store lock, and guard the final synchronous write.
  const write = ({
    action,
    toolCallId,
    args,
    run,
  }: {
    action: string;
    toolCallId: unknown;
    args: unknown;
    run: (core: any, input: { account: { platform: string; accountId: string }; at: string }) => unknown;
  }) => {
    const at = now();
    const requester = requesterFor(at);
    const callId = requireToolCallId(toolCallId);
    const account = { platform: requester.platform, accountId: requester.accountId };
    const committed = store.transact({
      actor: `${platform}:${requester.accountId}`,
      // The argument fingerprint is part of the action label so a reused call id with different
      // arguments is refused by the ledger instead of silently replaying or starting a new action.
      action: `${action}:${fingerprint(args)}`,
      at,
      idempotencyKey: `${platform}:${requester.accountId}:${action}:${callId}`,
      run: (core: any) => {
        assertCurrentInvocation(ctx);
        if (action === 'confirm' || action === 'submit') {
          // Preserve the core's specific unlinked-account rejection, then require the current
          // authority to agree with the persisted canonical member before any formal write.
          const currentMemberId = resolveMemberForAccount(core.state, account)?.member?.memberId ?? null;
          if (currentMemberId) {
            const eligibility = authorizeFormalAction?.({ ...account, at });
            if (!eligibility?.eligible || eligibility.memberId !== currentMemberId) {
              throw new ProposalToolBridgeError(
                'authoritative_registry_required',
                eligibility?.eligible && eligibility.memberId !== currentMemberId
                  ? 'authoritative_member_mismatch'
                  : eligibility?.reason ?? 'authoritative_registry_unavailable',
              );
            }
          }
        }
        return run(core, { account, at });
      },
    });
    const result = committed.result;
    const proposalId =
      (result && typeof result === 'object' && 'proposalId' in result ? (result as any).proposalId : null) ??
      (args && typeof args === 'object' && 'proposalId' in args ? (args as any).proposalId : null);
    // A domain rule can reject an action without the tool call itself failing. Report that
    // truthfully rather than presenting a rejected confirmation or submission as success.
    const domainRejected = Boolean(result) && typeof result === 'object' && (result as any).ok === false;
    const reason =
      domainRejected && typeof (result as any).reason === 'string' ? (result as any).reason : null;
    const details = {
      action,
      ok: !domainRejected,
      proposalId,
      ...(reason ? { reason } : {}),
      replayed: committed.replayed,
      revision: committed.revision,
      result,
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
  };

  const guard = (action: string, args: unknown, handler: () => unknown) => {
    try {
      assertNoImpersonationArgs(args);
      return handler();
    } catch (error) {
      return errorResult(action, error);
    }
  };

  return [
    {
      name: 'rein_proposal_create',
      label: 'Create proposal draft',
      description:
        'Save a proposal draft owned by the trusted sender. A draft is not a formal submission and needs no Contributor role yet. The acting account is taken from the host context, never from arguments.',
      parameters: Type.Object({ fields: proposalFieldsSchema }, { additionalProperties: false }),
      async execute(toolCallId: unknown, args: any) {
        return guard('create', args, () =>
          write({
            action: 'create',
            toolCallId,
            args,
            run: (core, { account, at }) =>
              core.createDraft({ account, fields: clone(args?.fields ?? {}), at }),
          }),
        );
      },
    },
    {
      name: 'rein_proposal_revise',
      label: 'Revise proposal draft',
      description:
        'Apply a partial revision to a draft you own or lead. Material changes to amounts, dates or commitments invalidate any earlier confirmation and require a new one.',
      parameters: Type.Object(
        {
          proposalId: Type.String({ minLength: 1, maxLength: 64 }),
          patch: proposalFieldsSchema,
        },
        { additionalProperties: false },
      ),
      async execute(toolCallId: unknown, args: any) {
        return guard('revise', args, () =>
          write({
            action: 'revise',
            toolCallId,
            args,
            run: (core, { account, at }) =>
              core.reviseDraft({
                proposalId: args?.proposalId,
                account,
                patch: clone(args?.patch ?? {}),
                at,
              }),
          }),
        );
      },
    },
    {
      name: 'rein_proposal_confirm',
      label: 'Confirm proposal version',
      description:
        'Record your own explicit confirmation of the current proposal version. Requires an active Contributor role on the authoritative record. Silence is not consent and a stale version is refused.',
      parameters: Type.Object(
        {
          proposalId: Type.String({ minLength: 1, maxLength: 64 }),
          version: Type.Integer({ minimum: 1, maximum: 100000 }),
          statement: Type.String({ minLength: 1, maxLength: 2000 }),
          acknowledgedMaterialChanges: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      async execute(toolCallId: unknown, args: any) {
        return guard('confirm', args, () =>
          write({
            action: 'confirm',
            toolCallId,
            args,
            run: (core, { account, at }) =>
              core.confirmLeadVersion({
                proposalId: args?.proposalId,
                account,
                version: args?.version,
                at,
                statement: args?.statement,
                acknowledgedMaterialChanges: args?.acknowledgedMaterialChanges === true,
              }),
          }),
        );
      },
    },
    {
      name: 'rein_proposal_submit',
      label: 'Submit proposal for assessment',
      description:
        'Submit a confirmed proposal for assessment. It requires the confirmed version and an eligible Contributor lead, and routes to Board selection, needs-information or needs-exception. It never approves funding.',
      parameters: Type.Object(
        { proposalId: Type.String({ minLength: 1, maxLength: 64 }) },
        { additionalProperties: false },
      ),
      async execute(toolCallId: unknown, args: any) {
        return guard('submit', args, () =>
          write({
            action: 'submit',
            toolCallId,
            args,
            run: (core, { account, at }) =>
              core.submitForAssessment({ proposalId: args?.proposalId, account, at }),
          }),
        );
      },
    },
  ];
}

/**
 * Build a v2 tool factory for the proposal lifecycle. Register it as
 * `api.registerTool(createProposalToolRegistration(options), { names: PROPOSAL_TOOL_NAMES })`.
 * When configuration is absent, `create` returns null and the runtime registers no tools.
 */
export function createProposalToolRegistration(options?: ProposalToolBridgeOptions) {
  const config = normalizeOptions(options);
  return {
    contextVersion: 2 as const,
    create(ctx: any) {
      if (!config) return null;
      return buildTools(config, ctx);
    },
  };
}
