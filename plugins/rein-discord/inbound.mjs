import { resolveOwner, sessionKey, isolatedToolsForAudience, createOwnerQueue } from './isolation.mjs';
import { createTurnControl } from './turn-control.mjs';
import { configuredModelRoutes, handleModelSelection } from './model-selection.mjs';

export function createIsolatedReceiver({ config, cfg, runtime, memory, send, signal, sessionStore, turns = createTurnControl(), trace = () => {} }) {
  const queue = createOwnerQueue();
  const seen = new Set();
  return async event => {
    const owner = resolveOwner(config, event);
    if (!owner || signal.aborted || typeof event.text !== 'string' || !event.text.trim() ||
        !/^[0-9]{17,20}$/.test(event.id ?? '') || event.text.length > 4000) return { dispatched: false };
    if (owner.audience === 'public' && config.requireMention !== false && !event.mentioned) return { dispatched: false };
    if (seen.has(event.id)) return { dispatched: false };
    seen.add(event.id);
    if (seen.size > 10000) seen.delete(seen.values().next().value);
    return queue(owner.key, async () => {
      if (signal.aborted) return { dispatched: false };
      const command = event.text.trim();
      if (['/new', '/reset', '/forget'].includes(command)) {
        if (command === '/forget') {
          memory.forget(owner, undefined, () => {
            if (signal.aborted) throw new Error('Receiver stopped');
          });
        } else memory.reset(owner);
        await send(owner.channelId, command === '/forget' ? '已删除你在这段对话中的记忆，并开始新对话。' : '已为你开始新对话。保存的记忆仍保留。', event.id);
        return { dispatched: false, handled: true };
      }
      const modelCommand = /^\/model(?:\s|$)/.test(command) && configuredModelRoutes(cfg) !== null;
      // No inherited global/admin/plugin commands, thread bindings, quoted
      // messages, channel history, attachments or reply-to content are loaded.
      if (command.startsWith('/') && !modelCommand) return { dispatched: false };
      const generation = memory.generation(owner);
      const key = sessionKey(owner, generation);
      const kind = owner.audience === 'public' ? 'channel' : 'direct';
      const ingress = await runtime.inbound.ingress.resolveStable({
        channelId: 'discord', accountId: 'default', cfg,
        identity: { key: 'discord-user-id', entryIdPrefix: 'rein-discord-user' },
        subject: { stableId: owner.senderId }, conversation: { kind, id: owner.channelId },
        contextBinding: { agentId: owner.agentId, sessionKey: key, nativeChannelId: owner.channelId,
          messageId: event.id, inboundEventKind: 'user_request' },
        dmPolicy: 'allowlist', allowFrom: config.dmAllowFrom,
        groupPolicy: 'allowlist', groupAllowFrom: [owner.senderId],
      });
      if (signal.aborted || ingress.ingress.admission !== 'dispatch') return { dispatched: false };
      if (modelCommand) {
        const turn = turns.open(key, signal);
        try {
          const reply = await handleModelSelection({ command, cfg, owner, key, sessionStore, signal: turn.signal,
            assertCurrent() {
              turn.assertCurrent();
              if (memory.generation(owner) !== generation) throw new Error('Isolated model selection scope changed');
            } });
          turn.assertCurrent();
          if (reply) await send(owner.channelId, reply, event.id);
          return { dispatched: false, handled: true };
        } finally { turn.close(); }
      }
      const target = `channel:${owner.channelId}`;
      const ctxPayload = runtime.inbound.buildContext({
        channel: 'discord', accountId: 'default', channelIngress: ingress,
        messageId: event.id, timestamp: event.timestamp,
        from: owner.audience === 'public' ? `discord:channel:${owner.channelId}` : `discord:${owner.senderId}`,
        sender: { id: owner.senderId },
        conversation: { kind, id: owner.channelId, spaceId: owner.guildId ?? undefined, nativeChannelId: owner.channelId },
        route: { agentId: owner.agentId, accountId: 'default', routeSessionKey: key, dispatchSessionKey: key,
          dmScope: 'per-account-channel-peer' },
        reply: { to: target, originatingTo: target, nativeChannelId: owner.channelId },
        message: { rawBody: event.text, bodyForAgent: event.text, inboundEventKind: 'user_request' },
        command: { kind: 'normal', authorized: false },
        access: { commands: { authorized: false }, mentions: { canDetectMention: true, wasMentioned: event.mentioned === true } },
      });
      trace({ phase: 'dispatch', owner: owner.key, sessionKey: key, audience: owner.audience });
      const turn = turns.open(key,signal);
      let result;
      try { result = await runtime.inbound.dispatch({
        cfg, channel: 'discord', accountId: 'default', route: { agentId: owner.agentId, sessionKey: key, dmScope: 'per-account-channel-peer' },
        ctxPayload, messageId: event.id,
        toolsAllow: isolatedToolsForAudience(cfg, owner.audience),
        record: { onRecordError: () => { throw new Error('Isolated session recording failed'); } },
        replyOptions: { abortSignal: turn.signal },
        delivery: {
          // Deliver only finalized text to this immutable native target. Model
          // tool routes/media URLs cannot redirect or add recipients.
          deliver: async (payload, info) => {
            if (turn.forgetOutcome) return { visibleReplySent: false };
            if (signal.aborted) throw new Error('Receiver stopped');
            if (info.kind !== 'final' || !payload.text) return { visibleReplySent: false };
            await send(owner.channelId, payload.text, event.id);
            return { visibleReplySent: true };
          },
          onError: () => { throw new Error('Isolated Discord delivery failed'); },
        },
      }); } catch (error) {
        if (!turn.forgetOutcome) throw error;
      } finally { turn.close(); }
      if (turn.forgetOutcome) {
        if (!signal.aborted) await send(owner.channelId,turn.forgotten
          ? '已删除指定记忆，并开始新对话。' : '这次未能删除记忆，请稍后重试。',event.id);
        return { dispatched: false, handled: true, forgotten: turn.forgotten };
      }
      return result;
    });
  };
}
