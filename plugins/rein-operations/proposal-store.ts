// Durable transactional store for the deterministic proposal core (PRD R01-R09, US15, AC17).
//
// The adapter owns one slot in the local rehearsal ledger and persists the whole proposal-core state
// there: members, identity links, proposals with their version history, the proposal counter, the
// core's own receipts, the audit trail and the explicitly recorded zero-budget policy. One committed
// transaction moves records, audit entry and idempotency receipt to the same revision, so a restart
// reconstructs the same core instead of renumbering proposals or replaying an action.
//
// Honest limits:
// - `ledger.ts` is a single local JSON file guarded by an exclusive lock directory. That serializes
//   cooperating processes on one host. It is a rehearsal store, not a production database: there is
//   no multi-host consensus, and a stale lock directory needs operator inspection rather than silent
//   stealing, because stealing it could double an external effect.
// - Identity, eligibility, approval and policy stay in the deterministic core. This adapter never
//   invents a member, a role, an approval or an authorized zero-budget policy, and it cannot switch a
//   proposed default on.
// - A persisted state is reconstructed, never trusted. Malformed JSON, a foreign slot shape or a
//   truncated write raises ProposalStoreError instead of building a core that throws later.
// - Nothing here talks to a chat platform, a website or a payment provider. Those adapters remain
//   pending, so this module proves local durability only.

import { createHash } from 'node:crypto';
import { createLedger } from './ledger.ts';
import { createProposalCore, createState } from './proposals.ts';

export const PROPOSAL_STORE_SLOT = 'reinProposals';
export const PROPOSAL_STORE_KEY = 'rein-proposals';
export const PROPOSAL_STORE_ACTOR = 'rein-operations';

// The ledger is used through this port. `ledger.ts` supplies the default implementation, but the
// store only depends on the two methods below, so that file can move without touching this module.
export interface ProposalLedgerPort {
  snapshot: () => { records?: Record<string, unknown> } | undefined;
  transact: (input: {
    key: string;
    actor: string;
    action: string;
    at: string;
    apply: (records: Record<string, any>) => unknown;
  }) => { key: string; actor: string; action: string; at: string; revision: number; result: any };
}

export class ProposalStoreError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ProposalStoreError';
    this.code = code;
    this.details = details;
  }
}

const isPlainObject = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const clone = (value: any) => structuredClone(value);

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProposalStoreError('validation', `${field} must be a non-empty string`, { field });
  }
  return value.trim();
}

function timestamp(value: unknown, field: string): string {
  const iso = text(value, field);
  if (!Number.isFinite(Date.parse(iso))) {
    throw new ProposalStoreError('validation', `${field} must be a timestamp`, { field });
  }
  return iso;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ProposalStoreError('validation', `${field} must be a non-negative integer`, { field });
  }
  return value as number;
}

// A persisted state must carry every collection the core reads. Without this check a truncated file
// would hydrate into a core that throws somewhere later, after the caller already trusted the read.
export function hydrateProposalState(value: unknown) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) {
    throw new ProposalStoreError('corrupt_state', 'persisted proposal state is not an object', {
      received: Array.isArray(value) ? 'array' : typeof value,
    });
  }
  for (const field of ['members', 'identities', 'proposals', 'receipts']) {
    if (!isPlainObject(value[field])) {
      throw new ProposalStoreError('corrupt_state', `persisted proposal state has no ${field} collection`, { field });
    }
  }
  if (!Array.isArray(value.audit)) {
    throw new ProposalStoreError('corrupt_state', 'persisted proposal state has no audit trail', { field: 'audit' });
  }
  if (!isPlainObject(value.counters) || !Number.isInteger(value.counters.proposal) || value.counters.proposal < 0) {
    throw new ProposalStoreError('corrupt_state', 'persisted proposal counter is not a non-negative integer', {
      field: 'counters.proposal',
    });
  }
  if (value.zeroBudgetPolicy !== null && !isPlainObject(value.zeroBudgetPolicy)) {
    throw new ProposalStoreError('corrupt_state', 'persisted zero-budget policy is neither null nor an object', {
      field: 'zeroBudgetPolicy',
    });
  }
  return clone(value);
}

// Restart recovery entry point: rebuild a working core from a persisted state, or from empty.
export function openProposalCore(value: unknown) {
  const state = hydrateProposalState(value);
  return createProposalCore(state ?? createState());
}

