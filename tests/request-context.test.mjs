import test from 'node:test';
import assert from 'node:assert/strict';
import { createProposalCore } from '../plugins/rein-operations/proposals.ts';
import { resolveTrustedRequester, assertCurrentInvocation, createContributorVerifier } from '../plugins/rein-operations/request-context.ts';

const at = '2026-09-24T00:00:00Z';
const scope = state => ({ platform: 'discord', allowedNativeChannelIds: ['proposal-room'], proposalState: state, at });
const context = { messageChannel: 'discord', nativeChannelId: 'proposal-room', requesterSenderId: 'user-123' };

test('trusted requester derives identity from the runtime sender, never a claimed tool actor', () => {
  const core = createProposalCore();
  core.recordMember({ memberId: 'member-1', roles: [{ role: 'contributor' }], recordedBy: 'registry', at });
  core.linkIdentity({ platform: 'discord', accountId: 'user-123', memberId: 'member-1', verifiedBy: 'registry', verifiedAt: at });
  const requester = resolveTrustedRequester({ ...context, claimedActor: 'board-chair' }, scope(core.snapshot()));
  assert.equal(requester.memberId, 'member-1');
  assert.equal(requester.contributorEligible, true);
  assert.equal(requester.accountId, 'user-123');
});

test('unconfigured or missing host context and unapproved channels fail closed', () => {
  const state = createProposalCore().snapshot();
  const unlinked = resolveTrustedRequester(context, scope(state));
  assert.equal(unlinked.memberId, null);
  assert.equal(unlinked.contributorEligible, false);
  assert.throws(() => resolveTrustedRequester(context, { ...scope(state), platform: null }), { code: 'platform_scope_not_configured' });
  assert.throws(() => resolveTrustedRequester(context, { ...scope(state), allowedNativeChannelIds: [] }), { code: 'platform_scope_not_configured' });
  assert.throws(() => resolveTrustedRequester(context, { ...scope(state), proposalState: null }), { code: 'identity_registry_unavailable' });
  assert.throws(() => resolveTrustedRequester({ ...context, requesterSenderId: ' ' }, scope(state)), { code: 'trusted_requester_unavailable' });
  assert.throws(() => resolveTrustedRequester({ ...context, requesterSenderId: undefined }, scope(state)), { code: 'trusted_requester_unavailable' });
  assert.throws(() => resolveTrustedRequester({ ...context, messageChannel: 'slack' }, scope(state)), { code: 'trusted_requester_unavailable' });
  assert.throws(() => resolveTrustedRequester({ ...context, nativeChannelId: 'public-chat' }, scope(state)), { code: 'channel_out_of_scope' });
});

test('current-invocation guard must be host provided and is called at the write boundary', () => {
  let calls = 0;
  assert.throws(() => assertCurrentInvocation({}), { code: 'current_invocation_guard_unavailable' });
  assertCurrentInvocation({ assertInvocationCurrent() { calls += 1; } });
  assert.equal(calls, 1);
});

test('publication eligibility reads the current registry and follows role revocation', () => {
  const core = createProposalCore();
  core.recordMember({ memberId: 'member-1', roles: [{ role: 'contributor' }], recordedBy: 'registry', at });
  core.linkIdentity({ platform: 'discord', accountId: 'user-123', memberId: 'member-1', verifiedBy: 'registry', verifiedAt: at });
  const verify = createContributorVerifier(() => core.snapshot());
  assert.equal(verify('member-1', at), true);
  assert.equal(verify('member-2', at), false);
  core.revokeMemberRole({ memberId: 'member-1', role: 'contributor', revokedBy: 'registry', at: '2026-09-25T00:00:00Z' });
  assert.equal(verify('member-1', '2026-09-25T00:00:01Z'), false);
});
