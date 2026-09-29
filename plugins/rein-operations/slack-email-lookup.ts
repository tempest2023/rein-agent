// Optional email-first identity source for the Slack P0 vertical slice: read one Slack user's
// profile email through the Slack Web API `users.info`, with a bot token that carries
// `users:read` and `users:read.email`.
//
// Scope: PRD R02 (verify identity links; a display name or platform label never establishes
// identity) and the fail-closed posture required by AC01/AC06. This module answers exactly one
// question for one configured workspace: "which normalized email address does this Slack user id
// currently publish, for a human account that is not deleted?" It never decides a contact, never
// writes, never reads a clock, and never returns or logs the bot token or the raw provider payload.
//
// What a match does and does not mean:
// - A match is evidence that an existing `contact_identities` email row belongs to whoever controls
//   this Slack account. It is not an administrator verification decision; the reader that consumes
//   it keeps the existing verified-link rules and refuses to contradict them.
// - `users:read.email` returns an address only when the workspace has one and the app holds the
//   scope. A missing scope, an invisible user and a genuinely absent address are different fixed
//   reasons, never a silent empty match.
// - Only the `Authorization` request header carries the credential: no token ever appears in a URL,
//   an error or a result.
//
// Access model: the Slack Web API answers most failures with HTTP 200 and `ok: false`, and
// transport-level trouble with a non-2xx status. Both paths fail closed here. The provider's
// `error` text is mapped to a fixed reason and is never propagated, because it can echo request
// data.

export const SLACK_USERS_INFO_URL = 'https://slack.com/api/users.info';

export type SlackEmailLookupStatus =
  | 'found'
  | 'invalid_request'
  | 'not_found'
  | 'no_email'
  | 'deleted'
  | 'not_human'
  | 'wrong_team'
  | 'malformed'
  | 'unavailable';

export interface SlackEmailLookupResult {
  status: SlackEmailLookupStatus;
  /** Fixed reason code. Never provider text, never the address, never the bot token. */
  reason: string;
  /** Normalized (trimmed and lowercased) address. Non-null only when `status` is `'found'`. */
  normalizedEmail: string | null;
  /** HTTP status for a provider failure, otherwise null. */
  httpStatus: number | null;
}

export interface SlackEmailLookupConfig {
  /** Bot token scoped to `users:read` and `users:read.email`. Never logged, echoed or returned. */
  botToken: string;
  /** The one Slack workspace this deployment serves; a profile from any other team is refused. */
  slackTeamId: string;
  /** Request timeout in milliseconds. Defaults to 10000. */
  timeoutMs?: number;
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface SlackEmailLookup {
  /** Resolve one Slack user id to the normalized email its profile publishes in this team. */
  lookupEmail(slackUserId: string): Promise<SlackEmailLookupResult>;
}

const SLACK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_EMAIL_LENGTH = 254;
/**
 * A deliberately strict address shape. `contact_identities.normalized_value` stores
 * `lower(trim(email))`, so trimming and lowercasing is the whole normalization contract. The
 * character set also excludes the separators PostgREST treats specially inside a filter value
 * (comma and parentheses), so a caller can place the result in an `eq.` filter verbatim.
 */
const EMAIL_PATTERN =
  /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Normalize one candidate address the same way the database stores it, or return null when it is
 * not a plain address. Exported so the reader can re-check a provider's answer instead of trusting
 * it, with one definition of "normalized".
 */
export function normalizeEmailAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH) return null;
  return EMAIL_PATTERN.test(email) ? email : null;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const configError = (message: string): Error => new Error(`slack email lookup config: ${message}`);

const failure = (
  status: SlackEmailLookupStatus,
  reason: string,
  httpStatus: number | null = null,
): SlackEmailLookupResult => ({ status, reason, normalizedEmail: null, httpStatus });

