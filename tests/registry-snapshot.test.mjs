import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRegistrySnapshot,
  validateRegistrySnapshot,
  checkRegistryFreshness,
  resolveRegistryAccount,
  checkRegistryRoleEligibility,
  checkContributorEligibility,
  checkBoardEligibility,
  registryAccountsForMember,
  listEligibleMembers,
  toProposalRegistryState,
} from '../plugins/rein-operations/registry-snapshot.ts';
import { checkContributorEligibility as proposalContributorEligibility } from '../plugins/rein-operations/proposals.ts';

const at = '2026-09-24T00:00:00Z';
const generatedAt = '2026-09-24T00:00:00Z';
const maxAgeMs = 60 * 60 * 1000;
const options = { at, maxAgeMs };

const baseSnapshot = () => ({
  version: 'registry-2026-09-24.1',
  generatedAt,
  platform: 'discord',
  members: [
    { memberId: 'member-1', status: 'active', roles: [{ role: 'contributor', status: 'active' }] },
    { memberId: 'member-2', status: 'active', roles: [{ role: 'board', status: 'active' }] },
  ],
  links: [
    { platform: 'discord', accountId: 'user-1', memberId: 'member-1', status: 'verified', verifiedAt: '2026-09-01T00:00:00Z' },
    { platform: 'discord', accountId: 'user-2', memberId: 'member-2', status: 'verified', verifiedAt: '2026-09-01T00:00:00Z' },
  ],
});

const codes = result => result.problems.map(item => item.code);

test('a valid snapshot resolves current Contributor and Board eligibility by platform account', () => {
  const snapshot = createRegistrySnapshot(baseSnapshot(), options);

  const contributor = checkContributorEligibility(snapshot, { platform: 'discord', accountId: 'user-1', at });
  assert.equal(contributor.eligible, true);
  assert.equal(contributor.reason, 'eligible_contributor');
  assert.equal(contributor.memberId, 'member-1');

  assert.equal(checkBoardEligibility(snapshot, { platform: 'discord', accountId: 'user-2', at }).eligible, true);
  assert.deepEqual(checkContributorEligibility(snapshot, { platform: 'discord', accountId: 'user-2', at }), {
    eligible: false,
    reason: 'no_active_contributor_role',
    memberId: 'member-2',
  });
  assert.deepEqual(checkBoardEligibility(snapshot, { platform: 'discord', accountId: 'user-1', at }), {
    eligible: false,
    reason: 'no_active_board_role',
    memberId: 'member-1',
  });
  assert.deepEqual(checkContributorEligibility(snapshot, { platform: 'discord', accountId: 'user-9', at }), {
    eligible: false,
    reason: 'identity_not_linked',
    memberId: null,
  });
});

test('the frozen snapshot is detached from the caller and cannot be mutated', () => {
  const input = baseSnapshot();
  const snapshot = createRegistrySnapshot(input, options);

  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.members), true);
  assert.equal(Object.isFrozen(snapshot.links), true);
  assert.equal(Object.isFrozen(snapshot.members['member-1'].roles), true);

  input.members[0].status = 'revoked';
  input.links[0].memberId = 'member-2';
  assert.equal(snapshot.members['member-1'].status, 'active');
  assert.equal(snapshot.links['discord:user-1'].memberId, 'member-1');
  assert.equal(checkContributorEligibility(snapshot, { platform: 'discord', accountId: 'user-1', at }).eligible, true);
});

