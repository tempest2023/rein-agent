// Outbound reply guard for the MVP proposal field-collection tool (case 3).
//
// Why this exists. `rein_proposal_collect` answers the model with a structured object that
// carries implementation words on purpose: the configured vote type code (for example
// `event_single`), the collected-field preview, the missing-field names, the sealed draft token and
// its expiry, the tool name. Those are correct for the caller that has to act on them, but
// `workspace/AGENTS.md` and `docs/agent-test-cases-zh.md` case 3 require the member to see only
// their own words and a plain next question. Prompt text alone did not hold: a synthetic rehearsal
// showed the member-facing reply echoing internal type codes, so the boundary is enforced here in
// code instead of being asked for in a prompt. It is not a blanket guarantee: only a recognized
// event shape with a usable run id arms it, so a malformed event or a missing run id stays
// fail-open and delivers the host's own payload unchanged.
//
// What it does, and what it deliberately leaves alone. Two host hooks, matched to three tool names
// (`rein_proposal_collect`, `rein_governance_proposal_submit` and the Tool Search dispatcher
// `tool_call`) and to one `runId`:
// - `after_tool_call` notices exactly one successful, validated `rein_proposal_collect`
//   collecting answer and remembers the safe fields that answer derived from the proposer's own
//   words (the public preview and the ready-to-ask `nextPrompt`), keyed by the run that produced it.
//   The same hook also watches `rein_governance_proposal_submit`: a submit in that run means the run's
//   reply is the submit outcome, so the remembered collect is dropped before the outcome is read,
//   whether the submit succeeded or failed. That keeps the submit reply from being rewritten into
//   the collect prompt. The cheap, matcher-limited part of that work happens before any decoding, so
//   ordinary tool traffic in a run pays nothing for a guard that will not fire. An interface check,
//   not a measured benchmark.
// - Both of those tools reach this plugin through Tool Search on a live Gateway: the host exposes
//   one outer dispatcher tool named `tool_call` and the guest call runs inside it. The outer
//   `after_tool_call` therefore reports `toolName: 'tool_call'` with the dispatcher's envelope as
//   `result.toolName`-less body, so the identity of the tool that actually ran lives in the host's
//   `result.details.tool` (`{ id, name, source }`) and the guest outcome lives in
//   `result.details.result`. The hook unwraps exactly that one shape, and only when the host body
//   names one of this guard's two tools; every other `tool_call` is left alone. The params of the
//   outer call are never read, because they are model-authored and can name any tool at all. Direct
//   (non-Tool-Search) calls keep reporting their own bare tool name and are handled as before.
// - `reply_payload_sending` fires for the same run, on the Slack surface, when the host is about to
//   deliver the turn's final reply. That one payload's text is replaced with safe plain copy built
//   from the remembered fields; every other property of the payload is preserved by spreading the
//   original, and the payload object received from the host is never mutated in place.
//
// Nothing else is touched. Another tool, another run, a non-Slack surface, a non-final dispatch kind
// (progress output and tool messages), a reply with no matching successful collect, a failed or
// malformed collect, an author-prepared and ready-to-submit result, a cancel result and a handler
// error all leave the payload exactly as the host supplied it. No reply is ever sent from here: the
// guard only edits the text of a payload the host was already going to deliver, and it never calls a
// Slack API.
//
// Amounts and currencies. This guard never repeats an amount back to the member, in any currency.
// The tool carries `requestedMinor` as an integer in minor units and the currency beside it, and the
// number of minor units in one major unit is a per-currency fact (100 for USD, 1 for JPY, 1000 for
// BHD) that this guard does not know. Deriving a major-unit amount would therefore have to guess, so
// it does not print one at all: the member hears that an amount and a currency were both received,
// and the exact pair is read back from the tool's own field preview by the prepare/read-back flow,
// which already has the amount and the currency together. An amount the guard does not print cannot
// be printed wrongly.
//
// Memory. One entry per run, consumed on first use, and every entry expires after a fixed TTL, so a
// run whose reply never arrives, or a stream of unrelated runs, cannot grow this state without
// bound. The entries live in one store shared by every loaded copy of this module in the process
// (see `COLLECT_REPLY_GUARD_SHARED_STATE_KEY`), because a live Gateway loads this plugin more than
// once and the two hooks above can run in different copies. A per-instance map put the arm in one
// copy and left the reply hook looking in the other, empty copy, so the member got the model's own
// prose; the shared store is what makes the remembered fact reachable from both hooks. Sharing
// changes only who can read an entry, not what is remembered: the store is still bounded, still
// swept on every hook call, and still confined to one process. A caller that asks for isolation
// (`stateKey: null`) gets private memory instead.
//
// Diagnostics. A live run showed a collect reaching the run while the delivered Slack reply stayed
// the model's own prose, and nothing in the host's gateway log could say whether the hooks ran, ran
// under a different tool name, or ran but matched no remembered run. This module therefore carries
// one optional trace, off unless `REIN_GOVERNANCE_GUARD_DIAG` is set AND the registration injects a
// sink:
// `after_tool_call.match`, `after_tool_call.arm` or `after_tool_call.reject` (with the refusing
// reason) and `reply_payload_sending.entry`, `.hit` or `.miss`. Each line carries only the event
// kind plus channel, run id and tool names rendered by this module's own identifier rule, which
// echoes a short identifier-shaped value and hashes anything else. No user wording, no token, no
// draft or confirmation secret, no raw params and no result field is ever written, and a throwing
// sink is swallowed like every other failure here, so the trace cannot change whether a reply is
// delivered.
//
// Open versus closed, stated plainly. This is a reply-rewriting guard, not an authorization gate, so
// every refusal path here is deliberately open: an event shape the guard does not recognize, a
// payload it cannot read or rebuild, or a thrown error leaves the host's own payload exactly as it
// was and lets delivery proceed. The guard never suppresses, delays or replaces a reply it cannot
// rebuild; the only thing refused is the unsafe rewrite itself. A payload handed through by a
// refusal may still carry internal vocabulary, so this guard is a floor on what one known tool's
// final reply says, not a blanket guarantee about every payload the host delivers.

