// Outbound reply guard for the ballot tool (case 6).
//
// Why this exists. A successful `rein_poll_vote` answers the caller with a structured object that
// carries implementation vocabulary on purpose: the stored poll identifier, the recorded approval
// count, the abstention flag, the flags that the record was written (`recorded`, `replaced`) and that
// it authorizes no spending, plus a reason code on a refused ballot. Those fields are right for the
// caller that acts on them, but `docs/agent-test-cases-zh.md` case 6 only asks a director to hear that
// the ballot was recorded, how many proposals they approved (or that the abstention is recorded), and
// that the record moves no money - never a field name, a tool name, a proposal or poll identifier, or
// a voter. Live acceptance replies kept leaking those identifiers and field names
// (`runtime/case6-clean-acceptance-evidence.md`, section 8.6), and prompt text alone held no better
// here than it did for the sibling collect flow (case 3). This guard therefore builds the
// member-facing wording itself from the verified figures and delivers it as that run's final reply.
//
// What it does, and what it deliberately leaves alone. Two host hooks, matched to the ballot tool, to
// the round-read tool it may follow, to every other tool this governance entry registers, and to the Tool
// Search dispatcher `tool_call`, all correlated by one `runId`:
// - `after_tool_call` runs a small per-run state machine over the calls it observes. Case 6 asks a
//   director to name a candidate by its spoken title, and the title-to-id mapping is only visible from
//   a round read, so one run may hold exactly one *verified provisional* round read
//   (`rein_poll_result` answering `ok: false`, `status: 'provisional'`, `error: 'provisional'`, and
//   a `provisional` narration with `outcome: null` and `finalized: false`, whether the host reports the
//   call with the tool's own `provisional` code, with no error at all, or with the generic `failed` it
//   stamps on an `ok: false` answer) followed by exactly one
//   *verified successful* ballot - or the ballot alone, with no read at all. A verified success is the
//   tool's own recorded answer: `tool === 'rein_poll_vote'`, `ok === true`, `recorded === true`, an
//   `approvalCount` that is a non-negative safe integer inside the tool's own approval fence,
//   `abstained` that agrees with the count (`abstained === (approvalCount === 0)`), `replaced === false`,
//   `authorizesSpending === false`, and no error on the answer or the host event. When the read names a
//   stored round and the ballot names one too, the two have to be the same round; a read that cannot
//   name its round is still accepted, and the ballot's own answer is the only thing the delivered
//   sentence is built from. Anything else - a failed ballot, an error answer, the read and the ballot in
//   the other order, a second read, a sibling tool, or any third call - remembers no text for the run
//   and marks it disqualified, so the run's reply is delivered exactly as the host made it.
//
// One call, two channels. A live Gateway reports a single business call to `after_tool_call` twice:
// once under the tool's own name and once inside the Tool Search `tool_call` envelope, both carrying the
// same guest outcome (`runtime/openclaw/tmp/gateway.log:1469-1472` shows the pair for the sibling
// collect tool). Counting those as two calls disqualified every live case-6 turn and let the model's own
// prose reach the director, so an observation that arrives on the other channel from the last counted
// one is recognized as that call reported again and is not counted - but only when the two agree on the
// tool and carry the same *verified* answer (the ballot's own sentence and round, or the round read's own
// round). That agreement is what tells a re-report apart from a second genuine call, and it is read from
// the tool's own answer rather than from any tool-call identifier the host passes. A second observation
// on the *same* channel, a repeat of an already-paired call, and a second call whose answer differs are
// all still second calls, so they disqualify the run exactly as before.
// - `reply_payload_sending` fires for the same run, on the Slack surface, when the host is about to
//   deliver the turn's final reply. That one payload's text is replaced with the remembered wording;
//   every other property of the payload is preserved by spreading the original, and the payload object
//   received from the host is never mutated in place. The preparatory read deliberately arms nothing on
//   its own here: this guard's reply is the ballot's sentence or nothing at all.
//
// Nothing else is touched. Another run, a non-Slack surface, a non-final dispatch kind (progress output
// and tool messages), a run with no usable correlation, a run whose observed call was a failure, a run
// that observed a different tool or a different call order, and a payload without text all leave the
// payload exactly as the host supplied it. The preparatory read is the poll guard's own tool, so the two
// guards are correlated but independent: the poll guard arms its open-round clarification for the read
// and then clears it when the ballot arrives, while this guard arms only the ballot's sentence, so the
// delivered reply is this guard's wording and never the model's prose. No reply is ever sent from here:
// the guard only edits the text of a payload the host was already going to deliver, and it never calls a
// Slack API, the database or a model.
//
// The wording is the guard's own, never the model's prose. It names no identifier, no voter and no
// internal field, and each sentence is fixed apart from the one approval count, which is printed only
// from the verified integer. The abstention sentence states both that the abstention was recorded and
// that no approval was cast, and every sentence ends with the same clause the case-6 expectation and
// the tool's own description carry: this record moves no money.
//
// Memory. One entry per run, consumed on first use, and every entry expires after a fixed TTL, so a run
// whose reply never arrives, or a stream of unrelated runs, cannot grow this state without bound. The
// entry carries the run's place in the two-step chain, so a run waiting on the ballot after its one
// preparatory read is remembered just as an armed run is, and a disqualified run is remembered too (with
// no text) - that is what stops a later ballot in the same run from arming a reply over a turn the guard
// already declined to judge. The entries live in one
// store shared by every loaded copy of this module in the process (see
// `VOTE_REPLY_GUARD_SHARED_STATE_KEY`), because a live Gateway loads this plugin more than once and the
// two hooks above can run in different copies; a per-instance map put the arm in one copy and left the
// reply hook looking in the other, empty copy. Sharing changes only who can read an entry, not what is
// remembered: the store is still bounded, still swept on every hook call, and still confined to one
// process. The key is this module's own, so a remembered ballot, a remembered collect and a remembered
// round result can never be read as each other. A caller that asks for isolation (`stateKey: null`)
// gets private memory instead.
//
// Open versus closed, stated plainly. This is a reply-rewriting guard, not an authorization gate, so
// every refusal path here is deliberately open: an event shape the guard does not recognize, a payload
// it cannot read, an answer it cannot vouch for, or a thrown error leaves the host's own payload exactly
// as it was and lets delivery proceed. The guard never suppresses, delays or replaces a reply it cannot
// rebuild; the only thing refused is the unsafe rewrite itself. A payload handed through by a refusal
// may still carry internal vocabulary, so this guard is a floor on what one known tool's final reply
// says, not a blanket guarantee about every payload the host delivers.

