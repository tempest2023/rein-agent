// Outbound reply guard for the MVP poll-result tool (case 7).
//
// Why this exists. `rein_poll_result` answers the caller with a structured object that carries
// implementation vocabulary on purpose: the stored poll identifier, the recorded outcome, the
// per-proposal counts, the participation and abstention totals, the transport metadata (`delivery`,
// `model_relayed`), the reason code of a replay (`existing_finalized`) and the flag that the round
// was already recorded (`repeated`). Those are right for the caller that acts on them, but
// `docs/agent-test-cases-zh.md` case 7 requires the director to hear the outcome, the winner's
// recorded count, the recorded participation and abstention counts, and that the record moves no
// money: never a field name, a tool name, a voter or an identifier. That count is the recorded
// approval total the tool publishes for the winner (`narration.counts`), never money. The tool
// already builds the sentence for this purpose in `narration.note`, so this guard writes no prose of
// its own. It validates the tool's own sentence and delivers that sentence as the run's final reply,
// because prompt text alone did not hold for the sibling collect flow (case 3), where a synthetic
// rehearsal delivered the model's own prose instead of the member-facing wording.
//
// What it does, and what it deliberately leaves alone. Two host hooks, matched to the result tool
// (`rein_poll_result`), to the MVP write tools that close a run, and to the Tool Search
// dispatcher `tool_call`, all correlated by one `runId`:
// - `after_tool_call` notices exactly one recognized `rein_poll_result` answer carrying a
//   *validated* `narration.note`, and remembers that sentence, keyed by the run that produced it. A
//   write observed in the same run drops the remembered sentence, because that run's reply is the
//   write outcome rather than the round narration. Both a direct call and a Tool Search dispatch are
//   recognized; a dispatch is unwrapped through the host's own tool identity, never through the
//   model-authored params.
// - `reply_payload_sending` fires for the same run, on the Slack surface, when the host is about to
//   deliver the turn's final reply. That one payload's text is replaced with the remembered
//   sentence; every other property of the payload is preserved by spreading the original, and the
//   payload object received from the host is never mutated in place.
//
// Nothing else is touched. Another tool, another run, a non-Slack surface, a non-final dispatch kind
// (progress output and tool messages), a reply with no matching recognized result, a failed or
// malformed result, an error answer and a payload without text all leave the payload exactly as the
// host supplied it. No reply is ever sent from here: the guard only edits the text of a payload the
// host was already going to deliver, and it never calls a Slack API, the database or a model.
//
// What makes a sentence deliverable. The note is the tool's own wording, so the guard's job is to
// refuse a sentence it cannot vouch for rather than to rewrite one, and every refusal leaves the
// host's own payload open:
// - the answer names `rein_poll_result`, carries a `narration` object whose `kind` is `final`,
//   and is the recorded outcome (`ok === true`), with a non-empty `note` inside a fixed length fence;
// - the note carries no implementation term (`rein_`, `narration`, `delivery`, `model_relayed`,
//   `official`, `finalized`, `existing_finalized`, `settled`, `repeated`, `authorizesSpending`,
//   `abstainCount`, `totalBallots`, `winnerTitle`, `candidateProposals`, `pollId`, `tool_call`) and
//   no identifier-shaped token: a stored contact or proposal identifier in the sentence would be a
//   voter or a record reaching a spoken reply, and the tool's own note never carries one;
// - a `winner` sentence names the highest-approval candidate and its recorded count; that count is
//   the non-negative safe integer the tool published for that same proposal id in
//   `narration.counts`, so the figure travels with the outcome it belongs to and a sentence whose
//   count the answer does not carry is refused rather than delivered. The count is an approval
//   total, never a monetary amount, and the previous response's award count stays on the payload's
//   own fields;
// - the sentence states that the record moves no money, and its `outcome` is `winner` or `no_winner`;
// - a `no_winner` sentence names no winner and no winning title - a tie and an all-abstain round are
//   both recorded this way, the record carries no cause, and the tie rule is still unconfirmed, so
//   naming a candidate would claim something the record cannot support.
//
// An open round is answered too, but never from the model's prose and never with the tool's own
// outcome wording. `rein_poll_result` answers a round that is still open with `provisional`, the
// frozen candidate identifiers and titles instead of an outcome, and no count, no winner and no
// participation total. That answer is what a later director turn maps a spoken proposal name
// against, so the *clarification* has to survive; but the model's own reply to a provisional read is
// exactly the reply that leaked attempted voter names and implementation fields. The guard therefore
// rebuilds the provisional reply itself: the frozen candidate titles in their frozen order as a
// numbered list a director can point at, one generic clause that says the round is not over and there
// is no winner, no count and no participation figure yet, and one instruction to answer with a
// number or to abstain explicitly. Nothing is read from the model's prose, no identifier and no voter
// is ever named, and when a frozen title is missing or two titles cannot be told apart the guard does
// not present a numbered list it cannot vouch for - it says so and asks which candidate is meant, so
// case 6's omitted and ambiguous candidate still gets its clarification. A provisional read observed
// in a run that already armed a sentence replaces that sentence: the run's reply is about the open
// round, not a closed one, so the closed round's outcome is never delivered over it. A write then
// observed in the same run clears the run, because that run's reply is the write outcome.
//
// Memory. One entry per run, consumed on first use, and every entry expires after a fixed TTL, so a
// run whose reply never arrives, or a stream of unrelated runs, cannot grow this state without
// bound. The entries live in one store shared by every loaded copy of this module in the process
// (see `POLL_REPLY_GUARD_SHARED_STATE_KEY`), because a live Gateway loads this plugin more than once
// and the two hooks above can run in different copies; a per-instance map put the arm in one copy and
// left the reply hook looking in the other, empty copy. Sharing changes only who can read an entry,
// not what is remembered: the store is still bounded, still swept on every hook call, and still
// confined to one process. A caller that asks for isolation (`stateKey: null`) gets private memory
// instead. The key is this module's own, so a remembered collect and a remembered round result can
// never be read as each other.
//
// Open versus closed, stated plainly. This is a reply-rewriting guard, not an authorization gate, so
// every refusal path here is deliberately open: an event shape the guard does not recognize, a
// payload it cannot read or rebuild, a note it cannot vouch for, or a thrown error leaves the host's
// own payload exactly as it was and lets delivery proceed. The guard never suppresses, delays or
// replaces a reply it cannot rebuild; the only thing refused is the unsafe rewrite itself. A payload
// handed through by a refusal may still carry internal vocabulary, so this guard is a floor on what
// one known tool's final reply says, not a blanket guarantee about every payload the host delivers.

