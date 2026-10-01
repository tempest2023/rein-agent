import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendRuntime, resolveBackendRuntimeConfig } from '../plugins/rein-operations/backend-runtime.ts';
import { createBackendTransport } from '../plugins/rein-operations/backend-transport.ts';

const BASE = 'https://rein.example.org';
const WORKSPACE = 'T0TEAM';
const SENDER = 'U0SENDER';
const CHANNEL = 'C0BOARD';

function env(overrides = {}) {
  return {
    REIN_BACKEND_URL: BASE,
    REIN_AGENT_CALLER_ID: 'rein-agent',
    REIN_AGENT_CREDENTIAL: 'super-secret-credential',
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    enabled: true,
    platform: 'slack',
    backendApiBaseUrlEnvVar: 'REIN_BACKEND_URL',
    agentCallerIdEnvVar: 'REIN_AGENT_CALLER_ID',
    agentCredentialEnvVar: 'REIN_AGENT_CREDENTIAL',
    workspaces: [
      { platform: 'slack', workspaceId: WORKSPACE, nativeChannelIds: [CHANNEL] },
    ],
    proposalChannelIds: [CHANNEL],
    boardChannelIds: [CHANNEL],
    ...overrides,
  };
}

function recordingFetch(responses) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return {
      ok: next.ok,
      status: next.status,
      async json() {
        return next.raw !== undefined ? next.raw : next.body;
      },
    };
  };
  return { fetchImpl, calls };
}

const relayOk = (assertion = 'opaque-assertion-value') => ({
  ok: true,
  status: 200,
  body: { assertion, expires_at: '2026-09-30T17:05:00Z' },
});

function runtimeWith(responses, { configOverrides = {}, envOverrides = {}, now } = {}) {
  const { fetchImpl, calls } = recordingFetch(responses);
  const runtime = createBackendRuntime({
    config: config(configOverrides),
    env: env(envOverrides),
    transport: createBackendTransport({
      baseUrl: BASE,
      callerId: 'rein-agent',
      credential: 'super-secret-credential',
      fetch: fetchImpl,
    }),
    ...(now ? { now } : {}),
  });
  assert.ok(runtime);
  return { runtime, calls };
}

function trustedContext(overrides = {}) {
  const calls = { current: 0 };
  const ctx = {
    sessionId: 'S0SESSION',
    messageChannel: 'slack',
    nativeChannelId: CHANNEL,
    requesterSenderId: SENDER,
    assertInvocationCurrent() {
      calls.current += 1;
    },
    ...overrides,
  };
  return { ctx, calls };
}

const echoRegistration = (captured) => ({
  contextVersion: 2,
  create(ctx) {
    return [
      {
        name: 'rein_test_probe',
        async execute(_toolCallId, args) {
          captured.push(args);
          return { ok: true, args };
        },
      },
    ];
  },
});

test('the runtime is null while foundationDb is absent or disabled', () => {
  assert.equal(createBackendRuntime({ config: null, env: env() }), null);
  assert.equal(createBackendRuntime({ config: { ...config(), enabled: false }, env: env() }), null);
  assert.equal(resolveBackendRuntimeConfig({ config: { enabled: false }, env: env() }), null);
});

test('an enabled but incomplete block fails loudly instead of registering nothing', () => {
  assert.throws(
    () => createBackendRuntime({ config: config({ workspaces: [] }), env: env() }),
    /workspaces must list at least one/,
  );
  assert.throws(
    () => createBackendRuntime({ config: config({ backendApiBaseUrlEnvVar: 'not a name' }), env: env() }),
    /must name a server environment variable/,
  );
  assert.throws(
    () => createBackendRuntime({ config: config({ agentCredentialEnvVar: undefined }), env: env() }),
    /agentCredentialEnvVar/,
  );
});