import type {
  PluginHookAfterToolCallEvent,
  PluginHookReplyPayload,
  PluginHookReplyPayloadSendingEvent,
  PluginHookReplyPayloadSendingResult,
  PluginHookToolContext,
} from 'openclaw/plugin-sdk/plugin-entry';

/** The collecting tool this guard observes and may rewrite the reply of. */
export const COLLECT_GUARD_TOOL_NAME = 'rein_proposal_collect';
/**
 * The submit tool this guard watches in the same run. A submit closes the collection, so it drops
 * the run's remembered collect and its reply is never rewritten.
 */
export const SUBMIT_GUARD_TOOL_NAME = 'rein_governance_proposal_submit';
/**
 * The Tool Search dispatcher the host reports when either tool above runs through Tool Search. It
 * is matched, not trusted: its identity is only read from the host's own `result.details.tool`, so
 * admitting the dispatcher to the matcher arms nothing by itself.
 */
export const TOOL_SEARCH_DISPATCHER_TOOL_NAME = 'tool_call';
/**
 * Every tool name the `after_tool_call` matcher must admit, so the entry wiring cannot drift: the
 * two guard tools for a direct (non-Tool-Search) call, plus the dispatcher for a Tool Search call.
 */
export const COLLECT_REPLY_GUARD_TOOL_NAMES = [
  COLLECT_GUARD_TOOL_NAME,
  SUBMIT_GUARD_TOOL_NAME,
  TOOL_SEARCH_DISPATCHER_TOOL_NAME,
] as const;
/** The one transport surface this guard rewrites on. */
export const COLLECT_GUARD_CHANNEL = 'slack';
/** The one dispatch kind this guard rewrites: the turn's final reply, not progress or tool output. */
export const COLLECT_GUARD_FINAL_KIND = 'final';
/** How long a remembered collect stays replaceable before it is swept, in milliseconds. */
export const COLLECT_REPLY_GUARD_TTL_MS = 5 * 60 * 1000;
/** How many runs may be remembered at once; the oldest entry is dropped past this bound. */
export const COLLECT_REPLY_GUARD_MAX_ENTRIES = 64;
/**
 * Process-wide key of the remembered-collect store. A live Gateway loads this plugin more than once:
 * two byte-identical build trees, each with its own bundled module graph and its own copy of this
 * module, both call {@link createCollectReplyGuard}, and the `after_tool_call` hook that arms and the
 * `reply_payload_sending` hook that reads can land in different copies. A `Map` created inside one
 * module graph is invisible to the other, so the arm and the reply never meet. The store therefore
 * lives on `globalThis` under an interned symbol, the same process-global pattern OpenClaw uses for
 * its own plugin registry state (`vendor/openclaw/src/plugins/runtime-state.ts`). The `.v1` suffix
 * versions the slot so a future change to the remembered shape takes a new name instead of reading a
 * stale one, and a slot whose contents do not match this module's own shape is replaced rather than
 * trusted. The slot is readable by any code in the same process, which is the price of reaching both
 * module graphs; entries are still only the proposer's own fields and the tool's own question lines,
 * never a token.
 */