test('expired roles and revoked members or links fail closed', () => {
  const input = baseSnapshot();
  input.members[0].roles = [
    { role: 'contributor', status: 'active', expiresAt: '2026-09-23T23:59:59Z' },
  ];
  const expired = createRegistrySnapshot(input, options);
  assert.deepEqual(checkContributorEligibility(expired, { platform: 'discord', accountId: 'user-1', at }), {
    eligible: false,
    reason: 'contributor_role_expired',
    memberId: 'member-1',
  });

  const stillValid = baseSnapshot();
  stillValid.members[0].roles = [{ role: 'contributor', status: 'active', expiresAt: '2026-09-24T00:00:01Z' }];
  const valid = createRegistrySnapshot(stillValid, options);
  assert.equal(checkContributorEligibility(valid, { platform: 'discord', accountId: 'user-1', at }).eligible, true);

  const revokedLink = baseSnapshot();
  revokedLink.links[0].status = 'revoked';
  const link = createRegistrySnapshot(revokedLink, options);
  assert.deepEqual(checkContributorEligibility(link, { platform: 'discord', accountId: 'user-1', at }), {
    eligible: false,
    reason: 'identity_link_revoked',
    memberId: 'member-1',
  });
  assert.equal(listEligibleMembers(link, { role: 'contributor', at }).includes('member-1'), false);

  const suspended = baseSnapshot();
  suspended.members[0].status = 'suspended';
  const suspendedSnapshot = createRegistrySnapshot(suspended, options);
  assert.deepEqual(checkContributorEligibility(suspendedSnapshot, { platform: 'discord', accountId: 'user-1', at }), {
    eligible: false,
    reason: 'member_status_suspended',
    memberId: 'member-1',
  });

  const revokedRole = baseSnapshot();
  revokedRole.members[0].roles = [{ role: 'contributor', status: 'revoked' }];
  const roleSnapshot = createRegistrySnapshot(revokedRole, options);
  assert.equal(
    checkContributorEligibility(roleSnapshot, { platform: 'discord', accountId: 'user-1', at }).reason,
    'no_active_contributor_role',
  );
});

test('a stale snapshot is rejected and freshness is rechecked on every lookup', () => {
  const staleAt = '2026-09-24T01:00:00.001Z';
  const stale = validateRegistrySnapshot(baseSnapshot(), { at: staleAt, maxAgeMs });
  assert.equal(stale.ok, false);
  assert.equal(stale.snapshot, null);
  assert.deepEqual(codes(stale), ['snapshot_stale']);
  assert.throws(() => createRegistrySnapshot(baseSnapshot(), { at: staleAt, maxAgeMs }), { code: 'snapshot_stale' });

  // Boundary is inclusive: exactly maxAgeMs old is still usable.
  const boundary = createRegistrySnapshot(baseSnapshot(), { at: '2026-09-24T01:00:00Z', maxAgeMs });
  assert.equal(checkRegistryFreshness(boundary, { at: '2026-09-24T01:00:00Z' }).fresh, true);

  const snapshot = createRegistrySnapshot(baseSnapshot(), options);
  assert.equal(checkContributorEligibility(snapshot, { platform: 'discord', accountId: 'user-1', at }).eligible, true);
  assert.deepEqual(checkContributorEligibility(snapshot, { platform: 'discord', accountId: 'user-1', at: '2026-09-24T03:00:00Z' }), {
    eligible: false,
    reason: 'snapshot_stale',
    memberId: null,
  });
  assert.deepEqual(listEligibleMembers(snapshot, { role: 'contributor', at: '2026-09-24T03:00:00Z' }), []);

  // A snapshot generated after the lookup instant is not usable for that instant either.
  const future = validateRegistrySnapshot(baseSnapshot(), { at: '2026-09-23T23:00:00Z', maxAgeMs });
  assert.equal(future.ok, false);
  assert.deepEqual(codes(future), ['snapshot_generated_in_future']);
});

test('maxAgeMs is mandatory and has no implicit default', () => {
  for (const bad of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '3600000']) {
    const result = validateRegistrySnapshot(baseSnapshot(), { at, maxAgeMs: bad });
    assert.equal(result.ok, false, `maxAgeMs ${String(bad)} must be rejected`);
    assert.equal(codes(result).includes('max_age_required'), true);
    assert.throws(() => createRegistrySnapshot(baseSnapshot(), { at, maxAgeMs: bad }), { code: 'max_age_required' });
  }
  const missingAt = validateRegistrySnapshot(baseSnapshot(), { maxAgeMs });
  assert.equal(missingAt.ok, false);
  assert.deepEqual(codes(missingAt), ['at_required']);
});

