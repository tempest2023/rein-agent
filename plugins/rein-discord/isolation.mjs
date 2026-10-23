import { isAbsolute } from 'node:path';
import { configuredRouterStatusTool, ROUTE_STATUS_TOOL } from './model-selection.mjs';
import { createScopedOwner, sessionKey, MEMORY_TOOLS } from '@rein-protocol/isolation-core/scope';
import { assertIsolatedRuntime } from '@rein-protocol/isolation-core/runtime-guard';
export { sessionKey, MEMORY_TOOLS, createOwnerQueue } from '@rein-protocol/isolation-core/scope';

const snowflake = value => typeof value === 'string' && /^[0-9]{17,20}$/.test(value);
export const PUBLIC_TOOLS = ['read', 'web_search', 'web_fetch', 'rein_status', 'rein_member_status',
  'rein_identity_bind_start', 'rein_identity_bind_status', 'rein_identity_bind_complete',
  'rein_resources_search', 'rein_resource_get', 'rein_events_search', 'rein_event_get', ...MEMORY_TOOLS];
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
  assertIsolatedRuntime(cfg,config,workspaceDir,{platform:'discord',publicTools:isolatedToolsForAudience(cfg,'public'),publicReferences:['DISCORD_ONBOARDING.md'],publicSkills:['rein-community-discovery']});
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
  return Object.freeze({...createScopedOwner({...config,platform:'discord'}, {spaceId:guildId,channelId:event.channelId,
    senderId:event.senderId,audience,kind:audience==='public'?'channel':'direct'}),guildId});
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
