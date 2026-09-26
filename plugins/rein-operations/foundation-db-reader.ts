// Read-only server-side reader for the Supabase tables that back Slack P0 identity linking and
// human-entered available-funds figures.
//
// Scope: PRD R02 (verify identity links and current eligibility; display names and platform role
// labels never establish identity), R21 (a designated finance lead records financial figures that
// the Agent may read) and the fail-closed posture required by AC01/AC06. The table contract below
// is the sibling foundation migration
// `supabase/migrations/20260924094436_rein_slack_identity_and_fund_snapshots.sql`, read-only:
//
//   public.<env>_rein_slack_links(slack_team_id, slack_user_id, contact_id, status,
//     verified_at, verified_by, revoked_at)      -- status is 'verified' or 'revoked'
//   public.<env>_rein_fund_snapshots(currency, available_minor, recorded_at, recorded_by,
//     source_note)                               -- human entered, integer minor units
//   public.<env>_community_contacts(id)
//   public.<env>_contributors(id, contact_id, status)
//   public.<env>_people(contact_id, contributor_id, person_type)
//
// Access model: those tables enable RLS, grant nothing to `anon` or `authenticated` and are
// readable by `service_role` only, so this reader authenticates with the server-only secret key
// over PostgREST. The key is never logged, echoed in an error or returned to a caller: every
// failure collapses to a fixed reason code, and a response body is never propagated.
//
// Limitations, because they decide what an answer means:
// - OpenClaw's version-2 tool context carries the chat account but no trustworthy Slack team ID,
//   so the team is fixed operator configuration. This reader proves that a Slack user ID is linked
//   inside the configured team. It cannot prove that a later caller is that user, so callers must
//   take the sender ID from trusted host context and must never accept a model-supplied ID.
// - This module only reads. It never reserves, approves, spends or reconciles money, and a funds
//   answer is an operator-entered figure, not a payment instruction.
// - Nothing here reads a clock, so freshness, expiry and deadline rules stay with the caller.
// - `people.person_type` is the only role source used. Free-text `people.role` and the publication
//   state are never selected, because neither establishes eligibility (R02).

export type FoundationEnvironment = 'dev' | 'prod';

