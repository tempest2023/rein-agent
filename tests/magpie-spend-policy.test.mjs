import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { assertManagedSpendPolicy } from '../plugins/rein-router/spend-policy.mjs';

const diagnostic = 'rein_magpie_codex_credit_configuration_required';
function auth(email = 'synthetic@example.test', workspace = 'workspace-one', plan = 'plus') {
  const claims = { email, 'https://api.openai.com/auth': { chatgpt_account_id: workspace, chatgpt_plan_type: plan } };
  return { auth_mode: 'chatgpt', tokens: { account_id: workspace, access_token: 'synthetic-access-token',
    id_token: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2ln` } };
}

function fixture(t, { settings, logins, live } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rein-magpie-spend-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const homeDir = join(root, 'home'), configDir = join(root, 'config/magpie');
  mkdirSync(join(homeDir, '.codex'), { recursive: true, mode: 0o700 });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const write = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  write(join(configDir, 'settings.json'), settings ?? { codexNoCredits: ['synthetic@example.test'] });
  if (logins !== null) write(join(configDir, 'logins.json'), logins ?? [{ agent: 'codex', user: 'synthetic@example.test', auth: auth() }]);
  if (live !== null) write(join(homeDir, '.codex/auth.json'), live ?? auth());
  return { root, homeDir, configDir, write, options: { gateway: { subscriptionOnly: true,
    managed: { homeDir, allowSubscriptionAccounts: true } }, routes: [{ gatewayModel: 'codex/model' }], allowPaidUsage: false } };
}

const denied = options => assert.rejects(assertManagedSpendPolicy(options), error => error.message === diagnostic);

test('requires credits off for every private saved Codex account and current live identity', async t => {
  const f = fixture(t, { settings: { codexNoCredits: ['synthetic@example.test', 'spare@example.test'] },
    logins: [{ agent: 'codex', user: 'synthetic@example.test', auth: auth() },
      { agent: 'codex', user: 'spare@example.test', auth: auth('spare@example.test', 'workspace-two') }] });
  assert.deepEqual(await assertManagedSpendPolicy(f.options), { codexAccountsChecked: 2 });
  f.write(join(f.configDir, 'settings.json'), { codexNoCredits: ['synthetic@example.test'] });
  await denied(f.options);
});

test('supports the private live-only account when its exact name is covered', async t => {
  const f = fixture(t, { logins: null });
  assert.deepEqual(await assertManagedSpendPolicy(f.options), { codexAccountsChecked: 1 });
});

test('accepts covered saved-only policy evidence but rejects absent or corrupt account evidence', async t => {
  const f = fixture(t, { live: null });
  assert.deepEqual(await assertManagedSpendPolicy(f.options), { codexAccountsChecked: 1 });
  f.write(join(f.homeDir, '.codex/auth.json'), null);
  await denied(f.options);
  rmSync(join(f.homeDir, '.codex/auth.json'));
  rmSync(join(f.configDir, 'logins.json'));
  await denied(f.options);
});

test('preserves workspace-qualified saved names and refuses unknown colliding workspaces', async t => {
  const base = 'synthetic@example.test · Team';
  const second = `${base} · workspac`;
  const f = fixture(t, { settings: { codexNoCredits: [base.toLowerCase(), second.toLowerCase()] },
    live: auth('synthetic@example.test', 'workspace-two', 'team'), logins: [
      { agent: 'codex', user: base, auth: auth('synthetic@example.test', 'workspace-one', 'team') },
      { agent: 'codex', user: second, auth: auth('synthetic@example.test', 'workspace-two', 'team') }] });
  assert.deepEqual(await assertManagedSpendPolicy(f.options), { codexAccountsChecked: 2 });
  f.write(join(f.homeDir, '.codex/auth.json'), auth('synthetic@example.test', 'workspace-three', 'team'));
  await denied(f.options);
});

test('both explicit paid switches are required to bypass the local preference audit', async t => {
  const f = fixture(t, { settings: {} });
  await denied({ ...f.options, allowPaidUsage: true });
  await denied({ ...f.options, gateway: { ...f.options.gateway, subscriptionOnly: false } });
  assert.deepEqual(await assertManagedSpendPolicy({ ...f.options, allowPaidUsage: true,
    gateway: { ...f.options.gateway, subscriptionOnly: false } }), { codexAccountsChecked: 0 });
});

test('native API-key mode, missing identity and disabled subscription serving fail closed', async t => {
  for (const live of [{ ...auth(), auth_mode: 'apikey' }, { ...auth(), OPENAI_API_KEY: 'synthetic-api-key' },
    auth('', 'workspace-one'), { tokens: { access_token: 'synthetic' } }]) {
    const f = fixture(t, { live }); await denied(f.options);
  }
  const f = fixture(t);
  await denied({ ...f.options, gateway: { ...f.options.gateway, managed: { ...f.options.gateway.managed, allowSubscriptionAccounts: false } } });
  f.write(join(f.configDir, 'settings.json'), { codexNoCredits: ['synthetic@example.test'], noAccountDiscovery: true });
  await denied(f.options);
});

test('corrupt, missing, oversized and symbolic private files yield only the fixed diagnostic', async t => {
  const f = fixture(t);
  const settings = join(f.configDir, 'settings.json');
  writeFileSync(settings, 'private-invalid-json', { mode: 0o600 }); await denied(f.options);
  rmSync(settings); await denied(f.options);
  writeFileSync(settings, ' '.repeat(256 * 1024 + 1), { mode: 0o600 }); await denied(f.options);
  rmSync(settings);
  const external = join(f.root, 'external.json'); f.write(external, { codexNoCredits: ['synthetic@example.test'] });
  symlinkSync(external, settings); await denied(f.options);
  rmSync(settings); f.write(settings, { codexNoCredits: ['synthetic@example.test'] });
  rmSync(join(f.homeDir, '.codex'), { recursive: true });
  const externalDirectory = join(f.root, 'external-codex'); mkdirSync(externalDirectory, { mode: 0o700 });
  f.write(join(externalDirectory, 'auth.json'), auth()); symlinkSync(externalDirectory, join(f.homeDir, '.codex'));
  await denied(f.options);
});

test('duplicate saved names cannot conceal a workspace rename, and non-Codex routes read no private files', async t => {
  const f = fixture(t, { logins: [{ agent: 'codex', user: 'synthetic@example.test', auth: auth() },
    { agent: 'codex', user: 'SYNTHETIC@example.test', auth: auth('synthetic@example.test', 'another-workspace') }] });
  await denied(f.options);
  rmSync(dirname(f.homeDir), { recursive: true, force: true });
  assert.deepEqual(await assertManagedSpendPolicy({ ...f.options, routes: [{ gatewayModel: 'claude/model' }] }), { codexAccountsChecked: 0 });
});

test('the audit refuses private account files readable by other users', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  chmodSync(join(f.homeDir, '.codex/auth.json'), 0o644);
  await denied(f.options);
});

test('hardlinked account files cannot attest a private profile', async t => {
  const f = fixture(t);
  linkSync(join(f.homeDir, '.codex/auth.json'), join(f.root, 'synthetic-outside-auth.json'));
  await denied(f.options);
});
