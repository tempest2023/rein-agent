// Tests for the durable proposal store adapter (plugins/rein-operations/proposal-store.ts).
//
// These checks drive the real proposals core through the real ledger file: restart recovery,
// optimistic conflict rejection, idempotent retries and their exact key semantics, slot isolation and
// corrupt-file handling. They prove local durability on one host only. No chat platform, website or
// payment provider is connected, so nothing here claims that a live integration works.
//
// Run: node --test tests/proposal-store.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLedger } from '../plugins/rein-operations/ledger.ts';
import { createProposalCore } from '../plugins/rein-operations/proposals.ts';
import {
  createProposalStore,
  hydrateProposalState,
  openProposalCore,
  ProposalStoreError,
  PROPOSAL_STORE_SLOT,
} from '../plugins/rein-operations/proposal-store.ts';

const T = {
  records: '2026-09-24T08:00:00Z',
  draft: '2026-09-24T09:00:00Z',
  confirm: '2026-09-24T09:30:00Z',
  submit: '2026-09-24T10:00:00Z',
};

// The P0 chat platform is still undecided (docs/decisions.md), so the rehearsal uses a synthetic
// label that cannot be mistaken for an adopted platform choice.
const CONTRIBUTOR = { platform: 'rehearsal-chat', accountId: 'u-contributor' };
const CONTRIBUTOR_KEY = 'rehearsal-chat:u-contributor';

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

const tempDir = () => mkdtempSync(join(tmpdir(), 'rein-proposal-store-'));

function recordMembership(store, { expectedRevision = 0, idempotencyKey = 'msg-record-membership', at = T.records } = {}) {
  return store.transact({
    action: 'record_membership',
    at,
    idempotencyKey,
    expectedRevision,
    run(core) {
      core.recordMember({ memberId: 'M-100', displayName: 'Maya Chen', roles: [{ role: 'contributor' }], recordedBy: 'admin', at });
      core.recordMember({ memberId: 'M-200', displayName: 'Lin Wei', roles: [], recordedBy: 'admin', at });
      core.linkIdentity({ ...CONTRIBUTOR, displayName: 'Maya Chen', memberId: 'M-100', verifiedBy: 'admin', verifiedAt: at });
      return { members: Object.keys(core.snapshot().members).length, linked: CONTRIBUTOR_KEY };
    },
  });
}

function createDraft(store, { expectedRevision, idempotencyKey, at = T.draft }) {
  return store.transact({
    action: 'create_draft',
    at,
    idempotencyKey,
    expectedRevision,
    run: core => core.createDraft({ account: CONTRIBUTOR, fields: baseFields(), at, idempotencyKey: `${idempotencyKey}:core` }),
  });
}

