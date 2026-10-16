import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep, dirname, join } from 'node:path';
import { existsSync, realpathSync, readdirSync, lstatSync } from 'node:fs';
import { configuredRouterStatusTool, ROUTE_STATUS_TOOL } from './model-selection.mjs';

const snowflake = value => typeof value === 'string' && /^[0-9]{17,20}$/.test(value);
export const MEMORY_TOOLS = ['rein_memory_read', 'rein_memory_remember', 'rein_memory_forget'];
export const PUBLIC_TOOLS = ['read', 'web_search', 'web_fetch', 'rein_status', 'rein_member_status',
  'rein_identity_bind_start', 'rein_identity_bind_status', 'rein_identity_bind_complete', ...MEMORY_TOOLS];
export const PRIVATE_TOOLS = ['read', 'web_search', 'web_fetch', 'rein_status', ...MEMORY_TOOLS];

export function isolatedToolsForAudience(cfg, audience) {
  const defaults = audience === 'public' ? PUBLIC_TOOLS : PRIVATE_TOOLS;
  return configuredRouterStatusTool(cfg) ? [...defaults, ROUTE_STATUS_TOOL] : defaults;
}

export function validateIsolationConfig(config) {
  if (!config || !snowflake(config.botUserId) || !/^[a-z][a-z0-9-]{0,50}$/.test(config.agentId ?? '') ||
      !/^[A-Z][A-Z0-9_]+$/.test(config.tokenEnv ?? '') || !isAbsolute(config.memoryPath ?? '') ||
      !Array.isArray(config.guilds) || config.guilds.length === 0 ||
      !Array.isArray(config.dmAllowFrom)) throw new Error('Invalid rein-discord isolation configuration');
  const channels = new Set();
  for (const guild of config.guilds) {
    if (!snowflake(guild.id) || !Array.isArray(guild.channelIds) || guild.channelIds.length === 0 ||
        (guild.userIds !== undefined && (!Array.isArray(guild.userIds) || guild.userIds.length === 0 || guild.userIds.some(id => !snowflake(id))))) {
      throw new Error('Guild/channel/user allowlists must use native Discord IDs');
    }
    for (const id of guild.channelIds) {
      if (!snowflake(id) || channels.has(id)) throw new Error('Invalid or ambiguous Discord channel');
      channels.add(id);
    }
  }
  if (config.dmAllowFrom.some(id => !snowflake(id))) throw new Error('Invalid DM allowlist');
  return config;
}

export function assertIsolationRuntime(cfg, config, workspaceDir) {
  validateIsolationConfig(config);
  let parent = dirname(config.memoryPath);
  const suffix = [];
  while (!existsSync(parent)) { suffix.unshift(parent.split(sep).at(-1)); parent = dirname(parent); }
  const physicalMemory = join(realpathSync(parent), ...suffix, config.memoryPath.split(sep).at(-1));
  const inside = relative(realpathSync(workspaceDir), physicalMemory);
  if (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) throw new Error('Private memory must be outside the public workspace');
  if (cfg.plugins?.entries?.discord?.enabled !== false) throw new Error('Disable the bundled Discord plugin before enabling rein-discord');
  if (cfg.memory?.search?.enabled !== false || cfg.memory?.search?.rememberAcrossConversations !== false ||
      cfg.agents?.defaults?.compaction?.memoryFlush?.enabled !== false) throw new Error('Shared native memory must be disabled');
  if (cfg.agents?.defaults?.skipBootstrap !== true) throw new Error('Dedicated public workspace must disable automatic bootstrap creation');
  if (cfg.tools?.fs?.workspaceOnly !== true || cfg.tools?.sessions?.visibility !== 'self' || cfg.tools?.agentToAgent?.enabled !== false) {
    throw new Error('Rein Discord requires confined filesystem and session tools');
  }
  const allowedTools = isolatedToolsForAudience(cfg, 'public');
  if (!Array.isArray(cfg.tools?.allow) || cfg.tools.allow.some(name => !allowedTools.includes(name))) {
    throw new Error('Rein Discord requires an explicit onboarding-only tool allowlist');
  }
  if (cfg.tools?.alsoAllow?.length || cfg.tools?.byProvider || cfg.skills?.load?.extraDirs?.length ||
      cfg.plugins?.slots?.contextEngine) throw new Error('Tool, skill-directory and context-engine overrides are unsupported');
  if (cfg.session?.groupScope === 'main' || Object.entries(cfg.channels ?? {}).some(([name,value]) =>
      !['discord','defaults'].includes(name) && value?.enabled !== false)) throw new Error('Use a dedicated Discord profile with separate room sessions');
  if (Object.values(cfg.models?.providers ?? {}).some(provider => provider.agentRuntime ||
      provider.models?.some(model => model.agentRuntime)) || cfg.agents?.defaults?.cliBackends ||
      Object.values(cfg.agents?.defaults?.models ?? {}).some(model => model.agentRuntime)) throw new Error('Alternate provider/model agent runtimes are unsupported');
  // This adapter is deliberately one dedicated agent/account. Agent overrides,
  // channel bindings and shared alternate harnesses would invalidate the audited boundary.
  // The host migrates an omitted roster to { main: {} } before registration.
  // Permit only that empty entry; every per-agent field and extra agent is unsupported.
  const entries = cfg.agents?.entries;
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const emptyMain = record(entries) && Object.keys(entries).length === 1 &&
    Object.hasOwn(entries, 'main') && record(entries.main) && Object.keys(entries.main).length === 0;
  if (config.agentId !== 'main' || cfg.bindings?.length || cfg.agents?.list?.length || cfg.agents?.ownership !== undefined ||
      (entries !== undefined && !emptyMain) || cfg.channels?.discord?.accounts ||
      cfg.agents?.defaults?.memory || cfg.agents?.defaults?.tools) throw new Error('Agent/account/binding overrides are unsupported in the isolated profile');
  // This is a dedicated public-reference workspace, not an operator workspace.
  // Contents of these reviewed files are public; no runtime/transcript directory
  // or personal bootstrap file can be added without failing startup.
  const publicFiles = new Set(['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'TOOLS.md', 'HEARTBEAT.md',
    'USER.md', 'DISCORD_ONBOARDING.md', 'community-directory.json']);
  for (const file of readdirSync(workspaceDir)) {
    const stat = lstatSync(join(workspaceDir, file));
    if (!publicFiles.has(file) || !stat.isFile() || stat.nlink !== 1) throw new Error('Workspace must contain only approved public reference files');
  }
}

