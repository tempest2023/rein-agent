import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGatewayCredentialEnvironmentName } from '../plugins/rein-router/policy.mjs';
import { stopOwnedProcessTree } from '../plugins/rein-router/process-tree.mjs';
import { datasetDigest, loadEvaluationDataset, readEvaluationJson } from './subscription-routing-evaluation.mjs';
import { writeEvaluationReport } from './evaluate-subscription-routing.mjs';
import { root, upstream, requireSource } from './runtime-env.mjs';

const PLUGIN_ID = 'rein-routing-evaluation';
const fail = () => { throw new Error('subscription_hosted_evaluation_invalid'); };

export function parseHostedEvaluationArguments(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--allow-paid-jev') {
      if (parsed.allowPaidJev) fail(); parsed.allowPaidJev = true; continue;
    }
    const key = { '--openclaw-config': 'configPath', '--dataset': 'datasetPath', '--output': 'outputPath', '--max-calls': 'maxCalls' }[args[i]];
    if (!key || parsed[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) fail();
    parsed[key] = key === 'maxCalls' ? Number(args[++i]) : resolve(args[++i]);
  }
  if (!parsed.allowPaidJev || !parsed.configPath || !parsed.outputPath ||
      !Number.isSafeInteger(parsed.maxCalls) || parsed.maxCalls < 1 || parsed.maxCalls > 256) fail();
  return parsed;
}

/** Copy only an explicitly enabled hosted role and env SecretRef; never resolve credentials here. */
export function hostedEvaluationSettings(config, environment, { allowPaidJev, maxCalls }, dataset) {
  const plugin = config?.plugins?.entries?.typesafe;
  const key = plugin?.config?.apiKey;
  const model = config?.agents?.defaults?.decisionModel;
  if (!allowPaidJev || config?.plugins?.enabled === false || !config?.plugins?.allow?.includes('typesafe') ||
      config?.plugins?.deny?.includes('typesafe') ||
      plugin?.enabled !== true || !/^typesafe\/jev-[A-Za-z0-9.-]+$/.test(model ?? '') ||
      !plugin.config || Object.keys(plugin.config).some(name => !['apiKey', 'timeoutMs'].includes(name)) ||
      !key || Object.keys(key).sort().join(',') !== 'id,provider,source' || key.source !== 'env' || key.provider !== 'default' ||
      !isGatewayCredentialEnvironmentName(key.id) || key.id.startsWith('REIN_EVALUATION_') ||
      typeof environment[key.id] !== 'string' || !environment[key.id].trim() ||
      (plugin.config.timeoutMs !== undefined && (!Number.isSafeInteger(plugin.config.timeoutMs) ||
        plugin.config.timeoutMs < 1000 || plugin.config.timeoutMs > 60000)) ||
      !dataset.config.decision.allowPaidJev || dataset.cases.filter(item => item.expected.evaluate).length > maxCalls) fail();
  return { model, apiKey: { ...key }, ...(plugin.config.timeoutMs === undefined ? {} : { timeoutMs: plugin.config.timeoutMs }) };
}

function isolatedEnvironment(temp, settings, environment) {
  // No existing OpenClaw state/profile or credential stores are inherited. The one
  // selected env value is passed to the host, whose native SecretRef flow prepares it.
  const env = {};
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT'])
    if (typeof environment[name] === 'string') env[name] = environment[name];
  Object.assign(env, { HOME: join(temp, 'home'), USERPROFILE: join(temp, 'home'),
    XDG_CONFIG_HOME: join(temp, 'config'), XDG_DATA_HOME: join(temp, 'data'), XDG_STATE_HOME: join(temp, 'state'),
    XDG_CACHE_HOME: join(temp, 'cache'), TMPDIR: join(temp, 'tmp'), TMP: join(temp, 'tmp'), TEMP: join(temp, 'tmp'),
    OPENCLAW_STATE_DIR: join(temp, 'openclaw-state'), OPENCLAW_CONFIG_PATH: join(temp, 'openclaw.json'),
    OPENCLAW_SKIP_CRON: '1', OPENCLAW_SKIP_BUNDLED_DOCTOR: '1',
    [settings.apiKey.id]: environment[settings.apiKey.id] });
  return env;
}

