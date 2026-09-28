import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../plugins/rein-operations/index.ts';
import {
  COLLECT_GUARD_CHANNEL,
  COLLECT_GUARD_FINAL_KIND,
  COLLECT_GUARD_TOOL_NAME,
  COLLECT_REPLY_GUARD_DIAG_ENV,
  COLLECT_REPLY_GUARD_SHARED_STATE_KEY,
  COLLECT_REPLY_GUARD_TOOL_NAMES,
  COLLECT_REPLY_GUARD_MAX_ENTRIES,
  COLLECT_REPLY_GUARD_TTL_MS,
  SUBMIT_GUARD_TOOL_NAME,
  TOOL_SEARCH_DISPATCHER_TOOL_NAME,
  createCollectReplyGuard,
} from '../plugins/rein-operations/mvp-collect-reply-guard.ts';

// Focused tests for the case-3 outbound guard. They drive the guard's own hooks with plain objects,
// so no host, gateway, Slack API or database is involved. Each test asserts on the exact payload
// handed back, which is the only thing the guard is allowed to change.

const RUN = 'run-case3-1';
const OTHER_RUN = 'run-other-1';

/** One successful `rein_proposal_collect` answer, shaped exactly as the tool returns it. */
function collectAnswer(overrides = {}) {
  const details = {
    tool: COLLECT_GUARD_TOOL_NAME,
    ok: true,
    status: 'collecting',
    collected: {
      title: 'September community sharing session',
      summary: 'community sharing session, about fifty people',
      voteType: 'event_pair',
      requestedMinor: 30000,
      currency: 'USD',
      approximateWhen: 'sometime in October',
    },
    missingFields: ['voteType'],
    advisoryMissingFields: [],
    readyForSubmit: false,
    nextPrompt: ['这属于哪一类提案？类型由运营配置决定，如果你不确定，我先说明可选的范围再一起选一个。'],
    summaryConfirmationRequired:
      'The rough timing the proposer gave is not a stored field: put it into the proposal summary and confirm that wording with the proposer before submit.',
    proposalId: null,
    preparedTitle: null,
    submitted: false,
    recorded: false,
    draftToken: 'rein_proposal_draft.rpd1.OPAQUE-TOKEN-VALUE',
    draftTokenExpiresAt: '2026-09-27T11:00:00.000Z',
    note: 'These fields are held in the draft token only.',
    authorizesSpending: false,
    ...overrides,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(details) }],
    details,
  };
}

/** The model's own (unsafe) final reply: it echoes the internal type code and field names. */
const unsafeFinalPayload = () => ({
  text: '已记录：title=九月分享会，voteType=event_pair，requestedMinor=30000。confirmationToken=abc',
  replyToId: '1700000000.000100',
  media: [{ url: 'https://example.invalid/poster.png' }],
  metadata: { silentReply: false },
});

/**
 * A store key no other guard in this file shares. The guard's default store is deliberately
 * process-wide, so a test that wants one instance in isolation names its own key instead of writing
 * into the slot the plugin's own registration uses; the tests that prove two instances meet, or that
 * two keys stay apart, pass their own keys explicitly.
 */
const isolatedStoreKey = () => Symbol('rein-mvp-guard-test-instance');

const buildGuard = (options = {}) =>
  createCollectReplyGuard({ now: () => 0, stateKey: isolatedStoreKey(), ...options });

/**
 * Arm the guard with one successful collect. Omitted options fall back to the defaults, and an
 * explicit `runId: undefined` genuinely omits the field, so a test can prove what a missing run id
 * does instead of silently reusing the default.
 */
function arm(guard, options = {}) {
  const { error } = options;
  // `result: undefined` must stay genuinely absent, exactly as a host event with no result would be,
  // so the default only applies when the key itself is missing.
  const result = Object.hasOwn(options, 'result') ? options.result : collectAnswer();
  const event = { toolName: COLLECT_GUARD_TOOL_NAME, params: {}, toolCallId: 'call-1', result };
  const runId = Object.hasOwn(options, 'runId') ? options.runId : RUN;
  if (runId !== undefined) event.runId = runId;
  if (error !== undefined) event.error = error;
  guard.afterToolCall(event);
  return guard;
}

/**
 * Feed one `rein_governance_proposal_submit` call through the guard. The guard only ever clears the run's
 * remembered collect here; it reads nothing out of the submit answer, so a bare event is enough to
 * prove the clearing. `error` marks a failed submit, which must clear just the same.
 */
function observeSubmit(guard, options = {}) {
  const event = { toolName: SUBMIT_GUARD_TOOL_NAME, params: {}, toolCallId: 'call-submit-1' };
  const runId = Object.hasOwn(options, 'runId') ? options.runId : RUN;
  if (runId !== undefined) event.runId = runId;
  if (options.error !== undefined) event.error = options.error;
  if (Object.hasOwn(options, 'result')) event.result = options.result;
  guard.afterToolCall(event);
  return guard;
}

/**
 * Send one payload through the guard. Omitted options fall back to the matching defaults, while an
 * explicit `undefined` (for example `{ channel: undefined }`) genuinely omits the field, so a test
 * can prove what a missing surface or run id does instead of silently reusing a default.
 */
const send = (guard, options = {}) => {
  const event = { payload: options.payload ?? unsafeFinalPayload(), sessionKey: 'sess-1' };
  event.kind = Object.hasOwn(options, 'kind') ? options.kind : COLLECT_GUARD_FINAL_KIND;
  event.channel = Object.hasOwn(options, 'channel') ? options.channel : COLLECT_GUARD_CHANNEL;
  event.runId = Object.hasOwn(options, 'runId') ? options.runId : RUN;
  return guard.replyPayloadSending(event);
};

test('the guard names exactly one tool, surface and dispatch kind', () => {
  assert.equal(COLLECT_GUARD_TOOL_NAME, 'rein_proposal_collect');
  assert.equal(COLLECT_GUARD_CHANNEL, 'slack');
  assert.equal(COLLECT_GUARD_FINAL_KIND, 'final');
  assert.equal(TOOL_SEARCH_DISPATCHER_TOOL_NAME, 'tool_call');
  assert.ok(COLLECT_REPLY_GUARD_TTL_MS > 0);
  assert.ok(COLLECT_REPLY_GUARD_MAX_ENTRIES >= 1);
});

