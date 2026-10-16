import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export function magpiePaths(root = projectRoot) {
  root = resolve(root);
  const binary = join(root, '.toolchain/magpie-bin', process.platform === 'win32' ? 'magpie.exe' : 'magpie');
  return { root, source: join(root, '.toolchain/magpie'), binary, receipt: `${binary}.json`,
    lock: join(root, 'plugins/rein-router/magpie.lock.json'), homeDir: join(root, 'runtime/magpie/home') };
}

export function readMagpieLock(root = projectRoot) {
  const lock = JSON.parse(readFileSync(magpiePaths(root).lock, 'utf8'));
  if (lock.schemaVersion !== 1 || lock.repository !== 'https://github.com/yetone/magpie.git' ||
      !/^[a-f0-9]{40}$/.test(lock.revision) || lock.version !== `rein-${lock.revision.slice(0, 12)}` ||
      !/^\d+\.\d+\.\d+$/.test(lock.goVersion) ||
      JSON.stringify(lock.buildTags) !== '["nogui"]') throw new Error('magpie_dependency_invalid_lock');
  return Object.freeze(lock);
}

export function magpieBuildCommand(lock, binaryPath) {
  return { command: 'go', args: ['build', '-mod=readonly', '-tags', 'nogui', '-trimpath', '-buildvcs=false',
    '-ldflags', `-s -w -X main.version=${lock.version}`, '-o', binaryPath, '.'] };
}

/** Share the native headless build environment with integration fixtures. */
export function magpieBuildEnvironment(root = projectRoot, environment = process.env) {
  const env = { ...environment, CGO_ENABLED: '0', GOTOOLCHAIN: 'auto', GOENV: 'off', GOFLAGS: '',
    GOWORK: 'off', GOEXPERIMENT: '', GOCACHE: join(resolve(root), '.toolchain/magpie-go-cache'),
    GOMODCACHE: join(resolve(root), '.toolchain/magpie-go-mod') };
  delete env.GOOS; delete env.GOARCH;
  return env;
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Filesystem-only verification; never launch a process or fetch an update. */
export async function verifyMagpieInstallation({ root = projectRoot, binaryPath } = {}) {
  const paths = magpiePaths(root);
  if (binaryPath !== undefined && !isAbsolute(binaryPath)) throw new Error('magpie_binary_path_must_be_absolute');
  const binary = binaryPath ?? paths.binary;
  const lock = readMagpieLock(root);
  let receipt;
  try {
    if (!lstatSync(binary).isFile() || !lstatSync(`${binary}.json`).isFile() || lstatSync(`${binary}.json`).size > 4096) throw new Error();
    receipt = JSON.parse(readFileSync(`${binary}.json`, 'utf8'));
  } catch { throw new Error('magpie_dependency_not_prepared'); }
  if (receipt.revision !== lock.revision || receipt.version !== lock.version ||
      !/^[a-f0-9]{64}$/.test(receipt.sha256) || await sha256File(binary) !== receipt.sha256)
    throw new Error('magpie_dependency_receipt_mismatch');
  // Portable mode overrides XDG isolation, so never accept a portable runtime.
  if (existsSync(join(dirname(binary), '.portable')) || existsSync(join(dirname(binary), 'data')))
    throw new Error('magpie_dependency_portable_mode_disallowed');
  return { binaryPath: binary, receipt, lock, homeDir: paths.homeDir };
}

async function runProcess(command, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { if (stdout.length < 524288) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 524288) stderr += chunk; });
    child.once('error', () => reject(new Error(`magpie_dependency_${command}_unavailable`)));
    child.once('close', code => resolveRun({ code, stdout, stderr }));
  });
}

/** Explicit project setup: pinned source -> native CLI, never go install or a daemon. */
export async function bootstrapMagpie({ root = projectRoot, run = runProcess, environment = process.env } = {}) {
  const paths = magpiePaths(root);
  const lock = readMagpieLock(root);
  const checked = async (command, args, options, label) => {
    const result = await run(command, args, options);
    if (result.code !== 0) throw new Error(`magpie_dependency_${label}_failed`);
    return result.stdout.trim();
  };
  mkdirSync(dirname(paths.source), { recursive: true });
  if (!existsSync(paths.source)) await checked('git', ['clone', '--filter=blob:none', lock.repository, paths.source],
    { cwd: paths.root, env: environment }, 'clone');
  const git = (args, label) => checked('git', args, { cwd: paths.source, env: environment }, label);
  if (await git(['remote', 'get-url', 'origin'], 'origin') !== lock.repository)
    throw new Error('magpie_dependency_unexpected_origin');
  if (await git(['status', '--porcelain', '--untracked-files=all'], 'status'))
    throw new Error('magpie_dependency_source_dirty');
  let revision = await git(['rev-parse', 'HEAD'], 'revision');
  if (revision !== lock.revision) {
    await git(['fetch', '--depth=1', 'origin', lock.revision], 'fetch');
    await git(['checkout', '--detach', lock.revision], 'checkout');
    revision = await git(['rev-parse', 'HEAD'], 'revision');
  }
  if (revision !== lock.revision || await git(['status', '--porcelain', '--untracked-files=all'], 'status'))
    throw new Error('magpie_dependency_source_mismatch');
  const mod = readFileSync(join(paths.source, 'go.mod'), 'utf8');
  if (!/^module github\.com\/yetone\/magpie\s*$/m.test(mod) ||
      mod.match(/^go (\S+)$/m)?.[1] !== lock.goVersion) throw new Error('magpie_dependency_go_version_mismatch');
  mkdirSync(dirname(paths.binary), { recursive: true });
  if (existsSync(join(dirname(paths.binary), '.portable')) || existsSync(join(dirname(paths.binary), 'data')))
    throw new Error('magpie_dependency_portable_mode_disallowed');
  const temporary = `${paths.binary}.build-${randomUUID()}`;
  const receiptTemporary = `${paths.receipt}.build-${randomUUID()}`;
  const build = magpieBuildCommand(lock, temporary);
  const buildEnv = magpieBuildEnvironment(paths.root, environment);
  try {
    await checked(build.command, build.args, { cwd: paths.source, env: buildEnv }, 'build');
    if (await git(['status', '--porcelain', '--untracked-files=all'], 'status'))
      throw new Error('magpie_dependency_source_changed_during_build');
    const receipt = { revision: lock.revision, version: lock.version, sha256: await sha256File(temporary) };
    writeFileSync(receiptTemporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, paths.binary);
    renameSync(receiptTemporary, paths.receipt);
    return verifyMagpieInstallation({ root: paths.root });
  } finally {
    rmSync(temporary, { force: true }); rmSync(receiptTemporary, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2).filter(arg => arg !== '--');
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    console.error('Usage: node scripts/magpie-dependency.mjs [--check]'); process.exitCode = 1;
  } else {
    try {
      const prepared = args[0] === '--check' ? await verifyMagpieInstallation() : await bootstrapMagpie();
      console.log(`Project Magpie dependency ready: ${prepared.lock.version}`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
