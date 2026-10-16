import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { acquireManagedProfileLock } from '../plugins/rein-router/managed-gateway.mjs';

const PROVIDER_ID = 'bailian-token-plan';
const KEY_ENV = 'BAILIAN_TOKEN_PLAN_API_KEY';
const ANTHROPIC_BASE = 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic';
const CHAT_BASE = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const DESTINATION = 'runtime/magpie/config/magpie/providers.json';
const MAX_BYTES = 4 * 1024 * 1024;
const ROOT_FIELDS = ['providers', 'groups', 'searches', 'noAutoGroups', 'order', 'groupOrder', 'pluginLeft'];

function refuse(reason) {
  const code = `bailian_import_${reason}`;
  const error = new Error(code); error.code = code; throw error;
}

const object = value => value && typeof value === 'object' && !Array.isArray(value);
function inside(parent, path) {
  const rel = relative(parent, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function checkPath(projectRoot, path, { createDirectories = false, file = true } = {}) {
  if (!inside(join(projectRoot, 'runtime'), path)) refuse('path_outside_runtime');
  const parts = relative(projectRoot, path).split(sep);
  let current = projectRoot;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const leaf = index === parts.length - 1;
    let info;
    try { info = lstatSync(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (createDirectories && !(leaf && file)) {
        mkdirSync(current, { mode: 0o700 }); info = lstatSync(current);
      } else continue;
    }
    if (info.isSymbolicLink()) refuse('symlink_refused');
    if (leaf && file ? !info.isFile() || info.nlink !== 1 : !info.isDirectory()) refuse('path_invalid');
  }
}

function readPrivateFile(path, { optional = false, privateMode = false } = {}) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES) refuse('file_invalid');
    if (privateMode && (info.mode & 0o077) !== 0) refuse('destination_permissions');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function parseJson(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { refuse('json_invalid'); }
  const check = item => {
    if (typeof item === 'number' && !Number.isFinite(item)) refuse('json_invalid');
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) refuse('json_invalid');
      check(child);
    }
  };
  check(value);
  return value;
}

function sourceProvider(config) {
  const provider = config?.models?.providers?.[PROVIDER_ID];
  if (!object(provider) || !((provider.api === 'anthropic-messages' && provider.baseUrl === ANTHROPIC_BASE) ||
      (provider.api === 'openai-completions' && provider.baseUrl === CHAT_BASE))) refuse('source_provider_invalid');
  const ref = provider.apiKey;
  if (!object(ref) || Object.keys(ref).some(key => !['source', 'provider', 'id'].includes(key)) ||
      ref.source !== 'env' || ref.provider !== 'default' || ref.id !== KEY_ENV) refuse('source_credential_invalid');
  if (!Array.isArray(provider.models) || provider.models.length === 0 || provider.models.length > 64) refuse('source_models_invalid');
  const models = provider.models.map(model => model?.id);
  if (models.some(model => typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) ||
      new Set(models).size !== models.length) refuse('source_models_invalid');
  return models;
}

function validateDestination(value) {
  if (!object(value) || Object.keys(value).some(key => !ROOT_FIELDS.includes(key)) || !Array.isArray(value.providers)) refuse('destination_invalid');
  const ids = new Set();
  for (const provider of value.providers) {
    if (!object(provider) || typeof provider.id !== 'string' || !/^[a-z][a-z0-9._-]{0,127}$/.test(provider.id) || ids.has(provider.id)) refuse('destination_invalid');
    ids.add(provider.id);
    for (const field of ['name', 'key', 'preset', 'chat', 'anthropic', 'responses', 'gemini', 'decide', 'routing']) {
      if (provider[field] !== undefined && typeof provider[field] !== 'string') refuse('destination_invalid');
    }
    for (const field of ['models', 'fallback', 'was', 'pickedFrom']) {
      if (provider[field] !== undefined && (!Array.isArray(provider[field]) || provider[field].some(item => typeof item !== 'string'))) refuse('destination_invalid');
    }
  }
  for (const field of ['groups', 'searches', 'pluginLeft']) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].some(item => !object(item)))) refuse('destination_invalid');
  }
  for (const field of ['order', 'groupOrder']) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].some(item => typeof item !== 'string'))) refuse('destination_invalid');
  }
  if (value.noAutoGroups !== undefined && typeof value.noAutoGroups !== 'boolean') refuse('destination_invalid');
  const existing = value.providers.find(provider => provider.id === PROVIDER_ID);
  if (existing) {
    for (const [field, expected] of [['chat', CHAT_BASE], ['anthropic', ANTHROPIC_BASE]]) {
      if (existing[field] !== undefined && existing[field] !== '' && existing[field] !== expected) refuse('destination_provider_conflict');
    }
    for (const field of ['responses', 'gemini', 'decide', 'routing', 'sink', 'accessKeyID', 'secretAccessKey', 'keyProtocol']) {
      if (existing[field] !== undefined && existing[field] !== '') refuse('destination_provider_conflict');
    }
    for (const field of ['fallback', 'keys']) {
      if (existing[field] !== undefined && (!Array.isArray(existing[field]) || existing[field].length !== 0)) refuse('destination_provider_conflict');
    }
    for (const field of ['headers', 'extraBody']) {
      if (existing[field] !== undefined && (!object(existing[field]) || Object.keys(existing[field]).length !== 0)) refuse('destination_provider_conflict');
    }
  }
  return value;
}

