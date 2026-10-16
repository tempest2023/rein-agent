import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareMagpieKey } from '../scripts/prepare-magpie-key.mjs';
import { magpiePaths } from '../scripts/magpie-dependency.mjs';
import { acquireManagedProfileLock } from '../plugins/rein-router/managed-gateway.mjs';

const secret = `sk-magpie-key-${'1'.repeat(48)}`;
const keyId = 'a'.repeat(24);
const envName = 'REIN_MAGPIE_GATEWAY_KEY';
const route = (id, gatewayModel) => ({ id, provider: 'Synthetic provider', gatewayModel,
  billingSource: 'Synthetic included allowance', billingMode: 'subscription', billingVerified: false,
  purpose: 'Synthetic general requests', effort: 'medium', contextWindow: 32768, maxTokens: 1024 });

function fixture(t) {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'rein-magpie-key-')));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: projectRoot, stdio: 'ignore' }).status, 0);
  writeFileSync(join(projectRoot, '.gitignore'), 'runtime/\n');
  const paths = magpiePaths(projectRoot);
  const configPath = join(projectRoot, 'router.local.json');
  const config = { enabled: false, gateway: { baseUrl: 'http://127.0.0.1:3425/v1', apiKeyEnvVar: envName,
    managed: { binaryPath: paths.binary, homeDir: paths.homeDir } },
    routes: [route('one', 'fixture/one'), route('two', 'fixture/two'), route('one-high', 'fixture/one')] };
  const writeConfig = value => writeFileSync(configPath, JSON.stringify(value), { mode: 0o600 });
  writeConfig(config);
  const keyPath = join(projectRoot, 'runtime/magpie/config/magpie/caller-keys.json');
  const envPath = join(projectRoot, 'runtime/magpie/gateway.env');
  const calls = [];
  let generations = 0;
  const readStore = () => existsSync(keyPath) ? JSON.parse(readFileSync(keyPath, 'utf8')) : [];
  const writeStore = value => {
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    writeFileSync(keyPath, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  };
  const run = async (binary, args, options) => {
    calls.push({ binary, args, options });
    assert.equal(binary, paths.binary);
    assert.equal(options.cwd, paths.homeDir);
    assert.equal(options.env.HOME, paths.homeDir);
    assert.equal(options.env.MAGPIE_NO_ACCOUNTS, '1');
    assert.equal(options.env.BAILIAN_TOKEN_PLAN_API_KEY, undefined);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(options.shell, false);
    assert.ok(!args.some(arg => /^sk-magpie-key-/.test(arg)));
    const store = readStore();
    if (args[1] === 'add') {
      generations++;
      const nextId = generations === 1 ? keyId : String.fromCharCode(97 + generations).repeat(24);
      const nextSecret = `sk-magpie-key-${String(generations).repeat(48)}`;
      store.push({ id: nextId, name: args[2], secret: nextSecret }); writeStore(store);
      return { code: 0, stdout: `${nextSecret}\n`, stderr: 'PRIVATE_STARTUP_DIAGNOSTIC_CANARY' };
    }
    if (args[1] === 'models') {
      store.find(entry => entry.id === args[2]).models = args.slice(3); writeStore(store);
      return { code: 0, stdout: 'Synthetic restricted models', stderr: '' };
    }
    if (args[1] === 'remove') {
      writeStore(store.filter(entry => entry.id !== args[2]));
      return { code: 0, stdout: 'Gateway key removed', stderr: '' };
    }
    throw new Error('Unexpected synthetic command');
  };
  const execute = extra => prepareMagpieKey({ projectRoot, configPath, run,
    verifyInstallation: async () => {}, environment: { PATH: '/usr/bin', BAILIAN_TOKEN_PLAN_API_KEY: 'PRIVATE_UPSTREAM_CANARY' }, ...extra });
  return { projectRoot, paths, configPath, config, writeConfig, keyPath, envPath, calls, readStore, writeStore, run, execute };
}

async function rejects(run, code) {
  await assert.rejects(run, error => {
    assert.equal(error.code, code); assert.equal(error.message, code);
    assert.ok(!JSON.stringify({ ...error, message: error.message }).includes('CANARY'));
    assert.ok(!error.message.includes(secret)); return true;
  });
}

