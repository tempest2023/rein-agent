import { randomUUID } from 'node:crypto';

const routeId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
export const ROUTE_STATUS_TOOL = 'rein_route_status';

// This is an owner-scoped selector, never a generic OpenClaw command surface.
// Credentials, endpoints, billing policy and other agents are not command inputs.
export function configuredModelRoutes(cfg) {
  const plugins = cfg.plugins;
  const entry = plugins?.entries?.['rein-router'];
  const config = entry?.config;
  if (plugins?.enabled === false || !Array.isArray(plugins?.allow) || !plugins.allow.includes('rein-router') ||
      plugins?.deny?.includes('rein-router') || entry?.enabled !== true || config?.enabled !== true ||
      !Array.isArray(config.channels) || !config.channels.includes('discord') ||
      !Array.isArray(config.routes) || config.routes.length === 0 || config.routes.length > 64) return null;
  const ids = config.routes.map(route => route?.id);
  if (ids.some(id => !routeId(id) || id === 'auto') || new Set(ids).size !== ids.length) return null;
  return ids;
}

// Status reads are a separate operator opt-in from model selection itself.
export function configuredRouterStatusTool(cfg) {
  return Array.isArray(cfg.tools?.allow) && cfg.tools.allow.includes(ROUTE_STATUS_TOOL) &&
    configuredModelRoutes(cfg) !== null;
}

export async function handleModelSelection({ command, cfg, owner, key, sessionStore, signal, assertCurrent }) {
  const routes = configuredModelRoutes(cfg);
  if (!routes) return null;
  if (!sessionStore?.resolveStorePath || !sessionStore.getSessionEntry ||
      !sessionStore.runWithWorkAdmission || !sessionStore.patchSessionEntry || !sessionStore.applyModelOverride) {
    throw new Error('Host session capabilities are required for isolated model selection');
  }
  const parts = command.split(/\s+/);
  const requested = parts[1];
  if (parts.length > 2 || (requested !== undefined && requested !== 'auto' && !routes.includes(requested))) {
    return `可用模型：auto、${routes.join('、')}。使用 /model 查看当前选择，或 /model <模型> 切换。`;
  }
  const storePath = sessionStore.resolveStorePath(cfg.session?.store, { agentId: owner.agentId });
  return await sessionStore.runWithWorkAdmission({ storePath, sessionKey: key, signal }, async admissionSignal => {
    const assertActive = () => {
      signal.throwIfAborted();
      admissionSignal.throwIfAborted();
      assertCurrent();
    };
    assertActive();
    const scope = { agentId: owner.agentId, sessionKey: key, storePath, readConsistency: 'latest' };
    const existing = sessionStore.getSessionEntry(scope);
    if (existing?.modelSelectionLocked) return '当前对话的模型已锁定，无法切换。';
    if (requested === undefined) {
      const selected = existing?.providerOverride === 'rein-magpie' &&
        (existing.modelOverride === 'auto' || routes.includes(existing.modelOverride))
        ? existing.modelOverride : '使用代理默认配置';
      return `当前模型选择：${selected}。可用模型：auto、${routes.join('、')}。使用 /model <模型> 切换；auto 使用动态路由。`;
    }
    const expectedSessionId = existing?.sessionId;
    const updated = await sessionStore.patchSessionEntry({
      ...scope,
      fallbackEntry: existing ?? { sessionId: randomUUID(), updatedAt: Date.now() },
      assertCommitAllowed: assertActive,
      update(entry, context) {
        assertActive();
        if (entry.modelSelectionLocked || context.existingEntry?.sessionId !== expectedSessionId) {
          throw new Error('Isolated model selection session changed');
        }
        const selected = { ...entry };
        sessionStore.applyModelOverride({ entry: selected,
          selection: { provider: 'rein-magpie', model: requested },
          selectionSource: requested === 'auto' ? 'auto' : 'user' });
        // Native selection clears stale auth/runtime metadata. Preserve those
        // deletions in the patch without replacing unrelated session state.
        return Object.fromEntries([...new Set([...Object.keys(entry), ...Object.keys(selected)])]
          .filter(field => !Object.is(entry[field], selected[field]))
          .map(field => [field, selected[field]]));
      },
    });
    assertActive();
    if (!updated || updated.providerOverride !== 'rein-magpie' || updated.modelOverride !== requested) {
      throw new Error('Isolated model selection was not persisted');
    }
    return requested === 'auto' ? '已为这段对话启用动态模型路由。' : `已为这段对话选择模型：${requested}。`;
  });
}
