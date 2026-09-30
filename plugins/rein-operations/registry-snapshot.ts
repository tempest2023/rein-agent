// Deterministic validation and freshness boundary for one authoritative member registry snapshot.
//
// Scope: PRD R01-R03 (identity linking and eligibility verification) and R10 (a frozen eligible
// roster before a selection round), with the fail-closed behaviour required by AC01 and AC06.
//
// Design rules:
// - Pure and side-effect free. No network, no clock, no random source and no database access. The
//   caller supplies the provider snapshot, the instant `at`, and an explicit `maxAgeMs`.
// - No default authority. There is no fallback role, no Contributor status implied by a Board
//   seat, and no eligibility from a display name or a platform role label. Malformed, stale,
//   duplicated or conflicting input fails closed instead of being repaired.
// - No role mutation. This module never grants, extends, suspends or revokes a role; the
//   authoritative provider remains the only writer. Lookups derive an answer and nothing else.
// - A provider snapshot is untrusted input. It is validated, deeply frozen and detached from the
//   caller's objects before any eligibility question is answered.
// - Freshness is re-evaluated on every lookup, because a snapshot that was current when it was
//   loaded can be stale at the moment a protected action is attempted.

import { accountKey } from './proposals.ts';

export interface RegistryProblem {
  code: string;
  path: string;
  message: string;
}

export interface RegistryRoleInput {
  role: string;
  status: string;
  expiresAt?: string | null;
}

export interface RegistryMemberInput {
  memberId: string;
  status: string;
  roles?: readonly RegistryRoleInput[] | null;
}

export interface RegistryLinkInput {
  platform: string;
  accountId: string;
  memberId: string;
  status: string;
  verifiedAt?: string | null;
}

export interface RegistrySnapshotInput {
  version: string;
  generatedAt: string;
  /** Optional single-platform scope. P0 runs one chat platform, still undecided. */
  platform?: string | null;
  members: readonly RegistryMemberInput[];
  links: readonly RegistryLinkInput[];
}

export interface RegistryBuildOptions {
  /** Instant the snapshot is used at, ISO 8601. Required; never read from the system clock. */
  at: string;
  /** Maximum accepted age in milliseconds. Required; there is no default tolerance. */
  maxAgeMs: number;
}

export interface FrozenRegistryRole {
  readonly role: string;
  readonly status: string;
  readonly expiresAt: string | null;
}

export interface FrozenRegistryMember {
  readonly memberId: string;
  readonly status: string;
  readonly roles: readonly FrozenRegistryRole[];
}

export interface FrozenRegistryLink {
  readonly platform: string;
  readonly accountId: string;
  readonly memberId: string;
  readonly status: string;
  readonly verifiedAt: string | null;
}

export interface RegistrySnapshot {
  readonly version: string;
  readonly generatedAt: string;
  readonly generatedAtMs: number;
  readonly platform: string | null;
  readonly maxAgeMs: number;
  readonly members: Readonly<Record<string, FrozenRegistryMember>>;
  /** Keyed by the shared proposals-core account key `${platform}:${accountId}`. */
  readonly links: Readonly<Record<string, FrozenRegistryLink>>;
  readonly memberIds: readonly string[];
  /** Canonical member id -> every linked account key, so multi-account members are not double counted. */
  readonly accountKeysByMember: Readonly<Record<string, readonly string[]>>;
}

export interface RegistryValidationResult {
  ok: boolean;
  problems: RegistryProblem[];
  snapshot: RegistrySnapshot | null;
}

export interface RegistryAccountLookup {
  status:
    | 'resolved'
    | 'snapshot_stale'
    | 'snapshot_generated_in_future'
    | 'platform_mismatch'
    | 'identity_not_linked'
    | 'identity_link_revoked'
    | 'authoritative_member_missing';
  reason: string;
  memberId: string | null;
  member: FrozenRegistryMember | null;
  link: FrozenRegistryLink | null;
}

export interface RegistryEligibility {
  eligible: boolean;
  reason: string;
  memberId: string | null;
}

