import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedReceiver } from '../plugins/rein-discord/inbound.mjs';
import { resolveOwner, sessionKey, assertIsolationRuntime, PUBLIC_TOOLS, PRIVATE_TOOLS } from '../plugins/rein-discord/isolation.mjs';
import { configuredModelRoutes, configuredRouterStatusTool, ROUTE_STATUS_TOOL } from '../plugins/rein-discord/model-selection.mjs';

const ids = { guild: '100000000000000001', room: '100000000000000002',
  alice: '100000000000000003', bob: '100000000000000004', dm: '100000000000000005' };
const discord = { agentId: 'main', botUserId: '100000000000000008', requireMention: false,
  guilds: [{ id: ids.guild, channelIds: [ids.room], userIds: [ids.alice, ids.bob] }],
  dmAllowFrom: [ids.alice, ids.bob] };
const routerConfig = () => ({ plugins: { allow: ['rein-router'], entries: {
  'rein-router': { enabled: true, config: { enabled: true, channels: ['discord', 'slack'],
    routes: [{ id: 'flash' }, { id: 'reasoning' }] } },
} } });

function fixture({ cfg = routerConfig(), admission = 'dispatch' } = {}) {
  let sequence = 10n;
  const controller = new AbortController();
  const generations = new Map();
  const entries = new Map();
  const operations = [];
  const sent = [];
  const dispatched = [];
  const nativeSelections = [];
  const memory = {
    generation: owner => generations.get(owner.key) ?? 0,
    reset(owner) { generations.set(owner.key, this.generation(owner) + 1); },
    forget(owner) { this.reset(owner); },
  };
  const address = p => `${p.agentId ?? 'main'}:${p.sessionKey}`;
  const sessionStore = {
    resolveStorePath(_path, { agentId }) { return `/synthetic/${agentId}/sessions.json`; },
    getSessionEntry(p) { operations.push({ kind: 'read', ...p }); return entries.get(address(p)); },
    async runWithWorkAdmission(p, run) {
      operations.push({ kind: 'work-admission', ...p });
      await sessionStore.onAdmission?.();
      return await run(p.signal);
    },
    async patchSessionEntry(p) {
      operations.push({ kind: 'patch', ...p });
      const existingEntry = entries.get(address(p));
      const patch = await p.update(existingEntry ?? p.fallbackEntry, { existingEntry });
      await sessionStore.onBeforeCommit?.();
      p.assertCommitAllowed();
      const next = { ...(existingEntry ?? p.fallbackEntry), ...patch };
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
      entries.set(address(p), next);
      return next;
    },
    applyModelOverride(p) {
      nativeSelections.push(p.selection);
      p.entry.providerOverride = p.selection.provider;
      p.entry.modelOverride = p.selection.model;
      p.entry.modelOverrideSource = p.selectionSource;
      p.entry.modelOverrideRouteResolution = 'resolved';
    },
  };
  const runtime = { inbound: {
    ingress: { async resolveStable(p) { operations.push({ kind: 'ingress', ...p }); return { ingress: { admission } }; } },
    buildContext: p => p,
    async dispatch(p) { dispatched.push(p); return { dispatched: true }; },
  } };
  const receive = createIsolatedReceiver({ config: discord, cfg, runtime, memory,
    sessionStore, signal: controller.signal, send: async (...args) => sent.push(args) });
  const event = (text = '/model', senderId = ids.alice, overrides = {}) => ({
    id: String(100000000000000000n + sequence++), senderId, guildId: ids.guild,
    channelId: ids.room, kind: 'channel', text, ...overrides,
  });
  const keyFor = event => {
    const owner = resolveOwner(discord, event);
    return sessionKey(owner, memory.generation(owner));
  };
  const entryFor = event => entries.get(`main:${keyFor(event)}`);
  return { cfg, controller, entries, operations, sent, dispatched, nativeSelections,
    sessionStore, memory, receive, event, keyFor, entryFor };
}

test('isolated /model requires explicit loaded router, channel and unambiguous route catalog', async () => {
  const configs = [
    {},
    { plugins: { ...routerConfig().plugins, enabled: false } },
    { plugins: { ...routerConfig().plugins, allow: [] } },
    { plugins: { ...routerConfig().plugins, deny: ['rein-router'] } },
  ];
  for (const mutate of [
    entry => { entry.enabled = false; },
    entry => { entry.config.enabled = false; },
    entry => { entry.config.channels = ['slack']; },
    entry => { entry.config.routes = [{ id: 'auto' }]; },
    entry => { entry.config.routes = [{ id: 'flash' }, { id: 'flash' }]; },
    entry => { entry.config.routes = [{ id: 'attacker/provider' }]; },
  ]) {
    const cfg = routerConfig(); mutate(cfg.plugins.entries['rein-router']); configs.push(cfg);
  }
  for (const cfg of configs) {
    assert.equal(configuredModelRoutes(cfg), null);
    const f = fixture({ cfg });
    assert.deepEqual(await f.receive(f.event('/model flash')), { dispatched: false });
    assert.equal(f.operations.length, 0);
    assert.equal(f.sent.length, 0);
  }
});

