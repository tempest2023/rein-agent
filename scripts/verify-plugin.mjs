import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { environment, upstream, requireSource } from './runtime-env.mjs';
requireSource();
const result = spawnSync('pnpm', ['--silent', 'openclaw', 'plugins', 'inspect', 'rein-operations', '--runtime', '--json'], {
  cwd: upstream, env: environment(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
});
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stdout);
const report = JSON.parse(result.stdout);
assert.equal(report.plugin.id, 'rein-operations');
assert.equal(report.plugin.imported, true, 'Runtime module was not imported');
assert.notEqual(report.plugin.status, 'error', report.plugin.error);
assert.deepEqual(report.tools.flatMap(tool => tool.names), ['rein_status']);
assert.equal(report.diagnostics.filter(item => item.level === 'error').length, 0);
console.log('Verified real OpenClaw loader: rein-operations imported; rein_status registered; no plugin errors.');
