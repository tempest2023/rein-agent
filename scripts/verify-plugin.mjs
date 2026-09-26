import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { environment, root, upstream, requireSource } from './runtime-env.mjs';
requireSource();

function inspectPlugin(env) {
  const result = spawnSync('pnpm', ['--silent', 'openclaw', 'plugins', 'inspect', 'rein-operations', '--runtime', '--json'], {
    cwd: upstream, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stdout);
  return { report: JSON.parse(result.stdout), stdout: result.stdout };
}

const { report } = inspectPlugin(environment());
assert.equal(report.plugin.id, 'rein-operations');
assert.equal(report.plugin.imported, true, 'Runtime module was not imported');
assert.notEqual(report.plugin.status, 'error', report.plugin.error);
assert.deepEqual(report.tools.flatMap(tool => tool.names), ['rein_status', 'rein_simulate_vote', 'rein_simulate_proposal']);
assert.equal(report.diagnostics.filter(item => item.level === 'error').length, 0);
console.log('Verified real OpenClaw loader: rein-operations imported; status and synthetic simulation tools registered; no plugin errors.');

// The MVP read slice registers only from explicit configuration, and the Supabase key comes from the
// server environment. The dummy values below never leave this process; no live call is made.
const MVP_KEY_ENV = 'REIN_TEST_MVP_LOADER_SERVICE_KEY';
const MVP_URL_ENV = 'REIN_TEST_MVP_LOADER_URL';
const MVP_KEY = 'sb_secret_loader_test_0000000000000000';
const temp = mkdtempSync(join(tmpdir(), 'rein-openclaw-mvp-read-tools-'));
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
            mvp: {
              enabled: true,
              platform: 'slack',
              slackTeamId: 'T0123456ABC',
              environment: 'dev',
              proposalChannelIds: ['C_PROPOSAL'],
              boardChannelIds: ['C_BOARD'],
              supabaseUrlEnvVar: MVP_URL_ENV,
              supabaseServiceKeyEnvVar: MVP_KEY_ENV,
            },
          },
        },
      },
    },
  }, null, 2));
  const mvp = inspectPlugin({
    ...environment(),
    OPENCLAW_STATE_DIR: temp,
    OPENCLAW_CONFIG_PATH: configPath,
    [MVP_URL_ENV]: 'https://project-ref.supabase.co',
    [MVP_KEY_ENV]: MVP_KEY,
  });
  assert.equal(mvp.report.plugin.imported, true);
  assert.notEqual(mvp.report.plugin.status, 'error', mvp.report.plugin.error);
  assert.deepEqual(
    mvp.report.tools.flatMap(tool => tool.names),
    [
      'rein_mvp_my_status', 'rein_mvp_funds',
      'rein_mvp_proposal_submit', 'rein_mvp_poll_open', 'rein_mvp_vote', 'rein_mvp_poll_result',
      'rein_mvp_proposal_comment_suggest', 'rein_mvp_revision_approve', 'rein_mvp_revision_apply',
      'rein_status',
    ],
  );
  assert.equal(mvp.report.diagnostics.filter(item => item.level === 'error').length, 0);
  assert.ok(!mvp.stdout.includes(MVP_KEY), 'the service key must never appear in loader output');
  console.log('Verified real OpenClaw loader: configured MVP read, write and post-result feedback tools registered; simulators and legacy proposal tools hidden; no plugin errors.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
