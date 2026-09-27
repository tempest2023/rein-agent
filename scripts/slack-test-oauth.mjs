#!/usr/bin/env node
// Local Slack PKCE user-token helper for the five Rein MVP test identities.
//
// Purpose: acquire one user OAuth token (`xoxp-...`) per test account so the local harness can act
// as a real human. Scope is user-only (`chat:write`); no bot scopes are requested.
//
// Slack facts this file relies on, quoted from https://docs.slack.dev/authentication/using-pkce/:
//   - "Desktop redirects are not allowed to request bot scopes." So `scope=` stays empty and the
//     only requested scope travels in `user_scope=chat:write`.
//   - "The client should call the oauth.v2.access API method, but should not include client_secret
//     in the parameters. Instead, the client should provide the code and the code_verifier."
//   - `code_challenge_method` must be `S256`; it is the only supported algorithm.
//   - "Enabling PKCE marks your app as a public client, which is a one-way operation. It cannot be
//     disabled without contacting Slack support." Treat the flag and the app as permanent.
//   - "if PKCE is enabled, all refresh tokens issued to your app will expire in 30 days instead of
//     lasting indefinitely." A refresh token stored here is therefore not a permanent credential.
//
// Redirect URL: the app's Slack-side redirect URL must be HTTPS. Slack's PKCE page describes
// http://localhost redirects as a desktop redirect, but the app settings UI rejects an
// `http://localhost` redirect URL, so this helper takes the redirect from SLACK_TEST_REDIRECT_URI
// (for example an https://<random>.trycloudflare.com tunnel address that forwards to the loopback
// listener). The listener itself stays on plain http://127.0.0.1:<port>: only the public URL Slack
// redirects the browser to is untrusted network surface, and the tunnel terminates TLS for you.
// The redirect URL must be byte-identical in three places or Slack replies `bad_redirect_uri`:
// this helper, the authorize request, and the token exchange.
//
// What this helper deliberately does not do:
//   - It never prints a token, a refresh token, or a code verifier. Only account ids, the authorize
//     URL and verification results reach stdout.
//   - It never starts or configures a tunnel. Supply the tunnel URL; this file only validates it.
//   - It does not run the refresh exchange. Refresh tokens are recorded so a later rotation flow can
//     use them; recording is not the same as supporting rotation.
//   - It binds one loopback port for exactly one callback, then closes the listener.
//
// Usage:
//   SLACK_TEST_CLIENT_ID=123.456 \
//   SLACK_TEST_REDIRECT_URI=https://<random>.trycloudflare.com/oauth/callback \
//   node scripts/slack-test-oauth.mjs start --account lead
//
// Required environment:
//   SLACK_TEST_CLIENT_ID   Non-secret Slack app client ID; the app must have PKCE enabled and the
//                          redirect URL below registered.
//   SLACK_TEST_REDIRECT_URI  The app's registered HTTPS redirect URL. Must be https, must end with
//                            the loopback callback path, and must be the same URL registered in Slack.
// Optional environment:
//   SLACK_TEST_OAUTH_PORT  Loopback port; defaults to 8765.
//   SLACK_TEST_ALLOW_LOCALHOST_REDIRECT=1
//                          Opt out of the HTTPS requirement and use the legacy http://localhost
//                          redirect. Kept only for a Slack app that already accepted it; new apps
//                          reject it.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../', import.meta.url));

/** The one workspace these test identities must belong to. */
export const SLACK_TEST_TEAM_ID = 'T0C4GRL55HB';

/** The only requested scope, and it is a user scope. */
export const SLACK_TEST_USER_SCOPE = 'chat:write';

/** Loopback port and exact redirect path; both must match the Slack app's registered redirect URL. */
export const DEFAULT_OAUTH_PORT = 8765;
export const DEFAULT_REDIRECT_PATH = '/oauth/callback';

export const AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
export const ACCESS_URL = 'https://slack.com/api/oauth.v2.access';
export const AUTH_TEST_URL = 'https://slack.com/api/auth.test';

