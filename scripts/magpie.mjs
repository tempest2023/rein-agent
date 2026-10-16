import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { magpiePaths, projectRoot, verifyMagpieInstallation } from './magpie-dependency.mjs';

const COMMANDS = new Set(['help', '--help', '-h', 'version', '--version', '-v', 'healthcheck',
  'accounts', 'providers', 'presets', 'models', 'provider', 'quota', 'gateway-key', 'usage']);
const PROVIDER_COMMANDS = new Set(['add', 'set', 'models', 'fallback', 'on', 'off', 'test']);
const ACCOUNT_COMMANDS = new Set(['add', 'refresh', 'project', 'alias']);

/** No credentials in argv; this wrapper never installs host services or changes agents. */
export function validateMagpieArguments(input) {
  const args = [...input];
  if (!args.length) return ['help'];
  if (!COMMANDS.has(args[0]) || args.some(arg => typeof arg !== 'string' || /[\x00-\x1f\x7f]/.test(arg)))
    throw new Error('magpie_command_disallowed');
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (/^(?:sk-|rk-|Bearer\s)/i.test(arg) ||
        /^(?:key|api[-_.]?key|token|secret|access\.key|access\.secret|balance\.token|header\.[^=]+)=/i.test(arg))
      throw new Error('magpie_credentials_in_arguments_disallowed');
    if (arg === '--key' && !(args[0] === 'gateway-key' && args[1] === 'add' && args[index + 1] === '-'))
      throw new Error('magpie_credentials_in_arguments_disallowed');
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
    if (/^https?:\/\//i.test(value)) {
      let url; try { url = new URL(value); } catch { throw new Error('magpie_invalid_url_argument'); }
      if (url.username || url.password || url.search || url.hash) throw new Error('magpie_credentials_in_arguments_disallowed');
    }
  }
  if (args[0] === 'accounts' && args[1] && args[1] !== '--json' && !ACCOUNT_COMMANDS.has(args[1]))
    throw new Error('magpie_account_command_disallowed');
  if (args[0] === 'provider') {
    if (!PROVIDER_COMMANDS.has(args[1])) throw new Error('magpie_provider_command_disallowed');
    if (['add', 'set'].includes(args[1]) && args.slice(3).some(arg => !arg.includes('=')))
      throw new Error('magpie_credentials_in_arguments_disallowed');
  }
  if (args[0].toLowerCase() === 'quota' && args[1]?.toLowerCase() === 'credits' && args.some(arg => arg.toLowerCase() === 'on'))
    throw new Error('magpie_credit_spending_disallowed');
  return args;
}

export async function runMagpie(input, { root = projectRoot, environment = process.env } = {}) {
  let allowSubscriptionAccounts = false;
  const args = [...input];
  if (args[0] === '--') args.shift();
  if (args[0] === '--allow-subscription-accounts') { args.shift(); allowSubscriptionAccounts = true; }
  const checkedArgs = validateMagpieArguments(args);
  const installed = await verifyMagpieInstallation({ root });
  const { buildManagedEnvironment, ensureManagedDirectories, acquireManagedProfileLock } = await import('../plugins/rein-router/managed-gateway.mjs');
  const env = buildManagedEnvironment({ homeDir: magpiePaths(root).homeDir,
    baseUrl: 'http://127.0.0.1:3425/v1', environment, allowSubscriptionAccounts });
  await ensureManagedDirectories(env);
  const release = await acquireManagedProfileLock(magpiePaths(root).homeDir);
  try { return await new Promise((resolveRun, reject) => {
    const child = spawn(installed.binaryPath, checkedArgs, { cwd: magpiePaths(root).homeDir, env, stdio: 'inherit', shell: false });
    const handlers = new Map();
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => { try { child.kill(signal); } catch { /* child already settled */ } };
      handlers.set(signal, handler); process.on(signal, handler);
    }
    const cleanup = () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
    child.once('error', () => { cleanup(); reject(new Error('magpie_project_command_failed_to_start')); });
    child.once('close', (code, signal) => { cleanup(); resolveRun(code ?? (signal === 'SIGINT' ? 130 : 1)); });
  }); } finally { await release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await runMagpie(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