test('native ingress authorizes exact sender/session before /model reads or writes', async () => {
  const f = fixture(); const event = f.event('/model flash');
  assert.deepEqual(await f.receive(event), { dispatched: false, handled: true });
  assert.deepEqual(f.operations.map(p => p.kind), ['ingress', 'work-admission', 'read', 'patch']);
  const ingress = f.operations[0]; const patch = f.operations.at(-1);
  assert.equal(ingress.subject.stableId, ids.alice);
  assert.equal(ingress.contextBinding.sessionKey, f.keyFor(event));
  assert.equal(patch.sessionKey, ingress.contextBinding.sessionKey);
  assert.equal(patch.agentId, 'main');
  assert.equal(patch.storePath, '/synthetic/main/sessions.json');
  assert.deepEqual(f.nativeSelections, [{ provider: 'rein-magpie', model: 'flash' }]);
  assert.equal(f.entryFor(event).modelOverrideSource, 'user');
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.sent[0][0], ids.room); assert.equal(f.sent[0][2], event.id);
});

test('denied host ingress and untrusted transport senders cannot select models', async () => {
  const f = fixture({ admission: 'deny' });
  await f.receive(f.event('/model flash'));
  assert.deepEqual(f.operations.map(p => p.kind), ['ingress']);
  assert.equal(f.sent.length, 0); assert.equal(f.entries.size, 0);
  for (const overrides of [{ bot: true }, { webhook: true }, { senderId: '100000000000000099' },
    { guildId: '100000000000000099' }, { channelId: ids.dm }, { guildId: null, kind: 'group' }]) {
    const other = fixture(); await other.receive(other.event('/model flash', ids.alice, overrides));
    assert.equal(other.operations.length, 0); assert.equal(other.sent.length, 0);
  }
});

test('/model reports own selection and catalog without a model run or write', async () => {
  const f = fixture(); const first = f.event('/model reasoning'); await f.receive(first);
  f.sent.length = 0; f.operations.length = 0;
  await f.receive(f.event('/model'));
  assert.deepEqual(f.operations.map(p => p.kind), ['ingress', 'work-admission', 'read']);
  assert.match(f.sent[0][1], /当前模型选择：reasoning/);
  assert.match(f.sent[0][1], /auto、flash、reasoning/);
  assert.ok(!f.sent[0][1].includes(ids.alice));
  assert.equal(f.dispatched.length, 0);
});

test('manual selection and auto sentinel persist for the subsequent native dispatch', async () => {
  const f = fixture(); const first = f.event('/model reasoning'); await f.receive(first);
  await f.receive(f.event('Continue the task.'));
  assert.equal(f.dispatched[0].route.sessionKey, f.keyFor(first));
  assert.equal(f.entryFor(first).modelOverride, 'reasoning');
  await f.receive(f.event('/model auto'));
  assert.equal(f.entryFor(first).modelOverride, 'auto');
  assert.equal(f.entryFor(first).providerOverride, 'rein-magpie');
  assert.equal(f.entryFor(first).modelOverrideSource, 'auto');
  assert.match(f.sent.at(-1)[1], /动态模型路由/);
});

test('same-room senders and a sender public/DM scopes retain independent selections', async () => {
  const f = fixture(); const alice = f.event('/model flash'); const bob = f.event('/model reasoning', ids.bob);
  const dm = f.event('/model auto', ids.alice, { guildId: null, channelId: ids.dm, kind: 'direct' });
  await f.receive(alice); await f.receive(bob); await f.receive(dm);
  assert.equal(f.entries.size, 3);
  assert.equal(f.entryFor(alice).modelOverride, 'flash');
  assert.equal(f.entryFor(bob).modelOverride, 'reasoning');
  assert.equal(f.entryFor(dm).modelOverride, 'auto');
  assert.equal(new Set([...f.entries.values()].map(entry => entry.sessionId)).size, 3);
  assert.equal(f.sent.at(-1)[0], ids.dm);
});

test('reset/new starts default selection in only the originating owner generation', async () => {
  const f = fixture(); const alice = f.event('/model flash'); const bob = f.event('/model reasoning', ids.bob);
  await f.receive(alice); await f.receive(bob); const oldKey = f.keyFor(alice);
  await f.receive(f.event('/reset')); await f.receive(f.event('/model'));
  assert.notEqual(f.keyFor(alice), oldKey); assert.equal(f.entryFor(alice), undefined);
  assert.match(f.sent.at(-1)[1], /使用代理默认配置/);
  assert.equal(f.entryFor(bob).modelOverride, 'reasoning');
  await f.receive(f.event('/model auto')); await f.receive(f.event('/new'));
  assert.equal(f.entryFor(alice), undefined);
});