/**
 * Token store shared with `scripts/slack-test-lib.mjs`. The five token keys are top-level strings so
 * that reader keeps working unchanged; all non-secret bookkeeping lives under the single `meta` key.
 */
export const DEFAULT_TOKEN_STORE = resolve(repoRoot, 'runtime/slack-test-tokens.json');

/** Slack's documented token prefixes. `xoxe-` is the refresh token issued under rotation. */
export const USER_TOKEN_PREFIX = 'xoxp-';
export const REFRESH_TOKEN_PREFIX = 'xoxe-';

/**
 * `json` is the top-level key `scripts/slack-test-lib.mjs` reads; `env` is the matching environment
 * variable name used by the CLI harness.
 */
export const SLACK_TEST_ACCOUNTS = [
  { id: 'lead', expectedUserId: 'U0C4V074CTW', env: 'SLACK_USER_TOKEN_LEAD', json: 'REIN_SLACK_USER_TOKEN_LEAD' },
  { id: 'member', expectedUserId: 'U0C5KLD8Z5E', env: 'SLACK_USER_TOKEN_MEMBER', json: 'REIN_SLACK_USER_TOKEN_MEMBER' },
  { id: 'dir1', expectedUserId: 'U0C4L74033P', env: 'SLACK_USER_TOKEN_DIR1', json: 'REIN_SLACK_USER_TOKEN_DIR1' },
  { id: 'dir2', expectedUserId: 'U0C4T82EPPB', env: 'SLACK_USER_TOKEN_DIR2', json: 'REIN_SLACK_USER_TOKEN_DIR2' },
  { id: 'dir3', expectedUserId: 'U0C4L74QGCD', env: 'SLACK_USER_TOKEN_DIR3', json: 'REIN_SLACK_USER_TOKEN_DIR3' },
];

export class OAuthError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'OAuthError';
    this.code = code;
  }
}

const trim = value => (typeof value === 'string' ? value.trim() : '');
const normalize = value => trim(value).toUpperCase();
const isUserToken = value => trim(value).startsWith(USER_TOKEN_PREFIX);

/**
 * Strip any Slack token substring from text. The helper never echoes a token on purpose; this is the
 * backstop for messages that arrive from a provider response or an unexpected error.
 */
export function redactTokens(text) {
  return String(text).replace(/\bxox[abpeors]-[A-Za-z0-9-]+/g, '[redacted-slack-token]');
}

/** Resolve one account descriptor by id, case-insensitively. */
export function resolveAccount(id) {
  const wanted = trim(id).toLowerCase();
  const account = SLACK_TEST_ACCOUNTS.find(item => item.id === wanted);
  if (!account) {
    throw new OAuthError(
      'unknown-account',
      `account ${trim(id) || '<none>'} is not one of: ${SLACK_TEST_ACCOUNTS.map(item => item.id).join(', ')}`,
    );
  }
  return account;
}

/** A fresh, high-entropy PKCE `code_verifier` per RFC 7636. */
export function createCodeVerifier() {
  return randomBytes(32).toString('base64url');
}

/** S256 `code_challenge`: base64url of the SHA-256 digest of the verifier. */
export function createCodeChallenge(verifier) {
  return createHash('sha256').update(String(verifier)).digest('base64url');
}

/** Random opaque `state`, so a callback the helper did not start is refused. */
export function createState() {
  return randomBytes(16).toString('hex');
}

/**
 * The legacy loopback redirect URL. Slack's settings UI now rejects an `http://localhost` redirect,
 * so this is only reachable through the explicit `SLACK_TEST_ALLOW_LOCALHOST_REDIRECT` opt-out.
 */
export function redirectUri(port, path = DEFAULT_REDIRECT_PATH) {
  return `http://localhost:${port}${path}`;
}