export async function runHostedEvaluation(options, environment = process.env) {
  if (!options?.allowPaidJev) fail();
  const [major, minor] = process.versions.node.split('.').map(Number);
  // Do not let the upstream shim re-exec a new Node after the owned launcher
  // exits; keep the admitted host as the process-tree root we will clean up.
  if (!(major === 24 && minor >= 16) && !(major === 26 && minor >= 1) && major < 27) fail();
  const dataset = loadEvaluationDataset(options.datasetPath);
  const settings = hostedEvaluationSettings(readEvaluationJson(options.configPath), environment, options, dataset);
  requireSource();
  if (existsSync(options.outputPath)) fail();
  const temp = mkdtempSync(join(tmpdir(), 'rein-hosted-routing-eval-'));
  let child, closed, stopping, spawnFailed = false, childClosed = false, interrupted = false, cleanupComplete = true;
  const stop = () => {
    if (!child) return Promise.resolve();
    return stopping ??= (async () => {
    if (spawnFailed && !child.pid) return;
    // The shared helper captures owned descendants while their root still lives,
    // fences PID reuse, and waits for settlement. An unexpected prior exit cannot
    // establish the descendant boundary, so preserve temp evidence on uncertainty.
    await stopOwnedProcessTree(child);
    await Promise.race([closed, new Promise(done => setTimeout(done, 1000))]);
    if (!childClosed) throw new Error('subscription_hosted_evaluation_cleanup_required');
    cleanupComplete = true;
    })();
  };
  const interrupt = () => { interrupted = true; if (child) void stop().catch(() => {}); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    for (const path of ['home', 'config', 'data', 'state', 'cache', 'tmp', 'workspace', 'plugin', 'openclaw-state'])
      mkdirSync(join(temp, path), { mode: 0o700 });
    const pluginPath = join(temp, 'plugin');
    writeFileSync(join(pluginPath, 'index.ts'), readFileSync(join(root, 'tests/fixtures/subscription-routing-evaluation.ts'), 'utf8')
      .replace("'__REIN_EVALUATION_MODULE__'", JSON.stringify(join(root, 'scripts/subscription-routing-evaluation.mjs'))));
    writeFileSync(join(pluginPath, 'openclaw.plugin.json'), JSON.stringify({ id: PLUGIN_ID, name: 'Isolated routing evaluation',
      activation: { onStartup: true }, configSchema: { type: 'object', additionalProperties: false, properties: {} } }));
    writeFileSync(join(pluginPath, 'package.json'), JSON.stringify({ name: '@rein-protocol/routing-evaluation', type: 'module',
      openclaw: { extensions: ['./index.ts'] } }));
    symlinkSync(join(upstream, 'node_modules'), join(pluginPath, 'node_modules'), 'dir');
    const reservation = createServer();
    await new Promise((done, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', done); });
    const port = reservation.address().port;
    await new Promise(done => reservation.close(done));
    const config = { gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token: randomBytes(32).toString('hex') } },
      agents: { defaults: { workspace: join(temp, 'workspace'), skipBootstrap: true, decisionModel: settings.model } },
      memory: { search: { enabled: false } }, channels: {},
      tools: { deny: ['*'] },
      plugins: { allow: ['typesafe', PLUGIN_ID], load: { paths: [join(upstream, 'extensions/typesafe'), pluginPath] },
        entries: { typesafe: { enabled: true, config: { apiKey: settings.apiKey,
          ...(settings.timeoutMs === undefined ? {} : { timeoutMs: settings.timeoutMs }) } }, [PLUGIN_ID]: { enabled: true } } } };
    writeFileSync(join(temp, 'openclaw.json'), JSON.stringify(config), { mode: 0o600 });
    writeFileSync(join(temp, 'dataset.json'), JSON.stringify(dataset), { mode: 0o600 });
    const env = isolatedEnvironment(temp, settings, environment);
    Object.assign(env, { REIN_EVALUATION_DATASET: join(temp, 'dataset.json'), REIN_EVALUATION_REPORT: join(temp, 'report.json'),
      REIN_EVALUATION_MAX_CALLS: String(options.maxCalls) });
    // Native logs can contain reflected evidence. Drain privately with a fixed cap;
    // errors and child output never reach the terminal or the report.
    if (interrupted) fail();
    child = spawn(process.execPath, [join(upstream, 'openclaw.mjs'), 'gateway', 'run', '--allow-unconfigured'],
      { cwd: upstream, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    cleanupComplete = false;
    closed = new Promise(done => child.once('close', () => { childClosed = true; done(); }));
    let outputBytes = 0, outputOverflow = false;
    child.once('error', () => { spawnFailed = true; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
      outputBytes += bytes.length;
      if (outputBytes > 4 * 1024 * 1024) { outputOverflow = true; void stop().catch(() => {}); }
    });
    const deadline = Date.now() + 60000 + dataset.cases.filter(item => item.expected.evaluate).length * (dataset.config.decision.timeoutMs + 1000);
    while (!existsSync(join(temp, 'report.json')) && child.exitCode === null && child.signalCode === null &&
        !interrupted && !spawnFailed && !outputOverflow && Date.now() < deadline)
      await new Promise(done => setTimeout(done, 100));
    if (!existsSync(join(temp, 'report.json')) || outputOverflow || interrupted) fail();
    const report = readEvaluationJson(join(temp, 'report.json'));
    if (report.failed || report.datasetSha256 !== datasetDigest(dataset) || report.callCount > options.maxCalls ||
        report.records?.length !== dataset.cases.length) fail();
    // Even an unavailable/failed classifier run remains useful evidence. Publish
    // its status and exit unsuccessfully so it cannot masquerade as acceptance.
    report.status = report.summary.routing.selectionFailures || report.records.some(record => record.evaluated && record.outcome?.status !== 'ok') ? 'incomplete' : 'complete';
    await stop();
    if (interrupted) fail();
    writeEvaluationReport(options.outputPath, report);
    return { status: report.status, callCount: report.callCount, summary: report.summary };
  } finally {
    try {
      await stop();
      if (spawnFailed && !child?.pid) cleanupComplete = true;
    } catch {
      // Never remove private state while an owned process may still be using it.
      throw new Error('subscription_hosted_evaluation_cleanup_required');
    } finally {
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      if (cleanupComplete) rmSync(temp, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); if (args[0] === '--') args.shift();
    const result = await runHostedEvaluation(parseHostedEvaluationArguments(args));
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'complete') process.exitCode = 1;
  } catch (error) {
    console.error(error?.message === 'subscription_hosted_evaluation_cleanup_required' ?
      'subscription_hosted_evaluation_cleanup_required' : 'subscription_hosted_evaluation_failed');
    process.exitCode = 1;
  }
}
