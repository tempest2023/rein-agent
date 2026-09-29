/**
 * Deterministic weighted-voting engine for Rein Protocol Foundation governance rounds.
 *
 * Scope: PRD R10-R16 — frozen round snapshot, explicit voter and proposal eligibility, deadlines,
 * ballot replacement with retained history, recusal, tallying, insufficient participation, ties and
 * competing budget demands.
 *
 * Design rules:
 * - Pure and side-effect free. Every function takes values and returns new values. Nothing here
 *   reads a clock, a random source, a network or a database, and caller inputs are never mutated.
 *   All timestamps are passed in by the caller.
 * - Counting rules are explicit inputs. This module applies no default: a caller that omits `rules`
 *   receives an error instead of the PRD's discussion defaults. `prdR14DiscussionDefaultRules()`
 *   exists only as a clearly labelled, opt-in starting point and is never activated implicitly.
 * - No payments, no signing, no identity or weight escalation. An "allocation" here is a
 *   deterministic bookkeeping decision, not a reservation receipt, transfer or promise to pay.
 */

export type VoteChoice = "approve" | "reject" | "abstain";

export type ProposalStatus =
  | "passed"
  | "not_passed"
  | "insufficient_participation_deferred"
  | "deferred_for_revote";

export interface WeightedMember {
  memberId: string;
  /** Non-negative integer voting weight frozen for this round. */
  weight: number;
}

export interface Fraction {
  numerator: number;
  denominator: number;
}

export interface ParticipationRule {
  /** Minimum share of eligible headcount that must participate, rounded up to a whole member. */
  minMemberFraction: Fraction;
  /** Minimum share of the proposal's total eligible voting weight that must participate. */
  minWeightFraction: Fraction;
}

export interface ApprovalRule {
  /** Approval weight must be strictly greater than this fraction of approve-plus-reject weight. */
  strictMajorityFraction: Fraction;
  /** Require at least one non-abstaining vote before a proposal can pass. */
  requireNonAbstainingVote: boolean;
}

export type TieOutcome = "not_passed" | "passed" | "defer_to_revote";

export interface TieRule {
  outcome: TieOutcome;
}

export type AllocationRule = "no_auto_allocation" | "explicit_ranking";

export type AllocationExhaustion = "stop_at_first_unfundable" | "continue_to_next_fitting";

export interface AllocationPolicy {
  rule: AllocationRule;
  /**
   * Required when `rule` is "explicit_ranking": a complete ordering of every proposal id in the
   * round, fixed before votes are seen. Competition is never resolved by message or processing order.
   */
  ranking?: readonly string[];
  /** Required when `rule` is "explicit_ranking": behaviour once a ranked proposal cannot be funded. */
  exhaustion?: AllocationExhaustion;
}

export interface RoundRules {
  rulesVersion: string;
  participation: ParticipationRule;
  approval: ApprovalRule;
  tie: TieRule;
  voteReplacement: { allowed: boolean };
  allocation: AllocationPolicy;
}

export interface ProposalInput {
  proposalId: string;
  /** Frozen proposal version identifier; results must trace back to it. */
  version: string;
  leadMemberId: string;
  /** Requested funding in integer minor units. Use 0 for a zero-budget activity. */
  requestedAmountMinor: number;
  /** Members recused from this proposal (typically the lead and directly interested members). */
  recusedMemberIds?: readonly string[];
}

export interface RoundInput {
  roundId: string;
  rules: RoundRules;
  /** Inclusive voting window start, ISO 8601 timestamp. */
  opensAt: string;
  /** Exclusive voting window end, ISO 8601 timestamp. At this instant the round is closed. */
  closesAt: string;
  currency: string;
  /** Budget available for allocation this round, or null when availability is unconfirmed. */
  budgetAvailableMinor: number | null;
  roster: readonly WeightedMember[];
  proposals: readonly ProposalInput[];
}

export interface ProposalSnapshot {
  readonly proposalId: string;
  readonly version: string;
  readonly leadMemberId: string;
  readonly requestedAmountMinor: number;
  readonly recusedMemberIds: readonly string[];
}

export interface RoundSnapshot {
  readonly roundId: string;
  readonly rulesVersion: string;
  readonly rules: RoundRules;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly currency: string;
  readonly budgetAvailableMinor: number | null;
  readonly roster: readonly WeightedMember[];
  readonly proposals: readonly ProposalSnapshot[];
  /** Non-blocking observations for operators, e.g. a lead who did not recuse. */
  readonly warnings: readonly string[];
}

