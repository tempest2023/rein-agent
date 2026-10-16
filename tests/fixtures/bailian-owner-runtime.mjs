// One local integration interaction. No Slack SDK, credential, socket, or delivery.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { readGatewayHeaderEvidence } from '../../plugins/rein-router/provenance.mjs';

const MODEL = 'bailian-token-plan/qwen3.8-flash';
const MARKER = 'REIN_BAILIAN_OWNER_CHECK';
const SESSION = 'agent:main:slack:channel:rein-bailian-owner-probe';
const usageFields = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'];
export const profileDigest = paths => createHash('sha256').update(JSON.stringify(paths.map(path =>
  createHash('sha256').update(readFileSync(path)).digest('hex')))).digest('hex');

export function registerOwnerProbe(api, { production, evidencePath, profilePaths, expectedDigest }) {
  // OpenClaw can register provider/runtime and channel scopes separately.
  // Private files coordinate this one probe without relying on shared closures.
  const statePath = kind => `${evidencePath}.${kind}`;
  const load = (kind, fallback) => existsSync(statePath(kind)) ? JSON.parse(readFileSync(statePath(kind), 'utf8')) : fallback;
  const save = (kind, value) => writeFileSync(statePath(kind), JSON.stringify(value), { mode: 0o600 });
  let finalReply = false;
  const bounded = wrap => ctx => wrap({ ...ctx, streamFn(model, context, options) {
    if (model.id !== `${MODEL}:none` || model.provider !== 'rein-magpie')
      throw new Error('bailian_probe_unexpected_model');
    let index;
    for (let slot = 0; slot < 2; slot++) {
      try { writeFileSync(statePath(`slot-${slot}`), '1', { mode: 0o600, flag: 'wx' }); index = slot; break; }
      catch (error) { if (error.code !== 'EEXIST') throw new Error('bailian_probe_budget_unavailable'); }
    }
    if (index === undefined) throw new Error('bailian_probe_model_budget_exceeded');
    const call = { session: new Headers(options?.headers).get('x-magpie-session'), headers: null };
    save(`call-${index}`, call);
    return ctx.streamFn(model, context, { ...options, maxTokens: 256, onResponse: async (response, suppliedModel) => {
      call.headers = readGatewayHeaderEvidence(response); save(`call-${index}`, call);
      await options?.onResponse?.(response, suppliedModel);
    } });
  } });
  production.register(new Proxy(api, { get(target, property) {
    if (property === 'on') return (name, hook, options) => target.on(name,
      name === 'before_agent_run' ? (...args) => {
        const result = hook(...args);
        if (result?.outcome === 'block') save('gate', { reason: /^rein_router_[a-z_]+$/.test(result.reason ?? '')
          ? result.reason : 'bailian_probe_native_gate_blocked' });
        return result;
      } : hook, options);
    if (property === 'registerProvider') return provider => target.registerProvider({ ...provider,
      wrapStreamFn: bounded(provider.wrapStreamFn),
      wrapSimpleCompletionStreamFn: bounded(provider.wrapSimpleCompletionStreamFn) });
    if (property === 'registerService') return service => target.registerService({ ...service,
      async start(ctx) {
        await service.start(ctx);
        if (profileDigest(profilePaths) !== expectedDigest) {
          await service.stop(ctx); throw new Error('bailian_probe_profile_changed');
        }
        save('ready', true);
      }, async stop(ctx) { if (existsSync(statePath('ready'))) unlinkSync(statePath('ready')); await service.stop(ctx); } });
    return Reflect.get(target, property);
  } }));
  api.on('llm_output', event => {
    if (event.provider !== 'rein-magpie' || event.model !== 'bailian-flash') return;
    const state = load('usage', { usage: {}, usageEvents: 0 });
    state.usageEvents++;
    // Pinned OpenClaw emits attemptUsage once per attempt, including its tool
    // continuations. Sum attempts if the host ever emits more than one.
    for (const field of usageFields) if (Number.isSafeInteger(event.usage?.[field]) && event.usage[field] >= 0) {
      const total = (state.usage[field] ?? 0) + event.usage[field];
      if (Number.isSafeInteger(total)) state.usage[field] = total;
    }
    save('usage', state);
  });
  api.on('agent_end', (event, ctx) => {
    if (ctx.sessionKey !== SESSION) return;
    const assistant = event.messages?.findLast(message => message?.role === 'assistant');
    save('terminal', { success: event.success === true && !event.error,
      stopReason: ['stop', 'toolUse', 'error', 'aborted', 'length'].includes(assistant?.stopReason) ? assistant.stopReason : null });
  });
  api.registerTool({ contextVersion: 2, create(ctx) {
    return { name: 'rein_probe_echo', label: 'Read-only acceptance echo',
      description: 'Return the literal acceptance marker without reading or changing user data.',
      parameters: { type: 'object', properties: { marker: { type: 'string', enum: [MARKER] } },
        required: ['marker'], additionalProperties: false },
      async execute(_id, args) {
        ctx.assertInvocationCurrent();
        if (ctx.sessionKey !== SESSION || ctx.messageChannel !== 'slack' ||
            ctx.requesterSenderId !== 'U0000000001' || ctx.agentAccountId !== 'default' ||
            args.marker !== MARKER || existsSync(statePath('tool'))) throw new Error('bailian_probe_echo_scope_invalid');
        writeFileSync(statePath('tool'), '1', { mode: 0o600, flag: 'wx' });
        return { content: [{ type: 'text', text: MARKER }], details: { marker: MARKER } };
      } };
  } }, { names: ['rein_probe_echo'] });
  api.registerChannel({ id: 'slack', meta: { id: 'slack', label: 'Local integration acceptance probe',
    selectionLabel: 'Local integration acceptance probe', docsPath: '/channels/slack', blurb: 'Local delivery only' },
    capabilities: { chatTypes: ['channel'], media: false, nativeCommands: false },
    config: { listAccountIds: cfg => cfg.channels?.slack?.enabled === true ? ['default'] : [],
      resolveAccount: (_cfg, accountId) => ({ accountId, enabled: true }),
      isEnabled: account => account.enabled, isConfigured: () => true },
    gateway: { async startAccount(ctx) {
      let error, stage = 'service';
      try {
        const readyDeadline = Date.now() + 10000;
        while (!load('ready', false) && !ctx.abortSignal.aborted && Date.now() < readyDeadline)
          await new Promise(resolve => setTimeout(resolve, 50));
        if (!load('ready', false) || !ctx.channelRuntime || ctx.accountId !== 'default') throw new Error('probe_not_ready');
        stage = 'ingress';
        const runtime = ctx.channelRuntime, channelId = 'C0000000001', senderId = 'U0000000001';
        const messageId = 'rein-bailian-owner-check', target = `channel:${channelId}`;
        const route = { agentId: 'main', accountId: 'default', routeSessionKey: SESSION, dispatchSessionKey: SESSION };
        const ingress = await runtime.inbound.ingress.resolveStable({ channelId: 'slack', accountId: 'default', cfg: ctx.cfg,
          identity: { key: 'slack-user-id', entryIdPrefix: 'rein-bailian-owner' }, subject: { stableId: senderId },
          conversation: { kind: 'channel', id: channelId },
          contextBinding: { agentId: 'main', sessionKey: SESSION, nativeChannelId: channelId,
            messageId, inboundEventKind: 'user_request' },
          dmPolicy: 'disabled', groupPolicy: 'allowlist', groupAllowFrom: [senderId] });
        if (ingress.ingress.admission !== 'dispatch') throw new Error('probe_ingress_denied');
        stage = 'dispatch';
        const text = `Call rein_probe_echo exactly once with marker ${MARKER}, then reply OK.`;
        const ctxPayload = runtime.inbound.buildContext({ channel: 'slack', accountId: 'default', channelIngress: ingress,
          messageId, timestamp: Date.now(), from: `slack:channel:${channelId}`, sender: { id: senderId },
          conversation: { kind: 'channel', id: channelId, spaceId: 'T0000000001', nativeChannelId: channelId }, route,
          reply: { to: target, originatingTo: target, nativeChannelId: channelId },
          message: { rawBody: text, bodyForAgent: text, inboundEventKind: 'user_request' },
          command: { kind: 'normal', authorized: false },
          access: { commands: { authorized: false }, mentions: { canDetectMention: true, wasMentioned: true } } });
        await runtime.inbound.dispatch({ cfg: ctx.cfg, channel: 'slack', accountId: 'default',
          route: { agentId: 'main', sessionKey: SESSION }, ctxPayload, messageId, toolsAllow: ['rein_probe_echo'],
          record: { onRecordError: () => { throw new Error('probe_record_failed'); } },
          replyOptions: { abortSignal: ctx.abortSignal }, delivery: {
            deliver: async (payload, info) => {
              if (info.kind !== 'final' || !payload.text) return { visibleReplySent: false };
              finalReply = true; return { visibleReplySent: true };
            }, onError: () => { throw new Error('probe_delivery_failed'); },
          } });
      } catch { error = `bailian_probe_owner_${stage}_failed`; }
      finally { writeFileSync(evidencePath, JSON.stringify({ error, calls: [0, 1].map(index => load(`call-${index}`, null)).filter(Boolean),
        toolCalls: existsSync(statePath('tool')) ? 1 : 0, finalReply, terminal: load('terminal', null),
        gate: load('gate', null), ...load('usage', { usage: {}, usageEvents: 0 }) }), { mode: 0o600 }); }
      await new Promise(resolve => {
        if (ctx.abortSignal.aborted) resolve(); else ctx.abortSignal.addEventListener('abort', resolve, { once: true });
      });
    } },
  });
}