export interface FoundationDbReaderConfig {
  /** Supabase project URL, for example `https://<project-ref>.supabase.co`. */
  supabaseUrl: string;
  /** Server-only secret or legacy service_role key. Never sent to a caller. */
  serviceRoleKey: string;
  /** Selects the `<env>_` table prefix. */
  environment: FoundationEnvironment;
  /**
   * Fixed Slack workspace ID for the one P0 platform. Configuration, not input: OpenClaw's v2 tool
   * context does not carry a trusted team ID, so a caller-supplied one could not be verified.
   */
  slackTeamId: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

export type SlackMemberStatus =
  | 'resolved'
  | 'invalid_request'
  | 'identity_not_linked'
  | 'identity_link_ambiguous'
  | 'identity_link_revoked'
  | 'identity_link_malformed'
  | 'member_record_malformed'
  | 'unavailable';

export interface SlackMemberResolution {
  status: SlackMemberStatus;
  /** Fixed reason code. Never provider text, and never part of the secret key. */
  reason: string;
  /** Canonical contact ID. Non-null only when `status` is `'resolved'`. */
  contactId: string | null;
  /** True only for a Contributor row whose `status` is exactly `'active'`. */
  isActiveContributor: boolean;
  /** Derived from `people.person_type = 'director'` via `contact_id` or `contributor_id`. */
  isDirector: boolean;
  /** HTTP status for a provider failure, otherwise null. */
  httpStatus: number | null;
}

export type AvailableFundsStatus = 'snapshot' | 'unknown' | 'invalid_request' | 'unavailable';

export interface AvailableFunds {
  status: AvailableFundsStatus;
  reason: string;
  /** The requested currency, or null when the request itself was rejected. */
  currency: string | null;
  /** Integer minor units. Non-null only when `status` is `'snapshot'`. */
  availableMinor: number | null;
  recordedAt: string | null;
  recordedBy: string | null;
  sourceNote: string | null;
  httpStatus: number | null;
  /** Always false: this figure is informational and never authorizes spending. */
  authorizesSpending: false;
}

export interface FoundationDbReader {
  readonly environment: FoundationEnvironment;
  readonly tablePrefix: string;
  /** Resolve one Slack user ID to its canonical contact ID and current Contributor/director flags. */
  resolveSlackMember(slackUserId: string): Promise<SlackMemberResolution>;
  /** Latest human-entered available-funds snapshot for one currency, or an explicit unknown. */
  readAvailableFunds(currency: string): Promise<AvailableFunds>;
}

interface QueryFailure {
  ok: false;
  reason: string;
  httpStatus: number | null;
}

interface QuerySuccess {
  ok: true;
  rows: readonly unknown[];
}

type QueryOutcome = QueryFailure | QuerySuccess;

const SLACK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const LINK_STATUSES = Object.freeze(['verified', 'revoked']);
const CONTRIBUTOR_STATUSES = Object.freeze(['active', 'inactive']);
const PERSON_TYPES = Object.freeze(['director', 'core_contributor']);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

const isoInstant = (value: unknown): string | null =>
  typeof value === 'string' && ISO_INSTANT_PATTERN.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : null;

/** `undefined` means present but malformed; `null` means the column is null. */
const optionalUuid = (value: unknown): string | null | undefined => {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : undefined;
};

const configError = (message: string): Error => new Error(`foundation db reader config: ${message}`);

const slackMemberFailure = (
  status: SlackMemberStatus,
  reason: string,
  httpStatus: number | null = null,
): SlackMemberResolution => ({
  status,
  reason,
  contactId: null,
  isActiveContributor: false,
  isDirector: false,
  httpStatus,
});

const fundsFailure = (
  status: AvailableFundsStatus,
  reason: string,
  currency: string | null,
  httpStatus: number | null = null,
): AvailableFunds => ({
  status,
  reason,
  currency,
  availableMinor: null,
  recordedAt: null,
  recordedBy: null,
  sourceNote: null,
  httpStatus,
  authorizesSpending: false,
});

/**
 * Build a reader bound to one Supabase environment and one Slack team.
 *
 * Throws only for invalid configuration, which is an operator error and not a data path. Failed
 * lookups resolve to a closed result instead, so a caller cannot mistake an error for an answer.
 */
export function createFoundationDbReader(config: FoundationDbReaderConfig): FoundationDbReader {
  const rawUrl = typeof config?.supabaseUrl === 'string' ? config.supabaseUrl.trim() : '';
  if (!rawUrl) throw configError('supabaseUrl is required');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw configError('supabaseUrl must be an absolute URL');
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw configError('supabaseUrl must use http or https');
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw configError('supabaseUrl must be a bare project URL without credentials, query or fragment');
  }
  const baseUrl = rawUrl.replace(/\/+$/, '');

  const serviceRoleKey = typeof config?.serviceRoleKey === 'string' ? config.serviceRoleKey.trim() : '';
  if (!serviceRoleKey) throw configError('serviceRoleKey is required');

  const environment = config?.environment;
  if (environment !== 'dev' && environment !== 'prod') {
    throw configError("environment must be 'dev' or 'prod'");
  }

  const slackTeamId = typeof config?.slackTeamId === 'string' ? config.slackTeamId.trim() : '';
  if (!SLACK_ID_PATTERN.test(slackTeamId)) {
    throw configError('slackTeamId must be a Slack ID such as T01234567');
  }

  const fetchImpl = config?.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw configError('a fetch implementation is required');

  const tablePrefix = `${environment}_`;

