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
  'rein_member_status', 'rein_funds', 'rein_poll_candidates', 'rein_vote_type_resolve',
  'rein_governance_proposal_submit', 'rein_poll_open', 'rein_poll_vote', 'rein_poll_result',
  'rein_proposal_collect',
  'rein_proposal_comment_suggest', 'rein_revision_approve', 'rein_revision_apply',
]);
// The MVP read slice registers only from explicit configuration, and it names server environment
// variables instead of carrying the Supabase URL or key in plugin config.
const mvpSchema = manifest.configSchema.properties.foundationDb;
assert.equal(mvpSchema.additionalProperties, false, 'foundationDb config block must reject unknown keys');
assert.deepEqual(Object.keys(mvpSchema.properties).sort(), [
  'boardChannelIds', 'enabled', 'environment', 'identityEmailMatch', 'platform',
  'proposalChannelIds', 'proposalConfirmationKeyEnvVar', 'slackBotTokenEnvVar', 'slackTeamId',
  'supabaseServiceKeyEnvVar', 'supabaseUrlEnvVar', 'voteTypeAliases',
]);
for (const field of ['supabaseUrlEnvVar', 'supabaseServiceKeyEnvVar', 'proposalConfirmationKeyEnvVar', 'slackBotTokenEnvVar']) {
  assert.match(mvpSchema.properties[field].description, /environment variable/i, `foundationDb.${field} must name a server environment variable`);
}
// Email-first identity matching is opt-in and off by default, so the Slack bot token it needs is
// named but never required while the option is disabled.
assert.deepEqual(mvpSchema.properties.identityEmailMatch.enum, ['enabled', 'disabled']);
assert.equal(mvpSchema.properties.identityEmailMatch.default, 'disabled');
assert.ok(existsSync(resolve(root, 'plugins/rein-operations/slack-email-lookup.ts')), 'Missing plugins/rein-operations/slack-email-lookup.ts');
assert.ok(
  pluginPackage.files.includes('slack-email-lookup.ts'),
  'package files must ship slack-email-lookup.ts',
);
for (const p of ['mvp-read-tools.ts', 'mvp-write-tools.ts', 'mvp-feedback-tools.ts']) {
  const source = read(`plugins/rein-operations/${p}`);
  assert.ok(
    source.includes("from './slack-email-lookup.ts'") &&
      source.includes("identityEmailMatch") &&
      source.includes("slackBotTokenEnvVar"),
    `${p} must wire the opt-in email identity match through its own config check`,
  );
}
assert.ok(existsSync(resolve(root, 'plugins/rein-operations/mvp-read-tools.ts')), 'Missing plugins/rein-operations/mvp-read-tools.ts');
assert.ok(pluginPackage.files.includes('mvp-read-tools.ts'), 'package files must ship mvp-read-tools.ts');
// Spoken-name resolution is operator configuration, not a built-in dictionary: the matcher may
// carry no synonym, translation or production mapping of its own, so the pure resolver stays free
// of any non-ASCII label literal.
assert.ok(existsSync(resolve(root, 'plugins/rein-operations/mvp-vote-type-resolve.ts')), 'Missing plugins/rein-operations/mvp-vote-type-resolve.ts');
assert.ok(pluginPackage.files.includes('mvp-vote-type-resolve.ts'), 'package files must ship mvp-vote-type-resolve.ts');
for (const p of ['mvp-vote-type-resolve.ts', 'mvp-read-tools.ts']) {
  assert.ok(
    !/[\u0080-\uffff]/.test(read(`plugins/rein-operations/${p}`)),
    `${p} must not embed a hardcoded label, synonym or translation; the operator writes the vocabulary`,
  );
}
assert.ok(
  read('plugins/rein-operations/mvp-read-tools.ts').includes("'./mvp-vote-type-resolve.ts'"),
  'mvp-read-tools.ts must resolve phrases through mvp-vote-type-resolve.ts',
);
assert.ok(
  read('plugins/rein-operations/mvp-read-tools.ts').includes('voteTypeAliases'),
  'mvp-read-tools.ts must read the operator-authored voteTypeAliases block',
);
assert.ok(pluginPackage.files.includes('foundation-db-reader.ts'), 'package files must ship foundation-db-reader.ts');
// The proposal confirmation token is minted and verified by this module, and the tool that needs it
// must ship alongside the writer it guards.
assert.ok(existsSync(resolve(root, 'plugins/rein-operations/mvp-proposal-confirmation.ts')), 'Missing plugins/rein-operations/mvp-proposal-confirmation.ts');
assert.ok(pluginPackage.files.includes('mvp-proposal-confirmation.ts'), 'package files must ship mvp-proposal-confirmation.ts');
assert.ok(
  read('plugins/rein-operations/mvp-write-tools.ts').includes('./mvp-proposal-confirmation.ts'),
  'mvp-write-tools.ts must verify the author confirmation through mvp-proposal-confirmation.ts',
);
for (const p of ['plugins/rein-operations/mvp-proposal-confirmation.ts', 'plugins/rein-operations/mvp-write-tools.ts']) {
  assert.ok(
    !/(eyJ[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_]{8,})/.test(read(p)),
    `${p} must not contain a credential literal`,
  );
}
assert.ok(read('plugins/rein-operations/index.ts').includes('./mvp-read-tools.ts'), 'index.ts must register the MVP read tools');
// Multi-turn field collection is read-only. Its draft token is sealed under its own key and prefix,
// so it is a separate domain from the submit confirmation: neither tool accepts the other's token,
// and the collection tool must ship alongside the module that seals its own token.
assert.ok(existsSync(resolve(root, 'plugins/rein-operations/mvp-proposal-draft.ts')), 'Missing plugins/rein-operations/mvp-proposal-draft.ts');
assert.ok(existsSync(resolve(root, 'plugins/rein-operations/mvp-collect-tools.ts')), 'Missing plugins/rein-operations/mvp-collect-tools.ts');
for (const p of ['mvp-proposal-draft.ts', 'mvp-collect-tools.ts']) {
  assert.ok(pluginPackage.files.includes(p), `package files must ship ${p}`);
}
assert.ok(read('plugins/rein-operations/index.ts').includes('./mvp-collect-tools.ts'), 'index.ts must register the MVP proposal collection tool');
assert.ok(read('plugins/rein-operations/index.ts').includes('./mvp-collect-reply-guard.ts'), 'index.ts must register the collect reply guard');
for (const p of ['mvp-collect-reply-guard.ts', 'mvp-poll-reply-guard.ts', 'mvp-vote-reply-guard.ts']) {
  assert.ok(existsSync(resolve(root, 'plugins/rein-operations', p)), `Missing plugins/rein-operations/${p}`);
  assert.ok(pluginPackage.files.includes(p), `package files must ship ${p}`);
}
{
  const collect = read('plugins/rein-operations/mvp-collect-tools.ts');
  // The collection path writes nothing: no submit call, no database write method, and the answer
  // always states that nothing was recorded and that no spending is authorized.
  assert.ok(
    !/submitProposal|createPoll|castBallot|finalizePoll/.test(collect),
    'mvp-collect-tools.ts must not reach a write path',
  );
  assert.ok(
    /recorded: false/.test(collect) && /authorizesSpending: false/.test(collect),
    'every collected answer must state that nothing was recorded and no spending is authorized',
  );
  // The draft domain must be its own prefix and version, and must derive its own key, so a submit
  // confirmation and a draft token can never be read as each other.
  const draft = read('plugins/rein-operations/mvp-proposal-draft.ts');
  assert.ok(/DRAFT_TOKEN_PREFIX = 'rein_proposal_draft'/.test(draft) && /DRAFT_TOKEN_VERSION = 'rpd1'/.test(draft), 'the draft token must carry its own prefix and version');
  assert.ok(
    /rein\.proposal-draft\.hkdf-salt-rpd1/.test(draft) &&
      /rein\.proposal-draft\.aes-256-gcm-rpd1/.test(draft),
    'the draft token must derive its own key with its own salt and label',
  );
  assert.ok(
    /MAX_DRAFT_DOCUMENT_BYTES/.test(draft) && /COLLECT_TOKEN_CAP/.test(draft),
    'the draft token must keep a size fence tied to the cap its schema advertises',
  );
}
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
  !/rein_(poll_open|poll_vote|poll_result)[\s\S]{0,400}(pay|transfer|disburse|reserve)/i.test(read('plugins/rein-operations/mvp-write-tools.ts')),
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
  !/rein_(revision_apply|revision_approve|proposal_comment_suggest)[\s\S]{0,800}(pay|transfer|disburse|reservation)\s*\(/i.test(
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
