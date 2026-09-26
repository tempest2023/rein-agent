// Deterministic identity and proposal core for P0 (PRD R01-R09).
//
// Pure functions over one explicit state object: no I/O, no timers, no network, and no policy
// that switches itself on. The PRD's recommendations stay unapproved until an authorized
// operator records them, because a prompt or a manifest declaration is not an authorization
// check. Identity and eligibility are derived from authoritative member records, never from
// display names or platform role labels.

export const PROPOSAL_STATES = Object.freeze([
  'draft',
  'needs_reconfirmation',
  'confirmed',
  'needs_information',
  'needs_exception',
  'awaiting_governance',
  'approved',
  'on_hold',
  'duplicate',
  'withdrawn',
]);

// Amounts, dates, scale and commitments. Changing one of these after a lead confirmed a version
// invalidates that confirmation instead of silently editing a confirmed record (R05).
export const MATERIAL_FIELD_PATHS = Object.freeze([
  'format',
  'schedule.startAt',
  'schedule.timeZone',
  'schedule.durationMinutes',
  'location.venue',
  'capacity.expectedAttendance',
  'capacity.registration',
  'fees.charged',
  'fees.amountMinor',
  'budget.requestedAmountMinor',
  'budget.currency',
  'budget.reimbursementExpected',
  'budget.contractualCommitments',
  'budget.hiddenCostsConfirmed',
  'deliverables.photoRestrictions',
]);

// R04 information table reduced to the fields that gate formal assessment.
export const REQUIRED_FIELD_PATHS = Object.freeze([
  'title',
  'eventType',
  'purpose',
  'audience',
  'format',
  'schedule.startAt',
  'schedule.timeZone',
  'schedule.durationMinutes',
  'capacity.expectedAttendance',
  'program.agenda',
  'risks.notes',
  'budget.requestedAmountMinor',
]);

const clone = value => (value === undefined ? undefined : structuredClone(value));

const getPath = (object, path) =>
  path
    .split('.')
    .reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), object);

const isBlank = value =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

const requireText = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
};

const requireTimestamp = (value, name) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
  return value;
};

const requireAccount = account => {
  if (!account || typeof account !== 'object') throw new Error('account is required');
  requireText(account.platform, 'account.platform');
  requireText(account.accountId, 'account.accountId');
  return account;
};

const isTimeZone = value => {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const deepMerge = (base, patch) => {
  if (patch === undefined) return clone(base);
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return clone(patch);
  const target = base && typeof base === 'object' && !Array.isArray(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    target[key] =
      value && typeof value === 'object' && !Array.isArray(value) ? deepMerge(target[key], value) : clone(value);
  }
  return target;
};

export const accountKey = (platform, accountId) => `${platform}:${accountId}`;

// Titles are compared on letters and digits only so punctuation and spacing cannot hide a
// duplicate submission (R05).
export const normalizeTitle = value =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim();

export function createState() {
  return {
    members: {},
    identities: {},
    proposals: {},
    counters: { proposal: 0 },
    receipts: {},
    audit: [],
    zeroBudgetPolicy: null,
  };
}

export const snapshot = state => structuredClone(state);

export function resolveMemberForAccount(state, account) {
  requireAccount(account);
  const identity = state.identities[accountKey(account.platform, account.accountId)];
  if (!identity) return null;
  return {
    identity: clone(identity),
    member: state.members[identity.memberId] ? clone(state.members[identity.memberId]) : null,
  };
}

export function memberAccounts(state, memberId) {
  return Object.values(state.identities)
    .filter(identity => identity.memberId === memberId)
    .map(identity => ({ platform: identity.platform, accountId: identity.accountId, status: identity.status }));
}

// R02: an active Contributor role on the authoritative record is the only source of proposal
// eligibility. An identity link, a display name, or a platform role label alone is not enough.
export function checkContributorEligibility(state, { platform, accountId, at }) {
  requireText(platform, 'platform');
  requireText(accountId, 'accountId');
  requireTimestamp(at, 'at');
  const identity = state.identities[accountKey(platform, accountId)];
  if (!identity) return { eligible: false, reason: 'identity_not_linked', memberId: null };
  if (identity.status !== 'verified') {
    return { eligible: false, reason: 'identity_link_revoked', memberId: identity.memberId };
  }
  const member = state.members[identity.memberId];
  if (!member) return { eligible: false, reason: 'authoritative_member_missing', memberId: identity.memberId };
  if (member.status !== 'active') {
    return { eligible: false, reason: `member_status_${member.status}`, memberId: identity.memberId };
  }
  const grant = (member.roles ?? []).find(role => role.role === 'contributor' && role.status === 'active');
  if (!grant) return { eligible: false, reason: 'no_active_contributor_role', memberId: identity.memberId };
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.parse(at)) {
    return { eligible: false, reason: 'contributor_role_expired', memberId: identity.memberId };
  }
  return { eligible: true, reason: 'eligible_contributor', memberId: identity.memberId };
}

