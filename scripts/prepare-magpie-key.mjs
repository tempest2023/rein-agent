import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRouterConfig } from '../plugins/rein-router/policy.mjs';
import { acquireManagedProfileLock, buildManagedEnvironment, ensureManagedDirectories } from '../plugins/rein-router/managed-gateway.mjs';
import { magpiePaths, projectRoot as defaultRoot, verifyMagpieInstallation } from './magpie-dependency.mjs';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT = 64 * 1024;
const KEY = /^sk-magpie-key-[a-f0-9]{48}$/;
const ID = /^[a-f0-9]{24}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const ENV_FILE = 'runtime/magpie/gateway.env';
const KEY_FILE = 'runtime/magpie/config/magpie/caller-keys.json';
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function refuse(reason) {
  const code = `magpie_key_${reason}`;
  const error = new Error(code); error.code = code; throw error;
}

function inspectPath(root, path, { create = false, directory = false } = {}) {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) refuse('path_invalid');
  let current = root;
  for (const [index, part] of rel.split(sep).entries()) {
    current = join(current, part);
    const leaf = index === rel.split(sep).length - 1;
    let info;
    try { info = lstatSync(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (create && (!leaf || directory)) { mkdirSync(current, { mode: 0o700 }); info = lstatSync(current); }
      else continue;
    }
    if (info.isSymbolicLink()) refuse('symlink_refused');
    if (leaf && !directory ? !info.isFile() || info.nlink !== 1 : !info.isDirectory()) refuse('path_invalid');
    if (current === join(root, 'runtime/magpie') && process.platform !== 'win32' && (info.mode & 0o077))
      refuse('profile_permissions');
  }
}

function readFile(path, { optional = false, privateMode = true, limit = MAX_BYTES } = {}) {
  let descriptor;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) refuse('file_invalid');
    if (privateMode && process.platform !== 'win32' && (info.mode & 0o077)) refuse('file_permissions');
    return readFileSync(descriptor, 'utf8');
  } finally { closeSync(descriptor); }
}

function ignored(root, path) {
  const args = ['check-ignore', '--quiet', '--no-index', '--', path];
  const checked = spawnSync('git', args, { cwd: root, stdio: 'ignore' });
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', path], { cwd: root, stdio: 'ignore' });
  if (checked.error || checked.status !== 0 || tracked.error || tracked.status !== 1) refuse('destination_not_ignored');
}

function keyStore(root) {
  const path = join(root, KEY_FILE);
  inspectPath(root, path);
  const text = readFile(path, { optional: true });
  if (text === null) return [];
  let value;
  try { value = JSON.parse(text); } catch { refuse('store_invalid'); }
  if (!Array.isArray(value) || value.length > 4096 || value.some(entry => !object(entry) ||
      typeof entry.id !== 'string' || !entry.id || entry.id.length > 128 || typeof entry.name !== 'string' ||
      typeof entry.secret !== 'string' || entry.secret.length > 256) ||
      new Set(value.map(entry => entry.id)).size !== value.length ||
      new Set(value.filter(entry => entry.secret).map(entry => entry.secret)).size !== value.filter(entry => entry.secret).length)
    refuse('store_invalid');
  return value;
}

function scoped(entry, models) {
  return object(entry) && ID.test(entry.id) && KEY.test(entry.secret) &&
    (entry.off === undefined || entry.off === false) && entry.lan !== true &&
    Array.isArray(entry.models) && entry.models.length === models.length &&
    [...entry.models].sort().every((model, index) => model === models[index]);
}

const scopeName = (root, models) => `Rein project router ${createHash('sha256').update(JSON.stringify([root, models])).digest('hex').slice(0, 20)}`;
function oldScope(entry) {
  const models = entry?.models;
  if (!Array.isArray(models) || !models.length || models.length > 64 || new Set(models).size !== models.length ||
      models.some(model => typeof model !== 'string' || !MODEL.test(model) || /^group\//i.test(model) ||
        model.includes('//') || model.endsWith('/') || model.split('/').some(part => part === '.' || part === '..'))) return null;
  return [...models].sort();
}

