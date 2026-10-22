import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { browserContext, browserEnvironment, createBrowserRunner, nativeArgs, runNative } from './agent-browser-runtime.mjs';
import { browserRoot, verifyBrowser } from './agent-browser-dependency.mjs';

const instance = `probe-${randomBytes(6).toString('hex')}`;
const context = browserContext({ instance });
const options = { session: 'fixture', json: true };
const binary = verifyBrowser();
const env = browserEnvironment(context);
const password = randomBytes(24).toString('hex');
let token = '', logins = 0, submissions = 0;
const server = createServer(async (req, res) => {
  const signedIn = token && req.headers.cookie?.includes(`fixture=${token}`);
  const redirect = path => { res.writeHead(303, { Location: path }); res.end(); };
  if (req.url === '/login' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const fields = new URLSearchParams(body);
    if (fields.get('username') !== 'synthetic' || fields.get('password') !== password) { res.writeHead(403); res.end('Invalid fixture'); return; }
    logins++; token = randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', `fixture=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`);
    redirect('/dashboard'); return;
  }
  if (req.url === '/login') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<form id="login" method="post" action="/login"><input name="username" autocomplete="username"><input name="password" type="password"><button type="submit">Sign in</button></form>'); return;
  }
  if (req.url === '/dashboard' || req.url === '/submitted') {
    if (!signedIn) { redirect('/login'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<h1 id="account">Fixture dashboard</h1>' +
      (req.url === '/submitted' ? '<p id="receipt">Synthetic item recorded</p>' : '') +
      '<form method="post" action="/submit"><button id="submit" type="submit">Submit synthetic item</button></form>'); return;
  }
  if (req.url === '/submit' && req.method === 'POST') {
    if (!signedIn) { redirect('/login'); return; }
    submissions++; redirect('/submitted'); return;
  }
  res.writeHead(404); res.end();
});

try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const enrolled = await runNative(binary, nativeArgs(context, { json: true }, [
    'auth', 'save', 'fixture', '--url', `${origin}/login`, '--username', 'synthetic', '--password-stdin',
  ]), env, { capture: true, input: password + '\n' });
  assert.equal(enrolled.code, 0, (enrolled.stderr + enrolled.stdout).replaceAll(password, '[fixture-secret]'));
  assert.ok(!enrolled.stdout.includes(password) && !enrolled.stderr.includes(password));
  const run = createBrowserRunner(context, options);
  const checkLogin = async () => {
    const result = await runNative(process.execPath, [join(browserRoot, 'scripts/agent-browser.mjs'),
      '--session', 'fixture', 'ensure-login', 'fixture', '--url', `${origin}/dashboard`,
      '--authenticated-selector', '#account', '--login-selector', '#login'],
    { ...process.env, NORI_BROWSER_INSTANCE: instance }, { capture: true });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.ok(!result.stdout.includes(password));
    return JSON.parse(result.stdout);
  };
  assert.equal((await checkLogin()).loginAttempts, 1);
  assert.equal(logins, 1);
  const vault = readFileSync(join(context.authDir, context.profile('fixture') + '.json'), 'utf8');
  assert.equal(JSON.parse(vault).encrypted, true);
  assert.ok(!vault.includes(password));
  await run(['close']);
  const stateFiles = readdirSync(join(context.stateDir, 'sessions')).filter(name => name.endsWith('.json') || name.endsWith('.json.enc'));
  assert.ok(stateFiles.length > 0, 'Close must save session state');
  for (const name of stateFiles) {
    const state = readFileSync(join(context.stateDir, 'sessions', name));
    assert.ok(name.endsWith('.json.enc'), 'All state files must use the native encrypted format');
    assert.ok(!state.includes(Buffer.from(token)), 'Persisted cookies must be encrypted');
  }
  assert.equal(statSync(context.keyFile).mode & 0o777, 0o600);
  assert.equal((await checkLogin()).loginAttempts, 0, 'Restart must reuse the cookie');
  assert.equal(logins, 1);
  token = 'server-expired-session';
  const recovered = await checkLogin();
  assert.equal(recovered.status, 'authenticated');
  assert.equal(recovered.loginAttempts, 1);
  assert.equal(logins, 2);
  assert.equal(submissions, 0, 'Recovery must not submit a business action');
  await run(['snapshot', '-i']);
  await run(['click', '#submit']);
  await run(['wait', '#receipt']);
  assert.equal(submissions, 1, 'Continue the pending action once after recovery');
  assert.equal((await checkLogin()).loginAttempts, 0);
  assert.equal(submissions, 1, 'A later recovery check must not replay the action');
  console.log('PASS: native vault login, encrypted disk state, restart reuse, expiry recovery and one continued synthetic action. No live accounts or model inference.');
} finally {
  await runNative(binary, nativeArgs(context, options, ['close']), env, { capture: true });
  await runNative(binary, nativeArgs(context, { json: true }, ['auth', 'delete', 'fixture']), env, { capture: true });
  await runNative(binary, nativeArgs(context, { json: true }, ['close']), env, { capture: true });
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(join(context.stateDir, '..'), { recursive: true, force: true });
  rmSync(context.local, { recursive: true, force: true });
}