export class RegistrySnapshotError extends Error {
  code: string;
  problems: RegistryProblem[];

  constructor(code: string, problems: RegistryProblem[] = []) {
    super(code);
    this.name = 'RegistrySnapshotError';
    this.code = code;
    this.problems = problems;
  }
}

const LINK_STATUSES = Object.freeze(['verified', 'revoked']);

const problem = (code: string, path: string, message: string): RegistryProblem => ({ code, path, message });

const isPlainObject = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const timestamp = (value: unknown): number | null =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Validate an operator/provider supplied snapshot and check its freshness at `at`.
 *
 * Never throws for bad input; it returns every problem it found so an operator can see the whole
 * list at once. `snapshot` is non-null only when `ok` is true.
 */
export function validateRegistrySnapshot(
  input: unknown,
  options: RegistryBuildOptions,
): RegistryValidationResult {
  const problems: RegistryProblem[] = [];
  const push = (code: string, path: string, message: string) => {
    problems.push(problem(code, path, message));
  };

  const atMs = timestamp((options as { at?: unknown } | null | undefined)?.at);
  if (atMs === null) push('at_required', 'options.at', 'An ISO timestamp for the lookup instant is required');
  const maxAgeMs = (options as { maxAgeMs?: unknown } | null | undefined)?.maxAgeMs;
  if (typeof maxAgeMs !== 'number' || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    push('max_age_required', 'options.maxAgeMs', 'A positive maxAgeMs must be supplied explicitly');
  }

  if (!isPlainObject(input)) {
    push('snapshot_malformed', '', 'The registry snapshot must be an object');
    return { ok: false, problems, snapshot: null };
  }
  const raw = input as Record<string, unknown>;

  const version = text(raw.version);
  if (version === null) push('version_required', 'version', 'A non-empty registry version is required');

  const generatedAt = text(raw.generatedAt);
  const generatedAtMs = timestamp(raw.generatedAt);
  if (generatedAt === null) push('generated_at_required', 'generatedAt', 'generatedAt is required');
  else if (generatedAtMs === null) push('generated_at_invalid', 'generatedAt', 'generatedAt must be an ISO timestamp');

  let platform: string | null = null;
  if (raw.platform !== undefined && raw.platform !== null) {
    platform = text(raw.platform);
    if (platform === null) push('platform_invalid', 'platform', 'platform must be a non-empty string when present');
  }

  const members: Record<string, FrozenRegistryMember> = {};
  const membersReadable = Array.isArray(raw.members);
  if (!membersReadable) {
    push('members_required', 'members', 'members must be an array');
  } else {
    raw.members.forEach((entry: unknown, index: number) => {
      const path = `members[${index}]`;
      if (!isPlainObject(entry)) {
        push('member_malformed', path, 'Each member must be an object');
        return;
      }
      const member = entry as Record<string, unknown>;
      const memberId = text(member.memberId);
      if (memberId === null) {
        push('member_id_required', `${path}.memberId`, 'memberId is required');
        return;
      }
      const status = text(member.status);
      if (status === null) push('member_status_required', `${path}.status`, 'An authoritative member status is required');
      if (Object.hasOwn(members, memberId)) {
        push('duplicate_member_id', `${path}.memberId`, `memberId ${memberId} appears more than once`);
        return;
      }

      const roles: FrozenRegistryRole[] = [];
      const seenRoles = new Set<string>();
      const rawRoles = member.roles ?? [];
      if (!Array.isArray(rawRoles)) {
        push('roles_malformed', `${path}.roles`, 'roles must be an array when present');
      } else {
        rawRoles.forEach((roleEntry: unknown, roleIndex: number) => {
          const rolePath = `${path}.roles[${roleIndex}]`;
          if (!isPlainObject(roleEntry)) {
            push('role_malformed', rolePath, 'Each role grant must be an object');
            return;
          }
          const grant = roleEntry as Record<string, unknown>;
          const roleName = text(grant.role);
          if (roleName === null) {
            push('role_name_required', `${rolePath}.role`, 'A role name is required');
            return;
          }
          const roleStatus = text(grant.status);
          if (roleStatus === null) push('role_status_required', `${rolePath}.status`, 'A role status is required');
          let expiresAt: string | null = null;
          if (grant.expiresAt !== undefined && grant.expiresAt !== null) {
            expiresAt = text(grant.expiresAt);
            if (expiresAt === null || timestamp(expiresAt) === null) {
              push('role_expires_at_invalid', `${rolePath}.expiresAt`, 'expiresAt must be an ISO timestamp when present');
            }
          }
          if (seenRoles.has(roleName)) {
            push('duplicate_role_grant', `${rolePath}.role`, `Role ${roleName} is granted more than once for ${memberId}`);
            return;
          }
          seenRoles.add(roleName);
          roles.push({ role: roleName, status: roleStatus ?? '', expiresAt });
        });
      }

      members[memberId] = { memberId, status: status ?? '', roles };
    });
  }

  const links: Record<string, FrozenRegistryLink> = {};
  if (!Array.isArray(raw.links)) {
    push('links_required', 'links', 'links must be an array');
  } else {
    raw.links.forEach((entry: unknown, index: number) => {
      const path = `links[${index}]`;
      if (!isPlainObject(entry)) {
        push('link_malformed', path, 'Each identity link must be an object');
        return;
      }
      const link = entry as Record<string, unknown>;
      const linkPlatform = text(link.platform);
      const accountId = text(link.accountId);
      const memberId = text(link.memberId);
      if (linkPlatform === null) push('link_platform_required', `${path}.platform`, 'A platform is required');
      if (accountId === null) push('link_account_required', `${path}.accountId`, 'An account id is required');
      if (memberId === null) push('link_member_required', `${path}.memberId`, 'A canonical memberId is required');

      const status = text(link.status);
      if (status === null || !LINK_STATUSES.includes(status)) {
        push('link_status_invalid', `${path}.status`, `status must be one of ${LINK_STATUSES.join(', ')}`);
      }

      let verifiedAt: string | null = null;
      if (link.verifiedAt !== undefined && link.verifiedAt !== null) {
        verifiedAt = text(link.verifiedAt);
        if (verifiedAt === null || timestamp(verifiedAt) === null) {
          push('link_verified_at_invalid', `${path}.verifiedAt`, 'verifiedAt must be an ISO timestamp when present');
        }
      }
      if (linkPlatform === null || accountId === null || memberId === null) return;

      if (platform !== null && linkPlatform !== platform) {
        push(
          'link_platform_conflict',
          `${path}.platform`,
          `Link platform ${linkPlatform} is outside the snapshot platform ${platform}`,
        );
      }
      // Skip the reference check when the member list itself was unreadable: one structural
      // failure should not cascade into one derived error per link.
      if (membersReadable && !Object.hasOwn(members, memberId)) {
        push('unknown_member_reference', `${path}.memberId`, `Link references unknown member ${memberId}`);
      }

      const key = accountKey(linkPlatform, accountId);
      const existing = links[key];
      if (existing) {
        const claim = existing.memberId === memberId ? 'the same member twice' : `member ${existing.memberId} and member ${memberId}`;
        push('duplicate_identity_link', path, `Account ${key} is claimed by ${claim}`);
        return;
      }
      links[key] = {
        platform: linkPlatform,
        accountId,
        memberId,
        status: status ?? '',
        verifiedAt,
      };
    });
  }

  if (atMs !== null && generatedAtMs !== null) {
    const ageMs = atMs - generatedAtMs;
    if (ageMs < 0) {
      push('snapshot_generated_in_future', 'generatedAt', 'generatedAt is later than the lookup instant');
    } else if (typeof maxAgeMs === 'number' && Number.isFinite(maxAgeMs) && maxAgeMs > 0 && ageMs > maxAgeMs) {
      push('snapshot_stale', 'generatedAt', `Snapshot is ${ageMs}ms old, beyond maxAgeMs ${maxAgeMs}`);
    }
  }

  if (problems.length > 0) return { ok: false, problems, snapshot: null };

  const accountKeysByMember: Record<string, string[]> = {};
  for (const memberId of Object.keys(members)) accountKeysByMember[memberId] = [];
  for (const [key, link] of Object.entries(links)) {
    if (accountKeysByMember[link.memberId]) accountKeysByMember[link.memberId].push(key);
  }

  const snapshot = deepFreeze<RegistrySnapshot>({
    version: version as string,
    generatedAt: generatedAt as string,
    generatedAtMs: generatedAtMs as number,
    platform,
    maxAgeMs: maxAgeMs as number,
    members,
    links,
    memberIds: Object.keys(members),
    accountKeysByMember,
  });
  return { ok: true, problems: [], snapshot };
}