test('arbitrary provider, billing toggles, extra arguments and other slash commands are rejected', async () => {
  const f = fixture();
  for (const text of ['/model openai/gpt-5', '/model pay-as-you-go', '/model flash bob', '/model FLASH']) {
    await f.receive(f.event(text));
  }
  assert.equal(f.entries.size, 0); assert.equal(f.nativeSelections.length, 0);
  assert.equal(f.dispatched.length, 0); assert.equal(f.sent.length, 4);
  const calls = f.operations.length;
  for (const text of ['/exec run', '/models', '/modelx', '/config set', '/model/flash']) await f.receive(f.event(text));
  assert.equal(f.operations.length, calls); assert.equal(f.sent.length, 4);
});

test('locked native session refuses selection', async () => {
  const f = fixture(); const event = f.event('/model flash');
  f.entries.set(`main:${f.keyFor(event)}`, { sessionId: 'locked', updatedAt: 1, modelSelectionLocked: true });
  await f.receive(event);
  assert.equal(f.entryFor(event).modelOverride, undefined);
  assert.equal(f.operations.some(p => p.kind === 'patch'), false);
  assert.match(f.sent.at(-1)[1], /已锁定/);
});

test('gateway cancellation during host admission prevents writes and acknowledgement', async () => {
  const f = fixture(); f.sessionStore.onAdmission = () => f.controller.abort();
  await assert.rejects(() => f.receive(f.event('/model flash')));
  assert.equal(f.entries.size, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.operations.some(p => p.kind === 'patch'), false);
});

test('owner generation and cancellation are revalidated inside session commit', async () => {
  for (const cancel of [false, true]) {
    const f = fixture(); const event = f.event('/model flash');
    f.sessionStore.onBeforeCommit = () => {
      if (cancel) f.controller.abort(); else f.memory.reset(resolveOwner(discord, event));
    };
    await assert.rejects(() => f.receive(event));
    assert.equal(f.entries.size, 0); assert.equal(f.sent.length, 0);
  }
});

test('session identity changing before the update refuses stale selection', async () => {
  const f = fixture(); const event = f.event('/model flash'); const key = `main:${f.keyFor(event)}`;
  f.entries.set(key, { sessionId: 'original', updatedAt: 1 });
  const read = f.sessionStore.getSessionEntry;
  f.sessionStore.getSessionEntry = p => {
    const captured = read(p); f.entries.set(key, { sessionId: 'replacement', updatedAt: 2 }); return captured;
  };
  await assert.rejects(() => f.receive(event), /session changed/);
  assert.equal(f.entries.get(key).modelOverride, undefined); assert.equal(f.sent.length, 0);
});

test('host persistence failure produces no successful model-selection acknowledgement', async () => {
  const f = fixture(); f.sessionStore.patchSessionEntry = async () => { throw new Error('write failed'); };
  await assert.rejects(() => f.receive(f.event('/model flash')), /write failed/);
  assert.equal(f.entries.size, 0); assert.equal(f.sent.length, 0);
});

test('deduplicated /model input performs one scoped patch', async () => {
  const f = fixture(); const event = f.event('/model flash'); await f.receive(event); await f.receive(event);
  assert.equal(f.operations.filter(p => p.kind === 'patch').length, 1);
  assert.equal(f.sent.length, 1);
});

function isolatedStartup(t, cfg = routerConfig()) {
  const root = mkdtempSync(join(tmpdir(), 'rein-router-status-isolation-'));
  const workspace = join(root, 'public'); mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cfg.plugins ??= {};
  cfg.plugins.entries ??= {};
  cfg.plugins.entries.discord = { enabled: false };
  cfg.memory = { search: { enabled: false, rememberAcrossConversations: false } };
  cfg.agents = { defaults: { skipBootstrap: true, compaction: { memoryFlush: { enabled: false } } } };
  cfg.tools = { allow: [...PUBLIC_TOOLS], fs: { workspaceOnly: true },
    sessions: { visibility: 'self' }, agentToAgent: { enabled: false } };
  const config = { ...discord, tokenEnv: 'REIN_TEST_DISCORD_TOKEN', memoryPath: join(root, 'private/member.sqlite') };
  return { cfg, config, workspace };
}