test('a successful collect replaces only the matching final Slack payload with safe plain copy', () => {
  const guard = arm(buildGuard());
  assert.equal(guard.pendingCount(), 1);
  const original = unsafeFinalPayload();
  const outcome = guard.replyPayloadSending({
    payload: original,
    kind: COLLECT_GUARD_FINAL_KIND,
    channel: COLLECT_GUARD_CHANNEL,
    runId: RUN,
    sessionKey: 'sess-1',
  });
  assert.ok(outcome, 'the guard must return a replacement result');
  const replacement = outcome.payload;

  // Only the text changed: everything else the host set is preserved.
  assert.equal(replacement.replyToId, original.replyToId);
  assert.deepEqual(replacement.media, original.media);
  assert.deepEqual(replacement.metadata, original.metadata);
  assert.notEqual(replacement.text, original.text);
  // The payload handed in by the host is not mutated in place.
  assert.equal(original.text, unsafeFinalPayload().text);

  // No internal vocabulary survives into the member-facing text.
  const spoken = replacement.text;
  for (const forbidden of [
    'event_pair',
    'voteType',
    'requestedMinor',
    'draftToken',
    'rein_proposal_draft',
    'OPAQUE-TOKEN-VALUE',
    'confirmationToken',
    'missingFields',
    'readyForSubmit',
    'rein_proposal_collect',
    'summaryConfirmationRequired',
  ]) {
    assert.ok(!spoken.includes(forbidden), `member text leaked ${forbidden}: ${spoken}`);
  }

  // It does repeat the proposer's own words and the tool's own ready-made question, and it states
  // plainly that nothing has been submitted yet.
  assert.ok(spoken.includes('September community sharing session'), spoken);
  assert.ok(spoken.includes('sometime in October'), spoken);
  assert.ok(spoken.includes('这属于哪一类提案？'), spoken);
  assert.ok(/不提交/.test(spoken), spoken);
});

test('no amount, currency code or minor-unit number is ever repeated into the member text', () => {
  // The tool carries one amount in minor units plus a currency code, and how many minor units make
  // one major unit is a per-currency fact this guard does not know: 100 for USD, 1 for JPY, 1000 for
  // BHD. So the guard repeats neither the number nor the code, and it cannot print a wrong amount in
  // any currency. Only the fact that an amount and a currency arrived together is named.
  const cases = [
    { requestedMinor: 30000, currency: 'USD', extra: { title: null, summary: null, approximateWhen: null } },
    { requestedMinor: 30000, currency: 'JPY', extra: { title: null, summary: null, approximateWhen: null } },
    { requestedMinor: 1000, currency: 'BHD', extra: { title: null, summary: null, approximateWhen: null } },
    { requestedMinor: 0, currency: 'JPY', extra: { title: null, summary: null, approximateWhen: null } },
  ];
  for (const { requestedMinor, currency, extra } of cases) {
    const guard = arm(buildGuard(), {
      result: collectAnswer({
        collected: { ...collectAnswer().details.collected, requestedMinor, currency, ...extra },
      }),
    });
    const outcome = send(guard);
    assert.ok(outcome, `${currency} must still be answered with safe copy`);
    const spoken = outcome.payload.text;
    // No digits at all, in any of these: a major-unit amount, a minor-unit amount or a currency code.
    assert.ok(!/\d/.test(spoken), `member text repeated a number for ${currency}: ${spoken}`);
    assert.ok(!spoken.includes(currency), `member text repeated the ${currency} code: ${spoken}`);
    assert.ok(spoken.includes('预算'), spoken);
  }
  // A collect that pairs an amount with a currency still repeats the proposer's own other words, so
  // the amount rule narrows the amount only and does not silence the guard.
  const withTitle = arm(buildGuard(), {
    result: collectAnswer({
      collected: { ...collectAnswer().details.collected, requestedMinor: 30000, currency: 'JPY' },
    }),
  });
  const withTitleText = send(withTitle).payload.text;
  assert.ok(withTitleText.includes('September community sharing session'), withTitleText);
  assert.ok(withTitleText.includes('预算'), withTitleText);
  assert.ok(!withTitleText.includes('JPY'), withTitleText);
});

test('an unpaired amount or currency is never named as a recorded budget', () => {
  // The tool records an amount and its currency together or not at all, so these shapes come from
  // nothing the tool produces. The guard still refuses to claim a budget was recorded, because a
  // half pair is not a budget: it narrows the claim to the proposer's own words instead.
  const halfPairs = [
    { requestedMinor: 30000, currency: null },
    { requestedMinor: null, currency: 'USD' },
  ];
  for (const collected of halfPairs) {
    const guard = arm(buildGuard(), {
      result: collectAnswer({
        collected: {
          ...collectAnswer().details.collected,
          ...collected,
          title: null,
          summary: null,
          approximateWhen: null,
        },
      }),
    });
    const outcome = send(guard);
    assert.ok(outcome, 'the reply is still guarded');
    assert.ok(!outcome.payload.text.includes('预算'), outcome.payload.text);
    assert.ok(!/\d/.test(outcome.payload.text), outcome.payload.text);
  }
});

test('the same run is answered once and then swept', () => {
  const guard = arm(buildGuard());
  assert.ok(send(guard));
  assert.equal(guard.pendingCount(), 0);
  // A second payload for the same run is delivered exactly as the host made it.
  assert.equal(send(guard), undefined);
});

test('a run with no successful collect is untouched', () => {
  const guard = buildGuard();
  assert.equal(send(guard), undefined);
  assert.equal(guard.pendingCount(), 0);
  // A collect in another run never licenses a replacement in this one, and the other run keeps its
  // own entry: isolation is per run, not per guard.
  arm(guard, { runId: OTHER_RUN });
  assert.equal(send(guard), undefined);
  assert.equal(guard.pendingCount(), 1);
});

test('a submit in the same run clears the remembered collect and leaves the submit reply alone', () => {
  // The same run that collected then submitted: the run's reply is the submit outcome, so the
  // remembered collect must be dropped rather than rewritten into the collect prompt.
  const guard = arm(buildGuard());
  assert.equal(guard.pendingCount(), 1);
  observeSubmit(guard);
  assert.equal(guard.pendingCount(), 0);
  assert.equal(send(guard), undefined);
});

test('a failed submit also clears the remembered collect', () => {
  // A submit that errored is still a submit: its outcome is what the run must deliver, so the
  // clearing does not depend on the submit succeeding.
  const guard = arm(buildGuard());
  assert.equal(guard.pendingCount(), 1);
  observeSubmit(guard, { error: 'tool failed' });
  assert.equal(guard.pendingCount(), 0);
  assert.equal(send(guard), undefined);
});

test('a submit in another run never clears this run collect', () => {
  const guard = arm(buildGuard());
  observeSubmit(guard, { runId: OTHER_RUN });
  // Clearing is per run: the other run's submit leaves this run's collect intact and still guarded.
  assert.equal(guard.pendingCount(), 1);
  assert.ok(send(guard));
});

test('a submit with no run id clears nothing and arms nothing', () => {
  const guard = arm(buildGuard());
  observeSubmit(guard, { runId: undefined });
  assert.equal(guard.pendingCount(), 1);
});

test('a missing run id arms nothing and replaces nothing', () => {
  const guard = buildGuard();
  arm(guard, { runId: undefined });
  assert.equal(guard.pendingCount(), 0);
  assert.equal(send(guard), undefined);
  assert.equal(send(guard, { runId: undefined }), undefined);
});

test('non-final dispatch kinds are never rewritten', () => {
  for (const kind of ['tool', 'block']) {
    const guard = arm(buildGuard());
    assert.equal(send(guard, { kind }), undefined, kind);
    // The entry survives the bypass, so the eventual final reply is still guarded.
    assert.equal(guard.pendingCount(), 1);
    assert.ok(send(guard, { kind: COLLECT_GUARD_FINAL_KIND }));
  }
});