export const COLLECT_REPLY_GUARD_SHARED_STATE_KEY =
  '@rein-protocol/openclaw-rein-operations.governance-collect-reply-guard.v1';
/** Shape version of one store: a store carrying any other version is replaced, not read. */
const COLLECT_REPLY_GUARD_STORE_VERSION = 1;
/**
 * Environment variable that turns on this guard's diagnostic lines. It is off by default, and a
 * value of `0`, `false` or `off` keeps it off, so a running deployment emits nothing unless an
 * operator asks for it. The lines are for read-only troubleshooting of the hook chain: they carry
 * no user wording, no token, no draft or confirmation secret, and no sensitive parameter or result
 * field.
 */
export const COLLECT_REPLY_GUARD_DIAG_ENV = 'REIN_GOVERNANCE_GUARD_DIAG';
/** Longest tool-supplied `nextPrompt` line this guard will repeat back. */
const MAX_PROMPT_LINE_LENGTH = 400;
/**
 * Longest remembered author wording this guard will repeat back. The character budget is what the
 * collect tool's own `draftPreview` measured for the longest legal field value it stores, so a value
 * this guard repeats can never be a truncated prefix of a value the tool accepted; anything longer
 * could only come from an answer this tool never produced. A unit test keeps the budget tied to the
 * tool's own fence so the two cannot drift apart.
 */
const MAX_AUTHOR_WORDING_LENGTH = 4000;
/**
 * Longest raw run id, channel id or tool name this module will ever print. Anything past it is
 * hashed instead of repeated, so one oversized or adversarially shaped identifier cannot become a
 * channel for arbitrary text to reach the log. Channel and tool names are Slack/host identifiers
 * this deployment already writes flush in its own gateway log, so they are correlated as-is; only
 * the run id is hashed, because it is the value the live hook chain is being compared on.
 */
const DIAG_ID_MAX_LENGTH = 64;

/** A place one diagnostic line may go; the plugin registration passes the host's own logger. */
export interface GuardDiagnosticSink {
  info?: (message: string) => void;
  debug?: (message: string) => void;
}

/** Sum the bytes of one string into a short hex digest. */
const fnv1a32 = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/**
 * Render one diagnostic identifier. A short, identifier-shaped value is echoed as-is; anything else
 * is replaced by a hash and its length, so the log can correlate two events that carry the same
 * value without ever becoming a reliable copy target for arbitrary text.
 */
const diagId = (value: string | null | undefined): string => {
  if (typeof value !== 'string' || value.length === 0) return '<none>';
  if (value.length <= DIAG_ID_MAX_LENGTH && /^[A-Za-z0-9:._-]+$/.test(value)) return value;
  return `sha:${fnv1a32(value)}#len${value.length}`;
};