test('an unset environment variable fails closed with no request and never echoes the name value', () => {
  assert.throws(
    () => createBackendRuntime({ config: config(), env: env({ REIN_AGENT_CREDENTIAL: '' }) }),
    (error) => {
      assert.ok(!String(error.message).includes('super-secret-credential'));
      assert.match(error.message, /agentCredentialEnvVar/);
      return true;
    },
  );
});

test('a repeated workspace is refused as ambiguous configuration', () => {
  assert.throws(
    () =>
      createBackendRuntime({
        config: config({
          workspaces: [
            { platform: 'slack', workspaceId: WORKSPACE, nativeChannelIds: [CHANNEL] },
            { platform: 'slack', workspaceId: WORKSPACE, nativeChannelIds: [CHANNEL] },
          ],
        }),
        env: env(),
      }),
    /must not repeat/,
  );
});

test('the workspace resolves from the host channel rather than a hardcoded team id', async () => {
  const slack = runtimeWith([relayOk(), { ok: true, status: 200, body: { ok: true } }]);
  const { ctx: slackCtx } = trustedContext();
  const wrappedSlack = slack.runtime.wrapRegistration(echoRegistration([]));
  const [slackTool] = wrappedSlack.create(slackCtx);
  await slackTool.execute('call_1', {});
  assert.equal(slack.calls[0].url, `${BASE}/api/ingress/relay`);
  assert.equal(JSON.parse(slack.calls[0].init.body).platform, 'slack');
  assert.equal(JSON.parse(slack.calls[0].init.body).workspace_id, WORKSPACE);
});

test('a host platform with no enrolled workspace is refused before any backend call', async () => {
  const { runtime, calls } = runtimeWith([relayOk()]);
  const { ctx } = trustedContext({ messageChannel: 'discord' });
  const [tool] = runtime.wrapRegistration(echoRegistration([])).create(ctx);
  await assert.rejects(() => tool.execute('call_1', {}), (error) => {
    assert.equal(error.code, 'workspace_scope_unresolved');
    return true;
  });
  assert.equal(calls.length, 0);
});

test('one deployment admits several enrolled platforms and the trusted channel picks the workspace', async () => {
  const { runtime, calls } = runtimeWith(
    [relayOk(), relayOk(), { ok: true, status: 200, body: { ok: true } }, { ok: true, status: 200, body: { ok: true } }],
    {
      configOverrides: {
        workspaces: [
          { platform: 'slack', workspaceId: WORKSPACE, nativeChannelIds: [CHANNEL] },
          { platform: 'discord', workspaceId: 'G0GUILD', nativeChannelIds: ['D0BOARD'] },
        ],
      },
    },
  );
  const slack = trustedContext();
  const discord = trustedContext({ messageChannel: 'discord', nativeChannelId: 'D0BOARD' });
  const [slackTool] = runtime.wrapRegistration(echoRegistration([])).create(slack.ctx);
  const [discordTool] = runtime.wrapRegistration(echoRegistration([])).create(discord.ctx);
  await slackTool.execute('call_s', {});
  await discordTool.execute('call_d', {});
  const first = JSON.parse(calls[0].init.body);
  const second = JSON.parse(calls[1].init.body);
  assert.equal(first.platform, 'slack');
  assert.equal(first.workspace_id, WORKSPACE);
  assert.equal(first.channel_id, CHANNEL);
  assert.equal(second.platform, 'discord');
  assert.equal(second.workspace_id, 'G0GUILD');
  assert.equal(second.channel_id, 'D0BOARD');
});

test('a native channel enrolled under two workspaces is refused as ambiguous before any backend call', async () => {
  const { runtime, calls } = runtimeWith([relayOk()], {
    configOverrides: {
      workspaces: [
        { platform: 'slack', workspaceId: WORKSPACE, nativeChannelIds: [CHANNEL] },
        { platform: 'slack', workspaceId: 'T0OTHER', nativeChannelIds: [CHANNEL] },
      ],
    },
  });
  const { ctx } = trustedContext();
  const [tool] = runtime.wrapRegistration(echoRegistration([])).create(ctx);
  await assert.rejects(() => tool.execute('call_1', {}), (error) => {
    assert.equal(error.code, 'workspace_scope_unresolved');
    return true;
  });
  assert.equal(calls.length, 0);
});

