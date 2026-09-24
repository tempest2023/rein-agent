import { existsSync, readFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
export const root = fileURLToPath(new URL('../', import.meta.url));
export const upstream = resolve(root, 'vendor/openclaw');
export function environment() {
  const localBin = resolve(root, '.toolchain/node_modules/.bin');
  return {
    ...process.env,
    PATH: [existsSync(localBin) ? localBin : '', process.env.PATH].filter(Boolean).join(delimiter),
    OPENCLAW_STATE_DIR: resolve(root, 'runtime/openclaw'),
    OPENCLAW_CONFIG_PATH: resolve(root, 'runtime/openclaw/openclaw.json'),
  };
}
export function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env: environment(), stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
export function requireSource() {
  if (!existsSync(resolve(upstream, 'package.json'))) throw new Error('Run git submodule update --init --recursive first.');
  return JSON.parse(readFileSync(resolve(upstream, 'package.json'), 'utf8'));
}
