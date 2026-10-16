import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection, createServer as createSocketServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { root as defaultRoot, upstream, requireSource } from './runtime-env.mjs';
import { magpiePaths, verifyMagpieInstallation } from './magpie-dependency.mjs';
import { acquireManagedProfileLock } from '../plugins/rein-router/managed-gateway.mjs';
import { stopOwnedProcessTree } from '../plugins/rein-router/process-tree.mjs';
import { buildOpenClawFragment, validateRouterConfig } from '../plugins/rein-router/policy.mjs';
import { readGatewayRouteEvidence } from '../plugins/rein-router/provenance.mjs';
import { profileDigest } from '../tests/fixtures/bailian-owner-runtime.mjs';

const PROVIDER = 'bailian-token-plan', MODEL = 'qwen3.8-flash', MEMBER = `${PROVIDER}/${MODEL}`;
const HOST = 'token-plan.cn-beijing.maas.aliyuncs.com';
const CHAT = `https://${HOST}/compatible-mode/v1`, ANTHROPIC = `https://${HOST}/apps/anthropic`;
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const refuse = reason => { const error = new Error(`bailian_probe_${reason}`); error.code = error.message; throw error; };

function privateText(root, path, { privateMode = true } = {}) {
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) refuse('profile_path_invalid');
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part); const stat = lstatSync(current);
    if (stat.isSymbolicLink()) refuse('profile_symlink_refused');
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024 ||
        (privateMode && process.platform !== 'win32' && (stat.mode & 0o077))) refuse('profile_file_invalid');
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd));
  } finally { closeSync(fd); }
}

