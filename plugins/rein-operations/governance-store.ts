// Durable transactional store for the deterministic governance engine (PRD R10-R16, AC05-AC08,
// AC17).
//
// The adapter owns one slot in the local rehearsal ledger and persists frozen rounds there: the
// frozen snapshot, the ballots, the recusals, a per-round optimistic revision and a store-level
// audit trail. One committed transaction moves the round records, the audit entry and the
// idempotency receipt to the same ledger revision, so a restart reconstructs the same rounds
// instead of renumbering ballots or replaying an action.
//
// What this module deliberately does not do:
// - It never calls `prdR14DiscussionDefaultRules()`. Counting rules, weights, deadlines, currency
//   and budget availability come from the caller's explicit, approved input. A round without
//   complete rules is refused by the engine, not filled in here.
// - It never reserves, allocates, pays or promises money. `tallyRound` reports the engine's
//   bookkeeping decision only; there is no payment, reservation or receipt of funds.
// - It never verifies identity. The trusted caller supplies the verified requester id, the store
//   records it, and it refuses a ballot whose member id differs from that requester (AC06).
//
// Honest limits:
// - `ledger.ts` is one local JSON file guarded by an exclusive lock directory. Concurrent calls
//   fail on lock contention and must be retried by the caller; it is not a production database: there
//   is no multi-host consensus, and a stale lock directory needs operator inspection rather than
//   silent stealing.
// - A persisted slot is reconstructed, never trusted. Malformed JSON, a foreign schema or a
//   truncated write raises GovernanceStoreError instead of building a round the engine cannot read.
// - Nothing here talks to a chat platform, a website or a payment provider. Those adapters remain
//   pending, so this module proves local durability only.

import { createLedger } from './ledger.ts';
import {
  createRound,
  castBallot as castBallotInEngine,
  declareRecusal as declareRecusalInEngine,
  tallyRound as tallyRoundInEngine,
  tallyProposal as tallyProposalInEngine,
  GovernanceError,
} from './governance.ts';
import type { RoundInput, RoundState, RoundResult, ProposalTally } from './governance.ts';

export const GOVERNANCE_STORE_SLOT = 'reinGovernance';
export const GOVERNANCE_STORE_KEY = 'rein-governance';
export const GOVERNANCE_STORE_ACTOR = 'rein-operations';
export const GOVERNANCE_STORE_SCHEMA = 'rein-governance-store/1';

export const GOVERNANCE_STORE_ACTIONS = ['open_round', 'cast_ballot', 'declare_recusal'] as const;
export const GOVERNANCE_AUDIT_OUTCOMES = ['accepted', 'duplicate_suppressed', 'rejected'] as const;

export type GovernanceStoreAction = (typeof GOVERNANCE_STORE_ACTIONS)[number];
export type GovernanceAuditOutcome = (typeof GOVERNANCE_AUDIT_OUTCOMES)[number];

// The ledger is used through this port. `ledger.ts` supplies the default implementation, but the
// store only depends on the two methods below, so that file can move without touching this module.
export interface GovernanceLedgerPort {
  snapshot: () => { records?: Record<string, unknown>; receipts?: Record<string, any> } | undefined;
  transact: (input: {
    key: string;
    actor: string;
    action: string;
    at: string;
    apply: (records: Record<string, any>) => unknown;
  }) => { key: string; actor: string; action: string; at: string; revision: number; result: any };
}

export interface GovernanceRoundApproval {
  /** Reference to the recorded authorization that opened this round. Required, never defaulted. */
  reference: string;
  /** The person or body that approved the round input. Required, never defaulted. */
  approvedBy: string;
}

export interface GovernanceRoundEntry {
  roundId: string;
  /** Per-round optimistic revision. It moves only when the round state actually changes. */
  revision: number;
  createdAt: string;
  createdBy: string;
  approval: { reference: string; approvedBy: string; at: string };
  state: RoundState;
}

