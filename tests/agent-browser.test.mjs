import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserContext, browserEnvironment, nativeArgs, parseBrowserArgs, waitForBrowserClose } from '../scripts/agent-browser-runtime.mjs';
import { ensureLogin, parseLoginArgs } from '../scripts/agent-browser-login.mjs';

test('native session/credential scope and encryption survive repeated launches without inheriting browser settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'nori-browser-'));
  try {
    const a = browserContext({ root, home: root, instance: 'a' });
    const b = browserContext({ root, home: root, instance: 'b' });
    assert.notEqual(a.profile('admin'), b.profile('admin'));
    const inherited = { PATH: '/bin', AGENT_BROWSER_ENCRYPTION_KEY: 'bad', AGENT_BROWSER_CDP: 'remote', AGENT_BROWSER_SESSION: 'shared', NORI_BROWSER_EXECUTABLE_PATH: '/test/chrome' };
    const env = browserEnvironment(a, inherited);
    assert.match(env.AGENT_BROWSER_ENCRYPTION_KEY, /^[a-f0-9]{64}$/);
    assert.equal(browserEnvironment(a, inherited).AGENT_BROWSER_ENCRYPTION_KEY, env.AGENT_BROWSER_ENCRYPTION_KEY);
    assert.equal(env.AGENT_BROWSER_CDP, undefined);
    assert.equal(env.AGENT_BROWSER_SESSION, undefined);
    assert.equal(env.AGENT_BROWSER_EXECUTABLE_PATH, '/test/chrome');
    assert.notEqual(browserEnvironment(b, inherited).AGENT_BROWSER_ENCRYPTION_KEY, env.AGENT_BROWSER_ENCRYPTION_KEY);
    const args = nativeArgs(a, parseBrowserArgs(['--session', 'admin-report', 'auth', 'login', 'admin']));
    assert.ok(args.includes('--restore'));
    assert.equal(args.at(-1), a.profile('admin'));
    const original = readFileSync(a.keyFile, 'utf8');
    writeFileSync(a.keyFile, 'invalid');
    assert.throws(() => browserEnvironment(a, inherited), /invalid/);
    assert.equal(readFileSync(a.keyFile, 'utf8'), 'invalid', 'Must never rotate a corrupt key silently');
    writeFileSync(a.keyFile, original);
    rmSync(a.keyFile);
    mkdirSync(a.authDir, { recursive: true });
    writeFileSync(join(a.authDir, a.profile('admin') + '.json'), '{}');
    assert.throws(() => browserEnvironment(a, inherited), /missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('local wrapper requires explicit sessions and stdin enrollment, rejects scope escapes', () => {
  for (const args of [
    ['open', 'https://example.com'], ['--session', '../bad', 'close'],
    ['auth', 'save', 'admin', '--password', 'secret'],
    ['auth', 'save', 'admin', '--password=secret', '--password-stdin'],
    ['--session', 'admin', 'auth', 'login', 'admin', '--url', 'https://evil.example'],
    ['--session', 'admin', '--namespace=other', 'close'],
    ['--session', 'admin', '--cdp', '9222', 'open', 'https://example.com'],
    ['--session', 'admin', 'connect', '9222'],
    ['--session', 'admin', 'batch'],
    ['--session', 'admin', 'state', 'load', '/tmp/other.json'],
    ['--json', '--version', '--args=--user-data-dir=/tmp/other'],
  ]) assert.throws(() => parseBrowserArgs(args));
  assert.equal(parseBrowserArgs(['auth', 'save', 'admin', '--password-stdin']).args[1], 'save');
  assert.equal(parseBrowserArgs(['skills', 'get', 'core']).session, undefined);
  assert.deepEqual(parseBrowserArgs(['--', '--session', 'report', 'snapshot', '-i']), parseBrowserArgs(['--session', 'report', 'snapshot', '-i']));
});

test('a symlinked storage ancestor cannot redirect creation of a key', () => {
  const root = mkdtempSync(join(tmpdir(), 'nori-browser-link-'));
  try {
    const context = browserContext({ root, home: root });
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, 'runtime'));
    assert.throws(() => browserEnvironment(context, {}), /real directory/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('close waits for native daemon cleanup before another command can reopen its session', async () => {
  const socketDir = mkdtempSync(join(tmpdir(), 'nori-browser-close-'));
  let timer;
  try {
    const pid = join(socketDir, 'fixture.pid');
    const socket = join(socketDir, 'fixture.sock');
    writeFileSync(pid, 'synthetic'); writeFileSync(socket, 'synthetic');
    timer = setTimeout(() => { rmSync(pid); rmSync(socket); }, 75);
    await waitForBrowserClose({ socketDir }, 'fixture', 1000);
    writeFileSync(pid, 'still-closing');
    await assert.rejects(waitForBrowserClose({ socketDir }, 'fixture', 30), /still pending/);
    assert.equal(readFileSync(pid, 'utf8'), 'still-closing', 'Do not delete or kill a pending daemon');
  } finally { clearTimeout(timer); rmSync(socketDir, { recursive: true, force: true }); }
});

const target = { alias: 'fixture', url: 'https://fixture.example/dashboard', authenticatedSelector: '#account', loginSelector: '#login' };
function fixture({ state = 'login', after = 'authenticated', failLogin = false, origin = 'https://fixture.example', waitFails = false } = {}) {
  const calls = [];
  return { calls, run: async args => {
    calls.push(args);
    if (args[0] === 'auth' && args[1] === 'show') return { profile: { url: 'https://fixture.example/login' } };
    if (args[0] === 'auth' && args[1] === 'login') {
      if (failLogin) throw new Error('outcome_unknown');
      state = after; return {};
    }
    const shown = state === 'both' || (args[2] === '#account' ? state === 'authenticated' : state === 'login');
    if (args[0] === 'get' && args[1] === 'count') return { count: shown ? 1 : 0 };
    if (args[0] === 'get') return { url: origin + '/page' };
    if (args[0] === 'is') return { visible: shown, origin };
    if (args[0] === 'wait' && waitFails) throw new Error('Challenge has no authenticated selector');
    return {};
  } };
}

test('reuse avoids login, expiry logs in once then returns to the pending read-only destination', async () => {
  const reused = fixture({ state: 'authenticated' });
  assert.equal((await ensureLogin(reused.run, target)).loginAttempts, 0);
  const expired = fixture();
  assert.deepEqual(await ensureLogin(expired.run, target), { status: 'authenticated', loginAttempts: 1, resumedUrl: target.url });
  assert.equal(expired.calls.filter(c => c[0] === 'auth' && c[1] === 'login').length, 1);
  assert.equal(expired.calls.filter(c => c[0] === 'open').length, 2);
  assert.ok(expired.calls.every(c => ['auth', 'open', 'get', 'is', 'wait'].includes(c[0])), 'No replayed business action');
});

test('ambiguous pages and cross-origin redirects never trigger credential submission', async () => {
  for (const config of [{ state: 'unknown' }, { state: 'both' }, { origin: 'https://other.example' }]) {
    const f = fixture(config);
    assert.equal((await ensureLogin(f.run, target)).status, 'manual_intervention_required');
    assert.ok(!f.calls.some(c => c[1] === 'login'));
  }
  const f = fixture();
  await assert.rejects(ensureLogin(f.run, { ...target, url: 'https://other.example/dashboard' }), /origin/);
  assert.equal(f.calls.length, 1);
});

test('challenge, bad credentials and unknown submission outcome stop without a second attempt', async () => {
  for (const config of [{ after: 'login' }, { after: 'unknown', waitFails: true }]) {
    const f = fixture(config);
    const result = await ensureLogin(f.run, target);
    assert.equal(result.status, 'manual_intervention_required');
    assert.equal(result.loginAttempts, 1);
    assert.equal(f.calls.filter(c => c[1] === 'login').length, 1);
  }
  const f = fixture({ failLogin: true });
  await assert.rejects(ensureLogin(f.run, target), /outcome_unknown/);
  assert.equal(f.calls.filter(c => c[1] === 'login').length, 1);
});

test('recovery arguments require concrete indicators and a credential-free HTTP(S) URL', () => {
  const args = ['fixture', '--url', target.url, '--authenticated-selector', '#account', '--login-selector', '#login'];
  assert.deepEqual(parseLoginArgs(args), target);
  assert.throws(() => parseLoginArgs(['fixture', '--url', target.url]));
  assert.throws(() => parseLoginArgs(args.map(a => a === target.url ? 'https://user:secret@fixture.example' : a)));
});
