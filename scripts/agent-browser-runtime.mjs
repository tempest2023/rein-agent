import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { browserRoot, verifyBrowser } from './agent-browser-dependency.mjs';

export function validName(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(value ?? '')) throw new Error('Use a name of 1–48 letters, digits, underscores or hyphens.');
  return value;
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('Browser storage must be a real directory.');
  chmodSync(path, 0o700);
}

export function browserContext({ root = browserRoot, instance = process.env.NORI_BROWSER_INSTANCE ?? 'operator', home = homedir() } = {}) {
  validName(instance);
  root = realpathSync(root);
  const namespace = `nori-${createHash('sha256').update(realpathSync(root) + '\0' + instance).digest('hex').slice(0, 12)}`;
  const local = resolve(root, 'runtime/agent-browser', instance);
  const native = join(home, '.agent-browser');
  return { namespace, local, keyFile: join(local, 'encryption-key'),
    directories: [join(root, 'runtime'), join(root, 'runtime/agent-browser'), local,
      native, join(native, 'auth'), join(native, 'namespaces'), join(native, 'namespaces', namespace)],
    authDir: join(native, 'auth'), stateDir: join(native, 'namespaces', namespace, 'state'),
    socketDir: join(native, 'namespaces', namespace, 'run'),
    profile: alias => `${namespace}-${validName(alias)}` };
}

export function browserEnvironment(context, inherited = process.env) {
  for (const directory of context.directories) privateDirectory(directory);
  if (!existsSync(context.keyFile)) {
    const hasProfiles = existsSync(context.authDir) && readdirSync(context.authDir).some(n => n.startsWith(context.namespace + '-'));
    const hasStates = existsSync(join(context.stateDir, 'sessions')) && readdirSync(join(context.stateDir, 'sessions')).length > 0;
    if (hasProfiles || hasStates) throw new Error('Nori encryption key is missing. Restore its backup before using existing credentials or sessions.');
    try { writeFileSync(context.keyFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const keyStat = lstatSync(context.keyFile);
  if (!keyStat.isFile() || keyStat.isSymbolicLink() || keyStat.nlink !== 1) throw new Error('Nori encryption key must be a regular, unlinked file.');
  const key = readFileSync(context.keyFile, 'utf8').trim();
  if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Error('Nori encryption key is invalid; restore it from backup.');
  chmodSync(context.keyFile, 0o600);
  privateDirectory(context.stateDir);
  privateDirectory(join(context.stateDir, 'sessions'));
  privateDirectory(context.socketDir);
  // Do not inherit another agent's CDP endpoint, vault key, provider or auto-connect.
  const env = Object.fromEntries(Object.entries(inherited).filter(([name]) => !name.startsWith('AGENT_BROWSER_')));
  env.AGENT_BROWSER_ENCRYPTION_KEY = key;
  env.AGENT_BROWSER_NAMESPACE = context.namespace;
  // Keep the socket location deterministic even on hosts with XDG_RUNTIME_DIR set.
  env.AGENT_BROWSER_SOCKET_DIR = resolve(context.authDir, '..');
  env.AGENT_BROWSER_CONFIG = resolve(browserRoot, 'config/agent-browser.json');
  if (inherited.NORI_BROWSER_EXECUTABLE_PATH) env.AGENT_BROWSER_EXECUTABLE_PATH = inherited.NORI_BROWSER_EXECUTABLE_PATH;
  return env;
}

export function parseBrowserArgs(input) {
  const args = [...input];
  // pnpm run may preserve npm's conventional argument separator.
  if (args[0] === '--') args.shift();
  const options = { json: false, headed: false };
  while (args.length) {
    if (args[0] === '--session') { args.shift(); options.session = validName(args.shift()); }
    else if (args[0] === '--json') { args.shift(); options.json = true; }
    else if (args[0] === '--headed') { args.shift(); options.headed = true; }
    else break;
  }
  // These overrides would leave the wrapper's managed local session or key scope.
  const reserved = new Set(['--namespace', '--config', '--session', '--session-name', '--restore', '--restore-save',
    '--state', '--profile', '--cdp', '--auto-connect', '--provider', '-p', '--credential-provider', '--item', '--password', '--allowed-domains',
    '--args', '--executable-path', '--engine', '--extension']);
  if (args.some(arg => reserved.has(arg.split('=')[0]))) throw new Error('Unsupported override for Nori local browser. Password enrollment requires --password-stdin.');
  if (!args.length || (args[0].startsWith('-') && !['--help', '--version'].includes(args[0]))) throw new Error('Use --session, --json or --headed before the command; see the Nori browser skill.');
  if (args[0] === 'auth') {
    if (!['save', 'login', 'show', 'delete', 'list'].includes(args[1])) throw new Error('Unsupported auth command.');
    if (args[1] !== 'list') validName(args[2]);
    if (args[1] === 'save' && !args.includes('--password-stdin')) throw new Error('Use auth save with --password-stdin from an operator terminal.');
    if (args[1] === 'login' && args.some(a => a.split('=')[0] === '--url')) throw new Error('Use the saved login origin; URL overrides are disabled.');
  }
  const offline = ['skills', '--version', '--help', 'install'].includes(args[0]) ||
    (args[0] === 'auth' && args[1] !== 'login');
  if (!offline && !options.session) throw new Error('Pass --session <account-task> before the command. Keep it stable when resuming.');
  if (['mcp', 'upgrade', 'plugin', 'connect', 'batch'].includes(args[0]) || (args[0] === 'state' && args[1] === 'load')) {
    throw new Error('This command bypasses the pinned local workflow. Use individual commands in the managed Nori session.');
  }
  return { ...options, args };
}

export function nativeArgs(context, options, command = options.args) {
  const args = [...command];
  if (args[0] === 'auth' && args[1] !== 'list') args[2] = context.profile(args[2]);
  return ['--config', resolve(browserRoot, 'config/agent-browser.json'), '--namespace', context.namespace,
    ...(options.session ? ['--session', options.session, '--restore'] : []),
    ...(options.json ? ['--json'] : []), ...(options.headed ? ['--headed'] : []), ...args];
}

export function runNative(binary, args, env, { capture = false, input, timeout = 90_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { env, timeout, stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'] });
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolvePromise({ code: code ?? 1, signal, stdout, stderr }));
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

export async function waitForBrowserClose(context, session = 'default', timeoutMs = 10_000) {
  // v0.39.1 acknowledges close before its delayed daemon shutdown. An immediate
  // Linux relaunch can otherwise reach that dying daemon and lose the new browser.
  const deadline = Date.now() + timeoutMs;
  const files = ['pid', 'sock'].map(extension => join(context.socketDir, `${validName(session)}.${extension}`));
  while (files.some(file => existsSync(file))) {
    if (Date.now() >= deadline) throw new Error('Browser close is still pending; inspect the session before resuming.');
    await delay(25);
  }
}

export function createBrowserRunner(context, options, inherited = process.env) {
  const binary = verifyBrowser();
  const env = browserEnvironment(context, inherited);
  return async command => {
    const result = await runNative(binary, nativeArgs(context, { ...options, json: true }, command), env, { capture: true });
    let response;
    try { response = JSON.parse(result.stdout); } catch { throw new Error('Browser returned no structured result; inspect current state before retrying.'); }
    if (result.code !== 0 || !response.success) {
      // Avoid copying raw site or credential-related output into a recovery error.
      throw new Error('Browser command failed or outcome is unknown; inspect current state before retrying.');
    }
    if (['close', 'quit', 'exit'].includes(command[0]) && response.data?.closed) await waitForBrowserClose(context, options.session);
    return response.data;
  };
}
