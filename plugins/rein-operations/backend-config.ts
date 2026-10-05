// The tool-side configuration contract for every backend-backed governance surface.
//
// The `foundationDb` block names the backend by environment variable and lists the approved
// workspaces with their own native channel IDs. It names no database URL, no service key and no
// profile-email option, because the Agent holds no database credential and resolves no identity
// itself: it presents a private backend-signed proof on every call.
//
// The acting platform is never a constant. It is the trusted `ctx.messageChannel`, admitted only
// when it matches exactly one configured workspace whose platform equals that channel and whose
// channel list contains the trusted native channel ID.

import { createBackendTransport, type BackendTransport } from './backend-transport.ts';
import {
  createBackendReader,
  createBackendWriter,
  resolveInvocationProof,
  type BackendProofResolution,
  type ToolProofProvider,
} from './backend-db-adapter.ts';
import type { FoundationDbReader } from './foundation-db-reader.ts';
import type { FoundationDbWriter } from './foundation-db-writer.ts';

export const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const PLATFORM_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;
export const ID_FIELD_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Every key the block may carry. Anything else is refused, so a legacy key fails loudly. */
export const BACKEND_CONFIG_KEYS = Object.freeze([
  'enabled',
  'platform',
  'workspaces',
  'proposalChannelIds',
  'boardChannelIds',
  'voteTypeAliases',
  'backendApiBaseUrlEnvVar',
  'agentCallerIdEnvVar',
  'agentCredentialEnvVar',
  'proposalConfirmationKeyEnvVar',
] as const);

/** Keys of the earlier database-shaped block. Naming one is an operator error, never a fallback. */
export const LEGACY_CONFIG_KEYS = Object.freeze([
  'slackTeamId',
  'environment',
  'supabaseUrlEnvVar',
  'supabaseServiceKeyEnvVar',
  'identityEmailMatch',
  'slackBotTokenEnvVar',
] as const);

export interface BackendWorkspace {
  platform: string;
  workspaceId: string;
  nativeChannelIds: readonly string[];
  proposalChannelIds: readonly string[];
  boardChannelIds: readonly string[];
}

export interface ResolvedBackendConfig {
  platform: string;
  workspaces: readonly BackendWorkspace[];
  voteTypeAliases: unknown;
  baseUrl: string;
  callerId: string;
  credential: string;
  confirmationSigningKey: string | null;
  timeoutMs?: number;
}

export interface ResolvedBackendIdentity {
  platform: string;
  workspaceId: string;
  nativeChannelId: string;
}

export type BackendConfigErrorFactory = (message: string) => never;

export interface ParseBackendConfigOptions {
  config?: unknown;
  env?: Record<string, string | undefined>;
  requireConfirmationKey?: boolean;
  confirmationSigningKey?: string;
  error: BackendConfigErrorFactory;
  /**
   * Raised when a named variable is unset or empty. Kept apart from `error` so a deployment with a
   * missing value reports its own code instead of a malformed block.
   */
  envError?: BackendConfigErrorFactory;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const readEnvReference = (factory: BackendConfigErrorFactory, reference: unknown, field: string): string => {
  const name = trimmed(reference);
  if (!ENV_VAR_NAME_PATTERN.test(name)) {
    factory(`foundationDb.${field} must name a server environment variable`);
  }
  return name;
};

const readEnvValue = (
  factory: BackendConfigErrorFactory,
  env: Record<string, string | undefined>,
  name: string,
  field: string,
): string => {
  const value = env?.[name];
  if (typeof value !== 'string' || !value.trim()) {
    factory(`server environment variable ${name} referenced by foundationDb.${field} is unset or empty`);
  }
  return (value as string).trim();
};

const readChannelIdList = (factory: BackendConfigErrorFactory, field: string, value: unknown): string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    factory(`foundationDb.${field} must list at least one approved native channel ID`);
  }
  const channels = (value as unknown[]).map(id => trimmed(id));
  if (channels.some(id => !ID_FIELD_PATTERN.test(id))) {
    factory(`foundationDb.${field} must contain non-empty native channel ID strings`);
  }
  return channels;
};

