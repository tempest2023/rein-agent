import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { root, upstream, environment, requireSource } from './runtime-env.mjs';
import { PUBLIC_TOOLS } from '../plugins/rein-discord/isolation.mjs';
import { buildOpenClawFragment } from '../plugins/rein-router/policy.mjs';
import { createGatewayRequestHeaders, readGatewayHeaderEvidence, readGatewayRouteEvidence } from '../plugins/rein-router/provenance.mjs';
import magpieLock from '../plugins/rein-router/magpie.lock.json' with { type: 'json' };
import { magpieBuildEnvironment } from './magpie-dependency.mjs';

requireSource();
const MAGPIE_REVISION = magpieLock.revision;
const extraArgs = process.argv.slice(2);
if (extraArgs[0] === '--') extraArgs.shift();
assert.ok(extraArgs.length === 0 || (extraArgs.length === 2 && extraArgs[0] === '--magpie-checkout'),
  'Usage: verify-subscriptions.mjs [--magpie-checkout <reviewed-source-directory>]');
const magpieSource = extraArgs.length ? resolve(extraArgs[1]) : undefined;
if (magpieSource) {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: magpieSource, encoding: 'utf8' });
  assert.equal(revision.status, 0, 'Magpie source checkout required');
  assert.equal(revision.stdout.trim(), MAGPIE_REVISION, 'Use the reviewed Magpie revision');
  assert.equal(spawnSync('git', ['diff', '--exit-code', 'HEAD'], { cwd: magpieSource, stdio: 'ignore' }).status, 0,
    'Magpie tracked source must match the reviewed revision');
}
const temp = mkdtempSync(join(tmpdir(), 'rein-subscription-probe-'));
const requests = [];
const decisions = [];
const traces = new Map();
const markerFor = request => {
  const message = request.messages?.findLast(m => m.role === 'user' && /CASE_[A-Z_]+/.test(JSON.stringify(m.content)));
  return JSON.stringify(message?.content)?.match(/CASE_[A-Z_]+/)?.[0];
};
const server = createServer(async (req, res) => {
  if (req.method === 'GET') {
    const session = new URL(req.url, 'http://127.0.0.1').searchParams.get('session');
    if (traces.has(session)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(traces.get(session))); return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); return;
  }
  let body = ''; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  if (req.url === '/v1/systemone') {
    decisions.push(request);
    const coding = request.state.currentRequest.includes('CASE_CODE');
    const choice = (criteria, selected) => ({ type: 'choice', choice: selected, confidence: 0.99,
      probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === selected ? 0.99 : 0.01 / (Object.keys(criteria).length - 1)])) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'jev-fixture', answers: {
      route: choice(request.questions.route.criteria, request.state.currentRequest.includes('CASE_AUTH_FALLBACK') ? 'claude' : 'google'),
      task: choice(request.questions.task.criteria, coding ? 'coding' : 'simple'),
      contextIndependent: { type: 'noul', noul: 0.99 },
    }, usage: { input_tokens: 25, output_tokens: 0 } }));
    return;
  }
  requests.push(request);
  const marker = markerFor(request);
  if (marker === 'CASE_GATEWAY_KEY') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Synthetic gateway credential revoked', type: 'authentication_error' } })); return;
  }
  if (marker === 'CASE_AUTH_FALLBACK' && (request.model.startsWith('fixture/claude') || request.model === 'claude')) {
    const session = req.headers['x-magpie-session'];
    traces.set(session, { session, seq: 1, route: { asked: 'fixture/claude', model: 'fixture/claude',
      done: true, status: 401, tries: [{ model: 'fixture/claude', done: true, status: 401 }] } });
    res.writeHead(401, { 'content-type': 'application/json', 'x-magpie-provider': 'fixture', 'x-magpie-model': 'fixture/claude' });
    res.end(JSON.stringify({ error: { message: 'Synthetic upstream subscription access token expired', type: 'authentication_error' } })); return;
  }
  if (marker === 'CASE_FALLBACK' && (request.model.startsWith('fixture/google') || request.model === 'google')) {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Synthetic included quota exhausted', type: 'insufficient_quota' } }));
    return;
  }
  const lastUser = request.messages.findLastIndex(m => m.role === 'user' && /CASE_[A-Z_]+/.test(JSON.stringify(m.content)));
  const toolResult = request.messages.slice(lastUser + 1).some(m => m.role === 'tool');
  const delta = toolResult ? { role: 'assistant', content: `OK ${marker}` } :
    { role: 'assistant', tool_calls: [{ index: 0, id: `call_${marker}`, type: 'function',
      function: { name: 'tool_call', arguments: JSON.stringify({ id: 'rein_memory_read', args: {} }) } }] };
  res.writeHead(200, { 'content-type': 'text/event-stream', 'x-magpie-provider': 'fixture', 'x-magpie-model': request.model });
  const event = { id: 'synthetic-subscription-probe', object: 'chat.completion.chunk', created: 1,
    model: magpieSource ? `${request.model}-vendor-snapshot` : request.model, choices: [{ index: 0, delta, finish_reason: null }] };
  res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.write(`data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: toolResult ? 'stop' : 'tool_calls' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
let magpieChild;
let magpieOutput = '';
let gatewayBaseUrl = `http://127.0.0.1:${port}/v1`;
let gatewayKey = 'sk-magpie-key-synthetic-local-probe-00000000';
async function stopMagpie() {
  if (!magpieChild || magpieChild.exitCode !== null) return;
  magpieChild.kill('SIGTERM');
  await Promise.race([new Promise(resolve => magpieChild.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  if (magpieChild.exitCode === null) magpieChild.kill('SIGKILL');
}
if (magpieSource) {
  try {
  const helperDir = join(magpieSource, `.rein-probe-${process.pid}`); mkdirSync(helperDir);
  writeFileSync(join(helperDir, 'main.go'), readFileSync(join(root, 'tests/fixtures/magpie-gateway.go')));
  const binary = join(temp, 'magpie-fixture');
  try {
    const built = spawnSync('go', ['build', '-mod=readonly', '-tags', 'nogui', '-o', binary, `./.rein-probe-${process.pid}`], {
      cwd: magpieSource, encoding: 'utf8', timeout: 600000, maxBuffer: 8 * 1024 * 1024,
      env: magpieBuildEnvironment(root),
    });
    assert.equal(built.status, 0, `Could not build isolated Magpie fixture: ${built.stderr}`);
  } finally { rmSync(helperDir, { recursive: true, force: true }); }
  magpieChild = spawn(binary, ['-upstream', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  magpieChild.stdout.on('data', b => { magpieOutput += b; });
  let magpieErrors = '';
  magpieChild.stderr.on('data', b => { magpieErrors += b; });
  const readyUntil = Date.now() + 15000;
  while (!magpieOutput.includes('\n') && magpieChild.exitCode === null && Date.now() < readyUntil) await new Promise(r => setTimeout(r, 50));
  const readyLine = magpieOutput.split('\n').find(line => line.startsWith('REIN_MAGPIE_FIXTURE_READY '));
  assert.ok(readyLine, `Isolated Magpie fixture did not start: ${magpieErrors.slice(-3000)}`);
  const ready = JSON.parse(readyLine.slice('REIN_MAGPIE_FIXTURE_READY '.length));
  gatewayBaseUrl = ready.baseUrl; gatewayKey = ready.apiKey;
  // The actual gateway must restrict its generated key to these four fixtures.
  const models = await fetch(`${gatewayBaseUrl}/models`, { headers: { authorization: `Bearer ${gatewayKey}`, Origin: 'null' },
    signal: AbortSignal.timeout(3000), redirect: 'error' }).then(r => r.json());
  assert.deepEqual(models.data.map(model => model.id).sort(), ['bailian', 'claude', 'google', 'openai'].map(id => `rein-fixture-${id}/${id}`).sort());
  } catch (error) {
    await stopMagpie();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}
const reservation = createSocketServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const gatewayPort = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const publicDir = join(temp, 'public'); mkdirSync(publicDir);
const pluginDir = join(temp, 'fixture'); mkdirSync(pluginDir);
const fixture = readFileSync(join(root, 'tests/fixtures/subscription-router-gateway.ts'), 'utf8')
  .replaceAll('../../plugins/rein-discord/', `${join(root, 'plugins/rein-discord')}/`);
writeFileSync(join(pluginDir, 'index.ts'), fixture);
writeFileSync(join(pluginDir, 'openclaw.plugin.json'), readFileSync(join(root, 'plugins/rein-discord/openclaw.plugin.json')));
writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: '@rein-protocol/subscription-probe-fixture', type: 'module', openclaw: { extensions: ['./index.ts'] } }));
symlinkSync(join(root, 'plugins/rein-discord/node_modules'), join(pluginDir, 'node_modules'));
const router = { enabled: true, gateway: { baseUrl: gatewayBaseUrl, apiKeyEnvVar: 'REIN_SUBSCRIPTION_PROBE_KEY' },
  routes: ['openai', 'claude', 'google', 'bailian'].map(id => ({ id, provider: `Synthetic ${id}`, gatewayModel: magpieSource ? `rein-fixture-${id}/${id}` : `fixture/${id}`,
    billingSource: 'synthetic allowance fixture', billingMode: id === 'bailian' ? 'coding-plan' : 'subscription', billingVerified: true,
    purpose: id === 'google' ? 'Cheap self-contained general queries' : 'Capable research and coding',
    effort: id === 'google' ? 'off' : id === 'claude' ? 'high' : 'medium', contextWindow: 32768, maxTokens: 512 })),
  defaultRoute: 'openai', fallbackRoutes: ['openai'], channels: ['discord', 'slack'],
  adminSenders: [{ channel: 'discord', accountId: 'default', senderId: '100000000000000003' }],
  decision: { allowPaidJev: true, timeoutMs: 5000, maxPromptChars: 16000 } };
const cfg = buildOpenClawFragment(router, join(root, 'plugins/rein-router'));
cfg.gateway = { mode: 'local', bind: 'loopback', port: gatewayPort, auth: { mode: 'token', token: 'synthetic-subscription-probe' } };
Object.assign(cfg.agents.defaults, { workspace: publicDir, skipBootstrap: true, decisionModel: 'typesafe/jev-latest', compaction: { memoryFlush: { enabled: false } } });
cfg.memory = { search: { enabled: false, rememberAcrossConversations: false } };
cfg.tools = { allow: PUBLIC_TOOLS, fs: { workspaceOnly: true }, sessions: { visibility: 'self' }, agentToAgent: { enabled: false } };
cfg.channels = { discord: { enabled: true } };
cfg.plugins.allow.push('rein-discord', 'typesafe', 'openai');
cfg.plugins.load.paths.push(pluginDir, join(upstream, 'extensions/typesafe'));
cfg.plugins.entries.discord = { enabled: false };
cfg.plugins.entries.typesafe = { enabled: true, config: { baseUrl: `http://127.0.0.1:${port}` } };
cfg.plugins.entries['rein-discord'] = { enabled: true, config: { agentId: 'main', botUserId: '100000000000000008', tokenEnv: 'REIN_UNUSED_DISCORD_TOKEN',
  memoryPath: join(temp, 'private/member.sqlite'), requireMention: false,
  guilds: [{ id: '100000000000000001', channelIds: ['100000000000000002'], userIds: ['100000000000000003'] }], dmAllowFrom: [] } };
const configPath = join(temp, 'openclaw.json'); writeFileSync(configPath, JSON.stringify(cfg));
const evidencePath = join(temp, 'evidence.json');
const env = { ...environment(), OPENCLAW_STATE_DIR: join(temp, 'state'), OPENCLAW_CONFIG_PATH: configPath,
  REIN_SUBSCRIPTION_PROBE_KEY: gatewayKey, REIN_ROUTER_EVIDENCE_PATH: evidencePath,
  REIN_ROUTER_ACTUAL_MAGPIE: magpieSource ? '1' : '',
  OPENCLAW_SKIP_CRON: '1', OPENCLAW_SKIP_BUNDLED_DOCTOR: '1' };
// This fixture tests the fallback boundary immediately. Production profiles keep
// their native retry policy; retry.provider is an embedded-session setting.
const agentDir = join(temp, 'state/agents/main/agent'); mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ retry: { provider: { maxRetries: 0 } } }));
let child, output = '';
const stop = signal => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
try {
  const inspected = spawnSync(process.execPath, [join(upstream, 'openclaw.mjs'), 'plugins', 'inspect', 'rein-router', '--runtime', '--json'],
    { cwd: upstream, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
  const report = JSON.parse(inspected.stdout);
  assert.equal(report.plugin.imported, true);
  assert.notEqual(report.plugin.status, 'error', report.plugin.error);
  assert.equal(report.diagnostics.filter(item => item.level === 'error').length, 0);
  child = spawn(process.execPath, [join(upstream, 'openclaw.mjs'), 'gateway', 'run', '--allow-unconfigured'],
    { cwd: upstream, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  let exited = false; child.on('exit', () => { exited = true; });
  const deadline = Date.now() + 150000;
  while (!existsSync(evidencePath) && !exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
  assert.ok(existsSync(evidencePath), `Native router probe incomplete:\n${output.slice(-12000)}`);
  const evidence = JSON.parse(readFileSync(evidencePath));
  assert.ok(!evidence.error, `${evidence.error}\n${output.slice(-12000)}`);
  const expected = { CASE_AUTO: 'fixture/google:none', CASE_CLAUDE: 'fixture/claude:high', CASE_OPENAI: 'fixture/openai:medium',
    CASE_BAILIAN: 'fixture/bailian:medium', CASE_GOOGLE: 'fixture/google:none', CASE_CODE: 'fixture/claude:high' };
  for (const [marker, model] of Object.entries(expected)) {
    const calls = requests.filter(request => markerFor(request) === marker);
    assert.equal(calls.length, 2, `${marker} must execute native tool round trip; ${JSON.stringify(calls.map(c => c.model))}\n${output.slice(-8000)}`);
    const [rawModel, effort] = model.slice('fixture/'.length).split(':');
    assert.ok(calls.every(request => request.model === (magpieSource ? rawModel : model)), `${marker} selected wrong route: ${calls.map(c => c.model)}`);
    if (magpieSource) assert.ok(calls.every(request => request.reasoning_effort === effort), `${marker}: actual Magpie upstream effort disagrees with route`);
    assert.ok(calls[1].messages.some(message => message.role === 'tool'), `${marker} missing actual tool result`);
  }
  assert.equal(decisions.length, magpieSource ? 4 : 5, 'Manual model selection must bypass the real decision runtime');
  const authFallback = requests.filter(request => markerFor(request) === 'CASE_AUTH_FALLBACK');
  assert.equal(authFallback[0]?.model, magpieSource ? 'claude' : 'fixture/claude:high');
  assert.equal(authFallback.at(-1)?.model, magpieSource ? 'openai' : 'fixture/openai:medium', `Upstream auth failure poisoned the shared gateway key:\n${output.slice(-12000)}`);
  assert.ok(evidence.sent.some(entry => entry[1] === 'OK CASE_AUTH_FALLBACK'), 'Upstream authentication fallback did not finish tools');
  const fallback = requests.filter(request => markerFor(request) === 'CASE_FALLBACK');
  assert.ok(fallback.some(request => request.model === (magpieSource ? 'google' : 'fixture/google:none')), 'Quota failure route not attempted');
  assert.equal(fallback.at(-1).model, magpieSource ? 'openai' : 'fixture/openai:medium', `Only explicit fallback may answer; calls=${fallback.map(c => c.model)}\n${output.slice(-15000)}`);
  assert.ok(requests.every(request => (magpieSource ? /^(openai|claude|google|bailian)$/ : /^fixture\/(openai|claude|google|bailian):(none|medium|high)$/).test(request.model)), 'Unknown model or sentinel escaped');
  assert.ok(evidence.sent.some(entry => entry[1] === 'OK CASE_FALLBACK'), 'Fallback did not finish its native tool round trip');
  if (magpieSource) {
    const identity = createGatewayRequestHeaders();
    const response = await fetch(`${gatewayBaseUrl}/chat/completions`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { ...identity.headers, authorization: `Bearer ${gatewayKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'rein-fixture-openai/openai:high', stream: true, messages: [{ role: 'user', content: 'CASE_PROVENANCE synthetic model attribution' }] }) });
    const headerEvidence = readGatewayHeaderEvidence({ status: response.status, headers: Object.fromEntries(response.headers) });
    await response.text();
    const actual = await readGatewayRouteEvidence({ baseUrl: gatewayBaseUrl, gatewayKey, session: identity.session,
      expectedModel: 'rein-fixture-openai/openai', headerEvidence });
    assert.equal(actual?.gatewayMember, 'rein-fixture-openai/openai');
    assert.equal(actual?.vendorServedModel, 'openai-vendor-snapshot', 'Vendor-served snapshot must come from real Magpie trace, not the member header');
    assert.equal(actual?.effort, 'high');
    assert.equal(actual?.evidence, 'gateway-session-route');
    assert.ok(!requests.some(request => request.model === 'payg'), 'Managed Magpie key allowed an excluded paid fallback');
    const refused = await fetch(`${gatewayBaseUrl}/models`, { redirect: 'error', signal: AbortSignal.timeout(3000),
      headers: { authorization: 'Bearer sk-magpie-key-unknown-synthetic-probe-00000000', Origin: 'null' } });
    assert.equal(refused.status, 403, 'Null-origin Magpie request must reject an unknown managed gateway key');
    await refused.body?.cancel();
    const denied = await fetch(`${gatewayBaseUrl}/chat/completions`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
      headers: { authorization: 'Bearer sk-magpie-key-unknown-synthetic-probe-00000000', Origin: 'null', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'rein-fixture-payg/payg', messages: [{ role: 'user', content: 'CASE_REVOKED_KEY' }] }) });
    assert.equal(denied.status, 403, 'Unknown gateway key must stop before any upstream model call');
    await denied.body?.cancel();
    assert.ok(!requests.some(request => request.model === 'payg'), 'Revoked-key request escaped to a paid fallback');
  } else {
    assert.equal(requests.filter(request => markerFor(request) === 'CASE_GATEWAY_KEY').length, 1,
      'A genuine gateway credential failure must stop every route behind that key');
    assert.ok(!evidence.sent.some(entry => entry[1] === 'OK CASE_GATEWAY_KEY'));
  }
  console.log(`Native subscription probe passed${magpieSource ? ' through actual reviewed Magpie gateway' : ''}: real plugin loader, local TypeSafe decision adapter, four synthetic routes with streaming tools, owner-scoped /model, admin coding effort and configured quota fallback. No live providers or paid requests.`);
} finally {
  if (child) { stop('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]); stop('SIGKILL'); }
  await stopMagpie();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}