import type {
  PluginHookAfterToolCallEvent,
  PluginHookReplyPayload,
  PluginHookReplyPayloadSendingEvent,
  PluginHookReplyPayloadSendingResult,
  PluginHookToolContext,
} from 'openclaw/plugin-sdk/plugin-entry';

/** The result tool this guard observes and may rewrite the reply of. */
export const POLL_RESULT_GUARD_TOOL_NAME = 'rein_poll_result';
/**
 * The Tool Search dispatcher the host reports when the result tool, or one of the clearing writes
 * below, runs through Tool Search. It is matched, not trusted: its identity is only read from the
 * host's own `result.details.tool`, so admitting the dispatcher to the matcher arms nothing by
 * itself.
 */
export const TOOL_SEARCH_DISPATCHER_TOOL_NAME = 'tool_call';
/**
 * The MVP tools that close a run once they are observed in it. A run that read a round result and
 * then wrote through one of these is delivering that write's outcome, so its remembered sentence is
 * dropped before the outcome is read and its reply is never rewritten. This is deliberately the
 * broad side of the boundary: clearing too much only delivers the model's own prose, which is the
 * behaviour without this guard, while clearing too little could rewrite a reply that is about a
 * write. A unit test keeps the list tied to the write tools the MVP block actually registers.
 */
export const POLL_REPLY_GUARD_WRITE_TOOL_NAMES = Object.freeze([
  'rein_governance_proposal_submit',
  'rein_poll_open',
  'rein_poll_vote',
  'rein_proposal_comment_suggest',
  'rein_revision_approve',
  'rein_revision_apply',
]);
/**
 * Every tool name the `after_tool_call` matcher must admit, so the entry wiring cannot drift: the
 * result tool for a direct (non-Tool-Search) call, the clearing writes, plus the dispatcher for a
 * Tool Search call.
 */
export const POLL_REPLY_GUARD_TOOL_NAMES = Object.freeze([
  POLL_RESULT_GUARD_TOOL_NAME,
  ...POLL_REPLY_GUARD_WRITE_TOOL_NAMES,
  TOOL_SEARCH_DISPATCHER_TOOL_NAME,
]);
/** The one transport surface this guard rewrites on. */
export const POLL_GUARD_CHANNEL = 'slack';
/** The one dispatch kind this guard rewrites: the turn's final reply, not progress or tool output. */
export const POLL_GUARD_FINAL_KIND = 'final';
/** How long a remembered sentence stays replaceable before it is swept, in milliseconds. */
export const POLL_REPLY_GUARD_TTL_MS = 5 * 60 * 1000;
/** How many runs may be remembered at once; the oldest entry is dropped past this bound. */
export const POLL_REPLY_GUARD_MAX_ENTRIES = 64;
/**
 * Longest remembered sentence this guard will deliver. The longest note the tool can build is its
 * own fixed sentences plus one stored proposal title, and that title is capped at 200 characters by
 * the write tool and by the database writer, so this fence clears the longest legal note by more than
 * three times. A unit test keeps the fence above the tool's own title cap.
 */
export const MAX_POLL_NOTE_LENGTH = 1000;
/**
 * Process-wide key of the remembered-sentence store. A live Gateway loads this plugin more than once:
 * two byte-identical build trees, each with its own bundled module graph and its own copy of this
 * module, both call {@link createPollReplyGuard}, and the `after_tool_call` hook that arms and the
 * `reply_payload_sending` hook that reads can land in different copies. A `Map` created inside one
 * module graph is invisible to the other, so the arm and the reply never meet. The store therefore
 * lives on `globalThis` under an interned symbol, the same process-global pattern OpenClaw uses for
 * its own plugin registry state (`vendor/openclaw/src/plugins/runtime-state.ts`). The `.v1` suffix
 * versions the slot so a future change to the remembered shape takes a new name instead of reading a
 * stale one, and a slot whose contents do not match this module's own shape is replaced rather than
 * trusted. The slot is readable by any code in the same process, which is the price of reaching both
 * module graphs; what is remembered is the tool's own member-facing sentence and nothing else. The
 * key is distinct from the collect guard's slot, so the two guards can never read each other's entry.
 */