/** A rejected token or a missing scope needs an operator change before any lookup can succeed. */
const SLACK_AUTH_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'missing_scope',
  'no_permission',
  'not_allowed_token_type',
]);
/** Slack's own "there is no such user here" codes, which are a data answer, not an outage. */
const SLACK_NOT_FOUND_ERRORS = new Set(['user_not_found', 'user_not_visible', 'users_not_found']);
const SLACK_DELETED_ERRORS = new Set(['user_deleted', 'user_is_deleted']);

const isAuthFailureStatus = (httpStatus: number): boolean => httpStatus === 401 || httpStatus === 403;

/**
 * Build one lookup bound to one workspace and one bot token.
 *
 * Throws only for invalid configuration, which is an operator error and not a data path. Every
 * failed lookup resolves to a closed result instead, so a caller cannot mistake an error for an
 * answer.
 */
export function createSlackEmailLookup(config: SlackEmailLookupConfig): SlackEmailLookup {
  const botToken = typeof config?.botToken === 'string' ? config.botToken.trim() : '';
  if (!botToken) throw configError('botToken is required');

  const slackTeamId = typeof config?.slackTeamId === 'string' ? config.slackTeamId.trim() : '';
  if (!SLACK_ID_PATTERN.test(slackTeamId)) {
    throw configError('slackTeamId must be a Slack ID such as T01234567');
  }

  const timeoutMs = config?.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw configError('timeoutMs must be a positive integer');
  }

  const fetchImpl = config?.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw configError('a fetch implementation is required');

  const lookupEmail = async (slackUserId: string): Promise<SlackEmailLookupResult> => {
    const userId = typeof slackUserId === 'string' ? slackUserId.trim() : '';
    if (!SLACK_ID_PATTERN.test(userId)) return failure('invalid_request', 'slack_user_id_invalid');

    const query = new URLSearchParams({ user: userId }).toString();
    let response: Response;
    try {
      response = await fetchImpl(`${SLACK_USERS_INFO_URL}?${query}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${botToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return failure('unavailable', 'transport_error');
    }

    const httpStatus = typeof response?.status === 'number' ? response.status : null;
    if (!response || response.ok !== true) {
      const reason =
        httpStatus !== null && isAuthFailureStatus(httpStatus) ? 'auth_error' : 'http_error';
      return failure('unavailable', reason, httpStatus);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return failure('malformed', 'response_malformed', httpStatus);
    }
    if (!isPlainObject(body)) return failure('malformed', 'response_malformed', httpStatus);

    if (body.ok !== true) {
      // The provider's `error` string is never propagated: it is provider text, and a caller must
      // read a fixed reason instead.
      const error = typeof body.error === 'string' ? body.error : '';
      if (SLACK_AUTH_ERRORS.has(error)) return failure('unavailable', 'auth_error', httpStatus);
      if (SLACK_DELETED_ERRORS.has(error)) return failure('deleted', 'user_deleted', httpStatus);
      if (SLACK_NOT_FOUND_ERRORS.has(error)) return failure('not_found', 'user_not_found', httpStatus);
      return failure('unavailable', 'slack_error', httpStatus);
    }

    const user = body.user;
    if (!isPlainObject(user)) return failure('malformed', 'response_malformed', httpStatus);
    if (user.deleted === true) return failure('deleted', 'user_deleted', httpStatus);
    // A bot or app account can never stand in for a human community record, whatever address it
    // publishes.
    if (user.is_bot === true || user.is_app_user === true) {
      return failure('not_human', 'user_not_human', httpStatus);
    }
    if (nonEmptyText(user.team_id) !== slackTeamId) {
      return failure('wrong_team', 'team_mismatch', httpStatus);
    }

    const profile = isPlainObject(user.profile) ? user.profile : null;
    const email = normalizeEmailAddress(profile?.email);
    if (email === null) return failure('no_email', 'email_missing', httpStatus);

    return { status: 'found', reason: 'found', normalizedEmail: email, httpStatus: null };
  };

  return Object.freeze({ lookupEmail });
}