test('offline key preparation restricts exact raw models before publishing its private environment file', async t => {
  const f = fixture(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Offline key preparation must not contact a provider'); };
  let result;
  try { result = await f.execute(); } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(f.calls.map(call => call.args[1]), ['add', 'models']);
  assert.deepEqual(f.calls[1].args, ['gateway-key', 'models', keyId, 'fixture/one', 'fixture/two']);
  assert.deepEqual(f.readStore()[0].models, ['fixture/one', 'fixture/two']);
  assert.equal(readFileSync(f.envPath, 'utf8'), `${envName}=${secret}\n`);
  assert.equal(statSync(f.envPath).mode & 0o777, 0o600);
  assert.deepEqual(result, { envPath: f.envPath, apiKeyEnvVar: envName, modelCount: 2, status: 'created' });
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes('CANARY'));
  assert.equal(existsSync(join(f.projectRoot, 'runtime/magpie/.rein-magpie.lock')), false);
  assert.equal(existsSync(join(f.projectRoot, 'runtime/openclaw/.env')), false);
});

test('safe reruns reuse the same enabled exact-scope key without creating duplicates or rewriting environment', async t => {
  const f = fixture(t); await f.execute();
  const before = readFileSync(f.envPath); const time = statSync(f.envPath).mtimeMs;
  const result = await f.execute();
  assert.equal(result.status, 'reused');
  assert.equal(f.calls.length, 2); assert.equal(f.readStore().length, 1);
  assert.deepEqual(readFileSync(f.envPath), before); assert.equal(statSync(f.envPath).mtimeMs, time);
  rmSync(f.envPath);
  assert.equal((await f.execute()).status, 'reused');
  assert.equal(f.calls.length, 2); assert.equal(f.readStore().length, 1);
});

test('a different configured environment name cannot overwrite the prepared environment file', async t => {
  const f = fixture(t); await f.execute(); const before = readFileSync(f.envPath);
  f.config.gateway.apiKeyEnvVar = 'OTHER_GATEWAY_KEY'; f.writeConfig(f.config);
  await rejects(f.execute, 'magpie_key_existing_environment_conflict');
  assert.deepEqual(readFileSync(f.envPath), before); assert.equal(f.calls.length, 2);
});

test('duplicate stored secrets cannot authenticate through a broader sibling entry', async t => {
  const f = fixture(t); await f.execute(); rmSync(f.envPath);
  const store = f.readStore();
  store.unshift({ id: 'b'.repeat(24), name: 'Broader sibling', secret, models: [] }); f.writeStore(store);
  await rejects(f.execute, 'magpie_key_store_invalid');
  assert.equal(existsSync(f.envPath), false); assert.equal(f.calls.length, 2);
});

test('revoked, broadened, narrowed or mismatched existing scope is never reused or expanded', async t => {
  for (const mutate of [
    entry => { entry.off = true; }, entry => { entry.models = []; },
    entry => { entry.models = ['fixture/*']; }, entry => { entry.models = ['fixture/one']; },
    entry => { entry.models.push('paid/hidden'); }, entry => { entry.secret = `sk-magpie-key-${'2'.repeat(48)}`; },
  ]) {
    const f = fixture(t); await f.execute(); const before = readFileSync(f.envPath);
    const store = f.readStore(); mutate(store[0]); f.writeStore(store);
    await rejects(f.execute, 'magpie_key_existing_environment_conflict');
    assert.deepEqual(readFileSync(f.envPath), before); assert.equal(f.calls.length, 2);
  }
});

test('unverified disabled routes cannot turn wildcards, aliases, groups or effort suffixes into key permissions', async t => {
  for (const model of ['fixture/*', 'group/automatic', 'bare-model', 'fixture/one:high', 'fixture/../model', 'fixture//model', 'fixture/model\npaid/hidden']) {
    const f = fixture(t); f.config.routes[0].gatewayModel = model; f.writeConfig(f.config);
    await rejects(f.execute, 'magpie_key_config_invalid');
    assert.equal(f.calls.length, 0); assert.equal(existsSync(f.envPath), false);
  }
});

test('only the fixed project-local managed home and binary can be configured', async t => {
  for (const change of [
    gateway => { delete gateway.managed; }, gateway => { gateway.managed.homeDir = '/unrelated/profile'; },
    gateway => { gateway.managed.binaryPath = '/unrelated/magpie'; },
  ]) {
    const f = fixture(t); change(f.config.gateway); f.writeConfig(f.config);
    await rejects(f.execute, 'magpie_key_managed_profile_mismatch'); assert.equal(f.calls.length, 0);
  }
});

