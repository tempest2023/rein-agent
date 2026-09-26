import { checkContributorEligibility, resolveMemberForAccount } from './proposals.ts';

export class RequestContextError extends Error {
  constructor(code) { super(code); this.name = 'RequestContextError'; this.code = code; }
}

/**
 * Bind an OpenClaw tool invocation to the host-supplied sender and channel. No model/tool
 * argument is accepted as an actor. The caller must supply an organization-approved platform
 * and a non-empty channel scope; without them all invocations fail closed.
 */
export function resolveTrustedRequester(context, { platform, allowedNativeChannelIds, proposalState, at }) {
  if (!platform || !Array.isArray(allowedNativeChannelIds) || allowedNativeChannelIds.length === 0) {
    throw new RequestContextError('platform_scope_not_configured');
  }
  if (!proposalState?.identities || !proposalState?.members) {
    throw new RequestContextError('identity_registry_unavailable');
  }
  if (!context || context.messageChannel !== platform ||
      typeof context.requesterSenderId !== 'string' || !context.requesterSenderId.trim() ||
      typeof context.nativeChannelId !== 'string' || !context.nativeChannelId.trim()) {
    throw new RequestContextError('trusted_requester_unavailable');
  }
  if (!allowedNativeChannelIds.includes(context.nativeChannelId)) {
    throw new RequestContextError('channel_out_of_scope');
  }
  const account = { platform, accountId: context.requesterSenderId };
  const memberId = resolveMemberForAccount(proposalState, account)?.member?.memberId ?? null;
  const contributor = checkContributorEligibility(proposalState, { ...account, at });
  return Object.freeze({
    platform,
    accountId: context.requesterSenderId,
    nativeChannelId: context.nativeChannelId,
    memberId,
    contributorEligible: contributor.eligible,
    contributorReason: contributor.reason,
  });
}

/** Call in the final synchronous write/effect guard for a contextVersion:2 tool. */
export function assertCurrentInvocation(context) {
  if (typeof context?.assertInvocationCurrent !== 'function') {
    throw new RequestContextError('current_invocation_guard_unavailable');
  }
  context.assertInvocationCurrent();
}

/** Supply activities.confirmFacts with a current registry-backed Contributor check. */
export function createContributorVerifier(getProposalState) {
  if (typeof getProposalState !== 'function') throw new RequestContextError('identity_registry_unavailable');
  return (memberId, at) => {
    const state = getProposalState();
    if (!state?.identities || !state?.members || typeof memberId !== 'string' || !memberId.trim()) return false;
    for (const identity of Object.values(state.identities)) {
      if (identity?.memberId !== memberId || identity.status !== 'verified') continue;
      const check = checkContributorEligibility(state, { platform: identity.platform, accountId: identity.accountId, at });
      if (check.eligible && check.memberId === memberId) return true;
    }
    return false;
  };
}