function requireIgnoredDestination(projectRoot) {
  const ignored = spawnSync('git', ['check-ignore', '--quiet', '--no-index', '--', DESTINATION], { cwd: projectRoot, stdio: 'ignore' });
  if (ignored.error || ignored.status !== 0) refuse('destination_not_ignored');
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', DESTINATION], { cwd: projectRoot, stdio: 'ignore' });
  if (tracked.error || tracked.status !== 1) refuse('destination_not_ignored');
}

async function importOffline({ projectRoot, configPath, environment = process.env } = {}) {
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot) || !object(environment)) refuse('arguments_invalid');
  const requestedRoot = resolve(projectRoot);
  projectRoot = realpathSync(projectRoot);
  const scopedPath = value => isAbsolute(value) && inside(requestedRoot, value)
    ? resolve(projectRoot, relative(requestedRoot, value)) : resolve(projectRoot, value);
  if (configPath !== undefined && typeof configPath !== 'string') refuse('arguments_invalid');
  configPath = configPath === undefined ? join(projectRoot, 'runtime/openclaw/openclaw.json') : scopedPath(configPath);
  checkPath(projectRoot, configPath);
  const models = sourceProvider(parseJson(readPrivateFile(configPath)));
  let key = environment[KEY_ENV];
  if (key === undefined) {
    if (environment.OPENCLAW_STATE_DIR !== undefined && typeof environment.OPENCLAW_STATE_DIR !== 'string') refuse('source_env_invalid');
    const stateDir = environment.OPENCLAW_STATE_DIR === undefined ? dirname(configPath) : scopedPath(environment.OPENCLAW_STATE_DIR);
    const envFile = join(stateDir, '.env');
    checkPath(projectRoot, envFile);
    const bytes = readPrivateFile(envFile);
    let parsed;
    try { parsed = parseEnv(bytes.toString('utf8')); } catch { refuse('source_env_invalid'); }
    key = parsed[KEY_ENV];
  }
  // Plan keys are opaque and may contain dots; never parse or rewrite them.
  if (typeof key !== 'string' || !/^sk-sp-[!-~]{8,240}$/.test(key)) refuse('source_key_invalid');
  const destination = join(projectRoot, DESTINATION);
  checkPath(projectRoot, destination);
  requireIgnoredDestination(projectRoot);
  checkPath(projectRoot, destination, { createDirectories: true });
  const homeDir = join(projectRoot, 'runtime/magpie/home');
  checkPath(projectRoot, homeDir, { file: false });
  let release;
  try { release = await acquireManagedProfileLock(homeDir); } catch { refuse('profile_busy'); }
  let temporary;
  try {
    checkPath(projectRoot, destination);
    const before = readPrivateFile(destination, { optional: true, privateMode: true });
    const data = before ? validateDestination(parseJson(before)) : { providers: [] };
    const index = data.providers.findIndex(provider => provider.id === PROVIDER_ID);
    const imported = { ...(index >= 0 ? data.providers[index] : {}), id: PROVIDER_ID,
      name: index >= 0 ? data.providers[index].name ?? 'Bailian Token Plan' : 'Bailian Token Plan',
      preset: PROVIDER_ID, key, chat: CHAT_BASE, anthropic: ANTHROPIC_BASE, models };
    if (index >= 0) data.providers[index] = imported; else data.providers.push(imported);
    temporary = join(dirname(destination), `.providers-import-${randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    // Cooperative profile locking prevents the managed gateway/CLI from writing;
    // also refuse an unexpected external writer observed during this import.
    checkPath(projectRoot, destination);
    const current = readPrivateFile(destination, { optional: true, privateMode: true });
    if (before === null ? current !== null : current === null || !before.equals(current)) refuse('destination_changed');
    requireIgnoredDestination(projectRoot);
    renameSync(temporary, destination); temporary = undefined;
    return { providerId: PROVIDER_ID, chatBaseUrl: CHAT_BASE, anthropicBaseUrl: ANTHROPIC_BASE, models };
  } finally {
    if (temporary && existsSync(temporary)) unlinkSync(temporary);
    await release();
  }
}

/** Explicit offline credential import into this project's isolated Magpie profile. */
export async function importBailianSubscription(options) {
  try {
    if (options && Object.keys(options).some(key => !['projectRoot', 'configPath', 'environment'].includes(key))) refuse('arguments_invalid');
    return await importOffline(options);
  } catch (error) {
    if (typeof error?.code === 'string' && /^bailian_import_[a-z_]+$/.test(error.code)) throw error;
    refuse('failed');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && !(args.length === 2 && args[0] === '--config')) refuse('arguments_invalid');
    const projectRoot = fileURLToPath(new URL('../', import.meta.url));
    console.log(JSON.stringify(await importBailianSubscription({ projectRoot, configPath: args[1] })));
  } catch (error) {
    console.error(typeof error?.code === 'string' && /^bailian_import_[a-z_]+$/.test(error.code) ? error.code : 'bailian_import_failed');
    process.exitCode = 1;
  }
}