test('route status remains absent from unchanged public/private defaults and ordinary dispatch', async () => {
  const publicBefore = [...PUBLIC_TOOLS]; const privateBefore = [...PRIVATE_TOOLS];
  assert.ok(!PUBLIC_TOOLS.includes(ROUTE_STATUS_TOOL));
  assert.ok(!PRIVATE_TOOLS.includes(ROUTE_STATUS_TOOL));
  const f = fixture();
  await f.receive(f.event('Which route is answering?'));
  await f.receive(f.event('Which route is answering?', ids.alice, { guildId: null, channelId: ids.dm, kind: 'direct' }));
  assert.equal(configuredRouterStatusTool(f.cfg), false);
  assert.deepEqual(f.dispatched[0].toolsAllow, publicBefore);
  assert.deepEqual(f.dispatched[1].toolsAllow, privateBefore);
  assert.deepEqual(PUBLIC_TOOLS, publicBefore);
  assert.deepEqual(PRIVATE_TOOLS, privateBefore);
});

test('explicit loaded-router status opt-in passes startup and appends once per isolated audience', async t => {
  const { cfg, config, workspace } = isolatedStartup(t);
  cfg.tools.allow.push(ROUTE_STATUS_TOOL, ROUTE_STATUS_TOOL);
  assert.equal(configuredRouterStatusTool(cfg), true);
  assert.doesNotThrow(() => assertIsolationRuntime(cfg, config, workspace));
  const f = fixture({ cfg });
  const alice = f.event('Show my route.'); const bob = f.event('Show my route.', ids.bob);
  const dm = f.event('Show my route.', ids.alice, { guildId: null, channelId: ids.dm, kind: 'direct' });
  await f.receive(alice); await f.receive(bob); await f.receive(dm);
  assert.equal(new Set(f.dispatched.map(call => call.route.sessionKey)).size, 3);
  assert.deepEqual(f.dispatched[0].toolsAllow, [...PUBLIC_TOOLS, ROUTE_STATUS_TOOL]);
  assert.deepEqual(f.dispatched[1].toolsAllow, [...PUBLIC_TOOLS, ROUTE_STATUS_TOOL]);
  assert.deepEqual(f.dispatched[2].toolsAllow, [...PRIVATE_TOOLS, ROUTE_STATUS_TOOL]);
  assert.equal(f.dispatched[2].toolsAllow.includes('rein_member_status'), false);
  assert.equal(f.dispatched[2].toolsAllow.includes('rein_identity_bind_start'), false);
  assert.ok(f.dispatched.every(call => call.toolsAllow.filter(name => name === ROUTE_STATUS_TOOL).length === 1));
  assert.ok(!PUBLIC_TOOLS.includes(ROUTE_STATUS_TOOL));
  assert.ok(!PRIVATE_TOOLS.includes(ROUTE_STATUS_TOOL));
});

test('status name without an enabled Discord router fails startup and never reaches dispatch tools', async t => {
  for (const mutate of [
    cfg => { delete cfg.plugins.entries['rein-router']; },
    cfg => { cfg.plugins.entries['rein-router'].enabled = false; },
    cfg => { cfg.plugins.entries['rein-router'].config.enabled = false; },
    cfg => { cfg.plugins.entries['rein-router'].config.channels = ['slack']; },
    cfg => { cfg.plugins.deny = ['rein-router']; },
    cfg => { cfg.plugins.allow = []; },
    cfg => { cfg.plugins.enabled = false; },
    cfg => { cfg.plugins.entries['rein-router'].config.routes = [{ id: 'auto' }]; },
  ]) {
    const { cfg, config, workspace } = isolatedStartup(t);
    cfg.tools.allow.push(ROUTE_STATUS_TOOL); mutate(cfg);
    assert.equal(configuredRouterStatusTool(cfg), false);
    assert.throws(() => assertIsolationRuntime(cfg, config, workspace), /tool allowlist/);
    const f = fixture({ cfg }); await f.receive(f.event('hello'));
    assert.equal(f.dispatched[0].toolsAllow.includes(ROUTE_STATUS_TOOL), false);
  }
});

test('route status opt-in cannot add wildcard, provider-specific or per-agent tool escapes', t => {
  for (const mutate of [
    cfg => { cfg.tools.allow.push('*'); },
    cfg => { cfg.tools.allow.push('rein_*'); },
    cfg => { cfg.tools.allow.push('exec'); },
    cfg => { cfg.tools.alsoAllow = [ROUTE_STATUS_TOOL]; },
    cfg => { cfg.tools.byProvider = { 'rein-magpie': { allow: ['exec'] } }; },
    cfg => { cfg.agents.defaults.tools = { allow: ['exec'] }; },
    cfg => { cfg.agents.list = [{ id: 'main', tools: { allow: ['exec'] } }]; },
  ]) {
    const { cfg, config, workspace } = isolatedStartup(t);
    cfg.tools.allow.push(ROUTE_STATUS_TOOL); mutate(cfg);
    assert.throws(() => assertIsolationRuntime(cfg, config, workspace));
  }
  const malformed = routerConfig(); malformed.tools = { allow: ROUTE_STATUS_TOOL };
  assert.equal(configuredRouterStatusTool(malformed), false);
});
