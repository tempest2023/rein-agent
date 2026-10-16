import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { importBailianSubscription } from '../scripts/import-bailian-subscription.mjs';
import { acquireManagedProfileLock } from '../plugins/rein-router/managed-gateway.mjs';

const providerId = 'bailian-token-plan';
const envName = 'BAILIAN_TOKEN_PLAN_API_KEY';
const key = 'sk-sp-synthetic-import-secret-0000000000';
const otherKey = 'sk-sp-synthetic-process-secret-1111111111';
const anthropic = 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic';
const chat = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const sourceConfig = () => ({ agents: { defaults: { model: 'existing/unmodified' } }, models: { providers: {
  [providerId]: { baseUrl: anthropic, api: 'anthropic-messages',
    apiKey: { source: 'env', provider: 'default', id: envName },
    models: [{ id: 'auto' }, { id: 'qwen3.8-flash' }] },
} } });

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, stdio: 'ignore' });
  assert.equal(result.status, 0);
}

function fixture(t) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'rein-bailian-import-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  git(projectRoot, ['init', '--quiet']);
  writeFileSync(join(projectRoot, '.gitignore'), 'runtime/\n');
  const sourceDir = join(projectRoot, 'runtime/openclaw'); mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
  const configPath = join(sourceDir, 'openclaw.json'); const envPath = join(sourceDir, '.env');
  const writeSource = config => writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  writeSource(sourceConfig());
  writeFileSync(envPath, `${envName}="${key}"\nUNRELATED_SYNTHETIC_SECRET=private\n`, { mode: 0o600 });
  const destination = join(projectRoot, 'runtime/magpie/config/magpie/providers.json');
  const homeDir = join(projectRoot, 'runtime/magpie/home');
  const writeDestination = value => {
    mkdirSync(join(projectRoot, 'runtime/magpie/config/magpie'), { recursive: true, mode: 0o700 });
    writeFileSync(destination, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
    chmodSync(destination, 0o600);
  };
  const run = overrides => importBailianSubscription({ projectRoot, environment: {}, ...overrides });
  return { projectRoot, sourceDir, configPath, envPath, destination, homeDir, writeSource, writeDestination, run };
}

async function refuses(run, code) {
  await assert.rejects(run, error => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.ok(!JSON.stringify({ message: error.message, ...error }).includes(key));
    return true;
  });
}

test('offline import reuses the existing env SecretRef and exact models in a private project-only provider', async t => {
  const f = fixture(t);
  const beforeConfig = readFileSync(f.configPath); const beforeEnv = readFileSync(f.envPath);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Provider calls are forbidden in an offline import'); };
  let result;
  try { result = await f.run(); } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(result, { providerId, chatBaseUrl: chat, anthropicBaseUrl: anthropic, models: ['auto', 'qwen3.8-flash'] });
  const stored = JSON.parse(readFileSync(f.destination, 'utf8'));
  assert.deepEqual(stored.providers, [{ id: providerId, name: 'Bailian Token Plan', preset: providerId,
    key, chat, anthropic, models: ['auto', 'qwen3.8-flash'] }]);
  assert.equal(statSync(f.destination).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(f.configPath), beforeConfig);
  assert.deepEqual(readFileSync(f.envPath), beforeEnv);
  assert.ok(!JSON.stringify(result).includes(key));
  assert.ok(!Object.hasOwn(stored.providers[0], 'fallback'));
  assert.ok(!Object.hasOwn(stored.providers[0], 'responses'));
  assert.ok(!Object.hasOwn(stored.providers[0], 'decide'));
});

test('an existing process env value takes precedence without copying unrelated credentials', async t => {
  const f = fixture(t);
  await f.run({ environment: { [envName]: otherKey, UNRELATED_SECRET: 'unrelated-value' } });
  const contents = readFileSync(f.destination, 'utf8');
  assert.equal(JSON.parse(contents).providers[0].key, otherKey);
  assert.ok(!contents.includes(key)); assert.ok(!contents.includes('unrelated-value'));
});

test('opaque Token Plan keys retain dots and other printable token punctuation exactly', async t => {
  const f = fixture(t); const opaque = 'sk-sp-synthetic.scope.signature';
  await f.run({ environment: { [envName]: opaque } });
  assert.equal(JSON.parse(readFileSync(f.destination, 'utf8')).providers[0].key, opaque);
});

test('project-local OPENCLAW_STATE_DIR and quoted dotenv values resolve without executing shell syntax', async t => {
  const f = fixture(t); const state = join(f.projectRoot, 'runtime/alternate-state'); mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(state, '.env'), `${envName}='${otherKey}'\nUNRELATED=$(exit 1)\n`, { mode: 0o600 });
  await f.run({ environment: { OPENCLAW_STATE_DIR: state } });
  assert.equal(JSON.parse(readFileSync(f.destination, 'utf8')).providers[0].key, otherKey);
});