test('duplicate and conflicted identities are rejected instead of resolved', () => {
  const duplicateMember = baseSnapshot();
  duplicateMember.members.push({ memberId: 'member-1', status: 'active', roles: [] });
  assert.deepEqual(codes(validateRegistrySnapshot(duplicateMember, options)), ['duplicate_member_id']);

  const duplicateAccount = baseSnapshot();
  duplicateAccount.links.push({
    platform: 'discord',
    accountId: 'user-1',
    memberId: 'member-2',
    status: 'verified',
  });
  const conflicted = validateRegistrySnapshot(duplicateAccount, options);
  assert.equal(conflicted.ok, false);
  assert.deepEqual(codes(conflicted), ['duplicate_identity_link']);

  const sameAccountTwice = baseSnapshot();
  sameAccountTwice.links.push({
    platform: 'discord',
    accountId: 'user-1',
    memberId: 'member-1',
    status: 'verified',
  });
  assert.deepEqual(codes(validateRegistrySnapshot(sameAccountTwice, options)), ['duplicate_identity_link']);

  const unknownMember = baseSnapshot();
  unknownMember.links[1].memberId = 'member-404';
  assert.deepEqual(codes(validateRegistrySnapshot(unknownMember, options)), ['unknown_member_reference']);

  const duplicateRole = baseSnapshot();
  duplicateRole.members[0].roles = [
    { role: 'contributor', status: 'active' },
    { role: 'contributor', status: 'revoked' },
  ];
  assert.deepEqual(codes(validateRegistrySnapshot(duplicateRole, options)), ['duplicate_role_grant']);
});

test('malformed input is reported without producing a partial snapshot', () => {
  assert.deepEqual(codes(validateRegistrySnapshot(null, options)), ['snapshot_malformed']);

  const noVersion = baseSnapshot();
  delete noVersion.version;
  const noVersionResult = validateRegistrySnapshot(noVersion, options);
  assert.equal(noVersionResult.ok, false);
  assert.equal(noVersionResult.snapshot, null);
  assert.deepEqual(codes(noVersionResult), ['version_required']);

  const badMembers = baseSnapshot();
  badMembers.members = 'not-an-array';
  assert.deepEqual(codes(validateRegistrySnapshot(badMembers, options)), ['members_required']);

  const badLinks = baseSnapshot();
  delete badLinks.links;
  assert.deepEqual(codes(validateRegistrySnapshot(badLinks, options)), ['links_required']);

  const badStatus = baseSnapshot();
  badStatus.links[0].status = 'probably';
  assert.deepEqual(codes(validateRegistrySnapshot(badStatus, options)), ['link_status_invalid']);

  const badTimestamp = baseSnapshot();
  badTimestamp.generatedAt = 'yesterday';
  assert.deepEqual(codes(validateRegistrySnapshot(badTimestamp, options)), ['generated_at_invalid']);

  const multipleProblems = baseSnapshot();
  multipleProblems.members[0].roles = [{ status: 'active' }];
  multipleProblems.links[1].accountId = '';
  const reported = validateRegistrySnapshot(multipleProblems, options);
  assert.equal(reported.ok, false);
  assert.deepEqual(codes(reported).sort(), ['link_account_required', 'role_name_required']);
});