const readWorkspaces = (
  factory: BackendConfigErrorFactory,
  block: Record<string, unknown>,
): BackendWorkspace[] => {
  const workspaces = block.workspaces;
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    factory('foundationDb.workspaces must list at least one approved workspace');
  }
  const seen = new Set<string>();
  return (workspaces as unknown[]).map(entry => {
    if (!isPlainObject(entry)) factory('foundationDb.workspaces entries must be objects');
    const platform = trimmed((entry as Record<string, unknown>).platform);
    if (!PLATFORM_PATTERN.test(platform)) {
      factory('each foundationDb.workspaces entry must name a lower-case platform such as slack or discord');
    }
    const workspaceId = trimmed((entry as Record<string, unknown>).workspaceId);
    if (!ID_FIELD_PATTERN.test(workspaceId)) {
      factory('each foundationDb.workspaces entry must carry one non-empty workspaceId');
    }
    const key = `${platform}\u0000${workspaceId}`;
    if (seen.has(key)) factory('foundationDb.workspaces must not repeat one platform and workspaceId');
    seen.add(key);
    return {
      platform,
      workspaceId,
      nativeChannelIds: readChannelIdList(factory, 'workspaces[].nativeChannelIds', (entry as Record<string, unknown>).nativeChannelIds),
      proposalChannelIds: [],
      boardChannelIds: [],
    };
  });
};

export function parseBackendConfig(options: ParseBackendConfigOptions): ResolvedBackendConfig | null {
  const { config, error: factory } = options;
  if (!isPlainObject(config)) return null;
  if (config.enabled !== true) return null;

  for (const key of LEGACY_CONFIG_KEYS) {
    if (Object.hasOwn(config, key)) {
      factory(
        `foundationDb.${key} is no longer accepted: this block names an authenticated backend, not a database, and the Agent holds no database credential`,
      );
    }
  }
  for (const key of Object.keys(config)) {
    if (!(BACKEND_CONFIG_KEYS as readonly string[]).includes(key)) {
      factory(`foundationDb.${key} is not a known configuration key`);
    }
  }

  const workspaces = readWorkspaces(factory, config);
  // `platform` is a legacy single-platform default. The approved workspaces decide which platforms
  // are admitted, so an absent value is valid; a present one must still name a real platform and
  // must be one the workspace list actually enrolls.
  const declaredPlatform = config.platform === undefined ? '' : trimmed(config.platform);
  if (declaredPlatform && !PLATFORM_PATTERN.test(declaredPlatform)) {
    factory('foundationDb.platform must name the governance platform, for example slack');
  }
  if (declaredPlatform && !workspaces.some(workspace => workspace.platform === declaredPlatform)) {
    factory('foundationDb.platform must name a platform the foundationDb.workspaces list enrolls');
  }
  const platform = declaredPlatform || workspaces[0].platform;
  const proposalChannelIds = readChannelIdList(factory, 'proposalChannelIds', config.proposalChannelIds);
  const boardChannelIds = readChannelIdList(factory, 'boardChannelIds', config.boardChannelIds);
  const allowed = new Set(workspaces.flatMap(workspace => [...workspace.nativeChannelIds]));
  for (const channel of [...proposalChannelIds, ...boardChannelIds]) {
    if (!allowed.has(channel)) {
      factory('every foundationDb proposal and board channel must appear in some workspaces[] nativeChannelIds list');
    }
  }

  const env = options.env ?? process.env;
  const envFactory = options.envError ?? options.error;
  const baseUrlReference = readEnvReference(factory, config.backendApiBaseUrlEnvVar, 'backendApiBaseUrlEnvVar');
  const callerIdReference = readEnvReference(factory, config.agentCallerIdEnvVar, 'agentCallerIdEnvVar');
  const credentialReference = readEnvReference(factory, config.agentCredentialEnvVar, 'agentCredentialEnvVar');
  const confirmationReference =
    options.requireConfirmationKey === true
      ? readEnvReference(factory, config.proposalConfirmationKeyEnvVar, 'proposalConfirmationKeyEnvVar')
      : null;

  const baseUrl = readEnvValue(envFactory, env, baseUrlReference, 'backendApiBaseUrlEnvVar');
  const callerId = readEnvValue(envFactory, env, callerIdReference, 'agentCallerIdEnvVar');
  const credential = readEnvValue(envFactory, env, credentialReference, 'agentCredentialEnvVar');
  const injectedKey = trimmed(options.confirmationSigningKey);
  if (options.requireConfirmationKey === true && confirmationReference !== null && !injectedKey) {
    readEnvValue(envFactory, env, confirmationReference, 'proposalConfirmationKeyEnvVar');
  }
  const confirmationSigningKey = injectedKey
    ? injectedKey
    : confirmationReference === null
      ? null
      : readEnvValue(envFactory, env, confirmationReference, 'proposalConfirmationKeyEnvVar');

  const timeoutMs = config.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0)) {
    factory('foundationDb.timeoutMs must be a positive integer when it is present');
  }

  const labelled = workspaces.map(workspace => ({
    ...workspace,
    proposalChannelIds: proposalChannelIds.filter(channel => workspace.nativeChannelIds.includes(channel)),
    boardChannelIds: boardChannelIds.filter(channel => workspace.nativeChannelIds.includes(channel)),
  }));

  return {
    platform,
    workspaces: labelled,
    voteTypeAliases: config.voteTypeAliases,
    baseUrl,
    callerId,
    credential,
    confirmationSigningKey,
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
  };
}