test('a non-Slack surface is never rewritten', () => {
  for (const channel of ['discord', 'telegram', undefined]) {
    const guard = arm(buildGuard());
    assert.equal(send(guard, { channel }), undefined, String(channel));
    assert.equal(guard.pendingCount(), 1);
  }
});

test('a failed collect never arms a replacement', () => {
  const guard = buildGuard();
  arm(guard, {
    result: {
      content: [{ type: 'text', text: JSON.stringify({ tool: COLLECT_GUARD_TOOL_NAME, ok: false, error: 'channel_out_of_scope' }) }],
      details: { tool: COLLECT_GUARD_TOOL_NAME, ok: false, error: 'channel_out_of_scope', message: 'limited to its approved proposal channel' },
    },
  });
  assert.equal(guard.pendingCount(), 0);
  assert.equal(send(guard), undefined);

  const withError = arm(buildGuard(), { error: 'tool failed' });
  assert.equal(withError.pendingCount(), 0);
  assert.equal(send(withError), undefined);
});

test('a malformed or unrecognized result is refused rather than guessed at', () => {
  const shapes = [
    { result: undefined },
    { result: 'not an object' },
    // No collected preview to repeat back.
    { result: { details: { tool: COLLECT_GUARD_TOOL_NAME, ok: true, status: 'collecting', recorded: false } } },
    { result: { content: [{ type: 'text', text: 'not json' }], details: null } },
    // A collecting answer that claims something was recorded is not the read-only collecting shape.
    { result: { details: { tool: COLLECT_GUARD_TOOL_NAME, ok: true, status: 'collecting', recorded: true, collected: {} } } },
    // A different tool's answer is never accepted even if it mimics the shape.
    { result: { details: { tool: 'rein_governance_proposal_submit', ok: true, status: 'collecting', recorded: false, collected: {} } } },
    // A non-collecting status is not the shape the member-facing prompt belongs to.
    { result: { details: { tool: COLLECT_GUARD_TOOL_NAME, ok: true, status: 'prepared', recorded: false, collected: {} } } },
  ];
  for (const shape of shapes) {
    const guard = buildGuard();
    arm(guard, shape);
    assert.equal(guard.pendingCount(), 0, JSON.stringify(shape));
    assert.equal(send(guard), undefined);
  }
});

test('an author-prepared ready-to-submit result leaves the reply to the prepare flow', () => {
  const guard = arm(buildGuard(), {
    result: collectAnswer({ readyForSubmit: true, proposalId: 'proposal-uuid', preparedTitle: 'September community sharing session' }),
  });
  assert.equal(guard.pendingCount(), 1);
  assert.equal(send(guard), undefined);
  // Consumed, so the read-back reply is the only one and it is the model's own.
  assert.equal(guard.pendingCount(), 0);
});

test('the safer details shape and the text-only content shape both arm the guard', () => {
  const contentOnly = buildGuard();
  contentOnly.afterToolCall({
    toolName: COLLECT_GUARD_TOOL_NAME,
    params: {},
    runId: RUN,
    result: collectAnswer(),
  });
  assert.equal(contentOnly.pendingCount(), 1);
  const replaced = send(contentOnly);
  assert.ok(replaced);
  assert.ok(!replaced.payload.text.includes('event_pair'));
});

// --- Tool Search dispatch ------------------------------------------------------------------------
// On a live Gateway the collect and submit tools are reached through Tool Search: the host runs one
// outer dispatcher tool named `tool_call`, so `after_tool_call` reports that outer name and the
// dispatcher's envelope rather than the guest tool. The wrapper shapes below mirror a real `tool_call`
// result, where `details.tool` is the host-resolved identity (with a namespaced id) and
// `details.result` is the guest outcome whose own `details` carries the collected preview.

/**
 * One `tool_call` result for a successful collect: the host envelope wraps the guest tool's own
 * `AgentToolResult` (its `content` text block plus its `details`).
 */
function wrappedCollectResult(guest = collectAnswer(), toolNameOverride) {
  const name = toolNameOverride ?? COLLECT_GUARD_TOOL_NAME;
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          tool: { id: `openclaw:rein-operations:${name}`, name, source: 'openclaw' },
          result: guest.details,
        }),
      },
    ],
    details: {
      tool: { id: `openclaw:rein-operations:${name}`, name, source: 'openclaw' },
      result: guest,
    },
  };
}

/** One `tool_call` result for a submit in the same run; only its host identity matters to the guard. */
function wrappedSubmitResult(result = { details: { tool: SUBMIT_GUARD_TOOL_NAME, ok: true } }) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ tool: { name: SUBMIT_GUARD_TOOL_NAME }, result }) }],
    details: {
      tool: {
        id: `openclaw:rein-operations:${SUBMIT_GUARD_TOOL_NAME}`,
        name: SUBMIT_GUARD_TOOL_NAME,
        source: 'openclaw',
      },
      result,
    },
  };
}

/** Arm the guard through the outer `tool_call` dispatcher, exactly as the host reports it. */
function armViaToolSearch(guard, options = {}) {
  const event = {
    toolName: TOOL_SEARCH_DISPATCHER_TOOL_NAME,
    // The model-authored outer params: the guard must never consult these for identity.
    params: options.params ?? { id: COLLECT_GUARD_TOOL_NAME, args: {} },
    toolCallId: 'call-ts-1',
    result: Object.hasOwn(options, 'result') ? options.result : wrappedCollectResult(),
  };
  event.runId = Object.hasOwn(options, 'runId') ? options.runId : RUN;
  if (options.error !== undefined) event.error = options.error;
  guard.afterToolCall(event);
  return guard;
}

/** Feed one `tool_call`-wrapped submit through the guard. */
function observeSubmitViaToolSearch(guard, options = {}) {
  const event = {
    toolName: TOOL_SEARCH_DISPATCHER_TOOL_NAME,
    params: options.params ?? { id: SUBMIT_GUARD_TOOL_NAME, args: {} },
    toolCallId: 'call-ts-submit-1',
    result: Object.hasOwn(options, 'result') ? options.result : wrappedSubmitResult(),
  };
  event.runId = Object.hasOwn(options, 'runId') ? options.runId : RUN;
  if (options.error !== undefined) event.error = options.error;
  guard.afterToolCall(event);
  return guard;
}

test('a collect dispatched through Tool Search arms the guard and rewrites the final reply', () => {
  // The outer event names `tool_call`, not the guest tool: without unwrapping, this is the exact
  // live path that left the reply as model prose.
  const guard = buildGuard();
  armViaToolSearch(guard);
  assert.equal(guard.pendingCount(), 1);
  const original = unsafeFinalPayload();
  const outcome = guard.replyPayloadSending({
    payload: original,
    kind: COLLECT_GUARD_FINAL_KIND,
    channel: COLLECT_GUARD_CHANNEL,
    runId: RUN,
    sessionKey: 'sess-1',
  });
  assert.ok(outcome, 'a dispatched collect must still arm the replacement');
  assert.notEqual(outcome.payload.text, original.text);
  for (const forbidden of [
    'event_pair',
    'voteType',
    'requestedMinor',
    'draftToken',
    'rein_proposal_draft',
    'missingFields',
    'rein_proposal_collect',
  ]) {
    assert.ok(
      !outcome.payload.text.includes(forbidden),
      `member text leaked ${forbidden}: ${outcome.payload.text}`,
    );
  }
  assert.ok(outcome.payload.text.includes('September community sharing session'), outcome.payload.text);
  assert.ok(outcome.payload.text.includes('这属于哪一类提案？'), outcome.payload.text);
});

