// Local Slack governance test harness library: five required test identities plus one optional `guest`
// identity, user OAuth tokens only.
//
// Dependency-free and credential-safe. It reads per-account user tokens from a gitignored local
// file or environment, verifies each token with `auth.test`, and refuses to continue on any
// workspace or identity mismatch. Tokens are never logged, echoed in errors, or returned.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const repoRoot = fileURLToPath(new URL('../', import.meta.url));

/**
 * Local, gitignored secret files, checked in this order. The first file that defines a key wins,
 * so an operator override in `secrets/` or a `--file` path still beats OAuth helper output.
 */
export const DEFAULT_TOKEN_PATHS = [
  resolve(repoRoot, 'secrets/slack-test-tokens.json'),
  resolve(repoRoot, 'runtime/slack-test-tokens.json'),
  resolve(repoRoot, '.env.slack-test.local'),
];

/** The one workspace these test identities must belong to. */
export const SLACK_TEST_TEAM_ID = 'T0C4GRL55HB';

/**
 * `lead` is the identity the harness sends as; the other four are directory/approver identities.
 * `env` names the per-account environment variable, `json` the key inside the local token file.
 *
 * The five below are **required**: their Slack user ids are fixed in this workspace, so absence of a
 * token is an error. `guest` is the optional sixth identity (see `SLACK_TEST_OPTIONAL_IDENTITIES`).
 */
export const SLACK_TEST_IDENTITIES = [
  { id: 'lead', expectedUserId: 'U0C4V074CTW', json: 'REIN_SLACK_USER_TOKEN_LEAD', env: 'SLACK_USER_TOKEN_LEAD' },
  { id: 'member', expectedUserId: 'U0C5KLD8Z5E', json: 'REIN_SLACK_USER_TOKEN_MEMBER', env: 'SLACK_USER_TOKEN_MEMBER' },
  { id: 'dir1', expectedUserId: 'U0C4L74033P', json: 'REIN_SLACK_USER_TOKEN_DIR1', env: 'SLACK_USER_TOKEN_DIR1' },
  { id: 'dir2', expectedUserId: 'U0C4T82EPPB', json: 'REIN_SLACK_USER_TOKEN_DIR2', env: 'SLACK_USER_TOKEN_DIR2' },
  { id: 'dir3', expectedUserId: 'U0C4L74QGCD', json: 'REIN_SLACK_USER_TOKEN_DIR3', env: 'SLACK_USER_TOKEN_DIR3' },
];

/**
 * Optional synthetic identities. A `guest` account is meant for the unlinked-identity case (a real
 * invited person whose Slack profile email matches no community record), so its Slack user id is
 * **not** known at build time and must never be hardcoded. The id is supplied by the operator through
 * gitignored configuration, and the account is enrolled only when both the id and a user token are
 * present. No id or token is ever committed; a missing configuration simply leaves the account out.
 */
export const SLACK_TEST_OPTIONAL_IDENTITIES = [
  {
    id: 'guest',
    // Name of the gitignored config/env entries; the value is the Slack user id, e.g. `U0123ABCDEF`.
    idEnv: 'SLACK_USER_ID_GUEST',
    idJson: 'REIN_SLACK_USER_ID_GUEST',
    json: 'REIN_SLACK_USER_TOKEN_GUEST',
    env: 'SLACK_USER_TOKEN_GUEST',
  },
];

/** Slack workspace member ids are upper-case `U`/`W` prefixed, 9-11 characters. */
const SLACK_USER_ID_PATTERN = /^[UW][A-Z0-9]{6,14}$/;

/** Whether a value looks like a Slack member id (never a token). */
export function isSlackUserId(value) {
  return SLACK_USER_ID_PATTERN.test(trim(value));
}

/**
 * Resolve the optional identities the operator has configured. An entry is enrolled only when its
 * user id is present and well formed; a token alone is not enough, because `auth.test` must be able
 * to compare the resolved user id against an expected one. Returns descriptors shaped exactly like
 * `SLACK_TEST_IDENTITIES`, so every downstream helper treats them the same way.
 */
