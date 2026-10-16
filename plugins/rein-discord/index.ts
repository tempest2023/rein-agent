import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { buildJsonChannelConfigSchema } from 'openclaw/plugin-sdk/channel-config-schema';
import { applyModelOverrideToSessionEntry } from 'openclaw/plugin-sdk/model-session-runtime';
import { validateIsolationConfig, assertIsolationRuntime, MEMORY_TOOLS } from './isolation.mjs';
import { createMemberMemory } from './memory.mjs';
import { createMemoryToolFactory } from './memory-tools.mjs';
import { getHostTurnControl } from './turn-control.mjs';

type DiscordTransport = typeof import('./gateway.mjs').startIsolatedDiscord;
const defaultTransport: DiscordTransport = async params => {
  const { startIsolatedDiscord } = await import('./gateway.mjs');
  return await startIsolatedDiscord(params);
};

// The optional transport is code-only dependency injection for the native
// pipeline probe, never a runtime config option or model-accessible endpoint.
export function registerReinDiscord(api: OpenClawPluginApi, transport: DiscordTransport = defaultTransport) {
    const config = validateIsolationConfig(api.pluginConfig);
    const workspaceDir = api.config.agents?.defaults?.workspace;
    if (!workspaceDir) throw new Error('Dedicated public Discord workspace is required');
    assertIsolationRuntime(api.config, config, workspaceDir);
    let memory;
    const turns = getHostTurnControl(config.memoryPath);
    const getMemory = () => memory ??= createMemberMemory(config.memoryPath);
    api.registerTool({ contextVersion: 2, create: createMemoryToolFactory(config, getMemory, turns) }, { names: MEMORY_TOOLS });
    api.registerChannel({
      id: 'discord',
      meta: { id: 'discord', label: 'Rein Isolated Discord', selectionLabel: 'Rein Isolated Discord',
        docsPath: '/channels/discord', blurb: 'Per-sender community onboarding' },
      capabilities: { chatTypes: ['direct', 'channel'], media: false, nativeCommands: false },
      configSchema: buildJsonChannelConfigSchema({ type: 'object', properties: { enabled: { type: 'boolean' } }, additionalProperties: false }),
      config: {
        listAccountIds: cfg => cfg.channels?.discord?.enabled === true ? ['default'] : [],
        resolveAccount: cfg => ({ accountId: 'default', enabled: cfg.channels?.discord?.enabled === true }),
        isEnabled: account => account.enabled,
        isConfigured: () => Boolean(process.env[config.tokenEnv]),
      },
      gateway: {
        async startAccount(ctx) {
          if (!ctx.channelRuntime) throw new Error('Host-owned channel runtime required');
          return await transport({ config, cfg: ctx.cfg, runtime: ctx.channelRuntime,
            memory: getMemory(), turns, sessionStore: { ...api.runtime.agent.session,
              applyModelOverride: applyModelOverrideToSessionEntry },
            signal: ctx.abortSignal, status: ctx.setStatus, log: ctx.log });
        },
      },
    });
}

export default definePluginEntry({
  id: 'rein-discord',
  name: 'Rein Isolated Discord',
  description: 'Dedicated onboarding ingress with per-sender, per-audience sessions and memory.',
  register: registerReinDiscord,
});