test('a spoofed outer params.id never decides identity through Tool Search', () => {
  // The wrapper's host identity is the submit tool, but the model wrote a collect id in the outer
  // params. The guard must trust the host envelope and treat this as a submit, not a collect.
  const guard = buildGuard();
  armViaToolSearch(guard, {
    result: wrappedCollectResult(collectAnswer(), SUBMIT_GUARD_TOOL_NAME),
    params: { id: COLLECT_GUARD_TOOL_NAME, args: { title: 'spoofed' } },
  });
  assert.equal(guard.pendingCount(), 0);

  // The reverse: the host identity is the collect tool while the params claim a submit. This is a
  // collect, and it arms, because the host identity says so.
  const collecting = buildGuard();
  armViaToolSearch(collecting, {
    result: wrappedCollectResult(),
    params: { id: SUBMIT_GUARD_TOOL_NAME, args: {} },
  });
  assert.equal(collecting.pendingCount(), 1);
  assert.ok(send(collecting));
});

test('a spoofed outer params.id in a submit wrapper never clears a remembered collect', () => {
  // The envelope identifies the submit tool, and the params claim collect. The guard reads the host
  // identity only, so the submit still clears.
  const guard = arm(buildGuard());
  observeSubmitViaToolSearch(guard, {
    result: wrappedSubmitResult(),
    params: { id: COLLECT_GUARD_TOOL_NAME, args: {} },
  });
  assert.equal(guard.pendingCount(), 0, 'a submit dispatch clears regardless of the outer params');
  assert.equal(send(guard), undefined);
});

test('a submit dispatched through Tool Search clears the remembered collect', () => {
  const guard = armViaToolSearch(buildGuard());
  assert.equal(guard.pendingCount(), 1);
  observeSubmitViaToolSearch(guard);
  assert.equal(guard.pendingCount(), 0);
  assert.equal(send(guard), undefined);
});

test('an unrelated tool dispatched through Tool Search is ignored', () => {
  // A `tool_call` for a tool that is not the guard's own must neither arm nor replace, whether or
  // not its body happens to carry a collected-looking object.
  for (const name of ['rein_poll_result', 'rein_status', 'some_other_tool']) {
    const guard = buildGuard();
    armViaToolSearch(guard, {
      result: wrappedCollectResult(collectAnswer(), name),
      params: { id: name, args: {} },
    });
    assert.equal(guard.pendingCount(), 0, name);
    assert.equal(send(guard), undefined, name);
  }
});

test('a malformed Tool Search envelope is refused rather than guessed at', () => {
  const shapes = [
    // No host identity at all.
    { result: { content: [], details: { result: collectAnswer() } } },
    // Identity present but no guest outcome.
    { result: { content: [], details: { tool: { name: COLLECT_GUARD_TOOL_NAME } } } },
    // Identity is not an object.
    { result: { content: [], details: { tool: COLLECT_GUARD_TOOL_NAME, result: collectAnswer() } } },
    // A non-object result.
    { result: 'not an object' },
    // A failed guest outcome never arms, even through the dispatcher.
    {
      result: {
        content: [],
        details: {
          tool: { name: COLLECT_GUARD_TOOL_NAME },
          result: { details: { tool: COLLECT_GUARD_TOOL_NAME, ok: false, error: 'x' } },
        },
      },
    },
  ];
  for (const shape of shapes) {
    const guard = buildGuard();
    armViaToolSearch(guard, shape);
    assert.equal(guard.pendingCount(), 0, JSON.stringify(shape));
    assert.equal(send(guard), undefined);
  }
});

test('a Tool Search dispatch with no run id arms nothing and replaces nothing', () => {
  const guard = buildGuard();
  armViaToolSearch(guard, { runId: undefined });
  assert.equal(guard.pendingCount(), 0);
  assert.equal(send(guard, { runId: undefined }), undefined);
});

test('a payload without text is left alone', () => {
  const guard = arm(buildGuard());
  const outcome = send(guard, { payload: { replyToId: '1700000000.000100' } });
  assert.equal(outcome, undefined);
  // The entry is consumed by the attempt so it cannot be replayed onto a later payload.
  assert.equal(guard.pendingCount(), 0);
});

test('an expired entry is swept and never rewrites a later reply', () => {
  let clock = 0;
  const guard = createCollectReplyGuard({ now: () => clock, ttlMs: 60_000, stateKey: isolatedStoreKey() });
  arm(guard);
  assert.equal(guard.pendingCount(), 1);
  clock = 60_001;
  assert.equal(guard.pendingCount(), 0);
  assert.equal(send(guard), undefined);
});

test('the remembered set is bounded and drops the oldest run first', () => {
  const guard = createCollectReplyGuard({ now: () => 0, maxEntries: 2, stateKey: isolatedStoreKey() });
  arm(guard, { runId: 'run-a' });
  arm(guard, { runId: 'run-b' });
  arm(guard, { runId: 'run-c' });
  assert.equal(guard.pendingCount(), 2);
  // The oldest run is gone; the two most recent still guard their own replies.
  assert.equal(send(guard, { runId: 'run-a' }), undefined);
  assert.ok(send(guard, { runId: 'run-b' }));
});

// --- One store across guard instances ------------------------------------------------------------
// A live Gateway loaded this plugin more than once: two byte-identical build trees, each with its own
// bundled module graph and its own copy of this module. Each copy built its own guard, so the arming
// `after_tool_call` hook wrote into one instance's map and the `reply_payload_sending` hook looked in
// another instance's empty map. The arm was real (`pending=1`) and the reply still rejected with
// `no_pending_entry pending=0`, and the member got the model's own prose. These tests pin the fix:
// the remembered entries live in one store that every loaded copy in the process reaches.

test('a collect armed in one guard instance rewrites the reply delivered by another', () => {
  const key = Symbol.for('rein-mvp-collect-reply-guard-test.two-instance');
  const arming = createCollectReplyGuard({ now: () => 0, stateKey: key });
  const replying = createCollectReplyGuard({ now: () => 0, stateKey: key });

  // Arm through the live Tool Search shape, exactly as the arming module graph sees it.
  armViaToolSearch(arming);
  assert.equal(replying.pendingCount(), 1, 'the armed entry must be visible to the other instance');

  const outcome = send(replying);
  assert.ok(outcome, 'a collect armed elsewhere must still rewrite this instance reply');
  assert.ok(!outcome.payload.text.includes('event_pair'), outcome.payload.text);
  assert.ok(outcome.payload.text.includes('September community sharing session'), outcome.payload.text);

  // One-shot across instances: the read consumed the entry for both, so neither rewrites again.
  assert.equal(arming.pendingCount(), 0);
  assert.equal(send(arming), undefined);
  assert.equal(send(replying), undefined);
});