export const POLL_REPLY_GUARD_SHARED_STATE_KEY =
  '@rein-protocol/openclaw-rein-operations.governance-poll-reply-guard.v1';
/** Shape version of one store: a store carrying any other version is replaced, not read. */
const POLL_REPLY_GUARD_STORE_VERSION = 1;
/**
 * The clause a closed-round sentence must carry: a stored decision record moves no money. It is the
 * tool's own wording, and a unit test keeps this fence tied to the sentence the tool builds.
 */
const NO_FUNDS_SENTENCE = '不移动任何资金';
/**
 * The lead of a winner sentence: the recorded highest-approval candidate follows, then its recorded
 * count. It is the tool's own wording, and a unit test keeps this fence tied to the sentence the tool
 * builds. This is what tells a winner sentence apart from a no-winner one, so a no-winner sentence
 * that somehow carried a count is refused instead of delivered as an outcome with a tally.
 */
const WINNER_LEAD = '本轮投票已结束，最高赞成票的候选人是：';
/**
 * The lead of a no-winner sentence: the record holds no winner at all, so no candidate and no count
 * may be reported with it. Same fence as above, tied to the tool's own wording by a unit test.
 */
const NO_WINNER_LEAD = '本轮投票已结束，记录的结果是无赢家';
/**
 * The lead of the guard's own open-round clarification. It says the round is not over and that no
 * winner, no count and no participation figure exists yet - the same three facts the tool's own
 * provisional note carries, with no number in it, and a unit test keeps this fence tied to that note.
 */
const PROVISIONAL_OPEN_LEAD =
  '本轮还没有结束，所以还没有结果：现在没有赢家，也没有票数与参与人数。';
/**
 * The instruction the open-round clarification ends with: answer with a candidate's number, or say
 * explicitly that you abstain. Case 6 needs a spoken name mapped onto a frozen candidate, and a
 * number is the one thing a director can repeat back without knowing an identifier.
 */
const PROVISIONAL_SELECT_INSTRUCTION =
  '如果要投票，请回复候选的编号；如果这一轮弃权，也请直接说明弃权。';
/**
 * What the open-round clarification says when it cannot present a numbered candidate list: a frozen
 * title is missing, or two frozen titles cannot be told apart. The guard asks which candidate is meant
 * instead of presenting a list it cannot vouch for, so case 6's omitted and ambiguous candidate still
 * gets its clarification.
 */
const PROVISIONAL_UNCLEAR_INSTRUCTION =
  '这一轮的候选名称暂时无法完整确定，请说明你指的是哪一条提案，或直接说明弃权。';
/**
 * Longest frozen candidate title the guard will repeat in the open-round clarification. It is the
 * same 200-character cap the write tool and the database writer enforce on a stored title, so a title
 * the tool reported is never truncated here; a longer one is refused rather than spliced.
 */
const MAX_CANDIDATE_TITLE_LENGTH = 200;
/**
 * Most candidates the open-round clarification will list. The frozen pool of one round is assembled by
 * the tool from the stored proposals, and a list a director is meant to pick a number from has to stay
 * short enough to read; past this bound the guard refuses to list rather than deliver an unreadable
 * reply, and the same fence guards the two numbered-list loops below.
 */
const MAX_PROVISIONAL_CANDIDATES = 50;
/**
 * The count clause of a winner sentence, as a fixed regular expression. The tool prints the winner's
 * *approval* count as N approvals ("赞成 N 票"), not as a ballot figure: an approval count can rise
 * past the number of participating directors when a proposal type allows more than one approval per
 * voter (see `maxApprovalsPerVoter` in `mvp-vote-tally.ts`), so calling it ballots would be wrong. The
 * same shape with no count, the generic "已记录该候选人的票数", is what a winner sentence carries when
 * the record cannot say how many approvals the winner took, and each alternative below is exactly one
 * such wording. The count is what case 7 requires the director to hear, so a winner sentence carrying
 * neither shape is refused rather than delivered without a figure.
 */
const WINNER_COUNT_CLAUSE_PATTERN =
  /本轮该候选人获得赞成\s(\d+)\s票|本轮该候选人获得赞成票数已记录在案/;
/**
 * How many times the count clause may appear in one winner sentence: exactly once, right after the
 * winner's title. A sentence that repeats the figure cannot be delivered unchanged, because a count
 * pinned to the wrong candidate would then read as that candidate's count.
 */
const WINNER_COUNT_CLAUSE_LIMIT = 1;
/** The marker a no-winner sentence must carry: the record holds no winner. */
const NO_WINNER_PHRASE = '无赢家';
/**
 * The clause a no-winner sentence must carry: the rule for a tie is not settled. Without it a
 * no-winner record could be read as an adopted rule, which case 7 forbids.
 */