/** Throwing wrapper for protected actions that must fail closed instead of inspecting problems. */
export function createRegistrySnapshot(input: unknown, options: RegistryBuildOptions): RegistrySnapshot {
  const result = validateRegistrySnapshot(input, options);
  if (!result.ok || !result.snapshot) {
    throw new RegistrySnapshotError(result.problems[0]?.code ?? 'snapshot_invalid', result.problems);
  }
  return result.snapshot;
}

/**
 * Freshness at one instant. Boundary is inclusive: an age exactly equal to `maxAgeMs` is accepted,
 * anything older is stale.
 */
export function checkRegistryFreshness(
  snapshot: RegistrySnapshot,
  { at }: { at: string },
): { fresh: boolean; reason: string; ageMs: number } {
  const atMs = timestamp(at);
  if (atMs === null) throw new RegistrySnapshotError('at_required', [problem('at_required', 'at', 'An ISO timestamp is required')]);
  const ageMs = atMs - snapshot.generatedAtMs;
  if (ageMs < 0) return { fresh: false, reason: 'snapshot_generated_in_future', ageMs };
  if (ageMs > snapshot.maxAgeMs) return { fresh: false, reason: 'snapshot_stale', ageMs };
  return { fresh: true, reason: 'fresh', ageMs };
}

