// Result contracts for the two governance reads. This module holds types only: the Agent opens no
// database connection and holds no database credential, so every read is executed by the
// authenticated Foundation backend through `backend-db-adapter.ts`, which returns exactly these
// shapes. The compatibility names below stay for the tool modules and the adapters that consume
// them.

export type FoundationEnvironment = 'dev' | 'prod';

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
  /** Fixed reason code from the backend. Never provider text and never a credential. */
  reason: string;
  /** Canonical contact ID. Non-null only when `status` is `'resolved'`. */
  contactId: string | null;
  /**
   * Which canonical evidence the backend resolved the member from: `'platform_link'` for a
   * canonical verified binding, `'slack_link'` for the retained Slack-specific spelling the
   * backend may still report. Null whenever `status` is not `'resolved'`.
   */
  matchedBy: 'platform_link' | 'slack_link' | null;
  /** True only for a Contributor record whose status is exactly `'active'`. */
  isActiveContributor: boolean;
  /** True only for a current director record. */
  isDirector: boolean;
  /** HTTP status for a backend failure, otherwise null. */
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
  /** Resolve one platform user ID to its canonical contact ID and current role flags. */
  resolveSlackMember(slackUserId: string): Promise<SlackMemberResolution>;
  /** Latest human-entered available-funds snapshot for one currency, or an explicit unknown. */
  readAvailableFunds(currency: string): Promise<AvailableFunds>;
}
