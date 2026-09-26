// Tests for the proposal tool bridge (plugins/rein-operations/proposal-tool-bridge.ts).
//
// These checks drive the real proposal core through the real durable store and the real tool factory:
// host-context account derivation, forged-actor rejection, fail-closed configuration and channel
// scoping, Contributor revocation, version confirmation, retry replay, conflicting-retry refusal,
// the final invocation guard and restart persistence.
//
// Honest limit: OpenClaw's v2 tool context exposes no trusted inbound message or event id, only the
// `toolCallId` handed to `execute`. The retry key is scoped to that call id, so a retried invocation
// replays, but a caller that invents a fresh call id is not stopped by this layer. No chat platform,
// website or payment provider is connected, so nothing here proves a live integration.
//
// Run: node --test tests/proposal-tool-bridge.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProposalStore } from '../plugins/rein-operations/proposal-store.ts';
import {
  createProposalToolRegistration,
  PROPOSAL_TOOL_NAMES,
} from '../plugins/rein-operations/proposal-tool-bridge.ts';
import { createRegistrySnapshot, checkContributorEligibility } from '../plugins/rein-operations/registry-snapshot.ts';

// The P0 chat platform is still undecided (docs/decisions.md), so the rehearsal uses a synthetic
// label that cannot be mistaken for an adopted platform choice.
const PLATFORM = 'rehearsal-chat';
const CHANNEL = 'proposal-room';
const SEED_AT = '2026-09-24T08:00:00Z';
const CLOCK = '2026-09-24T09:00:00Z';

const baseFields = () => ({
  title: 'Campus paper discussion',
  eventType: 'reading_group',
  purpose: 'Discuss alignment papers with students',
  audience: 'Students, open to the public',
  format: 'in_person',
  schedule: { startAt: '2026-10-10T18:00:00Z', timeZone: 'America/Los_Angeles', durationMinutes: 90 },
  location: { venue: 'Room 204', venueConfirmed: true },
  capacity: { expectedAttendance: 15, registration: 'open' },
  program: { agenda: 'Two papers, 45 minutes each' },
  fees: { charged: false },
  budget: {
    requestedAmountMinor: 0,
    reimbursementExpected: false,
    hiddenCostsConfirmed: true,
    contractualCommitments: false,
  },
  risks: { notes: 'No known risks' },
  deliverables: { summary: true, photoRestrictions: 'no_photos' },
});

const tempDir = () => mkdtempSync(join(tmpdir(), 'rein-proposal-bridge-'));

function seedContributor(store, { memberId = 'M-100', accountId = 'u-contributor', role = 'contributor', at = SEED_AT } = {}) {
  return store.transact({
    action: 'record_membership',
    at,
    idempotencyKey: `seed-${memberId}-${accountId}`,
    run(core) {
      core.recordMember({ memberId, displayName: 'Seed Member', roles: role ? [{ role }] : [], recordedBy: 'admin', at });
      core.linkIdentity({ platform: PLATFORM, accountId, memberId, verifiedBy: 'admin', verifiedAt: at });
      return { memberId, accountId };
    },
  });
}

function registrationFor(store) {
  return createProposalToolRegistration({
    platform: PLATFORM,
    allowedNativeChannelIds: [CHANNEL],
    store,
    now: () => CLOCK,
    // Synthetic provider for domain tests; production registration supplies no provider and
    // therefore refuses formal confirmation/submission until the authority is integrated.
    authorizeFormalAction: () => ({ eligible: true, reason: 'synthetic_test_grant', memberId: 'M-100' }),
  });
}

function makeContext(overrides = {}) {
  return {
    messageChannel: PLATFORM,
    nativeChannelId: CHANNEL,
    requesterSenderId: 'u-contributor',
    assertInvocationCurrent: () => {},
    ...overrides,
  };
}

function toolsFor(registration, context) {
  const tools = registration.create(context);
  return tools ? Object.fromEntries(tools.map(tool => [tool.name, tool])) : null;
}