/** One remembered collecting answer: the safe facts one later reply may be rebuilt from. */
export interface CollectReplyFacts {
  /** The proposer's own title, or null while they have not given one. */
  title: string | null;
  /** The proposer's own summary wording, or null. */
  summary: string | null;
  /** The proposer's own rough timing wording, or null; never parsed into a date. */
  approximateWhen: string | null;
  /**
   * True when the collect answered with a requested amount and its currency as one pair. The pair
   * itself is never repeated back, because this guard does not know how many minor units make one
   * major unit in the answered currency. The prepare/read-back flow prints the exact pair instead.
   */
  hasAmountAndCurrency: boolean;
  /** Ready-to-ask lines in the proposer's own language, already free of internal vocabulary. */
  nextPrompt: string[];
  /**
   * True when this collect answered `readyForSubmit: true`: every required field is present. That
   * turn belongs to the prepare/read-back flow rather than to a follow-up question, so its reply is
   * left exactly as the model wrote it and this guard never touches it.
   */
  preparedForSubmit: boolean;
}

export interface CollectReplyGuardOptions {
  /** Injectable clock for deterministic tests; defaults to the wall clock. */
  now?: () => number;
  /** Injectable sweep interval in milliseconds; defaults to the module TTL. */
  ttlMs?: number;
  /** Injectable bound on remembered runs; defaults to the module bound. */
  maxEntries?: number;
  /**
   * Reads the environment variable that turns diagnostics on. Defaults to `process.env`. Passing a
   * source that leaves {@link COLLECT_REPLY_GUARD_DIAG_ENV} unset keeps diagnostics off entirely.
   */
  env?: Record<string, string | undefined>;
  /**
   * Sink for the optional diagnostic lines. Nothing is emitted without it, even when the
   * environment variable is set, so a test or an embedder that passes no sink never sees a line.
   */
  diagnostic?: GuardDiagnosticSink;
  /**
   * Identity of the remembered-collect store this instance reads and writes. Omit it (the production
   * case) to use the plugin's own process-wide slot, which is what lets a collect armed by the
   * `after_tool_call` hook of one loaded module graph be found by the `reply_payload_sending` hook of
   * another graph in the same process. A string or symbol names one store inside this process, shared
   * by every instance that passes the same key and separated from every other key; a string is
   * interned with `Symbol.for`, so the same text names the same store in every module graph. `null`
   * keeps this instance's memory to itself, which is what a test that wants an isolated store passes.
   */
  stateKey?: string | symbol | null;
}