/** Whether the operator explicitly opted back into the legacy plain-http loopback redirect. */
export function allowsLocalhostRedirect(env = process.env) {
  const raw = trim(env.SLACK_TEST_ALLOW_LOCALHOST_REDIRECT).toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * Resolve and validate the redirect URL Slack will send the browser to.
 *
 * The app's redirect URL must be HTTPS. A tunnel address such as
 * `https://<random>.trycloudflare.com/oauth/callback` is supplied by the operator; this helper never
 * creates the tunnel. The path must match the loopback listener path exactly, so the tunnel forwards
 * the callback to a path this helper is actually serving.
 *
 * Validation is deliberately strict and happens before any listener starts, because a mismatch only
 * surfaces at Slack as `bad_redirect_uri` after the user has already consented.
 */
export function resolveRedirectUri({ env = process.env, port = resolvePort(env) } = {}) {
  const configured = trim(env.SLACK_TEST_REDIRECT_URI);
  if (!configured) {
    throw new OAuthError(
      'missing-redirect-uri',
      [
        'Set SLACK_TEST_REDIRECT_URI to the HTTPS redirect URL registered in the Slack app.',
        `It must end with ${DEFAULT_REDIRECT_PATH} and forward to the local listener.`,
        'Slack rejects an http://localhost redirect URL in the app settings UI.',
        'For a temporary tunnel, run a quick tunnel that points at the loopback port and use its URL,',
        'for example: cloudflared tunnel --url http://127.0.0.1:' + port,
      ].join('\n'),
    );
  }

  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new OAuthError('invalid-redirect-uri', 'SLACK_TEST_REDIRECT_URI is not a valid absolute URL.');
  }

  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (url.protocol !== 'https:') {
    // Plain http is only acceptable for a loopback redirect, and only with the explicit opt-out.
    if (url.protocol === 'http:' && loopbackHosts.has(url.hostname) && allowsLocalhostRedirect(env)) {
      return url.toString();
    }
    throw new OAuthError(
      'invalid-redirect-uri',
      `SLACK_TEST_REDIRECT_URI must use https; received ${url.protocol.replace(':', '') || '<none>'}. ` +
        'Slack rejects an http://localhost redirect URL in the app settings UI.',
    );
  }

  if (url.username || url.password) {
    throw new OAuthError('invalid-redirect-uri', 'SLACK_TEST_REDIRECT_URI must not carry userinfo.');
  }
  if (!url.hostname) {
    throw new OAuthError(
      'invalid-redirect-uri',
      'SLACK_TEST_REDIRECT_URI must name the public host Slack redirects the browser to.',
    );
  }
  if (loopbackHosts.has(url.hostname.toLowerCase()) && !allowsLocalhostRedirect(env)) {
    throw new OAuthError(
      'loopback-redirect-uri',
      `SLACK_TEST_REDIRECT_URI points at ${url.hostname}, which cannot receive Slack's redirect. ` +
        'Use the HTTPS address of a tunnel that forwards to the loopback listener, for example: ' +
        'cloudflared tunnel --url http://127.0.0.1:' + port,
    );
  }
  if (url.hash) {
    throw new OAuthError('invalid-redirect-uri', 'SLACK_TEST_REDIRECT_URI must not carry a fragment.');
  }
  if (url.search) {
    throw new OAuthError('invalid-redirect-uri', 'SLACK_TEST_REDIRECT_URI must not carry a query string.');
  }
  if (url.pathname !== DEFAULT_REDIRECT_PATH) {
    throw new OAuthError(
      'invalid-redirect-uri',
      `SLACK_TEST_REDIRECT_URI path must be ${DEFAULT_REDIRECT_PATH}; received ${url.pathname || '<none>'}. ` +
        'The tunnel must forward that exact path to the local listener.',
    );
  }
  return url.toString();
}

/** Read an integer port from `SLACK_TEST_OAUTH_PORT`, or fall back to the default. */
export function resolvePort(env = process.env) {
  const raw = trim(env.SLACK_TEST_OAUTH_PORT);
  if (!raw) return DEFAULT_OAUTH_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new OAuthError('invalid-port', `SLACK_TEST_OAUTH_PORT must be 1-65535, received ${raw}`);
  }
  return port;
}