const UNCONFIRMED_RULE_PHRASE = '尚未确认';
/**
 * Implementation vocabulary a member-facing sentence may never carry, matched case-insensitively.
 * Every entry is a tool name, a result field name or transport metadata the tool's own note does not
 * contain, so a sentence carrying one did not come from the tool's note alone.
 */
const IMPLEMENTATION_TERMS = Object.freeze([
  'rein_',
  'tool_call',
  'narration',
  'delivery',
  'model_relayed',
  'model-relayed',
  'official',
  'finalized',
  'existing_finalized',
  'settled',
  'repeated',
  'authorizesspending',
  'abstaincount',
  'totalballots',
  'winnertitle',
  'candidateproposals',
  'pollid',
]);
/**
 * A stored identifier: a contact, proposal or poll identifier is a UUID, and the tool's own note
 * never carries one. A sentence with an identifier in it is refused rather than delivered, so a voter
 * or a record cannot reach a spoken reply through this path.
 */
const IDENTIFIER_SHAPED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Read the recorded count the tool published for the recorded winner, or null when the answer does
 * not carry one.
 *
 * The figure is read only from the recorded winner's own entry: `narration.counts` is the tool's
 * per-proposal count map, keyed by the stored proposal id, and the value at the recorded winner's id
 * is that winner's own count. A missing map, a missing entry and a value that is not a non-negative
 * safe integer are all refusals, never a count of 0, so a sentence cannot be delivered with a figure
 * the answer did not publish. Nothing here reads a ballot count: `totalBallots` and `abstainCount`
 * are separate recorded totals.
 */
const readWinnerCount = (
  narration: Record<string, unknown>,
  winnerId: string,
): number | null => {
  const counts = narration.counts;
  if (!isRecord(counts)) return null;
  const value = counts[winnerId];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
};

export interface PollReplyGuardOptions {
  /** Injectable clock for deterministic tests; defaults to the wall clock. */
  now?: () => number;
  /** Injectable sweep interval in milliseconds; defaults to the module TTL. */
  ttlMs?: number;
  /** Injectable bound on remembered runs; defaults to the module bound. */
  maxEntries?: number;
  /**
   * Identity of the remembered-sentence store this instance reads and writes. Omit it (the
   * production case) to use the plugin's own process-wide slot, which is what lets a result armed by
   * the `after_tool_call` hook of one loaded module graph be found by the `reply_payload_sending`
   * hook of another graph in the same process. A string or symbol names one store inside this
   * process, shared by every instance that passes the same key and separated from every other key; a
   * string is interned with `Symbol.for`, so the same text names the same store in every module
   * graph. `null` keeps this instance's memory to itself, which is what a test that wants an
   * isolated store passes.
   */
  stateKey?: string | symbol | null;
}

export interface PollReplyGuard {
  /**
   * `api.on('after_tool_call', ...)`: notice one recognized `rein_poll_result` answer - a
   * validated closed-round sentence, or a guard-built open-round clarification from the frozen
   * candidate titles - or drop a remembered sentence when a closing write is observed in the same
   * run. Both a direct call and a Tool Search dispatch of any of those tools are recognized; a
   * dispatch is unwrapped through the host's own tool identity.
   */
  afterToolCall(event: PluginHookAfterToolCallEvent, ctx?: PluginHookToolContext): void;
  /**
   * `api.on('reply_payload_sending', ...)`: replace the one final payload of the same run with the
   * remembered sentence while preserving every other property, or hand back the payload unchanged.
   */
  replyPayloadSending(
    event: PluginHookReplyPayloadSendingEvent,
    ctx?: unknown,
  ): PluginHookReplyPayloadSendingResult | undefined;
  /**
   * Number of runs currently remembered in this guard's store; exposed for tests and for leak
   * checks. With the default shared store this counts the whole process's entries for this guard, not
   * just the ones this instance armed.
   */
  pendingCount(): number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One remembered sentence, with the moment it stops being replaceable. */
interface PollReplyPendingEntry {
  note: string;
  expiresAt: number;
}

/**
 * The remembered-sentence store: one entry per run, oldest first so the bound drops the oldest run.
 * When it is shared it is one object on `globalThis`, and the entries map is reached through that
 * object rather than being held by the guard instance; every read and write below is identical
 * whether the store is shared or private.
 */
interface PollReplyPendingStore {
  version: number;
  entries: Map<string, PollReplyPendingEntry>;
}

/** True only for a store this module created and whose remembered shape it can still read. */
const isPendingStore = (value: unknown): value is PollReplyPendingStore =>
  isRecord(value) && value.version === POLL_REPLY_GUARD_STORE_VERSION && value.entries instanceof Map;

/**
 * Resolve the store one guard instance reads and writes. An omitted key is the plugin's own
 * process-wide slot, which is the production case: two loaded module graphs each build a guard, and
 * the arm from one must be readable by the other. `null` asks for private memory, and a string or
 * symbol names one shared store among the instances that pass it. A slot holding something this
 * module did not write, or a store from another shape version, is replaced rather than read, and both
 * the read and the write are guarded: an environment where `globalThis` cannot carry this property
 * falls back to private memory, so a hostile or unusual host cannot turn this into a registration
 * failure or a throw.
 */
const resolvePendingStore = (
  stateKey: string | symbol | null | undefined,
): PollReplyPendingStore => {
  const freshStore = (): PollReplyPendingStore => ({
    version: POLL_REPLY_GUARD_STORE_VERSION,
    entries: new Map(),
  });
  if (stateKey === null) return freshStore();
  const key: PropertyKey =
    stateKey === undefined
      ? Symbol.for(POLL_REPLY_GUARD_SHARED_STATE_KEY)
      : typeof stateKey === 'string'
        ? Symbol.for(stateKey)
        : stateKey;
  try {
    const holder = globalThis as unknown as Record<PropertyKey, unknown>;
    const existing = holder[key];
    if (isPendingStore(existing)) return existing;
    const created = freshStore();
    holder[key] = created;
    return created;
  } catch {
    return freshStore();
  }
};

const asText = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
};