/** Capture secret-bearing native output privately and bound both output and lifetime. */
async function runPrivate(binary, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const output = { stdout: [], stderr: [] };
    let bytes = 0, invalid = false;
    const timer = setTimeout(() => { invalid = true; child.kill('SIGKILL'); }, 5000);
    for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) { invalid = true; child.kill('SIGKILL'); return; }
      output[name].push(chunk);
    });
    child.once('error', () => { clearTimeout(timer); reject(new Error('magpie_key_command_failed')); });
    child.once('close', code => {
      clearTimeout(timer);
      resolveRun({ code: invalid ? -1 : code,
        stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8') });
    });
  });
}

function writeEnvironment(root, envPath, name, secret, previous) {
  inspectPath(root, envPath);
  ignored(root, ENV_FILE);
  const temporary = join(dirname(envPath), `.gateway-env-${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, `${name}=${secret}\n`); fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    if (previous === undefined) {
      // Initial publication never replaces a concurrent writer's file.
      linkSync(temporary, envPath);
    } else {
      inspectPath(root, envPath);
      if (readFile(envPath, { limit: 4096 }) !== previous) refuse('environment_changed');
      // Only --replace authorizes replacing the exact old private file, after
      // its owned credential has been revoked and the new scope verified.
      renameSync(temporary, envPath);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

async function prepare({ projectRoot = defaultRoot, configPath, environment = process.env,
  run = runPrivate, verifyInstallation = verifyMagpieInstallation, replace = false } = {}) {
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot) || typeof configPath !== 'string' ||
      !isAbsolute(configPath) || typeof run !== 'function' || typeof verifyInstallation !== 'function' ||
      typeof replace !== 'boolean' || !object(environment))
    refuse('arguments_invalid');
  const root = realpathSync(projectRoot);
  // Router configuration has no credentials; allow an explicitly named external
  // regular file, but never a symlink or a linked/oversized file.
  let config;
  try { config = validateRouterConfig(JSON.parse(readFile(configPath, { privateMode: false }))); }
  catch { refuse('config_invalid'); }
  const paths = magpiePaths(root);
  if (!config.gateway || !config.routes.length || config.gateway.managed?.homeDir !== paths.homeDir ||
      config.gateway.managed?.binaryPath !== paths.binary) refuse('managed_profile_mismatch');
  const models = [...new Set(config.routes.map(route => route.gatewayModel))].sort();
  const name = scopeName(root, models);
  const envPath = join(root, ENV_FILE);
  ignored(root, ENV_FILE); ignored(root, KEY_FILE);
  inspectPath(root, paths.homeDir, { create: true, directory: true });
  inspectPath(root, join(root, KEY_FILE)); inspectPath(root, envPath);
  const childEnvironment = buildManagedEnvironment({ homeDir: paths.homeDir,
    baseUrl: config.gateway.baseUrl, environment, allowSubscriptionAccounts: false });
  await ensureManagedDirectories(childEnvironment);
  let release;
  try { release = await acquireManagedProfileLock(paths.homeDir); } catch { refuse('profile_busy'); }
  let before, creating = false, oldRecord, oldModels, reusedReplacement = false, revocationStarted = false;
  const invoke = async args => {
    const result = await run(paths.binary, args, { cwd: paths.homeDir, env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    if (!object(result) || result.code !== 0 || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' ||
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT) refuse('command_failed');
    return result.stdout.trim();
  };
  try {
    await verifyInstallation({ root, binaryPath: paths.binary });
    before = keyStore(root);
    const existingEnvironment = readFile(envPath, { optional: true, limit: 4096 });
    if (existingEnvironment !== null) {
      const match = new RegExp(`^${config.gateway.apiKeyEnvVar}=(sk-magpie-key-[a-f0-9]{48})\\n?$`).exec(existingEnvironment);
      const record = match && before.find(entry => entry.secret === match[1]);
      if (record?.name === name && scoped(record, models))
        return { envPath, apiKeyEnvVar: config.gateway.apiKeyEnvVar, modelCount: models.length, status: 'reused' };
      oldModels = oldScope(record);
      if (!replace || !oldModels || record.name !== scopeName(root, oldModels) || !scoped(record, oldModels))
        refuse('existing_environment_conflict');
      oldRecord = record;
    }
    const matching = before.filter(entry => entry.name === name);
    if (matching.length > 1 || (matching.length === 1 && !scoped(matching[0], models))) refuse('existing_key_conflict');
    let record = matching[0];
    if (!record) {
      creating = true;
      const secret = await invoke(['gateway-key', 'add', name]);
      const added = keyStore(root).filter(entry => entry.name === name && !before.some(old => old.id === entry.id));
      if (added.length !== 1 || !KEY.test(secret) || added[0].secret !== secret || !ID.test(added[0].id)) refuse('created_key_invalid');
      record = added[0];
      await invoke(['gateway-key', 'models', record.id, ...models]);
    }
    const verified = keyStore(root).find(entry => entry.id === record.id);
    if (!verified || verified.name !== name || verified.secret !== record.secret || !scoped(verified, models)) refuse('scope_unverified');
    if (oldRecord) {
      reusedReplacement = matching.length > 0;
      inspectPath(root, envPath);
      if (readFile(envPath, { limit: 4096 }) !== existingEnvironment) refuse('environment_changed');
      const currentOld = keyStore(root).find(entry => entry.id === oldRecord.id);
      if (!currentOld || currentOld.secret !== oldRecord.secret || currentOld.name !== oldRecord.name ||
          !scoped(currentOld, oldModels)) refuse('replacement_source_changed');
      revocationStarted = true;
      await invoke(['gateway-key', 'remove', oldRecord.id]);
      if (keyStore(root).some(entry => entry.id === oldRecord.id || entry.secret === oldRecord.secret))
        refuse('revocation_unverified');
    }
    writeEnvironment(root, envPath, config.gateway.apiKeyEnvVar, verified.secret, oldRecord ? existingEnvironment : undefined);
    creating = false;
    return { envPath, apiKeyEnvVar: config.gateway.apiKeyEnvVar, modelCount: models.length,
      status: oldRecord ? 'replaced' : matching.length ? 'reused' : 'created' };
  } catch (error) {
    if (creating) {
      try {
        const fresh = keyStore(root).filter(entry => entry.name === name && !before.some(old => old.id === entry.id));
        for (const entry of fresh) {
          if (!ID.test(entry.id)) refuse('cleanup_required');
          await invoke(['gateway-key', 'remove', entry.id]);
        }
        if (keyStore(root).some(entry => entry.name === name && !before.some(old => old.id === entry.id))) refuse('cleanup_required');
      } catch { refuse('cleanup_required'); }
    }
    if (reusedReplacement && revocationStarted) {
      // A preexisting next-catalog key is not this operation's to delete. If
      // publication failed after revoking the old key, leave the old file dead
      // and request explicit cleanup/recovery without returning either secret.
      const state = keyStore(root);
      if (!state.some(entry => entry.id === oldRecord.id || entry.secret === oldRecord.secret) &&
          state.some(entry => entry.name === name)) refuse('cleanup_required');
    }
    throw error;
  } finally { await release(); }
}

/** Explicit offline creation of a narrowly scoped key; never activates a profile. */
export async function prepareMagpieKey(options) {
  try {
    if (options && Object.keys(options).some(name => !['projectRoot', 'configPath', 'environment', 'run', 'verifyInstallation', 'replace'].includes(name)))
      refuse('arguments_invalid');
    return await prepare(options);
  } catch (error) {
    if (typeof error?.code === 'string' && /^magpie_key_[a-z_]+$/.test(error.code)) throw error;
    refuse('failed');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const replace = args[0] === '--replace';
    if ((replace ? args.length !== 2 : args.length !== 1) || args.at(-1).startsWith('--')) refuse('arguments_invalid');
    const prepared = await prepareMagpieKey({ configPath: resolve(args.at(-1)), replace });
    console.log(`Project Magpie gateway key ${prepared.status}; ${prepared.modelCount} exact model(s). Protected environment file: ${ENV_FILE}`);
  } catch (error) {
    console.error(typeof error?.code === 'string' && /^magpie_key_[a-z_]+$/.test(error.code) ? error.code : 'magpie_key_failed');
    process.exitCode = 1;
  }
}