  const requestRows = async (table: string, params: Record<string, string>): Promise<QueryOutcome> => {
    const query = new URLSearchParams(params).toString();
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/rest/v1/${table}?${query}`, {
        method: 'GET',
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          accept: 'application/json',
        },
      });
    } catch {
      return { ok: false, reason: 'transport_error', httpStatus: null };
    }
    const httpStatus = typeof response?.status === 'number' ? response.status : null;
    if (!response || response.ok !== true) return { ok: false, reason: 'http_error', httpStatus };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: 'response_malformed', httpStatus };
    }
    if (!Array.isArray(body)) return { ok: false, reason: 'response_malformed', httpStatus };
    return { ok: true, rows: body };
  };

  const resolveSlackMember = async (slackUserId: string): Promise<SlackMemberResolution> => {
    const userId = typeof slackUserId === 'string' ? slackUserId.trim() : '';
    if (!SLACK_ID_PATTERN.test(userId)) {
      return slackMemberFailure('invalid_request', 'slack_user_id_invalid');
    }

    const links = await requestRows(`${tablePrefix}rein_slack_links`, {
      select: 'slack_team_id,slack_user_id,contact_id,status,verified_at,verified_by,revoked_at',
      slack_team_id: `eq.${slackTeamId}`,
      slack_user_id: `eq.${userId}`,
      // The table is unique on (slack_team_id, slack_user_id); a second row is a contract breach.
      limit: '2',
    });
    if (!links.ok) return slackMemberFailure('unavailable', links.reason, links.httpStatus);
    if (links.rows.length === 0) return slackMemberFailure('identity_not_linked', 'identity_not_linked');
    if (links.rows.length > 1) return slackMemberFailure('identity_link_ambiguous', 'identity_link_ambiguous');

    const rawLink = links.rows[0];
    if (!isPlainObject(rawLink)) return slackMemberFailure('identity_link_malformed', 'link_row_malformed');
    // Re-check scope locally: a row outside the configured team is never a match, whatever the
    // server-side filter returned.
    if (rawLink.slack_team_id !== slackTeamId || rawLink.slack_user_id !== userId) {
      return slackMemberFailure('identity_link_malformed', 'link_row_out_of_scope');
    }
    const contactId = optionalUuid(rawLink.contact_id);
    if (!contactId) return slackMemberFailure('identity_link_malformed', 'link_contact_id_malformed');
    const linkStatus = rawLink.status;
    if (typeof linkStatus !== 'string' || !LINK_STATUSES.includes(linkStatus)) {
      return slackMemberFailure('identity_link_malformed', 'link_status_malformed');
    }
    // Both the verified and the revoked state must keep the verification decision they rest on.
    if (isoInstant(rawLink.verified_at) === null || nonEmptyText(rawLink.verified_by) === null) {
      return slackMemberFailure('identity_link_malformed', 'link_verification_missing');
    }
    if (linkStatus === 'revoked') {
      if (isoInstant(rawLink.revoked_at) === null) {
        return slackMemberFailure('identity_link_malformed', 'link_revocation_missing');
      }
      return slackMemberFailure('identity_link_revoked', 'identity_link_revoked');
    }
    if (rawLink.revoked_at !== null) {
      return slackMemberFailure('identity_link_malformed', 'link_revoked_at_unexpected');
    }

    const contacts = await requestRows(`${tablePrefix}community_contacts`, {
      select: 'id',
      id: `eq.${contactId}`,
      limit: '2',
    });
    if (!contacts.ok) return slackMemberFailure('unavailable', contacts.reason, contacts.httpStatus);
    if (contacts.rows.length === 0) return slackMemberFailure('member_record_malformed', 'contact_missing');
    if (contacts.rows.length > 1) return slackMemberFailure('member_record_malformed', 'contact_ambiguous');
    const rawContact = contacts.rows[0];
    if (!isPlainObject(rawContact) || rawContact.id !== contactId) {
      return slackMemberFailure('member_record_malformed', 'contact_row_malformed');
    }

    const contributors = await requestRows(`${tablePrefix}contributors`, {
      select: 'id,contact_id,status',
      contact_id: `eq.${contactId}`,
      limit: '2',
    });
    if (!contributors.ok) return slackMemberFailure('unavailable', contributors.reason, contributors.httpStatus);
    if (contributors.rows.length > 1) {
      return slackMemberFailure('member_record_malformed', 'contributor_ambiguous');
    }
    let contributorId: string | null = null;
    let isActiveContributor = false;
    if (contributors.rows.length === 1) {
      const rawContributor = contributors.rows[0];
      if (!isPlainObject(rawContributor)) {
        return slackMemberFailure('member_record_malformed', 'contributor_row_malformed');
      }
      const contributor = optionalUuid(rawContributor.id);
      if (!contributor) return slackMemberFailure('member_record_malformed', 'contributor_id_malformed');
      if (rawContributor.contact_id !== contactId) {
        return slackMemberFailure('member_record_malformed', 'contributor_contact_mismatch');
      }
      const contributorStatus = rawContributor.status;
      if (typeof contributorStatus !== 'string' || !CONTRIBUTOR_STATUSES.includes(contributorStatus)) {
        return slackMemberFailure('member_record_malformed', 'contributor_status_malformed');
      }
      contributorId = contributor;
      isActiveContributor = contributorStatus === 'active';
    }

    // A director may be linked through the contact or through the Contributor record, so both keys
    // are queried. `people` is unique on `contact_id` and on `contributor_id`, so at most two rows
    // can match.
    const peopleParams: Record<string, string> = { select: 'contact_id,contributor_id,person_type', limit: '3' };
    if (contributorId) peopleParams.or = `(contact_id.eq.${contactId},contributor_id.eq.${contributorId})`;
    else peopleParams.contact_id = `eq.${contactId}`;
    const people = await requestRows(`${tablePrefix}people`, peopleParams);
    if (!people.ok) return slackMemberFailure('unavailable', people.reason, people.httpStatus);

    let isDirector = false;
    for (const rawPerson of people.rows) {
      if (!isPlainObject(rawPerson)) return slackMemberFailure('member_record_malformed', 'person_row_malformed');
      const personContactId = optionalUuid(rawPerson.contact_id);
      const personContributorId = optionalUuid(rawPerson.contributor_id);
      if (personContactId === undefined || personContributorId === undefined) {
        return slackMemberFailure('member_record_malformed', 'person_identifier_malformed');
      }
      const personType = rawPerson.person_type;
      if (typeof personType !== 'string' || !PERSON_TYPES.includes(personType)) {
        return slackMemberFailure('member_record_malformed', 'person_type_malformed');
      }
      const matchesContact = personContactId === contactId;
      const matchesContributor = contributorId !== null && personContributorId === contributorId;
      if (!matchesContact && !matchesContributor) {
        return slackMemberFailure('member_record_malformed', 'person_row_out_of_scope');
      }
      if (personType === 'director') isDirector = true;
    }

    return { status: 'resolved', reason: 'resolved', contactId, isActiveContributor, isDirector, httpStatus: null };
  };

  const readAvailableFunds = async (currency: string): Promise<AvailableFunds> => {
    const code = typeof currency === 'string' ? currency.trim() : '';
    if (!CURRENCY_PATTERN.test(code)) {
      return fundsFailure('invalid_request', 'currency_invalid', code || null);
    }

    // One row only: the newest human entry by `recorded_at`, with insertion order as a deterministic
    // tie-break. The reader never sums, averages or combines snapshots.
    const result = await requestRows(`${tablePrefix}rein_fund_snapshots`, {
      select: 'currency,available_minor,recorded_at,recorded_by,source_note',
      currency: `eq.${code}`,
      order: 'recorded_at.desc,created_at.desc',
      limit: '1',
    });
    if (!result.ok) return fundsFailure('unavailable', result.reason, code, result.httpStatus);
    if (result.rows.length === 0) return fundsFailure('unknown', 'no_snapshot', code);

    const rawSnapshot = result.rows[0];
    if (!isPlainObject(rawSnapshot)) return fundsFailure('unknown', 'snapshot_malformed', code);
    if (rawSnapshot.currency !== code) return fundsFailure('unknown', 'snapshot_currency_mismatch', code);
    const availableMinor = rawSnapshot.available_minor;
    if (!Number.isSafeInteger(availableMinor) || (availableMinor as number) < 0) {
      return fundsFailure('unknown', 'snapshot_amount_malformed', code);
    }
    const recordedAt = isoInstant(rawSnapshot.recorded_at);
    if (recordedAt === null) return fundsFailure('unknown', 'snapshot_recorded_at_malformed', code);
    const recordedBy = nonEmptyText(rawSnapshot.recorded_by);
    if (recordedBy === null) return fundsFailure('unknown', 'snapshot_recorded_by_missing', code);
    const sourceNote = rawSnapshot.source_note;
    if (sourceNote !== null && typeof sourceNote !== 'string') {
      return fundsFailure('unknown', 'snapshot_source_note_malformed', code);
    }

    return {
      status: 'snapshot',
      reason: 'snapshot',
      currency: code,
      availableMinor: availableMinor as number,
      recordedAt,
      recordedBy,
      sourceNote,
      httpStatus: null,
      authorizesSpending: false,
    };
  };

  return Object.freeze({ environment, tablePrefix, resolveSlackMember, readAvailableFunds });
}