async function preparedProfile(projectRoot, environment) {
  try {
    const root = realpathSync(projectRoot), paths = magpiePaths(root);
    const release = await acquireManagedProfileLock(paths.homeDir);
    try {
      const routerPath = join(root, 'runtime/magpie/router.local.json');
      const router = validateRouterConfig(JSON.parse(privateText(root, routerPath)));
      if (router.allowPaidUsage || router.gateway?.subscriptionOnly !== true ||
          router.decision.allowPaidJev || router.gateway.managed?.binaryPath !== paths.binary ||
          router.gateway.managed?.homeDir !== paths.homeDir || router.gateway.managed.allowSubscriptionAccounts)
        refuse('managed_profile_required');
      const route = router.routes.find(candidate => candidate.gatewayModel === MEMBER);
      if (!route || route.billingMode !== 'subscription') refuse('subscription_route_required');
      const providerPath = join(root, 'runtime/magpie/config/magpie/providers.json');
      const stored = JSON.parse(privateText(root, providerPath));
      const providers = stored?.providers;
      const entries = Array.isArray(providers) && providers.filter(provider => provider?.id === PROVIDER);
      if (!entries || entries.length !== 1) refuse('imported_provider_required');
      const provider = entries[0];
      const fields = ['id', 'name', 'preset', 'key', 'chat', 'anthropic', 'models', 'contexts', 'maxConcurrency',
        'icon', 'catalog', 'website', 'keysURL'];
      if (Object.keys(provider).some(field => !fields.includes(field)) || provider.preset !== PROVIDER ||
          provider.chat !== CHAT || provider.anthropic !== ANTHROPIC ||
          !Array.isArray(provider.models) || !provider.models.includes(MODEL) ||
          typeof provider.key !== 'string' || !/^sk-sp-[!-~]{8,240}$/.test(provider.key)) refuse('imported_provider_invalid');
      const source = JSON.parse(privateText(root, join(root, 'runtime/openclaw/openclaw.json'), { privateMode: false }))
        ?.models?.providers?.[PROVIDER];
      if (!object(source) || !((source.api === 'anthropic-messages' && source.baseUrl === ANTHROPIC) ||
          (source.api === 'openai-completions' && source.baseUrl === CHAT)) || source.apiKey?.source !== 'env' ||
          source.apiKey?.provider !== 'default' || source.apiKey?.id !== 'BAILIAN_TOKEN_PLAN_API_KEY') refuse('source_provider_invalid');
      const sourceKey = environment.BAILIAN_TOKEN_PLAN_API_KEY ?? parseEnv(privateText(root,
        join(root, 'runtime/openclaw/.env'))).BAILIAN_TOKEN_PLAN_API_KEY;
      if (sourceKey !== provider.key) refuse('source_key_mismatch');
      const envPath = join(root, 'runtime/magpie/gateway.env'), keyPath = join(root, 'runtime/magpie/config/magpie/caller-keys.json');
      const envText = privateText(root, envPath), env = parseEnv(envText), name = router.gateway.apiKeyEnvVar;
      const lines = envText.split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith('#'));
      const gatewayKey = env[name];
      if (Object.keys(env).length !== 1 || Object.keys(env)[0] !== name || lines.length !== 1 ||
          !new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(lines[0]) ||
          typeof gatewayKey !== 'string' || !/^sk-magpie-key-[A-Za-z0-9_-]{16,240}$/.test(gatewayKey) ||
          (environment[name] !== undefined && environment[name] !== gatewayKey)) refuse('gateway_environment_invalid');
      const keys = JSON.parse(privateText(root, keyPath));
      const matches = Array.isArray(keys) && keys.filter(entry => entry?.secret === gatewayKey);
      if (!matches || matches.length !== 1 || matches[0].off === true || matches[0].lan === true ||
          !Array.isArray(matches[0].models) || matches[0].models.length !== 1 || matches[0].models[0] !== MEMBER)
        refuse('exact_gateway_scope_required');
      const profilePaths = [providerPath, keyPath, envPath, routerPath];
      return { root, paths, router, gatewayKey, profilePaths, digest: profileDigest(profilePaths), summary: {
        provider: PROVIDER, model: MODEL, configuredEndpoints: [CHAT, ANTHROPIC],
        credentialEvidence: 'existing-env-secret-matches-private-import-and-exact-managed-key-scope',
        configuredRouterEnabled: router.enabled, configuredBillingAttestation: route.billingVerified,
        prepaidAddonDeclarationRequired: true,
        maxTokens: 256, thinking: 'off', fallback: false, jev: false,
      } };
    } finally { await release(); }
  } catch (error) {
    if (/^bailian_probe_[a-z_]+$/.test(error?.code ?? '')) throw error;
    refuse('profile_unavailable');
  }
}

function closeOf(child, timeout) {
  return new Promise(resolveClose => {
    const done = closed => { clearTimeout(timer); child.off('close', onClose); resolveClose(closed); };
    const onClose = () => done(true), timer = setTimeout(() => done(false), timeout);
    child.once('close', onClose);
  });
}
async function vacantPort() {
  const server = createSocketServer(); await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port; await new Promise(resolveClose => server.close(resolveClose)); return port;
}

async function gatewayPortOpen(baseUrl) {
  const url = new URL(baseUrl);
  return new Promise(resolveOpen => {
    const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) });
    const done = open => { socket.destroy(); resolveOpen(open); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(250, () => done(true));
  });
}

