import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { root, environment, requireSource } from './runtime-env.mjs';
requireSource();
const env = environment();
mkdirSync(env.OPENCLAW_STATE_DIR, { recursive: true, mode: 0o700 });
if (existsSync(env.OPENCLAW_CONFIG_PATH)) {
  console.log('Existing local OpenClaw config preserved.');
} else {
  const config = {
    gateway: { mode: 'local', bind: 'loopback', port: 18791, auth: { mode: 'token', token: randomBytes(32).toString('hex') } },
    agents: { defaults: { workspace: resolve(root, 'workspace') } },
    plugins: { allow: ['rein-operations'], load: { paths: [resolve(root, 'plugins/rein-operations')] }, entries: { 'rein-operations': { enabled: true } } },
  };
  writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Created isolated local config; channels and models remain unconfigured.');
}