export interface BallotRecord {
  readonly sequence: number;
  readonly proposalId: string;
  readonly memberId: string;
  readonly choice: VoteChoice;
  readonly castAt: string;
  readonly idempotencyKey: string | null;
  readonly replacesSequence: number | null;
}

export interface RecusalRecord {
  readonly sequence: number;
  readonly proposalId: string;
  readonly memberId: string;
  readonly declaredAt: string;
  readonly reason: string;
}

export interface RoundState {
  readonly snapshot: RoundSnapshot;
  readonly ballots: readonly BallotRecord[];
  readonly recusals: readonly RecusalRecord[];
}

export interface BallotInput {
  proposalId: string;
  memberId: string;
  choice: VoteChoice;
  castAt: string;
  /** Optional duplicate-suppression key so a repeated click cannot create a second ballot. */
  idempotencyKey?: string;
}

export interface BallotResult {
  state: RoundState;
  accepted: boolean;
  /** True when an identical submission was suppressed by its idempotency key. */
  duplicated: boolean;
  reason: string | null;
  ballot: BallotRecord | null;
  replacedSequence: number | null;
}

export interface RecusalInput {
  proposalId: string;
  memberId: string;
  declaredAt: string;
  reason: string;
}

export interface RecusalResult {
  state: RoundState;
  accepted: boolean;
  reason: string | null;
  recusal: RecusalRecord | null;
}

export interface ProposalTally {
  proposalId: string;
  proposalVersion: string;
  leadMemberId: string;
  requestedAmountMinor: number;
  currency: string;
  recusedMemberIds: readonly string[];
  eligibleMemberCount: number;
  eligibleWeight: number;
  requiredParticipatingMembers: number;
  requiredParticipatingWeight: Fraction;
  participatingMemberCount: number;
  participatingWeight: number;
  participation: {
    memberRequirementMet: boolean;
    weightRequirementMet: boolean;
    met: boolean;
  };
  counts: { approve: number; reject: number; abstain: number };
  weights: { approve: number; reject: number; abstain: number };
  nonAbstainingWeight: number;
  /** Share of non-abstaining weight that approved, or null when nothing non-abstaining was cast. */
  approvalShareOfNonAbstaining: Fraction | null;
  status: ProposalStatus;
  passed: boolean;
  reasons: readonly string[];
}

export interface AllocationDecision {
  proposalId: string;
  requestedAmountMinor: number;
  allocatedMinor: number;
  status: "allocated" | "passed_no_funding_required" | "awaiting_funding_allocation";
  basis: string;
}

export interface BudgetSummary {
  currency: string;
  availableMinor: number | null;
  availableFundsKnown: boolean;
  requestedByPassedMinor: number;
  shortfallMinor: number | null;
  status: "not_requested" | "fully_covered" | "shortfall" | "available_funds_unknown";
}

export interface RoundResult {
  roundId: string;
  rulesVersion: string;
  currency: string;
  proposals: readonly ProposalTally[];
  budget: BudgetSummary;
  allocations: readonly AllocationDecision[];
  awaitingFundingAllocation: readonly string[];
  outstanding: readonly string[];
}

const VOTE_CHOICES: readonly VoteChoice[] = ["approve", "reject", "abstain"];
const TIE_OUTCOMES: readonly TieOutcome[] = ["not_passed", "passed", "defer_to_revote"];
const ALLOCATION_RULES: readonly AllocationRule[] = ["no_auto_allocation", "explicit_ranking"];
const ALLOCATION_EXHAUSTION: readonly AllocationExhaustion[] = [
  "stop_at_first_unfundable",
  "continue_to_next_fitting",
];

export class GovernanceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GovernanceError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new GovernanceError(code, message);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail("invalid_input", `${field} must be a non-empty string`);
  }
  return value as string;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("invalid_input", `${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail("invalid_input", `${field} must be an ISO 8601 timestamp string`);
  }
  return value as string;
}

function validateFraction(value: unknown, field: string): Fraction {
  if (value === null || typeof value !== "object") {
    fail("invalid_rules", `${field} must be an explicit { numerator, denominator } fraction`);
  }
  const fraction = value as Fraction;
  if (!Number.isSafeInteger(fraction.numerator) || fraction.numerator < 0) {
    fail("invalid_rules", `${field}.numerator must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(fraction.denominator) || fraction.denominator <= 0) {
    fail("invalid_rules", `${field}.denominator must be a positive safe integer`);
  }
  if (fraction.numerator > fraction.denominator) {
    fail("invalid_rules", `${field} must not exceed one whole (numerator <= denominator)`);
  }
  return { numerator: fraction.numerator, denominator: fraction.denominator };
}

