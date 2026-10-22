import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const browserRoot = fileURLToPath(new URL('../', import.meta.url));
export const browserPin = JSON.parse(readFileSync(resolve(browserRoot, 'config/agent-browser.lock.json'), 'utf8'));
export const browserPackage = resolve(browserRoot, '.toolchain/agent-browser', browserPin.version);
export const binaryName = `agent-browser-${process.platform}-${process.arch}`;
export const browserBinary = join(browserPackage, 'bin', binaryName);

export function verifyBrowser(directory = browserPackage) {
  const expected = browserPin.binaries[binaryName];
  if (!expected) throw new Error('Supported hosts: macOS and glibc Linux, arm64/x64.');
  const binary = join(directory, 'bin', binaryName);
  if (!existsSync(binary)) throw new Error('Run npm run browser:setup first.');
  if (createHash('sha256').update(readFileSync(binary)).digest('hex') !== expected) {
    throw new Error('agent-browser binary digest differs from the reviewed release. Run browser:setup.');
  }
  if (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version !== browserPin.version ||
      !existsSync(join(directory, 'skill-data/core/SKILL.md'))) throw new Error('Incomplete agent-browser package.');
  return binary;
}

export async function setupBrowser() {
  if (existsSync(browserPackage)) { verifyBrowser(); return; }
  if (!browserPin.binaries[binaryName]) throw new Error('Unsupported platform; see docs/agent-browser.md.');
  const parent = resolve(browserPackage, '..');
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, '.install-'));
  try {
    const response = await fetch(browserPin.tarball, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Package download failed: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
    if (integrity !== browserPin.integrity) throw new Error('agent-browser package integrity mismatch.');
    // Extract only the current platform and the unmodified official skill bundle.
    // npm's package includes every platform binary; no install scripts are needed.
    const result = spawnSync('tar', ['-xz', '-C', staging, '--strip-components=1',
      `package/bin/${binaryName}`, 'package/skill-data', 'package/skills', 'package/LICENSE', 'package/package.json',
      'package/cli/src/native/a11y'],
    { input: archive, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Package extraction failed: ${result.stderr}`);
    chmodSync(join(staging, 'bin', binaryName), 0o755);
    verifyBrowser(staging);
    renameSync(staging, browserPackage);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--check')) verifyBrowser(); else await setupBrowser();
    console.log(`agent-browser ${browserPin.version}: verified native CLI and official skills.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
