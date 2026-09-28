import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import {
  ACCESS_URL,
  AUTH_TEST_URL,
  DEFAULT_REDIRECT_PATH,
  DEFAULT_TOKEN_STORE,
  OAuthError,
  SLACK_TEST_ACCOUNTS,
  SLACK_TEST_TEAM_ID,
  allowsLocalhostRedirect,
  buildAuthorizeUrl,
  buildStoreUpdate,
  createCodeChallenge,
  createCodeVerifier,
  exchangeCode,
  normalizeAccessPayload,
  readTokenStore,
  redirectUri,
  redactTokens,
  resolveAccount,
  resolveRedirectUri,
  verifyCallbackState,
  verifyUserToken,
  waitForCallback,
  writeTokenStore,
} from '../scripts/slack-test-oauth.mjs';
import { DEFAULT_TOKEN_PATHS, redactTokens as harnessRedact, parseEnvText } from '../scripts/slack-test-lib.mjs';

const LEAD = resolveAccount('lead');

/** Reserve an ephemeral port and release it, so a listener test never collides with a real run. */
async function freePort() {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

/** Assert the port is bindable, which is only true once the previous listener fully closed. */
async function assertPortIsFree(port) {
  const reuse = createServer();
  try {
    await new Promise((resolve, reject) => {
      reuse.on('error', reject);
      reuse.listen(port, '127.0.0.1', resolve);
    });
  } finally {
    await new Promise(resolve => reuse.close(resolve));
  }
}

/** A complete, valid `oauth.v2.access` payload for one account. */
function accessPayload(overrides = {}) {
  return {
    ok: true,
    access_token: 'xoxb-bot-token-that-must-not-be-stored',
    token_type: 'bot',
    team: { id: SLACK_TEST_TEAM_ID, name: 'Rein Test' },
    authed_user: {
      id: LEAD.expectedUserId,
      scope: 'chat:write',
      access_token: 'xoxp-lead-token',
      token_type: 'user',
    },
    ...overrides,
  };
}

/** Build a response object that the helper's `fetch` seam can consume. */
function jsonResponse(payload, status = 200) {
  return { status, json: async () => payload };
}

/** Record every request a fake `fetch` receives and reply with the queued payloads in order. */
function recordingFetch(payloads) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: new URLSearchParams(String(options.body)) });
    const next = payloads[calls.length - 1];
    if (next === undefined) throw new Error(`unexpected request ${calls.length} to ${url}`);
    return jsonResponse(next);
  };
  return { calls, fetchImpl };
}

test('S256 challenge matches the Slack documentation vector', () => {
  // https://docs.slack.dev/authentication/using-pkce/ publishes this exact pair.
  assert.equal(createCodeChallenge('secretpassword'), 'ldMBaaWcQYtSATMV_IG8mf3wp7A6EW80arYoSW80ntU');
});

test('code verifier is high-entropy, URL-safe and unique per run', () => {
  const verifiers = new Set();
  for (let index = 0; index < 64; index += 1) {
    const verifier = createCodeVerifier();
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
    verifiers.add(verifier);
  }
  assert.equal(verifiers.size, 64, 'each run must receive a fresh verifier');
});

test('authorize URL is a PKCE desktop request: user scope only, no bot scope, S256', () => {
  const verifier = 'secretpassword';
  const url = buildAuthorizeUrl({
    clientId: '123.456',
    redirect: redirectUri(8765),
    state: 'state-under-test',
    codeChallenge: createCodeChallenge(verifier),
  });

  assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2/authorize');
  assert.equal(url.searchParams.get('client_id'), '123.456');
  assert.equal(url.searchParams.get('scope'), '', 'a desktop redirect may not request bot scopes');
  assert.equal(url.searchParams.get('user_scope'), 'chat:write');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), createCodeChallenge(verifier));
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:8765/oauth/callback');
  assert.equal(url.searchParams.get('state'), 'state-under-test');
  assert.equal(url.searchParams.get('client_secret'), null);
  assert.ok(!url.toString().includes('secretpassword'), 'the verifier never travels in the authorize URL');
});

test('redirect URI keeps the loopback host and registered path', () => {
  assert.equal(redirectUri(8765), `http://localhost:8765${DEFAULT_REDIRECT_PATH}`);
  assert.equal(redirectUri(9000), 'http://localhost:9000/oauth/callback');
});