/**
 * Read the structured answer out of a tool outcome. The host may hand back the tool's structured
 * `details`, the result object itself, or a JSON text block, so all three shapes are accepted; a
 * shape this guard does not recognize yields null and therefore no replacement.
 */
const readAnswer = (result: unknown): Record<string, unknown> | null => {
  if (!isRecord(result)) return null;
  const direct = result.details;
  if (isRecord(direct)) return direct;
  const content = result.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') continue;
      try {
        const parsed: unknown = JSON.parse(part.text);
        if (isRecord(parsed)) return parsed;
      } catch {
        // Not the structured answer; keep looking and refuse if nothing else matches.
      }
    }
  }
  return null;
};

/**
 * Resolve the tool that actually produced one `after_tool_call` observation, and the outcome to read
 * from it, when the observation is a Tool Search dispatch.
 *
 * On a live Gateway the result tool and the clearing writes run through Tool Search: the host
 * exposes one outer dispatcher literally named `tool_call`, and the guest runs inside it. The outer
 * event's `toolName` is therefore the dispatcher's, and the model-authored `params` may name any tool
 * at all, so the identity of what ran is taken only from the host's own body. That body is
 * `{ ...controlResult, details: callResult }`, and `callResult` is
 * `{ tool: { id, name, source }, result }` where `tool` comes from the catalog entry the runtime
 * resolved and `result` is the guest outcome. This returns that guest outcome, and null for anything
 * else: a non-dispatcher call, a dispatcher envelope that does not name one of this guard's tools, or
 * a body whose host identity or guest outcome is missing.
 */
const unwrapToolSearchDispatch = (
  result: unknown,
): { toolName: string; result: unknown } | null => {
  if (!isRecord(result)) return null;
  const details = result.details;
  if (!isRecord(details)) return null;
  const tool = details.tool;
  const innerName = isRecord(tool) && typeof tool.name === 'string' ? tool.name : null;
  if (innerName === null || !(POLL_REPLY_GUARD_TOOL_NAMES as readonly string[]).includes(innerName)) {
    return null;
  }
  const inner = details.result;
  if (!isRecord(inner)) return null;
  return { toolName: innerName, result: inner };
};

/** True when a member-facing sentence carries no implementation term and no stored identifier. */
const isSpeakableNote = (note: string): boolean => {
  const lowered = note.toLowerCase();
  for (const term of IMPLEMENTATION_TERMS) {
    if (lowered.includes(term)) return false;
  }
  return !IDENTIFIER_SHAPED.test(note);
};

/**
 * True when the answer is the tool's own open-round read. Such a read is answered with the guard's own
 * clarification rather than the model's prose, and a run that contains one is a run whose reply is
 * about the open round, so a sentence armed earlier in the same run is dropped rather than delivered
 * over it.
 *
 * A provisional read holds no outcome at all: the round has not closed and no figure has been
 * counted, so the tool's own provisional answer carries `outcome: null`. A narration that says
 * `provisional` and also claims a recorded outcome is self-contradictory, and the guard refuses it
 * rather than narrate an outcome it cannot vouch for.
 *
 * The whole `provisional` envelope has to agree before this is trusted, because this is the one shape
 * the guard admits while the host is flagging the call as an error (see `isProvisionalToolErrorShape`
 * and the `after_tool_call` reader): the tool builds a provisional read with `ok: false`, `status:
 * provisional`, `error: provisional`, no outcome and no finalized flag, so an envelope that claims any
 * of those otherwise is not the tool's own open-round read and is refused.
 */
const isProvisionalRead = (answer: Record<string, unknown>): boolean =>
  answer.tool === POLL_RESULT_GUARD_TOOL_NAME &&
  answer.ok === false &&
  answer.status === 'provisional' &&
  isRecord(answer.narration) &&
  answer.narration.kind === 'provisional' &&
  answer.narration.outcome === null &&
  answer.narration.finalized === false;