export function resolveOptionalIdentities({ env = process.env, meta = {} } = {}) {
  const resolved = [];
  for (const optional of SLACK_TEST_OPTIONAL_IDENTITIES) {
    const fromEnv = env[optional.idEnv] ?? env[optional.idJson];
    const fromMeta = rotationEntry(meta, optional.id).expectedUserId;
    const expectedUserId = trim(isSlackUserId(fromEnv) ? fromEnv : fromMeta);
    if (!isSlackUserId(expectedUserId)) continue;
    resolved.push({ ...optional, expectedUserId: normalize(expectedUserId) });
  }
  return resolved;
}

/**
 * Every identity active for one run: the five required ones first, then any configured optional
 * identities. Order is stable so output and tests do not depend on optional enrolment.
 */
export function activeIdentities({ env = process.env, meta = {} } = {}) {
  return [...SLACK_TEST_IDENTITIES, ...resolveOptionalIdentities({ env, meta })];
}

/** Only the channels below may receive test messages. */
export const SLACK_TEST_CHANNELS = [
  { id: 'C0C4L0YN814', label: 'proposal' },
  { id: 'C0C5KGG01A4', label: 'board' },
];

/** The account every test message must mention. */
export const SLACK_TEST_MENTION_USER_ID = 'U0C5G9Y8HLG';

/** Token rotation is refused when the token is expired or expires within this window. */
export const TOKEN_SKEW_MS = 120_000;

/** Shape shared with the OAuth helper: flat token keys plus one `meta` object for rotation data. */
export const TOKEN_META_KEY = 'meta';

export class HarnessError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'HarnessError';
    this.code = code;
  }
}

const trim = value => (typeof value === 'string' ? value.trim() : '');
const isToken = value => trim(value).startsWith('xoxp-');

/** Parse `KEY=value` lines, ignoring blank lines and `#` comments. No shell escape processing. */
export function parseEnvText(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    out.set(match[1], match[2].trim().replace(/^["']|["']$/g, ''));
  }
  return out;
}

/** Normalize a `KEY=value` map into the `{ tokens, meta }` shape used by the JSON reader. */
function envTokensFromMap(map) {
  const doc = {};
  for (const [key, value] of map) doc[key] = value;
  return readJsonTokenDoc(doc);
}

/** Strip any `xoxp-` token substring from text so provider or accidental echoes stay redacted. */
export function redactTokens(text) {
  return String(text).replace(/xoxp-[A-Za-z0-9-]+/g, '[redacted-user-token]');
}

function readTokenFile(path) {
  const text = readFileSync(path, 'utf8');
  if (path.endsWith('.json')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HarnessError('token-file', `${path} is not valid JSON`);
    }
    return readJsonTokenDoc(parsed);
  }
  return envTokensFromMap(parseEnvText(text));
}

const TOKEN_ALIASES = new Map();
for (const identity of SLACK_TEST_IDENTITIES) {
  TOKEN_ALIASES.set(identity.json, identity.id);
  TOKEN_ALIASES.set(identity.env, identity.id);
}
// Optional identities are read from the same document, but their enrolment still depends on a
// configured user id, so a stray `guest` token alone never enrolls the account.
for (const identity of SLACK_TEST_OPTIONAL_IDENTITIES) {
  TOKEN_ALIASES.set(identity.json, identity.id);
  TOKEN_ALIASES.set(identity.env, identity.id);
}

/** The base ids whose descriptors are fixed in code; used to distinguish required from optional. */
const REQUIRED_IDENTITY_IDS = new Set(SLACK_TEST_IDENTITIES.map(identity => identity.id));

/** Whether a token document key maps to a known identity id. */
function isKnownIdentityId(id) {
  return REQUIRED_IDENTITY_IDS.has(id) || SLACK_TEST_OPTIONAL_IDENTITIES.some(item => item.id === id);
}

/**
 * Read the shared token document. Contract: flat top-level keys
 * `REIN_SLACK_USER_TOKEN_<LEAD|MEMBER|DIR1|DIR2|DIR3>` (or the `SLACK_USER_TOKEN_*` alias) mapped to
 * `xoxp-` strings, plus one ignored `meta` object holding rotation data. A nested `accounts` wrapper
 * is accepted as a read-only fallback. Non-string values are skipped rather than stringified.
 */
export function readJsonTokenDoc(doc) {
  const tokens = new Map();
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { tokens, meta: {} };

  const assign = (key, value) => {
    const accountId = TOKEN_ALIASES.get(key);
    if (!accountId) return;
    if (typeof value === 'string' && isToken(value)) tokens.set(accountId, trim(value));
  };

  for (const [key, value] of Object.entries(doc)) {
    if (key === TOKEN_META_KEY) continue;
    if (key === 'accounts' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [accountId, entry] of Object.entries(value)) {
        if (!isKnownIdentityId(accountId)) continue;
        if (typeof entry === 'string') {
          if (isToken(entry)) tokens.set(accountId, trim(entry));
          continue;
        }
        if (!entry || typeof entry !== 'object') continue;
        for (const field of ['accessToken', 'token', 'userToken']) {
          if (isToken(entry[field])) {
            tokens.set(accountId, trim(entry[field]));
            break;
          }
        }
      }
      continue;
    }
    assign(key, value);
  }

  const meta = doc[TOKEN_META_KEY] && typeof doc[TOKEN_META_KEY] === 'object' ? doc[TOKEN_META_KEY] : {};
  return { tokens, meta };
}

