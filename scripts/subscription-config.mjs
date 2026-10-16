import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenClawFragment } from '../plugins/rein-router/policy.mjs';

// Offline only: stdout is a reviewable fragment, never a runtime config write.
try {
  if (!process.argv[2]) throw new Error('Usage: node scripts/subscription-config.mjs <router-config.json> [absolute-plugin-path]');
  let config;
  try { config = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8')); }
  catch { throw new Error('rein_router_input_invalid: readable JSON configuration required'); }
  const pluginPath = process.argv[3] ?? fileURLToPath(new URL('../plugins/rein-router', import.meta.url));
  process.stdout.write(`${JSON.stringify(buildOpenClawFragment(config, pluginPath), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
