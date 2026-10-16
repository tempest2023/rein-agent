import { execFile, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { magpiePaths, projectRoot, verifyMagpieInstallation } from './magpie-dependency.mjs';
import { acquireManagedProfileLock, buildManagedEnvironment,
  ensureManagedDirectories } from '../plugins/rein-router/managed-gateway.mjs';
import { stopOwnedProcessTree } from '../plugins/rein-router/process-tree.mjs';

const BASE_URL = 'http://127.0.0.1:3425/v1';
const failure = reason => new Error(`magpie_ui_${reason}`);
const signalExitCode = signal => signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;

/** Let upstream persist its own updater preference; keep output private and bounded. */
export function disableMagpieAutoUpdate(binaryPath, { cwd, env }, execFileImpl = execFile) {
  return new Promise((resolveConfigured, reject) => {
    const complete = error => error ? reject(failure('configuration_failed')) : resolveConfigured();
    try {
      execFileImpl(binaryPath, ['update', 'auto', 'off'], { cwd, env, shell: false,
        timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true, killSignal: 'SIGKILL' }, complete);
    } catch { complete(true); }
  });
}

/** An inconclusive connection check never authorizes starting a second gateway. */
async function gatewayOccupied(url) {
  return new Promise(resolveOccupied => {
    const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) });
    const done = occupied => { socket.destroy(); resolveOccupied(occupied); };
    socket.once('connect', () => done(true));
    socket.once('error', error => done(error.code !== 'ECONNREFUSED'));
    socket.setTimeout(250, () => done(true));
  });
}

/** Launch upstream's configuration UI; provider setup and sign-in stay upstream. */
export async function runMagpieUi(input = [], { root = projectRoot, environment = process.env,
  gatewayBaseUrl = BASE_URL,
  spawnImpl = spawn, portCheck = gatewayOccupied, verifier = verifyMagpieInstallation,
  stopImpl = stopOwnedProcessTree, configureNative = disableMagpieAutoUpdate, signalSource = process } = {}) {
  const options = [...input];
  if (options[0] === '--') options.shift();
  if (options.length > 1 || (options.length === 1 && options[0] !== '--no-open'))
    throw failure('arguments_invalid');
  const paths = magpiePaths(root);
  let installed;
  try { installed = await verifier({ root: paths.root }); }
  catch (error) {
    if (/^magpie_dependency_[a-z_]+$/.test(error?.message ?? '')) throw error;
    throw failure('dependency_verification_failed');
  }
  const env = buildManagedEnvironment({ homeDir: paths.homeDir, baseUrl: gatewayBaseUrl,
    environment, allowSubscriptionAccounts: true });
  await ensureManagedDirectories(env);
  const release = await acquireManagedProfileLock(paths.homeDir);
  let child, requestedSignal, cleanup, finish, keepLock = false;
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
    requestedSignal ??= signal;
    if (finish) void finish();
  }]));
  for (const [signal, handler] of handlers) signalSource.on(signal, handler);
  try {
    let occupied;
    try { occupied = await portCheck(new URL(gatewayBaseUrl)); }
    catch { throw failure('gateway_check_failed'); }
    if (occupied !== false) throw failure('gateway_occupied');
    if (requestedSignal) return signalExitCode(requestedSignal);
    try { await configureNative(installed.binaryPath, { cwd: paths.homeDir, env }); }
    catch { throw failure('configuration_failed'); }
    if (requestedSignal) return signalExitCode(requestedSignal);
    try {
      child = spawnImpl(installed.binaryPath, ['web', '--addr', '127.0.0.1:0', ...options], {
        cwd: paths.homeDir, env, detached: process.platform !== 'win32', stdio: 'inherit', shell: false,
      });
    } catch { throw failure('failed_to_start'); }
    return await new Promise((resolveRun, reject) => {
      let code, exitSignal, failedToStart = false;
      finish = () => {
        if (cleanup) return cleanup;
        // Defer so synchronous test/event callbacks cannot enter cleanup twice.
        cleanup = Promise.resolve().then(async () => {
          if (code === 0 && !exitSignal && !failedToStart) {
            // Native Quit already reaped the root. Verify its fixed gateway has
            // closed rather than trying to signal a potentially reused PID.
            try { if (await portCheck(new URL(gatewayBaseUrl)) !== false) throw failure('cleanup_required'); }
            catch { keepLock = true; throw failure('cleanup_required'); }
          } else if (child.pid) {
            try {
              if ((await stopImpl(child))?.complete !== true) throw failure('cleanup_required');
            } catch { keepLock = true; throw failure('cleanup_required'); }
          }
          if (failedToStart) throw failure('failed_to_start');
          return requestedSignal ? signalExitCode(requestedSignal)
            : code ?? (exitSignal ? signalExitCode(exitSignal) : 1);
        });
        cleanup.then(resolveRun, reject);
        return cleanup.catch(() => {});
      };
      child.once('error', () => { failedToStart = true; void finish(); });
      child.once('close', (status, signal) => { code = status; exitSignal = signal; void finish(); });
      if (requestedSignal) void finish();
    });
  } finally {
    for (const [signal, handler] of handlers) signalSource.off(signal, handler);
    if (!keepLock) await release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await runMagpieUi(process.argv.slice(2)); }
  catch (error) {
    console.error(/^(?:magpie_ui_|magpie_dependency_|rein_magpie_)[a-z_]+$/.test(error?.message ?? '')
      ? error.message : 'magpie_ui_failed');
    process.exitCode = 1;
  }
}