/**
 * Resolve one platform account to its canonical member at `at`. Authorization is not decided here;
 * this is the identity lookup the proposal and voting tool bridges build on.
 */
export function resolveRegistryAccount(
  snapshot: RegistrySnapshot,
  { platform, accountId, at }: { platform: string; accountId: string; at: string },
): RegistryAccountLookup {
  if (text(platform) === null || text(accountId) === null) {
    throw new RegistrySnapshotError('account_required', [problem('account_required', 'account', 'platform and accountId are required')]);
  }
  const freshness = checkRegistryFreshness(snapshot, { at });
  if (freshness.reason === 'snapshot_generated_in_future') {
    return { status: 'snapshot_generated_in_future', reason: freshness.reason, memberId: null, member: null, link: null };
  }
  if (!freshness.fresh) {
    return { status: 'snapshot_stale', reason: freshness.reason, memberId: null, member: null, link: null };
  }
  if (snapshot.platform !== null && platform !== snapshot.platform) {
    return { status: 'platform_mismatch', reason: 'platform_mismatch', memberId: null, member: null, link: null };
  }
  const link = snapshot.links[accountKey(platform, accountId)];
  if (!link) {
    const elsewhere = Object.values(snapshot.links).some(candidate => candidate.accountId === accountId);
    if (elsewhere) {
      return { status: 'platform_mismatch', reason: 'platform_mismatch', memberId: null, member: null, link: null };
    }
    return { status: 'identity_not_linked', reason: 'identity_not_linked', memberId: null, member: null, link: null };
  }
  if (link.status !== 'verified') {
    return { status: 'identity_link_revoked', reason: 'identity_link_revoked', memberId: link.memberId, member: null, link };
  }
  const member = snapshot.members[link.memberId] ?? null;
  if (!member) {
    return {
      status: 'authoritative_member_missing',
      reason: 'authoritative_member_missing',
      memberId: link.memberId,
      member: null,
      link,
    };
  }
  return { status: 'resolved', reason: 'resolved', memberId: member.memberId, member, link };
}

