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
//   public.<env>_contact_identities(id, contact_id, identity_kind, normalized_value, created_at)
//                                                -- unique on (identity_kind, normalized_value);
//                                                   an email row stores lower(trim(email))
//   public.<env>_community_contacts(id)
//   public.<env>_contributors(id, contact_id, status)
//   public.<env>_people(contact_id, contributor_id, person_type)
//
// Access model: those tables enable RLS, grant nothing to `anon` or `authenticated` and are
// readable by `service_role` only, so this reader authenticates with the server-only secret key
// over PostgREST. The key generation decides the transport: a legacy `service_role` JWT travels in
// both the `apikey` and the bearer header, while a modern secret key is presented in `apikey`
// only, because Supabase never accepts one as a bearer token. The key is never logged, echoed in
// an error, placed in a URL or returned to a caller: every failure collapses to a fixed reason
// code, and a response body is never propagated.
//
// Limitations, because they decide what an answer means:
// - OpenClaw's version-2 tool context carries the chat account but no trustworthy Slack team ID,
//   so the team is fixed operator configuration. This reader proves that a Slack user ID is linked
//   inside the configured team. It cannot prove that a later caller is that user, so callers must
//   take the sender ID from trusted host context and must never accept a model-supplied ID.
// - Identity follows D13 once an email lookup is injected (`emailLookup`, for example
//   `createSlackEmailLookup(...)`): the sender's current Slack profile email must match exactly one
//   `<env>_contact_identities` email row, and that match is the **only** grant. Every request
//   derives the contact and its current role again, and nothing here creates, updates or persists a
//   link. The retained `<env>_rein_slack_links` table is no longer a grant: a `revoked` row vetoes
//   the sender, a `verified` row whose contact conflicts with the matched email vetoes the sender,
//   and a `verified` row that agrees grants nothing by itself. A missing or hidden profile email, a
//   lookup that cannot answer, an email matching no row or more than one row, a matched contact that
//   is soft-deleted, and a matched contact with no usable record all fail closed. Without an
//   injected lookup this module keeps its earlier link-only behaviour unchanged.
// - This module only reads. It never reserves, approves, spends or reconciles money, and a funds
//   answer is an operator-entered figure, not a payment instruction.
// - Nothing here reads a clock, so freshness, expiry and deadline rules stay with the caller.
// - `people.person_type` is the only role source used. Free-text `people.role` and the publication
//   state are never selected, because neither establishes eligibility (R02).

import {
  normalizeEmailAddress,
  type SlackEmailLookup,
  type SlackEmailLookupResult,
} from './slack-email-lookup.ts';

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
  /**
   * Optional Slack email identity source, for example `createSlackEmailLookup(...)`. Absent, this
   * reader reads the verified Slack link only and never contacts Slack. Present, D13 applies: the
   * profile email must match exactly one existing `contact_identities` email row, and that match is
   * the only grant. Link rows then only veto.
   */
  emailLookup?: SlackEmailLookup;
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
  | 'identity_link_conflict'
  | 'member_record_malformed'
  | 'unavailable';

