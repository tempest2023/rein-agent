import { createHash } from 'node:crypto';
import {
  createConfiguredTransport,
  parseBackendConfig,
  resolveTrustedWorkspace,
  type ResolvedBackendConfig,
} from './backend-config.ts';
import type { BackendProof, BackendTransport } from './backend-transport.ts';

export type BackendProofResolution =
  | { ok: true; proof: BackendProof }
  | { ok: false; reason: string };

export type ToolProofProvider = (ctx: unknown) => BackendProofResolution | null | undefined;

export type BackendRuntimeFailureReason =
  | 'trusted_requester_unavailable'
  | 'trusted_call_id_unavailable'
  | 'current_invocation_guard_unavailable'
  | 'workspace_scope_unresolved'
  | 'proof_unavailable'
  | 'proof_in_flight';

export interface BackendToolRegistration {
  contextVersion?: 2;
  create: (ctx: unknown) => unknown;
}

export interface BackendRuntime {
  readonly transport: BackendTransport;
  /**
   * The legacy configured default platform. Admission never reads it: the acting platform is the
   * trusted host message channel, so one deployment may serve several enrolled platforms.
   */
  readonly platform: string;
  proofProvider: ToolProofProvider;
  wrapRegistration<TRegistration extends BackendToolRegistration>(registration: TRegistration): TRegistration;
}

export class BackendRuntimeError extends Error {
  readonly code: BackendRuntimeFailureReason;

  constructor(code: BackendRuntimeFailureReason, message?: string) {
    super(message ?? code);
    this.name = 'BackendRuntimeError';
    this.code = code;
  }
}