export interface GovernanceAuditEntry {
  sequence: number;
  roundId: string;
  action: GovernanceStoreAction;
  outcome: GovernanceAuditOutcome;
  /** Why an attempt was rejected or suppressed, or null when it was accepted. */
  reason: string | null;
  at: string;
  /** Trusted requester id supplied by the caller, never read from a model argument. */
  actor: string;
  /** Trusted requester context recorded verbatim for audit, or null. */
  context: Record<string, unknown> | null;
  proposalId: string | null;
  memberId: string | null;
  choice: string | null;
  ballotSequence: number | null;
  replacedSequence: number | null;
  /** The engine-level duplicate-suppression key, if the caller supplied one. */
  ballotKey: string | null;
  /** The round revision after this entry. Unchanged for rejected and suppressed attempts. */
  roundRevision: number;
}

interface GovernanceSlotData {
  schema: string;
  rounds: Record<string, GovernanceRoundEntry>;
  audit: GovernanceAuditEntry[];
}

export class GovernanceStoreError extends Error {
  code: string;
  details: Record<string, unknown>;
  cause?: unknown;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GovernanceStoreError';
    this.code = code;
    this.details = details;
  }
}

const isPlainObject = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const clone = (value: any) => structuredClone(value);

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

const corrupt = (message: string, details: Record<string, unknown> = {}) =>
  new GovernanceStoreError('corrupt_state', message, details);

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GovernanceStoreError('validation', `${field} must be a non-empty string`, { field });
  }
  return value.trim();
}

function timestamp(value: unknown, field: string): string {
  const iso = text(value, field);
  if (!Number.isFinite(Date.parse(iso))) {
    throw new GovernanceStoreError('validation', `${field} must be a timestamp`, { field });
  }
  return iso;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new GovernanceStoreError('validation', `${field} must be a non-negative integer`, { field });
  }
  return value as number;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, field);
}

function optionalContext(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) {
    throw new GovernanceStoreError('validation', 'context must be an object when supplied', { field: 'context' });
  }
  try {
    return clone(value);
  } catch {
    throw new GovernanceStoreError('validation', 'context must be structured-cloneable', { field: 'context' });
  }
}

function requireNullableInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  return nonNegativeInteger(value, field);
}

// A persisted round state must carry every collection the engine reads. Without this check a
// truncated file would hydrate into a state that throws somewhere later, after the caller already
// trusted the read.
function validateRoundState(value: unknown, roundId: string): RoundState {
  if (!isPlainObject(value)) throw corrupt(`round ${roundId} state is not an object`, { roundId });
  const snapshot = value.snapshot;
  if (!isPlainObject(snapshot)) throw corrupt(`round ${roundId} has no frozen snapshot`, { roundId });
  if (snapshot.roundId !== roundId) {
    throw corrupt(`round ${roundId} snapshot belongs to another round`, { roundId, snapshotRoundId: snapshot.roundId });
  }
  if (typeof snapshot.rulesVersion !== 'string' || !snapshot.rulesVersion.trim()) {
    throw corrupt(`round ${roundId} snapshot has no rules version`, { roundId });
  }
  if (!isPlainObject(snapshot.rules)) throw corrupt(`round ${roundId} snapshot has no rules`, { roundId });
  for (const field of ['opensAt', 'closesAt']) {
    if (typeof snapshot[field] !== 'string' || !Number.isFinite(Date.parse(snapshot[field]))) {
      throw corrupt(`round ${roundId} snapshot has no valid ${field}`, { roundId, field });
    }
  }
  if (typeof snapshot.currency !== 'string' || !snapshot.currency.trim()) {
    throw corrupt(`round ${roundId} snapshot has no currency`, { roundId });
  }
  for (const field of ['roster', 'proposals', 'warnings']) {
    if (!Array.isArray(snapshot[field])) {
      throw corrupt(`round ${roundId} snapshot has no ${field} collection`, { roundId, field });
    }
  }
  for (const field of ['ballots', 'recusals']) {
    if (!Array.isArray(value[field])) {
      throw corrupt(`round ${roundId} has no ${field} collection`, { roundId, field });
    }
  }
  return clone(value) as RoundState;
}