function validateRules(input: unknown): RoundRules {
  if (input === null || typeof input !== "object") {
    fail(
      "rules_required",
      "rules must be passed explicitly; this engine activates no counting default, including the PRD R14 discussion proposal",
    );
  }
  const rules = input as RoundRules;
  const sections = ["participation", "approval", "tie", "voteReplacement", "allocation"];
  const missing = sections.filter((key) => (rules as Record<string, unknown>)[key] === undefined
    || (rules as Record<string, unknown>)[key] === null);
  if (typeof rules.rulesVersion !== "string" || rules.rulesVersion.trim() === "" || missing.length > 0) {
    fail(
      "rules_required",
      `rules must be passed explicitly and completely; missing or incomplete: ${missing.join(", ") || "rulesVersion"}`,
    );
  }

  if (rules.participation === null || typeof rules.participation !== "object") {
    fail("invalid_rules", "rules.participation must be provided explicitly");
  }
  validateFraction(rules.participation.minMemberFraction, "rules.participation.minMemberFraction");
  validateFraction(rules.participation.minWeightFraction, "rules.participation.minWeightFraction");

  if (rules.approval === null || typeof rules.approval !== "object") {
    fail("invalid_rules", "rules.approval must be provided explicitly");
  }
  validateFraction(rules.approval.strictMajorityFraction, "rules.approval.strictMajorityFraction");
  if (typeof rules.approval.requireNonAbstainingVote !== "boolean") {
    fail("invalid_rules", "rules.approval.requireNonAbstainingVote must be an explicit boolean");
  }

  if (rules.tie === null || typeof rules.tie !== "object") {
    fail("invalid_rules", "rules.tie must be provided explicitly; ties are never resolved implicitly");
  }
  if (!TIE_OUTCOMES.includes(rules.tie.outcome)) {
    fail("invalid_rules", `rules.tie.outcome must be one of ${TIE_OUTCOMES.join(", ")}`);
  }

  if (rules.voteReplacement === null || typeof rules.voteReplacement !== "object") {
    fail("invalid_rules", "rules.voteReplacement must be provided explicitly");
  }
  if (typeof rules.voteReplacement.allowed !== "boolean") {
    fail("invalid_rules", "rules.voteReplacement.allowed must be an explicit boolean");
  }

  if (rules.allocation === null || typeof rules.allocation !== "object") {
    fail("invalid_rules", "rules.allocation must be provided explicitly");
  }
  if (!ALLOCATION_RULES.includes(rules.allocation.rule)) {
    fail("invalid_rules", `rules.allocation.rule must be one of ${ALLOCATION_RULES.join(", ")}`);
  }
  if (rules.allocation.rule === "explicit_ranking") {
    if (!Array.isArray(rules.allocation.ranking)) {
      fail("invalid_rules", "rules.allocation.ranking is required for the explicit_ranking rule");
    }
    if (!ALLOCATION_EXHAUSTION.includes(rules.allocation.exhaustion as AllocationExhaustion)) {
      fail(
        "invalid_rules",
        `rules.allocation.exhaustion must be one of ${ALLOCATION_EXHAUSTION.join(", ")} for the explicit_ranking rule`,
      );
    }
  }

  return rules;
}

/** Ceiling division for non-negative integers. */
function ceilDiv(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator - 1) / denominator);
}