/**
 * Resolve one user token per account from the environment or the first local file that defines it.
 * Throws a single aggregated error listing only which accounts are missing; never prints values.
 *
 * The five required identities must all be present. An optional identity is loaded only when the
 * operator has configured its user id (see `resolveOptionalIdentities`), so the same helper works
 * unchanged whether or not a `guest` account exists.
 */
export function loadUserTokens({ env = process.env, paths = DEFAULT_TOKEN_PATHS, identities } = {}) {
  const existing = paths.filter(path => existsSync(path));
  const fileMaps = existing.map(path => {
    try {
      return { path, ...readTokenFile(path) };
    } catch (error) {
      if (error instanceof HarnessError) return { path, map: new Map(), meta: {} };
      throw error;
    }
  });

  // Merge meta from every readable file first, so an optional identity's expected user id may live in
  // the token document itself rather than only in the environment.
  const mergedMeta = {};
  for (const file of fileMaps) Object.assign(mergedMeta, file.meta ?? {});
  const wanted = identities ?? activeIdentities({ env, meta: mergedMeta });

  const tokens = new Map();
  const meta = {};
  const missing = [];
  for (const identity of wanted) {
    const fromEnv = env[identity.env] ?? env[identity.json];
    if (isToken(fromEnv)) {
      tokens.set(identity.id, trim(fromEnv));
      continue;
    }
    let value = '';
    for (const file of fileMaps) {
      const candidate = (file.tokens ?? file.map).get(identity.id);
      if (isToken(candidate)) {
        value = trim(candidate);
        Object.assign(meta, file.meta ?? {});
        break;
      }
    }
    if (value) tokens.set(identity.id, value);
    // A required identity, and an optional identity the operator has already enrolled by configuring
    // its user id, must both carry a token; only a wholly unconfigured optional account is skipped.
    else missing.push(`${identity.id} (${identity.env})`);
  }

  if (missing.length > 0) {
    throw new HarnessError(
      'missing-tokens',
      [
        'No Slack user OAuth token (xoxp-...) found for:',
        ...missing.map(item => `  - ${item}`),
        'Provide them in the environment or in a gitignored local file:',
        ...paths.map(path => `  - ${path}`),
        'Bot tokens and xapp- app tokens are not accepted; this harness authenticates as users.',
      ].join('\n'),
    );
  }
  return { tokens, meta };
}