export interface CreateBackendRuntimeOptions {
  config?: unknown;
  env?: Record<string, string | undefined>;
  transport?: BackendTransport;
  now?: () => number;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The two caller-visible refusals the integration contract names: a malformed `foundationDb` block
 * and a referenced server environment variable that is unset or empty. `backend-config.ts` keeps
 * the env read on its own factory, so each failure carries its own code.
 */
const CONFIG_INVALID_CODE = 'foundation_db_config_invalid';
const ENV_VALUE_MISSING_CODE = 'foundation_db_env_value_missing';

const codedConfigError =
  (code: string) =>
  (message: string): never => {
    const error = new Error(message) as Error & { code?: string };
    error.code = code;
    throw error;
  };

export function resolveBackendRuntimeConfig(options?: CreateBackendRuntimeOptions): ResolvedBackendConfig | null {
  return parseBackendConfig({
    config: options?.config,
    ...(options?.env ? { env: options.env } : {}),
    error: codedConfigError(CONFIG_INVALID_CODE),
    envError: codedConfigError(ENV_VALUE_MISSING_CODE),
  });
}

const readTrustedContext = (
  ctx: unknown,
): { platform: string; nativeChannelId: string; senderId: string; sessionId: string } => {
  if (!isPlainObject(ctx)) {
    throw new BackendRuntimeError('trusted_requester_unavailable', 'trusted host tool context is unavailable');
  }
  const platform = typeof ctx.messageChannel === 'string' ? ctx.messageChannel.trim() : '';
  const nativeChannelId = typeof ctx.nativeChannelId === 'string' ? ctx.nativeChannelId.trim() : '';
  const senderId = typeof ctx.requesterSenderId === 'string' ? ctx.requesterSenderId.trim() : '';
  const sessionId = typeof ctx.sessionId === 'string' ? ctx.sessionId.trim() : '';
  if (!platform || !nativeChannelId || !senderId || !sessionId) {
    throw new BackendRuntimeError(
      'trusted_requester_unavailable',
      'host tool context carried no trusted platform, channel, sender and session',
    );
  }
  return { platform, nativeChannelId, senderId, sessionId };
};

const derivationEventId = (params: {
  sessionId: string;
  toolCallId: string;
  platform: string;
  workspaceId: string;
  channelId: string;
  senderId: string;
}): string =>
  createHash('sha256')
    .update(
      [
        params.sessionId,
        params.toolCallId,
        params.platform,
        params.workspaceId,
        params.channelId,
        params.senderId,
      ].join('\u0000'),
    )
    .digest('hex');

const isProofShape = (value: unknown): value is BackendProof =>
  isPlainObject(value) && value.kind === 'assertion' && typeof value.assertion === 'string' && value.assertion.length > 0;

export function createBackendRuntime(options?: CreateBackendRuntimeOptions): BackendRuntime | null {
  const resolved = resolveBackendRuntimeConfig(options);
  if (!resolved) return null;

  const transport = options?.transport ?? createConfiguredTransport(resolved);
  const now = options?.now ?? Date.now;
  const proofByContext = new WeakMap<object, BackendProof>();
  const inFlightContexts = new WeakSet<object>();

  const proofProvider: ToolProofProvider = ctx => {
    if (!isPlainObject(ctx)) return { ok: false, reason: 'proof_unavailable' };
    const proof = proofByContext.get(ctx);
    if (!proof) return { ok: false, reason: 'proof_unavailable' };
    return { ok: true, proof };
  };

  const assertCurrent = (ctx: Record<string, unknown>): void => {
    const guard = ctx.assertInvocationCurrent;
    if (typeof guard !== 'function') {
      throw new BackendRuntimeError(
        'current_invocation_guard_unavailable',
        'the host tool context carried no current-invocation guard',
      );
    }
    (guard as () => void).call(ctx);
  };

  const mintProof = async (ctx: Record<string, unknown>, toolCallId: string): Promise<BackendProof> => {
    const trusted = readTrustedContext(ctx);
    // One deployment may serve several enrolled platforms at once. The acting platform is the
    // trusted message channel, admitted only when it resolves to exactly one configured workspace;
    // the legacy `resolved.platform` default narrows nothing.
    const identity = resolveTrustedWorkspace(resolved, ctx);
    if (!identity) {
      throw new BackendRuntimeError(
        'workspace_scope_unresolved',
        'the trusted host channel does not resolve to exactly one configured workspace',
      );
    }
    const eventId = derivationEventId({
      sessionId: trusted.sessionId,
      toolCallId,
      platform: identity.platform,
      workspaceId: identity.workspaceId,
      channelId: identity.nativeChannelId,
      senderId: trusted.senderId,
    });
    const response = await transport.relayIngress({
      platform: identity.platform,
      workspace_id: identity.workspaceId,
      platform_user_id: trusted.senderId,
      channel_id: identity.nativeChannelId,
      event_id: eventId,
      event_ts: new Date(now()).toISOString(),
    });
    if (!response.ok) {
      throw new BackendRuntimeError('proof_unavailable', `ingress relay refused the request (${response.reason})`);
    }
    const proof = { kind: 'assertion' as const, assertion: (response.body as Record<string, unknown>).assertion };
    if (!isProofShape(proof)) {
      throw new BackendRuntimeError('proof_unavailable', 'ingress relay returned no usable assertion');
    }
    return Object.freeze(proof);
  };

  const wrapExecute = (ctx: Record<string, unknown>, execute: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]): Promise<unknown> => {
      // The ingress event id is derived from the host's own tool call id, so a call that arrives
      // without one fails closed rather than minting a reusable, colliding proof.
      const toolCallId = typeof args[0] === 'string' ? args[0].trim() : '';
      if (!toolCallId) {
        throw new BackendRuntimeError(
          'trusted_call_id_unavailable',
          'the host tool call carried no trusted call id to derive the ingress event from',
        );
      }
      assertCurrent(ctx);
      if (inFlightContexts.has(ctx)) {
        throw new BackendRuntimeError('proof_in_flight', 'a concurrent tool call already owns this host context');
      }
      inFlightContexts.add(ctx);
      try {
        let proof: BackendProof;
        try {
          proof = await mintProof(ctx, toolCallId);
        } catch (error) {
          if (error instanceof BackendRuntimeError) throw error;
          throw new BackendRuntimeError('proof_unavailable', 'the ingress relay did not complete');
        }
        proofByContext.set(ctx, proof);
        assertCurrent(ctx);
        return await execute.apply(undefined, args);
      } finally {
        proofByContext.delete(ctx);
        inFlightContexts.delete(ctx);
      }
    };

  const wrapRegistration = <TRegistration extends BackendToolRegistration>(
    registration: TRegistration,
  ): TRegistration => {
    if (!registration || typeof registration.create !== 'function') {
      throw new BackendRuntimeError('trusted_requester_unavailable', 'wrapRegistration requires a tool registration');
    }
    const wrapped = {
      contextVersion: 2 as const,
      create(ctx: unknown) {
        const tools = registration.create(ctx);
        if (!Array.isArray(tools) || !isPlainObject(ctx)) return tools;
        return tools.map(tool => {
          if (!isPlainObject(tool) || typeof tool.execute !== 'function') return tool;
          return {
            ...tool,
            execute: wrapExecute(ctx, tool.execute as (...args: unknown[]) => unknown),
          };
        });
      },
    };
    return wrapped as unknown as TRegistration;
  };

  return Object.freeze({
    transport,
    platform: resolved.platform,
    proofProvider,
    wrapRegistration,
  });
}