test('Chat Completions source uses the same approved China plan endpoints', async t => {
  const f = fixture(t); const config = sourceConfig();
  Object.assign(config.models.providers[providerId], { baseUrl: chat, api: 'openai-completions' });
  f.writeSource(config); await f.run();
  assert.equal(JSON.parse(readFileSync(f.destination, 'utf8')).providers[0].chat, chat);
});

test('atomic merge preserves unrelated providers, groups, ordering and nested configuration', async t => {
  const f = fixture(t);
  const existing = { providers: [{ id: 'existing-provider', name: 'Existing', key: 'synthetic-existing-key',
    contexts: { 'existing/model': 123456 }, accountWindowCaps: { synthetic: { window: { tokens: 1000 } } },
    fallback: ['existing-backup/model'] }], groups: [{ id: 'work', members: ['existing-provider/model'], details: { keep: true } }],
    searches: [{ id: 'synthetic', headers: { 'x-synthetic': 'preserved' } }], noAutoGroups: true,
    order: ['existing-provider'], groupOrder: ['work'], pluginLeft: [{ id: 'synthetic-left', picks: { models: ['a'] } }] };
  f.writeDestination(existing); await f.run();
  const stored = JSON.parse(readFileSync(f.destination, 'utf8'));
  assert.deepEqual(stored.providers[0], existing.providers[0]);
  for (const field of ['groups', 'searches', 'noAutoGroups', 'order', 'groupOrder', 'pluginLeft']) assert.deepEqual(stored[field], existing[field]);
  assert.equal(stored.providers[1].id, providerId);
  assert.ok(!readdirSync(join(f.projectRoot, 'runtime/magpie/config/magpie')).some(name => name.endsWith('.tmp')));
});

test('repeat import refreshes only the Bailian key/models while retaining non-routing metadata', async t => {
  const f = fixture(t);
  f.writeDestination({ providers: [{ id: providerId, name: 'Local China plan', key: key,
    chat, anthropic, models: ['old-fixture'], contexts: { 'qwen3.8-flash': 1000000 }, maxConcurrency: 1 }] });
  await f.run({ environment: { [envName]: otherKey } });
  const stored = JSON.parse(readFileSync(f.destination, 'utf8')).providers;
  assert.equal(stored.length, 1); assert.equal(stored[0].name, 'Local China plan');
  assert.equal(stored[0].key, otherKey); assert.deepEqual(stored[0].models, ['auto', 'qwen3.8-flash']);
  assert.deepEqual(stored[0].contexts, { 'qwen3.8-flash': 1000000 }); assert.equal(stored[0].maxConcurrency, 1);
});