/**
 * The error code the tool stamps on its own open-round read. The host treats any truthy
 * `details.error`, or `ok: false`, as a tool error (`isToolResultError` in
 * `vendor/openclaw/src/agents/embedded-agent-subscribe.handlers.tool-result-error.ts`), so
 * `after_tool_call` carries a non-empty `event.error` for a *successful* provisional read - the
 * envelope answers "the round is still open", which the host reports like any other failed call. That
 * reason code is what tells a live provisional read apart from every genuine tool error.
 */
const PROVISIONAL_ERROR_CODE = 'provisional';

/**
 * True only for the host-reported error of a live provisional read: the exact `provisional` code the
 * tool stamps on that one envelope. Any other error - a real failure, a validation error, an empty or
 * unknown code - is a call this guard must not read an answer from, so it stays fail-open.
 */
const isProvisionalToolError = (error: unknown): boolean =>
  typeof error === 'string' && error.trim() === PROVISIONAL_ERROR_CODE;

/**
 * Read the frozen candidate titles the tool reported for an open round, in the order it reported them,
 * or null when the guard cannot vouch for a list it would put in front of a director.
 *
 * The only thing taken from the answer is each candidate's stored `title`: never the `proposalId`,
 * which is a stored identifier and must not reach a spoken reply, and never a voter. The tool reports
 * the pool it froze for the round, so the order here is the frozen order and the numbers a director
 * reads map back to that same order. A title the database could not answer for is reported as null and
 * makes the whole list unusable - no title is ever invented or filled in - and `candidateTitlesResolved`
 * has to agree. `ambiguousCandidateTitles` and a second, local title comparison both mark a pool in
 * which two candidates cannot be told apart by name, which is exactly the case case 6 must ask about
 * rather than resolve by number.
 */
const readFrozenTitles = (answer: Record<string, unknown>): string[] | null => {
  const narration = isRecord(answer.narration) ? answer.narration : null;
  if (!narration) return null;
  const raw = Array.isArray(narration.candidateProposals) ? narration.candidateProposals : null;
  if (raw === null || raw.length === 0) return null;
  if (raw.length > MAX_PROVISIONAL_CANDIDATES) return null;
  // The tool's own summary flag has to agree with what the rows say: an unreadable pool is asked
  // about, never printed as if every title had resolved.
  if (narration.candidateTitlesResolved !== true) return null;
  const ambiguous = Array.isArray(narration.ambiguousCandidateTitles)
    ? narration.ambiguousCandidateTitles.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (ambiguous.length > 0) return null;
  const titles: string[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const title = asText(entry.title, MAX_CANDIDATE_TITLE_LENGTH);
    if (title === null) return null;
    titles.push(title);
  }
  // Two frozen candidates whose titles compare equal cannot be told apart by a number the director
  // reads, so the guard asks which one is meant instead of listing both under one name. This repeats
  // the tool's own comparison rather than trusting the flag alone.
  const seen = new Set<string>();
  for (const title of titles) {
    const key = title.replace(/\s+/gu, ' ').toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
  }
  return titles;
};

/**
 * Build the open-round clarification this guard delivers, or null when the answer is not a recognized
 * provisional read with a usable frozen pool. The copy is the guard's own: the frozen candidate titles
 * in order as a numbered list, one generic clause that names no winner and no count, and one
 * instruction to answer with a number or to abstain. It never carries an identifier, a voter, a
 * participation figure or the tool's outcome wording.
 */
const buildProvisionalText = (answer: Record<string, unknown>): string | null => {
  if (answer.tool !== POLL_RESULT_GUARD_TOOL_NAME) return null;
  if (!isRecord(answer.narration) || answer.narration.kind !== 'provisional') return null;
  // A provisional read is not an outcome, and it publishes no participation figure, so this stays
  // fail-closed on an answer that claims otherwise.
  if (answer.ok === true) return null;
  // An open window and a round that never opened (a cancelled one) both read back with no outcome;
  // either is answered with the same open-round clarification.
  const titles = readFrozenTitles(answer);
  const lines: string[] = [PROVISIONAL_OPEN_LEAD];
  if (titles === null) {
    lines.push(PROVISIONAL_UNCLEAR_INSTRUCTION);
  } else {
    lines.push('这一轮的候选如下：');
    titles.forEach((title, index) => {
      lines.push(`${index + 1}. ${title}`);
    });
    lines.push(PROVISIONAL_SELECT_INSTRUCTION);
  }
  const text = lines.join('\n');
  return text.length > MAX_POLL_NOTE_LENGTH ? null : text;
};

/**
 * Read a sentence this guard may deliver, or null when the answer is not the recognized shape or the
 * sentence cannot be vouched for. Every check here is a refusal, never a rewrite: the sentence that
 * is delivered is the tool's own, byte for byte.
 */
