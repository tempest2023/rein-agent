import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadMagpieGatewayEnvironment } from '../scripts/magpie-gateway-env.mjs';
import { magpiePaths } from '../scripts/magpie-dependency.mjs';

const name = 'REIN_MAGPIE_GATEWAY_KEY';
const secret = `sk-magpie-key-${'1'.repeat(48)}`;
const other = `sk-magpie-key-${'2'.repeat(48)}`;

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rein-magpie-gateway-env-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = magpiePaths(root);
  const configPath = join(root, 'runtime/openclaw/openclaw.json');
  const envPath = join(root, 'runtime/magpie/gateway.env');
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const host = { plugins: { allow: ['rein-router'], entries: { 'rein-router': { enabled: true,
    config: { enabled: true, gateway: { apiKeyEnvVar: name,
      managed: { binaryPath: paths.binary, homeDir: paths.homeDir } } } } } } };
  const writeHost = value => writeFileSync(configPath, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  const writeEnv = text => {
    mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 });
    writeFileSync(envPath, text, { mode: 0o600 }); chmodSync(envPath, 0o600);
  };
  writeHost(host);
  const environment = { OPENCLAW_CONFIG_PATH: configPath, HOME: '/synthetic/existing-home',
    PATH: '/synthetic/existing-path', UNRELATED_SECRET: 'SYNTHETIC_EXISTING_CANARY' };
  const load = extra => loadMagpieGatewayEnvironment({ root, environment, ...extra });
  return { root, paths, configPath, envPath, host, writeHost, writeEnv, environment, load };
}

function refuses(run, code) {
  assert.throws(run, error => {
    assert.equal(error.code, code); assert.equal(error.message, code);
    assert.ok(!error.message.includes(secret)); assert.ok(!error.message.includes('CANARY'));
    return true;
  });
}

test('only the declared managed key is merged into a copy without profile or environment writes', t => {
  const f = fixture(t); f.writeEnv(`${name}=${secret}\n`);
  const beforeConfig = readFileSync(f.configPath); const beforeEnv = readFileSync(f.envPath);
  const before = { ...f.environment }; const result = f.load();
  assert.notEqual(result, f.environment);
  assert.deepEqual(result, { ...before, [name]: secret });
  assert.deepEqual(f.environment, before);
  assert.deepEqual(readFileSync(f.configPath), beforeConfig); assert.deepEqual(readFileSync(f.envPath), beforeEnv);
  assert.equal(existsSync(join(f.root, 'runtime/openclaw/.env')), false);
});

test('disabled, denied, unallowlisted and unrelated profiles do not read a missing gateway environment', t => {
  for (const mutate of [
    host => { host.plugins.enabled = false; }, host => { host.plugins.deny = ['rein-router']; },
    host => { host.plugins.allow = ['another-plugin']; }, host => { host.plugins.entries['rein-router'].enabled = false; },
    host => { host.plugins.entries['rein-router'].config.enabled = false; }, host => { delete host.plugins.entries['rein-router']; },
    host => { delete host.plugins.entries['rein-router'].config.gateway.managed; },
  ]) {
    const f = fixture(t); mutate(f.host); f.writeHost(f.host);
    assert.deepEqual(f.load(), f.environment);
    assert.equal(existsSync(f.envPath), false);
  }
});

test('an unconfigured, absent or malformed OpenClaw JSON profile receives no injected secret', t => {
  const f = fixture(t);
  assert.deepEqual(f.load({ environment: { PATH: '/synthetic' } }), { PATH: '/synthetic' });
  rmSync(f.configPath); assert.deepEqual(f.load(), f.environment);
  f.writeHost('{PRIVATE_MALFORMED_CANARY'); assert.deepEqual(f.load(), f.environment);
  f.writeHost('[]'); assert.deepEqual(f.load(), f.environment);
});