/**
 * Pick the one workspace a trusted tool context belongs to. The platform is the host's own
 * `messageChannel`, and the channel must be inside that workspace's approved list; a call that
 * matches no workspace, a platform the operator did not configure, or a channel from another
 * workspace is refused before any backend call.
 */
export function resolveTrustedWorkspace(
  config: ResolvedBackendConfig,
  ctx: unknown,
): ResolvedBackendIdentity | null {
  if (!isPlainObject(ctx)) return null;
  const platform = trimmed(ctx.messageChannel);
  const nativeChannelId = trimmed(ctx.nativeChannelId);
  if (!platform || !nativeChannelId) return null;
  if (!(config.workspaces ?? []).some(workspace => workspace.platform === platform)) return null;
  const matches = config.workspaces.filter(
    workspace => workspace.platform === platform && workspace.nativeChannelIds.includes(nativeChannelId),
  );
  if (matches.length !== 1) return null;
  return { platform, workspaceId: matches[0].workspaceId, nativeChannelId };
}

export function createConfiguredTransport(config: ResolvedBackendConfig): BackendTransport {
  return createBackendTransport({
    baseUrl: config.baseUrl,
    callerId: config.callerId,
    credential: config.credential,
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  });
}

/**
 * One reader/writer pair per invocation. The transport is bound to the resolved workspace, and the
 * proof is resolved through the provider on every backend call, so a proof that lands after this
 * factory ran is still used and a missing one closes that single call.
 */
export function createInvocationAdapters(params: {
  transport: BackendTransport;
  identity: ResolvedBackendIdentity | null;
  proofProvider?: ToolProofProvider;
  ctx: unknown;
}): {
  reader: FoundationDbReader | null;
  writer: FoundationDbWriter | null;
  getProof: () => BackendProofResolution;
} | null {
  const identity = params.identity;
  if (identity === null) return null;
  const getProof = (): BackendProofResolution =>
    resolveInvocationProof(params.proofProvider, params.ctx);
  const base = { transport: params.transport, getProof, ...identity };
  return {
    reader: createBackendReader(base),
    writer: createBackendWriter(base),
    getProof,
  };
}