export function validateSchedule(fields, { now }) {
  requireTimestamp(now, 'now');
  const problems = [];
  const startAt = getPath(fields, 'schedule.startAt');
  const timeZone = getPath(fields, 'schedule.timeZone');
  const duration = getPath(fields, 'schedule.durationMinutes');
  if (!isTimeZone(timeZone)) {
    problems.push({
      code: isBlank(timeZone) ? 'missing_timezone' : 'invalid_timezone',
      path: 'schedule.timeZone',
      message: 'An IANA time zone is required so the date is unambiguous',
    });
  }
  if (!Number.isFinite(Date.parse(startAt))) {
    problems.push({ code: 'invalid_start', path: 'schedule.startAt', message: 'A parseable start time is required' });
  } else if (Date.parse(startAt) <= Date.parse(now)) {
    problems.push({
      code: 'event_date_passed',
      path: 'schedule.startAt',
      message: 'A proposal whose event date has passed cannot enter the active queue',
    });
  }
  if (!Number.isInteger(duration) || duration <= 0) {
    problems.push({
      code: 'invalid_duration',
      path: 'schedule.durationMinutes',
      message: 'Duration must be positive whole minutes',
    });
  }
  return { valid: problems.length === 0, problems };
}

// R04: required information plus the explicit zero-budget confirmations. Missing items are
// reported one by one so the lead is told exactly what to fix.
export function checkCompleteness(fields) {
  const problems = [];
  const missing = path => problems.push({ code: 'missing_field', path, message: `${path} is required` });
  for (const path of REQUIRED_FIELD_PATHS) if (isBlank(getPath(fields, path))) missing(path);

  const format = getPath(fields, 'format');
  if ((format === 'in_person' || format === 'hybrid') && isBlank(getPath(fields, 'location.venue'))) {
    missing('location.venue');
  }
  if (typeof getPath(fields, 'fees.charged') !== 'boolean') missing('fees.charged');
  else if (getPath(fields, 'fees.charged') === true && isBlank(getPath(fields, 'fees.amountMinor'))) {
    missing('fees.amountMinor');
  }

  const amount = getPath(fields, 'budget.requestedAmountMinor');
  if (!isBlank(amount)) {
    if (!Number.isInteger(amount) || amount < 0) {
      problems.push({
        code: 'invalid_requested_amount',
        path: 'budget.requestedAmountMinor',
        message: 'Requested funding uses integer minor units and cannot be negative',
      });
    } else if (amount > 0) {
      if (isBlank(getPath(fields, 'budget.currency'))) missing('budget.currency');
      if (isBlank(getPath(fields, 'budget.items'))) missing('budget.items');
      if (isBlank(getPath(fields, 'budget.assumptions'))) missing('budget.assumptions');
    } else if (getPath(fields, 'budget.reimbursementExpected') === true || getPath(fields, 'budget.contractualCommitments') === true) {
      // An expected reimbursement or contract is a funding request with an unknown amount. It is
      // incomplete rather than zero-budget, so it can neither be fast-tracked nor take a voting
      // slot until the lead states the amount (R08).
      problems.push({
        code: 'funding_request_requires_amount',
        path: 'budget.requestedAmountMinor',
        message: 'A proposal expecting reimbursement or contractual commitments must state the requested amount',
      });
    } else {
      if (getPath(fields, 'budget.reimbursementExpected') !== false) {
        problems.push({
          code: 'zero_budget_reimbursement_unconfirmed',
          path: 'budget.reimbursementExpected',
          message: 'A zero-budget proposal must state that no later reimbursement is expected',
        });
      }
      if (getPath(fields, 'budget.hiddenCostsConfirmed') !== true) {
        problems.push({
          code: 'zero_budget_hidden_costs_unconfirmed',
          path: 'budget.hiddenCostsConfirmed',
          message: 'A zero-budget proposal must confirm there are no hidden organizational costs',
        });
      }
      if (getPath(fields, 'budget.contractualCommitments') !== false) {
        problems.push({
          code: 'zero_budget_commitments_unconfirmed',
          path: 'budget.contractualCommitments',
          message: 'A zero-budget proposal must confirm there are no contractual commitments',
        });
      }
    }
  }
  return { complete: problems.length === 0, problems };
}