test('scope command failure removes the new key without publishing a client credential', async t => {
  const f = fixture(t);
  const run = async (binary, args, options) => args[1] === 'models'
    ? { code: 1, stdout: secret, stderr: 'PRIVATE_PROVIDER_FAILURE_CANARY' } : f.run(binary, args, options);
  await rejects(() => f.execute({ run }), 'magpie_key_command_failed');
  assert.equal(existsSync(f.envPath), false); assert.deepEqual(f.readStore(), []);
  assert.equal(f.calls.at(-1).args[1], 'remove');
});

test('a successful CLI claim cannot publish a key unless the native store confirms the exact restriction', async t => {
  const f = fixture(t);
  const run = async (binary, args, options) => args[1] === 'models'
    ? { code: 0, stdout: 'Everything restricted, trust me', stderr: '' } : f.run(binary, args, options);
  await rejects(() => f.execute({ run }), 'magpie_key_scope_unverified');
  assert.equal(existsSync(f.envPath), false); assert.deepEqual(f.readStore(), []);
});

test('failed cleanup leaves the environment unpublished and returns only a fixed recovery code', async t => {
  const f = fixture(t);
  const run = async (binary, args, options) => ['models', 'remove'].includes(args[1])
    ? { code: 1, stdout: secret, stderr: 'PRIVATE_CLEANUP_CANARY' } : f.run(binary, args, options);
  await rejects(() => f.execute({ run }), 'magpie_key_cleanup_required');
  assert.equal(existsSync(f.envPath), false); assert.equal(f.readStore().length, 1);
});

test('native creation that writes a key then fails still receives cleanup', async t => {
  const f = fixture(t);
  const run = async (binary, args, options) => {
    const result = await f.run(binary, args, options);
    if (args[1] === 'add') throw new Error(`PRIVATE_CLI_CANARY ${secret}`);
    return result;
  };
  await rejects(() => f.execute({ run }), 'magpie_key_failed');
  assert.equal(existsSync(f.envPath), false); assert.deepEqual(f.readStore(), []);
});

test('oversized captured command output cannot publish a key or escape into errors', async t => {
  const f = fixture(t);
  const run = async (binary, args, options) => {
    const result = await f.run(binary, args, options);
    return args[1] === 'add' ? { ...result, stderr: 'CANARY'.repeat(12000) } : result;
  };
  await rejects(() => f.execute({ run }), 'magpie_key_command_failed');
  assert.equal(existsSync(f.envPath), false); assert.deepEqual(f.readStore(), []);
});

test('environment publication refuses a concurrent file and preserves existing unrelated keys', async t => {
  const f = fixture(t);
  const other = { id: 'b'.repeat(24), name: 'Unrelated synthetic key', secret: `sk-magpie-key-${'3'.repeat(48)}`, models: ['other/model'] };
  f.writeStore([other]);
  const run = async (binary, args, options) => {
    const result = await f.run(binary, args, options);
    if (args[1] === 'models') writeFileSync(f.envPath, 'SYNTHETIC_CONCURRENT=unchanged\n', { mode: 0o600 });
    return result;
  };
  await rejects(() => f.execute({ run }), 'magpie_key_failed');
  assert.equal(readFileSync(f.envPath, 'utf8'), 'SYNTHETIC_CONCURRENT=unchanged\n');
  assert.deepEqual(f.readStore(), [other]);
});

test('shared process/profile lock refuses key mutation while another owner is active', async t => {
  const f = fixture(t); mkdirSync(dirname(f.paths.homeDir), { recursive: true, mode: 0o700 });
  const release = await acquireManagedProfileLock(f.paths.homeDir);
  try {
    await rejects(f.execute, 'magpie_key_profile_busy');
    assert.equal(f.calls.length, 0); assert.equal(existsSync(f.envPath), false);
  } finally { await release(); }
});

test('tracked or unignored credential destinations fail before creating or changing a key', async t => {
  const unignored = fixture(t); writeFileSync(join(unignored.projectRoot, '.gitignore'), '');
  await rejects(unignored.execute, 'magpie_key_destination_not_ignored'); assert.equal(unignored.calls.length, 0);
  const tracked = fixture(t); tracked.writeStore([]);
  assert.equal(spawnSync('git', ['add', '--force', 'runtime/magpie/config/magpie/caller-keys.json'],
    { cwd: tracked.projectRoot, stdio: 'ignore' }).status, 0);
  await rejects(tracked.execute, 'magpie_key_destination_not_ignored'); assert.equal(tracked.calls.length, 0);
});