/** The non-secret client ID; absent or obviously wrong values fail before any listener starts. */
export function requireClientId(env = process.env) {
  const clientId = trim(env.SLACK_TEST_CLIENT_ID);
  if (!clientId) {
    throw new OAuthError('missing-client-id', 'Set SLACK_TEST_CLIENT_ID to the Slack app client ID (non-secret).');
  }
  if (!/^\d+\.[\dA-Za-z]+$/.test(clientId)) {
    throw new OAuthError('invalid-client-id', 'SLACK_TEST_CLIENT_ID must look like the digits.digits Slack client ID.');
  }
  return clientId;
}

/**
 * Build the authorize URL. `scope=` stays empty on purpose: a desktop redirect may not request bot
 * scopes, and the default `scope` parameter is the bot scope field.
 */
export function buildAuthorizeUrl({ clientId, redirect, state, codeChallenge }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', '');
  url.searchParams.set('user_scope', SLACK_TEST_USER_SCOPE);
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url;
}

/** Pull `code`, `state` and any Slack `error` out of a loopback callback path. */
export function parseCallbackPath(pathWithQuery) {
  let url;
  try {
    url = new URL(String(pathWithQuery), 'http://localhost');
  } catch {
    throw new OAuthError('malformed-callback', 'callback URL could not be parsed');
  }
  return {
    code: trim(url.searchParams.get('code')),
    state: trim(url.searchParams.get('state')),
    error: trim(url.searchParams.get('error')),
  };
}

/**
 * Refuse a callback that does not carry the state this run generated, and refuse a second one. A
 * callback with the wrong state is reported, not silently dropped, so a misconfigured app is visible.
 */
export function verifyCallbackState(query, expectedState) {
  const state = trim(query?.state);
  if (!state || state !== expectedState) {
    throw new OAuthError(
      'state-mismatch',
      `callback state ${state || '<none>'} does not match the state this run generated`,
    );
  }
  return true;
}

/** Slack delivers refusals (and a repeated callback) as `error=` rather than an HTTP failure. */
export function callbackErrorNotice(query) {
  const error = trim(query?.error);
  if (!error) return null;
  if (error === 'access_denied') return 'Slack reported access_denied: the account cancelled or refused the request.';
  if (error === 'invalid_code') return 'Slack reported invalid_code: this callback was already used or has expired.';
  return `Slack reported ${error} on the callback.`;
}

/**
 * Validate one `oauth.v2.access` payload and return the fields the store needs.
 *
 * Rotation-aware by design: Slack returns refresh fields only when the app has token rotation
 * enabled, and with PKCE those refresh tokens expire after 30 days. Absent fields mean "no expiry is
 * known", which is the normal case for a classic app, so they are recorded as unknown rather than
 * treated as a failure.
 */
export function normalizeAccessPayload(payload, account, { expectedTeamId = SLACK_TEST_TEAM_ID } = {}) {
  if (payload?.ok !== true) {
    throw new OAuthError(
      'exchange-failed',
      `oauth.v2.access refused the code for ${account.id} (${redactTokens(payload?.error ?? 'unknown_error')})`,
    );
  }
  const teamId = normalize(payload.team?.id ?? '');
  if (teamId !== normalize(expectedTeamId)) {
    throw new OAuthError(
      'team-mismatch',
      `${account.id} authorized into workspace ${teamId || '<none>'}, expected ${expectedTeamId}`,
    );
  }
  const userId = normalize(payload.authed_user?.id ?? '');
  if (userId !== normalize(account.expectedUserId)) {
    throw new OAuthError(
      'user-mismatch',
      `${account.id} authorized as user ${userId || '<none>'}, expected ${account.expectedUserId}`,
    );
  }
  const token = payload.authed_user?.access_token;
  if (!isUserToken(token)) {
    throw new OAuthError(
      'bad-token',
      `oauth.v2.access did not return a user token (xoxp-) for ${account.id}`,
    );
  }
  const refreshToken = trim(payload.authed_user?.refresh_token);
  return {
    id: account.id,
    userId,
    teamId,
    teamName: trim(payload.team?.name),
    scope: trim(payload.authed_user?.scope),
    token,
    refreshTokenRequired: refreshToken.length > 0 || payload.authed_user?.refresh_token_required === true,
    expiresAt: expiresAtFrom(payload.authed_user?.expires_in),
    refreshToken: refreshToken || null,
  };
}