export function createProposalStore(options: {
  path?: string;
  ledger?: ProposalLedgerPort;
  slot?: string;
  key?: string;
  actor?: string;
}) {
  if (!isPlainObject(options)) {
    throw new ProposalStoreError('validation', 'createProposalStore requires an options object');
  }
  const slot = text(options.slot ?? PROPOSAL_STORE_SLOT, 'slot');
  const key = text(options.key ?? PROPOSAL_STORE_KEY, 'key');
  const defaultActor = text(options.actor ?? PROPOSAL_STORE_ACTOR, 'actor');
  if (options.ledger && (typeof options.ledger.transact !== 'function' || typeof options.ledger.snapshot !== 'function')) {
    throw new ProposalStoreError('validation', 'ledger must expose snapshot() and transact()', { field: 'ledger' });
  }
  const ledger: ProposalLedgerPort = options.ledger ?? createLedger(text(options.path, 'path'));

  const readRecords = (): Record<string, any> => {
    let records: unknown;
    try {
      records = ledger.snapshot()?.records;
    } catch (error) {
      throw new ProposalStoreError('corrupt_state', `the ledger file could not be read: ${describe(error)}`, {
        cause: describe(error),
      });
    }
    if (records === undefined || records === null) return {};
    if (!isPlainObject(records)) {
      throw new ProposalStoreError('corrupt_state', 'the ledger records are not an object', { field: 'records' });
    }
    return records;
  };

  const readSlot = (records: Record<string, any>) => {
    const entry = records[slot];
    if (entry === undefined || entry === null) return { revision: 0, state: null as any };
    if (!isPlainObject(entry)) {
      throw new ProposalStoreError('corrupt_state', `ledger slot ${slot} is not an object`, { slot });
    }
    const current = nonNegativeInteger(entry.revision, `ledger slot ${slot} revision`);
    const state = hydrateProposalState(entry.state);
    if (!state) {
      throw new ProposalStoreError('corrupt_state', `ledger slot ${slot} carries no proposal state`, { slot });
    }
    return { revision: current, state };
  };

  const snapshot = () => {
    const { revision, state } = readSlot(readRecords());
    return { revision, state };
  };

  // Port-compatible read for callers that only need the state (see activities.ts createLedgerStore).
  const load = () => snapshot().state;

  const commit = ({
    actor,
    action,
    at,
    idempotencyKey,
    expectedRevision,
    produce,
  }: {
    actor?: string;
    action: string;
    at: string;
    idempotencyKey: string;
    expectedRevision?: number | null;
    produce: (current: { revision: number; state: any }) => { state: unknown; result?: unknown };
  }) => {
    const actorText = text(actor ?? defaultActor, 'actor');
    const actionText = text(action, 'action');
    const atText = timestamp(at, 'at');
    const keyText = text(idempotencyKey, 'idempotencyKey');
    if (typeof produce !== 'function') {
      throw new ProposalStoreError('validation', 'produce must be a function', { field: 'produce' });
    }
    if (expectedRevision !== null && expectedRevision !== undefined) {
      nonNegativeInteger(expectedRevision, 'expectedRevision');
    }

    // `ledger.transact` replays a stored receipt for the same key/actor/action without inspecting the
    // payload, so this flag is the only reliable way to tell a replay from a fresh commit.
    let applied = false;
    let receipt: any;
    try {
      receipt = ledger.transact({
        key: `${key}:${keyText}`,
        actor: actorText,
        action: actionText,
        at: atText,
        apply(records) {
          applied = true;
          const current = readSlot(records);
          // Optimistic rejection happens before any write: apply throwing leaves the ledger file,
          // its revision and its receipts untouched, so a retry starts from a fresh read.
          if (expectedRevision !== null && expectedRevision !== undefined && expectedRevision !== current.revision) {
            throw new ProposalStoreError('storage_conflict', 'proposal state changed in another transaction; reload before retrying', {
              slot,
              expectedRevision,
              actualRevision: current.revision,
            });
          }
          let produced: { state: unknown; result?: unknown };
          try {
            produced = produce({ revision: current.revision, state: current.state });
          } catch (error) {
            if (error instanceof ProposalStoreError) throw error;
            // A domain rule rejected the action. Keep the original message and error instead of
            // reporting a storage failure that never happened.
            const rejected = new ProposalStoreError('proposal_action_failed', describe(error), { slot, action: actionText });
            rejected.cause = error;
            throw rejected;
          }
          const nextState = hydrateProposalState(produced?.state);
          if (!nextState) {
            throw new ProposalStoreError('validation', 'a transaction must produce a proposal state', { slot });
          }
          let result: unknown;
          try {
            result = clone(produced.result);
          } catch {
            throw new ProposalStoreError('validation', 'a transaction result must be structured-cloneable', { slot });
          }
          const nextRevision = current.revision + 1;
          records[slot] = { revision: nextRevision, state: nextState };
          return { revision: nextRevision, result };
        },
      });
    } catch (error) {
      if (error instanceof ProposalStoreError) throw error;
      const failed = new ProposalStoreError('storage_failure', `ledger transaction failed: ${describe(error)}`, {
        slot,
        cause: describe(error),
      });
      failed.cause = error;
      throw failed;
    }

    const stored = receipt?.result;
    return { revision: stored?.revision as number, result: stored?.result as unknown, receipt, replayed: !applied };
  };

  // Transactional read-modify-write.
  //
  // Exact key semantics, because the ledger replays on key/actor/action alone and never compares the
  // payload:
  // - One key must identify one logical action (a chat message id works). Repeating the call with the
  //   same actor and action returns the stored receipt without running `run` again, which is what
  //   makes a retry after a crash safe. `replayed` reports which of the two happened.
  // - The same key with a different actor or a different action fails loudly.
  // - The same key, same action, different arguments returns the first result. That matches the
  //   proposal core's own `idempotent` helper; a caller that must tell two requests apart has to
  //   derive the key from the request instead of reusing one bare label.
  // - `expectedRevision` is optional. Leave it null for a read-modify-write inside the lock; pass the
  //   revision you last read when a stale writer must be rejected.
  const transact = ({
    action,
    at,
    idempotencyKey,
    expectedRevision = null,
    actor = defaultActor,
    run,
  }: {
    action: string;
    at: string;
    idempotencyKey: string;
    expectedRevision?: number | null;
    actor?: string;
    run: (core: ReturnType<typeof createProposalCore>, current: { revision: number; state: any }) => unknown;
  }) => {
    if (typeof run !== 'function') {
      throw new ProposalStoreError('validation', 'run must be a function', { field: 'run' });
    }
    return commit({
      actor,
      action,
      at,
      idempotencyKey,
      expectedRevision,
      produce: ({ revision, state }) => {
        const core = openProposalCore(state);
        const result = run(core, { revision, state: state === null ? null : clone(state) });
        return { state: core.snapshot(), result };
      },
    });
  };

  // Whole-state write for callers that already hold a core snapshot.
  //
  // Exact key semantics: the ledger key always carries a fingerprint of the state being written, so
  // the same `idempotencyKey` with a different state can never silently replay the earlier receipt.
  // An identical retry replays (that is the retry-safety property); a changed state is written when
  // the revision is current and rejected with storage_conflict when it is stale. `expectedRevision`
  // is required here because this call replaces the slot instead of reading it first.
  const save = (
    state: unknown,
    {
      actor = defaultActor,
      action = 'persist_proposal_state',
      at = new Date().toISOString(),
      expectedRevision,
      idempotencyKey,
    }: {
      actor?: string;
      action?: string;
      at?: string;
      expectedRevision: number;
      idempotencyKey?: string;
    } = {} as any,
  ) => {
    const nextState = hydrateProposalState(state);
    if (!nextState) {
      throw new ProposalStoreError('validation', 'save requires a proposal state object', { field: 'state' });
    }
    const expected = nonNegativeInteger(expectedRevision, 'expectedRevision');
    const atText = timestamp(at, 'at');
    const scope = text(idempotencyKey ?? `derived:${expected}:${action}`, 'idempotencyKey');
    const committed = commit({
      actor,
      action,
      at: atText,
      idempotencyKey: `${scope}:${fingerprint(nextState)}`,
      expectedRevision: expected,
      produce: () => ({ state: nextState, result: null }),
    });
    return { revision: committed.revision, state: nextState, replayed: committed.replayed };
  };

  return { slot, key, ledger, snapshot, load, transact, save };
}