// Only the authenticated transport supplies these fields. Message text, display
// names, community-link claims and model arguments never participate in routing.
export function resolveOwner(config, event) {
  if (!snowflake(event.senderId) || !snowflake(event.channelId) || event.bot || event.webhook) return null;
  let guildId;
  let audience;
  if (event.guildId) {
    const guild = config.guilds.find(g => g.id === event.guildId && g.channelIds.includes(event.channelId));
    if (!guild || (guild.userIds && !guild.userIds.includes(event.senderId))) return null;
    guildId = guild.id;
    audience = 'public';
  } else {
    if (event.kind !== 'direct' || !config.dmAllowFrom.includes(event.senderId)) return null;
    guildId = null;
    audience = 'private';
  }
  const tuple = [1, config.agentId, 'discord', 'default', config.botUserId, guildId, event.channelId, audience, event.senderId];
  return Object.freeze({ key: createHash('sha256').update(JSON.stringify(tuple)).digest('hex'),
    agentId: config.agentId, accountId: 'default', guildId, channelId: event.channelId,
    senderId: event.senderId, audience });
}

export function sessionKey(owner, generation = 0) {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Invalid session generation');
  return `agent:${owner.agentId}:discord:${owner.audience === 'public' ? 'channel' : 'direct'}:rein-isolated-v1-${owner.key}-${generation}`;
}

export function ownerFromToolContext(config, ctx, generation) {
  if (ctx.messageChannel !== 'discord' || ctx.agentId !== config.agentId ||
      ctx.agentAccountId !== 'default' || typeof ctx.assertInvocationCurrent !== 'function') return null;
  const guild = config.guilds.find(g => g.channelIds.includes(ctx.nativeChannelId));
  const owner = resolveOwner(config, { senderId: ctx.requesterSenderId, channelId: ctx.nativeChannelId,
    guildId: guild?.id, kind: guild ? 'channel' : 'direct' });
  if (!owner || ctx.sessionKey !== sessionKey(owner, generation(owner))) return null;
  return owner;
}

export function createOwnerQueue() {
  const pending = new Map();
  const counts = new Map();
  let total = 0;
  return async (ownerKey, task) => {
    if ((counts.get(ownerKey) ?? 0) >= 16 || total >= 256) throw new Error('Discord turn queue is full');
    counts.set(ownerKey, (counts.get(ownerKey) ?? 0) + 1);
    total++;
    const previous = pending.get(ownerKey) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    pending.set(ownerKey, next);
    try { return await next; }
    finally {
      total--;
      const count = counts.get(ownerKey) - 1;
      if (count) counts.set(ownerKey,count); else counts.delete(ownerKey);
      if (pending.get(ownerKey) === next) pending.delete(ownerKey);
    }
  };
}