export interface CollectReplyGuard {
  /**
   * `api.on('after_tool_call', ...)`: notice one successful collecting answer, or drop a remembered
   * one when a submit is observed in the same run. Both a direct call and a Tool Search dispatch of
   * either tool are recognized; a dispatch is unwrapped through the host's own tool identity.
   */
  afterToolCall(event: PluginHookAfterToolCallEvent, ctx?: PluginHookToolContext): void;
  /**
   * `api.on('reply_payload_sending', ...)`: replace the one final payload of the same run with safe
   * plain copy while preserving every other property, or hand back the payload unchanged.
   */
  replyPayloadSending(
    event: PluginHookReplyPayloadSendingEvent,
    ctx?: unknown,
  ): PluginHookReplyPayloadSendingResult | undefined;
  /**
   * Number of runs currently remembered in this guard's store; exposed for tests and for leak
   * checks. With the default shared store this counts the whole process's entries for this plugin,
   * not just the ones this instance armed.
   */
  pendingCount(): number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One remembered collecting answer, with the moment it stops being replaceable. */
interface CollectReplyPendingEntry {
  facts: CollectReplyFacts;
  expiresAt: number;
}

/**
 * The remembered-collect store: one entry per run, oldest first so the bound drops the oldest run.
 * When it is shared it is one object on `globalThis`, and the entries map is reached through that
 * object rather than being held by the guard instance; every read and write below is identical
 * whether the store is shared or private.
 */
interface CollectReplyPendingStore {
  version: number;
  entries: Map<string, CollectReplyPendingEntry>;
}

/** True only for a store this module created and whose remembered shape it can still read. */
const isPendingStore = (value: unknown): value is CollectReplyPendingStore =>
  isRecord(value) && value.version === COLLECT_REPLY_GUARD_STORE_VERSION && value.entries instanceof Map;

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
const resolvePendingStore = (stateKey: string | symbol | null | undefined): CollectReplyPendingStore => {
  const freshStore = (): CollectReplyPendingStore => ({
    version: COLLECT_REPLY_GUARD_STORE_VERSION,
    entries: new Map(),
  });
  if (stateKey === null) return freshStore();
  const key: PropertyKey =
    stateKey === undefined
      ? Symbol.for(COLLECT_REPLY_GUARD_SHARED_STATE_KEY)
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
 * On a live Gateway both guard tools run through Tool Search: the host exposes one outer dispatcher
 * literally named `tool_call`, and the guest runs inside it. The outer event's `toolName` is
 * therefore the dispatcher's, and the model-authored `params` may name any tool at all, so the
 * identity of what ran is taken only from the host's own body. That body is
 * `{ ...controlResult, details: callResult }`, and `callResult` is
 * `{ tool: { id, name, source }, result }` where `tool` comes from the catalog entry the runtime
 * resolved and `result` is the guest outcome. This returns that guest outcome, and null for
 * anything else: a non-dispatcher call, a dispatcher envelope that does not name one of this
 * guard's two tools, or a body whose host identity or guest outcome is missing. A `tool_call` for an
 * unrelated tool returns null and is ignored, exactly like any other unrelated tool.
 */
const unwrapToolSearchDispatch = (
  result: unknown,
): { toolName: string; result: unknown } | null => {
  if (!isRecord(result)) return null;
  const details = result.details;
  if (!isRecord(details)) return null;
  const tool = details.tool;
  const innerName = isRecord(tool) && typeof tool.name === 'string' ? tool.name : null;
  if (innerName !== COLLECT_GUARD_TOOL_NAME && innerName !== SUBMIT_GUARD_TOOL_NAME) return null;
  const inner = details.result;
  if (!isRecord(inner)) return null;
  return { toolName: innerName, result: inner };
};

/** Read the fields this guard repeats back, or null when the remembered shape is unusable. */
const readFacts = (answer: Record<string, unknown>): CollectReplyFacts | null => {
  const collected = isRecord(answer.collected) ? answer.collected : null;
  if (!collected) return null;
  // The amount and its currency are one recorded pair: the guard only takes note that both are there
  // and present. It deliberately reads no number out of them, because minor-to-major conversion is a
  // per-currency fact this module does not know, and there is nothing it would safely do with the
  // number on its own.
  const hasAmountAndCurrency =
    typeof collected.requestedMinor === 'number' &&
    Number.isSafeInteger(collected.requestedMinor) &&
    collected.requestedMinor >= 0 &&
    asText(collected.currency, 3) !== null;
  const prompts = Array.isArray(answer.nextPrompt)
    ? answer.nextPrompt
        .map(line => asText(line, MAX_PROMPT_LINE_LENGTH))
        .filter((line): line is string => line !== null)
    : [];
  return {
    title: asText(collected.title, MAX_AUTHOR_WORDING_LENGTH),
    summary: asText(collected.summary, MAX_AUTHOR_WORDING_LENGTH),
    approximateWhen: asText(collected.approximateWhen, MAX_AUTHOR_WORDING_LENGTH),
    hasAmountAndCurrency,
    nextPrompt: prompts,
    // A ready answer means every required field is present, so the turn is the prepared version the
    // author reads back before submit, not a follow-up question. Leave that reply alone entirely.
    preparedForSubmit: answer.readyForSubmit === true,
  };
};

/**
 * Build the member-facing copy. It repeats only what the proposer said and only the tool's own
 * ready-made question lines, and it names no tool, field, type code, alias or token.
 */
const buildSafeText = (facts: CollectReplyFacts): string => {
  const lines: string[] = [];
  const quoted: string[] = [];
  if (facts.title !== null) quoted.push(`标题「${facts.title}」`);
  if (facts.summary !== null) quoted.push(`摘要「${facts.summary}」`);
  if (facts.approximateWhen !== null) quoted.push(`大致时间「${facts.approximateWhen}」`);
  // No number and no currency code: only that an amount and a currency arrived together. The exact
  // pair is read back from the tool's own field preview during prepare, where both are already known.
  if (facts.hasAmountAndCurrency) quoted.push('预算金额和币种都已经记下了');
  if (quoted.length > 0) {
    lines.push(`我先把你已经说过的内容记下来了：${quoted.join('；')}。`);
  } else {
    lines.push('我先把你已经说过的内容记下来了，细节还没定也没有关系。');
  }
  lines.push('现在还不提交，等下面这些补齐、并且你确认过之后我再往下走。');
  if (facts.nextPrompt.length > 0) {
    lines.push(...facts.nextPrompt);
  } else {
    lines.push('需要补的内容已经齐了。我先整理成一版完整说法读回给你确认，你点头之后再提交。');
  }
  return lines.join('\n');
};

/** Read the text off a payload, or null when it carries none. */
const readPayloadText = (payload: PluginHookReplyPayload): string | null =>
  isRecord(payload) && typeof payload.text === 'string' ? payload.text : null;

/**
 * Build the outbound reply guard. Register the two hooks it returns:
 *
 * ```ts
 * const guard = createCollectReplyGuard();
 * api.on('after_tool_call', guard.afterToolCall, { matcher: [...COLLECT_REPLY_GUARD_TOOL_NAMES] });
 * api.on('reply_payload_sending', guard.replyPayloadSending);
 * ```
 */
export function createCollectReplyGuard(options?: CollectReplyGuardOptions): CollectReplyGuard {
  const now = typeof options?.now === 'function' ? options.now : () => Date.now();
  const ttlMs =
    typeof options?.ttlMs === 'number' && Number.isFinite(options.ttlMs) && options.ttlMs >= 0
      ? options.ttlMs
      : COLLECT_REPLY_GUARD_TTL_MS;
  const maxEntries =
    typeof options?.maxEntries === 'number' &&
    Number.isSafeInteger(options.maxEntries) &&
    options.maxEntries >= 1
      ? options.maxEntries
      : COLLECT_REPLY_GUARD_MAX_ENTRIES;
  // Diagnostics are opt-in twice over: an operator has to set the environment variable AND the
  // registration has to hand over a sink. With either one missing this is a no-op, so a deployed
  // guard stays as quiet as it was before this diagnostic existed.
  const diagnosticEnabled = (() => {
    const raw = (options?.env ?? process.env)[COLLECT_REPLY_GUARD_DIAG_ENV];
    if (typeof raw !== 'string') return false;
    const value = raw.trim().toLowerCase();
    return value !== '' && value !== '0' && value !== 'false' && value !== 'off';
  })();
  const diagnosticSink = diagnosticEnabled ? options?.diagnostic : undefined;

  /**
   * Emit one diagnostic line. Every line is a single fixed prefix plus `key=value` pairs whose
   * values are identifiers this module rendered itself, so no user wording, token, draft secret or
   * raw result field can reach it. Nothing here is allowed to change control flow: a sink that
   * throws is swallowed, exactly as the guard's own fail-open posture requires.
   */
  const emitDiagnostic = (event: string, fields: Record<string, string>): void => {
    if (!diagnosticSink) return;
    const parts = Object.entries(fields).map(([key, value]) => `${key}=${value}`);
    const line = `rein-governance-guard ${event}${parts.length > 0 ? ` ${parts.join(' ')}` : ''}`;
    try {
      if (typeof diagnosticSink.info === 'function') diagnosticSink.info(line);
      else if (typeof diagnosticSink.debug === 'function') diagnosticSink.debug(line);
    } catch {
      // A diagnostic sink must never disturb delivery; drop the line and carry on.
    }
  };

  /**
   * Remembered facts per run, ordered oldest first so the bound drops the oldest entry. The map
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

  /**
   * Emit the one line that classifies a refusal. The unconditional entry/match line proves the hook
   * was reached; this line says what it then decided, and only a decision that keeps the host's own
   * payload open is classified. A rewriting path emits `hit`/`arm` where it rewrites or remembers,
   * so no observation is ever described by both a refusal and a hit.
   */
  const emitRefusal = (hook: string, fields: Record<string, string>, classifiedRefusal: boolean): void => {
    if (!classifiedRefusal) return;
    emitDiagnostic(`${hook}.reject`, fields);
  };

  const afterToolCall = (event: PluginHookAfterToolCallEvent, ctx?: PluginHookToolContext): void => {
    // The entry line is emitted for every observation, before any decision, so a live run can tell
    // "the hook never ran for this tool" apart from "the hook ran and matched nothing". A second line
    // classifies what the hook then did: `arm` where it remembered a collect, `reject` where it left
    // the payload open, and nothing at all where it took a rewriting path.
    let diagnosticOutcome: 'arm' | 'reject' | 'none' = 'none';
    let diagnosticDetail = 'reason=unclassified';
    let diagnosticFields: Record<string, string> = {};
    let observedToolNameForDiagnostic: string | null = null;
    let matchedToolForDiagnostic: string | null = null;
    let runIdForDiagnostic: string | null = null;
    try {
      if (!isRecord(event)) return;
      const observedToolName =
        typeof event.toolName === 'string'
          ? event.toolName
          : typeof ctx?.toolName === 'string'
            ? ctx.toolName
            : '';
      observedToolNameForDiagnostic = observedToolName;
      // Tool Search reports the outer dispatcher's name, so the identity of the tool that actually
      // ran is read from the host's own envelope. `params.id` is deliberately never consulted: the
      // model writes it, and a spoofed id must not be able to arm or clear the guard.
      const dispatched =
        observedToolName === TOOL_SEARCH_DISPATCHER_TOOL_NAME
          ? unwrapToolSearchDispatch(event.result)
          : null;
      const toolName = dispatched ? dispatched.toolName : observedToolName;
      matchedToolForDiagnostic = toolName;
      const result = dispatched ? dispatched.result : event.result;
      const runIdRaw = typeof event.runId === 'string' ? event.runId : ctx?.runId;
      const runId = typeof runIdRaw === 'string' && runIdRaw.trim() ? runIdRaw.trim() : null;
      runIdForDiagnostic = runId;
      // A `tool_call` dispatch of one of this guard's two tools, or a direct call to one of them, is
      // the only thing that counts as a match: the matcher admitted this event and the host body named
      // a tool this guard observes. Everything else reads `match=false`.
      const matched = toolName === COLLECT_GUARD_TOOL_NAME || toolName === SUBMIT_GUARD_TOOL_NAME;
      diagnosticFields = {
        match: matched ? 'true' : 'false',
        observed: diagId(observedToolName),
        matched: diagId(toolName),
        run: diagId(runId),
      };
      diagnosticOutcome = 'reject';
      diagnosticDetail = matched ? 'reason=unclassified' : 'reason=unmatched_tool';
      // A submit in the same run closes the collection: that run's reply is the submit outcome, so
      // any remembered collect is dropped before the outcome is even read. This happens whether the
      // submit succeeded or failed, so neither can be masked by the collect prompt, and it arms no
      // replacement of its own. Without a run id there is no entry to correlate, so this stays
      // fail-open.
      if (toolName === SUBMIT_GUARD_TOOL_NAME) {
        if (runId) pending.delete(runId);
        diagnosticDetail = 'reason=submit_observed';
        return;
      }
      if (toolName !== COLLECT_GUARD_TOOL_NAME) {
        return;
      }
      // A failed call must never arm a replacement: only a clean, structured collecting answer does.
      if (event.error !== undefined && event.error !== null && event.error !== '') {
        diagnosticDetail = 'reason=tool_error';
        return;
      }
      const answer = readAnswer(result);
      if (!answer) {
        diagnosticDetail = 'reason=answer_unreadable';
        return;
      }
      if (answer.tool !== COLLECT_GUARD_TOOL_NAME) {
        diagnosticDetail = 'reason=answer_tool_mismatch';
        return;
      }
      if (answer.ok !== true || answer.status !== 'collecting' || answer.recorded !== false) {
        diagnosticDetail = 'reason=answer_not_collecting';
        return;
      }
      // Without a run to correlate the two hooks there is nothing safe to do; leave the reply alone.
      if (!runId) {
        diagnosticDetail = 'reason=run_id_missing';
        return;
      }
      const facts = readFacts(answer);
      if (!facts) {
        diagnosticDetail = 'reason=facts_unusable';
        return;
      }
      sweep();
      pending.delete(runId);
      pending.set(runId, { facts, expiresAt: now() + ttlMs });
      diagnosticOutcome = 'arm';
      diagnosticDetail = `dispatched=${dispatched ? 'true' : 'false'} pending=${pending.size}`;
    } catch {
      // A guard that throws must not change the tool path: remember nothing for this call.
      diagnosticOutcome = 'reject';
      diagnosticDetail = 'reason=threw';
    } finally {
      if (diagnosticOutcome === 'none' && Object.keys(diagnosticFields).length === 0) {
        diagnosticFields = {
          match: 'false',
          observed: diagId(observedToolNameForDiagnostic),
          matched: diagId(matchedToolForDiagnostic),
          run: diagId(runIdForDiagnostic),
        };
      }
      emitDiagnostic('after_tool_call.match', diagnosticFields);
      if (diagnosticOutcome === 'arm') {
        emitDiagnostic('after_tool_call.arm', { ...diagnosticFields, detail: diagnosticDetail });
      } else {
        emitRefusal('after_tool_call', { ...diagnosticFields, detail: diagnosticDetail }, diagnosticOutcome === 'reject');
      }
    }
  };

  const replyPayloadSending = (
    event: PluginHookReplyPayloadSendingEvent,
    _ctx?: unknown,
  ): PluginHookReplyPayloadSendingResult | undefined => {
    // The entry line is emitted for every payload, before any shape check, so a live run can prove the
    // hook saw its run's final Slack payload at all. A second line classifies the decision: `hit` where
    // the text was replaced, `miss` where the payload was left exactly as the host made it.
    let diagnosticOutcome: 'hit' | 'miss' = 'miss';
    let diagnosticDetail = 'reason=unclassified';
    let diagnosticFields: Record<string, string> = {};
    try {
      if (!isRecord(event)) return undefined;
      diagnosticFields = {
        channel: diagId(typeof event.channel === 'string' ? event.channel : null),
        kind: diagId(typeof event.kind === 'string' ? event.kind : null),
        run: diagId(typeof event.runId === 'string' ? event.runId.trim() : null),
      };
      const runId = typeof event.runId === 'string' ? event.runId.trim() : '';
      if (event.kind !== COLLECT_GUARD_FINAL_KIND) {
        diagnosticDetail = 'reason=kind_not_final';
        return undefined;
      }
      if (event.channel !== COLLECT_GUARD_CHANNEL) {
        diagnosticDetail = 'reason=channel_not_slack';
        return undefined;
      }
      if (!runId) {
        diagnosticDetail = 'reason=run_id_missing';
        return undefined;
      }
      sweep();
      const entry = pending.get(runId);
      if (!entry) {
        diagnosticDetail = `reason=no_pending_entry pending=${pending.size}`;
        return undefined;
      }
      // One answer is answered once: a later payload in the same run is delivered untouched.
      pending.delete(runId);
      if (entry.facts.preparedForSubmit) {
        diagnosticDetail = 'reason=prepared_for_submit';
        return undefined;
      }
      const payload = event.payload;
      if (!isRecord(payload) || readPayloadText(payload) === null) {
        diagnosticDetail = 'reason=payload_without_text';
        return undefined;
      }
      // Spread the original payload and replace only its text, so media, metadata, threading and
      // every other property the host set stay exactly as they were.
      diagnosticOutcome = 'hit';
      diagnosticDetail = 'payload_text_replaced';
      return { payload: { ...payload, text: buildSafeText(entry.facts) } };
    } catch {
      // Fail open by design: an unusable event or an unexpected shape leaves the payload exactly as
      // the host made it and delivery proceeds. Nothing is suppressed, and the guard makes no claim
      // about internal vocabulary in a reply it did not rebuild.
      diagnosticDetail = 'reason=threw';
      return undefined;
    } finally {
      if (Object.keys(diagnosticFields).length === 0) {
        diagnosticFields = { channel: '<none>', kind: '<none>', run: '<none>' };
      }
      emitDiagnostic('reply_payload_sending.entry', diagnosticFields);
      if (diagnosticOutcome === 'hit') {
        emitDiagnostic('reply_payload_sending.hit', { ...diagnosticFields, detail: diagnosticDetail });
      } else {
        emitRefusal('reply_payload_sending', { ...diagnosticFields, detail: diagnosticDetail }, true);
      }
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