test('one canonical member with several accounts keeps a single governance identity', () => {
  const input = baseSnapshot();
  input.links.push({
    platform: 'discord',
    accountId: 'user-1-work',
    memberId: 'member-1',
    status: 'verified',
    verifiedAt: '2026-09-10T00:00:00Z',
  });
  const snapshot = createRegistrySnapshot(input, options);

  const primary = checkContributorEligibility(snapshot, { platform: 'discord', accountId: 'user-1', at });
  const secondary = checkContributorEligibility(snapshot, { platform: 'discord', accountId: 'user-1-work', at });
  assert.equal(primary.memberId, 'member-1');
  assert.equal(secondary.memberId, 'member-1');
  assert.equal(primary.eligible && secondary.eligible, true);

  assert.deepEqual(listEligibleMembers(snapshot, { role: 'contributor', at }), ['member-1']);
  assert.equal(registryAccountsForMember(snapshot, 'member-1').length, 2);
  assert.equal(registryAccountsForMember(snapshot, 'member-2').length, 1);
  assert.deepEqual(registryAccountsForMember(snapshot, 'member-404'), []);
});

test('platform mismatch fails closed', () => {
  const scoped = createRegistrySnapshot(baseSnapshot(), options);
  assert.deepEqual(resolveRegistryAccount(scoped, { platform: 'slack', accountId: 'user-1', at }), {
    status: 'platform_mismatch',
    reason: 'platform_mismatch',
    memberId: null,
    member: null,
    link: null,
  });
  assert.deepEqual(checkContributorEligibility(scoped, { platform: 'slack', accountId: 'user-1', at }), {
    eligible: false,
    reason: 'platform_mismatch',
    memberId: null,
  });

  const unscoped = baseSnapshot();
  delete unscoped.platform;
  const anyPlatform = createRegistrySnapshot(unscoped, options);
  assert.equal(checkContributorEligibility(anyPlatform, { platform: 'discord', accountId: 'user-1', at }).eligible, true);
  assert.equal(
    checkContributorEligibility(anyPlatform, { platform: 'slack', accountId: 'user-1', at }).reason,
    'platform_mismatch',
  );
  assert.equal(
    checkContributorEligibility(anyPlatform, { platform: 'slack', accountId: 'user-404', at }).reason,
    'identity_not_linked',
  );

  const crossPlatform = baseSnapshot();
  crossPlatform.links.push({ platform: 'slack', accountId: 'user-3', memberId: 'member-1', status: 'verified' });
  const conflict = validateRegistrySnapshot(crossPlatform, options);
  assert.equal(conflict.ok, false);
  assert.deepEqual(codes(conflict), ['link_platform_conflict']);
});

test('the adapted state is consumable by the existing proposals-core eligibility bridge', () => {
  const snapshot = createRegistrySnapshot(baseSnapshot(), options);
  const state = toProposalRegistryState(snapshot);

  assert.deepEqual(Object.keys(state.identities).sort(), ['discord:user-1', 'discord:user-2']);
  assert.equal(state.identities['discord:user-1'].status, 'verified');
  assert.equal(proposalContributorEligibility(state, { platform: 'discord', accountId: 'user-1', at }).eligible, true);
  assert.deepEqual(
    proposalContributorEligibility(state, { platform: 'discord', accountId: 'user-2', at }),
    { eligible: false, reason: 'no_active_contributor_role', memberId: 'member-2' },
  );

  // The adapter copies, so a consumer cannot mutate the frozen snapshot through it.
  state.members['member-1'].status = 'revoked';
  assert.equal(snapshot.members['member-1'].status, 'active');
  assert.equal(checkContributorEligibility(snapshot, { platform: 'discord', accountId: 'user-1', at }).eligible, true);
});

test('unknown roles are never granted implicitly', () => {
  const snapshot = createRegistrySnapshot(baseSnapshot(), options);
  assert.deepEqual(checkRegistryRoleEligibility(snapshot, { platform: 'discord', accountId: 'user-1', at, role: 'admin' }), {
    eligible: false,
    reason: 'no_active_admin_role',
    memberId: 'member-1',
  });
  assert.deepEqual(listEligibleMembers(snapshot, { role: 'board', at }), ['member-2']);
  assert.throws(() => listEligibleMembers(snapshot, { role: '  ', at }), { code: 'role_required' });
});