function greatestCommonDivisor(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

function reduceFraction(numerator: number, denominator: number): Fraction {
  if (denominator === 0) return { numerator: 0, denominator: 1 };
  const divisor = greatestCommonDivisor(numerator, denominator) || 1;
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

/**
 * Freeze a round: proposal versions, roster, weights and rules. The returned snapshot is deeply
 * frozen and detached from the caller's objects, so later edits to the inputs cannot change an
 * active round. New proposals must be opened in a later round.
 */
export function createRound(input: RoundInput): RoundState {
  if (input === null || typeof input !== "object") {
    fail("invalid_input", "round input must be an object");
  }
  const roundId = requireNonEmptyString(input.roundId, "roundId");
  const rules = validateRules(input.rules);
  const opensAt = requireTimestamp(input.opensAt, "opensAt");
  const closesAt = requireTimestamp(input.closesAt, "closesAt");
  if (Date.parse(closesAt) <= Date.parse(opensAt)) {
    fail("invalid_input", "closesAt must be later than opensAt");
  }
  const currency = requireNonEmptyString(input.currency, "currency");

  let budgetAvailableMinor: number | null = null;
  if (input.budgetAvailableMinor !== null && input.budgetAvailableMinor !== undefined) {
    budgetAvailableMinor = requireNonNegativeInteger(input.budgetAvailableMinor, "budgetAvailableMinor");
  }

  if (!Array.isArray(input.roster)) fail("invalid_input", "roster must be an array");
  const seenMembers = new Set<string>();
  const roster: WeightedMember[] = input.roster.map((member, index) => {
    const memberId = requireNonEmptyString(member?.memberId, `roster[${index}].memberId`);
    if (seenMembers.has(memberId)) fail("invalid_input", `duplicate roster member ${memberId}`);
    seenMembers.add(memberId);
    return { memberId, weight: requireNonNegativeInteger(member?.weight, `roster[${index}].weight`) };
  });

  if (!Array.isArray(input.proposals)) fail("invalid_input", "proposals must be an array");
  const seenProposals = new Set<string>();
  const warnings: string[] = [];
  const proposals: ProposalSnapshot[] = input.proposals.map((proposal, index) => {
    const proposalId = requireNonEmptyString(proposal?.proposalId, `proposals[${index}].proposalId`);
    if (seenProposals.has(proposalId)) fail("invalid_input", `duplicate proposal ${proposalId}`);
    seenProposals.add(proposalId);
    const version = requireNonEmptyString(proposal?.version, `proposals[${index}].version`);
    const leadMemberId = requireNonEmptyString(proposal?.leadMemberId, `proposals[${index}].leadMemberId`);
    const requestedAmountMinor = requireNonNegativeInteger(
      proposal?.requestedAmountMinor,
      `proposals[${index}].requestedAmountMinor`,
    );
    const recusedMemberIds = [...new Set(proposal?.recusedMemberIds ?? [])].sort();
    for (const recusedId of recusedMemberIds) {
      if (!seenMembers.has(recusedId)) {
        fail("invalid_input", `proposal ${proposalId} recusal ${recusedId} is not on the frozen roster`);
      }
    }
    // The lead may be a Contributor who is not a Board voter. Only warn when the lead is on the
    // roster and has not recused, because PRD R13 recommends lead recusal.
    if (seenMembers.has(leadMemberId) && !recusedMemberIds.includes(leadMemberId)) {
      warnings.push(`proposal ${proposalId}: lead ${leadMemberId} is not marked recused`);
    }
    return { proposalId, version, leadMemberId, requestedAmountMinor, recusedMemberIds };
  });

  if (rules.allocation.rule === "explicit_ranking") {
    const ranking = [...(rules.allocation.ranking ?? [])];
    const ranked = new Set(ranking);
    if (ranked.size !== ranking.length) {
      fail("invalid_rules", "rules.allocation.ranking must not repeat a proposal id");
    }
    for (const proposalId of seenProposals) {
      if (!ranked.has(proposalId)) {
        fail(
          "invalid_rules",
          `rules.allocation.ranking must cover every frozen proposal; missing ${proposalId}`,
        );
      }
    }
    for (const rankedId of ranked) {
      if (!seenProposals.has(rankedId)) {
        fail("invalid_rules", `rules.allocation.ranking references unknown proposal ${rankedId}`);
      }
    }
  }

  const snapshot = deepFreeze<RoundSnapshot>({
    roundId,
    rulesVersion: rules.rulesVersion,
    rules: structuredClone(rules),
    opensAt,
    closesAt,
    currency,
    budgetAvailableMinor,
    roster,
    proposals,
    warnings,
  });

  return deepFreeze<RoundState>({ snapshot, ballots: [], recusals: [] });
}

/** Members recused from one proposal: the frozen declarations plus any recorded during the round. */
export function effectiveRecusedMemberIds(state: RoundState, proposalId: string): readonly string[] {
  const proposal = findProposal(state, proposalId);
  const recused = new Set<string>(proposal.recusedMemberIds);
  for (const recusal of state.recusals) {
    if (recusal.proposalId === proposalId) recused.add(recusal.memberId);
  }
  return [...recused].sort();
}

export function isProposalEligible(state: RoundState, proposalId: string): boolean {
  return state.snapshot.proposals.some((proposal) => proposal.proposalId === proposalId);
}

export function isVoterEligible(state: RoundState, memberId: string): boolean {
  return state.snapshot.roster.some((member) => member.memberId === memberId);
}

/** Voting-window state at an explicit instant: scheduled, open, or closed. */
export function getRoundStatus(state: RoundState, at: string): "scheduled" | "open" | "closed" {
  const instant = Date.parse(requireTimestamp(at, "at"));
  if (instant < Date.parse(state.snapshot.opensAt)) return "scheduled";
  if (instant < Date.parse(state.snapshot.closesAt)) return "open";
  return "closed";
}

function findProposal(state: RoundState, proposalId: string): ProposalSnapshot {
  const proposal = state.snapshot.proposals.find((entry) => entry.proposalId === proposalId);
  if (!proposal) fail("unknown_proposal", `proposal ${proposalId} is not part of this frozen round`);
  return proposal;
}

function weightOf(state: RoundState, memberId: string): number {
  const member = state.snapshot.roster.find((entry) => entry.memberId === memberId);
  if (!member) fail("ineligible_voter", `member ${memberId} is not on the frozen roster`);
  return member.weight;
}

function latestBallotFor(
  state: RoundState,
  proposalId: string,
  memberId: string,
): BallotRecord | undefined {
  let latest: BallotRecord | undefined;
  for (const ballot of state.ballots) {
    if (ballot.proposalId !== proposalId || ballot.memberId !== memberId) continue;
    if (latest === undefined || ballot.sequence > latest.sequence) latest = ballot;
  }
  return latest;
}

function rejectedBallot(state: RoundState, reason: string): BallotResult {
  return { state, accepted: false, duplicated: false, reason, ballot: null, replacedSequence: null };
}

/**
 * Record one ballot. Rejections are normal outcomes and never throw: ineligible voters, recused
 * members, proposals outside the frozen snapshot, out-of-window timestamps, disallowed replacements
 * and duplicate submissions all return `accepted: false` with a reason.
 */
export function castBallot(state: RoundState, input: BallotInput): BallotResult {
  if (input === null || typeof input !== "object") fail("invalid_input", "ballot input must be an object");
  const proposalId = requireNonEmptyString(input.proposalId, "ballot.proposalId");
  const memberId = requireNonEmptyString(input.memberId, "ballot.memberId");
  const castAt = requireTimestamp(input.castAt, "ballot.castAt");
  if (!VOTE_CHOICES.includes(input.choice)) {
    return rejectedBallot(state, "invalid_choice");
  }
  if (input.idempotencyKey !== undefined) {
    requireNonEmptyString(input.idempotencyKey, "ballot.idempotencyKey");
  }

  if (input.idempotencyKey !== undefined) {
    const prior = state.ballots.find((ballot) => ballot.idempotencyKey === input.idempotencyKey);
    if (prior) {
      const same =
        prior.proposalId === proposalId && prior.memberId === memberId && prior.choice === input.choice;
      if (same) {
        return {
          state,
          accepted: true,
          duplicated: true,
          reason: null,
          ballot: prior,
          replacedSequence: prior.replacesSequence,
        };
      }
      return rejectedBallot(state, "idempotency_key_conflict");
    }
  }

  if (!isVoterEligible(state, memberId)) return rejectedBallot(state, "ineligible_voter");
  if (!isProposalEligible(state, proposalId)) return rejectedBallot(state, "proposal_not_eligible");
  if (effectiveRecusedMemberIds(state, proposalId).includes(memberId)) {
    return rejectedBallot(state, "recused_member");
  }
  if (getRoundStatus(state, castAt) !== "open") return rejectedBallot(state, "outside_voting_window");

  const existing = latestBallotFor(state, proposalId, memberId);
  if (existing && !state.snapshot.rules.voteReplacement.allowed) {
    return rejectedBallot(state, "vote_replacement_not_allowed");
  }

  const ballot: BallotRecord = {
    sequence: state.ballots.length + 1,
    proposalId,
    memberId,
    choice: input.choice,
    castAt,
    idempotencyKey: input.idempotencyKey ?? null,
    replacesSequence: existing ? existing.sequence : null,
  };

  return {
    state: deepFreeze<RoundState>({
      snapshot: state.snapshot,
      ballots: [...state.ballots, ballot],
      recusals: state.recusals,
    }),
    accepted: true,
    duplicated: false,
    reason: null,
    ballot,
    replacedSequence: ballot.replacesSequence,
  };
}

/**
 * Declare a recusal during an open round. Accepted only while no ballot exists yet for that
 * proposal, so recusal can never silently invalidate a recorded vote. Later declarations require
 * an authorized round restart, which is outside this engine.
 */
export function declareRecusal(state: RoundState, input: RecusalInput): RecusalResult {
  if (input === null || typeof input !== "object") fail("invalid_input", "recusal input must be an object");
  const proposalId = requireNonEmptyString(input.proposalId, "recusal.proposalId");
  const memberId = requireNonEmptyString(input.memberId, "recusal.memberId");
  const declaredAt = requireTimestamp(input.declaredAt, "recusal.declaredAt");
  const reason = requireNonEmptyString(input.reason, "recusal.reason");

  const reject = (code: string): RecusalResult => ({ state, accepted: false, reason: code, recusal: null });

  if (!isVoterEligible(state, memberId)) return reject("ineligible_voter");
  if (!isProposalEligible(state, proposalId)) return reject("proposal_not_eligible");
  if (effectiveRecusedMemberIds(state, proposalId).includes(memberId)) return reject("already_recused");
  if (getRoundStatus(state, declaredAt) !== "open") return reject("outside_voting_window");
  if (state.ballots.some((ballot) => ballot.proposalId === proposalId)) {
    return reject("ballots_already_recorded_restart_required");
  }

  const recusal: RecusalRecord = {
    sequence: state.recusals.length + 1,
    proposalId,
    memberId,
    declaredAt,
    reason,
  };

  return {
    state: deepFreeze<RoundState>({
      snapshot: state.snapshot,
      ballots: state.ballots,
      recusals: [...state.recusals, recusal],
    }),
    accepted: true,
    reason: null,
    recusal,
  };
}

/**
 * Count one proposal under the frozen rules. Recused members are excluded from both the eligible
 * headcount and the eligible weight. Abstentions count toward participation but never toward the
 * approve-versus-reject comparison. Insufficient participation is reported as deferred, not
 * rejected, and a tie is resolved only by the explicitly supplied tie rule.
 */
export function tallyProposal(state: RoundState, proposalId: string): ProposalTally {
  const snapshot = state.snapshot;
  const proposal = findProposal(state, proposalId);
  const rules = snapshot.rules;
  const recusedMemberIds = effectiveRecusedMemberIds(state, proposalId);
  const recused = new Set(recusedMemberIds);

  const eligibleMembers = snapshot.roster.filter((member) => !recused.has(member.memberId));
  const eligibleMemberCount = eligibleMembers.length;
  const eligibleWeight = eligibleMembers.reduce((total, member) => total + member.weight, 0);

  const memberFraction = rules.participation.minMemberFraction;
  const weightFraction = rules.participation.minWeightFraction;
  const requiredParticipatingMembers = ceilDiv(
    eligibleMemberCount * memberFraction.numerator,
    memberFraction.denominator,
  );

  const latestByMember = new Map<string, BallotRecord>();
  for (const ballot of state.ballots) {
    if (ballot.proposalId !== proposalId || recused.has(ballot.memberId)) continue;
    const previous = latestByMember.get(ballot.memberId);
    if (previous === undefined || ballot.sequence > previous.sequence) {
      latestByMember.set(ballot.memberId, ballot);
    }
  }

  const counts = { approve: 0, reject: 0, abstain: 0 };
  const weights = { approve: 0, reject: 0, abstain: 0 };
  let participatingWeight = 0;
  for (const ballot of latestByMember.values()) {
    const weight = weightOf(state, ballot.memberId);
    counts[ballot.choice] += 1;
    weights[ballot.choice] += weight;
    participatingWeight += weight;
  }

  const participatingMemberCount = latestByMember.size;
  const memberRequirementMet = participatingMemberCount >= requiredParticipatingMembers;
  const weightRequirementMet =
    participatingWeight * weightFraction.denominator >= eligibleWeight * weightFraction.numerator;
  const participationMet = memberRequirementMet && weightRequirementMet;

  const nonAbstainingWeight = weights.approve + weights.reject;
  const approvalShareOfNonAbstaining =
    nonAbstainingWeight === 0 ? null : reduceFraction(weights.approve, nonAbstainingWeight);

  const reasons: string[] = [];
  let status: ProposalStatus;

  if (!participationMet) {
    status = "insufficient_participation_deferred";
    reasons.push("insufficient_participation");
    if (!memberRequirementMet) reasons.push("member_participation_below_minimum");
    if (!weightRequirementMet) reasons.push("weight_participation_below_minimum");
  } else if (nonAbstainingWeight === 0) {
    status = "not_passed";
    reasons.push("no_non_abstaining_vote");
  } else if (weights.approve === weights.reject) {
    if (rules.tie.outcome === "passed") {
      status = "passed";
      reasons.push("tie_resolved_by_rule_as_passed");
    } else if (rules.tie.outcome === "defer_to_revote") {
      status = "deferred_for_revote";
      reasons.push("tie_deferred_to_revote");
    } else {
      status = "not_passed";
      reasons.push("tie_does_not_pass");
    }
  } else {
    const majority = rules.approval.strictMajorityFraction;
    const meetsThreshold =
      weights.approve * majority.denominator > nonAbstainingWeight * majority.numerator;
    if (meetsThreshold) {
      status = "passed";
    } else {
      status = "not_passed";
      reasons.push("approval_below_strict_majority");
    }
  }

  if (status === "passed" && proposal.requestedAmountMinor > 0) {
    reasons.push("support_threshold_met_funding_still_requires_allocation");
  }

  return deepFreeze<ProposalTally>({
    proposalId,
    proposalVersion: proposal.version,
    leadMemberId: proposal.leadMemberId,
    requestedAmountMinor: proposal.requestedAmountMinor,
    currency: snapshot.currency,
    recusedMemberIds,
    eligibleMemberCount,
    eligibleWeight,
    requiredParticipatingMembers,
    requiredParticipatingWeight: weightFraction,
    participatingMemberCount,
    participatingWeight,
    participation: {
      memberRequirementMet,
      weightRequirementMet,
      met: participationMet,
    },
    counts,
    weights,
    nonAbstainingWeight,
    approvalShareOfNonAbstaining,
    status,
    passed: status === "passed",
    reasons,
  });
}

/**
 * Count the whole round and resolve competing budget demands. Allocations are deterministic and
 * independent of message or processing order: proposals are emitted sorted by id, and competition
 * is resolved only by an explicit ranking supplied in the rules. Nothing is ever allocated on a
 * first-come basis, and unconfirmed availability pauses funding commitments instead of guessing.
 */
export function tallyRound(state: RoundState): RoundResult {
  const snapshot = state.snapshot;
  const proposals = snapshot.proposals
    .map((proposal) => tallyProposal(state, proposal.proposalId))
    .sort((left, right) => (left.proposalId < right.proposalId ? -1 : 1));

  const passed = proposals.filter((proposal) => proposal.passed);
  const requestedByPassedMinor = passed.reduce(
    (total, proposal) => total + proposal.requestedAmountMinor,
    0,
  );
  const availableMinor = snapshot.budgetAvailableMinor;

  let budgetStatus: BudgetSummary["status"];
  let shortfallMinor: number | null = null;
  if (passed.length === 0) {
    budgetStatus = "not_requested";
  } else if (availableMinor === null) {
    budgetStatus = "available_funds_unknown";
  } else if (requestedByPassedMinor <= availableMinor) {
    budgetStatus = "fully_covered";
  } else {
    budgetStatus = "shortfall";
    shortfallMinor = requestedByPassedMinor - availableMinor;
  }

  const outstanding = new Set<string>();
  for (const proposal of proposals) {
    for (const reason of proposal.reasons) {
      if (reason !== "support_threshold_met_funding_still_requires_allocation") outstanding.add(reason);
    }
  }
  if (budgetStatus === "shortfall") outstanding.add("budget_shortfall_requires_prioritization_decision");
  if (budgetStatus === "available_funds_unknown") {
    outstanding.add("available_funds_unknown_pause_commitments");
  }

  const policy = snapshot.rules.allocation;
  const allocationByProposal = new Map<string, AllocationDecision>();
  const passedById = new Map(passed.map((proposal) => [proposal.proposalId, proposal]));

  const decide = (
    proposal: ProposalTally,
    status: AllocationDecision["status"],
    allocatedMinor: number,
    basis: string,
  ): AllocationDecision => ({
    proposalId: proposal.proposalId,
    requestedAmountMinor: proposal.requestedAmountMinor,
    allocatedMinor,
    status,
    basis,
  });

  if (passed.length > 0) {
    if (availableMinor === null) {
      for (const proposal of passed) {
        allocationByProposal.set(
          proposal.proposalId,
          proposal.requestedAmountMinor === 0
            ? decide(proposal, "passed_no_funding_required", 0, "available_funds_unknown")
            : decide(proposal, "awaiting_funding_allocation", 0, "available_funds_unknown"),
        );
      }
    } else if (budgetStatus === "fully_covered") {
      for (const proposal of passed) {
        allocationByProposal.set(
          proposal.proposalId,
          proposal.requestedAmountMinor === 0
            ? decide(proposal, "passed_no_funding_required", 0, "no_competition")
            : decide(proposal, "allocated", proposal.requestedAmountMinor, "no_competition"),
        );
      }
    } else if (policy.rule === "no_auto_allocation") {
      for (const proposal of passed) {
        allocationByProposal.set(
          proposal.proposalId,
          proposal.requestedAmountMinor === 0
            ? decide(proposal, "passed_no_funding_required", 0, "no_auto_allocation")
            : decide(proposal, "awaiting_funding_allocation", 0, "no_auto_allocation"),
        );
      }
    } else {
      let remaining = availableMinor;
      let blocked = false;
      for (const rankedId of policy.ranking ?? []) {
        const proposal = passedById.get(rankedId);
        if (!proposal) continue;
        if (proposal.requestedAmountMinor === 0) {
          allocationByProposal.set(
            proposal.proposalId,
            decide(proposal, "passed_no_funding_required", 0, "explicit_ranking"),
          );
          continue;
        }
        if (!blocked && remaining >= proposal.requestedAmountMinor) {
          remaining -= proposal.requestedAmountMinor;
          allocationByProposal.set(
            proposal.proposalId,
            decide(proposal, "allocated", proposal.requestedAmountMinor, "explicit_ranking"),
          );
          continue;
        }
        allocationByProposal.set(
          proposal.proposalId,
          decide(proposal, "awaiting_funding_allocation", 0, "explicit_ranking"),
        );
        if (policy.exhaustion === "stop_at_first_unfundable") blocked = true;
      }
    }
  }

  const allocations = passed.map(
    (proposal) =>
      allocationByProposal.get(proposal.proposalId) ??
      decide(proposal, "awaiting_funding_allocation", 0, "unresolved"),
  );

  const awaitingFundingAllocation = allocations
    .filter((decision) => decision.status === "awaiting_funding_allocation")
    .map((decision) => decision.proposalId);

  return deepFreeze<RoundResult>({
    roundId: snapshot.roundId,
    rulesVersion: snapshot.rulesVersion,
    currency: snapshot.currency,
    proposals,
    budget: {
      currency: snapshot.currency,
      availableMinor,
      availableFundsKnown: availableMinor !== null,
      requestedByPassedMinor,
      shortfallMinor,
      status: budgetStatus,
    },
    allocations,
    awaitingFundingAllocation,
    outstanding: [...outstanding].sort(),
  });
}

/**
 * The counting rules discussed in PRD R14 and R15. These are a *discussion default*, not adopted
 * organizational policy: nothing in this module applies them unless a caller explicitly passes the
 * result as `rules`. Resolve the open decisions in docs/decisions.md before a real round.
 */
export function prdR14DiscussionDefaultRules(options: { rulesVersion: string }): RoundRules {
  return {
    rulesVersion: requireNonEmptyString(options?.rulesVersion, "options.rulesVersion"),
    participation: {
      minMemberFraction: { numerator: 1, denominator: 2 },
      minWeightFraction: { numerator: 1, denominator: 2 },
    },
    approval: {
      strictMajorityFraction: { numerator: 1, denominator: 2 },
      requireNonAbstainingVote: true,
    },
    tie: { outcome: "not_passed" },
    voteReplacement: { allowed: true },
    allocation: { rule: "no_auto_allocation" },
  };
}