function hydrateRoundEntry(roundId: string, value: unknown): GovernanceRoundEntry {
  if (!isPlainObject(value)) throw corrupt(`round ${roundId} entry is not an object`, { roundId });
  if (value.roundId !== roundId) {
    throw corrupt(`round ${roundId} entry is stored under another id`, { roundId, storedRoundId: value.roundId });
  }
  const revision = nonNegativeInteger(value.revision, `round ${roundId} revision`);
  const createdAt = timestamp(value.createdAt, `round ${roundId} createdAt`);
  const createdBy = text(value.createdBy, `round ${roundId} createdBy`);
  if (!isPlainObject(value.approval)) throw corrupt(`round ${roundId} has no recorded approval`, { roundId });
  const approval = {
    reference: text(value.approval.reference, `round ${roundId} approval.reference`),
    approvedBy: text(value.approval.approvedBy, `round ${roundId} approval.approvedBy`),
    at: timestamp(value.approval.at, `round ${roundId} approval.at`),
  };
  return { roundId, revision, createdAt, createdBy, approval, state: validateRoundState(value.state, roundId) };
}

function hydrateAuditEntry(value: unknown, index: number): GovernanceAuditEntry {
  const where = `audit[${index}]`;
  if (!isPlainObject(value)) throw corrupt(`${where} is not an object`);
  const sequence = nonNegativeInteger(value.sequence, `${where}.sequence`);
  if (sequence !== index + 1) throw corrupt(`${where} is out of sequence`, { expected: index + 1, sequence });
  if (!GOVERNANCE_STORE_ACTIONS.includes(value.action)) {
    throw corrupt(`${where} has an unknown action`, { action: value.action });
  }
  if (!GOVERNANCE_AUDIT_OUTCOMES.includes(value.outcome)) {
    throw corrupt(`${where} has an unknown outcome`, { outcome: value.outcome });
  }
  if (value.context !== null && !isPlainObject(value.context)) {
    throw corrupt(`${where} has a non-object context`, { context: typeof value.context });
  }
  return {
    sequence,
    roundId: text(value.roundId, `${where}.roundId`),
    action: value.action,
    outcome: value.outcome,
    reason: optionalText(value.reason, `${where}.reason`),
    at: timestamp(value.at, `${where}.at`),
    actor: text(value.actor, `${where}.actor`),
    context: value.context === null ? null : clone(value.context),
    proposalId: optionalText(value.proposalId, `${where}.proposalId`),
    memberId: optionalText(value.memberId, `${where}.memberId`),
    choice: optionalText(value.choice, `${where}.choice`),
    ballotSequence: requireNullableInteger(value.ballotSequence, `${where}.ballotSequence`),
    replacedSequence: requireNullableInteger(value.replacedSequence, `${where}.replacedSequence`),
    ballotKey: optionalText(value.ballotKey, `${where}.ballotKey`),
    roundRevision: nonNegativeInteger(value.roundRevision, `${where}.roundRevision`),
  };
}

/** Restart-recovery entry point: validate and detach a persisted slot, or return null when empty. */
export function hydrateGovernanceSlot(value: unknown): GovernanceSlotData | null {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) {
    throw corrupt('persisted governance slot is not an object', {
      received: Array.isArray(value) ? 'array' : typeof value,
    });
  }
  if (value.schema !== GOVERNANCE_STORE_SCHEMA) {
    throw corrupt('persisted governance slot has an unexpected schema', { schema: value.schema });
  }
  if (!isPlainObject(value.rounds)) throw corrupt('persisted governance slot has no rounds collection', { field: 'rounds' });
  if (!Array.isArray(value.audit)) throw corrupt('persisted governance slot has no audit trail', { field: 'audit' });
  const rounds: Record<string, GovernanceRoundEntry> = {};
  for (const [roundId, entry] of Object.entries(value.rounds)) {
    rounds[roundId] = hydrateRoundEntry(roundId, entry);
  }
  const audit = value.audit.map((entry, index) => hydrateAuditEntry(entry, index));
  return { schema: GOVERNANCE_STORE_SCHEMA, rounds, audit };
}

