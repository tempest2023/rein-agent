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

// The default development entry registers the status and synthetic simulation tools. This check
// runs against an isolated, explicit config so it never depends on local runtime state: a developer
// who has enabled the MVP block in the gitignored runtime config must not change this result.
const baseTemp = mkdtempSync(join(tmpdir(), 'rein-openclaw-default-tools-'));
try {
  const baseConfigPath = join(baseTemp, 'openclaw.json');
  writeFileSync(baseConfigPath, JSON.stringify({
    plugins: {
      allow: ['rein-operations'],
      load: { paths: [resolve(root, 'plugins/rein-operations')] },
      entries: { 'rein-operations': { enabled: true } },
    },
  }, null, 2));
  const { report } = inspectPlugin({
    ...environment(),
    OPENCLAW_STATE_DIR: baseTemp,
    OPENCLAW_CONFIG_PATH: baseConfigPath,
  });
  assert.equal(report.plugin.id, 'rein-operations');
  assert.equal(report.plugin.imported, true, 'Runtime module was not imported');
  assert.notEqual(report.plugin.status, 'error', report.plugin.error);
  assert.deepEqual(report.tools.flatMap(tool => tool.names), ['rein_status', 'rein_simulate_vote', 'rein_simulate_proposal']);
  assert.equal(report.diagnostics.filter(item => item.level === 'error').length, 0);
  console.log('Verified real OpenClaw loader: rein-operations imported; status and synthetic simulation tools registered; no plugin errors.');
} finally {
  rmSync(baseTemp, { recursive: true, force: true });
}

// The MVP read slice registers only from explicit configuration, and the Supabase key comes from the
// server environment. The dummy values below never leave this process; no live call is made.
const MVP_KEY_ENV = 'REIN_TEST_MVP_LOADER_SERVICE_KEY';
const MVP_URL_ENV = 'REIN_TEST_MVP_LOADER_URL';
const MVP_KEY = 'sb_secret_loader_test_0000000000000000';
// The proposal confirmation signing key is a second server-only secret this slice needs; the loader
// check injects a dummy value so registration can complete without touching a real secret.
const MVP_CONFIRM_ENV = 'REIN_TEST_MVP_LOADER_CONFIRMATION_KEY';
const MVP_CONFIRM_KEY = 'loader-test-proposal-confirmation-key-0001';
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
            foundationDb: {
              enabled: true,
              platform: 'slack',
              slackTeamId: 'T0123456ABC',
              environment: 'dev',
              proposalChannelIds: ['C_PROPOSAL'],
              boardChannelIds: ['C_BOARD'],
              supabaseUrlEnvVar: MVP_URL_ENV,
              supabaseServiceKeyEnvVar: MVP_KEY_ENV,
              proposalConfirmationKeyEnvVar: MVP_CONFIRM_ENV,
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
    [MVP_CONFIRM_ENV]: MVP_CONFIRM_KEY,
  });
  assert.equal(mvp.report.plugin.imported, true);
  assert.notEqual(mvp.report.plugin.status, 'error', mvp.report.plugin.error);
  assert.deepEqual(
    mvp.report.tools.flatMap(tool => tool.names),
    [
      'rein_member_status', 'rein_funds', 'rein_poll_candidates', 'rein_vote_type_resolve',
      'rein_governance_proposal_submit', 'rein_poll_open', 'rein_poll_vote', 'rein_poll_result',
      'rein_proposal_collect',
      'rein_proposal_comment_suggest', 'rein_revision_approve', 'rein_revision_apply',
      'rein_status',
    ],
  );
  assert.equal(mvp.report.diagnostics.filter(item => item.level === 'error').length, 0);
  assert.ok(!mvp.stdout.includes(MVP_KEY), 'the service key must never appear in loader output');
  assert.ok(!mvp.stdout.includes(MVP_CONFIRM_KEY), 'the confirmation key must never appear in loader output');
  console.log('Verified real OpenClaw loader: configured MVP read, write and post-result feedback tools registered; simulators and legacy proposal tools hidden; no plugin errors.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