test('two instances built without a key share the plugin-wide slot by default', () => {
  // The registration passes no key at all, so the default has to be the process-wide slot: that is
  // the exact pairing that failed live.
  const arming = createCollectReplyGuard({ now: () => 0 });
  const replying = createCollectReplyGuard({ now: () => 0 });
  const slot = Symbol.for(COLLECT_REPLY_GUARD_SHARED_STATE_KEY);
  const store = globalThis[slot];
  assert.equal(store?.version, 1, 'the default store must live in the documented versioned slot');
  assert.ok(store.entries instanceof Map);

  const runId = 'run-default-shared-store';
  arm(arming, { runId });
  assert.equal(store.entries.has(runId), true, 'the default store must be the process-wide slot');
  assert.equal(replying.pendingCount(), 1);
  assert.ok(send(replying, { runId }), 'the default store must carry the arm to the other instance');
  assert.equal(arming.pendingCount(), 0);
});

test('a submit seen by another instance clears the collect armed by the first', () => {
  const key = Symbol.for('rein-mvp-collect-reply-guard-test.two-instance-submit');
  const arming = createCollectReplyGuard({ now: () => 0, stateKey: key });
  const submitting = createCollectReplyGuard({ now: () => 0, stateKey: key });

  // Control: a submit in a different run is not this run's submit and leaves the arm intact.
  arm(arming);
  observeSubmit(submitting, { runId: OTHER_RUN });
  assert.equal(arming.pendingCount(), 1);
  assert.ok(send(arming));

  // Same run, observed by the other instance: the collect is dropped for both, so the submit outcome
  // is delivered as the model wrote it rather than rewritten into the collect prompt.
  arm(arming);
  observeSubmit(submitting);
  assert.equal(arming.pendingCount(), 0);
  assert.equal(send(arming), undefined);
  assert.equal(send(submitting), undefined);
});

test('an entry armed in one instance is swept on the other instance clock', () => {
  // Two separate clocks, so the expiry is proved to happen on the reading instance's own clock and
  // not because the arming instance happened to look again.
  let armingClock = 0;
  let replyingClock = 0;
  const key = Symbol.for('rein-mvp-collect-reply-guard-test.two-instance-expiry');
  const arming = createCollectReplyGuard({ now: () => armingClock, ttlMs: 60_000, stateKey: key });
  const replying = createCollectReplyGuard({ now: () => replyingClock, ttlMs: 60_000, stateKey: key });

  // One millisecond inside the TTL the reply instance still finds the entry and rewrites.
  arm(arming);
  replyingClock = 59_999;
  assert.ok(send(replying));

  // Past the TTL the reading instance sweeps the entry, so the later reply is left alone and the
  // shared store cannot grow without bound across instances.
  arm(arming);
  replyingClock = 60_000;
  assert.equal(replying.pendingCount(), 0, 'the reading instance sweeps the expired entry');
  assert.equal(send(replying), undefined);
  assert.equal(armingClock, 0, 'the arming instance was never consulted to expire the entry');
});

test('two stores stay apart unless the instances are given the same key', () => {
  const first = createCollectReplyGuard({ now: () => 0, stateKey: Symbol('store-first') });
  const second = createCollectReplyGuard({ now: () => 0, stateKey: Symbol('store-second') });
  arm(first);
  assert.equal(second.pendingCount(), 0, 'a different key is a different store');
  assert.equal(send(second), undefined);
  assert.ok(send(first), 'the arming instance still answers its own run');

  // A string key is interned, so the same text names the same store in both instances.
  const textFirst = createCollectReplyGuard({ now: () => 0, stateKey: 'rein-mvp-guard-test.text-key' });
  const textSecond = createCollectReplyGuard({ now: () => 0, stateKey: 'rein-mvp-guard-test.text-key' });
  arm(textFirst);
  assert.ok(send(textSecond), 'the same string key must name the same store');

  // `null` is the explicit opt-out: private memory, never the process-wide slot.
  const privateFirst = createCollectReplyGuard({ now: () => 0, stateKey: null });
  const privateSecond = createCollectReplyGuard({ now: () => 0, stateKey: null });
  arm(privateFirst);
  assert.equal(privateSecond.pendingCount(), 0);
  assert.equal(send(privateSecond), undefined);
  assert.ok(send(privateFirst));
});

test('a foreign or stale object in the shared slot is replaced rather than trusted', () => {
  // A slot another shape version, another library or a hostile loader left behind must never be read
  // as a store: anything this module did not write is replaced, and the guard still arms and rewrites.
  const slot = Symbol.for(COLLECT_REPLY_GUARD_SHARED_STATE_KEY);
  const junk = ['not a store', null, { version: 999, entries: new Map() }, { version: 1, entries: 'not a map' }];
  junk.forEach((value, index) => {
    globalThis[slot] = value;
    const runId = `run-replaced-slot-${index}`;
    const guard = createCollectReplyGuard({ now: () => 0 });
    arm(guard, { runId });
    const outcome = send(guard, { runId });
    assert.ok(outcome, `slot ${JSON.stringify(value)} must be replaced, not trusted`);
    assert.notEqual(globalThis[slot], value);
    assert.equal(globalThis[slot].version, 1);
    assert.ok(globalThis[slot].entries instanceof Map);
  });
});

test('the guard never mutates the event it is handed', () => {
  const guard = arm(buildGuard());
  const event = { payload: unsafeFinalPayload(), kind: 'final', channel: 'slack', runId: RUN };
  const before = JSON.stringify(event);
  guard.replyPayloadSending(event);
  assert.equal(JSON.stringify(event), before);
});

test('the guard repeats the longest author wording the collect tool can accept, unclipped', () => {
  // The guard may not silently shorten what the proposer said, and it may not repeat a value the
  // tool would have refused either. The tool's own fences are readable from its accepted input: a
  // summary of at most 4000 characters, a title of at most 200 and a rough timing of at most 120.
  // The guard's budget is the widest of those, so a legal summary comes back whole.
  const longestSummary = 'S'.repeat(4000);
  const guard = arm(buildGuard(), {
    result: collectAnswer({
      collected: { ...collectAnswer().details.collected, summary: longestSummary },
    }),
  });
  const outcome = send(guard);
  assert.ok(outcome);
  assert.ok(
    outcome.payload.text.includes(longestSummary),
    'a summary the tool accepted must be repeated whole, not truncated',
  );
  // One character past the tool's own widest fence is a shape this tool cannot produce, so the guard
  // clips rather than repeating it back unbounded.
  const overlong = 'S'.repeat(4001);
  const clipped = arm(buildGuard(), {
    result: collectAnswer({
      collected: { ...collectAnswer().details.collected, summary: overlong },
    }),
  });
  const clippedText = send(clipped).payload.text;
  assert.ok(!clippedText.includes(overlong), 'a value past the tool fence must not be repeated whole');
  assert.ok(clippedText.includes('S'.repeat(4000)), clippedText);
});