const TUNNEL_REDIRECT = 'https://random-words-1234.trycloudflare.com/oauth/callback';

test('the HTTPS tunnel redirect is accepted and returned byte-identical', () => {
  assert.equal(resolveRedirectUri({ env: { SLACK_TEST_REDIRECT_URI: TUNNEL_REDIRECT } }), TUNNEL_REDIRECT);
});

test('the redirect is validated for scheme, host and the exact callback path before any listener starts', () => {
  const refused = [
    [{}, 'missing-redirect-uri'],
    [{ SLACK_TEST_REDIRECT_URI: 'not a url' }, 'invalid-redirect-uri'],
    [{ SLACK_TEST_REDIRECT_URI: 'http://localhost:8765/oauth/callback' }, 'invalid-redirect-uri'],
    [{ SLACK_TEST_REDIRECT_URI: 'https://tunnel.example.com/callback' }, 'invalid-redirect-uri'],
    [{ SLACK_TEST_REDIRECT_URI: 'https://tunnel.example.com/oauth/callback?x=1' }, 'invalid-redirect-uri'],
    [{ SLACK_TEST_REDIRECT_URI: 'https://tunnel.example.com/oauth/callback#frag' }, 'invalid-redirect-uri'],
    [{ SLACK_TEST_REDIRECT_URI: 'https://user:pass@tunnel.example.com/oauth/callback' }, 'invalid-redirect-uri'],
  ];
  for (const [env, code] of refused) {
    assert.throws(
      () => resolveRedirectUri({ env }),
      error => error instanceof OAuthError && error.code === code,
      `${JSON.stringify(env)} must be refused as ${code}`,
    );
  }
});

test('an https loopback host is refused unless the operator explicitly opted out', () => {
  const env = { SLACK_TEST_REDIRECT_URI: 'https://localhost:8765/oauth/callback' };
  assert.throws(
    () => resolveRedirectUri({ env }),
    error => error instanceof OAuthError && error.code === 'loopback-redirect-uri',
  );
  assert.equal(
    resolveRedirectUri({ env: { ...env, SLACK_TEST_ALLOW_LOCALHOST_REDIRECT: '1' } }),
    'https://localhost:8765/oauth/callback',
  );
  assert.equal(allowsLocalhostRedirect({}), false);
  assert.equal(allowsLocalhostRedirect({ SLACK_TEST_ALLOW_LOCALHOST_REDIRECT: 'yes' }), true);
});

test('the manifest and the setup guide register an https tunnel callback, never the rejected localhost form', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../docs/slack-mvp-test-app-manifest.json', import.meta.url), 'utf8'),
  );
  const redirects = manifest.oauth_config.redirect_urls;
  assert.ok(Array.isArray(redirects) && redirects.length > 0, 'the manifest must register at least one redirect URL');
  for (const redirect of redirects) {
    const url = new URL(redirect);
    assert.equal(url.protocol, 'https:', `${redirect} must be https; Slack rejects an http://localhost redirect`);
    assert.equal(url.pathname, DEFAULT_REDIRECT_PATH, `${redirect} must end with the loopback callback path`);
    assert.ok(
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()),
      `${redirect} must name the tunnel host, not loopback`,
    );
  }
  assert.equal(manifest.oauth_config.pkce_enabled, true);
  assert.deepEqual(manifest.oauth_config.scopes, { user: ['chat:write'] });
  assert.deepEqual(manifest.features, {}, 'a desktop redirect may not request bot scopes');

  const guide = readFileSync(new URL('../docs/slack-test-app-oauth-setup.md', import.meta.url), 'utf8');
  assert.ok(guide.includes('SLACK_TEST_REDIRECT_URI'), 'the guide must name the redirect environment variable');
  for (const line of guide.split('\n')) {
    if (!line.includes('http://localhost')) continue;
    assert.match(
      line,
      /reject|refus|legacy|ALLOW_LOCALHOST|settings UI/i,
      `the guide must never advertise the rejected localhost redirect as the registered value: ${line.trim()}`,
    );
  }
});

