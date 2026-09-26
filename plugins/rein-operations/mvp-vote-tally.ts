/**
 * MVP approval tally.
 *
 * One frozen round, one deterministic count. A round freezes the eligible member roster and the
 * candidate proposal identifiers; every eligible member may return at most one immutable ballot
 * that approves 0..`maxApprovalsPerVoter` distinct candidates. An empty approval list is an
 * abstention: it counts as participation and adds nothing to any candidate. Each approved candidate
 * gains exactly one count per approving member.
 *
 * A unique highest count wins. A round in which no candidate is approved by anyone has no winner,
 * and a highest-count tie has no official winner: the tie rule is still only a proposal, so the
 * tally reports the tied candidates instead of enacting one.
 *
 * Out of scope on purpose: voting weights, rejection or disapproval, quorum, recusal, ranking,
 * budget and any automatic money movement. Nothing here has an external effect: it counts the
 * ballots it is given and returns a report.
 */

export class MvpVoteTallyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MvpVoteTallyError";
    this.code = code;
  }
}

export interface MvpBallot {
  /** Canonical member id of the voter. */
  memberId: string;
  /** Candidate proposal ids this member approves. Empty means the member abstained. */
  approvedProposalIds: readonly string[];
}

export interface MvpTallyInput {
  /** Frozen snapshot of eligible canonical member ids. Compared exactly; order is irrelevant. */
  eligibleMemberIds: readonly string[];
  /** Frozen candidate proposal ids for this round. Compared exactly; order is irrelevant. */
  candidateProposalIds: readonly string[];
  /** How many distinct candidates one member may approve; 0 approvals is always allowed. */
  maxApprovalsPerVoter: number;
  /** Ballots to count. Each member counts at most once. */
  ballots: readonly MvpBallot[];
}

export type RejectedBallotReason =
  | "invalid_ballot"
  | "ineligible_member"
  | "duplicate_approval"
  | "too_many_approvals"
  | "unknown_proposal"
  | "duplicate_ballot";

export interface RejectedBallot {
  memberId: string | null;
  /** Echo of the submitted approvals, or null when they are not an array of strings. */
  approvedProposalIds: readonly string[] | null;
  reason: RejectedBallotReason;
}

export type MvpTallyOutcome = "unique_winner" | "tie" | "no_winner";

export interface MvpTallyResult {
  candidateProposalIds: readonly string[];
  maxApprovalsPerVoter: number;
  /** Approvals per candidate. Every frozen candidate is a key, even at zero. */
  counts: Readonly<Record<string, number>>;
  rejectedBallots: readonly RejectedBallot[];
  participation: {
    eligible: number;
    /** Counted ballots, including abstentions. */
    participating: number;
    /** Counted ballots that approved no candidate. */
    abstained: number;
    /** Counted ballots that approved at least one candidate. */
    approving: number;
    /** Total approvals counted across all ballots. */
    approvals: number;
  };
  outcome: MvpTallyOutcome;
  winner: string | null;
  /** Candidates sharing the highest count when the outcome is a tie; empty otherwise. */
  tiedProposalIds: readonly string[];
  reasons: readonly string[];
}

function fail(code: string, message: string): never {
  throw new MvpVoteTallyError(code, message);
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

function requireIdList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("invalid_input", `${field} must be a non-empty array`);
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (typeof entry !== "string" || entry.length === 0) {
      fail("invalid_input", `${field} entries must be non-empty strings`);
    }
    if (seen.has(entry)) fail("invalid_input", `${field} contains a duplicate: ${entry}`);
    seen.add(entry);
    ids.push(entry);
  }
  return ids;
}

/**
 * Count one round of approval ballots against a frozen roster and a frozen candidate list.
 *
 * Malformed configuration (blank or duplicate eligible member ids, blank or duplicate candidate
 * proposal ids, or a `maxApprovalsPerVoter` that is not a positive integer) is a caller bug and
 * throws {@link MvpVoteTallyError} with code `invalid_input`. Malformed individual ballots are
 * normal data and are reported in `rejectedBallots` instead of throwing, so a frozen ballot set
 * always produces a readable result.
 *
 * Rejection precedence for one ballot is: shape, eligibility, a repeated approval inside the
 * ballot, too many approvals, unknown candidate, then a second ballot from the same member. The
 * first valid ballot for each eligible member is that member's one immutable ballot; any later
 * ballot from the same member is rejected as `duplicate_ballot` rather than replacing it, so the
 * count never depends on which ballot arrived last.
 */