import type {
  PluginHookAfterToolCallEvent,
  PluginHookReplyPayload,
  PluginHookReplyPayloadSendingEvent,
  PluginHookReplyPayloadSendingResult,
  PluginHookToolContext,
} from 'openclaw/plugin-sdk/plugin-entry';

/** The ballot tool this guard observes and may rewrite the reply of. */
export const VOTE_GUARD_TOOL_NAME = 'rein_poll_vote';
/**
 * The Tool Search dispatcher the host reports when the ballot tool, or any other observed tool below,
 * runs through Tool Search. It is matched, not trusted: its identity is only read from the host's own
 * `result.details.tool`, so admitting the dispatcher to the matcher arms nothing by itself.
 */
export const TOOL_SEARCH_DISPATCHER_TOOL_NAME = 'tool_call';
/**
 * The round-read tool a single ballot may follow in the same run. Case 6 asks a director to approve a
 * candidate by its spoken title, and the title-to-id mapping comes from a round read, so this one read
 * is the guard's one legal step before the ballot. Only a *verified provisional* read counts (see
 * {@link readProvisionalRead}); a closed-round read, a malformed read and a read carrying any other
 * error is a refusal. A unit test ties the name to the poll guard's own constant for the same tool.
 */
export const POLL_RESULT_READ_TOOL_NAME = 'rein_poll_result';
/**
 * The one tool name the state machine treats as a legitimate preparatory step, and only in its one
 * allowed place: before the ballot.
 */