test('exchange sends client_id, code, code_verifier and redirect_uri but never a client_secret', async () => {
  const { calls, fetchImpl } = recordingFetch([accessPayload()]);
  await exchangeCode({ clientId: '123.456', code: 'code-1', codeVerifier: 'verifier-1', redirect: redirectUri(8765), fetchImpl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ACCESS_URL);
  assert.equal(calls[0].body.get('code'), 'code-1');
  assert.equal(calls[0].body.get('code_verifier'), 'verifier-1');
  assert.equal(calls[0].body.get('client_id'), '123.456');
  assert.equal(calls[0].body.get('redirect_uri'), 'http://localhost:8765/oauth/callback');
  assert.equal(calls[0].body.get('client_secret'), null, 'PKCE replaces the client secret');
});

test('auth.test is called with the new user token and must match team and user', async () => {
  const { calls, fetchImpl } = recordingFetch([
    { ok: true, team_id: SLACK_TEST_TEAM_ID, user_id: LEAD.expectedUserId, user: 'lead' },
  ]);
  const verified = await verifyUserToken(LEAD, 'xoxp-lead-token', { fetchImpl });

  assert.equal(calls[0].url, AUTH_TEST_URL);
  assert.equal(calls[0].body.get('token'), 'xoxp-lead-token');
  assert.equal(verified.userId, LEAD.expectedUserId);
  assert.equal(verified.teamId, SLACK_TEST_TEAM_ID);
});

test('a callback state that does not match this run is refused before any exchange', () => {
  assert.throws(
    () => verifyCallbackState({ state: 'attacker-state', code: 'code-1' }, 'expected-state'),
    error => error instanceof OAuthError && error.code === 'state-mismatch',
  );
  assert.throws(
    () => verifyCallbackState({ code: 'code-1' }, 'expected-state'),
    error => error instanceof OAuthError && error.code === 'state-mismatch',
  );
  assert.equal(verifyCallbackState({ state: 'expected-state', code: 'code-1' }, 'expected-state'), true);
});

test('exchange refuses a response for the wrong user or the wrong workspace', () => {
  const wrongUser = accessPayload({ authed_user: { id: 'U0C5KLD8Z5E', scope: 'chat:write', access_token: 'xoxp-other' } });
  assert.throws(
    () => normalizeAccessPayload(wrongUser, LEAD),
    error => error instanceof OAuthError && error.code === 'user-mismatch',
  );

  const wrongTeam = accessPayload({ team: { id: 'T0000000000', name: 'Other' } });
  assert.throws(
    () => normalizeAccessPayload(wrongTeam, LEAD),
    error => error instanceof OAuthError && error.code === 'team-mismatch',
  );

  const botOnly = accessPayload({ authed_user: { id: LEAD.expectedUserId, access_token: 'xoxb-bot' } });
  assert.throws(
    () => normalizeAccessPayload(botOnly, LEAD),
    error => error instanceof OAuthError && error.code === 'bad-token',
  );
});

test('a refusal payload is reported without echoing a token', () => {
  assert.throws(
    () => normalizeAccessPayload({ ok: false, error: 'invalid_code' }, LEAD),
    error => error instanceof OAuthError && error.code === 'exchange-failed' && !/xoxp-/.test(error.message),
  );
});

test('rotation fields are recorded when Slack returns them', () => {
  const withRotation = accessPayload({
    authed_user: {
      id: LEAD.expectedUserId,
      scope: 'chat:write',
      access_token: 'xoxp-lead-token',
      refresh_token: 'xoxe-1-refresh',
      expires_in: 43200,
    },
  });
  const result = normalizeAccessPayload(withRotation, LEAD);
  assert.equal(result.refreshTokenRequired, true);
  assert.equal(result.refreshToken, 'xoxe-1-refresh');
  assert.match(result.expiresAt, /^\d{4}-\d{2}-\d{2}T/);

  const withoutRotation = normalizeAccessPayload(accessPayload(), LEAD);
  assert.equal(withoutRotation.refreshTokenRequired, false);
  assert.equal(withoutRotation.refreshToken, null);
  assert.equal(withoutRotation.expiresAt, null, 'a classic app reports no expiry rather than a fake one');
});

test('the stored file keeps a plain-token reader working and hides rotation data in meta', () => {
  const result = normalizeAccessPayload(
    accessPayload({
      authed_user: {
        id: LEAD.expectedUserId,
        scope: 'chat:write',
        access_token: 'xoxp-lead-token',
        refresh_token: 'xoxe-1-refresh',
        expires_in: 43200,
      },
    }),
    LEAD,
  );
  const { content } = buildStoreUpdate({ accountJsonKeys: new Map(), meta: null }, result, { now: '2026-09-26T00:00:00.000Z' });

  assert.equal(content.REIN_SLACK_USER_TOKEN_LEAD, 'xoxp-lead-token');
  assert.equal(content.meta.accounts.lead.userId, LEAD.expectedUserId);
  assert.equal(content.meta.accounts.lead.refreshToken, 'xoxe-1-refresh');
  assert.equal(content.meta.accounts.lead.refreshTokenExpiresAt, '2026-10-26T00:00:00.000Z', 'PKCE refresh tokens expire 30 days after issue');
  assert.equal(content.meta.scope, 'chat:write');
  assert.equal(content.meta.teamId, SLACK_TEST_TEAM_ID);

  const dir = mkdtempSync(join(tmpdir(), 'rein-oauth-store-'));
  try {
    const path = join(dir, 'slack-test-tokens.json');
    writeTokenStore(path, content);

    assert.equal(statSync(path).mode & 0o777, 0o600, 'the token file is owner-only');
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(Object.values(written).filter(value => typeof value === 'object').length, 1, 'only meta is a non-token object');
    assert.equal(written.meta.accounts.lead.refreshToken, 'xoxe-1-refresh');

    const parsed = parseEnvText(readFileSync(path, 'utf8'));
    assert.equal(
      parsed.get('REIN_SLACK_USER_TOKEN_LEAD'),
      undefined,
      'JSON is not env format; the harness validates JSON separately',
    );

    const reloaded = readTokenStore(path);
    assert.equal(reloaded.accountJsonKeys.get('lead'), 'xoxp-lead-token');
    assert.equal(reloaded.meta.accounts.lead.userId, LEAD.expectedUserId);
    assert.equal(reloaded.accountJsonKeys.get('member'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writing one account preserves the tokens already stored for the others', () => {
  const first = normalizeAccessPayload(accessPayload(), LEAD);
  const { content: afterLead } = buildStoreUpdate({ accountJsonKeys: new Map(), meta: null }, first);
  const existing = { accountJsonKeys: new Map([['lead', 'xoxp-lead-token']]), meta: afterLead.meta };

  const member = resolveAccount('member');
  const memberResult = normalizeAccessPayload(
    accessPayload({ authed_user: { id: member.expectedUserId, scope: 'chat:write', access_token: 'xoxp-member-token' } }),
    member,
  );
  const { content, accounts } = buildStoreUpdate(existing, memberResult);

  assert.equal(content.REIN_SLACK_USER_TOKEN_LEAD, 'xoxp-lead-token');
  assert.equal(content.REIN_SLACK_USER_TOKEN_MEMBER, 'xoxp-member-token');
  assert.equal(content.REIN_SLACK_USER_TOKEN_DIR1, '');
  assert.deepEqual([...accounts.keys()], ['lead', 'member']);
  assert.equal(content.meta.accounts.lead.userId, LEAD.expectedUserId);
  assert.equal(content.meta.accounts.member.userId, member.expectedUserId);
});

test('a corrupt store is refused instead of being overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rein-oauth-corrupt-'));
  try {
    const path = join(dir, 'slack-test-tokens.json');
    writeFileSync(path, '{"REIN_SLACK_USER_TOKEN_LEAD": "xoxp-lead-to');
    assert.throws(
      () => readTokenStore(path),
      error => error instanceof OAuthError && error.code === 'token-store',
    );
    assert.equal(
      readFileSync(path, 'utf8'),
      '{"REIN_SLACK_USER_TOKEN_LEAD": "xoxp-lead-to',
      'a corrupt file must not be silently rewritten',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a store that does not exist yet reads as empty rather than as an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rein-oauth-missing-'));
  try {
    const store = readTokenStore(join(dir, 'slack-test-tokens.json'));
    assert.equal(store.accountJsonKeys.size, 0);
    assert.equal(store.meta, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redaction removes any Slack token shape from text', () => {
  const text = 'authorization failed for xoxp-123-456-abcdef and xoxe-1-refresh and xoxb-bot-token';
  const redacted = redactTokens(text);
  assert.ok(!/xox[pbe]-/.test(redacted));
  assert.match(redacted, /\[redacted-slack-token\]/);
  assert.ok(!/xoxp-/.test(harnessRedact(text)), 'the shared harness redacts user tokens too');
});

test('the shared harness and this helper agree on the same token store contract', () => {
  assert.ok(
    DEFAULT_TOKEN_PATHS.includes(DEFAULT_TOKEN_STORE),
    'runtime/slack-test-tokens.json must be a token path the CLI harness reads',
  );
  assert.deepEqual(
    SLACK_TEST_ACCOUNTS.map(account => account.id),
    ['lead', 'member', 'dir1', 'dir2', 'dir3'],
  );
  for (const account of SLACK_TEST_ACCOUNTS) {
    assert.equal(account.json, `REIN_SLACK_USER_TOKEN_${account.id.toUpperCase()}`);
    assert.match(account.expectedUserId, /^U[A-Z0-9]{10}$/);
  }
  assert.equal(new Set(SLACK_TEST_ACCOUNTS.map(account => account.expectedUserId)).size, 5);
  assert.equal(SLACK_TEST_TEAM_ID, 'T0C4GRL55HB');
});

test('the helper source never contains a client secret or a token literal', () => {
  const source = readFileSync(new URL('../scripts/slack-test-oauth.mjs', import.meta.url), 'utf8');
  const executable = source
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.ok(!/client_secret/.test(executable), 'code must not send a client secret');
  assert.ok(!/xoxp-[A-Za-z0-9]{8,}/.test(source), 'no user token literal may be committed');
  assert.ok(!/xoxb-[A-Za-z0-9]{8,}/.test(source), 'no bot token literal may be committed');
});

test('the CLI accepts an account id and refuses an unknown one', () => {
  assert.equal(resolveAccount('dir3').expectedUserId, 'U0C4L74QGCD');
  assert.equal(resolveAccount(' LEAD ').id, 'lead');
  assert.throws(
    () => resolveAccount('admin'),
    error => error instanceof OAuthError && error.code === 'unknown-account',
  );
});

test('the loopback listener accepts one callback and refuses a replay', async () => {
  const port = await freePort();

  const pending = waitForCallback({ port, expectedState: 'state-1', timeoutMs: 5000 });
  const callback = await fetch(`http://127.0.0.1:${port}${DEFAULT_REDIRECT_PATH}?code=abc&state=state-1`);
  assert.equal(callback.status, 200);
  const received = await pending;
  assert.equal(received.code, 'abc');
  assert.equal(received.state, 'state-1');
});

test('the loopback listener rejects a mismatched state and frees the port', async () => {
  const port = await freePort();

  const pending = waitForCallback({ port, expectedState: 'state-good', timeoutMs: 5000 });
  const rejected = assert.rejects(pending, error => error instanceof OAuthError && error.code === 'state-mismatch');
  const response = await fetch(`http://127.0.0.1:${port}${DEFAULT_REDIRECT_PATH}?code=abc&state=state-bad`);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /state did not match/);
  await rejected;

  // The listener must already be closed, so the same port is free for the next account.
  await assertPortIsFree(port);
});

test('the loopback listener reports a refusal from Slack without exchanging anything', async () => {
  const port = await freePort();

  const pending = waitForCallback({ port, expectedState: 'state-good', timeoutMs: 5000 });
  const rejected = assert.rejects(pending, error => error instanceof OAuthError && error.code === 'callback-refused');
  const response = await fetch(`http://127.0.0.1:${port}${DEFAULT_REDIRECT_PATH}?error=access_denied&state=state-good`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /access_denied/);
  await rejected;
});

test('waitForCallback exposes no code path that requires a client secret', async () => {
  const source = readFileSync(new URL('../scripts/slack-test-oauth.mjs', import.meta.url), 'utf8');
  const accessCall = source.slice(source.indexOf('export async function exchangeCode'), source.indexOf('export async function verifyUserToken'));
  assert.ok(!accessCall.includes('client_secret') && !accessCall.includes('authorization'), 'the exchange carries no secret and no basic auth header');
});