test('source endpoint and credential mismatches cannot import pay-as-you-go access', async t => {
  for (const mutate of [
    provider => { provider.baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1'; },
    provider => { provider.baseUrl = 'https://coding.dashscope.aliyuncs.com/v1'; },
    provider => { provider.api = 'openai-responses'; },
    provider => { provider.apiKey = key; },
    provider => { provider.apiKey.id = 'OTHER_ENV_KEY'; },
    provider => { provider.apiKey.source = 'exec'; },
  ]) {
    const f = fixture(t); const config = sourceConfig(); mutate(config.models.providers[providerId]); f.writeSource(config);
    await assert.rejects(f.run(), error => /^bailian_import_source_(?:provider|credential)_invalid$/.test(error.code));
    assert.equal(existsSync(f.destination), false);
  }
  const f = fixture(t);
  for (const value of ['', 'sk-synthetic-payg-key-0000000000000', `${key}\n`, `$(echo ${key})`]) {
    await refuses(() => f.run({ environment: { [envName]: value } }), 'bailian_import_source_key_invalid');
  }
});

test('invalid, ambiguous and unsupported model IDs fail before creating a Magpie profile', async t => {
  for (const models of [[], [{ id: 'a' }, { id: 'a' }], [{ id: 'provider/model' }], [{ id: 'model:high' }], [{ id: 'with spaces' }], [null]]) {
    const f = fixture(t); const config = sourceConfig(); config.models.providers[providerId].models = models; f.writeSource(config);
    await refuses(f.run, 'bailian_import_source_models_invalid');
    assert.equal(existsSync(join(f.projectRoot, 'runtime/magpie')), false);
  }
});

test('malformed or unknown destination JSON is preserved without unsafe replacement', async t => {
  for (const contents of ['{invalid', '[]', '{}', '{"providers":null}',
    '{"providers":[],"unknown":"SYNTHETIC_SECRET_CANARY"}',
    '{"providers":[{"id":"same"},{"id":"same"}]}',
    '{"providers":[{"id":"existing","key":{"secret":"SYNTHETIC_SECRET_CANARY"}}]}',
    '{"providers":[{"id":"existing","name":{}}]}', '{"providers":[{"id":"existing","models":"invalid"}]}',
    '{"providers":[],"groups":{}}', '{"providers":[],"noAutoGroups":"true"}',
    '{"providers":[],"__proto__":{"leak":"SYNTHETIC_SECRET_CANARY"}}']) {
    const f = fixture(t); f.writeDestination(contents);
    await assert.rejects(f.run(), error => ['bailian_import_json_invalid', 'bailian_import_destination_invalid'].includes(error.code));
    assert.equal(readFileSync(f.destination, 'utf8'), contents);
    assert.equal(existsSync(join(f.projectRoot, 'runtime/magpie/.rein-magpie.lock')), false);
  }
});

test('existing Bailian fallback, alternative keys, auth headers and other endpoints are refused', async t => {
  for (const fields of [
    { fallback: ['paid/model'] }, { keys: [{ key: 'synthetic-other-key' }] }, { routing: 'paid-group' },
    { chat: 'https://payg.example/v1' }, { responses: 'https://payg.example/v1' },
    { decide: chat }, { headers: { authorization: 'Bearer synthetic-other-key' } },
    { extraBody: { model: 'unsupported-paid-model' } },
  ]) {
    const f = fixture(t); const original = JSON.stringify({ providers: [{ id: providerId, name: 'Existing', key, ...fields }] });
    f.writeDestination(original);
    await refuses(f.run, 'bailian_import_destination_provider_conflict');
    assert.equal(readFileSync(f.destination, 'utf8'), original);
  }
});

test('destination must remain ignored and untracked with private permissions', async t => {
  const unignored = fixture(t); writeFileSync(join(unignored.projectRoot, '.gitignore'), '');
  await refuses(unignored.run, 'bailian_import_destination_not_ignored');
  assert.equal(existsSync(unignored.destination), false);
  const tracked = fixture(t); tracked.writeDestination({ providers: [] });
  git(tracked.projectRoot, ['add', '--force', 'runtime/magpie/config/magpie/providers.json']);
  await refuses(tracked.run, 'bailian_import_destination_not_ignored');
  const publicFile = fixture(t); publicFile.writeDestination({ providers: [] }); chmodSync(publicFile.destination, 0o644);
  await refuses(publicFile.run, 'bailian_import_destination_permissions');
  assert.equal(readFileSync(publicFile.destination, 'utf8'), '{"providers":[]}');
});

test('symlinked destination directories/files and linked files cannot escape the isolated runtime', async t => {
  for (const mode of ['directory', 'file', 'hardlink']) {
    const f = fixture(t); const outside = join(f.projectRoot, 'outside'); mkdirSync(outside);
    const canary = join(outside, 'canary.json'); writeFileSync(canary, '{"providers":[]}', { mode: 0o600 });
    mkdirSync(join(f.projectRoot, 'runtime/magpie'), { recursive: true, mode: 0o700 });
    if (mode === 'directory') symlinkSync(outside, join(f.projectRoot, 'runtime/magpie/config'));
    else {
      mkdirSync(join(f.projectRoot, 'runtime/magpie/config/magpie'), { recursive: true, mode: 0o700 });
      if (mode === 'file') symlinkSync(canary, f.destination); else linkSync(canary, f.destination);
    }
    await assert.rejects(f.run(), error => ['bailian_import_symlink_refused', 'bailian_import_path_invalid'].includes(error.code));
    assert.equal(readFileSync(canary, 'utf8'), '{"providers":[]}');
  }
});

test('source config/env paths are confined to runtime and cannot follow symlinks', async t => {
  const f = fixture(t); const outside = join(f.projectRoot, 'outside.json'); writeFileSync(outside, JSON.stringify(sourceConfig()));
  await refuses(() => f.run({ configPath: outside }), 'bailian_import_path_outside_runtime');
  rmSync(f.envPath); symlinkSync(outside, f.envPath);
  await refuses(f.run, 'bailian_import_symlink_refused');
  assert.equal(existsSync(f.destination), false);
  await refuses(() => f.run({ destination: outside }), 'bailian_import_arguments_invalid');
});

test('the shared managed-profile lock refuses active gateway/CLI use and concurrent imports', async t => {
  const f = fixture(t); mkdirSync(join(f.projectRoot, 'runtime/magpie'), { recursive: true, mode: 0o700 });
  const release = await acquireManagedProfileLock(f.homeDir);
  try {
    await refuses(f.run, 'bailian_import_profile_busy');
    assert.equal(existsSync(f.destination), false);
    assert.equal(existsSync(join(f.projectRoot, 'runtime/magpie/.rein-magpie.lock')), true);
  } finally { await release(); }
  const results = await Promise.allSettled([f.run(), f.run()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'bailian_import_profile_busy');
  assert.equal(existsSync(join(f.projectRoot, 'runtime/magpie/.rein-magpie.lock')), false);
});

test('CLI argument errors never reflect supplied secrets or start a real import', () => {
  const script = fileURLToPath(new URL('../scripts/import-bailian-subscription.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--destination', key], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'bailian_import_arguments_invalid');
  assert.ok(!result.stderr.includes(key));
});