export const VOTE_REPLY_GUARD_PREPARATORY_TOOL_NAMES = Object.freeze([POLL_RESULT_READ_TOOL_NAME]);
/**
 * Every other tool this governance entry registers. One of these observed anywhere in the run makes the turn
 * one whose reply covers more than a single ballot, so the run is disqualified rather than rewritten
 * with single-ballot wording. Listing the sibling *read* tools as well as the writes is deliberate: the
 * boundary is "one provisional read and then the ballot, or the ballot alone", and a reply that also
 * reports a status, a funds snapshot or a candidate list is not a ballot confirmation. The entries
 * mirror the name lists the tool modules export, and a unit test keeps the two tied so the wiring cannot
 * drift. `rein_status` is registered in governance mode too, so it is listed as well.
 */
export const VOTE_REPLY_GUARD_OTHER_TOOL_NAMES = Object.freeze([
  'rein_status',
  'rein_member_status',
  'rein_funds',
  'rein_poll_candidates',
  'rein_vote_type_resolve',
  'rein_governance_proposal_submit',
  'rein_poll_open',
  'rein_proposal_collect',
  'rein_proposal_comment_suggest',
  'rein_revision_approve',
  'rein_revision_apply',
]);
/**
 * Every tool name the `after_tool_call` matcher must admit, so the entry wiring cannot drift: the ballot
 * tool for a direct (non-Tool-Search) call, the one preparatory read, the disqualifying siblings, plus
 * the dispatcher for a Tool Search call (which in a live Gateway carries every tool, so a second or
 * third call disqualifies the run even when its guest name is not one this guard knows).
 */
export const VOTE_REPLY_GUARD_TOOL_NAMES = Object.freeze([
  VOTE_GUARD_TOOL_NAME,
  ...VOTE_REPLY_GUARD_PREPARATORY_TOOL_NAMES,
  ...VOTE_REPLY_GUARD_OTHER_TOOL_NAMES,
  TOOL_SEARCH_DISPATCHER_TOOL_NAME,
]);
/** The one transport surface this guard rewrites on. */
export const VOTE_GUARD_CHANNEL = 'slack';
/** The one dispatch kind this guard rewrites: the turn's final reply, not progress or tool output. */
export const VOTE_GUARD_FINAL_KIND = 'final';
/** How long a remembered reply stays replaceable before it is swept, in milliseconds. */
export const VOTE_REPLY_GUARD_TTL_MS = 5 * 60 * 1000;
/** How many runs may be remembered at once; the oldest entry is dropped past this bound. */
export const VOTE_REPLY_GUARD_MAX_ENTRIES = 64;
/**
 * Longest approval count this guard will print. It is the same 200-entry cap the ballot tool's own
 * `approvedProposalIds` schema enforces (`MAX_APPROVALS` in `governance-write-tools.ts`), so a count the tool
 * accepted is never refused here, and a hostile answer cannot make the guard print a number the slice
 * could not have recorded. A unit test keeps this fence tied to the tool's own cap.
 */
export const MAX_VOTE_APPROVAL_COUNT = 200;
/**
 * Process-wide key of the remembered-reply store. A live Gateway loads this plugin more than once: two
 * byte-identical build trees, each with its own bundled module graph and its own copy of this module,
 * both call {@link createVoteReplyGuard}, and the `after_tool_call` hook that arms and the
 * `reply_payload_sending` hook that reads can land in different copies. A `Map` created inside one
 * module graph is invisible to the other, so the arm and the reply never meet. The store therefore
 * lives on `globalThis` under an interned symbol, the same process-global pattern OpenClaw uses for its
 * own plugin registry state (`vendor/openclaw/src/plugins/runtime-state.ts`). The `.v1` suffix versions
 * the slot so a future change to the remembered shape takes a new name instead of reading a stale one,
 * and a slot whose contents do not match this module's own shape is replaced rather than trusted. The
 * key is distinct from the collect guard's and the poll guard's slots, so the three guards can never
 * read each other's entry.
 */
export const VOTE_REPLY_GUARD_SHARED_STATE_KEY =
  '@rein-protocol/openclaw-rein-operations.governance-vote-reply-guard.v1';
/** Shape version of one store: a store carrying any other version is replaced, not read. */
const VOTE_REPLY_GUARD_STORE_VERSION = 1;