export interface SlackMemberResolution {
  status: SlackMemberStatus;
  /** Fixed reason code. Never provider text, and never part of the secret key. */
  reason: string;
  /** Canonical contact ID. Non-null only when `status` is `'resolved'`. */
  contactId: string | null;
  /**
   * Which evidence resolved the member: `'slack_link'` for a verified `rein_slack_links` row,
   * `'contact_email'` for a Slack profile email that matched a `contact_identities` email row.
   * Null whenever `status` is not `'resolved'`.
   */
  matchedBy: 'slack_link' | 'contact_email' | null;
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
/**
 * Loopback hostnames, where a plaintext HTTP project URL is a local hop and never crosses a network.
 * Any other host must use HTTPS so the server key is never sent over an unencrypted connection.
 */
export const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const LINK_STATUSES = Object.freeze(['verified', 'revoked']);
const CONTRIBUTOR_STATUSES = Object.freeze(['active', 'inactive']);
const PERSON_TYPES = Object.freeze(['director', 'core_contributor']);
/**
 * Fixed reason for each Slack email-lookup outcome that means "no usable address", so a caller
 * never reads provider text and never mistakes a missing scope for a missing member.
 */
const EMAIL_LOOKUP_REASONS: Record<string, string> = {
  invalid_request: 'identity_email_lookup_invalid',
  not_found: 'identity_email_user_not_found',
  no_email: 'identity_email_missing',
  deleted: 'identity_email_deleted',
  not_human: 'identity_email_not_human',
  wrong_team: 'identity_email_team_mismatch',
  malformed: 'identity_email_lookup_malformed',
};

/**
 * Supabase serves two generations of server key and they travel differently. A legacy
 * `service_role` key is a three-segment JWT, which PostgREST expects in both the `apikey` and the
 * `Authorization: Bearer` header. A modern secret key is not a JWT: Supabase never accepts it as a
 * bearer token, so presenting one there turns every read, write and RPC into a 401. Only the shape
 * of the key decides the headers, and the key itself never appears in a URL, a body or a result.
 */
const LEGACY_JWT_KEY_PATTERN = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/**
 * The `apikey` header always, plus a bearer token only for a legacy JWT key. Shared with the
 * writer so reads, writes and RPCs authenticate identically.
 */
export const supabaseServiceRoleHeaders = (serviceRoleKey: string): Record<string, string> => {
  const headers: Record<string, string> = { apikey: serviceRoleKey };
  if (LEGACY_JWT_KEY_PATTERN.test(serviceRoleKey)) headers.authorization = `Bearer ${serviceRoleKey}`;
  return headers;
};

/**
 * 401 and 403 are the server key rejected before any table policy or trigger runs. Both are a
 * connection-authentication failure, never a governance decision, and both stay `unavailable`.
 */
export const isSupabaseAuthFailureStatus = (httpStatus: number): boolean =>
  httpStatus === 401 || httpStatus === 403;

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
  matchedBy: null,
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
  if (parsedUrl.protocol !== 'https:') {
    // The server key travels in a request header, so a plaintext project URL would expose it in
    // transit. Loopback is a local-development address whose hop never leaves the machine, and it
    // stays the one explicit exception.
    if (parsedUrl.protocol !== 'http:' || !LOOPBACK_HOSTNAMES.has(parsedUrl.hostname)) {
      throw configError('supabaseUrl must use https, or http on a loopback address for local development');
    }
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

  // The email-first path is optional and off unless an operator injects a lookup. A present but
  // unusable object is a configuration error rather than a silent fallback to the link-only path.
  const emailLookup = config?.emailLookup;
  if (emailLookup !== undefined && typeof emailLookup?.lookupEmail !== 'function') {
    throw configError('emailLookup must implement lookupEmail');
  }
  // Under D13 the email match is the grant, so the matched contact must still be usable. The
  // link-only reader keeps its earlier behaviour, including for a soft-deleted contact.
  const requiresUsableContact = emailLookup !== undefined;

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
          ...supabaseServiceRoleHeaders(serviceRoleKey),
          accept: 'application/json',
        },
      });
    } catch {
      return { ok: false, reason: 'transport_error', httpStatus: null };
    }
    const httpStatus = typeof response?.status === 'number' ? response.status : null;
    if (!response || response.ok !== true) {
      // A rejected key is named as its own reason so a caller never reads an authentication failure
      // as a plain provider error.
      const reason =
        httpStatus !== null && isSupabaseAuthFailureStatus(httpStatus) ? 'auth_error' : 'http_error';
      return { ok: false, reason, httpStatus };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: 'response_malformed', httpStatus };
    }
    if (!Array.isArray(body)) return { ok: false, reason: 'response_malformed', httpStatus };
    return { ok: true, rows: body };
  };

  /**
   * The member-record proof shared by both evidence paths: the contact exists exactly once, its
   * optional Contributor row is consistent, and `people.person_type` decides the director flag.
   * Both paths must prove the same thing, so neither one may carry its own copy of these rules.
   */
  const resolveMemberRecord = async (
    contactId: string,
  ): Promise<{ ok: true; isActiveContributor: boolean; isDirector: boolean } | { ok: false; result: SlackMemberResolution }> => {
    const contacts = await requestRows(`${tablePrefix}community_contacts`, {
      select: 'id,deleted_at',
      id: `eq.${contactId}`,
      limit: '2',
    });
    if (!contacts.ok) {
      return { ok: false, result: slackMemberFailure('unavailable', contacts.reason, contacts.httpStatus) };
    }
    if (contacts.rows.length === 0) {
      return { ok: false, result: slackMemberFailure('member_record_malformed', 'contact_missing') };
    }
    if (contacts.rows.length > 1) {
      return { ok: false, result: slackMemberFailure('member_record_malformed', 'contact_ambiguous') };
    }
    const rawContact = contacts.rows[0];
    if (!isPlainObject(rawContact) || rawContact.id !== contactId) {
      return { ok: false, result: slackMemberFailure('member_record_malformed', 'contact_row_malformed') };
    }
    // D13 derives the contact from the email match, so a soft-deleted contact is not a usable
    // grant. `null` and an absent marker both mean "not deleted"; a present but unparseable marker
    // is a malformed record rather than an implicit live contact.
    if (requiresUsableContact && rawContact.deleted_at !== null && rawContact.deleted_at !== undefined) {
      if (isoInstant(rawContact.deleted_at) === null) {
        return { ok: false, result: slackMemberFailure('member_record_malformed', 'contact_deleted_at_malformed') };
      }
      return { ok: false, result: slackMemberFailure('member_record_malformed', 'contact_deleted') };
    }

    const contributors = await requestRows(`${tablePrefix}contributors`, {
      select: 'id,contact_id,status',
      contact_id: `eq.${contactId}`,
      limit: '2',
    });
    if (!contributors.ok) {
      return { ok: false, result: slackMemberFailure('unavailable', contributors.reason, contributors.httpStatus) };
    }
    if (contributors.rows.length > 1) {
      return { ok: false, result: slackMemberFailure('member_record_malformed', 'contributor_ambiguous') };
    }
    let contributorId: string | null = null;
    let isActiveContributor = false;
    if (contributors.rows.length === 1) {
      const rawContributor = contributors.rows[0];
      if (!isPlainObject(rawContributor)) {
        return { ok: false, result: slackMemberFailure('member_record_malformed', 'contributor_row_malformed') };
      }
      const contributor = optionalUuid(rawContributor.id);
      if (!contributor) {
        return { ok: false, result: slackMemberFailure('member_record_malformed', 'contributor_id_malformed') };
      }
      if (rawContributor.contact_id !== contactId) {
        return { ok: false, result: slackMemberFailure('member_record_malformed', 'contributor_contact_mismatch') };
      }
      const contributorStatus = rawContributor.status;
      if (typeof contributorStatus !== 'string' || !CONTRIBUTOR_STATUSES.includes(contributorStatus)) {
        return { ok: false, result: slackMemberFailure('member_record_malformed', 'contributor_status_malformed') };
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
    if (!people.ok) {
      return { ok: false, result: slackMemberFailure('unavailable', people.reason, people.httpStatus) };
    }

    let isDirector = false;
    for (const rawPerson of people.rows) {
      if (!isPlainObject(rawPerson)) {
        return { ok: false, result: slackMemberFailure('member_record_malformed', 'person_row_malformed') };
      }
      const personContactId = optionalUuid(rawPerson.contact_id);
      const personContributorId = optionalUuid(rawPerson.contributor_id);
      if (personContactId === undefined || personContributorId === undefined) {
        return { ok: false, result: slackMemberFailure('member_record_malformed', 'person_identifier_malformed') };
      }
      const personType = rawPerson.person_type;
      if (typeof personType !== 'string' || !PERSON_TYPES.includes(personType)) {
        return { ok: false, result: slackMemberFailure('member_record_malformed', 'person_type_malformed') };
      }
      const matchesContact = personContactId === contactId;
      const matchesContributor = contributorId !== null && personContributorId === contributorId;
      if (!matchesContact && !matchesContributor) {
        return { ok: false, result: slackMemberFailure('member_record_malformed', 'person_row_out_of_scope') };
      }
      if (personType === 'director') isDirector = true;
    }

    return { ok: true, isActiveContributor, isDirector };
  };

  /**
   * The D13 probe and the only grant once a lookup is injected. The Slack lookup supplies an
   * address; this reader re-normalizes it locally and matches it against `<env>_contact_identities`,
   * which is unique on `(identity_kind, normalized_value)`. Every outcome is closed: a matched
   * contact, or a result that a caller returns as-is.
   */
  const resolveEmailIdentity = async (
    userId: string,
  ): Promise<{ kind: 'matched'; contactId: string } | { kind: 'closed'; result: SlackMemberResolution }> => {
    let raw: SlackEmailLookupResult | null = null;
    try {
      raw = await emailLookup!.lookupEmail(userId);
    } catch {
      // A lookup that throws is a broken provider, never a match.
      raw = null;
    }
    if (!isPlainObject(raw) || typeof raw.status !== 'string') {
      return {
        kind: 'closed',
        result: slackMemberFailure('unavailable', 'identity_email_lookup_unavailable'),
      };
    }
    const lookupHttpStatus = typeof raw.httpStatus === 'number' ? raw.httpStatus : null;
    if (raw.status !== 'found') {
      if (raw.status === 'unavailable') {
        return {
          kind: 'closed',
          result: slackMemberFailure('unavailable', 'identity_email_lookup_unavailable', lookupHttpStatus),
        };
      }
      const reason = EMAIL_LOOKUP_REASONS[raw.status] ?? 'identity_email_lookup_malformed';
      return { kind: 'closed', result: slackMemberFailure('identity_not_linked', reason) };
    }

    // A provider is not trusted to hand the reader a value that is placed in a database filter.
    const email = normalizeEmailAddress(raw.normalizedEmail);
    if (email === null) {
      return { kind: 'closed', result: slackMemberFailure('identity_not_linked', 'identity_email_missing') };
    }

    const identities = await requestRows(`${tablePrefix}contact_identities`, {
      select: 'contact_id,identity_kind,normalized_value',
      identity_kind: 'eq.email',
      normalized_value: `eq.${email}`,
      // The table is unique on (identity_kind, normalized_value); a second row is a contract breach.
      limit: '2',
    });
    if (!identities.ok) {
      return {
        kind: 'closed',
        result: slackMemberFailure('unavailable', identities.reason, identities.httpStatus),
      };
    }
    if (identities.rows.length === 0) {
      return { kind: 'closed', result: slackMemberFailure('identity_not_linked', 'identity_email_not_found') };
    }
    if (identities.rows.length > 1) {
      return { kind: 'closed', result: slackMemberFailure('identity_not_linked', 'identity_email_ambiguous') };
    }
    const rawIdentity = identities.rows[0];
    if (!isPlainObject(rawIdentity)) {
      return {
        kind: 'closed',
        result: slackMemberFailure('identity_link_malformed', 'identity_email_row_malformed'),
      };
    }
    // Re-check the row locally: a row outside the exact email claim is never a match, whatever the
    // server-side filter returned.
    if (rawIdentity.identity_kind !== 'email' || rawIdentity.normalized_value !== email) {
      return {
        kind: 'closed',
        result: slackMemberFailure('identity_link_malformed', 'identity_email_row_out_of_scope'),
      };
    }
    const contactId = optionalUuid(rawIdentity.contact_id);
    if (!contactId) {
      return {
        kind: 'closed',
        result: slackMemberFailure('identity_link_malformed', 'identity_email_contact_id_malformed'),
      };
    }
    return { kind: 'matched', contactId };
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
    if (links.rows.length > 1) return slackMemberFailure('identity_link_ambiguous', 'identity_link_ambiguous');

    let linkedContactId: string | null = null;
    if (links.rows.length === 1) {
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
        // The veto: a revoked link returns before the optional email probe, so a later address
        // change can never restore an identity an administrator deliberately revoked.
        return slackMemberFailure('identity_link_revoked', 'identity_link_revoked');
      }
      if (rawLink.revoked_at !== null) {
        return slackMemberFailure('identity_link_malformed', 'link_revoked_at_unexpected');
      }
      linkedContactId = contactId;
    }

    // Link-only reader: a verified link is the grant, exactly as before the email path existed. A
    // revoked link already returned above.
    if (!emailLookup) {
      if (linkedContactId === null) return slackMemberFailure('identity_not_linked', 'identity_not_linked');
      const record = await resolveMemberRecord(linkedContactId);
      if (!record.ok) return record.result;
      return {
        status: 'resolved',
        reason: 'resolved',
        contactId: linkedContactId,
        matchedBy: 'slack_link',
        isActiveContributor: record.isActiveContributor,
        isDirector: record.isDirector,
        httpStatus: null,
      };
    }

    // D13: the current profile email match is the only grant. It runs after the link table so a
    // revoked link has already vetoed the sender. A lookup that cannot answer, a missing or hidden
    // address, and an email that matches no row or more than one row all fail closed, whether or not
    // a link row exists.
    const outcome = await resolveEmailIdentity(userId);
    if (outcome.kind === 'closed') return outcome.result;
    // A retained verified link whose contact conflicts with the matched email vetoes the sender, so
    // a stale or wrong manual link can never be silently bypassed, and a conflicting one can never
    // be silently chosen over the live address.
    if (linkedContactId !== null && linkedContactId !== outcome.contactId) {
      return slackMemberFailure('identity_link_conflict', 'identity_email_conflict');
    }
    const record = await resolveMemberRecord(outcome.contactId);
    if (!record.ok) return record.result;
    return {
      status: 'resolved',
      reason: 'resolved',
      contactId: outcome.contactId,
      matchedBy: 'contact_email',
      isActiveContributor: record.isActiveContributor,
      isDirector: record.isDirector,
      httpStatus: null,
    };
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