/** POST a Slack Web API method. Only the caller sees the token; results never carry it. */
export async function slackApi(method, token, params = {}, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) body.set(key, String(value));
  let response;
  try {
    response = await fetchImpl(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new HarnessError('network', `Slack ${method} request failed: ${redactTokens(error?.message ?? error)}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new HarnessError('invalid-response', `Slack ${method} returned a non-JSON response (HTTP ${response.status})`);
  }
  return { status: response.status, payload };
}

const normalize = value => trim(value).toUpperCase();

/**
 * Verify one token with `auth.test` and fail closed unless the workspace and user ID match exactly.
 * Returns `{ id, userId, team, teamId, teamRaw, user, url, botId }`; never a token.
 */
export async function verifyIdentity(identity, token, { fetchImpl = globalThis.fetch, expectedTeamId = SLACK_TEST_TEAM_ID } = {}) {
  const { payload } = await slackApi('auth.test', token, {}, { fetchImpl });
  if (payload?.ok !== true) {
    throw new HarnessError(
      'auth-failed',
      `auth.test refused ${identity.id} (${redactTokens(payload?.error ?? 'unknown_error')})`,
    );
  }
  const teamId = normalize(payload.team_id ?? '');
  if (teamId !== normalize(expectedTeamId)) {
    throw new HarnessError(
      'team-mismatch',
      `${identity.id} resolved to workspace ${teamId || '<none>'}, expected ${expectedTeamId}`,
    );
  }
  const userId = normalize(payload.user_id ?? '');
  if (userId !== normalize(identity.expectedUserId)) {
    throw new HarnessError(
      'user-mismatch',
      `${identity.id} resolved to user ${userId || '<none>'}, expected ${identity.expectedUserId}`,
    );
  }
  if (trim(payload.bot_id)) {
    throw new HarnessError('bot-token', `${identity.id} presented a bot identity (bot_id set); user tokens only`);
  }
  return {
    id: identity.id,
    userId,
    expectedUserId: identity.expectedUserId,
    team: payload.team ?? '',
    teamId,
    teamRaw: trim(payload.team_id ?? ''),
    user: payload.user ?? '',
    url: trim(payload.url ?? ''),
    botId: trim(payload.bot_id ?? ''),
  };
}

/**
 * Verify the five required identities and any enrolled optional identity, returning a Map keyed by
 * account id. Fails before any message is sent. `identities` defaults to the accounts present in
 * `tokens`, so callers that already resolved the active set keep exact control.
 */
export async function verifyAllIdentities(tokens, options = {}) {
  const wanted = options.identities ?? activeIdentities({ env: options.env ?? {}, meta: options.meta ?? {} });
  const verified = new Map();
  for (const identity of wanted) {
    const token = tokens.get(identity.id);
    if (!token) {
      // Skip an optional account that is not enrolled; a required one is always an error.
      if (!SLACK_TEST_IDENTITIES.some(base => base.id === identity.id) && options.requireOptional !== true) {
        continue;
      }
      throw new HarnessError('missing-tokens', `No token loaded for ${identity.id}`);
    }
    verified.set(identity.id, await verifyIdentity(identity, token, options));
  }
  return verified;
}

export function normalizeChannelId(value) {
  return normalize(value);
}

/** Throw unless the channel is one of the two approved test channels. */
export function assertAllowedChannel(channelId) {
  const normalized = normalizeChannelId(channelId);
  const allowed = SLACK_TEST_CHANNELS.find(channel => channel.id === normalized);
  if (!allowed) {
    throw new HarnessError(
      'channel-not-allowed',
      `channel ${normalized || '<none>'} is not an approved test channel; allowed: ${SLACK_TEST_CHANNELS.map(c => c.id).join(', ')}`,
    );
  }
  return allowed;
}

export function isValidCaseKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{6,128}$/.test(value);
}

export function assertCaseKey(value) {
  if (!isValidCaseKey(value)) {
    throw new HarnessError(
      'invalid-case-key',
      'case key must be 6-128 characters of letters, digits, dot, underscore, colon or hyphen',
    );
  }
  return value;
}

/**
 * Derive a stable idempotency key from a case key. The same case key always yields the same key, so
 * a repeat can be detected locally and the same value travels as the documented `client_msg_id`.
 *
 * Note: `client_msg_id` is the documented `chat.postMessage` argument for a client-side message
 * identity; unlike the undocumented `dedupe` field it is safe to send. Slack treats it as an
 * identity hint, not a hard exactly-once guarantee, so the local run ledger remains the authority.
 */
export function idempotencyKey(caseKey, accountId, channelId) {
  return `rein-slack-test:${caseKey}:${accountId}:${normalizeChannelId(channelId)}`;
}

/**
 * Slack returns an existing message instead of posting again when it recognizes the same
 * `client_msg_id`; `warning`/`response_metadata.messages` then report the deduplicated identity.
 */
export function clientMsgIdDuplicateNotice(response) {
  const warning = String(response?.payload?.warning ?? '');
  const messages = response?.payload?.response_metadata?.messages;
  const mentioned = text => /client_msg_id|dedupe/i.test(String(text));
  return (
    mentioned(warning) ||
    (Array.isArray(messages) && messages.some(mentioned))
  );
}

/**
 * A Slack `client_msg_id` must be a UUID. Derive a deterministic UUID (version 5 style, using the
 * idempotency key as the seed) so the same case key always produces the same identifier.
 */
export async function clientMsgIdForKey(dedupeKey) {
  const data = new TextEncoder().encode(dedupeKey);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
  const hex = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const variant = ((digest[8] & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(12, 15)}`,
    `${variant}${hex.slice(16, 18)}`,
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Local run ledger: records which case keys already produced a message in a channel. This is the
 * authority for skip-on-repeat, since Slack's client-side identity is only a hint.
 */
export function ledgerEntryKey(caseKey, accountId, channelId) {
  return idempotencyKey(caseKey, accountId, channelId);
}

export function readRunLedger(path) {
  if (!path || !existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function lookupLedger(ledger, caseKey, accountId, channelId) {
  const entry = ledger?.[ledgerEntryKey(caseKey, accountId, channelId)];
  return entry && typeof entry === 'object' ? entry : null;
}

export function mentionText(text) {
  return `${trim(text)} <@${SLACK_TEST_MENTION_USER_ID}>`;
}

/** Whether `text` already carries the required mention. */
export function hasMention(text) {
  return String(text).includes(`<@${SLACK_TEST_MENTION_USER_ID}>`);
}

/** The label every test message carries, so the same case is recognizable in the channel. */
export function caseLabel(caseKey, accountId) {
  return `[rein-slack-test case=${caseKey} as=${accountId}]`;
}

/** Extract a safe Slack permalink for a posted message, or null when Slack did not return one. */
export function permalinkFrom(response) {
  const permalink = trim(response?.payload?.message?.permalink);
  return permalink || null;
}

export function formatIdentity(verified) {
  return `${verified.id} (${verified.userId}) in ${verified.teamId}`;
}

/**
 * Read the rotation entry the OAuth helper records under `meta.accounts.<id>`. Accepts either
 * `meta.accounts.<id>` or `meta.<id>` so a simpler metadata layout still works.
 */
export function rotationEntry(meta, accountId) {
  const record = meta && typeof meta === 'object' ? meta : {};
  const accounts = record.accounts && typeof record.accounts === 'object' ? record.accounts : {};
  const entry = accounts[accountId] ?? record[accountId];
  return entry && typeof entry === 'object' ? entry : {};
}

/** Parse an expiry value that may be an ISO 8601 string or a millisecond/epoch-second number. */
export function parseExpiry(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Values below ~1e12 are epoch seconds; larger values are milliseconds.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value.trim());
    if (!Number.isNaN(parsed)) return parsed;
    const numeric = Number(value.trim());
    if (Number.isFinite(numeric)) return parseExpiry(numeric);
  }
  return null;
}

/**
 * Decide whether a user token may be used for a send. Fail closed on a token that is already
 * expired, expires within `TOKEN_SKEW_MS`, or is flagged as requiring a refresh the harness cannot
 * perform. Unknown expiry is accepted, which is correct for non-rotating classic user tokens.
 */
export function assessTokenFreshness(meta, accountId, { now = Date.now(), skewMs = TOKEN_SKEW_MS } = {}) {
  const entry = rotationEntry(meta, accountId);
  const expiresAt = parseExpiry(entry.expiresAt);

  if (expiresAt !== null) {
    if (expiresAt <= now) {
      return {
        usable: false,
        code: 'token-expired',
        expiresAt,
        detail: `${accountId} token expired at ${new Date(expiresAt).toISOString()}; reauthorize that account`,
      };
    }
    if (expiresAt - now <= skewMs) {
      return {
        usable: false,
        code: 'token-expired',
        expiresAt,
        detail: `${accountId} token expires at ${new Date(expiresAt).toISOString()}, inside the ${Math.round(skewMs / 1000)}s safety window; reauthorize that account`,
      };
    }

    // A recorded expiry in the future means the rotating token is still current. A refresh token
    // merely existing is normal for a rotating installation and must not block the send.
    return { usable: true, code: 'ok', expiresAt, detail: '' };
  }

  // No usable expiry. Fail closed only when the token is explicitly flagged as needing a refresh the
  // harness cannot perform, or as already expired. `refreshTokenRequired` on its own is not a signal
  // that the access token is stale; the OAuth helper sets it for every rotating account.
  const refreshFlagged = entry.refreshTokenRequired === true || entry.needsRefresh === true;
  const expiredFlagged = entry.expired === true || entry.tokenExpired === true;
  if (refreshFlagged || expiredFlagged) {
    return {
      usable: false,
      code: 'reauth-required',
      expiresAt,
      detail: `${accountId} has no usable expiry and is marked as needing a token refresh; reauthorize that account before sending`,
    };
  }

  return { usable: true, code: 'ok', expiresAt: null, detail: 'no expiry recorded' };
}

/** Throw when the sending account must not send. Never includes a token value. */
export function assertTokenFresh(meta, accountId, options = {}) {
  const assessment = assessTokenFreshness(meta, accountId, options);
  if (!assessment.usable) throw new HarnessError(assessment.code, assessment.detail);
  return assessment;
}

/**
 * Describe token presence and rotation state for operator diagnostics.
 * Returns only account ids, booleans and timestamps; never a token or refresh token.
 */
export function describeTokenStore(tokens, meta, { now = Date.now(), env = process.env } = {}) {
  return activeIdentities({ env, meta }).map(identity => {
    const entry = rotationEntry(meta, identity.id);
    const freshness = assessTokenFreshness(meta, identity.id, { now });
    return {
      id: identity.id,
      expectedUserId: identity.expectedUserId,
      present: tokens.has(identity.id),
      optional: !SLACK_TEST_IDENTITIES.some(base => base.id === identity.id),
      expiresAt: freshness.expiresAt === null ? null : new Date(freshness.expiresAt).toISOString(),
      refreshTokenRecorded: typeof entry.refreshToken === 'string' && entry.refreshToken.length > 0,
      refreshTokenRequired: entry.refreshTokenRequired === true,
      usable: freshness.usable,
      reason: freshness.usable ? 'ok' : freshness.code,
    };
  });
}

/**
 * Freshness check for every active account, used before any send so a stale peer is surfaced early.
 * An optional account is checked only when it is enrolled (its user id is configured).
 */
export function assertAllTokensFresh(meta, options = {}) {
  for (const identity of activeIdentities({ env: options.env ?? process.env, meta })) {
    assertTokenFresh(meta, identity.id, options);
  }
}