test('a restarted store reconstructs the same core, counter and identity links', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'state.json');
    const first = createProposalStore({ path: file });
    assert.deepEqual(first.snapshot(), { revision: 0, state: null });
    assert.equal(first.load(), null);

    const seeded = recordMembership(first, { expectedRevision: 0 });
    assert.equal(seeded.revision, 1);
    assert.equal(seeded.replayed, false);
    assert.deepEqual(seeded.result, { members: 2, linked: CONTRIBUTOR_KEY });

    const drafted = createDraft(first, { expectedRevision: 1, idempotencyKey: 'chat-message-1' });
    assert.equal(drafted.result.proposalId, 'EV-001');
    assert.equal(drafted.result.version, 1);

    const restarted = createProposalStore({ path: file });
    const restored = restarted.snapshot();
    assert.equal(restored.revision, 2);
    assert.equal(restored.state.counters.proposal, 1);
    assert.equal(restored.state.proposals['EV-001'].state, 'draft');
    assert.deepEqual(Object.keys(restored.state.identities), [CONTRIBUTOR_KEY]);
    assert.equal(
      openProposalCore(restored.state).eligibilityFor({ ...CONTRIBUTOR, at: T.draft }).eligible,
      true,
      'the identity link and contributor role survive the restart',
    );

    const second = createDraft(restarted, { expectedRevision: 2, idempotencyKey: 'chat-message-2' });
    assert.equal(second.result.proposalId, 'EV-002', 'identifiers do not restart at EV-001');
    assert.deepEqual(Object.keys(restarted.snapshot().state.proposals), ['EV-001', 'EV-002']);

    const raw = createLedger(file).snapshot();
    assert.deepEqual(Object.keys(raw.records), [PROPOSAL_STORE_SLOT], 'the adapter writes only its own slot');
    assert.equal(raw.revision, 3);
    assert.deepEqual(
      raw.audit.map(entry => [entry.key, entry.action, entry.actor, entry.at, entry.revision]),
      [
        ['rein-proposals:msg-record-membership', 'record_membership', 'rein-operations', T.records, 1],
        ['rein-proposals:chat-message-1', 'create_draft', 'rein-operations', T.draft, 2],
        ['rein-proposals:chat-message-2', 'create_draft', 'rein-operations', T.draft, 3],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale expected revision is rejected without touching the ledger', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'state.json');
    const writer = createProposalStore({ path: file });
    const stale = createProposalStore({ path: file });
    recordMembership(writer, { expectedRevision: 0 });

    assert.throws(
      () => recordMembership(stale, { expectedRevision: 0, idempotencyKey: 'msg-other-membership' }),
      error =>
        error instanceof ProposalStoreError &&
        error.code === 'storage_conflict' &&
        error.details.expectedRevision === 0 &&
        error.details.actualRevision === 1,
    );

    assert.equal(stale.snapshot().revision, 1, 'the rejected writer reads the committed revision');
    assert.equal(Object.keys(writer.snapshot().state.members).length, 2);

    const raw = createLedger(file).snapshot();
    assert.equal(raw.revision, 1, 'a rejected transaction writes no revision');
    assert.equal(raw.audit.length, 1, 'a rejected transaction writes no audit entry');
    assert.deepEqual(
      Object.keys(raw.receipts),
      ['rein-proposals:msg-record-membership'],
      'a rejected transaction stores no receipt',
    );

    const retried = recordMembership(stale, { expectedRevision: 1, idempotencyKey: 'msg-other-membership' });
    assert.equal(retried.revision, 2, 'reloading the revision lets the same caller commit');
    assert.equal(retried.replayed, false);
    assert.equal(createLedger(file).snapshot().revision, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reusing an idempotency key replays the receipt instead of repeating the action', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'state.json');
    const store = createProposalStore({ path: file });
    const first = createDraft(store, { expectedRevision: 0, idempotencyKey: 'chat-message-1' });
    assert.equal(first.result.proposalId, 'EV-001');
    assert.equal(first.revision, 1);
    assert.equal(first.replayed, false);
    assert.equal(first.receipt.actor, 'rein-operations');
    assert.equal(first.receipt.action, 'create_draft');

    const replay = store.transact({
      action: 'create_draft',
      at: T.draft,
      idempotencyKey: 'chat-message-1',
      expectedRevision: 0,
      run() {
        throw new Error('the action must not run twice');
      },
    });
    assert.deepEqual(replay.result, first.result);
    assert.equal(replay.revision, 1);
    assert.equal(replay.replayed, true, 'the caller can tell a replay from a fresh commit');
    assert.equal(replay.receipt.revision, 1, 'the replayed receipt reports the revision it committed');

    const restarted = createProposalStore({ path: file });
    const recovered = createDraft(restarted, { expectedRevision: 0, idempotencyKey: 'chat-message-1' });
    assert.equal(recovered.result.proposalId, 'EV-001', 'a retry after a restart does not duplicate the proposal');
    assert.equal(recovered.replayed, true);
    assert.equal(restarted.snapshot().revision, 1);
    assert.equal(restarted.snapshot().state.counters.proposal, 1);
    assert.deepEqual(Object.keys(restarted.snapshot().state.proposals), ['EV-001']);

    // The same key bound to another action fails loudly rather than silently succeeding.
    assert.throws(
      () => store.transact({ action: 'withdraw_proposal', at: T.draft, idempotencyKey: 'chat-message-1', run() {} }),
      error => error.code === 'storage_failure' && /idempotency key reused/.test(error.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the store never activates the proposed zero-budget default on its own', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'state.json');
    const store = createProposalStore({ path: file });
    recordMembership(store, { expectedRevision: 0 });
    const proposalId = createDraft(store, { expectedRevision: 1, idempotencyKey: 'draft-1' }).result.proposalId;

    const confirmed = store.transact({
      action: 'confirm_lead_version',
      at: T.confirm,
      idempotencyKey: 'confirm-1',
      expectedRevision: 2,
      run: core =>
        core.confirmLeadVersion({ proposalId, account: CONTRIBUTOR, version: 1, at: T.confirm, statement: 'I confirm this version.' }),
    });
    assert.equal(confirmed.result.ok, true);

    const submitted = store.transact({
      action: 'submit_for_assessment',
      at: T.submit,
      idempotencyKey: 'submit-1',
      expectedRevision: 3,
      run: core => core.submitForAssessment({ proposalId, account: CONTRIBUTOR, at: T.submit, idempotencyKey: 'submit-1' }),
    });
    assert.equal(submitted.result.status, 'needs_exception');
    assert.equal(submitted.result.approved, false);
    assert.equal(store.snapshot().state.zeroBudgetPolicy, null, 'no policy is persisted until one is recorded');

    const authorized = store.transact({
      action: 'authorize_zero_budget_policy',
      at: T.submit,
      idempotencyKey: 'authorize-1',
      expectedRevision: 4,
      run: core =>
        core.authorizeZeroBudgetPolicy({
          policyVersion: 'zero-budget-v1',
          authorizedBy: 'board-secretary',
          effectiveAt: T.submit,
          allowedEventTypes: ['reading_group'],
          maxExpectedAttendance: 20,
        }),
    });
    assert.equal(authorized.result.ok, true);

    const again = store.transact({
      action: 'submit_for_assessment',
      at: T.submit,
      idempotencyKey: 'submit-2',
      expectedRevision: 5,
      run: core => core.submitForAssessment({ proposalId, account: CONTRIBUTOR, at: T.submit, idempotencyKey: 'submit-2' }),
    });
    assert.equal(again.result.status, 'fast_track_eligible');
    assert.equal(again.result.approved, true);
    assert.equal(createProposalStore({ path: file }).snapshot().state.zeroBudgetPolicy.active, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the load/save port persists a whole state and rejects a stale writer', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'state.json');
    const store = createProposalStore({ path: file });
    assert.equal(store.load(), null);

    const core = createProposalCore();
    core.recordMember({ memberId: 'M-100', displayName: 'Maya Chen', roles: [{ role: 'contributor' }], recordedBy: 'admin', at: T.records });
    const state = core.snapshot();

    const saved = store.save(state, { expectedRevision: 0, at: T.records });
    assert.equal(saved.revision, 1);
    assert.equal(saved.replayed, false);
    assert.deepEqual(store.load(), state);

    const replay = store.save(state, { expectedRevision: 0, at: T.records });
    assert.equal(replay.revision, 1, 'an identical retry replays instead of writing a second revision');
    assert.equal(replay.replayed, true);
    const raw = createLedger(file).snapshot();
    assert.equal(raw.revision, 1);
    assert.equal(raw.audit.length, 1);

    assert.throws(
      () => store.save(state, { at: T.records }),
      error => error.code === 'validation' && error.details.field === 'expectedRevision',
    );
    assert.throws(() => store.save(null, { expectedRevision: 1 }), error => error.code === 'validation');
    assert.throws(() => store.save({}, { expectedRevision: 1 }), error => error.code === 'corrupt_state');
    assert.equal(store.snapshot().revision, 1, 'only the first save committed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicit idempotency key cannot hide a changed state', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'state.json');
    const store = createProposalStore({ path: file });
    const core = createProposalCore();
    core.recordMember({ memberId: 'M-100', displayName: 'Maya Chen', roles: [{ role: 'contributor' }], recordedBy: 'admin', at: T.records });
    const state = core.snapshot();
    store.save(state, { expectedRevision: 0, at: T.records, idempotencyKey: 'save-1' });

    // The ledger replays on key/actor/action alone, so the key carries the state fingerprint too: a
    // changed state under the same explicit key is either written or rejected, never silently dropped.
    const changed = { ...state, counters: { proposal: 5 } };
    assert.throws(
      () => store.save(changed, { expectedRevision: 0, at: T.records, idempotencyKey: 'save-1' }),
      error => error.code === 'storage_conflict' && error.details.actualRevision === 1,
    );

    const written = store.save(changed, { expectedRevision: 1, at: T.records, idempotencyKey: 'save-1' });
    assert.equal(written.revision, 2);
    assert.equal(written.replayed, false);
    assert.equal(store.load().counters.proposal, 5);

    const again = store.save(changed, { expectedRevision: 1, at: T.records, idempotencyKey: 'save-1' });
    assert.equal(again.revision, 2, 'an identical retry of the changed state replays');
    assert.equal(again.replayed, true);
    assert.equal(createLedger(file).snapshot().revision, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the adapter validates inputs and never persists a rejected action', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'state.json');
    const store = createProposalStore({ path: file });

    assert.throws(() => createProposalStore(), error => error.code === 'validation');
    assert.throws(() => createProposalStore({}), error => error.code === 'validation' && error.details.field === 'path');
    assert.throws(() => createProposalStore({ ledger: {} }), error => error.code === 'validation' && error.details.field === 'ledger');

    assert.throws(
      () => store.transact({ action: 'create_draft', at: T.draft, run() {} }),
      error => error.code === 'validation' && error.details.field === 'idempotencyKey',
    );
    assert.throws(
      () => store.transact({ action: 'create_draft', at: 'yesterday', idempotencyKey: 'k', run() {} }),
      error => error.code === 'validation' && error.details.field === 'at',
    );
    assert.throws(
      () => store.transact({ at: T.draft, idempotencyKey: 'k', run() {} }),
      error => error.code === 'validation' && error.details.field === 'action',
    );
    assert.throws(
      () => store.transact({ action: 'create_draft', at: T.draft, idempotencyKey: 'k' }),
      error => error.code === 'validation' && error.details.field === 'run',
    );
    assert.throws(
      () => store.transact({ action: 'create_draft', at: T.draft, idempotencyKey: 'k', expectedRevision: -1, run() {} }),
      error => error.code === 'validation' && error.details.field === 'expectedRevision',
    );
    assert.throws(
      () => store.transact({ action: 'create_draft', at: T.draft, idempotencyKey: 'k', expectedRevision: 1, run() {} }),
      error => error.code === 'storage_conflict',
    );

    assert.throws(
      () =>
        store.transact({
          action: 'record_member',
          at: T.records,
          idempotencyKey: 'bad-member',
          expectedRevision: 0,
          run: core => core.recordMember({ memberId: 'M-100', roles: [], recordedBy: 'admin', at: 'not-a-timestamp' }),
        }),
      error =>
        error.code === 'proposal_action_failed' &&
        /must be an ISO timestamp/.test(error.message) &&
        error.cause instanceof Error,
    );

    assert.throws(
      () => store.transact({ action: 'create_draft', at: T.draft, idempotencyKey: 'bad-result', expectedRevision: 0, run: () => () => {} }),
      error => error.code === 'validation' && /structured-cloneable/.test(error.message),
    );

    assert.equal(store.snapshot().revision, 0, 'no rejected transaction moved the revision');
    assert.equal(createLedger(file).snapshot().revision, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the proposal slot stays independent of other modules in the same ledger', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'state.json');
    const ledger = createLedger(file);
    const store = createProposalStore({ ledger });
    recordMembership(store, { expectedRevision: 0 });

    // Another module owns its own slot in the same file (activities.ts uses `reinOperations`).
    ledger.transact({
      key: 'activities:1',
      actor: 'operations-core',
      action: 'persist',
      at: T.records,
      apply(records) {
        records.reinOperations = { sequence: 1, activity: 'activity-1' };
      },
    });

    assert.equal(store.snapshot().revision, 1, 'another slot does not move the proposal revision');
    assert.deepEqual(store.snapshot().state.proposals, {});

    const raw = createLedger(file).snapshot();
    assert.deepEqual(Object.keys(raw.records).sort(), [PROPOSAL_STORE_SLOT, 'reinOperations'].sort());
    assert.deepEqual(raw.records.reinOperations, { sequence: 1, activity: 'activity-1' });
    assert.equal(raw.revision, 2);

    const restarted = createProposalStore({ path: file });
    assert.equal(restarted.snapshot().revision, 1);
    assert.equal(Object.keys(restarted.snapshot().state.members).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt or foreign ledger file fails loudly instead of hydrating a broken core', () => {
  const dir = tempDir();
  try {
    const truncated = join(dir, 'truncated.json');
    writeFileSync(truncated, '{"revision": 1, "records": {');
    assert.throws(
      () => createProposalStore({ path: truncated }).snapshot(),
      error => error.code === 'corrupt_state' && /could not be read/.test(error.message),
    );

    const write = (name, records) => {
      const target = join(dir, name);
      writeFileSync(target, JSON.stringify({ revision: 1, records, receipts: {}, audit: [] }));
      return target;
    };

    const noState = write('no-state.json', { [PROPOSAL_STORE_SLOT]: { revision: 1 } });
    assert.throws(
      () => createProposalStore({ path: noState }).snapshot(),
      error => error.code === 'corrupt_state' && /carries no proposal state/.test(error.message),
    );

    const partial = write('partial.json', { [PROPOSAL_STORE_SLOT]: { revision: 1, state: { members: {} } } });
    assert.throws(
      () => createProposalStore({ path: partial }).snapshot(),
      error => error.code === 'corrupt_state' && /identities/.test(error.message),
    );

    const badCounter = write('counter.json', {
      [PROPOSAL_STORE_SLOT]: { revision: 1, state: { ...createProposalCore().snapshot(), counters: { proposal: -1 } } },
    });
    assert.throws(
      () => createProposalStore({ path: badCounter }).snapshot(),
      error => error.code === 'corrupt_state' && /counter/.test(error.message),
    );

    assert.equal(hydrateProposalState(null), null);
    assert.equal(hydrateProposalState(undefined), null);
    assert.throws(() => openProposalCore({ members: {} }), error => error.code === 'corrupt_state');
    assert.deepEqual(openProposalCore(null).snapshot().proposals, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale ledger lock blocks the transaction instead of being stolen', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'state.json');
    mkdirSync(`${file}.lock`);
    const store = createProposalStore({ path: file });

    assert.throws(
      () => store.transact({ action: 'create_draft', at: T.draft, idempotencyKey: 'k', expectedRevision: 0, run: () => ({ ok: true }) }),
      error => error.code === 'storage_failure' && /EEXIST/.test(error.message),
    );
    assert.equal(store.snapshot().revision, 0);
    assert.ok(existsSync(`${file}.lock`), 'a lock the adapter did not create is left for an operator');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each committed transaction records its actor, action, time and revision', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'state.json');
    const store = createProposalStore({ path: file });
    const committed = store.transact({
      actor: 'ops-admin',
      action: 'record_membership',
      at: T.records,
      idempotencyKey: 'chat-message-9',
      expectedRevision: 0,
      run(core) {
        core.recordMember({
          memberId: 'M-100',
          displayName: 'Maya Chen',
          roles: [{ role: 'contributor' }],
          recordedBy: 'ops-admin',
          at: T.records,
        });
        return null;
      },
    });

    assert.equal(committed.result, null);
    assert.equal(committed.receipt.key, 'rein-proposals:chat-message-9');
    assert.equal(committed.receipt.actor, 'ops-admin');
    assert.equal(committed.receipt.action, 'record_membership');
    assert.equal(committed.receipt.at, T.records);
    assert.equal(committed.receipt.revision, 1);

    const raw = createLedger(file).snapshot();
    assert.deepEqual(raw.audit, [
      { key: 'rein-proposals:chat-message-9', actor: 'ops-admin', action: 'record_membership', at: T.records, revision: 1 },
    ]);
    assert.deepEqual(raw.receipts['rein-proposals:chat-message-9'], committed.receipt);
    assert.equal(raw.records[PROPOSAL_STORE_SLOT].revision, 1);
    assert.equal(raw.records[PROPOSAL_STORE_SLOT].state.members['M-100'].updatedBy, 'ops-admin');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
