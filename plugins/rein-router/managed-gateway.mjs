import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, lstat, open, unlink, access, realpath } from 'node:fs/promises';
import { isAbsolute, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { createConnection } from 'node:net';
import lock from './magpie.lock.json' with { type: 'json' };
import { stopOwnedProcessTree } from './process-tree.mjs';
import { assertManagedSpendPolicy } from './spend-policy.mjs';

const failure = code => new Error(`rein_magpie_${code}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Isolate upstream startup migrations and native clients from the user's home. */
export function buildManagedEnvironment({ homeDir, baseUrl, environment = process.env, allowSubscriptionAccounts = false }) {
  if (!isAbsolute(homeDir) || dirname(homeDir) === homeDir) throw failure('home_invalid');
  const url = new URL(baseUrl);
  if (!['http:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/v1' || !url.port || url.username || url.password || url.search || url.hash)
    throw failure('address_invalid');
  const root = dirname(homeDir);
  const child = Object.fromEntries(Object.entries(environment).filter(([name]) =>
    /^(?:PATH|LANG|LC_[A-Z_]+|TZ|TERM|SYSTEMROOT|COMSPEC|PATHEXT|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|https?_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/.test(name)));
  Object.assign(child, { HOME: homeDir, USERPROFILE: homeDir,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'), XDG_DATA_HOME: join(root, 'data'),
    XDG_RUNTIME_DIR: join(root, 'run'), TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
    APPDATA: join(root, 'config'), LOCALAPPDATA: join(root, 'data'),
    CODEX_HOME: join(homeDir, '.codex'), CLAUDE_CONFIG_DIR: join(homeDir, '.claude'),
    GEMINI_CLI_HOME: join(homeDir, '.gemini'), MAGPIE_ADDR: url.host, MAGPIE_TRUST_PROXY: '0' });
  if (!allowSubscriptionAccounts) child.MAGPIE_NO_ACCOUNTS = '1';
  return child;
}

export async function ensureManagedDirectories(environment) {
  const paths = ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME',
    'XDG_RUNTIME_DIR', 'TMPDIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME'];
  // Inspect existing ancestors before mkdir can follow any profile symlink.
  // macOS's system /var and /tmp aliases are safe canonical OS entry points.
  const inspect = async path => {
    const absolute = resolve(path), root = parse(absolute).root;
    let current = root;
    for (const part of relative(root, absolute).split(sep)) {
      current = join(current, part);
      let stat;
      try { stat = await lstat(current); }
      catch (error) { if (error.code === 'ENOENT') break; throw failure('private_directory_required'); }
      if (stat.isSymbolicLink()) {
        if (process.platform === 'darwin' && ['/var', '/tmp'].includes(current) &&
            await realpath(current) === `/private${current}`) continue;
        throw failure('private_directory_required');
      }
      if (!stat.isDirectory()) throw failure('private_directory_required');
    }
  };
  for (const field of paths) await inspect(environment[field]);
  for (const field of paths) {
    const path = environment[field];
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077)))
      throw failure('private_directory_required');
  }
}

/** Coordinate the foreground service, interactive CLI and offline secret import. */
export async function acquireManagedProfileLock(homeDir) {
  const path = join(dirname(homeDir), '.rein-magpie.lock');
  const value = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(value);
  } catch { throw failure('profile_busy'); }
  finally { await handle?.close(); }
  return async () => {
    try { if (await readFile(path, 'utf8') === value) await unlink(path); }
    catch { /* Never remove another owner's lock. */ }
  };
}

export async function verifyManagedBinary(binaryPath) {
  try {
    const stat = await lstat(binaryPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && !(stat.mode & 0o111)))
      throw failure('binary_invalid');
    for (const name of ['.portable', 'data']) {
      if (await access(join(dirname(binaryPath), name)).then(() => true, () => false))
        throw failure('portable_mode_disallowed');
    }
    const receiptStat = await lstat(`${binaryPath}.json`);
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.size > 4096)
      throw failure('receipt_invalid');
    const receipt = JSON.parse(await readFile(`${binaryPath}.json`, 'utf8'));
    if (receipt.revision !== lock.revision || receipt.version !== lock.version ||
        !/^[a-f0-9]{64}$/.test(receipt.sha256)) throw failure('binary_pin_mismatch');
    const digest = createHash('sha256').update(await readFile(binaryPath)).digest('hex');
    if (digest !== receipt.sha256) throw failure('binary_digest_mismatch');
  } catch { throw failure('binary_verification_failed'); }
}

async function portOccupied(url) {
  return new Promise(resolve => {
    const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) });
    const done = result => { socket.destroy(); resolve(result); };
    socket.once('connect', () => done(true));
    socket.once('error', error => done(error.code !== 'ECONNREFUSED'));
    socket.setTimeout(250, () => done(true));
  });
}

async function readSmallJson(response) {
  if (!response.ok || response.redirected || !response.body) return null;
  const reader = response.body.getReader();
  let body = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      body += new TextDecoder().decode(next.value);
      if (body.length > 64 * 1024) return null;
    }
    return JSON.parse(body);
  } finally { try { void reader.cancel().catch(() => {}); } catch { /* no raw child errors */ } }
}

/** A foreground child owned by one plugin instance; never adopts another daemon. */
export function createManagedGateway({ gateway, routes, allowPaidUsage = false, environment = process.env,
  spawnImpl = spawn, fetchImpl = globalThis.fetch, verifyInstallation = verifyManagedBinary,
  stopImpl = stopOwnedProcessTree }) {
  const config = gateway.managed;
  const childEnvironment = buildManagedEnvironment({ homeDir: config.homeDir, baseUrl: gateway.baseUrl,
    environment, allowSubscriptionAccounts: config.allowSubscriptionAccounts });
  const base = new URL(gateway.baseUrl);
  const getMetadata = async (url, headers) => {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, 250); });
    try {
      return await Promise.race([timeout, Promise.resolve().then(() => fetchImpl(url, {
        headers, redirect: 'error', signal: controller.signal })).then(readSmallJson)]);
    } catch { return null; }
    finally { clearTimeout(timer); controller.abort(); }
  };
  let child, ready = false, stopping = false, starting = false, generation = 0, serviceHealth, releaseProfile, cleanupFailed = false, activeKey, stopPromise;
  const isReady = () => Boolean(ready && child && child.exitCode === null && !child.killed &&
    activeKey && environment[gateway.apiKeyEnvVar] === activeKey);
  const stop = () => {
    generation++; ready = false; stopping = true; activeKey = undefined;
    // Startup retirement and host disposal can request the same stop while
    // metadata is pending. Only one cleanup may own this child, including
    // after it exits while that cleanup is still verifying its descendants.
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (cleanupFailed) throw failure('process_cleanup_required');
      const previous = child;
      if (!previous?.pid) { child = undefined; await releaseProfile?.(); releaseProfile = undefined; return; }
      try { await stopImpl(previous); }
      catch {
        cleanupFailed = true;
        serviceHealth?.reportFailure(failure('process_cleanup_required'));
        // Keep the ownership lock: an unverified detached native client must not
        // overlap a second service or an offline credential import.
        throw failure('process_cleanup_required');
      }
      if (child === previous) child = undefined;
      await releaseProfile?.(); releaseProfile = undefined;
    })().finally(() => { stopPromise = undefined; });
    return stopPromise;
  };
  const start = async context => {
    if (child || starting || stopPromise || cleanupFailed) throw failure('already_started');
    starting = true;
    const current = ++generation;
    stopping = false; ready = false; serviceHealth = context?.serviceHealth;
    try {
      await verifyInstallation(config.binaryPath);
      await ensureManagedDirectories(childEnvironment);
      releaseProfile = await acquireManagedProfileLock(config.homeDir);
      await assertManagedSpendPolicy({ gateway, routes, allowPaidUsage });
      if (await portOccupied(base)) throw failure('port_in_use');
      if (current !== generation || stopping) throw failure('startup_cancelled');
      const key = environment[gateway.apiKeyEnvVar];
      if (typeof key !== 'string' || !/^sk-magpie-key-[A-Za-z0-9_-]{16,240}$/.test(key)) throw failure('managed_key_required');
      activeKey = key;
      child = spawnImpl(config.binaryPath, ['serve'], { cwd: config.homeDir, env: childEnvironment,
        detached: process.platform !== 'win32', stdio: 'ignore' });
      const ownedChild = child;
      child.on('error', () => { ready = false; if (!stopping) serviceHealth?.reportFailure(failure('process_failed')); });
      child.on('exit', () => { ready = false; if (!stopping) serviceHealth?.reportFailure(failure('process_exited')); });
      const deadline = Date.now() + 3000;
      const headers = { Authorization: `Bearer ${key}`, Origin: 'null' };
      const allowed = new Set(routes.map(route => route.gatewayModel));
      while (Date.now() < deadline && current === generation && child.exitCode === null && !child.killed) {
        try {
          const info = await getMetadata(new URL('/', base), headers);
          if (info?.name === 'magpie' && info.version === lock.version) {
            const models = await getMetadata(`${gateway.baseUrl}/models`, headers);
            if (Array.isArray(models?.data) && models.data.length === allowed.size &&
                new Set(models.data.map(model => model.id)).size === allowed.size &&
                models.data.every(model => allowed.has(model.id))) {
              if (current !== generation || stopping || child !== ownedChild || ownedChild.exitCode !== null ||
                  ownedChild.killed || environment[gateway.apiKeyEnvVar] !== key) throw failure('startup_cancelled');
              ready = true; return;
            }
          }
        } catch { /* Only fixed diagnostics escape the private process boundary. */ }
        await sleep(50);
      }
      throw failure('startup_unavailable');
    } catch (error) {
      await stop();
      if (['rein_magpie_codex_credit_configuration_required', 'rein_magpie_port_in_use',
        'rein_magpie_managed_key_required', 'rein_magpie_binary_verification_failed',
        'rein_magpie_private_directory_required', 'rein_magpie_profile_busy'].includes(error?.message)) throw error;
      throw failure('startup_failed');
    } finally { starting = false; }
  };
  return { isReady, start, stop };
}