/** Convert Slack's `expires_in` seconds into an ISO timestamp, or null when it is not usable. */
export function expiresAtFrom(expiresIn, now = Date.now()) {
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(now + seconds * 1000).toISOString();
}

/**
 * Read the existing store. A missing file is normal; a corrupt file is an error, because silently
 * replacing it would drop the other accounts' tokens.
 */
export function readTokenStore(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { accountJsonKeys: new Map(), meta: null };
    throw new OAuthError('token-store', `could not read ${path}: ${error?.code ?? 'unknown'}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OAuthError('token-store', `${path} exists but is not valid JSON; refusing to overwrite it`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OAuthError('token-store', `${path} must contain a JSON object`);
  }
  const accountJsonKeys = new Map();
  for (const account of SLACK_TEST_ACCOUNTS) {
    const value = parsed[account.json];
    if (isUserToken(value)) accountJsonKeys.set(account.id, trim(value));
  }
  const meta = parsed.meta && typeof parsed.meta === 'object' && !Array.isArray(parsed.meta) ? parsed.meta : null;
  return { accountJsonKeys, meta };
}

/**
 * Merge one freshly authorized account into the store contents.
 *
 * Only `xoxp-` values are kept under the five token keys, and only the `meta` object carries
 * non-token bookkeeping, so `scripts/slack-test-lib.mjs` can keep trimming every top-level value.
 */
export function buildStoreUpdate(existing, result, { now = new Date().toISOString() } = {}) {
  const accounts = new Map(existing.accountJsonKeys);
  accounts.set(result.id, result.token);

  const metaAccounts = { ...(existing.meta?.accounts ?? {}) };
  metaAccounts[result.id] = {
    userId: result.userId,
    teamId: result.teamId,
    scope: result.scope,
    tokenType: 'user',
    refreshTokenRequired: result.refreshTokenRequired,
    expiresAt: result.expiresAt,
    ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
    ...(result.refreshToken ? { refreshTokenExpiresAt: expiresAtFrom(30 * 24 * 60 * 60, Date.parse(now)) } : {}),
    authorizedAt: now,
  };

  return {
    content: {
      ...Object.fromEntries(SLACK_TEST_ACCOUNTS.map(account => [account.json, accounts.get(account.id) ?? ''])),
      meta: {
        note: 'Generated by scripts/slack-test-oauth.mjs. Local secret: never commit. Slack user tokens plus non-secret account metadata.',
        updatedAt: now,
        scope: SLACK_TEST_USER_SCOPE,
        teamId: result.teamId,
        accounts: metaAccounts,
      },
    },
    accounts,
  };
}

/**
 * Write the store atomically with mode 0600: a temp file in the same directory is written, mode set,
 * then renamed over the target, so a reader never observes a partial file.
 */
export function writeTokenStore(path, content, { mode = 0o600 } = {}) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = resolve(directory, `.${path.split('/').pop()}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(content, null, 2)}\n`, { encoding: 'utf8', mode });
  chmodSync(temporaryPath, mode);
  renameSync(temporaryPath, path);
  return path;
}

/** POST a Slack API method as form data; only the caller sees the token. */
export async function slackPost(url, params, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) body.set(key, String(value));
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new OAuthError('network', `request to ${url} failed: ${redactTokens(error?.message ?? error)}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new OAuthError('invalid-response', `${url} returned a non-JSON response (HTTP ${response.status})`);
  }
  return { status: response.status, payload };
}

/** Exchange the authorization code. No `client_secret` is sent; PKCE replaces it. */
export async function exchangeCode({ clientId, code, codeVerifier, redirect, fetchImpl = globalThis.fetch }) {
  const { payload } = await slackPost(
    ACCESS_URL,
    { client_id: clientId, code, code_verifier: codeVerifier, redirect_uri: redirect },
    { fetchImpl },
  );
  return payload;
}