test('symlinked, linked and publicly readable credential files cannot be reused', async t => {
  for (const kind of ['symlink', 'hardlink', 'public']) {
    const f = fixture(t); await f.execute();
    const outside = join(f.projectRoot, 'outside.env'); writeFileSync(outside, readFileSync(f.envPath), { mode: 0o600 });
    if (kind === 'public') chmodSync(f.envPath, 0o644);
    else { rmSync(f.envPath); if (kind === 'symlink') symlinkSync(outside, f.envPath); else linkSync(outside, f.envPath); }
    await rejects(f.execute, kind === 'symlink' ? 'magpie_key_symlink_refused' : kind === 'hardlink' ? 'magpie_key_path_invalid' : 'magpie_key_file_permissions');
    assert.equal(f.calls.length, 2);
  }
});

test('CLI argument errors do not echo secrets or invoke the prepared binary', () => {
  const script = fileURLToPath(new URL('../scripts/prepare-magpie-key.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--config', secret], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'magpie_key_arguments_invalid');
  assert.ok(!result.stderr.includes(secret));
});

function expand(f) {
  f.config.routes.push(route('new-provider', 'new-provider/verified-model'));
  f.writeConfig(f.config);
}

test('catalog expansion requires explicit replacement and leaves the old environment and scope unchanged by default', async t => {
  const f = fixture(t); await f.execute();
  const before = readFileSync(f.envPath); const stored = f.readStore(); expand(f);
  await rejects(f.execute, 'magpie_key_existing_environment_conflict');
  assert.deepEqual(readFileSync(f.envPath), before); assert.deepEqual(f.readStore(), stored);
  assert.equal(f.calls.length, 2);
});

test('explicit replacement verifies a new exact scope then revokes only the old owned key and publishes atomically', async t => {
  const f = fixture(t); await f.execute();
  const unrelated = { id: 'b'.repeat(24), name: 'Unrelated key', secret: `sk-magpie-key-${'8'.repeat(48)}`, models: ['unrelated/model'] };
  f.writeStore([...f.readStore(), unrelated]); expand(f);
  const originalEnvironment = readFileSync(f.envPath, 'utf8');
  const run = async (binary, args, options) => {
    if (args[1] === 'models' && args[2] !== keyId) {
      assert.equal(readFileSync(f.envPath, 'utf8'), originalEnvironment);
      assert.ok(f.readStore().some(entry => entry.id === keyId));
    }
    if (args[1] === 'remove' && args[2] === keyId) {
      const next = f.readStore().find(entry => entry.id !== keyId && entry.name !== unrelated.name);
      assert.deepEqual(next.models, ['fixture/one', 'fixture/two', 'new-provider/verified-model']);
      assert.equal(readFileSync(f.envPath, 'utf8'), originalEnvironment);
    }
    return f.run(binary, args, options);
  };
  const result = await f.execute({ replace: true, run });
  assert.equal(result.status, 'replaced'); assert.equal(result.modelCount, 3);
  assert.deepEqual(f.calls.slice(2).map(call => call.args[1]), ['add', 'models', 'remove']);
  const store = f.readStore();
  assert.ok(!store.some(entry => entry.id === keyId || entry.secret === secret));
  assert.deepEqual(store.find(entry => entry.id === unrelated.id), unrelated);
  const next = store.find(entry => entry.id !== unrelated.id);
  assert.equal(readFileSync(f.envPath, 'utf8'), `${envName}=${next.secret}\n`);
  assert.equal(statSync(f.envPath).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(result).includes(next.secret));
});

test('same-catalog --replace is a no-op reuse without revoking or rotating the key', async t => {
  const f = fixture(t); await f.execute(); const before = readFileSync(f.envPath);
  const result = await f.execute({ replace: true });
  assert.equal(result.status, 'reused'); assert.equal(f.calls.length, 2);
  assert.deepEqual(readFileSync(f.envPath), before); assert.equal(f.readStore()[0].id, keyId);
});