export function detectMaterialChanges(previousFields, patch) {
  const changed = [];
  for (const path of MATERIAL_FIELD_PATHS) {
    const nextValue = getPath(patch, path);
    if (nextValue === undefined) continue;
    const previousValue = getPath(previousFields, path);
    if (JSON.stringify(previousValue ?? null) !== JSON.stringify(nextValue ?? null)) changed.push(path);
  }
  return changed;
}

// R07/R08 routing. A funding request always goes to Board selection in phase one; a zero-budget
// proposal is only fast-tracked when an authorized policy says so and every listed condition
// holds. Without that policy the answer is "needs a designated handler", never "approved".
export function routeProcessingPath({ fields, completeness, schedule, policy = null }) {
  if (!completeness.complete) {
    return { path: 'needs_information', reason: 'essential_information_incomplete', blockers: completeness.problems };
  }
  if (!schedule.valid) {
    return { path: 'needs_information', reason: 'schedule_not_valid', blockers: schedule.problems };
  }

  const amount = getPath(fields, 'budget.requestedAmountMinor');
  const fundingRequested =
    amount > 0 ||
    getPath(fields, 'budget.reimbursementExpected') === true ||
    getPath(fields, 'budget.contractualCommitments') === true;
  if (fundingRequested) {
    return {
      path: 'governance',
      reason: 'funding_request_requires_board_selection',
      basis: {
        requestedAmountMinor: amount,
        currency: getPath(fields, 'budget.currency') ?? null,
        reimbursementExpected: getPath(fields, 'budget.reimbursementExpected') === true,
        contractualCommitments: getPath(fields, 'budget.contractualCommitments') === true,
      },
    };
  }

  if (!policy || policy.active !== true) {
    return {
      path: 'needs_exception',
      reason: 'zero_budget_policy_not_authorized',
      blockers: [
        {
          code: 'zero_budget_policy_not_authorized',
          message: 'No authorized zero-budget policy is recorded, so automatic approval is unavailable',
        },
      ],
    };
  }
  if (!Array.isArray(policy.allowedEventTypes) || !policy.allowedEventTypes.includes(fields.eventType)) {
    return {
      path: 'needs_exception',
      reason: 'event_type_outside_authorized_scope',
      blockers: [
        {
          code: 'event_type_outside_authorized_scope',
          message: `${fields.eventType} is not an authorized routine event type`,
        },
      ],
    };
  }
  if (
    policy.requireVenueConfirmed !== false &&
    fields.format !== 'online' &&
    getPath(fields, 'location.venueConfirmed') !== true
  ) {
    return {
      path: 'needs_exception',
      reason: 'venue_not_confirmed',
      blockers: [
        {
          code: 'venue_not_confirmed',
          path: 'location.venueConfirmed',
          message: 'An in-person venue must be confirmed before automatic approval',
        },
      ],
    };
  }
  if (
    Number.isFinite(policy.maxExpectedAttendance) &&
    getPath(fields, 'capacity.expectedAttendance') > policy.maxExpectedAttendance
  ) {
    return {
      path: 'needs_exception',
      reason: 'scale_exceeds_authorized_limit',
      blockers: [
        {
          code: 'scale_exceeds_authorized_limit',
          message: `Expected attendance exceeds the authorized limit of ${policy.maxExpectedAttendance}`,
        },
      ],
    };
  }
  const unresolved = (Array.isArray(fields.exceptions) ? fields.exceptions : []).filter(Boolean);
  if (unresolved.length) {
    return {
      path: 'needs_exception',
      reason: 'unresolved_exceptions',
      blockers: unresolved.map(code => ({ code, message: `Unresolved exception: ${code}` })),
    };
  }
  return {
    path: 'fast_track_eligible',
    reason: 'authorized_routine_zero_budget_event',
    basis: {
      policyVersion: policy.policyVersion,
      authorizedBy: policy.authorizedBy,
      effectiveAt: policy.effectiveAt,
      eventType: fields.eventType,
    },
  };
}

