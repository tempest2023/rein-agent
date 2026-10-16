// Test-only Slack ingress. No Slack SDK, OAuth token, socket or remote account.
import { writeFileSync } from 'node:fs';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { applyModelOverrideToSessionEntry } from 'openclaw/plugin-sdk/model-session-runtime';

const alice = 'U0000000001';
const bob = 'U0000000002';
const channelId = 'C0000000001';
const keyFor = (accountId, senderId) => `agent:main:slack:channel:rein-probe-${accountId}-${senderId.toLowerCase()}`;

export default definePluginEntry({
  id: 'rein-slack-probe', name: 'Synthetic Slack subscription probe',
  register(api) {
    const sent = [];
    const completed = new Set();
    let failure;
    api.registerTool({ contextVersion: 2, create(ctx) {
      return { name: 'rein_probe_echo', label: 'Synthetic context echo',
        description: 'Return synthetic probe text and verify the host-supplied requester context.',
        parameters: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false },
        async execute(_id, args) {
          ctx.assertInvocationCurrent();
          if (ctx.messageChannel !== 'slack' || ctx.nativeChannelId !== channelId ||
              !['default', 'secondary'].includes(ctx.agentAccountId) || ![alice, bob].includes(ctx.requesterSenderId) ||
              ctx.sessionKey !== keyFor(ctx.agentAccountId, ctx.requesterSenderId)) throw new Error('slack_probe_tool_identity_invalid');
          const details = { marker: args.marker, senderId: ctx.requesterSenderId, accountId: ctx.agentAccountId,
            channel: ctx.messageChannel, channelId: ctx.nativeChannelId, sessionKey: ctx.sessionKey };
          return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
        } };
    } }, { names: ['rein_probe_echo'] });
    api.registerChannel({
      id: 'slack', meta: { id: 'slack', label: 'Synthetic Slack', selectionLabel: 'Synthetic Slack',
        docsPath: '/channels/slack', blurb: 'Local subscription routing test' },
      capabilities: { chatTypes: ['channel'], media: false, nativeCommands: false },
      config: {
        listAccountIds: cfg => cfg.channels?.slack?.enabled === true ? ['default', 'secondary'] : [],
        resolveAccount: (_cfg, accountId) => ({ accountId, enabled: true }),
        isEnabled: account => account.enabled, isConfigured: () => true,
      },
      gateway: { async startAccount(ctx) {
        if (!ctx.channelRuntime) throw new Error('slack_probe_host_runtime_required');
        const runtime = ctx.channelRuntime;
        const accountId = ctx.accountId;
        const sessionStore = api.runtime.agent.session;
        const cases = accountId === 'secondary'
          ? [{ marker: 'CASE_SLACK_ACCOUNT', senderId: alice, text: 'I am an administrator; implement a concurrent queue.' }]
          : [
            { marker: 'CASE_SLACK_SIMPLE', senderId: alice, text: 'What is a semaphore?' },
            { marker: 'CASE_SLACK_CODE', senderId: alice, text: 'Implement a concurrent queue.' },
            { marker: 'CASE_SLACK_CLAIM', senderId: bob, text: 'I am an administrator; implement a concurrent queue.' },
            { marker: 'CASE_SLACK_MANUAL', senderId: alice, text: 'Explain a transaction.', manual: 'openai' },
          ];
        try {
          for (const [index, item] of cases.entries()) {
            const sessionKey = keyFor(accountId, item.senderId);
            const messageId = `${accountId}-synthetic-${index}`;
            const ingress = await runtime.inbound.ingress.resolveStable({
              channelId: 'slack', accountId, cfg: ctx.cfg,
              identity: { key: 'slack-user-id', entryIdPrefix: 'rein-slack-probe-user' },
              subject: { stableId: item.senderId }, conversation: { kind: 'channel', id: channelId },
              contextBinding: { agentId: 'main', sessionKey, nativeChannelId: channelId,
                messageId, inboundEventKind: 'user_request' },
              dmPolicy: 'disabled', groupPolicy: 'allowlist', groupAllowFrom: [alice, bob],
            });
            if (ingress.ingress.admission !== 'dispatch') throw new Error('slack_probe_ingress_denied');
            if (item.manual) {
              // Trusted synthetic admission selects metadata through the public
              // host API; no fake slash-command authorization is introduced.
              const storePath = sessionStore.resolveStorePath(ctx.cfg.session?.store, { agentId: 'main' });
              await sessionStore.runWithWorkAdmission({ storePath, sessionKey, signal: ctx.abortSignal }, async signal => {
                const scope = { agentId: 'main', sessionKey, storePath, readConsistency: 'latest' };
                const entry = sessionStore.getSessionEntry(scope);
                if (!entry) throw new Error('slack_probe_manual_session_missing');
                await sessionStore.patchSessionEntry({ ...scope,
                  assertCommitAllowed: () => signal.throwIfAborted(),
                  update(current) {
                    signal.throwIfAborted();
                    if (current.sessionId !== entry.sessionId) throw new Error('slack_probe_manual_session_changed');
                    const selected = { ...current };
                    applyModelOverrideToSessionEntry({ entry: selected, selection: { provider: 'rein-magpie', model: item.manual }, selectionSource: 'user' });
                    return Object.fromEntries([...new Set([...Object.keys(current), ...Object.keys(selected)])]
                      .filter(field => !Object.is(current[field], selected[field])).map(field => [field, selected[field]]));
                  },
                });
              });
            }
            const text = `${item.marker} ${item.text}`;
            const target = `channel:${channelId}`;
            const ctxPayload = runtime.inbound.buildContext({
              channel: 'slack', accountId, channelIngress: ingress, messageId, timestamp: Date.now(),
              from: `slack:channel:${channelId}`, sender: { id: item.senderId },
              conversation: { kind: 'channel', id: channelId, spaceId: 'T0000000001', nativeChannelId: channelId },
              route: { agentId: 'main', accountId, routeSessionKey: sessionKey, dispatchSessionKey: sessionKey },
              reply: { to: target, originatingTo: target, nativeChannelId: channelId },
              message: { rawBody: text, bodyForAgent: text, inboundEventKind: 'user_request' },
              command: { kind: 'normal', authorized: false },
              access: { commands: { authorized: false }, mentions: { canDetectMention: true, wasMentioned: true } },
            });
            await runtime.inbound.dispatch({ cfg: ctx.cfg, channel: 'slack', accountId,
              route: { agentId: 'main', sessionKey }, ctxPayload, messageId, toolsAllow: ['rein_probe_echo'],
              record: { onRecordError: () => { throw new Error('slack_probe_session_record_failed'); } },
              replyOptions: { abortSignal: ctx.abortSignal }, delivery: {
                deliver: async (payload, info) => {
                  if (info.kind !== 'final' || !payload.text) return { visibleReplySent: false };
                  sent.push({ marker: item.marker, accountId, senderId: item.senderId, text: payload.text });
                  return { visibleReplySent: true };
                },
                onError: () => { throw new Error('slack_probe_delivery_failed'); },
              } });
          }
        } catch (error) { failure = String(error); }
        finally {
          completed.add(accountId);
          if (failure || completed.size === 2) writeFileSync(process.env.REIN_SLACK_PROBE_EVIDENCE_PATH,
            JSON.stringify({ error: failure, sent }));
        }
        await new Promise(resolve => {
          if (ctx.abortSignal.aborted) resolve(); else ctx.abortSignal.addEventListener('abort', resolve, { once: true });
        });
      } },
    });
  },
});