/**
 * Current role eligibility for one platform account. An active grant of the named role on an active
 * member behind a verified link is the only source of `eligible: true` (R02, AC01, AC06).
 */
export function checkRegistryRoleEligibility(
  snapshot: RegistrySnapshot,
  { platform, accountId, at, role }: { platform: string; accountId: string; at: string; role: string },
): RegistryEligibility {
  const roleName = text(role);
  if (roleName === null) {
    throw new RegistrySnapshotError('role_required', [problem('role_required', 'role', 'A role name is required')]);
  }
  const lookup = resolveRegistryAccount(snapshot, { platform, accountId, at });
  if (lookup.status !== 'resolved' || !lookup.member) {
    return { eligible: false, reason: lookup.reason, memberId: lookup.memberId };
  }
  const member = lookup.member;
  if (member.status !== 'active') {
    return { eligible: false, reason: `member_status_${member.status}`, memberId: member.memberId };
  }
  const grant = member.roles.find(entry => entry.role === roleName && entry.status === 'active');
  if (!grant) return { eligible: false, reason: `no_active_${roleName}_role`, memberId: member.memberId };
  const atMs = timestamp(at) as number;
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= atMs) {
    return { eligible: false, reason: `${roleName}_role_expired`, memberId: member.memberId };
  }
  return { eligible: true, reason: `eligible_${roleName}`, memberId: member.memberId };
}

export const checkContributorEligibility = (
  snapshot: RegistrySnapshot,
  args: { platform: string; accountId: string; at: string },
): RegistryEligibility => checkRegistryRoleEligibility(snapshot, { ...args, role: 'contributor' });

export const checkBoardEligibility = (
  snapshot: RegistrySnapshot,
  args: { platform: string; accountId: string; at: string },
): RegistryEligibility => checkRegistryRoleEligibility(snapshot, { ...args, role: 'board' });

/** Every account currently linked to one canonical member, so the bridge can show all of them. */
export function registryAccountsForMember(snapshot: RegistrySnapshot, memberId: string): readonly FrozenRegistryLink[] {
  return Object.freeze(
    (snapshot.accountKeysByMember[memberId] ?? []).map(key => snapshot.links[key]).filter(Boolean),
  );
}

/**
 * Distinct canonical members currently holding a role, so a member with several accounts is
 * counted once (R02). Sorted for a deterministic frozen roster.
 */
export function listEligibleMembers(snapshot: RegistrySnapshot, { role, at }: { role: string; at: string }): readonly string[] {
  const roleName = text(role);
  if (roleName === null) {
    throw new RegistrySnapshotError('role_required', [problem('role_required', 'role', 'A role name is required')]);
  }
  const freshness = checkRegistryFreshness(snapshot, { at });
  if (!freshness.fresh) return Object.freeze([]);
  const atMs = timestamp(at) as number;
  const eligible: string[] = [];
  for (const member of Object.values(snapshot.members)) {
    if (member.status !== 'active') continue;
    const grant = member.roles.find(entry => entry.role === roleName && entry.status === 'active');
    if (!grant) continue;
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= atMs) continue;
    const hasVerifiedLink = (snapshot.accountKeysByMember[member.memberId] ?? []).some(
      key => snapshot.links[key]?.status === 'verified',
    );
    if (hasVerifiedLink) eligible.push(member.memberId);
  }
  return Object.freeze(eligible.sort());
}

/**
 * Adapt the frozen snapshot to the proposals-core identity state shape so the existing
 * `resolveTrustedRequester` / `checkContributorEligibility` bridge can consume it. The adapter
 * grants nothing: authorization still happens in the deterministic services at the action boundary.
 */
export function toProposalRegistryState(snapshot: RegistrySnapshot): {
  members: Record<string, FrozenRegistryMember>;
  identities: Record<string, FrozenRegistryLink>;
} {
  return {
    members: structuredClone(snapshot.members),
    identities: structuredClone(snapshot.links),
  };
}