/** Confirm the new user token works and, again, that it is the expected person in the expected team. */
export async function verifyUserToken(account, token, { fetchImpl = globalThis.fetch } = {}) {
  const { payload } = await slackPost(AUTH_TEST_URL, { token }, { fetchImpl });
  if (payload?.ok !== true) {
    throw new OAuthError('auth-failed', `auth.test refused ${account.id} (${redactTokens(payload?.error ?? 'unknown_error')})`);
  }
  const teamId = normalize(payload.team_id ?? '');
  if (teamId !== normalize(SLACK_TEST_TEAM_ID)) {
    throw new OAuthError('team-mismatch', `${account.id} resolved to workspace ${teamId || '<none>'}, expected ${SLACK_TEST_TEAM_ID}`);
  }
  const userId = normalize(payload.user_id ?? '');
  if (userId !== normalize(account.expectedUserId)) {
    throw new OAuthError('user-mismatch', `${account.id} resolved to user ${userId || '<none>'}, expected ${account.expectedUserId}`);
  }
  return { id: account.id, userId, teamId, user: trim(payload.user), botId: trim(payload.bot_id) };
}

/**
 * Wait for exactly one loopback callback on `port`.
 *
 * The listener settles on the first request that carries a `code`/`error`, rejects on a wrong
 * `state`, and is fully closed before the returned promise settles, so a second callback cannot land
 * and the same port is immediately reusable for the next account in a five-account run.
 */
export function waitForCallback({ port, path = DEFAULT_REDIRECT_PATH, expectedState, timeoutMs = 300000, host = '127.0.0.1' }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let handled = false;
    let closing = false;
    let timer;

    const server = createServer((request, response) => {
      if (handled) {
        response.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Another authorization is already in progress.\n');
        return;
      }
      const requestPath = String(request.url ?? '');
      if (requestPath.split('?')[0] !== path) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found.\n');
        return;
      }

      let query;
      try {
        query = parseCallbackPath(requestPath);
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('The callback could not be parsed.\n');
        handled = true;
        response.on('finish', () => finish(() => rejectPromise(error)));
        return;
      }

      try {
        verifyCallbackState(query, expectedState);
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('The authorization state did not match; nothing was exchanged.\n');
        handled = true;
        response.on('finish', () => finish(() => rejectPromise(error)));
        return;
      }

      const notice = callbackErrorNotice(query);
      if (notice || !query.code) {
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(`${notice ?? 'The callback carried no authorization code.'}\n`);
        handled = true;
        response.on('finish', () =>
          finish(() => rejectPromise(new OAuthError('callback-refused', notice ?? 'the callback carried no code'))),
        );
        return;
      }

      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Authorization received. You can close this tab and return to the terminal.\n');
      handled = true;
      response.on('finish', () => finish(() => resolvePromise({ code: query.code, state: query.state })));
    });

    server.on('error', error => {
      finish(() =>
        rejectPromise(
          new OAuthError(
            'listen-failed',
            `could not listen on ${host}:${port} (${error?.code ?? 'unknown'}); is another OAuth run or another process using that port?`,
          ),
        ),
      );
    });

    timer = setTimeout(() => {
      finish(() => rejectPromise(new OAuthError('timeout', 'no callback arrived before the timeout; nothing was exchanged')));
    }, timeoutMs);
    timer.unref?.();

    server.listen(port, host);

    /** Close the listener completely before the caller continues, so the port is free again. */
    function finish(settle) {
      if (closing) return;
      closing = true;
      clearTimeout(timer);
      server.close(() => settle());
    }
  });
}

function parseArgs(argv) {
  const [command = 'start', ...rest] = argv;
  const flags = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      flags.set(name, true);
      continue;
    }
    flags.set(name, value);
    index += 1;
  }
  return { command, flags };
}