test('the real entry registers both guard hooks, matched to the collect and submit tools', () => {
  // The entry only needs the guard's hooks here; the fake api stands in for the host registrar so no
  // config, secret or live call is needed to prove the wiring.
  process.env.REIN_GUARD_TEST_URL = 'https://project-ref.supabase.co';
  process.env.REIN_GUARD_TEST_KEY = 'sb_secret_guard_test_0000000000000000';
  process.env.REIN_GUARD_TEST_CONFIRM = 'guard-test-proposal-confirmation-key-0001';
  const hooks = [];
  const logLines = [];
  plugin.register({
    registrationMode: 'full',
    pluginConfig: {
      foundationDb: {
        enabled: true,
        platform: 'slack',
        slackTeamId: 'T0123456ABC',
        environment: 'dev',
        proposalChannelIds: ['C_PROPOSAL'],
        boardChannelIds: ['C_BOARD'],
        supabaseUrlEnvVar: 'REIN_GUARD_TEST_URL',
        supabaseServiceKeyEnvVar: 'REIN_GUARD_TEST_KEY',
        proposalConfirmationKeyEnvVar: 'REIN_GUARD_TEST_CONFIRM',
      },
    },
    registerTool() {},
    logger: { info: line => logLines.push(line), warn() {}, error() {} },
    on(hookName, handler, options) {
      hooks.push({ hookName, handler, options });
    },
  });
  // This guard owns the first two registrations; a second reply guard (the case-7 poll-result guard)
  // registers its own pair after them, so this names its own hooks instead of the whole list.
  assert.deepEqual(hooks.slice(0, 2).map(hook => hook.hookName), ['after_tool_call', 'reply_payload_sending']);
  assert.deepEqual(hooks[0].options, { matcher: [...COLLECT_REPLY_GUARD_TOOL_NAMES] });
  // The matcher must admit both guard tools and the Tool Search dispatcher that carries them live.
  assert.deepEqual([...COLLECT_REPLY_GUARD_TOOL_NAMES], [
    COLLECT_GUARD_TOOL_NAME,
    SUBMIT_GUARD_TOOL_NAME,
    TOOL_SEARCH_DISPATCHER_TOOL_NAME,
  ]);
  // The registered handlers are the guard's own, and the wiring round-trips a reply end to end.
  hooks[0].handler({ toolName: COLLECT_GUARD_TOOL_NAME, params: {}, runId: RUN, result: collectAnswer() });
  const outcome = hooks[1].handler({
    payload: unsafeFinalPayload(),
    kind: COLLECT_GUARD_FINAL_KIND,
    channel: COLLECT_GUARD_CHANNEL,
    runId: RUN,
  });
  assert.ok(outcome, 'the registered reply hook must replace the matching final payload');
  assert.ok(!outcome.payload.text.includes('event_pair'), outcome.payload.text);

  // The same registered handler must also arm from a live Tool Search dispatch, where the outer
  // tool is `tool_call` and the real tool identity lives in the host envelope. Without the dispatcher
  // in the matcher this arming would never run, which is the live miss this fix closes.
  hooks[0].handler({
    toolName: TOOL_SEARCH_DISPATCHER_TOOL_NAME,
    params: { id: COLLECT_GUARD_TOOL_NAME },
    runId: RUN,
    result: wrappedCollectResult(),
  });
  const dispatchedOutcome = hooks[1].handler({
    payload: unsafeFinalPayload(),
    kind: COLLECT_GUARD_FINAL_KIND,
    channel: COLLECT_GUARD_CHANNEL,
    runId: RUN,
  });
  assert.ok(dispatchedOutcome, 'a Tool Search dispatch must arm the registered reply hook');
  assert.ok(!dispatchedOutcome.payload.text.includes('event_pair'), dispatchedOutcome.payload.text);

  // The same registered after_tool_call handler clears a remembered collect when a submit arrives in
  // the run, so the matcher admitting submit is load-bearing: without it, the submit reply would be
  // rewritten into the collect prompt.
  hooks[0].handler({ toolName: COLLECT_GUARD_TOOL_NAME, params: {}, runId: RUN, result: collectAnswer() });
  hooks[0].handler({ toolName: SUBMIT_GUARD_TOOL_NAME, params: {}, runId: RUN, result: { details: { tool: SUBMIT_GUARD_TOOL_NAME, ok: true } } });
  assert.equal(
    hooks[1].handler({
      payload: unsafeFinalPayload(),
      kind: COLLECT_GUARD_FINAL_KIND,
      channel: COLLECT_GUARD_CHANNEL,
      runId: RUN,
    }),
    undefined,
    'a submit in the run must leave the run reply untouched',
  );

  // This registration passed a sink but the trace's environment variable is unset, so the host's
  // gateway log stays exactly as quiet as it was before the diagnostic existed.
  assert.deepEqual(logLines, []);
});

test('the entry threads the host logger into the guard once the trace is switched on', () => {
  // The same entry wiring, this time with the trace's environment variable set: the guard must send its
  // lines to the host's own logger. The variable is restored so no later test inherits it.
  const previous = process.env[COLLECT_REPLY_GUARD_DIAG_ENV];
  process.env[COLLECT_REPLY_GUARD_DIAG_ENV] = '1';
  try {
    process.env.REIN_GUARD_TEST_URL = 'https://project-ref.supabase.co';
    process.env.REIN_GUARD_TEST_KEY = 'sb_secret_guard_test_0000000000000000';
    process.env.REIN_GUARD_TEST_CONFIRM = 'guard-test-proposal-confirmation-key-0001';
    const hooks = [];
    const logLines = [];
    plugin.register({
      registrationMode: 'full',
      pluginConfig: {
        foundationDb: {
          enabled: true,
          platform: 'slack',
          slackTeamId: 'T0123456ABC',
          environment: 'dev',
          proposalChannelIds: ['C_PROPOSAL'],
          boardChannelIds: ['C_BOARD'],
          supabaseUrlEnvVar: 'REIN_GUARD_TEST_URL',
          supabaseServiceKeyEnvVar: 'REIN_GUARD_TEST_KEY',
          proposalConfirmationKeyEnvVar: 'REIN_GUARD_TEST_CONFIRM',
        },
      },
      registerTool() {},
      logger: { info: line => logLines.push(line), warn() {}, error() {} },
      on(hookName, handler, options) {
        hooks.push({ hookName, handler, options });
      },
    });
    hooks[0].handler({
      toolName: TOOL_SEARCH_DISPATCHER_TOOL_NAME,
      params: { id: COLLECT_GUARD_TOOL_NAME },
      runId: RUN,
      result: wrappedCollectResult(),
    });
    const outcome = hooks[1].handler({
      payload: unsafeFinalPayload(),
      kind: COLLECT_GUARD_FINAL_KIND,
      channel: COLLECT_GUARD_CHANNEL,
      runId: RUN,
    });
    assert.ok(outcome, 'the registered reply hook still replaces the matching final payload');
    // One entry line and one classified line per hook: the match, then the arm, then the payload entry
    // and the hit that replaced it.
    assert.equal(logLines.length, 4, logLines.join('\n'));
    assert.ok(logLines[0].startsWith('rein-mvp-guard after_tool_call.match'), logLines[0]);
    assert.ok(logLines[1].startsWith('rein-mvp-guard after_tool_call.arm'), logLines[1]);
    assert.ok(logLines[2].startsWith('rein-mvp-guard reply_payload_sending.entry'), logLines[2]);
    assert.ok(logLines[3].startsWith('rein-mvp-guard reply_payload_sending.hit'), logLines[3]);
    assert.ok(!logLines.join('\n').includes('event_pair'), logLines.join('\n'));
  } finally {
    if (previous === undefined) delete process.env[COLLECT_REPLY_GUARD_DIAG_ENV];
    else process.env[COLLECT_REPLY_GUARD_DIAG_ENV] = previous;
  }
});