test('a call without a trusted tool call id fails closed instead of deriving a reusable event id', async () => {
  const { runtime, calls } = runtimeWith([relayOk()]);
  const captured = [];
  const { ctx } = trustedContext();
  const [tool] = runtime.wrapRegistration(echoRegistration(captured)).create(ctx);
  for (const callId of [undefined, null, '', '   ', 42, {}]) {
    await assert.rejects(() => tool.execute(callId, {}), (error) => {
      assert.equal(error.code, 'trusted_call_id_unavailable');
      return true;
    });
  }
  assert.equal(calls.length, 0);
  assert.equal(captured.length, 0);
  assert.deepEqual(runtime.proofProvider(ctx), { ok: false, reason: 'proof_unavailable' });
});

test('the relay carries the exact host tuple with an opaque derived event id and a real timestamp', async () => {
  const { runtime, calls } = runtimeWith([relayOk(), { ok: true, status: 200, body: { ok: true } }]);
  const { ctx } = trustedContext();
  const [tool] = runtime.wrapRegistration(echoRegistration([])).create(ctx);
  await tool.execute('call_abc', {});
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), [
    'channel_id',
    'event_id',
    'event_ts',
    'platform',
    'platform_user_id',
    'workspace_id',
  ]);
  assert.equal(body.platform_user_id, SENDER);
  assert.equal(body.channel_id, CHANNEL);
  assert.match(body.event_id, /^[0-9a-f]{64}$/);
  assert.ok(!body.event_id.includes(SENDER));
  assert.ok(Number.isFinite(Date.parse(body.event_ts)));
  assert.equal(calls[0].init.headers['x-rein-caller-id'], 'rein-agent');
  assert.equal(calls[0].init.headers.authorization, 'Bearer super-secret-credential');
});

test('a distinct tool call id derives a distinct event id on the same host context', async () => {
  const { runtime, calls } = runtimeWith([relayOk(), relayOk(), { ok: true, status: 200, body: { ok: true } }]);
  const { ctx } = trustedContext();
  const [tool] = runtime.wrapRegistration(echoRegistration([])).create(ctx);
  await tool.execute('call_one', {});
  await tool.execute('call_two', {});
  assert.notEqual(
    JSON.parse(calls[0].init.body).event_id,
    JSON.parse(calls[1].init.body).event_id,
  );
});

test('the proof reaches the tool through the provider and is cleared once the call ends', async () => {
  const { runtime } = runtimeWith([relayOk('assertion-for-this-call'), { ok: true, status: 200, body: { ok: true } }]);
  const { ctx } = trustedContext();
  const seen = [];
  const registration = {
    contextVersion: 2,
    create(context) {
      return [
        {
          name: 'rein_test_probe',
          async execute() {
            seen.push(runtime.proofProvider(context));
            return { ok: true };
          },
        },
      ];
    },
  };
  const [tool] = runtime.wrapRegistration(registration).create(ctx);
  await tool.execute('call_1', {});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ok, true);
  assert.deepEqual(seen[0].proof, { kind: 'assertion', assertion: 'assertion-for-this-call' });
  assert.deepEqual(runtime.proofProvider(ctx), { ok: false, reason: 'proof_unavailable' });
});

test('a model-supplied actor field never becomes the relay actor', async () => {
  const { runtime, calls } = runtimeWith([relayOk(), { ok: true, status: 200, body: { ok: true } }]);
  const { ctx } = trustedContext();
  const [tool] = runtime.wrapRegistration(echoRegistration([])).create(ctx);
  await tool.execute('call_1', {
    requesterSenderId: 'U0ATTACKER',
    senderId: 'U0ATTACKER',
    platform_user_id: 'U0ATTACKER',
    workspace_id: 'T0ATTACKER',
    channel_id: 'C0ATTACKER',
    proof: { kind: 'assertion', assertion: 'forged' },
  });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.platform_user_id, SENDER);
  assert.equal(body.workspace_id, WORKSPACE);
  assert.equal(body.channel_id, CHANNEL);
  assert.ok(!JSON.stringify(calls[0].init.body).includes('U0ATTACKER'));
  assert.ok(!JSON.stringify(calls[0].init.body).includes('forged'));
});