const readNote = (answer: Record<string, unknown>): string | null => {
  if (answer.tool !== POLL_RESULT_GUARD_TOOL_NAME) return null;
  const narration = isRecord(answer.narration) ? answer.narration : null;
  if (!narration) return null;
  const note = asText(narration.note, MAX_POLL_NOTE_LENGTH);
  if (note === null) return null;
  if (!isSpeakableNote(note)) return null;

  // Only a closed round's recorded outcome is read here. An open round answers `provisional` with the
  // frozen candidates instead of an outcome and is answered by `buildProvisionalText` rather than by
  // the tool's own outcome wording, so a provisional kind never reaches this reader.
  if (narration.kind !== 'final') return null;
  // A final note is an outcome: the answer is the database's own recorded result, and the sentence
  // states the standing of that record.
  if (answer.ok !== true) return null;
  const outcome = narration.outcome;
  if (outcome !== 'winner' && outcome !== 'no_winner') return null;
  // A decision record moves no money, and the sentence has to say so.
  if (!note.includes(NO_FUNDS_SENTENCE)) return null;

  if (outcome === 'winner') {
    // The recorded winner is a stored proposal identifier; the sentence names it by its stored title
    // when the database could answer for one, and the tool's own fallback wording stands in when it
    // could not. Either way the round is never read as one without a winner.
    if (typeof narration.winner !== 'string' || narration.winner.length === 0) return null;
    if (note.includes(NO_WINNER_PHRASE)) return null;
    // Case 7 requires the winner and its count together, so the sentence has to carry the count clause
    // exactly once. No clause means the delivered reply would omit the figure entirely - the gap this
    // check closes - and a repeated clause leaves a count sitting next to the wrong candidate.
    const countClauses = note.match(WINNER_COUNT_CLAUSE_PATTERN);
    if (!countClauses) return null;
    const allCountClauses = note.match(
      new RegExp(WINNER_COUNT_CLAUSE_PATTERN.source, 'g'),
    ) as string[] | null;
    if (!allCountClauses || allCountClauses.length > WINNER_COUNT_CLAUSE_LIMIT) return null;
    const winnerTitle = asText(narration.winnerTitle, MAX_POLL_NOTE_LENGTH);
    if (winnerTitle !== null && !note.includes(winnerTitle)) return null;
    // The figure the sentence prints has to be the count the tool published for that same winner, so
    // a sentence cannot name one candidate beside another candidate's count; and a count the answer
    // does carry has to reach the director, because the tool prints its count-recorded fallback only
    // when the record itself cannot say how many approvals the winner took.
    const recordedCount = readWinnerCount(narration, narration.winner);
    const printedCount = countClauses[1];
    if (printedCount !== undefined) {
      if (recordedCount === null || String(recordedCount) !== printedCount) return null;
    } else if (recordedCount !== null) {
      return null;
    }
    return note;
  }

  // A recorded no-winner outcome names no winner and no winning title, and it must not name any
  // candidate either: a tie and an all-abstain round are both recorded this way, the record carries
  // no cause, and the tie rule is still unconfirmed, so naming a candidate would claim something the
  // record cannot support.
  if (narration.winner !== null || narration.winnerTitle !== null) return null;
  if (!note.includes(NO_WINNER_PHRASE)) return null;
  if (!note.includes(UNCONFIRMED_RULE_PHRASE)) return null;
  // A no-winner record holds no winner, so its sentence carries no highest-approval lead, no count
  // clause and no candidate's count. A tie and an all-abstain round are both recorded this way and the
  // record carries no cause, so a tally printed beside "no winner" would claim a standing the record
  // cannot support.
  if (note.includes(WINNER_LEAD) || note.match(WINNER_COUNT_CLAUSE_PATTERN)) return null;
  const candidates = Array.isArray(narration.candidateProposals) ? narration.candidateProposals : [];
  for (const entry of candidates) {
    const title = isRecord(entry) ? asText(entry.title, MAX_POLL_NOTE_LENGTH) : null;
    if (title !== null && note.includes(title)) return null;
  }
  return note;
};

/** Read the text off a payload, or null when it carries none. */
const readPayloadText = (payload: PluginHookReplyPayload): string | null =>
  isRecord(payload) && typeof payload.text === 'string' ? payload.text : null;

/**
 * Build the outbound poll-result guard. Register the two hooks it returns:
 *
 * ```ts
 * const guard = createPollReplyGuard();
 * api.on('after_tool_call', guard.afterToolCall, { matcher: [...POLL_REPLY_GUARD_TOOL_NAMES] });
 * api.on('reply_payload_sending', guard.replyPayloadSending);
 * ```
 */