export function findDuplicateProposal(state, fields, { excludeId = null, leadMemberId = null } = {}) {
  const title = normalizeTitle(fields?.title);
  const startAt = getPath(fields ?? {}, 'schedule.startAt') ?? null;
  if (!title || !startAt) return null;
  for (const proposal of Object.values(state.proposals)) {
    if (proposal.id === excludeId) continue;
    if (proposal.state === 'withdrawn' || proposal.state === 'duplicate') continue;
    if (normalizeTitle(proposal.fields.title) !== title) continue;
    if ((getPath(proposal.fields, 'schedule.startAt') ?? null) !== startAt) continue;
    if (leadMemberId && proposal.leadMemberId && leadMemberId !== proposal.leadMemberId) continue;
    return clone(proposal);
  }
  return null;
}

export function createProposalCore(state = createState()) {
  const audit = entry => {
    state.audit.push({ ...entry });
  };
  const actorKey = account => accountKey(account.platform, account.accountId);
  const memberFor = account => state.identities[actorKey(account)]?.memberId ?? null;
  const sameAccount = (left, right) =>
    Boolean(left && right && left.platform === right.platform && left.accountId === right.accountId);

  // Retries and repeated chat messages must not repeat the action (US15). A key is bound to one
  // action so reusing it for something else fails loudly instead of silently succeeding.
  const idempotent = (key, action, compute) => {
    if (!key) return compute();
    const existing = state.receipts[key];
    if (existing) {
      if (existing.action !== action) throw new Error(`idempotency key ${key} already used for ${existing.action}`);
      return clone(existing.result);
    }
    const result = compute();
    state.receipts[key] = { action, result: clone(result) };
    return clone(result);
  };

  function recordMember({ memberId, displayName = null, status = 'active', roles = [], recordedBy, at }) {
    requireText(memberId, 'memberId');
    requireText(recordedBy, 'recordedBy');
    requireTimestamp(at, 'at');
    const member = {
      memberId,
      displayName,
      status,
      roles: roles.map(role => ({
        role: role.role,
        status: role.status ?? 'active',
        grantedAt: role.grantedAt ?? null,
        expiresAt: role.expiresAt ?? null,
      })),
      updatedAt: at,
      updatedBy: recordedBy,
    };
    state.members[memberId] = member;
    audit({
      action: 'record_member',
      actor: recordedBy,
      subject: memberId,
      at,
      detail: { status, roles: member.roles.map(role => role.role) },
    });
    return { ok: true, member: clone(member) };
  }

  function revokeMemberRole({ memberId, role, revokedBy, at, reason = null }) {
    requireText(revokedBy, 'revokedBy');
    requireTimestamp(at, 'at');
    const member = state.members[memberId];
    if (!member) return { ok: false, reason: 'unknown_member' };
    const grant = (member.roles ?? []).find(entry => entry.role === role);
    if (!grant) return { ok: false, reason: 'role_not_recorded' };
    grant.status = 'revoked';
    grant.revokedAt = at;
    grant.revokedBy = revokedBy;
    grant.reason = reason;
    audit({ action: 'revoke_member_role', actor: revokedBy, subject: memberId, at, detail: { role, reason } });
    return { ok: true, member: clone(member) };
  }

  // Linking is against an authoritative member record. The display name and platform role label
  // are kept for presentation only and are never used to match or authorize anyone (R02).
  function linkIdentity({
    platform,
    accountId,
    displayName = null,
    platformRoleLabel = null,
    memberId,
    verifiedBy,
    verifiedAt,
  }) {
    requireText(platform, 'platform');
    requireText(accountId, 'accountId');
    requireText(memberId, 'memberId');
    requireText(verifiedBy, 'verifiedBy');
    requireTimestamp(verifiedAt, 'verifiedAt');
    if (!state.members[memberId]) return { ok: false, reason: 'unknown_authoritative_member', memberId };
    const key = accountKey(platform, accountId);
    const existing = state.identities[key];
    if (existing && existing.memberId !== memberId) {
      return { ok: false, reason: 'account_already_linked', existingMemberId: existing.memberId };
    }
    if (existing && existing.status === 'verified') return { ok: true, unchanged: true, identity: clone(existing) };
    state.identities[key] = {
      platform,
      accountId,
      displayName,
      platformRoleLabel,
      memberId,
      status: 'verified',
      verifiedAt,
      verifiedBy,
    };
    audit({
      action: existing ? 'relink_identity' : 'link_identity',
      actor: verifiedBy,
      subject: key,
      at: verifiedAt,
      detail: { memberId },
    });
    return {
      ok: true,
      identity: clone(state.identities[key]),
      additionalAccount: memberAccounts(state, memberId).length > 1,
    };
  }

  function revokeIdentity({ platform, accountId, revokedBy, at, reason = null }) {
    requireText(revokedBy, 'revokedBy');
    requireTimestamp(at, 'at');
    const key = accountKey(platform, accountId);
    const identity = state.identities[key];
    if (!identity) return { ok: false, reason: 'identity_not_linked' };
    identity.status = 'revoked';
    identity.revokedAt = at;
    identity.revokedBy = revokedBy;
    identity.reason = reason;
    audit({
      action: 'revoke_identity',
      actor: revokedBy,
      subject: key,
      at,
      detail: { memberId: identity.memberId, reason },
    });
    return { ok: true, identity: clone(identity) };
  }

  // R07: the authorized scope is recorded explicitly and can be revoked; nothing here defaults it on.
  function authorizeZeroBudgetPolicy({
    policyVersion,
    authorizedBy,
    effectiveAt,
    allowedEventTypes,
    requireVenueConfirmed = true,
    maxExpectedAttendance = null,
  }) {
    requireText(policyVersion, 'policyVersion');
    requireText(authorizedBy, 'authorizedBy');
    requireTimestamp(effectiveAt, 'effectiveAt');
    if (!Array.isArray(allowedEventTypes) || allowedEventTypes.length === 0) {
      throw new Error('allowedEventTypes must list the authorized routine event types');
    }
    state.zeroBudgetPolicy = {
      active: true,
      policyVersion,
      authorizedBy,
      effectiveAt,
      allowedEventTypes: [...allowedEventTypes],
      requireVenueConfirmed,
      maxExpectedAttendance,
    };
    audit({
      action: 'authorize_zero_budget_policy',
      actor: authorizedBy,
      subject: policyVersion,
      at: effectiveAt,
      detail: { allowedEventTypes },
    });
    return { ok: true, policy: clone(state.zeroBudgetPolicy) };
  }

  function revokeZeroBudgetPolicy({ revokedBy, at, reason = null }) {
    requireText(revokedBy, 'revokedBy');
    requireTimestamp(at, 'at');
    if (!state.zeroBudgetPolicy) return { ok: false, reason: 'no_policy_recorded' };
    state.zeroBudgetPolicy = { ...state.zeroBudgetPolicy, active: false, revokedAt: at, revokedBy, reason };
    audit({
      action: 'revoke_zero_budget_policy',
      actor: revokedBy,
      subject: state.zeroBudgetPolicy.policyVersion,
      at,
      detail: { reason },
    });
    return { ok: true, policy: clone(state.zeroBudgetPolicy) };
  }

  // R02/US02: an unlinked member may save and develop a draft; only confirmation makes it formal.
  function createDraft({ account, fields = {}, at, idempotencyKey = null }) {
    requireAccount(account);
    requireTimestamp(at, 'at');
    return idempotent(idempotencyKey, 'create_draft', () => {
      state.counters.proposal += 1;
      const id = `EV-${String(state.counters.proposal).padStart(3, '0')}`;
      const proposal = {
        id,
        ownerAccount: { platform: account.platform, accountId: account.accountId },
        leadMemberId: null,
        state: 'draft',
        version: 1,
        fields: clone(fields),
        versions: [{ version: 1, at, createdBy: actorKey(account), fields: clone(fields), materialChanges: [] }],
        confirmations: [],
        confirmedVersion: null,
        materialChangesPending: [],
        processingPath: null,
        approvalBasis: null,
        duplicateOf: null,
        copiedFrom: null,
        heldReason: null,
        history: [{ at, action: 'create_draft', actor: actorKey(account) }],
      };
      state.proposals[id] = proposal;
      audit({ action: 'create_draft', actor: actorKey(account), subject: id, at, detail: { version: 1 } });
      return { ok: true, at, proposalId: id, version: 1, state: proposal.state, proposal: clone(proposal) };
    });
  }

  function reviseDraft({ proposalId, account, patch, at, idempotencyKey = null }) {
    requireAccount(account);
    requireTimestamp(at, 'at');
    const proposal = state.proposals[proposalId];
    if (!proposal) return { ok: false, reason: 'unknown_proposal' };
    if (proposal.state === 'withdrawn') return { ok: false, reason: 'proposal_withdrawn' };
    if (proposal.state === 'approved') return { ok: false, reason: 'approved_version_is_immutable' };
    if (proposal.state === 'awaiting_governance') return { ok: false, reason: 'frozen_for_governance' };
    const actorMemberId = memberFor(account);
    if (!(sameAccount(proposal.ownerAccount, account) || (actorMemberId && actorMemberId === proposal.leadMemberId))) {
      return { ok: false, reason: 'not_owner_or_lead' };
    }
    return idempotent(idempotencyKey, 'revise_draft', () => {
      const previous = clone(proposal.fields);
      const materialChanges = detectMaterialChanges(previous, patch);
      const wasConfirmed = proposal.confirmedVersion === proposal.version;
      proposal.fields = deepMerge(proposal.fields, patch);
      proposal.version += 1;
      proposal.versions.push({
        version: proposal.version,
        at,
        createdBy: actorKey(account),
        fields: clone(proposal.fields),
        materialChanges,
      });
      proposal.materialChangesPending = materialChanges;
      proposal.processingPath = null;
      proposal.duplicateOf = null;
      if (wasConfirmed) {
        proposal.confirmedVersion = null;
        proposal.state = 'needs_reconfirmation';
      } else if (proposal.state !== 'draft') {
        proposal.state = 'draft';
      }
      proposal.history.push({
        at,
        action: 'revise_draft',
        actor: actorKey(account),
        detail: { version: proposal.version, materialChanges },
      });
      audit({
        action: 'revise_draft',
        actor: actorKey(account),
        subject: proposalId,
        at,
        detail: { version: proposal.version, materialChanges },
      });
      return {
        ok: true,
        at,
        proposalId,
        version: proposal.version,
        state: proposal.state,
        materialChanges,
        reconfirmationRequired: wasConfirmed,
        proposal: clone(proposal),
      };
    });
  }

  // R05/US12: a formal version carries the lead's own confirmation. Silence is not consent, and a
  // material change must be acknowledged rather than absorbed.
  function confirmLeadVersion({ proposalId, account, version, at, statement, acknowledgedMaterialChanges = false }) {
    requireAccount(account);
    requireTimestamp(at, 'at');
    const proposal = state.proposals[proposalId];
    if (!proposal) return { ok: false, reason: 'unknown_proposal' };
    if (typeof statement !== 'string' || !statement.trim()) {
      return { ok: false, reason: 'explicit_confirmation_statement_required' };
    }
    if (proposal.state === 'withdrawn') return { ok: false, reason: 'proposal_withdrawn' };
    if (proposal.state === 'approved' || proposal.state === 'awaiting_governance') {
      return { ok: false, reason: 'version_frozen' };
    }
    if (!Number.isInteger(version) || version !== proposal.version) {
      return { ok: false, reason: 'stale_version', currentVersion: proposal.version };
    }
    const eligibility = checkContributorEligibility(state, {
      platform: account.platform,
      accountId: account.accountId,
      at,
    });
    if (!eligibility.eligible) return { ok: false, reason: eligibility.reason, eligibility };
    if (proposal.leadMemberId && proposal.leadMemberId !== eligibility.memberId) {
      return { ok: false, reason: 'lead_conflict', leadMemberId: proposal.leadMemberId };
    }
    if (
      proposal.confirmedVersion === version &&
      proposal.state === 'confirmed' &&
      proposal.leadMemberId === eligibility.memberId
    ) {
      return {
        ok: true,
        unchanged: true,
        proposalId,
        version,
        state: proposal.state,
        leadMemberId: proposal.leadMemberId,
        proposal: clone(proposal),
      };
    }
    const materialChanges = proposal.materialChangesPending ?? [];
    if (materialChanges.length && !acknowledgedMaterialChanges) {
      return { ok: false, reason: 'material_changes_unacknowledged', materialChanges };
    }
    proposal.leadMemberId = eligibility.memberId;
    proposal.confirmedVersion = version;
    proposal.state = 'confirmed';
    proposal.materialChangesPending = [];
    proposal.confirmations.push({
      version,
      memberId: eligibility.memberId,
      at,
      statement: statement.trim(),
      materialChanges,
      acknowledgedMaterialChanges: Boolean(materialChanges.length && acknowledgedMaterialChanges),
    });
    proposal.history.push({
      at,
      action: 'confirm_lead_version',
      actor: actorKey(account),
      detail: { version, materialChanges },
    });
    audit({
      action: 'confirm_lead_version',
      actor: actorKey(account),
      subject: proposalId,
      at,
      detail: { version, leadMemberId: eligibility.memberId, materialChanges },
    });
    return {
      ok: true,
      at,
      proposalId,
      version,
      state: proposal.state,
      leadMemberId: proposal.leadMemberId,
      proposal: clone(proposal),
    };
  }

  function submitForAssessment({ proposalId, account, at, idempotencyKey = null }) {
    requireAccount(account);
    requireTimestamp(at, 'at');
    const proposal = state.proposals[proposalId];
    if (!proposal) return { ok: false, reason: 'unknown_proposal' };
    return idempotent(idempotencyKey, 'submit_for_assessment', () => {
      if (proposal.state === 'withdrawn') return { ok: false, reason: 'proposal_withdrawn' };
      if (proposal.confirmedVersion !== proposal.version) {
        return {
          ok: false,
          reason: 'unconfirmed_version',
          currentVersion: proposal.version,
          confirmedVersion: proposal.confirmedVersion,
        };
      }
      const eligibility = checkContributorEligibility(state, {
        platform: account.platform,
        accountId: account.accountId,
        at,
      });
      if (!eligibility.eligible) return { ok: false, reason: `lead_ineligible:${eligibility.reason}`, eligibility };
      if (eligibility.memberId !== proposal.leadMemberId) {
        return { ok: false, reason: 'submit_requires_confirmed_lead' };
      }

      const duplicate = findDuplicateProposal(state, proposal.fields, {
        excludeId: proposal.id,
        leadMemberId: proposal.leadMemberId,
      });
      if (duplicate) {
        proposal.state = 'duplicate';
        proposal.processingPath = 'duplicate';
        proposal.duplicateOf = duplicate.id;
        proposal.history.push({
          at,
          action: 'submit_for_assessment',
          actor: actorKey(account),
          detail: { duplicateOf: duplicate.id },
        });
        audit({
          action: 'duplicate_submission',
          actor: actorKey(account),
          subject: proposalId,
          at,
          detail: { duplicateOf: duplicate.id },
        });
        return {
          ok: true,
          at,
          proposalId,
          status: 'duplicate',
          duplicateOf: duplicate.id,
          queued: false,
          approved: false,
          proposal: clone(proposal),
        };
      }

      const completeness = checkCompleteness(proposal.fields);
      const schedule = validateSchedule(proposal.fields, { now: at });
      const route = routeProcessingPath({
        fields: proposal.fields,
        completeness,
        schedule,
        policy: state.zeroBudgetPolicy,
      });
      proposal.processingPath = route.path;
      proposal.duplicateOf = null;
      if (route.path === 'needs_information') proposal.state = 'needs_information';
      else if (route.path === 'needs_exception') proposal.state = 'needs_exception';
      else if (route.path === 'governance') proposal.state = 'awaiting_governance';
      else if (route.path === 'fast_track_eligible') {
        proposal.state = 'approved';
        proposal.approvalBasis = { kind: 'zero_budget_fast_track', at, ...route.basis };
      }
      proposal.history.push({
        at,
        action: 'submit_for_assessment',
        actor: actorKey(account),
        detail: { path: route.path, reason: route.reason },
      });
      audit({
        action: 'submit_for_assessment',
        actor: actorKey(account),
        subject: proposalId,
        at,
        detail: { path: route.path, reason: route.reason },
      });
      return {
        ok: true,
        at,
        proposalId,
        status: route.path,
        reason: route.reason,
        blockers: route.blockers ?? [],
        queued: route.path === 'governance',
        approved: route.path === 'fast_track_eligible',
        approvalBasis: proposal.approvalBasis ? clone(proposal.approvalBasis) : null,
        proposal: clone(proposal),
      };
    });
  }

  function withdrawProposal({ proposalId, account, at, reason = null }) {
    requireAccount(account);
    requireTimestamp(at, 'at');
    const proposal = state.proposals[proposalId];
    if (!proposal) return { ok: false, reason: 'unknown_proposal' };
    const actorMemberId = memberFor(account);
    if (!(sameAccount(proposal.ownerAccount, account) || (actorMemberId && actorMemberId === proposal.leadMemberId))) {
      return { ok: false, reason: 'not_owner_or_lead' };
    }
    if (proposal.state === 'withdrawn') return { ok: true, unchanged: true, proposalId, state: 'withdrawn' };
    proposal.state = 'withdrawn';
    proposal.processingPath = null;
    proposal.history.push({ at, action: 'withdraw_proposal', actor: actorKey(account), detail: { reason } });
    audit({ action: 'withdraw_proposal', actor: actorKey(account), subject: proposalId, at, detail: { reason } });
    return { ok: true, at, proposalId, state: 'withdrawn', proposal: clone(proposal) };
  }

  function holdProposal({ proposalId, account, at, reason }) {
    requireAccount(account);
    requireTimestamp(at, 'at');
    const proposal = state.proposals[proposalId];
    if (!proposal) return { ok: false, reason: 'unknown_proposal' };
    if (proposal.state === 'withdrawn' || proposal.state === 'approved' || proposal.state === 'awaiting_governance') {
      return { ok: false, reason: `cannot_hold_${proposal.state}` };
    }
    proposal.state = 'on_hold';
    proposal.heldReason = reason ?? 'awaiting_lead_response';
    proposal.history.push({
      at,
      action: 'hold_proposal',
      actor: actorKey(account),
      detail: { reason: proposal.heldReason },
    });
    audit({
      action: 'hold_proposal',
      actor: actorKey(account),
      subject: proposalId,
      at,
      detail: { reason: proposal.heldReason },
    });
    return { ok: true, at, proposalId, state: proposal.state, heldReason: proposal.heldReason };
  }

  // R05: resume re-checks validity instead of rejecting a proposal permanently.
  function resumeProposal({ proposalId, at }) {
    requireTimestamp(at, 'at');
    const proposal = state.proposals[proposalId];
    if (!proposal) return { ok: false, reason: 'unknown_proposal' };
    if (proposal.state !== 'on_hold') return { ok: false, reason: 'not_on_hold' };
    const schedule = validateSchedule(proposal.fields, { now: at });
    const confirmed = proposal.confirmedVersion === proposal.version;
    proposal.state = confirmed && schedule.valid ? 'confirmed' : 'needs_information';
    proposal.heldReason = null;
    proposal.history.push({
      at,
      action: 'resume_proposal',
      detail: { state: proposal.state, scheduleProblems: schedule.problems.map(problem => problem.code) },
    });
    audit({ action: 'resume_proposal', subject: proposalId, at, detail: { state: proposal.state } });
    return { ok: true, at, proposalId, state: proposal.state, scheduleProblems: schedule.problems, proposal: clone(proposal) };
  }

  // US16: a copy starts a new draft and inherits no confirmation, approval or budget decision.
  function copyProposal({ proposalId, account, at, idempotencyKey = null }) {
    requireAccount(account);
    requireTimestamp(at, 'at');
    const source = state.proposals[proposalId];
    if (!source) return { ok: false, reason: 'unknown_proposal' };
    const created = createDraft({ account, fields: clone(source.fields), at, idempotencyKey });
    const proposal = state.proposals[created.proposalId];
    proposal.copiedFrom = source.id;
    proposal.history.push({ at, action: 'copy_proposal', actor: actorKey(account), detail: { copiedFrom: source.id } });
    audit({
      action: 'copy_proposal',
      actor: actorKey(account),
      subject: created.proposalId,
      at,
      detail: { copiedFrom: source.id },
    });
    return {
      ok: true,
      at,
      proposalId: created.proposalId,
      copiedFrom: source.id,
      state: proposal.state,
      proposal: clone(proposal),
    };
  }

  return {
    state,
    snapshot: () => snapshot(state),
    recordMember,
    revokeMemberRole,
    linkIdentity,
    revokeIdentity,
    memberAccounts: memberId => memberAccounts(state, memberId),
    eligibilityFor: account =>
      checkContributorEligibility(state, { platform: account.platform, accountId: account.accountId, at: account.at }),
    authorizeZeroBudgetPolicy,
    revokeZeroBudgetPolicy,
    createDraft,
    reviseDraft,
    confirmLeadVersion,
    submitForAssessment,
    withdrawProposal,
    holdProposal,
    resumeProposal,
    copyProposal,
  };
}