// The synthetic option is only a programmatic test seam; the CLI exposes no endpoint override.
export async function runNativeBailianOwnerProbe(profile, prepaidAddons, { synthetic = false } = {}) {
  requireSource(); await verifyMagpieInstallation({ root: profile.root, binaryPath: profile.paths.binary });
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'rein-bailian-owner-probe-')));
  let child, proxy, stopped = false, interrupted = false, upstreamConnections = 0, failedProbe = false;
  const sockets = new Set(), onInterrupt = () => { interrupted = true; };
  process.once('SIGTERM', onInterrupt); process.once('SIGINT', onInterrupt);
  try {
    // Permit only TLS to the exact Token Plan host; never forward a general API or channel connection.
    proxy = createServer((request, response) => { request.resume(); response.writeHead(403); response.end(); });
    proxy.on('connect', (request, socket, head) => {
      if (synthetic || request.url !== `${HOST}:443`) { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
      const remote = createConnection({ host: HOST, port: 443 }); sockets.add(socket); sockets.add(remote);
      const close = () => { socket.destroy(); remote.destroy(); sockets.delete(socket); sockets.delete(remote); };
      socket.on('error', close); remote.on('error', close); socket.on('close', close); remote.on('close', close);
      socket.setTimeout(45000, close); remote.setTimeout(45000, close);
      remote.once('connect', () => { upstreamConnections++; socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) remote.write(head); socket.pipe(remote); remote.pipe(socket); });
    });
    await new Promise(resolveListen => proxy.listen(0, '127.0.0.1', resolveListen));
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
    const fixture = join(temp, 'fixture'), workspace = join(temp, 'workspace'), state = join(temp, 'state'), home = join(temp, 'home');
    for (const path of [fixture, workspace, state, home, join(temp, 'tmp')]) mkdirSync(path, { recursive: true, mode: 0o700 });
    const index = `import production from ${JSON.stringify(join(profile.root, 'plugins/rein-router/index.ts'))};\n` +
      `import { registerOwnerProbe } from ${JSON.stringify(join(profile.root, 'tests/fixtures/bailian-owner-runtime.mjs'))};\n` +
      `export default { ...production, register(api) { registerOwnerProbe(api, { production, evidencePath: process.env.REIN_BAILIAN_EVIDENCE_PATH, profilePaths: JSON.parse(process.env.REIN_BAILIAN_PROFILE_PATHS), expectedDigest: process.env.REIN_BAILIAN_PROFILE_DIGEST }); } };\n`;
    writeFileSync(join(fixture, 'index.ts'), index, { mode: 0o600 });
    const manifest = JSON.parse(readFileSync(join(profile.root, 'plugins/rein-router/openclaw.plugin.json'), 'utf8'));
    manifest.channels = ['slack']; manifest.channelConfigs = { slack: { label: 'Local integration probe', schema: {
      type: 'object', properties: { enabled: { type: 'boolean' } }, additionalProperties: false } } };
    manifest.contracts.tools.push('rein_probe_echo');
    writeFileSync(join(fixture, 'openclaw.plugin.json'), JSON.stringify(manifest), { mode: 0o600 });
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: '@rein-protocol/bailian-owner-probe', version: '0.1.0',
      type: 'module', openclaw: { extensions: ['./index.ts'] } }), { mode: 0o600 });
    symlinkSync(join(profile.root, 'plugins/rein-router/node_modules'), join(fixture, 'node_modules'));
    const route = { id: 'bailian-flash', provider: 'Bailian Token Plan China', gatewayModel: MEMBER,
      billingSource: 'Existing China Token Plan; operator-declared prepaid add-on policy', billingMode: 'subscription',
      billingVerified: true, purpose: 'One local integration acceptance check', effort: 'off', contextWindow: 32768, maxTokens: 256 };
    const cfg = buildOpenClawFragment({ enabled: true, gateway: profile.router.gateway, routes: [route],
      defaultRoute: route.id, fallbackRoutes: [], allowPaidUsage: false, channels: ['slack'], decision: { allowPaidJev: false } }, fixture);
    cfg.models.catalogRefresh = { enabled: false };
    cfg.gateway = { mode: 'local', bind: 'loopback', port: await vacantPort(), auth: { mode: 'token', token: randomBytes(24).toString('hex') } };
    Object.assign(cfg.agents.defaults, { workspace, skipBootstrap: true, timeoutSeconds: 45,
      model: { primary: 'rein-magpie/bailian-flash', fallbacks: [] }, compaction: { memoryFlush: { enabled: false } } });
    cfg.memory = { search: { enabled: false, rememberAcrossConversations: false } };
    cfg.tools = { allow: ['rein_probe_echo'], fs: { workspaceOnly: true }, sessions: { visibility: 'self' }, agentToAgent: { enabled: false } };
    cfg.channels = { slack: { enabled: true } }; cfg.plugins.allow.push('openai');
    cfg.plugins.entries.slack = { enabled: false }; cfg.plugins.entries.discord = { enabled: false };
    const configPath = join(temp, 'openclaw.json'), evidencePath = join(temp, 'evidence.json');
    writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });
    const agentDir = join(state, 'agents/main/agent'); mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ retry: { provider: { maxRetries: 0 } } }), { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:PATH|LANG|LC_[A-Z_]+|TZ|SYSTEMROOT|COMSPEC|PATHEXT)$/.test(name)));
    Object.assign(env, { PATH: `${join(profile.root, '.toolchain/node_modules/.bin')}${delimiter}${env.PATH ?? ''}`,
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(temp, 'config'), XDG_CACHE_HOME: join(temp, 'cache'),
      XDG_DATA_HOME: join(temp, 'data'), XDG_STATE_HOME: join(temp, 'state'), TMPDIR: join(temp, 'tmp'),
      CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), GEMINI_CLI_HOME: join(home, '.gemini'),
      OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_SKIP_CRON: '1', OPENCLAW_SKIP_BUNDLED_DOCTOR: '1',
      REIN_BAILIAN_EVIDENCE_PATH: evidencePath, REIN_BAILIAN_PROFILE_PATHS: JSON.stringify(profile.profilePaths),
      REIN_BAILIAN_PROFILE_DIGEST: profile.digest, [profile.router.gateway.apiKeyEnvVar]: profile.gatewayKey,
      NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl,
      http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl,
      NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' });
    const outputPath = join(temp, 'native-output.log'); writeFileSync(outputPath, '', { mode: 0o600 });
    let output = ''; const capture = bytes => { if (output.length < 1024 * 1024) {
      output += bytes.toString(); writeFileSync(outputPath, output, { mode: 0o600 });
    } };
    child = spawn(process.execPath, [join(upstream, 'openclaw.mjs'), 'gateway', 'run', '--allow-unconfigured'],
      { cwd: temp, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', capture); child.stderr.on('data', capture); let failed = false; child.once('error', () => { failed = true; });
    const deadline = Date.now() + 150000; let nativeReady = false;
    while (!interrupted && !failed && (!existsSync(evidencePath) || !nativeReady) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${cfg.gateway.port}/readyz`, { signal: AbortSignal.timeout(500) });
        if (response.ok) nativeReady = (await response.json()).ready === true;
      } catch { /* Native startup remains bounded above. */ }
      if (!existsSync(evidencePath) || !nativeReady) await wait(250);
    }
    if (interrupted) refuse('interrupted');
    if (!existsSync(evidencePath) || !nativeReady) refuse('native_turn_incomplete');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    if (evidence.error || evidence.toolCalls !== 1 || !evidence.finalReply || evidence.calls?.length !== 2 || (!synthetic && !upstreamConnections) ||
        evidence.terminal?.success !== true || evidence.terminal.stopReason !== 'stop' || evidence.usageEvents < 1 ||
        !Number.isSafeInteger(evidence.usage?.input) || !Number.isSafeInteger(evidence.usage?.output))
      refuse('native_tool_roundtrip_failed');
    const routes = [];
    for (const call of evidence.calls) {
      const found = await readGatewayRouteEvidence({ baseUrl: profile.router.gateway.baseUrl, gatewayKey: profile.gatewayKey,
        session: call.session, expectedModel: MEMBER, headerEvidence: call.headers });
      if (found?.provider !== PROVIDER || found.gatewayMember !== MEMBER || found.evidence !== 'gateway-session-route')
        refuse('upstream_evidence_missing');
      if (!(found.vendorServedModel === MODEL || found.vendorServedModel?.startsWith(`${MODEL}-`)) ||
          !['none', 'off'].includes(found.effort)) refuse('upstream_model_or_effort_mismatch');
      routes.push(found);
    }
    const closed = closeOf(child, 15000); child.kill('SIGTERM'); if (!await closed) refuse('native_shutdown_timeout'); stopped = true;
    if (existsSync(join(dirname(profile.paths.homeDir), '.rein-magpie.lock')) || await gatewayPortOpen(profile.router.gateway.baseUrl))
      refuse('profile_cleanup_required');
    return { mode: synthetic ? 'synthetic' : 'live', provider: PROVIDER, requestedModel: MODEL,
      vendorServedModels: [...new Set(routes.map(route => route.vendorServedModel))],
      configuredEndpoints: synthetic ? ['loopback-fixture'] : [CHAT, ANTHROPIC],
      upstreamHostEvidence: synthetic ? 'loopback-fixture' : 'exact-token-plan-tls-host',
      effort: routes.map(route => route.effort), tool: { name: 'rein_probe_echo', executions: 1, nativeContinuation: true },
      modelCalls: 2, usage: evidence.usage, prepaidAddons,
      billingEvidence: 'configured-plan-key-and-endpoints; reconcile-provider-subscription-ledger' };
  } catch (error) {
    failedProbe = true;
    writeFileSync(join(temp, 'diagnostic.json'), JSON.stringify({ error: /^bailian_probe_[a-z_]+$/.test(error?.code ?? '')
      ? error.code : 'bailian_probe_failed' }), { mode: 0o600 });
    throw error;
  } finally {
    let cleanupUncertain = false;
    if (child && !stopped && child.exitCode === null && child.signalCode === null) {
      const closed = closeOf(child, 15000); child.kill('SIGTERM');
      if (!await closed) await stopOwnedProcessTree(child).catch(() => { cleanupUncertain = true; });
    }
    for (const socket of sockets) socket.destroy();
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolveClose => proxy.close(resolveClose)); }
    if (child && (existsSync(join(dirname(profile.paths.homeDir), '.rein-magpie.lock')) ||
        await gatewayPortOpen(profile.router.gateway.baseUrl))) cleanupUncertain = true;
    if (!cleanupUncertain && !failedProbe) rmSync(temp, { recursive: true, force: true });
    process.off('SIGTERM', onInterrupt); process.off('SIGINT', onInterrupt);
    if (cleanupUncertain) refuse('owned_cleanup_required');
  }
}

/** Dry-run reads local metadata only. Live execution always needs an explicit add-on declaration. */
export async function verifyBailianSubscription({ projectRoot = defaultRoot, environment = process.env,
  live = false, prepaidAddons, nativeRunner = runNativeBailianOwnerProbe } = {}) {
  try {
    if (typeof live !== 'boolean' || typeof nativeRunner !== 'function' ||
        (prepaidAddons !== undefined && !['absent', 'acknowledged'].includes(prepaidAddons))) refuse('arguments_invalid');
    if (live && !['absent', 'acknowledged'].includes(prepaidAddons)) refuse('prepaid_addon_declaration_required');
    const profile = await preparedProfile(projectRoot, environment);
    if (!live) return { mode: 'dry-run', ...profile.summary, inferenceRequests: 0 };
    return await nativeRunner(profile, prepaidAddons);
  } catch (error) {
    if (/^bailian_probe_[a-z_]+$/.test(error?.code ?? '')) throw error;
    refuse('failed');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2).filter(argument => argument !== '--');
    const live = args.includes('--live');
    const declarations = args.filter(argument => argument.startsWith('--prepaid-addons='));
    if (args.some(argument => argument !== '--live' && !argument.startsWith('--prepaid-addons=')) ||
        args.filter(argument => argument === '--live').length > 1 || declarations.length > 1) refuse('arguments_invalid');
    const prepaidAddons = declarations[0]?.slice('--prepaid-addons='.length);
    console.log(JSON.stringify(await verifyBailianSubscription({ live, prepaidAddons })));
  } catch (error) {
    console.error(/^bailian_probe_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'bailian_probe_failed');
    process.exitCode = 1;
  }
}
