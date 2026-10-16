import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';
import { magpiePaths, projectRoot } from './magpie-dependency.mjs';
import { isGatewayCredentialEnvironmentName } from '../plugins/rein-router/policy.mjs';

const KEY = /^sk-magpie-key-[A-Za-z0-9_-]{16,240}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function refuse(reason) {
  const code = `magpie_gateway_env_${reason}`;
  const error = new Error(code); error.code = code; throw error;
}

function readRegular(path, maxBytes, { optional = false, privateMode = false } = {}) {
  let descriptor;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) refuse('file_invalid');
    if (privateMode && process.platform !== 'win32' && (info.mode & 0o777) !== 0o600) refuse('file_permissions');
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(descriptor));
  } finally { closeSync(descriptor); }
}

function privateEnvironmentPath(root) {
  const components = ['runtime', 'magpie', 'gateway.env'];
  let path = root;
  for (const [index, part] of components.entries()) {
    path = join(path, part);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) refuse('symlink_refused');
    if (index < components.length - 1 && !info.isDirectory()) refuse('path_invalid');
  }
  return path;
}

/** Only an active, exact project-owned gateway may receive this one secret. */
export function loadMagpieGatewayEnvironment({ root = projectRoot, environment = process.env } = {}) {
  try {
    if (typeof root !== 'string' || !isAbsolute(root) || !object(environment)) refuse('arguments_invalid');
    const copy = { ...environment };
    const configPath = copy.OPENCLAW_CONFIG_PATH;
    if (typeof configPath !== 'string' || !isAbsolute(configPath)) return copy;
    let host;
    try {
      const text = readRegular(configPath, 4 * 1024 * 1024, { optional: true });
      if (text === null) return copy;
      host = JSON.parse(text);
    } catch { return copy; }
    const plugins = host?.plugins;
    const entry = plugins?.entries?.['rein-router'];
    if (plugins?.enabled === false || plugins?.deny?.includes('rein-router') ||
        (Array.isArray(plugins?.allow) && !plugins.allow.includes('rein-router')) ||
        entry?.enabled !== true || entry?.config?.enabled !== true) return copy;
    const canonicalRoot = realpathSync(root);
    const paths = magpiePaths(canonicalRoot);
    const gateway = entry.config.gateway;
    if (!object(gateway?.managed) || gateway.managed.binaryPath !== paths.binary ||
        gateway.managed.homeDir !== paths.homeDir) return copy;
    const name = gateway.apiKeyEnvVar;
    if (!isGatewayCredentialEnvironmentName(name)) refuse('variable_disallowed');
    const text = readRegular(privateEnvironmentPath(canonicalRoot), 4096, { privateMode: true });
    const parsed = parseEnv(text);
    const entries = Object.keys(parsed);
    // Reject duplicate assignments and extra non-comment content as well as
    // extra parsed variables; the prepared file contains exactly one secret.
    const declarations = text.split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith('#'));
    if (entries.length !== 1 || entries[0] !== name || declarations.length !== 1 ||
        !new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(declarations[0]) ||
        typeof parsed[name] !== 'string' || !KEY.test(parsed[name])) refuse('contents_invalid');
    if (copy[name] !== undefined && copy[name] !== parsed[name]) refuse('existing_value_conflict');
    copy[name] = parsed[name];
    return copy;
  } catch (error) {
    if (typeof error?.code === 'string' && /^magpie_gateway_env_[a-z_]+$/.test(error.code)) throw error;
    refuse('unavailable');
  }
}