// --- Opt-in hook-chain diagnostics ---------------------------------------------------------------
// A live run showed a collect reaching the run while the delivered Slack reply stayed the model's own
// prose, and the host's gateway log could not say why. These tests drive the optional trace that
// answers that question, and they prove it stays silent unless an operator asks for it.

/** Collect the diagnostic lines one guard emits, with the trace switched on for this test. */
function collectDiagnostics(options = {}) {
  const lines = [];
  const guard = createCollectReplyGuard({
    now: () => 0,
    stateKey: isolatedStoreKey(),
    env: { [COLLECT_REPLY_GUARD_DIAG_ENV]: '1' },
    diagnostic: { info: line => lines.push(line) },
    ...options,
  });
  return { guard, lines };
}

const collectLines = lines => lines.filter(line => line.startsWith('rein-mvp-guard after_tool_call'));
const replyLines = lines => lines.filter(line => line.startsWith('rein-mvp-guard reply_payload_sending'));

test('the trace stays silent unless it is explicitly enabled and given a sink', () => {
  // No sink: even with the environment variable set, nothing is emitted.
  const noSink = createCollectReplyGuard({
    now: () => 0,
    stateKey: isolatedStoreKey(),
    env: { [COLLECT_REPLY_GUARD_DIAG_ENV]: '1' },
  });
  arm(noSink);
  assert.ok(send(noSink), 'the guard still works with diagnostics on but no sink');

  // A sink but no environment variable: nothing is emitted either.
  const lines = [];
  const noEnv = createCollectReplyGuard({
    now: () => 0,
    stateKey: isolatedStoreKey(),
    env: {},
    diagnostic: { info: line => lines.push(line) },
  });
  arm(noEnv);
  send(noEnv);
  assert.deepEqual(lines, []);

  // Explicit off values are treated as off.
  for (const value of ['0', 'false', 'off', '']) {
    const offLines = [];
    const off = createCollectReplyGuard({
      now: () => 0,
      stateKey: isolatedStoreKey(),
      env: { [COLLECT_REPLY_GUARD_DIAG_ENV]: value },
      diagnostic: { info: line => offLines.push(line) },
    });
    arm(off);
    send(off);
    assert.deepEqual(offLines, [], `value ${JSON.stringify(value)} must keep the trace off`);
  }
});

test('an armed Tool Search dispatch and a rewritten reply each trace exactly one line', () => {
  const { guard, lines } = collectDiagnostics();
  armViaToolSearch(guard);
  const outcome = send(guard);
  assert.ok(outcome, 'the guard still replaces the reply with diagnostics on');

  // Four lines: the match and the arm for the tool call, then the entry and the hit for the payload.
  assert.equal(lines.length, 4, lines.join('\n'));
  const entryMatch = collectLines(lines)[0];
  assert.ok(entryMatch.startsWith('rein-mvp-guard after_tool_call.match'), entryMatch);
  const armed = collectLines(lines)[1];
  assert.ok(armed.startsWith('rein-mvp-guard after_tool_call.arm'), armed);
  // A dispatched call names both the outer dispatcher it observed and the guest tool it resolved to.
  assert.ok(armed.includes(`observed=${TOOL_SEARCH_DISPATCHER_TOOL_NAME}`), armed);
  assert.ok(armed.includes(`matched=${COLLECT_GUARD_TOOL_NAME}`), armed);
  assert.ok(armed.includes('dispatched=true'), armed);
  // The run id is the identifier-shaped `run-case3-1` fixture, so it correlates as-is.
  assert.ok(armed.includes(`run=${RUN}`), armed);

  assert.ok(replyLines(lines)[0].startsWith('rein-mvp-guard reply_payload_sending.entry'), replyLines(lines)[0]);
  const hit = replyLines(lines)[1];
  assert.ok(hit.startsWith('rein-mvp-guard reply_payload_sending.hit'), hit);
  assert.ok(hit.includes('channel=slack'), hit);
  assert.ok(hit.includes('kind=final'), hit);
  assert.ok(hit.includes(`run=${RUN}`), hit);
});

test('a refused observation traces one line that names the refusal reason', () => {
  const cases = [
    // The hook saw a tool that is neither guard tool, so the matcher decision was unmatched.
    {
      drive: guard => guard.afterToolCall({ toolName: 'rein_status', params: {}, runId: RUN, result: {} }),
      expect: line => {
        assert.ok(line.startsWith('rein-mvp-guard after_tool_call.reject'), line);
        assert.ok(line.includes('match=false'), line);
        assert.ok(line.includes('reason=unmatched_tool'), line);
      },
    },
    // The matcher admitted the dispatcher but its envelope named an unrelated tool.
    {
      drive: guard => armViaToolSearch(guard, { result: wrappedCollectResult(collectAnswer(), 'rein_status') }),
      expect: line => {
        assert.ok(line.includes('match=false'), line);
        assert.ok(line.includes(`observed=${TOOL_SEARCH_DISPATCHER_TOOL_NAME}`), line);
      },
    },
    // The collect was matched but answered with a failure, so nothing may be armed.
    {
      drive: guard => arm(guard, { error: 'tool failed' }),
      expect: line => {
        assert.ok(line.includes('match=true'), line);
        assert.ok(line.includes(`matched=${COLLECT_GUARD_TOOL_NAME}`), line);
        assert.ok(line.includes('reason=tool_error'), line);
      },
    },
    // A collecting answer without a run id cannot be correlated, so it arms nothing.
    {
      drive: guard => arm(guard, { runId: undefined }),
      expect: line => {
        assert.ok(line.includes('match=true'), line);
        assert.ok(line.includes('run=<none>'), line);
        assert.ok(line.includes('reason=run_id_missing'), line);
      },
    },
  ];
  for (const { drive, expect } of cases) {
    const { guard, lines } = collectDiagnostics();
    drive(guard);
    const matched = collectLines(lines);
    // The entry line always comes first and raw; the classified line follows when it is a refusal.
    assert.equal(matched.length, 2, `expected an entry and a classified line, got: ${lines.join('\n')}`);
    assert.ok(matched[0].startsWith('rein-mvp-guard after_tool_call.match'), matched[0]);
    expect(matched[1]);
  }
});