/**
 * The sentence a recorded approval gets, with the verified count substituted. It is the whole
 * member-facing copy for a ballot that approved at least one proposal, and it names no identifier and
 * no field. A unit test pins the literal.
 */
export const VOTE_REPLY_APPROVAL_TEMPLATE = '你的投票已记录。你赞成了 {count} 个提案。';
/**
 * The sentence a recorded abstention gets: the abstention is recorded, and no approval was cast. A
 * unit test pins the literal.
 */
export const VOTE_REPLY_ABSTENTION_SENTENCE = '你的弃权已记录；你没有投赞成票。';
/**
 * The clause every delivered ballot sentence ends with: a stored decision record moves no money. It is
 * the same standing the ballot tool's own description carries, and a unit test keeps this fence tied to
 * that description.
 */
export const VOTE_REPLY_NO_FUNDS_SENTENCE = '这条投票记录不移动资金。';

export interface VoteReplyGuardOptions {
  /** Injectable clock for deterministic tests; defaults to the wall clock. */
  now?: () => number;
  /** Injectable sweep interval in milliseconds; defaults to the module TTL. */
  ttlMs?: number;
  /** Injectable bound on remembered runs; defaults to the module bound. */
  maxEntries?: number;
  /**
   * Identity of the remembered-reply store this instance reads and writes. Omit it (the production
   * case) to use the plugin's own process-wide slot, which is what lets a ballot armed by the
   * `after_tool_call` hook of one loaded module graph be found by the `reply_payload_sending` hook of
   * another graph in the same process. A string or symbol names one store inside this process, shared
   * by every instance that passes the same key and separated from every other key; a string is interned
   * with `Symbol.for`, so the same text names the same store in every module graph. `null` keeps this
   * instance's memory to itself, which is what a test that wants an isolated store passes.
   */
  stateKey?: string | symbol | null;
}

