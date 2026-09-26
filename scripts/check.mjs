import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = p => readFileSync(resolve(root, p), 'utf8');
for (const p of ['README.md', 'README-zh.md', 'AGENTS.md', 'workspace/AGENTS.md', 'workspace/SOUL.md', 'workspace/IDENTITY.md', 'docs/architecture.md', 'docs/roadmap.md', 'docs/setup.md', 'docs/decisions.md', 'assets/brand/README.md', 'templates/proposal.md', 'templates/board-brief.md', 'templates/outcome.md', 'templates/weekly-summary.md']) {
  assert.ok(existsSync(resolve(root, p)) && read(p).trim(), `Missing/empty: ${p}`);
}
const config = JSON.parse(read('config/operations.example.json'));
assert.equal(config.status, 'draft-unapproved');
assert.equal(config.automationEnabled, false);
function unconfigured(value, path = '') {
  for (const [key, item] of Object.entries(value)) {
    if (key === 'status' || key === 'automationEnabled') continue;
    if (item && typeof item === 'object') unconfigured(item, `${path}${key}.`);
    else assert.equal(item, null, `Example policy must stay unapproved: ${path}${key}`);
  }
}
unconfigured(config);
const hashes = JSON.parse(read('docs/source-hashes.json'));
for (const [source, expected] of Object.entries(hashes)) {
  const path = source === 'README.md' ? 'docs/foundation-implementation-snapshot.md' : source;
  const actual = createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
  assert.equal(actual, expected, `Source snapshot changed: ${path}`);
}
for (const p of ['docs/PRD-agent-community-operations-zh.md', 'docs/PRD-agent-community-operations.md']) {
  for (let i = 1; i <= 20; i++) assert.ok(read(p).includes(`AC${String(i).padStart(2, '0')}`), `${p}: missing acceptance criterion ${i}`);
}
const manifest = JSON.parse(read('plugins/rein-operations/openclaw.plugin.json'));
const pluginPackage = JSON.parse(read('plugins/rein-operations/package.json'));
assert.equal(manifest.id, 'rein-operations');
assert.deepEqual(manifest.contracts.tools, [
  'rein_status', 'rein_simulate_vote', 'rein_simulate_proposal',
  'rein_proposal_create', 'rein_proposal_revise', 'rein_proposal_confirm', 'rein_proposal_submit',
  'rein_mvp_my_status', 'rein_mvp_funds',
  'rein_mvp_proposal_submit', 'rein_mvp_poll_open', 'rein_mvp_vote', 'rein_mvp_poll_result',
  'rein_mvp_proposal_comment_suggest', 'rein_mvp_revision_approve', 'rein_mvp_revision_apply',
]);
// The MVP read slice registers only from explicit configuration, and it names server environment
// variables instead of carrying the Supabase URL or key in plugin config.
const mvpSchema = manifest.configSchema.properties.mvp;
assert.equal(mvpSchema.additionalProperties, false, 'mvp config block must reject unknown keys');
assert.deepEqual(Object.keys(mvpSchema.properties).sort(), [
  'boardChannelIds', 'enabled', 'environment', 'platform', 'proposalChannelIds', 'slackTeamId',
  'supabaseServiceKeyEnvVar', 'supabaseUrlEnvVar',
]);
for (const field of ['supabaseUrlEnvVar', 'supabaseServiceKeyEnvVar']) {
  assert.match(mvpSchema.properties[field].description, /environment variable/i, `mvp.${field} must name a server environment variable`);
}
assert.ok(existsSync(resolve(root, 'plugins/rein-operations/mvp-read-tools.ts')), 'Missing plugins/rein-operations/mvp-read-tools.ts');
assert.ok(pluginPackage.files.includes('mvp-read-tools.ts'), 'package files must ship mvp-read-tools.ts');
assert.ok(pluginPackage.files.includes('foundation-db-reader.ts'), 'package files must ship foundation-db-reader.ts');
assert.ok(read('plugins/rein-operations/index.ts').includes('./mvp-read-tools.ts'), 'index.ts must register the MVP read tools');
for (const p of ['mvp-write-tools.ts', 'foundation-db-writer.ts', 'mvp-vote-tally.ts']) {
  assert.ok(
    existsSync(resolve(root, 'plugins/rein-operations', p)),
    `Missing plugins/rein-operations/${p}`,
  );
  assert.ok(pluginPackage.files.includes(p), `package files must ship ${p}`);
}
assert.ok(read('plugins/rein-operations/index.ts').includes('./mvp-write-tools.ts'), 'index.ts must register the MVP write tools');
// The MVP write slice is the only write path registered, and a vote outcome never moves money.
assert.ok(
  !/rein_mvp_(poll_open|vote|poll_result)[\s\S]{0,400}(pay|transfer|disburse|reserve)/i.test(read('plugins/rein-operations/mvp-write-tools.ts')),
  'mvp-write-tools.ts must not move money',
);
// The post-result feedback slice registers from the same explicit block, and the manifest
// description must not go stale: an ordinary title/summary revision is accepted and applied by the
// Agent, while a material revision waits for one recorded current director approval.
assert.ok(existsSync(resolve(root, 'plugins/rein-operations/mvp-feedback-tools.ts')), 'Missing plugins/rein-operations/mvp-feedback-tools.ts');
assert.ok(pluginPackage.files.includes('mvp-feedback-tools.ts'), 'package files must ship mvp-feedback-tools.ts');
assert.ok(pluginPackage.files.includes('mvp-proposal-feedback.ts'), 'package files must ship mvp-proposal-feedback.ts');
assert.ok(read('plugins/rein-operations/index.ts').includes('./mvp-feedback-tools.ts'), 'index.ts must register the MVP feedback tools');
const mvpDescription = mvpSchema.description;
assert.ok(
  !/open decision|still (?:be )?(?:an )?open|not (?:yet )?(?:decided|confirmed)|unresolved/i.test(mvpDescription),
  'the mvp description must not carry stale unresolved text about the ordinary revision rule',
);
assert.ok(
  /ordinary/i.test(mvpDescription) && /title or the summary/i.test(mvpDescription),
  'the mvp description must state the ordinary title/summary revision rule it supersedes',
);
// The negative claim is about actions, not prose: the same shape the write slice is held to, where
// the money words may appear only in the comment that denies them. A revision never authorizes
// spending, so no tool in this slice may reach a payment or reservation path.
assert.ok(
  !/rein_mvp_(revision_apply|revision_approve|proposal_comment_suggest)[\s\S]{0,800}(pay|transfer|disburse|reservation)\s*\(/i.test(
    read('plugins/rein-operations/mvp-feedback-tools.ts'),
  ),
  'mvp-feedback-tools.ts must not move money',
);
assert.ok(
  /authorizesSpending: false/.test(read('plugins/rein-operations/mvp-feedback-tools.ts')),
  'every feedback result must state that it authorizes no spending',
);
for (const p of ['plugins/rein-operations/openclaw.plugin.json', 'plugins/rein-operations/mvp-read-tools.ts', 'plugins/rein-operations/mvp-write-tools.ts', 'plugins/rein-operations/index.ts']) {
  assert.ok(!/(eyJ[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_]{8,})/.test(read(p)), `${p} must not contain a credential literal`);
}
for (const entry of pluginPackage.openclaw.extensions) assert.ok(existsSync(resolve(root, 'plugins/rein-operations', entry)));
assert.ok(read('.gitmodules').includes('https://github.com/openclaw/openclaw.git'));
assert.ok(existsSync(resolve(root, 'workspace/avatars/rein-agent.png')));
console.log('Scaffold OK: required files, unapproved example policy, source hashes, plugin tool contracts, AC01–AC20. No production integration tested.');