test('a channel outside the configured workspaces is refused before any backend call', async () => {
  const { runtime, calls } = runtimeWith([relayOk()]);
  const { ctx } = trustedContext({ nativeChannelId: 'C0PUBLIC' });
  const [tool] = runtime.wrapRegistration(echoRegistration([])).create(ctx);
  await assert.rejects(() => tool.execute('call_1', {}), (error) => {
    assert.equal(error.code, 'workspace_scope_unresolved');
    return true;
  });
  assert.equal(calls.length, 0);
});

test('a context without a trusted sender or channel is refused before any backend call', async () => {
  const missingSender = runtimeWith([relayOk()]);
  const { ctx: noSender } = trustedContext({ requesterSenderId: '   ' });
  const [senderTool] = missingSender.runtime.wrapRegistration(echoRegistration([])).create(noSender);
  await assert.rejects(() => senderTool.execute('call_1', {}), /trusted platform, channel, sender and session/);
  assert.equal(missingSender.calls.length, 0);

  const missingChannel = runtimeWith([relayOk()]);
  const { ctx: noChannel } = trustedContext({ nativeChannelId: undefined });
  const [channelTool] = missingChannel.runtime.wrapRegistration(echoRegistration([])).create(noChannel);
  await assert.rejects(() => channelTool.execute('call_1', {}), /trusted platform, channel, sender and session/);
  assert.equal(missingChannel.calls.length, 0);

  const missingPlatform = runtimeWith([relayOk()]);
  const { ctx: noPlatform } = trustedContext({ messageChannel: undefined });
  const [platformTool] = missingPlatform.runtime.wrapRegistration(echoRegistration([])).create(noPlatform);
  await assert.rejects(() => platformTool.execute('call_1', {}), /trusted platform, channel, sender and session/);
  assert.equal(missingPlatform.calls.length, 0);

  const missingSession = runtimeWith([relayOk()]);
  const { ctx: noSession } = trustedContext({ sessionId: undefined });
  const [sessionTool] = missingSession.runtime.wrapRegistration(echoRegistration([])).create(noSession);
  await assert.rejects(() => sessionTool.execute('call_1', {}), /trusted platform, channel, sender and session/);
  assert.equal(missingSession.calls.length, 0);
});

test('a context without a current-invocation guard is refused before any backend call', async () => {
  const { runtime, calls } = runtimeWith([relayOk()]);
  const { ctx } = trustedContext({ assertInvocationCurrent: undefined });
  const [tool] = runtime.wrapRegistration(echoRegistration([])).create(ctx);
  await assert.rejects(() => tool.execute('call_1', {}), (error) => {
    assert.equal(error.code, 'current_invocation_guard_unavailable');
    return true;
  });
  assert.equal(calls.length, 0);
});

test('a revoked or stale invocation is refused before the relay and again before the original execute', async () => {
  const { runtime, calls } = runtimeWith([relayOk(), { ok: true, status: 200, body: { ok: true } }]);
  let guardCount = 0;
  const captured = [];
  const { ctx } = trustedContext({
    assertInvocationCurrent() {
      guardCount += 1;
      if (guardCount > 1) throw new Error('invocation is no longer current');
    },
  });
  const [tool] = runtime.wrapRegistration(echoRegistration(captured)).create(ctx);
  await assert.rejects(() => tool.execute('call_1', {}), /no longer current/);
  assert.equal(calls.length, 1);
  assert.equal(captured.length, 0);
  assert.deepEqual(runtime.proofProvider(ctx), { ok: false, reason: 'proof_unavailable' });
});