test('formal actions fail closed without a current authoritative registry provider', async () => {
  const dir = tempDir();
  try {
    const store = createProposalStore({ path: join(dir, 'state.json') });
    seedContributor(store);
    const registration = createProposalToolRegistration({
      platform: PLATFORM, allowedNativeChannelIds: [CHANNEL], store, now: () => CLOCK,
    });
    const tools = toolsFor(registration, makeContext());
    const draft = await tools['rein_proposal_create'].execute('draft', { fields: baseFields() });
    assert.equal(draft.details.ok, true);
    const confirmed = await tools['rein_proposal_confirm'].execute('confirm', {
      proposalId: draft.details.proposalId, version: 1, statement: 'I confirm this version',
    });
    assert.equal(confirmed.details.ok, false);
    assert.equal(confirmed.details.causeCode, 'authoritative_registry_required');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formal action checks a current registry snapshot at the write boundary', async () => {
  const dir = tempDir();
  try {
    const store = createProposalStore({ path: join(dir, 'state.json') });
    seedContributor(store);
    let at = CLOCK;
    const raw = (status = 'active', generatedAt = CLOCK) => ({
      version: `registry-${status}-${generatedAt}`,
      generatedAt,
      platform: PLATFORM,
      members: [{ memberId: 'M-100', status: 'active', roles: [{ role: 'contributor', status }] }],
      links: [{ platform: PLATFORM, accountId: 'u-contributor', memberId: 'M-100', status: 'verified', verifiedAt: SEED_AT }],
    });
    let snapshot = createRegistrySnapshot(raw(), { at: CLOCK, maxAgeMs: 60_000 });
    const registration = createProposalToolRegistration({
      platform: PLATFORM, allowedNativeChannelIds: [CHANNEL], store,
      now: () => at,
      authorizeFormalAction: input => checkContributorEligibility(snapshot, input),
    });
    const tools = toolsFor(registration, makeContext());
    const draft = await tools['rein_proposal_create'].execute('snapshot-draft', { fields: baseFields() });
    assert.equal(draft.details.ok, true);
    const proposalId = draft.details.proposalId;
    const confirmed = await tools['rein_proposal_confirm'].execute('snapshot-confirm', {
      proposalId, version: 1, statement: 'I confirm this version',
    });
    assert.equal(confirmed.details.ok, true);

    const reassigned = raw();
    reassigned.members[0].memberId = 'M-200';
    reassigned.links[0].memberId = 'M-200';
    snapshot = createRegistrySnapshot(reassigned, { at: CLOCK, maxAgeMs: 60_000 });
    const mismatched = await tools['rein_proposal_submit'].execute('snapshot-submit-mismatch', { proposalId });
    assert.equal(mismatched.details.ok, false);
    assert.match(mismatched.details.message, /authoritative_member_mismatch/);

    snapshot = createRegistrySnapshot(raw('revoked'), { at: CLOCK, maxAgeMs: 60_000 });
    const revoked = await tools['rein_proposal_submit'].execute('snapshot-submit-revoked', { proposalId });
    assert.equal(revoked.details.ok, false);
    assert.equal(revoked.details.causeCode, 'authoritative_registry_required');

    snapshot = createRegistrySnapshot(raw(), { at: CLOCK, maxAgeMs: 60_000 });
    at = '2026-09-24T09:01:01Z';
    const stale = await tools['rein_proposal_submit'].execute('snapshot-submit-stale', { proposalId });
    assert.equal(stale.details.ok, false);
    assert.equal(stale.details.causeCode, 'authoritative_registry_required');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('absent configuration registers no tools and the surface stays proposal-only', () => {
  const dir = tempDir();
  try {
    const store = createProposalStore({ path: join(dir, 'state.json') });
    assert.equal(createProposalToolRegistration().create(makeContext()), null, 'no options means no tools');
    assert.equal(
      createProposalToolRegistration({ allowedNativeChannelIds: [CHANNEL], store }).create(makeContext()),
      null,
      'missing platform means no tools',
    );
    assert.equal(
      createProposalToolRegistration({ platform: PLATFORM, store }).create(makeContext()),
      null,
      'missing allowed channels means no tools',
    );
    assert.equal(
      createProposalToolRegistration({ platform: PLATFORM, allowedNativeChannelIds: [CHANNEL] }).create(makeContext()),
      null,
      'missing store means no tools',
    );
    assert.equal(
      createProposalToolRegistration({ platform: '   ', allowedNativeChannelIds: [CHANNEL], store }).create(makeContext()),
      null,
      'blank platform means no tools',
    );

    const registration = registrationFor(store);
    assert.equal(registration.contextVersion, 2);
    const tools = registration.create(makeContext());
    assert.deepEqual(tools.map(tool => tool.name), [...PROPOSAL_TOOL_NAMES]);
    // No registrar, policy-approval, funding, payment or voting tool is exposed here.
    assert.ok(!tools.some(tool => /registrar|policy|fund|approv|vote|pay|settle/i.test(tool.name)));
    for (const tool of tools) {
      const properties = tool.parameters?.properties ?? {};
      assert.ok(!('actor' in properties) && !('memberId' in properties) && !('accountId' in properties));
      assert.equal(tool.parameters?.additionalProperties, false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a forged actor argument is rejected and the draft owner comes from the host context', async () => {
  const dir = tempDir();
  try {
    const store = createProposalStore({ path: join(dir, 'state.json') });
    seedContributor(store);
    const tools = toolsFor(registrationFor(store), makeContext());

    const forgedActor = await tools['rein_proposal_create'].execute('call-forged-actor', {
      fields: baseFields(),
      actor: 'board-chair',
    });
    assert.equal(forgedActor.details.ok, false);
    assert.equal(forgedActor.details.error, 'actor_argument_rejected');

    const forgedMember = await tools['rein_proposal_create'].execute('call-forged-member', {
      fields: baseFields(),
      memberId: 'M-999',
    });
    assert.equal(forgedMember.details.error, 'actor_argument_rejected');

    const created = await tools['rein_proposal_create'].execute('call-1', { fields: baseFields() });
    assert.equal(created.details.ok, true);
    assert.equal(created.details.proposalId, 'EV-001');
    const proposal = store.snapshot().state.proposals['EV-001'];
    assert.deepEqual(proposal.ownerAccount, { platform: PLATFORM, accountId: 'u-contributor' });
    assert.equal(proposal.leadMemberId, null, 'a forged memberId cannot set the lead');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a wrong channel or mismatched host context fails closed without writing', async () => {
  const dir = tempDir();
  try {
    const store = createProposalStore({ path: join(dir, 'state.json') });
    seedContributor(store);
    const registration = registrationFor(store);
    const seededRevision = store.snapshot().revision;

    const wrongChannel = toolsFor(registration, makeContext({ nativeChannelId: 'public-chat' }));
    const wrong = await wrongChannel['rein_proposal_create'].execute('call-1', { fields: baseFields() });
    assert.equal(wrong.details.ok, false);
    assert.equal(wrong.details.error, 'channel_out_of_scope');

    const otherPlatform = toolsFor(registration, makeContext({ messageChannel: 'slack' }));
    const mismatched = await otherPlatform['rein_proposal_create'].execute('call-2', { fields: baseFields() });
    assert.equal(mismatched.details.error, 'trusted_requester_unavailable');

    const anonymous = toolsFor(registration, makeContext({ requesterSenderId: '   ' }));
    const missingSender = await anonymous['rein_proposal_create'].execute('call-3', { fields: baseFields() });
    assert.equal(missingSender.details.error, 'trusted_requester_unavailable');

    assert.equal(store.snapshot().revision, seededRevision, 'no rejected call advanced the store');
    assert.deepEqual(store.snapshot().state.proposals, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unlinked sender may draft but cannot confirm or submit', async () => {
  const dir = tempDir();
  try {
    const store = createProposalStore({ path: join(dir, 'state.json') });
    seedContributor(store);
    const tools = toolsFor(registrationFor(store), makeContext({ requesterSenderId: 'u-stranger' }));

    const created = await tools['rein_proposal_create'].execute('call-1', { fields: baseFields() });
    assert.equal(created.details.ok, true);
    assert.equal(created.details.proposalId, 'EV-001');

    const confirmed = await tools['rein_proposal_confirm'].execute('call-2', {
      proposalId: 'EV-001',
      version: 1,
      statement: 'I confirm this version',
    });
    assert.equal(confirmed.details.ok, false, 'a domain rejection is not reported as success');
    assert.equal(confirmed.details.reason, 'identity_not_linked');
    assert.equal(confirmed.details.result.ok, false, 'the domain rejected the confirmation');
    assert.equal(confirmed.details.result.reason, 'identity_not_linked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the first unlinked sender can create a draft on a fresh store with no registrar seed', async () => {
  const dir = tempDir();
  try {
    const store = createProposalStore({ path: join(dir, 'state.json') });
    assert.equal(store.snapshot().state, null, 'the store starts empty');
    const tools = toolsFor(registrationFor(store), makeContext({ requesterSenderId: 'u-newcomer' }));

    const created = await tools['rein_proposal_create'].execute('call-first', { fields: baseFields() });
    assert.equal(created.details.ok, true);
    assert.equal(created.details.proposalId, 'EV-001');
    assert.equal(created.details.result.ok, true);
    const proposal = store.snapshot().state.proposals['EV-001'];
    assert.deepEqual(proposal.ownerAccount, { platform: PLATFORM, accountId: 'u-newcomer' });
    assert.equal(proposal.leadMemberId, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a revoked Contributor can no longer confirm or submit', async () => {
  const dir = tempDir();
  try {
    const store = createProposalStore({ path: join(dir, 'state.json') });
    seedContributor(store);
    const registration = registrationFor(store);
    const tools = toolsFor(registration, makeContext());

    await tools['rein_proposal_create'].execute('call-1', { fields: baseFields() });
    const confirmed = await tools['rein_proposal_confirm'].execute('call-2', {
      proposalId: 'EV-001',
      version: 1,
      statement: 'I confirm this version',
    });
    assert.equal(confirmed.details.result.ok, true);
    assert.equal(confirmed.details.result.state, 'confirmed');

    store.transact({
      action: 'revoke_contributor',
      at: '2026-09-24T09:15:00Z',
      idempotencyKey: 'revoke-1',
      run: core =>
        core.revokeMemberRole({
          memberId: 'M-100',
          role: 'contributor',
          revokedBy: 'admin',
          at: '2026-09-24T09:15:00Z',
        }),
    });

    const afterRevoke = toolsFor(registration, makeContext());
    const confirmAgain = await afterRevoke['rein_proposal_confirm'].execute('call-3', {
      proposalId: 'EV-001',
      version: 1,
      statement: 'still me',
    });
    assert.equal(confirmAgain.details.ok, false, 'a rejected confirmation is not reported as success');
    assert.equal(confirmAgain.details.reason, 'no_active_contributor_role');
    assert.equal(confirmAgain.details.result.ok, false);
    assert.equal(confirmAgain.details.result.reason, 'no_active_contributor_role');

    const submit = await afterRevoke['rein_proposal_submit'].execute('call-4', { proposalId: 'EV-001' });
    assert.equal(submit.details.ok, false, 'a rejected submission is not reported as success');
    assert.equal(submit.details.reason, 'lead_ineligible:no_active_contributor_role');
    assert.equal(submit.details.result.ok, false);
    assert.equal(submit.details.result.reason, 'lead_ineligible:no_active_contributor_role');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('confirmation binds to the current version and refuses a stale one', async () => {
  const dir = tempDir();
  try {
    const store = createProposalStore({ path: join(dir, 'state.json') });
    seedContributor(store);
    const tools = toolsFor(registrationFor(store), makeContext());
    await tools['rein_proposal_create'].execute('call-1', { fields: baseFields() });

    const silent = await tools['rein_proposal_confirm'].execute('call-2', {
      proposalId: 'EV-001',
      version: 1,
      statement: '   ',
    });
    assert.equal(silent.details.result.reason, 'explicit_confirmation_statement_required');

    const stale = await tools['rein_proposal_confirm'].execute('call-3', {
      proposalId: 'EV-001',
      version: 2,
      statement: 'I confirm',
    });
    assert.equal(stale.details.result.reason, 'stale_version');
    assert.equal(stale.details.result.currentVersion, 1);

    const confirmed = await tools['rein_proposal_confirm'].execute('call-4', {
      proposalId: 'EV-001',
      version: 1,
      statement: 'I confirm this version',
    });
    assert.equal(confirmed.details.result.ok, true);
    assert.equal(confirmed.details.result.state, 'confirmed');

    const revised = await tools['rein_proposal_revise'].execute('call-5', {
      proposalId: 'EV-001',
      patch: { budget: { requestedAmountMinor: 5000, currency: 'USD', items: 'Venue', assumptions: 'Quote' } },
    });
    assert.equal(revised.details.result.ok, true);
    assert.equal(revised.details.result.version, 2);
    assert.equal(revised.details.result.reconfirmationRequired, true);

    const staleAgain = await tools['rein_proposal_confirm'].execute('call-6', {
      proposalId: 'EV-001',
      version: 1,
      statement: 'I confirm',
    });
    assert.equal(staleAgain.details.result.reason, 'stale_version');
    assert.equal(staleAgain.details.result.currentVersion, 2);

    const unacknowledged = await tools['rein_proposal_confirm'].execute('call-7', {
      proposalId: 'EV-001',
      version: 2,
      statement: 'I confirm the funding change',
    });
    assert.equal(unacknowledged.details.result.reason, 'material_changes_unacknowledged');

    const acknowledged = await tools['rein_proposal_confirm'].execute('call-8', {
      proposalId: 'EV-001',
      version: 2,
      statement: 'I confirm the funding change',
      acknowledgedMaterialChanges: true,
    });
    assert.equal(acknowledged.details.result.ok, true);
    assert.equal(acknowledged.details.result.state, 'confirmed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retrying the same tool call id replays instead of creating a second proposal', async () => {
  const dir = tempDir();
  try {
    const store = createProposalStore({ path: join(dir, 'state.json') });
    seedContributor(store);
    const tools = toolsFor(registrationFor(store), makeContext());

    const first = await tools['rein_proposal_create'].execute('call-retry', { fields: baseFields() });
    assert.equal(first.details.ok, true);
    assert.equal(first.details.replayed, false);

    const retry = await tools['rein_proposal_create'].execute('call-retry', { fields: baseFields() });
    assert.equal(retry.details.ok, true);
    assert.equal(retry.details.replayed, true);
    assert.equal(retry.details.proposalId, first.details.proposalId);
    assert.deepEqual(Object.keys(store.snapshot().state.proposals), ['EV-001']);
    assert.equal(store.snapshot().state.counters.proposal, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reusing one tool call id with different arguments fails loudly and writes nothing', async () => {
  const dir = tempDir();
  try {
    const store = createProposalStore({ path: join(dir, 'state.json') });
    seedContributor(store);
    const tools = toolsFor(registrationFor(store), makeContext());

    const first = await tools['rein_proposal_create'].execute('call-conflict', { fields: baseFields() });
    assert.equal(first.details.ok, true);

    const conflicting = await tools['rein_proposal_create'].execute('call-conflict', {
      fields: { ...baseFields(), title: 'A different title' },
    });
    assert.equal(conflicting.details.ok, false);
    assert.equal(conflicting.details.error, 'storage_failure');
    assert.match(conflicting.details.message, /idempotency key reused/i);
    assert.deepEqual(Object.keys(store.snapshot().state.proposals), ['EV-001']);
    assert.equal(store.snapshot().state.counters.proposal, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the final invocation guard runs before the write and a stale turn writes nothing', async () => {
  const dir = tempDir();
  try {
    const store = createProposalStore({ path: join(dir, 'state.json') });
    seedContributor(store);
    const registration = registrationFor(store);
    const before = store.snapshot().revision;

    let guardCalls = 0;
    const staleTools = toolsFor(
      registration,
      makeContext({
        assertInvocationCurrent() {
          guardCalls += 1;
          throw new Error('invocation no longer current');
        },
      }),
    );
    const stale = await staleTools['rein_proposal_create'].execute('call-1', { fields: baseFields() });
    assert.equal(stale.details.ok, false);
    assert.equal(guardCalls, 1, 'the guard ran inside the write path');
    assert.match(stale.details.message, /no longer current/);
    assert.equal(store.snapshot().revision, before);
    assert.deepEqual(store.snapshot().state.proposals, {});

    const noGuardTools = toolsFor(registration, makeContext({ assertInvocationCurrent: undefined }));
    const missing = await noGuardTools['rein_proposal_create'].execute('call-2', { fields: baseFields() });
    assert.equal(missing.details.ok, false);
    assert.equal(missing.details.causeCode, 'current_invocation_guard_unavailable');
    assert.equal(store.snapshot().revision, before);
    assert.deepEqual(store.snapshot().state.proposals, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a committed draft and its retry receipt survive a restart', async () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'state.json');
    const store = createProposalStore({ path: file });
    seedContributor(store);
    const tools = toolsFor(registrationFor(store), makeContext());
    const created = await tools['rein_proposal_create'].execute('call-persist', { fields: baseFields() });
    assert.equal(created.details.proposalId, 'EV-001');

    const reopened = createProposalStore({ path: file });
    const state = reopened.snapshot().state;
    assert.equal(state.proposals['EV-001'].ownerAccount.accountId, 'u-contributor');

    const reopenedTools = toolsFor(registrationFor(reopened), makeContext());
    const retried = await reopenedTools['rein_proposal_create'].execute('call-persist', { fields: baseFields() });
    assert.equal(retried.details.ok, true);
    assert.equal(retried.details.replayed, true);
    assert.equal(retried.details.proposalId, 'EV-001');
    assert.equal(reopened.snapshot().state.counters.proposal, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