export function tallyMvpVote(input: MvpTallyInput): MvpTallyResult {
  if (input === null || typeof input !== "object") {
    fail("invalid_input", "tally input must be an object");
  }
  const eligibleMemberIds = requireIdList(input.eligibleMemberIds, "eligibleMemberIds");
  const candidateProposalIds = requireIdList(input.candidateProposalIds, "candidateProposalIds");
  const maxApprovalsPerVoter = input.maxApprovalsPerVoter;
  if (
    typeof maxApprovalsPerVoter !== "number" ||
    !Number.isInteger(maxApprovalsPerVoter) ||
    maxApprovalsPerVoter < 1
  ) {
    fail("invalid_input", "maxApprovalsPerVoter must be a positive integer");
  }
  if (!Array.isArray(input.ballots)) {
    fail("invalid_input", "ballots must be an array");
  }

  const eligible = new Set(eligibleMemberIds);
  const counts = new Map<string, number>(candidateProposalIds.map((id) => [id, 0]));
  const countedMembers = new Set<string>();
  const rejectedBallots: RejectedBallot[] = [];
  let abstained = 0;
  let approving = 0;
  let approvals = 0;

  for (const raw of input.ballots as readonly unknown[]) {
    if (raw === null || typeof raw !== "object") {
      rejectedBallots.push({ memberId: null, approvedProposalIds: null, reason: "invalid_ballot" });
      continue;
    }
    const { memberId, approvedProposalIds } = raw as {
      memberId?: unknown;
      approvedProposalIds?: unknown;
    };
    // Echoed into the rejection report as submitted, and copied so freezing the result can never
    // freeze an array the caller still owns.
    const member = typeof memberId === "string" ? memberId : null;
    const approvalsList =
      Array.isArray(approvedProposalIds) && approvedProposalIds.every((id) => typeof id === "string")
        ? [...(approvedProposalIds as string[])]
        : null;
    if (
      member === null ||
      member.length === 0 ||
      approvalsList === null ||
      approvalsList.some((id) => id.length === 0)
    ) {
      rejectedBallots.push({
        memberId: member,
        approvedProposalIds: approvalsList,
        reason: "invalid_ballot",
      });
      continue;
    }
    if (!eligible.has(member)) {
      rejectedBallots.push({
        memberId: member,
        approvedProposalIds: approvalsList,
        reason: "ineligible_member",
      });
      continue;
    }
    if (new Set(approvalsList).size !== approvalsList.length) {
      rejectedBallots.push({
        memberId: member,
        approvedProposalIds: approvalsList,
        reason: "duplicate_approval",
      });
      continue;
    }
    if (approvalsList.length > maxApprovalsPerVoter) {
      rejectedBallots.push({
        memberId: member,
        approvedProposalIds: approvalsList,
        reason: "too_many_approvals",
      });
      continue;
    }
    if (approvalsList.some((id) => !counts.has(id))) {
      rejectedBallots.push({
        memberId: member,
        approvedProposalIds: approvalsList,
        reason: "unknown_proposal",
      });
      continue;
    }
    if (countedMembers.has(member)) {
      rejectedBallots.push({
        memberId: member,
        approvedProposalIds: approvalsList,
        reason: "duplicate_ballot",
      });
      continue;
    }

    countedMembers.add(member);
    if (approvalsList.length === 0) {
      abstained += 1;
    } else {
      approving += 1;
      for (const id of approvalsList) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      approvals += approvalsList.length;
    }
  }

  const highest = Math.max(...candidateProposalIds.map((id) => counts.get(id) ?? 0));
  const leaders = candidateProposalIds.filter((id) => counts.get(id) === highest);
  const outcome: MvpTallyOutcome =
    highest === 0 ? "no_winner" : leaders.length === 1 ? "unique_winner" : "tie";
  const reasons: string[] = [];
  if (outcome === "no_winner") {
    reasons.push("no_approvals_cast");
  } else if (outcome === "tie") {
    reasons.push("tie_at_highest_count");
  } else {
    reasons.push("unique_highest_count");
  }

  return deepFreeze<MvpTallyResult>({
    candidateProposalIds,
    maxApprovalsPerVoter,
    counts: Object.fromEntries(counts),
    rejectedBallots,
    participation: {
      eligible: eligibleMemberIds.length,
      participating: countedMembers.size,
      abstained,
      approving,
      approvals,
    },
    outcome,
    winner: outcome === "unique_winner" ? leaders[0] : null,
    tiedProposalIds: outcome === "tie" ? leaders : [],
    reasons,
  });
}