test('a refused ingress relay fails the call closed and leaves no proof behind', async () => {
  const { runtime } = runtimeWith([{ ok: false, status: 403, body: {} }]);
  const captured = [];
  const { ctx } = trustedContext();
  const [tool] = runtime.wrapRegistration(echoRegistration(captured)).create(ctx);
  await assert.rejects(() => tool.execute('call_1', {}), (error) => {
    assert.equal(error.code, 'proof_unavailable');
    return true;
  });
  assert.equal(captured.length, 0);
  assert.deepEqual(runtime.proofProvider(ctx), { ok: false, reason: 'proof_unavailable' });
});

test('a malformed relay body fails closed instead of carrying a broken proof', async () => {
  const { runtime } = runtimeWith([{ ok: true, status: 200, body: { assertion: '' } }]);
  const { ctx } = trustedContext();
  const [tool] = runtime.wrapRegistration(echoRegistration([])).create(ctx);
  await assert.rejects(() => tool.execute('call_1', {}), (error) => {
    assert.equal(error.code, 'proof_unavailable');
    return true;
  });
});

test('two concurrent tool calls on one host context fail closed rather than sharing a proof', async () => {
  let releaseRelay;
  const gate = new Promise((resolve) => {
    releaseRelay = resolve;
  });
  let relayCount = 0;
  const fetchImpl = async (url) => {
    relayCount += 1;
    await gate;
    return { ok: true, status: 200, json: async () => ({ assertion: 'assertion-1', expires_at: 'x' }) };
  };
  const runtime = createBackendRuntime({
    config: config(),
    env: env(),
    transport: createBackendTransport({
      baseUrl: BASE,
      callerId: 'rein-agent',
      credential: 'super-secret-credential',
      fetch: fetchImpl,
    }),
  });
  assert.ok(runtime);
  const { ctx } = trustedContext();
  const [tool] = runtime.wrapRegistration(echoRegistration([])).create(ctx);
  const first = tool.execute('call_one', {});
  const second = tool.execute('call_two', {});
  releaseRelay();
  const results = await Promise.allSettled([first, second]);
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'proof_in_flight');
  assert.equal(relayCount, 1);
});

test('the wrapped registration keeps the host call shape, including Tool Search inner call ids', async () => {
  const { runtime, calls } = runtimeWith([relayOk(), relayOk(), relayOk(), relayOk()]);
  const { ctx } = trustedContext();
  const captured = [];
  const [tool] = runtime.wrapRegistration(echoRegistration(captured)).create(ctx);
  const innerIds = [
    'tool_search_code:call_outer:rein_test_probe:1',
    'tool_search_code:call_outer:rein_test_probe:2',
  ];
  for (const id of innerIds) {
    await tool.execute(id, { inner: id });
  }
  assert.deepEqual(captured, [{ inner: innerIds[0] }, { inner: innerIds[1] }]);
  assert.equal(JSON.parse(calls[0].init.body).event_id === JSON.parse(calls[1].init.body).event_id, false);
  assert.equal(calls[0].url, `${BASE}/api/ingress/relay`);
});

test('a registration that returns no tools is left alone', () => {
  const { runtime } = runtimeWith([]);
  const registration = { contextVersion: 2, create: () => null };
  const wrapped = runtime.wrapRegistration(registration);
  assert.equal(wrapped.create({}), null);
});

test('a proof is never present in the result the model sees', async () => {
  const { runtime } = runtimeWith([
    relayOk('assertion-must-not-leak'),
    { ok: true, status: 200, body: { ok: true } },
  ]);
  const { ctx } = trustedContext();
  const allocation = {
    contextVersion: 2,
    create() {
      return [
        {
          name: 'rein_test_probe',
          async execute() {
            return { ok: true, note: 'operation complete' };
          },
        },
      ];
    },
  };
  const [tool] = runtime.wrapRegistration(allocation).create(ctx);
  const result = await tool.execute('call_1', {});
  assert.ok(!JSON.stringify(result).includes('assertion-must-not-leak'));
});