export function createPollReplyGuard(options?: PollReplyGuardOptions): PollReplyGuard {
  const now = typeof options?.now === 'function' ? options.now : () => Date.now();
  const ttlMs =
    typeof options?.ttlMs === 'number' && Number.isFinite(options.ttlMs) && options.ttlMs >= 0
      ? options.ttlMs
      : POLL_REPLY_GUARD_TTL_MS;
  const maxEntries =
    typeof options?.maxEntries === 'number' &&
    Number.isSafeInteger(options.maxEntries) &&
    options.maxEntries >= 1
      ? options.maxEntries
      : POLL_REPLY_GUARD_MAX_ENTRIES;
  /**
   * Remembered sentences per run, ordered oldest first so the bound drops the oldest entry. The map
   * belongs to the store, not to this instance: two loaded module graphs each build a guard, and the
   * arming hook and the reply hook can land in different graphs, so they have to meet on one map.
   */
  const pending = resolvePendingStore(options?.stateKey).entries;

  const sweep = () => {
    const at = now();
    for (const [runId, entry] of pending) {
      if (entry.expiresAt <= at) pending.delete(runId);
    }
    while (pending.size > maxEntries) {
      const oldest = pending.keys().next();
      if (oldest.done) break;
      pending.delete(oldest.value);
    }
  };

  const afterToolCall = (event: PluginHookAfterToolCallEvent, ctx?: PluginHookToolContext): void => {
    try {
      if (!isRecord(event)) return;
      const observedToolName =
        typeof event.toolName === 'string'
          ? event.toolName
          : typeof ctx?.toolName === 'string'
            ? ctx.toolName
            : '';
      // Tool Search reports the outer dispatcher's name, so the identity of the tool that actually
      // ran is read from the host's own envelope. `params.id` is deliberately never consulted: the
      // model writes it, and a spoofed id must not be able to arm or clear the guard.
      const dispatched =
        observedToolName === TOOL_SEARCH_DISPATCHER_TOOL_NAME
          ? unwrapToolSearchDispatch(event.result)
          : null;
      const toolName = dispatched ? dispatched.toolName : observedToolName;
      // A `tool_call` dispatch of one of this guard's tools, or a direct call to one of them, is the
      // only thing that counts as a match; every other tool is ignored here.
      if (!(POLL_REPLY_GUARD_TOOL_NAMES as readonly string[]).includes(toolName)) return;
      const result = dispatched ? dispatched.result : event.result;
      const runIdRaw = typeof event.runId === 'string' ? event.runId : ctx?.runId;
      const runId = typeof runIdRaw === 'string' && runIdRaw.trim() ? runIdRaw.trim() : null;
      // A write in the same run closes it: that run's reply is the write outcome, so any remembered
      // sentence is dropped before the outcome is even read. This happens whether the write succeeded
      // or failed, so neither can be masked by the round narration, and it arms nothing of its own.
      // Without a run id there is no entry to correlate, so this stays fail-open.
      if (toolName !== POLL_RESULT_GUARD_TOOL_NAME) {
        if (runId) pending.delete(runId);
        return;
      }
      const hasError = event.error !== undefined && event.error !== null && event.error !== '';
      const answer = readAnswer(result);
      if (!answer) return;
      // An open round's read is answered with the guard's own clarification rather than the model's
      // prose, and it is what a run's reply is about when a director still has to pick between
      // candidate titles. A sentence armed earlier in this run by a closed round is replaced, not
      // delivered over it, and a provisional read whose frozen pool the guard cannot vouch for still
      // replaces it with the "candidates unclear" clarification, so the run never falls back to the
      // model's own reply.
      const provisionalRead = isProvisionalRead(answer);
      // The host flags a live provisional read as a failed call, because the envelope answers
      // `ok: false` with an error code; that is the one error this guard still reads through. The
      // pair has to agree - the exact `provisional` code *and* the fully validated provisional shape -
      // so a real tool error, an unknown error code, or an envelope that only looks provisional
      // arms nothing.
      if (hasError && !(provisionalRead && isProvisionalToolError(event.error))) return;
      if (provisionalRead) {
        const provisionalText = buildProvisionalText(answer);
        if (provisionalText === null) {
          if (runId) pending.delete(runId);
          return;
        }
        // Without a run to correlate the two hooks there is nothing safe to do; leave the reply alone.
        if (!runId) return;
        sweep();
        pending.delete(runId);
        pending.set(runId, { note: provisionalText, expiresAt: now() + ttlMs });
        return;
      }
      const note = readNote(answer);
      if (note === null) return;
      // Without a run to correlate the two hooks there is nothing safe to do; leave the reply alone.
      if (!runId) return;
      sweep();
      pending.delete(runId);
      pending.set(runId, { note, expiresAt: now() + ttlMs });
    } catch {
      // A guard that throws must not change the tool path: remember nothing for this call.
    }
  };

  const replyPayloadSending = (
    event: PluginHookReplyPayloadSendingEvent,
    _ctx?: unknown,
  ): PluginHookReplyPayloadSendingResult | undefined => {
    try {
      if (!isRecord(event)) return undefined;
      if (event.kind !== POLL_GUARD_FINAL_KIND) return undefined;
      if (event.channel !== POLL_GUARD_CHANNEL) return undefined;
      const runId = typeof event.runId === 'string' ? event.runId.trim() : '';
      if (!runId) return undefined;
      sweep();
      const entry = pending.get(runId);
      if (!entry) return undefined;
      // One sentence is delivered once: a later payload in the same run is delivered untouched.
      pending.delete(runId);
      const payload = event.payload;
      if (!isRecord(payload) || readPayloadText(payload) === null) return undefined;
      // Spread the original payload and replace only its text, so media, metadata, threading and
      // every other property the host set stay exactly as they were.
      return { payload: { ...payload, text: entry.note } };
    } catch {
      // Fail open by design: an unusable event or an unexpected shape leaves the payload exactly as
      // the host made it and delivery proceeds. Nothing is suppressed, and the guard makes no claim
      // about internal vocabulary in a reply it did not rebuild.
      return undefined;
    }
  };

  return {
    afterToolCall,
    replyPayloadSending,
    pendingCount: () => {
      sweep();
      return pending.size;
    },
  };
}
