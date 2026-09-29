import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { environment, root, upstream, requireSource } from './runtime-env.mjs';

requireSource();
const temp = mkdtempSync(join(tmpdir(), 'rein-openclaw-proposal-tools-'));
try {
  const configPath = join(temp, 'openclaw.json');
  writeFileSync(configPath, JSON.stringify({
    plugins: {
      allow: ['rein-operations'],
      load: { paths: [resolve(root, 'plugins/rein-operations')] },
      entries: {
        'rein-operations': {
          enabled: true,
          config: {
            proposalTools: {
              enabled: true,
              platform: 'discord',
              allowedNativeChannelIds: ['synthetic-proposal-room'],
              statePath: join(temp, 'proposals.json'),
            },
          },
        },
      },
    },
  }, null, 2));
  const result = spawnSync('pnpm', ['--silent', 'openclaw', 'plugins', 'inspect', 'rein-operations', '--runtime', '--json'], {
    cwd: upstream,
    env: { ...environment(), OPENCLAW_STATE_DIR: temp, OPENCLAW_CONFIG_PATH: configPath },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.plugin.imported, true);
  assert.notEqual(report.plugin.status, 'error', report.plugin.error);
  assert.deepEqual(report.tools.flatMap(tool => tool.names), [
    'rein_proposal_create', 'rein_proposal_revise', 'rein_proposal_confirm', 'rein_proposal_submit',
    'rein_status', 'rein_simulate_vote', 'rein_simulate_proposal',
  ]);
  assert.equal(report.diagnostics.filter(item => item.level === 'error').length, 0);
  console.log('Verified configured v2 proposal tools through the real OpenClaw loader.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