test('failed new-scope verification preserves the old enabled credential and environment', async t => {
  const f = fixture(t); await f.execute(); const before = readFileSync(f.envPath); const old = f.readStore(); expand(f);
  const run = async (binary, args, options) => args[1] === 'models'
    ? { code: 1, stdout: '', stderr: 'PRIVATE_NEW_SCOPE_CANARY' } : f.run(binary, args, options);
  await rejects(() => f.execute({ replace: true, run }), 'magpie_key_command_failed');
  assert.deepEqual(readFileSync(f.envPath), before); assert.deepEqual(f.readStore(), old);
  assert.ok(!f.calls.some(call => call.args[1] === 'remove' && call.args[2] === keyId));
});

test('replacement refuses foreign names, wildcard old scope, malformed identities and disabled old keys', async t => {
  for (const mutate of [
    entry => { entry.name = 'Foreign operator key'; }, entry => { entry.models = ['fixture/*']; },
    entry => { entry.models = ['fixture/one', 'paid/model']; }, entry => { entry.models = ['group/automatic']; },
    entry => { entry.id = 'arbitrary-not-generated-id'; }, entry => { entry.lan = true; }, entry => { entry.off = true; },
  ]) {
    const f = fixture(t); await f.execute(); const before = readFileSync(f.envPath);
    const store = f.readStore(); mutate(store[0]); f.writeStore(store); expand(f);
    await rejects(() => f.execute({ replace: true }), 'magpie_key_existing_environment_conflict');
    assert.deepEqual(readFileSync(f.envPath), before); assert.deepEqual(f.readStore(), store);
    assert.equal(f.calls.length, 2);
  }
});

test('old-key revocation must be confirmed before replacement can publish its new credential', async t => {
  const f = fixture(t); await f.execute(); const before = readFileSync(f.envPath); const old = f.readStore(); expand(f);
  const run = async (binary, args, options) => args[1] === 'remove' && args[2] === keyId
    ? { code: 0, stdout: 'Claimed removed', stderr: '' } : f.run(binary, args, options);
  await rejects(() => f.execute({ replace: true, run }), 'magpie_key_revocation_unverified');
  assert.deepEqual(readFileSync(f.envPath), before); assert.deepEqual(f.readStore(), old);
});

test('publication failure after revocation fails closed with the old environment dead and the new key cleaned', async t => {
  const f = fixture(t); await f.execute(); const before = readFileSync(f.envPath, 'utf8'); expand(f);
  const run = async (binary, args, options) => {
    const result = await f.run(binary, args, options);
    if (args[1] === 'remove' && args[2] === keyId)
      writeFileSync(f.envPath, `${before}# synthetic concurrent publication failure\n`, { mode: 0o600 });
    return result;
  };
  await rejects(() => f.execute({ replace: true, run }), 'magpie_key_environment_changed');
  assert.deepEqual(f.readStore(), []);
  assert.ok(readFileSync(f.envPath, 'utf8').startsWith(before));
  assert.ok(!f.readStore().some(entry => entry.secret === secret));
});

test('replacement can reuse an already verified next-catalog key without another creation', async t => {
  const f = fixture(t); await f.execute(); const before = readFileSync(f.envPath);
  rmSync(f.envPath); expand(f); await f.execute();
  const next = f.readStore().find(entry => entry.id !== keyId);
  writeFileSync(f.envPath, before, { mode: 0o600 }); const count = f.calls.length;
  const result = await f.execute({ replace: true });
  assert.equal(result.status, 'replaced');
  assert.deepEqual(f.calls.slice(count).map(call => call.args), [['gateway-key', 'remove', keyId]]);
  assert.equal(readFileSync(f.envPath, 'utf8'), `${envName}=${next.secret}\n`);
});

test('failed publication never deletes a preexisting next-catalog key or publishes it', async t => {
  const f = fixture(t); await f.execute(); const before = readFileSync(f.envPath, 'utf8');
  rmSync(f.envPath); expand(f); await f.execute();
  const next = f.readStore().find(entry => entry.id !== keyId);
  writeFileSync(f.envPath, before, { mode: 0o600 });
  const run = async (binary, args, options) => {
    const result = await f.run(binary, args, options);
    if (args[1] === 'remove' && args[2] === keyId)
      writeFileSync(f.envPath, `${before}# synthetic concurrent publication failure\n`, { mode: 0o600 });
    return result;
  };
  await rejects(() => f.execute({ replace: true, run }), 'magpie_key_cleanup_required');
  assert.deepEqual(f.readStore(), [next]);
  assert.ok(!readFileSync(f.envPath, 'utf8').includes(next.secret));
});