export function createGovernanceStore(options: {
  path?: string;
  ledger?: GovernanceLedgerPort;
  slot?: string;
  key?: string;
  actor?: string;
} = {}) {
  if (!isPlainObject(options)) {
    throw new GovernanceStoreError('validation', 'createGovernanceStore requires an options object');
  }
  const slot = text(options.slot ?? GOVERNANCE_STORE_SLOT, 'slot');
  const key = text(options.key ?? GOVERNANCE_STORE_KEY, 'key');
  const defaultActor = text(options.actor ?? GOVERNANCE_STORE_ACTOR, 'actor');
  if (options.ledger && (typeof options.ledger.transact !== 'function' || typeof options.ledger.snapshot !== 'function')) {
    throw new GovernanceStoreError('validation', 'ledger must expose snapshot() and transact()', { field: 'ledger' });
  }
  const ledger: GovernanceLedgerPort = options.ledger ?? createLedger(text(options.path, 'path'));

  const emptyData = (): GovernanceSlotData => ({ schema: GOVERNANCE_STORE_SCHEMA, rounds: {}, audit: [] });

  const readRecords = (): Record<string, any> => {
    let records: unknown;
    try {
      records = ledger.snapshot()?.records;
    } catch (error) {
      throw corrupt(`the ledger file could not be read: ${describe(error)}`, { cause: describe(error) });
    }
    if (records === undefined || records === null) return {};
    if (!isPlainObject(records)) throw corrupt('the ledger records are not an object', { field: 'records' });
    return records;
  };

  const readSlot = (records: Record<string, any>) => {
    const entry = records[slot];
    if (entry === undefined || entry === null) return { revision: 0, data: emptyData() };
    if (!isPlainObject(entry)) throw corrupt(`ledger slot ${slot} is not an object`, { slot });
    const revision = nonNegativeInteger(entry.revision, `ledger slot ${slot} revision`);
    const data = hydrateGovernanceSlot(entry);
    if (!data) throw corrupt(`ledger slot ${slot} carries no governance data`, { slot });
    return { revision, data };
  };

  const readRound = (roundId: string) => {
    const { data } = readSlot(readRecords());
    const entry = data.rounds[roundId];
    if (!entry) {
      throw new GovernanceStoreError('round_not_found', `round ${roundId} is not in this store`, { roundId });
    }
    return entry;
  };

  const appendAudit = (
    audit: GovernanceAuditEntry[],
    entry: Omit<GovernanceAuditEntry, 'sequence'>,
  ): GovernanceAuditEntry[] => [...audit, { sequence: audit.length + 1, ...entry }];

  // Shared transaction envelope. `produce` receives the current slot and returns the next slot data
  // plus the caller-visible result. Throwing from `produce` leaves the ledger file, its revision and
  // its receipts untouched, so a retry starts from a fresh read.
  const commit = ({
    actor,
    action,
    roundId,
    at,
    idempotencyKey,
    produce,
  }: {
    actor: string;
    action: GovernanceStoreAction;
    roundId: string;
    at: string;
    idempotencyKey: string;
    produce: (current: { revision: number; data: GovernanceSlotData }) => { data: GovernanceSlotData; result: unknown };
  }) => {
    const actorText = text(actor ?? defaultActor, 'actor');
    const actionText = text(action, 'action');
    const scopedRoundId = text(roundId, 'roundId');
    const atText = timestamp(at, 'at');
    const keyText = text(idempotencyKey, 'idempotencyKey');
    const fullKey = `${key}:${JSON.stringify([scopedRoundId, keyText])}`;

    // Deterministic idempotency-conflict detection that does not depend on the ledger's message
    // text: one key must identify one actor and one action.
    let prior: any;
    try {
      prior = ledger.snapshot()?.receipts?.[fullKey];
    } catch (error) {
      throw corrupt(`the ledger file could not be read: ${describe(error)}`, { cause: describe(error) });
    }
    if (prior && (prior.actor !== actorText || prior.action !== actionText)) {
      throw new GovernanceStoreError(
        'idempotency_conflict',
        `idempotency key ${keyText} was already used for another actor or action`,
        { idempotencyKey: keyText, existingActor: prior.actor, existingAction: prior.action },
      );
    }

    // `ledger.transact` replays a stored receipt for the same key/actor/action without inspecting
    // the payload, so this flag is the only reliable way to tell a replay from a fresh commit.
    let applied = false;
    let receipt: any;
    try {
      receipt = ledger.transact({
        key: fullKey,
        actor: actorText,
        action: actionText,
        at: atText,
        apply(records: Record<string, any>) {
          applied = true;
          const current = readSlot(records);
          let produced: { data: GovernanceSlotData; result: unknown };
          try {
            produced = produce(current);
          } catch (error) {
            if (error instanceof GovernanceStoreError) throw error;
            if (error instanceof GovernanceError) {
              throw new GovernanceStoreError('governance_rejected', error.message, {
                slot,
                action: actionText,
                governanceCode: error.code,
              });
            }
            const failed = new GovernanceStoreError('action_failed', describe(error), { slot, action: actionText });
            failed.cause = error;
            throw failed;
          }
          const nextRevision = current.revision + 1;
          records[slot] = { revision: nextRevision, ...produced.data };
          return { revision: nextRevision, result: clone(produced.result) };
        },
      });
    } catch (error) {
      if (error instanceof GovernanceStoreError) throw error;
      if ((error as { code?: unknown })?.code === 'idempotency_conflict') {
        throw new GovernanceStoreError('idempotency_conflict', describe(error), { slot, roundId: scopedRoundId, idempotencyKey: keyText });
      }
      const failed = new GovernanceStoreError('storage_failure', `ledger transaction failed: ${describe(error)}`, {
        slot,
        cause: describe(error),
      });
      failed.cause = error;
      throw failed;
    }

    const stored = receipt?.result;
    return { revision: stored?.revision as number, result: stored?.result, replayed: !applied };
  };

  const checkExpectedRevision = (entry: GovernanceRoundEntry, expectedRevision: number | null | undefined) => {
    if (expectedRevision === null || expectedRevision === undefined) return;
    const expected = nonNegativeInteger(expectedRevision, 'expectedRevision');
    if (expected !== entry.revision) {
      throw new GovernanceStoreError(
        'storage_conflict',
        'round state changed in another transaction; reload before retrying',
        { roundId: entry.roundId, expectedRevision: expected, actualRevision: entry.revision },
      );
    }
  };

  const snapshot = () => {
    const { revision, data } = readSlot(readRecords());
    return { revision, rounds: clone(data.rounds), audit: clone(data.audit) };
  };

  const listRounds = () => {
    const { data } = readSlot(readRecords());
    return Object.values(data.rounds)
      .map((entry) => ({
        roundId: entry.roundId,
        revision: entry.revision,
        rulesVersion: entry.state.snapshot.rulesVersion,
        createdAt: entry.createdAt,
        createdBy: entry.createdBy,
        opensAt: entry.state.snapshot.opensAt,
        closesAt: entry.state.snapshot.closesAt,
        currency: entry.state.snapshot.currency,
        proposalCount: entry.state.snapshot.proposals.length,
        ballotCount: entry.state.ballots.length,
        recusalCount: entry.state.recusals.length,
      }))
      .sort((left, right) => (left.createdAt === right.createdAt
        ? (left.roundId < right.roundId ? -1 : 1)
        : (left.createdAt < right.createdAt ? -1 : 1)));
  };

  // R10/AC05 read: the frozen versions, rules, roster, weights and deadlines for one round.
  const getRound = (input: { roundId: string }) => {
    const roundId = text(input?.roundId, 'roundId');
    const entry = readRound(roundId);
    return clone({
      roundId: entry.roundId,
      revision: entry.revision,
      createdAt: entry.createdAt,
      createdBy: entry.createdBy,
      approval: entry.approval,
      state: entry.state,
    });
  };

  // R16 read: valid and invalid attempts, including rejected ones, with the trusted actor context.
  const readAudit = (input: { roundId?: string } = {}) => {
    const roundId = input?.roundId === undefined ? null : text(input.roundId, 'roundId');
    const { data } = readSlot(readRecords());
    const entries = roundId === null ? data.audit : data.audit.filter((entry) => entry.roundId === roundId);
    return clone(entries);
  };

  // Open one frozen round from explicitly approved input. The engine refuses incomplete rules, and
  // this store refuses a round with no recorded approval reference; neither is defaulted.
  const openRound = (input: {
    round: RoundInput;
    approval: GovernanceRoundApproval;
    actor?: string;
    at?: string;
    idempotencyKey: string;
    context?: Record<string, unknown> | null;
  }) => {
    if (!isPlainObject(input?.round)) {
      throw new GovernanceStoreError('validation', 'openRound requires a round input object', { field: 'round' });
    }
    const approvalReference = text(input?.approval?.reference, 'approval.reference');
    const approvedBy = text(input?.approval?.approvedBy, 'approval.approvedBy');
    const roundId = text(input.round.roundId, 'round.roundId');
    const actorText = text(input.actor ?? defaultActor, 'actor');
    const atText = timestamp(input.at ?? new Date().toISOString(), 'at');
    const context = optionalContext(input.context);

    const committed = commit({
      actor: actorText,
      action: 'open_round',
      roundId,
      at: atText,
      idempotencyKey: input.idempotencyKey,
      produce(current) {
        if (current.data.rounds[roundId]) {
          throw new GovernanceStoreError(
            'round_exists',
            `round ${roundId} is already frozen; open a new round instead of rewriting an active one`,
            { roundId },
          );
        }
        // The engine validates and deep-freezes the round. A missing or incomplete rules object
        // throws GovernanceError('rules_required'), which the envelope surfaces as
        // GovernanceStoreError('governance_rejected').
        const state = createRound({ ...input.round, roundId });
        const entry: GovernanceRoundEntry = {
          roundId,
          revision: 1,
          createdAt: atText,
          createdBy: actorText,
          approval: { reference: approvalReference, approvedBy, at: atText },
          state,
        };
        const audit = appendAudit(current.data.audit, {
          roundId,
          action: 'open_round',
          outcome: 'accepted',
          reason: null,
          at: atText,
          actor: actorText,
          context,
          proposalId: null,
          memberId: null,
          choice: null,
          ballotSequence: null,
          replacedSequence: null,
          ballotKey: null,
          roundRevision: 1,
        });
        return {
          data: { schema: GOVERNANCE_STORE_SCHEMA, rounds: { ...current.data.rounds, [roundId]: entry }, audit },
          result: {
            roundId,
            revision: 1,
            rulesVersion: state.snapshot.rulesVersion,
            approval: entry.approval,
            warnings: [...state.snapshot.warnings],
          },
        };
      },
    });
    return { ...committed.result, replayed: committed.replayed };
  };

  // Record one ballot, its replacement or its rejection.
  //
  // - Accepted: the round state and its revision advance together with the audit entry.
  // - Rejected (ineligible voter, recused member, late vote, disallowed replacement, actor mismatch,
  //   engine idempotency-key conflict): the audit entry is durable, the round state and its revision
  //   do not move, and the attempt is never counted. An unchanged state is never stored as an
  //   accepted ballot.
  // - Duplicate (the engine's own idempotency key already produced the same ballot): no state change,
  //   an audit entry marked `duplicate_suppressed`.
  const castBallot = (input: {
    roundId: string;
    ballot: { proposalId: string; memberId?: string | null; choice: string; castAt?: string; idempotencyKey?: string | null };
    actor?: string;
    at?: string;
    idempotencyKey: string;
    expectedRevision?: number | null;
    context?: Record<string, unknown> | null;
  }) => {
    const roundId = text(input?.roundId, 'roundId');
    if (!isPlainObject(input?.ballot)) {
      throw new GovernanceStoreError('validation', 'castBallot requires a ballot object', { field: 'ballot' });
    }
    const proposalId = text(input.ballot.proposalId, 'ballot.proposalId');
    const actorText = text(input.actor ?? defaultActor, 'actor');
    const atText = timestamp(input.at ?? new Date().toISOString(), 'at');
    const castAt = timestamp(input.ballot.castAt ?? atText, 'ballot.castAt');
    const context = optionalContext(input.context);
    // The trusted requester determines the voter. A ballot that names someone else is refused, and a
    // ballot that names nobody votes as the verified requester.
    const memberId = input.ballot.memberId === undefined || input.ballot.memberId === null
      ? actorText
      : text(input.ballot.memberId, 'ballot.memberId');
    const ballotKey = optionalText(input.ballot.idempotencyKey, 'ballot.idempotencyKey');

    const auditFor = (
      entry: GovernanceRoundEntry,
      outcome: GovernanceAuditOutcome,
      reason: string | null,
      extra: Partial<Omit<GovernanceAuditEntry, 'sequence'>> = {},
    ): Omit<GovernanceAuditEntry, 'sequence'> => ({
      roundId,
      action: 'cast_ballot',
      outcome,
      reason,
      at: atText,
      actor: actorText,
      context,
      proposalId,
      memberId,
      choice: typeof input.ballot.choice === 'string' ? input.ballot.choice : null,
      ballotSequence: null,
      replacedSequence: null,
      ballotKey,
      roundRevision: entry.revision,
      ...extra,
    });

    const committed = commit({
      actor: actorText,
      action: 'cast_ballot',
      roundId,
      at: atText,
      idempotencyKey: input.idempotencyKey,
      produce(current) {
        const entry = current.data.rounds[roundId];
        if (!entry) {
          throw new GovernanceStoreError('round_not_found', `round ${roundId} is not in this store`, { roundId });
        }
        checkExpectedRevision(entry, input.expectedRevision);

        if (memberId !== actorText) {
          const audit = appendAudit(current.data.audit, auditFor(entry, 'rejected', 'actor_mismatch'));
          return {
            data: { ...current.data, audit },
            result: { roundId, revision: entry.revision, accepted: false, duplicated: false, reason: 'actor_mismatch', ballot: null, replacedSequence: null },
          };
        }

        const outcome = castBallotInEngine(entry.state, {
          proposalId,
          memberId,
          choice: input.ballot.choice as any,
          castAt,
          ...(ballotKey === null ? {} : { idempotencyKey: ballotKey }),
        });

        if (!outcome.accepted) {
          const audit = appendAudit(current.data.audit, auditFor(entry, 'rejected', outcome.reason));
          return {
            data: { ...current.data, audit },
            result: { roundId, revision: entry.revision, accepted: false, duplicated: false, reason: outcome.reason, ballot: null, replacedSequence: null },
          };
        }

        if (outcome.duplicated) {
          const audit = appendAudit(current.data.audit, auditFor(entry, 'duplicate_suppressed', null, {
            ballotSequence: outcome.ballot?.sequence ?? null,
            replacedSequence: outcome.replacedSequence,
          }));
          return {
            data: { ...current.data, audit },
            result: {
              roundId,
              revision: entry.revision,
              accepted: true,
              duplicated: true,
              reason: null,
              ballot: clone(outcome.ballot),
              replacedSequence: outcome.replacedSequence,
            },
          };
        }

        const nextEntry: GovernanceRoundEntry = { ...entry, revision: entry.revision + 1, state: outcome.state };
        const audit = appendAudit(current.data.audit, auditFor(entry, 'accepted', null, {
          ballotSequence: outcome.ballot?.sequence ?? null,
          replacedSequence: outcome.replacedSequence,
          roundRevision: nextEntry.revision,
        }));
        return {
          data: { schema: GOVERNANCE_STORE_SCHEMA, rounds: { ...current.data.rounds, [roundId]: nextEntry }, audit },
          result: {
            roundId,
            revision: nextEntry.revision,
            accepted: true,
            duplicated: false,
            reason: null,
            ballot: clone(outcome.ballot),
            replacedSequence: outcome.replacedSequence,
          },
        };
      },
    });
    return { ...committed.result, replayed: committed.replayed };
  };

  // Declare a recusal. Accepted recusals advance the round revision; a rejected declaration is
  // audited without changing the round.
  const declareRecusal = (input: {
    roundId: string;
    recusal: { proposalId: string; memberId?: string | null; declaredAt?: string; reason: string };
    actor?: string;
    at?: string;
    idempotencyKey: string;
    expectedRevision?: number | null;
    context?: Record<string, unknown> | null;
  }) => {
    const roundId = text(input?.roundId, 'roundId');
    if (!isPlainObject(input?.recusal)) {
      throw new GovernanceStoreError('validation', 'declareRecusal requires a recusal object', { field: 'recusal' });
    }
    const proposalId = text(input.recusal.proposalId, 'recusal.proposalId');
    const reason = text(input.recusal.reason, 'recusal.reason');
    const actorText = text(input.actor ?? defaultActor, 'actor');
    const atText = timestamp(input.at ?? new Date().toISOString(), 'at');
    const declaredAt = timestamp(input.recusal.declaredAt ?? atText, 'recusal.declaredAt');
    const context = optionalContext(input.context);
    const memberId = input.recusal.memberId === undefined || input.recusal.memberId === null
      ? actorText
      : text(input.recusal.memberId, 'recusal.memberId');

    const auditFor = (
      entry: GovernanceRoundEntry,
      outcome: GovernanceAuditOutcome,
      outcomeReason: string | null,
      roundRevision: number,
    ): Omit<GovernanceAuditEntry, 'sequence'> => ({
      roundId,
      action: 'declare_recusal',
      outcome,
      reason: outcomeReason,
      at: atText,
      actor: actorText,
      context,
      proposalId,
      memberId,
      choice: null,
      ballotSequence: null,
      replacedSequence: null,
      ballotKey: null,
      roundRevision,
    });

    const committed = commit({
      actor: actorText,
      action: 'declare_recusal',
      roundId,
      at: atText,
      idempotencyKey: input.idempotencyKey,
      produce(current) {
        const entry = current.data.rounds[roundId];
        if (!entry) {
          throw new GovernanceStoreError('round_not_found', `round ${roundId} is not in this store`, { roundId });
        }
        checkExpectedRevision(entry, input.expectedRevision);

        if (memberId !== actorText) {
          const audit = appendAudit(current.data.audit, auditFor(entry, 'rejected', 'actor_mismatch', entry.revision));
          return {
            data: { ...current.data, audit },
            result: { roundId, revision: entry.revision, accepted: false, reason: 'actor_mismatch', recusal: null },
          };
        }

        const outcome = declareRecusalInEngine(entry.state, { proposalId, memberId, declaredAt, reason });
        if (!outcome.accepted) {
          const audit = appendAudit(current.data.audit, auditFor(entry, 'rejected', outcome.reason, entry.revision));
          return {
            data: { ...current.data, audit },
            result: { roundId, revision: entry.revision, accepted: false, reason: outcome.reason, recusal: null },
          };
        }

        const nextEntry: GovernanceRoundEntry = { ...entry, revision: entry.revision + 1, state: outcome.state };
        const audit = appendAudit(current.data.audit, auditFor(entry, 'accepted', null, nextEntry.revision));
        return {
          data: { schema: GOVERNANCE_STORE_SCHEMA, rounds: { ...current.data.rounds, [roundId]: nextEntry }, audit },
          result: { roundId, revision: nextEntry.revision, accepted: true, reason: null, recusal: clone(outcome.recusal) },
        };
      },
    });
    return { ...committed.result, replayed: committed.replayed };
  };

  // Counting reads. These never write, never reserve and never announce anything.
  const tallyRound = (input: { roundId: string }): RoundResult => {
    const roundId = text(input?.roundId, 'roundId');
    return tallyRoundInEngine(readRound(roundId).state);
  };

  const tallyProposal = (input: { roundId: string; proposalId: string }): ProposalTally => {
    const roundId = text(input?.roundId, 'roundId');
    const proposalId = text(input?.proposalId, 'proposalId');
    return tallyProposalInEngine(readRound(roundId).state, proposalId);
  };

  return {
    slot,
    key,
    ledger,
    snapshot,
    listRounds,
    getRound,
    readAudit,
    openRound,
    castBallot,
    declareRecusal,
    tallyRound,
    tallyProposal,
  };
}