test('a submit in the run traces its own match and clearing, not the collect prompt', () => {
  // Two observations in one run: the arm for the collect, then the submit that closes it.
  const { guard, lines } = collectDiagnostics();
  arm(guard);
  observeSubmit(guard);
  const matched = collectLines(lines);
  assert.equal(matched.length, 4, lines.join('\n'));
  assert.ok(matched[0].startsWith('rein-mvp-guard after_tool_call.match'), matched[0]);
  assert.ok(matched[1].startsWith('rein-mvp-guard after_tool_call.arm'), matched[1]);
  assert.ok(matched[2].startsWith('rein-mvp-guard after_tool_call.match'), matched[2]);
  assert.ok(matched[3].startsWith('rein-mvp-guard after_tool_call.reject'), matched[3]);
  assert.ok(matched[3].includes('reason=submit_observed'), matched[3]);
  assert.ok(matched[3].includes(`matched=${SUBMIT_GUARD_TOOL_NAME}`), matched[3]);
});

test('a reply that is not rewritten traces one miss line with its reason', () => {
  const cases = [
    { drive: guard => send(guard), expect: 'reason=no_pending_entry', run: RUN },
    { drive: guard => { arm(guard); send(guard, { channel: 'discord' }); }, expect: 'reason=channel_not_slack', run: RUN },
    { drive: guard => { arm(guard); send(guard, { kind: 'tool' }); }, expect: 'reason=kind_not_final', run: RUN },
    { drive: guard => { arm(guard); send(guard, { runId: undefined }); }, expect: 'reason=run_id_missing', run: '<none>' },
    { drive: guard => { arm(guard); send(guard, { payload: { replyToId: '1700000000.000100' } }); }, expect: 'reason=payload_without_text', run: RUN },
  ];
  for (const { drive, expect, run } of cases) {
    const { guard, lines } = collectDiagnostics();
    drive(guard);
    const matched = replyLines(lines);
    assert.equal(matched.length, 2, `expected an entry and a classified line, got: ${lines.join('\n')}`);
    assert.ok(matched[0].startsWith('rein-mvp-guard reply_payload_sending.entry'), matched[0]);
    assert.ok(matched[1].startsWith('rein-mvp-guard reply_payload_sending.reject'), matched[1]);
    assert.ok(matched[1].includes(expect), matched[1]);
    assert.ok(matched[1].includes(`run=${run}`), matched[1]);
  }
});

test('a ready-to-submit collect consumes its run and traces the prepared refusal', () => {
  const { guard, lines } = collectDiagnostics();
  arm(guard, {
    result: collectAnswer({ readyForSubmit: true, proposalId: 'proposal-uuid', preparedTitle: 'September community sharing session' }),
  });
  assert.equal(send(guard), undefined);
  const line = replyLines(lines)[1];
  assert.ok(line.startsWith('rein-mvp-guard reply_payload_sending.reject'), line);
  assert.ok(line.includes('reason=prepared_for_submit'), line);
});

test('the trace carries no user wording, token or secret and never changes the reply', () => {
  const { guard, lines } = collectDiagnostics();
  armViaToolSearch(guard);
  const outcome = send(guard);
  assert.ok(outcome, 'the guarded reply is still produced with diagnostics on');

  const transcript = lines.join('\n');
  // Nothing from the collect answer, the draft token or the model's unsafe reply may appear.
  for (const forbidden of [
    'September community sharing session',
    'community sharing session, about fifty people',
    'sometime in October',
    'event_pair',
    'voteType',
    'requestedMinor',
    'draftToken',
    'rein_proposal_draft',
    'OPAQUE-TOKEN-VALUE',
    'confirmationToken',
    'missingFields',
    'readyForSubmit',
    'summaryConfirmationRequired',
    '1700000000.000100',
    'sess-1',
  ]) {
    assert.ok(!transcript.includes(forbidden), `diagnostic line leaked ${forbidden}: ${transcript}`);
  }
  // Exactly two lines per hook, and the trace never multiplies with the payload it describes.
  assert.equal(lines.length, 4, transcript);
});

test('a long or non-identifier run id is hashed instead of repeated', () => {
  const { guard, lines } = collectDiagnostics();
  const secretLookingRunId = `run-${'A'.repeat(120)} secret-in-a-run-id`;
  arm(guard, { runId: secretLookingRunId });
  const line = collectLines(lines)[0];
  assert.ok(line, lines.join('\n'));
  assert.ok(!line.includes(secretLookingRunId), line);
  assert.ok(!line.includes('secret-in-a-run-id'), line);
  assert.ok(/run=sha:[0-9a-f]{8}#len\d+/.test(line), line);
});

test('a throwing diagnostic sink never disturbs the guard', () => {
  const guard = createCollectReplyGuard({
    now: () => 0,
    stateKey: isolatedStoreKey(),
    env: { [COLLECT_REPLY_GUARD_DIAG_ENV]: '1' },
    diagnostic: {
      info() {
        throw new Error('sink exploded');
      },
    },
  });
  arm(guard);
  const outcome = send(guard);
  assert.ok(outcome, 'a broken sink must not stop the rewrite');
  assert.ok(!outcome.payload.text.includes('event_pair'), outcome.payload.text);
});

test('the live-shaped transcript envelope wraps the collect and traces that exact chain', () => {
  // The exact shape the host reports on a live Gateway: one outer `tool_call` dispatcher whose body
  // carries the host-resolved tool identity and the guest outcome, with the run id at the top level of
  // the event, followed by the final Slack payload for the same run.
  const { guard, lines } = collectDiagnostics();
  const liveRun = '7910fe49-1e24-4e68-82ad-399cf8b2a1fa';
  const event = {
    toolName: TOOL_SEARCH_DISPATCHER_TOOL_NAME,
    params: { id: COLLECT_GUARD_TOOL_NAME, args: { approximateWhen: '明年三月上旬' } },
    runId: liveRun,
    toolCallId: 'call-live-1',
    durationMs: 36853,
    result: wrappedCollectResult(),
  };
  guard.afterToolCall(event, { toolName: TOOL_SEARCH_DISPATCHER_TOOL_NAME, runId: liveRun });
  assert.equal(guard.pendingCount(), 1);
  const outcome = guard.replyPayloadSending({
    payload: unsafeFinalPayload(),
    kind: COLLECT_GUARD_FINAL_KIND,
    channel: COLLECT_GUARD_CHANNEL,
    runId: liveRun,
    sessionKey: 'agent:main:slack:channel:c0c4l0yn814',
  });
  assert.ok(outcome, 'a live-shaped dispatch must arm and rewrite');
  assert.ok(!outcome.payload.text.includes('event_pair'));
  const transcript = lines.join('\n');
  assert.equal(lines.length, 4, transcript);
  assert.ok(transcript.includes('after_tool_call.match'), transcript);
  assert.ok(transcript.includes('after_tool_call.arm'), transcript);
  assert.ok(transcript.includes('reply_payload_sending.entry'), transcript);
  assert.ok(transcript.includes('reply_payload_sending.hit'), transcript);
  assert.ok(transcript.includes(`observed=${TOOL_SEARCH_DISPATCHER_TOOL_NAME}`), transcript);
  assert.ok(transcript.includes(`matched=${COLLECT_GUARD_TOOL_NAME}`), transcript);
  assert.ok(transcript.includes(`run=${liveRun}`), transcript);
  // The slack session key and the model-authored params never enter the trace.
  assert.ok(!transcript.includes('c0c4l0yn814'), transcript);
  assert.ok(!transcript.includes('明年三月上旬'), transcript);
});