export interface VoteReplyGuard {
  /**
   * `api.on('after_tool_call', ...)`: remember the member-facing reply for a run whose calls are one
   * verified provisional round read followed by one verified successful ballot, or one verified
   * successful ballot alone. Anything else - a failed ballot, an error, the two calls in the other
   * order, a second read, a sibling tool, or any third call - disqualifies the run. Both a direct call
   * and a Tool Search dispatch of any observed tool are recognized; a dispatch is unwrapped through the
   * host's own tool identity, and the two channels' adjacent reports of one call are counted once.
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
   * Number of runs currently remembered in this guard's store, disqualifications included; exposed for
   * tests and for leak checks. With the default shared store this counts the whole process's entries
   * for this guard, not just the ones this instance armed.
   */
  pendingCount(): number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Where a run stands in the one chain this guard accepts. `provisional` is a run that has made exactly
 * one verified provisional round read and may still be completed by one verified successful ballot;
 * `armed` holds the sentence to deliver; `disqualified` is every other run, remembered only so a later
 * call cannot revive it.
 */
type VoteReplyPhase = 'provisional' | 'armed' | 'disqualified';

/**
 * Which of the host's two report channels one observation arrived on: the tool's own name (`direct`) or
 * the Tool Search dispatcher's envelope (`dispatched`).
 */
type VoteObservationChannel = 'direct' | 'dispatched';

/**
 * One remembered run: its phase, the sentence when it is armed, the round the preparatory read named,
 * the last counted observation and the moment the entry stops being replaceable.
 */
interface VoteReplyPendingEntry {
  phase: VoteReplyPhase;
  /** The sentence this guard will deliver, set only in the `armed` phase. */
  text: string | null;
  /** The preparatory read's stored poll id, or null when that answer named none. */
  pollId: string | null;
  /** How many business calls this guard has counted in the run; a call's second channel is not one. */
  calls: number;
  /** The channel of the most recent counted observation, or null before the first one. */
  lastChannel: VoteObservationChannel | null;
  /**
   * Identity of the verified step the most recent counted observation carried - the ballot's own sentence
   * and round, or the round read's own round - or null when that call carried no verified step. Two
   * observations agree on one business call only when this matches.
   */
  lastSignature: string | null;
  /**
   * Whether the most recent counted call has already been recognized on its other channel. One call is
   * reported on two channels at most, so an observation after the pair is a further call and counts.
   */
  paired: boolean;
  expiresAt: number;
}

/**
 * The remembered-reply store: one entry per run, oldest first so the bound drops the oldest run. When
 * it is shared it is one object on `globalThis`, and the entries map is reached through that object
 * rather than being held by the guard instance; every read and write below is identical whether the
 * store is shared or private.
 */
interface VoteReplyPendingStore {
  version: number;
  entries: Map<string, VoteReplyPendingEntry>;
}

/** True only for a store this module created and whose remembered shape it can still read. */
const isPendingStore = (value: unknown): value is VoteReplyPendingStore =>
  isRecord(value) && value.version === VOTE_REPLY_GUARD_STORE_VERSION && value.entries instanceof Map;

/**
 * Resolve the store one guard instance reads and writes. An omitted key is the plugin's own
 * process-wide slot, which is the production case: two loaded module graphs each build a guard, and the
 * arm from one must be readable by the other. `null` asks for private memory, and a string or symbol
 * names one shared store among the instances that pass it. A slot holding something this module did not
 * write, or a store from another shape version, is replaced rather than read, and both the read and the
 * write are guarded: an environment where `globalThis` cannot carry this property falls back to private
 * memory, so a hostile or unusual host cannot turn this into a registration failure or a throw.
 */
const resolvePendingStore = (
  stateKey: string | symbol | null | undefined,
): VoteReplyPendingStore => {
  const freshStore = (): VoteReplyPendingStore => ({
    version: VOTE_REPLY_GUARD_STORE_VERSION,
    entries: new Map(),
  });
  if (stateKey === null) return freshStore();
  const key: PropertyKey =
    stateKey === undefined
      ? Symbol.for(VOTE_REPLY_GUARD_SHARED_STATE_KEY)
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

/**
 * Read the structured answer out of a tool outcome. The host may hand back the tool's structured
 * `details`, the result object itself, or a JSON text block, so all three shapes are accepted; a shape
 * this guard does not recognize yields null and therefore no replacement.
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
 * On a live Gateway the observed tools run through Tool Search: the host exposes one outer dispatcher
 * literally named `tool_call`, and the guest runs inside it. The outer event's `toolName` is therefore
 * the dispatcher's, and the model-authored `params` may name any tool at all, so the identity of what
 * ran is taken only from the host's own body. That body is `{ ...controlResult, details: callResult }`,
 * and `callResult` is `{ tool: { id, name, source }, result }` where `tool` comes from the catalog
 * entry the runtime resolved and `result` is the guest outcome. This returns that guest outcome, and
 * null for anything else: a non-dispatcher call, a dispatcher envelope that does not name one of the
 * tools this guard observes, or a body whose host identity or guest outcome is missing. A null here
 * means the outer dispatcher name itself is what the caller matches, which is what makes *any* other
 * dispatched tool disqualify the run.
 */
const unwrapToolSearchDispatch = (
  result: unknown,
): { toolName: string; result: unknown } | null => {
  if (!isRecord(result)) return null;
  const details = result.details;
  if (!isRecord(details)) return null;
  const tool = details.tool;
  const innerName = isRecord(tool) && typeof tool.name === 'string' ? tool.name : null;
  if (innerName === null || !(VOTE_REPLY_GUARD_TOOL_NAMES as readonly string[]).includes(innerName)) {
    return null;
  }
  const inner = details.result;
  if (!isRecord(inner)) return null;
  return { toolName: innerName, result: inner };
};

/** True for an error code the host or the tool stamped on the call, in any of its empty spellings. */
const hasErrorCode = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

/**
 * The tool's own error code for a provisional round read. A host that carries the answer's reason code
 * through stamps this on the event, so together with the validated envelope below it tells a
 * preparatory read apart from a real failure.
 */
const PROVISIONAL_ERROR_CODE = 'provisional';

/**
 * The generic failure code a host stamps on an `ok: false` answer when it does not carry the tool's own
 * reason code through: the answer's `ok: false` is read as a failed call, and the host's shared
 * terminal contract classifies a status it does not recognize as `failed`. That is the shape a live
 * Gateway reported for the provisional round read. This code is trusted only together with the fully
 * validated provisional answer shape below (see {@link readProvisionalRead}); on its own it is a real
 * failure, like any other host error.
 */
const HOST_FAILED_ERROR_CODE = 'failed';

/** Read the stored poll id off an answer, or null when the answer does not name a usable one. */
const readPollId = (answer: Record<string, unknown>): string | null =>
  typeof answer.pollId === 'string' && answer.pollId.trim() ? answer.pollId.trim() : null;

/**
 * True when a preparatory read and the ballot that followed it can be the same round. The correlation
 * only binds when both answers name a round; a read whose answer does not name a usable id is the same
 * round by default, because the guard then has nothing to compare and its wording comes from the ballot
 * alone.
 */
const samePoll = (readPollId: string | null, votePollId: string | null): boolean =>
  readPollId === null || votePollId === null || readPollId === votePollId;

/**
 * Read the member-facing sentence for one *verified* successful ballot, or null when the answer is not
 * that shape. Every check is a refusal, never a repair: the text delivered is built here from the
 * verified figures, and nothing is read from the model's own prose. The ballot's own stored round travels
 * back with the sentence so the state machine can bind it to the read that came before it.
 *
 * The verification is the tool's own recorded-answer shape, and each field has to agree with the
 * others: a ballot is a recorded success (`ok`, `recorded`), it is a first-time ballot (`replaced ===
 * false`), it authorizes no spending, its `approvalCount` is a non-negative safe integer inside the
 * tool's own approval fence, and its abstention flag matches the count (`abstained === (approvalCount
 * === 0)`). An answer that also carries a failure code is refused even when the success flags are set,
 * because no clean success carries one.
 */
const readVoteReply = (result: unknown): { text: string; pollId: string | null } | null => {
  const answer = readAnswer(result);
  if (!answer) return null;
  if (answer.tool !== VOTE_GUARD_TOOL_NAME) return null;
  if (answer.ok !== true) return null;
  if (answer.recorded !== true) return null;
  if (answer.replaced !== false) return null;
  if (answer.authorizesSpending !== false) return null;
  if (hasErrorCode(answer.error)) return null;
  const count = answer.approvalCount;
  if (
    typeof count !== 'number' ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > MAX_VOTE_APPROVAL_COUNT
  ) {
    return null;
  }
  const abstained = answer.abstained;
  if (typeof abstained !== 'boolean') return null;
  // The tool sets this flag from the same approved list it counts, so the two disagreeing means the
  // answer did not come from that path: refuse rather than pick one of the two facts.
  if (abstained !== (count === 0)) return null;
  const text =
    count === 0
      ? `${VOTE_REPLY_ABSTENTION_SENTENCE}${VOTE_REPLY_NO_FUNDS_SENTENCE}`
      : `${VOTE_REPLY_APPROVAL_TEMPLATE.replace('{count}', String(count))}${VOTE_REPLY_NO_FUNDS_SENTENCE}`;
  return { text, pollId: readPollId(answer) };
};

/**
 * Read the one preparatory step this guard accepts: a *verified provisional* round read, or null for
 * anything else. Every field of the tool's own provisional envelope has to agree - `ok: false`, `status:
 * 'provisional'`, the `provisional` error code, and a narration that is `provisional` with no outcome and
 * nothing finalized - because a closed round, a cancelled round read back as anything else, and a real
 * failure must all fall through to a refusal. The read's stored round travels back for correlation.
 *
 * A live provisional read is reported by the host as a failed call. Depending on the host, that failure
 * carries the tool's own `provisional` code or the generic `failed` the host derives from the answer's
 * `ok: false`, so both of those codes are read through - but only after the whole provisional envelope
 * above has already agreed, so a real failure wearing either code is still refused. An absent or empty
 * host error is the same read on a host that does not stamp one, and any other error is refused.
 */
const readProvisionalRead = (
  result: unknown,
  eventError: unknown,
): { pollId: string | null } | null => {
  const answer = readAnswer(result);
  if (!answer) return null;
  if (answer.tool !== POLL_RESULT_READ_TOOL_NAME) return null;
  if (answer.ok !== false) return null;
  if (answer.status !== PROVISIONAL_ERROR_CODE) return null;
  if (answer.error !== PROVISIONAL_ERROR_CODE) return null;
  const narration = isRecord(answer.narration) ? answer.narration : null;
  if (!narration) return null;
  if (narration.kind !== PROVISIONAL_ERROR_CODE) return null;
  if (narration.outcome !== null) return null;
  if (narration.finalized !== false) return null;
  // The host's own code is read last, and only against the envelope that has already been fully
  // validated: the tool's provisional code, the generic failure code the host stamps on an `ok: false`
  // answer, or no code at all. Every other host error is a real failure and refuses the read.
  if (
    hasErrorCode(eventError) &&
    eventError !== PROVISIONAL_ERROR_CODE &&
    eventError !== HOST_FAILED_ERROR_CODE
  ) {
    return null;
  }
  return { pollId: readPollId(answer) };
};

/** Read the text off a payload, or null when it carries none. */
const readPayloadText = (payload: PluginHookReplyPayload): string | null =>
  isRecord(payload) && typeof payload.text === 'string' ? payload.text : null;

/**
 * Build the outbound ballot guard. Register the two hooks it returns:
 *
 * ```ts
 * const guard = createVoteReplyGuard();
 * api.on('after_tool_call', guard.afterToolCall, { matcher: [...VOTE_REPLY_GUARD_TOOL_NAMES] });
 * api.on('reply_payload_sending', guard.replyPayloadSending);
 * ```
 */
export function createVoteReplyGuard(options?: VoteReplyGuardOptions): VoteReplyGuard {
  const now = typeof options?.now === 'function' ? options.now : () => Date.now();
  const ttlMs =
    typeof options?.ttlMs === 'number' && Number.isFinite(options.ttlMs) && options.ttlMs >= 0
      ? options.ttlMs
      : VOTE_REPLY_GUARD_TTL_MS;
  const maxEntries =
    typeof options?.maxEntries === 'number' &&
    Number.isSafeInteger(options.maxEntries) &&
    options.maxEntries >= 1
      ? options.maxEntries
      : VOTE_REPLY_GUARD_MAX_ENTRIES;
  /**
   * Remembered replies per run, ordered oldest first so the bound drops the oldest entry. The map
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
      // Tool Search reports the outer dispatcher's name, so the identity of the tool that actually ran
      // is read from the host's own envelope. `params.id` is deliberately never consulted: the model
      // writes it, and a spoofed id must not be able to arm or disqualify the guard. An envelope this
      // guard cannot unwrap keeps the outer `tool_call` name, and because the dispatcher is in the
      // observed set that unnamed guest still disqualifies the run.
      const dispatched =
        observedToolName === TOOL_SEARCH_DISPATCHER_TOOL_NAME
          ? unwrapToolSearchDispatch(event.result)
          : null;
      const toolName = dispatched ? dispatched.toolName : observedToolName;
      if (!(VOTE_REPLY_GUARD_TOOL_NAMES as readonly string[]).includes(toolName)) return;
      const runIdRaw = typeof event.runId === 'string' ? event.runId : ctx?.runId;
      const runId = typeof runIdRaw === 'string' && runIdRaw.trim() ? runIdRaw.trim() : null;
      // Without a run id there is no entry to correlate the two hooks, so this stays fail-open: the
      // host's own reply is delivered untouched.
      if (!runId) return;
      const result = dispatched ? dispatched.result : event.result;
      sweep();
      const previous = pending.get(runId);
      const expiresAt = now() + ttlMs;

      // Classify this one call before advancing the run. Only two shapes count as steps: the ballot,
      // and the provisional round read that may precede it. Every other observed tool - and a ballot or
      // a read that is not its own verified shape, including one the host flags as an error - is not a
      // step, and the run is disqualified by the transition below. The one host error that can still be
      // a step is the failure code the host stamps on a provisional read, and only the reader below
      // decides that, from the validated envelope rather than from the code alone.
      const voteReply =
        toolName === VOTE_GUARD_TOOL_NAME && !hasErrorCode(event.error)
          ? readVoteReply(result)
          : null;
      const provisionalRead =
        voteReply === null && toolName === POLL_RESULT_READ_TOOL_NAME
          ? readProvisionalRead(result, event.error)
          : null;

      // Which channel this observation arrived on, and the verified step it carries. The signature is
      // built only from what the tool's own answer proved, so two observations carrying the same
      // signature are the same recorded answer and not merely two calls that look alike.
      const channel: VoteObservationChannel = dispatched ? 'dispatched' : 'direct';
      const signature =
        voteReply !== null
          ? `vote:${voteReply.text}:${voteReply.pollId ?? ''}`
          : provisionalRead !== null
            ? `read:${provisionalRead.pollId ?? ''}`
            : null;

      // One business call reaches this hook twice, once per channel. When this observation is the last
      // counted call's other channel and agrees with it on the verified answer, it is that call reported
      // again: count nothing and leave the run where it stands. Every other observation is a call of its
      // own and advances the run below - a same-channel repeat, a call whose answer differs, and a
      // repeat of a call whose two channels have both been seen.
      if (
        previous !== undefined &&
        signature !== null &&
        previous.lastSignature === signature &&
        previous.lastChannel !== null &&
        previous.lastChannel !== channel &&
        !previous.paired
      ) {
        pending.delete(runId);
        pending.set(runId, { ...previous, paired: true, expiresAt });
        return;
      }

      const calls = (previous?.calls ?? 0) + 1;
      // The place this counted call leaves the run in, carried by every entry written below.
      const counted = { calls, lastChannel: channel, lastSignature: signature, paired: false, expiresAt };

      const disqualify = () => {
        pending.delete(runId);
        pending.set(runId, { phase: 'disqualified', text: null, pollId: null, ...counted });
      };

      if (previous === undefined) {
        // The first call of the run: the ballot alone, or the one preparatory read. Anything else ends
        // the run's chance here, so a later ballot cannot revive it.
        if (voteReply !== null) {
          pending.set(runId, {
            phase: 'armed',
            text: voteReply.text,
            pollId: null,
            ...counted,
          });
        } else if (provisionalRead !== null) {
          pending.set(runId, {
            phase: 'provisional',
            text: null,
            pollId: provisionalRead.pollId,
            ...counted,
          });
        } else {
          disqualify();
        }
        return;
      }

      // The second call of the run: the read may be completed by exactly one verified ballot on the
      // same round, and the ballot armed alone on the first call is complete already. Any other second
      // call, and any call after that, disqualifies the run - so the read and the ballot cannot arrive
      // in the other order, a second read never completes, and a failed ballot ends the run.
      if (previous.phase === 'provisional' && calls === 2 && voteReply !== null) {
        if (samePoll(previous.pollId, voteReply.pollId)) {
          pending.delete(runId);
          pending.set(runId, {
            phase: 'armed',
            text: voteReply.text,
            pollId: null,
            ...counted,
          });
          return;
        }
      }
      disqualify();
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
      if (event.kind !== VOTE_GUARD_FINAL_KIND) return undefined;
      if (event.channel !== VOTE_GUARD_CHANNEL) return undefined;
      const runId = typeof event.runId === 'string' ? event.runId.trim() : '';
      if (!runId) return undefined;
      sweep();
      const entry = pending.get(runId);
      if (!entry) return undefined;
      // One reply is judged once: a later payload in the same run is delivered untouched.
      pending.delete(runId);
      if (entry.phase !== 'armed' || entry.text === null) return undefined;
      const payload = event.payload;
      if (!isRecord(payload) || readPayloadText(payload) === null) return undefined;
      // Spread the original payload and replace only its text, so media, metadata, threading and every
      // other property the host set stay exactly as they were.
      return { payload: { ...payload, text: entry.text } };
    } catch {
      // Fail open by design: an unusable event or an unexpected shape leaves the payload exactly as the
      // host made it and delivery proceeds. Nothing is suppressed, and the guard makes no claim about
      // internal vocabulary in a reply it did not rebuild.
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