test('foreign or near-matching managed paths cannot redirect secret loading', t => {
  for (const mutate of [
    gateway => { gateway.managed.homeDir = '/unrelated/profile/home'; },
    gateway => { gateway.managed.binaryPath = '/unrelated/bin/magpie'; },
    gateway => { gateway.managed.homeDir = `${gateway.managed.homeDir}/../foreign`; },
    gateway => { gateway.managed.binaryPath = 'relative/magpie'; },
  ]) {
    const f = fixture(t); mutate(f.host.plugins.entries['rein-router'].config.gateway); f.writeHost(f.host);
    // A malformed secret file would fail if an unrelated profile tried to read it.
    f.writeEnv('PRIVATE_NOT_AN_ENV_CANARY');
    assert.deepEqual(f.load(), f.environment);
  }
});

test('existing same key is accepted, while a different key never gets overwritten', t => {
  const f = fixture(t); f.writeEnv(`${name}=${secret}\n`);
  assert.equal(f.load({ environment: { ...f.environment, [name]: secret } })[name], secret);
  const environment = { ...f.environment, [name]: other };
  refuses(() => f.load({ environment }), 'magpie_gateway_env_existing_value_conflict');
  assert.equal(environment[name], other);
});

test('active managed profiles fail closed when the prepared secret file is unavailable', t => {
  const f = fixture(t); refuses(f.load, 'magpie_gateway_env_unavailable');
});

test('dotenv parsing allows one quoted value without evaluating shell expressions', t => {
  const f = fixture(t); f.writeEnv(`# local synthetic key\nexport ${name}="${secret}"\n`);
  assert.equal(f.load()[name], secret);
  f.writeEnv(`${name}=$(echo PRIVATE_CANARY)\n`);
  refuses(f.load, 'magpie_gateway_env_contents_invalid');
});

test('extra variables, duplicate declarations, malformed keys and oversized files are rejected', t => {
  const f = fixture(t);
  for (const text of [
    `${name}=${secret}\nHOME=/private/foreign\n`, `${name}=${secret}\n${name}=${secret}\n`,
    `OTHER_KEY=${secret}\n`, `${name}=magpie\n`, `${name}=sk-sp-PRIVATE_CANARY\n`,
    `${name}=${secret}\nPRIVATE_GARBAGE_CANARY\n`, `${name}=${secret}\n${'#'.repeat(4096)}\n`,
  ]) {
    f.writeEnv(text);
    refuses(f.load, text.length > 4096 ? 'magpie_gateway_env_file_invalid' : 'magpie_gateway_env_contents_invalid');
  }
});

test('declared gateway secret cannot overwrite system, loader or runtime control variables', t => {
  for (const variable of ['HOME', 'PATH', 'CODEX_HOME', 'OPENCLAW_CONFIG_PATH', 'NODE_OPTIONS',
    'XDG_CONFIG_HOME', 'DYLD_INSERT_LIBRARIES', 'HTTP_PROXY', 'MAGPIE_ADDR', 'INVALID-name']) {
    const f = fixture(t); f.host.plugins.entries['rein-router'].config.gateway.apiKeyEnvVar = variable;
    f.writeHost(f.host);
    refuses(f.load, 'magpie_gateway_env_variable_disallowed');
    assert.equal(existsSync(f.envPath), false);
  }
});

test('public mode, symlink and hardlink files cannot supply the managed gateway key', t => {
  for (const mode of ['public', 'symlink', 'hardlink']) {
    const f = fixture(t); f.writeEnv(`${name}=${secret}\n`);
    const outside = join(f.root, 'outside.env'); writeFileSync(outside, readFileSync(f.envPath), { mode: 0o600 });
    if (mode === 'public') chmodSync(f.envPath, 0o644);
    else { rmSync(f.envPath); if (mode === 'symlink') symlinkSync(outside, f.envPath); else linkSync(outside, f.envPath); }
    refuses(f.load, mode === 'public' ? 'magpie_gateway_env_file_permissions' :
      mode === 'symlink' ? 'magpie_gateway_env_symlink_refused' : 'magpie_gateway_env_file_invalid');
  }
});

test('symlinked runtime ancestors cannot redirect the fixed gateway secret path', t => {
  const f = fixture(t); const outside = join(f.root, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'gateway.env'), `${name}=${secret}\n`, { mode: 0o600 });
  symlinkSync(outside, join(f.root, 'runtime/magpie'));
  refuses(f.load, 'magpie_gateway_env_symlink_refused');
});