const USAGE = `Local Slack PKCE user-token helper (no client secret, user scope only)

Usage:
  SLACK_TEST_CLIENT_ID=<client-id> \\
  SLACK_TEST_REDIRECT_URI=https://<tunnel-host>/oauth/callback \\
  node scripts/slack-test-oauth.mjs start --account <lead|member|dir1|dir2|dir3> [--port 8765] [--dry-run]

Accounts and the user each one must resolve to:
${SLACK_TEST_ACCOUNTS.map(account => `  ${account.id.padEnd(7)} ${account.expectedUserId}`).join('\n')}

The Slack app must have PKCE enabled, and SLACK_TEST_REDIRECT_URI must be the HTTPS redirect URL the
app has registered. Slack rejects an http://localhost redirect URL in the app settings UI, so use a
temporary tunnel that forwards to the loopback listener, for example:

  cloudflared tunnel --url http://127.0.0.1:${DEFAULT_OAUTH_PORT}

This helper never starts a tunnel and never sees the tunnel's credentials; it only validates the URL
and listens on http://127.0.0.1:${DEFAULT_OAUTH_PORT}${DEFAULT_REDIRECT_PATH}. Enabling PKCE is one-way
and cannot be undone without Slack support. User tokens are written to:
  ${DEFAULT_TOKEN_STORE}

--dry-run prints the authorize URL and the redirect that must be registered, then exits without
starting a listener, exchanging a code or touching the token file. No command prints a token, a
refresh token or an authorization code.`;

async function commandStart({ flags }) {
  const account = resolveAccount(flags.get('account') ?? '');
  const clientId = requireClientId();
  const port = flags.get('port') === undefined ? resolvePort() : resolvePort({ SLACK_TEST_OAUTH_PORT: String(flags.get('port')) });
  const redirect =
    typeof flags.get('redirect-uri') === 'string'
      ? resolveRedirectUri({ env: { ...process.env, SLACK_TEST_REDIRECT_URI: String(flags.get('redirect-uri')) }, port })
      : resolveRedirectUri({ port });
  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);
  const state = createState();
  const authorizeUrl = buildAuthorizeUrl({ clientId, redirect, state, codeChallenge });

  console.log(`Account: ${account.id} (must authorize as ${account.expectedUserId})`);
  console.log(`Redirect URI (must match the Slack app exactly): ${redirect}`);
  console.log(`Local listener: http://127.0.0.1:${port}${DEFAULT_REDIRECT_PATH}`);
  if (redirect.startsWith('https://') && !redirect.includes('localhost')) {
    console.log('Forward the tunnel to the local listener before consenting.');
  }
  console.log('Authorize URL (no secret in it):');
  console.log(authorizeUrl.toString());

  if (flags.get('dry-run') === true) {
    console.log('Dry run: no listener started, no code exchanged, token file untouched.');
    return 0;
  }

  console.log(`Waiting for the callback on http://localhost:${port}${DEFAULT_REDIRECT_PATH} ...`);
  const callback = await waitForCallback({ port, expectedState: state });
  const payload = await exchangeCode({ clientId, code: callback.code, codeVerifier, redirect });
  const result = normalizeAccessPayload(payload, account);
  const verified = await verifyUserToken(account, result.token);

  const existing = readTokenStore(DEFAULT_TOKEN_STORE);
  const { content, accounts } = buildStoreUpdate(existing, result);
  writeTokenStore(DEFAULT_TOKEN_STORE, content);

  console.log(`Verified ${account.id} as <@${verified.userId}> in ${verified.teamId} (${verified.user}).`);
  console.log(`Stored user token for ${account.id} at ${DEFAULT_TOKEN_STORE} (mode 0600, atomic replace).`);
  console.log(`Accounts now present in the store: ${[...accounts.keys()].join(', ')}`);
  if (result.refreshTokenRequired) {
    console.log('Refresh token stored; with PKCE enabled it expires 30 days after issue, so reauthorize before it does.');
  }
  console.log('No token value was printed.');
  return 0;
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'help' || flags.get('help') === true) {
    console.log(USAGE);
    return 0;
  }
  if (command !== 'start') throw new OAuthError('usage', `unknown command ${command}`);
  return commandStart({ flags });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main()
    .then(code => {
      process.exitCode = code ?? 0;
    })
    .catch(error => {
      if (error instanceof OAuthError) {
        console.error(redactTokens(error.message));
        if (error.code === 'usage') console.error(`\n${USAGE}`);
      } else {
        console.error(redactTokens(error?.stack ?? error));
      }
      process.exitCode = 1;
    });
}
