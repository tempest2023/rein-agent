import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import plugin from '../plugins/rein-operations/index.ts';
import { GOVERNANCE_READ_TOOL_NAMES } from '../plugins/rein-operations/governance-read-tools.ts';
import { GOVERNANCE_WRITE_TOOL_NAMES } from '../plugins/rein-operations/governance-write-tools.ts';
import { GOVERNANCE_COLLECT_TOOL_NAMES } from '../plugins/rein-operations/proposal-collect-tools.ts';
import { GOVERNANCE_FEEDBACK_TOOL_NAMES } from '../plugins/rein-operations/proposal-feedback-tools.ts';
import { COLLECT_REPLY_GUARD_TOOL_NAMES } from '../plugins/rein-operations/proposal-collect-reply-guard.ts';
import {
  POLL_GUARD_CHANNEL,
  POLL_GUARD_FINAL_KIND,
  POLL_REPLY_GUARD_TOOL_NAMES,
  POLL_RESULT_GUARD_TOOL_NAME,
  createPollReplyGuard,
} from '../plugins/rein-operations/poll-reply-guard.ts';
import {
  MAX_VOTE_APPROVAL_COUNT,
  POLL_RESULT_READ_TOOL_NAME,
  TOOL_SEARCH_DISPATCHER_TOOL_NAME,
  VOTE_GUARD_CHANNEL,
  VOTE_GUARD_FINAL_KIND,
  VOTE_GUARD_TOOL_NAME,
  VOTE_REPLY_ABSTENTION_SENTENCE,
  VOTE_REPLY_APPROVAL_TEMPLATE,
  VOTE_REPLY_GUARD_MAX_ENTRIES,
  VOTE_REPLY_GUARD_OTHER_TOOL_NAMES,
  VOTE_REPLY_GUARD_PREPARATORY_TOOL_NAMES,
  VOTE_REPLY_GUARD_SHARED_STATE_KEY,
  VOTE_REPLY_GUARD_TOOL_NAMES,
  VOTE_REPLY_GUARD_TTL_MS,
  VOTE_REPLY_NO_FUNDS_SENTENCE,
  createVoteReplyGuard,
} from '../plugins/rein-operations/vote-reply-guard.ts';

// Focused tests for the case-6 outbound guard. They drive the guard's own hooks with plain objects, so
// no host, gateway, Slack API or database is involved, and each test asserts on the exact payload
// handed back, which is the only thing the guard is allowed to change.

const writeToolsSource = readFileSync(
  fileURLToPath(new URL('../plugins/rein-operations/governance-write-tools.ts', import.meta.url)),
  'utf8',
);

// The guard's own wording, pinned here as a literal fence: a change to the delivered copy fails these
// cases instead of quietly matching whatever the guard now says.
const APPROVED = count => `你的投票已记录。你赞成了 ${count} 个提案。`;
const ABSTAINED = '你的弃权已记录；你没有投赞成票。';
const NO_FUNDS = '这条投票记录不移动资金。';
const approvedText = count => `${APPROVED(count)}${NO_FUNDS}`;
const abstainedText = () => `${ABSTAINED}${NO_FUNDS}`;

const RUN = 'run-case6-1';
const OTHER_RUN = 'run-case6-2';
const POLL = '33333333-3333-4333-8333-333333333333';
const CANDIDATE_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const CANDIDATE_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const VOTER_CONTACT = '99999999-9999-4999-8999-999999999999';
const OTHER_POLL = '44444444-4444-4444-8444-444444444444';
const TITLE_A = '清洁轮v3园艺角（合成）';
const TITLE_B = '清洁轮v3夜读会（合成）';
/** The tool's own provisional note, repeated here so the fixture cannot quietly drift from it. */
const PROVISIONAL_NOTE = '本轮还没有结束，所以还没有结果：现在没有赢家，也没有票数与参与人数。';
/**
 * The generic failure code the live host stamps on the provisional round read, in place of the tool's
 * own `provisional` code: the answer is `ok: false`, so the host records a failed call. Repeating the
 * literal here keeps the regression fixture anchored to the host's own value.
 */
const HOST_FAILED_ERROR = 'failed';

/**
 * One `rein_poll_vote` answer, shaped as the tool returns it (`governance-write-tools.ts` builds
 * `{ tool, ok, status, reason, pollId, approvalCount, abstained, recorded, replaced,
 * authorizesSpending }`, plus `error` on a refusal). `overrides` replace only the listed fields.
 */
function voteAnswer(overrides = {}) {
  const approvalCount = Object.hasOwn(overrides, 'approvalCount') ? overrides.approvalCount : 1;
  const details = {
    tool: VOTE_GUARD_TOOL_NAME,
    ok: true,
    status: 'inserted',
    reason: 'inserted',
    pollId: POLL,
    approvalCount,
    abstained: typeof approvalCount === 'number' ? approvalCount === 0 : false,
    recorded: true,
    replaced: false,
    authorizesSpending: false,
    ...overrides,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(details) }],
    details,
  };
}

/**
 * One provisional `rein_poll_result` answer, shaped exactly as the tool returns it (`ok: false`,
 * `status/error/narration.kind` all `provisional`, no outcome and nothing finalized), with the frozen
 * candidate pair the live read published. `overrides` replace only the listed fields.
 */
function provisionalAnswer(overrides = {}) {
  const candidateProposals = [
    { proposalId: CANDIDATE_A, title: TITLE_A },
    { proposalId: CANDIDATE_B, title: TITLE_B },
  ];
  const details = {
    tool: POLL_RESULT_READ_TOOL_NAME,
    ok: false,
    status: 'provisional',
    error: 'provisional',
    reason: 'poll_still_open',
    pollId: POLL,
    pollStatus: 'open',
    closesAt: '2026-10-02T18:00:00.000Z',
    closed: false,
    official: false,
    outcome: null,
    winner: null,
    counts: null,
    totalBallots: null,
    finalized: false,
    candidateProposals,
    candidateTitlesResolved: true,
    ambiguousCandidateTitles: [],
    authorizesSpending: false,
    narration: {
      kind: 'provisional',
      delivery: 'model_relayed',
      finalized: false,
      settled: false,
      record: 'provisional',
      pollId: POLL,
      candidateProposals,
      candidateTitlesResolved: true,
      ambiguousCandidateTitles: [],
      outcome: null,
      winner: null,
      winnerTitle: null,
      counts: null,
      totalBallots: null,
      abstainCount: null,
      authorizesSpending: false,
      note: PROVISIONAL_NOTE,
    },
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(details) }],
    details: { ...details, ...overrides },
  };
}

/** The model's own (unsafe) final reply: it echoes field names, an identifier and a voter. */
const unsafeFinalPayload = () => ({
  text:
    '已记录：tool=rein_poll_vote，status=inserted，approvalCount=1，replaced=false，' +
    `pollId=${POLL}，candidate=${CANDIDATE_A}，voter=${VOTER_CONTACT}`,
  replyToId: '1700000000.000100',
  media: [{ url: 'https://example.invalid/vote.png' }],
  metadata: { silentReply: false },
});

/** A store key no other guard in this file shares, for tests that want one instance in isolation. */
const isolatedStoreKey = () => Symbol('rein-governance-vote-guard-test-instance');

const buildGuard = (options = {}) =>
  createVoteReplyGuard({ now: () => 0, stateKey: isolatedStoreKey(), ...options });

/**
 * Feed one `after_tool_call` observation through the guard. Omitted options fall back to one
 * successful ballot, and an explicit `runId: undefined` genuinely omits the field, so a test can prove
 * what a missing run id does instead of silently reusing the default.
 */
function observe(guard, options = {}) {
  const event = {
    toolName: Object.hasOwn(options, 'toolName') ? options.toolName : VOTE_GUARD_TOOL_NAME,
    params: options.params ?? {},
    toolCallId: 'call-1',
    result: Object.hasOwn(options, 'result') ? options.result : voteAnswer(),
  };
  const runId = Object.hasOwn(options, 'runId') ? options.runId : RUN;
  if (runId !== undefined) event.runId = runId;
  if (options.error !== undefined) event.error = options.error;
  guard.afterToolCall(event);
  return guard;
}

/**
 * Feed one provisional round read through the guard, exactly as the live host reports it: the tool
 * answers `ok: false`, so the host stamps a failure on the event. The default fixture uses the tool's
 * own `provisional` code; a test can pass the generic `failed` the live Gateway derives instead.
 */
function observeProvisionalRead(guard, options = {}) {
  return observe(guard, {
    toolName: POLL_RESULT_READ_TOOL_NAME,
    result: Object.hasOwn(options, 'result') ? options.result : provisionalAnswer(),
    error: Object.hasOwn(options, 'error') ? options.error : 'provisional',
    ...(Object.hasOwn(options, 'runId') ? { runId: options.runId } : {}),
  });
}

/** Send one payload through the guard. An explicit `undefined` genuinely omits the field. */
const send = (guard, options = {}) => {
  const event = { payload: options.payload ?? unsafeFinalPayload(), sessionKey: 'sess-1' };
  event.kind = Object.hasOwn(options, 'kind') ? options.kind : VOTE_GUARD_FINAL_KIND;
  event.channel = Object.hasOwn(options, 'channel') ? options.channel : VOTE_GUARD_CHANNEL;
  event.runId = Object.hasOwn(options, 'runId') ? options.runId : RUN;
  return guard.replyPayloadSending(event);
};

/** One `tool_call` envelope around a guest result, as the live host reports it. */
function wrappedResult(guest, toolNameOverride) {
  const name = toolNameOverride ?? VOTE_GUARD_TOOL_NAME;
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

/** Feed one Tool Search dispatch, exactly as the host reports it. */
function observeViaToolSearch(guard, options = {}) {
  const event = {
    toolName: TOOL_SEARCH_DISPATCHER_TOOL_NAME,
    // The model-authored outer params: the guard must never consult these for identity.
    params: options.params ?? { id: VOTE_GUARD_TOOL_NAME, args: {} },
    toolCallId: 'call-ts-1',
    result: Object.hasOwn(options, 'result') ? options.result : wrappedResult(voteAnswer()),
  };
  event.runId = Object.hasOwn(options, 'runId') ? options.runId : RUN;
  if (options.error !== undefined) event.error = options.error;
  guard.afterToolCall(event);
  return guard;
}

const FORBIDDEN_IN_MEMBER_TEXT = [
  'rein_',
  'tool_call',
  'status',
  'reason',
  'inserted',
  'approvalCount',
  'abstained',
  'recorded',
  'replaced',
  'authorizesSpending',
  'pollId',
  POLL,
  CANDIDATE_A,
  CANDIDATE_B,
  VOTER_CONTACT,
];

test('the guard names one ballot tool, one surface, one kind and one bounded fence', () => {
  assert.equal(VOTE_GUARD_TOOL_NAME, 'rein_poll_vote');
  assert.equal(VOTE_GUARD_CHANNEL, 'slack');
  assert.equal(VOTE_GUARD_FINAL_KIND, 'final');
  assert.equal(TOOL_SEARCH_DISPATCHER_TOOL_NAME, 'tool_call');
  assert.ok(VOTE_REPLY_GUARD_TTL_MS > 0);
  assert.ok(VOTE_REPLY_GUARD_MAX_ENTRIES >= 1);
  assert.match(VOTE_REPLY_GUARD_SHARED_STATE_KEY, /governance-vote-reply-guard\.v1$/);
  // The matcher admits the ballot tool, the one preparatory read, the disqualifying siblings and the
  // Tool Search dispatcher, and nothing else.
  assert.deepEqual(
    [...VOTE_REPLY_GUARD_TOOL_NAMES],
    [
      VOTE_GUARD_TOOL_NAME,
      ...VOTE_REPLY_GUARD_PREPARATORY_TOOL_NAMES,
      ...VOTE_REPLY_GUARD_OTHER_TOOL_NAMES,
      TOOL_SEARCH_DISPATCHER_TOOL_NAME,
    ],
  );
  // The preparatory list is exactly the one round-read tool, and it is the poll guard's own tool: a
  // missing name would stop the live read-then-vote chain from arming, so the two stay tied.
  assert.deepEqual([...VOTE_REPLY_GUARD_PREPARATORY_TOOL_NAMES], [POLL_RESULT_READ_TOOL_NAME]);
  assert.equal(POLL_RESULT_READ_TOOL_NAME, POLL_RESULT_GUARD_TOOL_NAME);
  assert.ok(!VOTE_REPLY_GUARD_OTHER_TOOL_NAMES.includes(POLL_RESULT_READ_TOOL_NAME));
  // The preparatory and disqualifying lists together cover every other tool this governance entry registers: a
  // missing name could let a multi-step turn be rewritten as a single ballot confirmation.
  const registeredOthers = [
    'rein_status',
    ...GOVERNANCE_READ_TOOL_NAMES,
    ...GOVERNANCE_WRITE_TOOL_NAMES,
    ...GOVERNANCE_COLLECT_TOOL_NAMES,
    ...GOVERNANCE_FEEDBACK_TOOL_NAMES,
  ].filter(name => name !== VOTE_GUARD_TOOL_NAME);
  assert.deepEqual(
    [...VOTE_REPLY_GUARD_PREPARATORY_TOOL_NAMES, ...VOTE_REPLY_GUARD_OTHER_TOOL_NAMES].sort(),
    registeredOthers.sort(),
  );
  assert.ok(!VOTE_REPLY_GUARD_OTHER_TOOL_NAMES.includes(VOTE_GUARD_TOOL_NAME));
});

test('the ballot wording is the guard own copy, tied to the tool own approval cap and standing', () => {
  // The literal the director hears, byte for byte.
  assert.equal(VOTE_REPLY_APPROVAL_TEMPLATE, '你的投票已记录。你赞成了 {count} 个提案。');
  assert.equal(VOTE_REPLY_ABSTENTION_SENTENCE, ABSTAINED);
  assert.equal(VOTE_REPLY_NO_FUNDS_SENTENCE, NO_FUNDS);
  // The count fence clears the count the tool itself can record.
  const toolCap = Number(/const MAX_APPROVALS = (\d+);/.exec(writeToolsSource)?.[1]);
  assert.ok(Number.isSafeInteger(toolCap) && toolCap > 0, 'the tool approval cap must be readable');
  assert.equal(MAX_VOTE_APPROVAL_COUNT, toolCap);
  // The tool's own description carries the same standing the delivered sentence states.
  assert.ok(
    writeToolsSource.includes('A vote decision record moves no money.'),
    'the tool no longer states that a vote decision record moves no money',
  );
  // The provisional envelope the chain accepts is the tool's own, byte for byte: the same status and
  // error code, and the narration kind the tool stamps on a round that is still open.
  for (const fragment of ["status: 'provisional'", "error: 'provisional'", "kind: 'provisional'", "'rein_poll_result'"]) {
    assert.ok(writeToolsSource.includes(fragment), `the tool no longer builds ${fragment}`);
  }
});

test('a verified successful approval replaces only the matching final Slack payload', () => {
  const guard = observe(buildGuard());
  assert.equal(guard.pendingCount(), 1);
  const outcome = send(guard);
  assert.ok(outcome);
  assert.equal(outcome.payload.text, approvedText(1));
  // Every other property the host set is preserved.
  assert.equal(outcome.payload.replyToId, '1700000000.000100');
  assert.deepEqual(outcome.payload.media, [{ url: 'https://example.invalid/vote.png' }]);
  assert.deepEqual(outcome.payload.metadata, { silentReply: false });
  for (const forbidden of FORBIDDEN_IN_MEMBER_TEXT) {
    assert.ok(!outcome.payload.text.includes(forbidden), `member text leaked ${forbidden}`);
  }
});

test('the recorded count is the one the answer published, printed as approvals', () => {
  for (const count of [1, 2, 7]) {
    const outcome = send(observe(buildGuard(), { result: voteAnswer({ approvalCount: count }) }));
    assert.ok(outcome);
    assert.equal(outcome.payload.text, approvedText(count));
  }
});

test('a recorded abstention says so and states that no approval was cast', () => {
  const outcome = send(
    observe(buildGuard(), { result: voteAnswer({ approvalCount: 0, abstained: true }) }),
  );
  assert.ok(outcome);
  assert.equal(outcome.payload.text, abstainedText());
  for (const forbidden of FORBIDDEN_IN_MEMBER_TEXT) {
    assert.ok(!outcome.payload.text.includes(forbidden), `member text leaked ${forbidden}`);
  }
});

test('a failed ballot, an error answer or a refusal reason never arms a replacement', () => {
  // The tool's own refusal envelope: ok false with a reason code.
  const failed = {
    content: [{ type: 'text', text: '{}' }],
    details: {
      tool: VOTE_GUARD_TOOL_NAME,
      ok: false,
      status: 'rejected',
      reason: 'too_many_approvals',
      error: 'too_many_approvals',
      pollId: POLL,
      approvalCount: 0,
      abstained: true,
      recorded: false,
      replaced: false,
      authorizesSpending: false,
    },
  };
  for (const result of [
    failed,
    voteAnswer({ ok: false }),
    voteAnswer({ recorded: false }),
    voteAnswer({ error: 'too_many_approvals' }),
  ]) {
    const guard = observe(buildGuard(), { result });
    assert.equal(send(guard), undefined, JSON.stringify(result.details ?? result));
  }
  // An empty error spelling is no error at all, on the answer or on the host event, so the ballot still
  // arms exactly as the host's own truthiness test would read it.
  assert.ok(send(observe(buildGuard(), { result: voteAnswer({ error: '' }) })));
  // A host-reported error on the call is the same refusal, even with a success-shaped answer.
  assert.equal(send(observe(buildGuard(), { error: 'tool_call_failed' })), undefined);
  // An empty error string is no error at all, so the same answer still arms.
  assert.ok(send(observe(buildGuard(), { error: '' })));
});

test('a contradictory or out-of-fence ballot answer is refused rather than repaired', () => {
  const shapes = [
    voteAnswer({ replaced: true }),
    voteAnswer({ authorizesSpending: true }),
    voteAnswer({ approvalCount: 1.5 }),
    voteAnswer({ approvalCount: -1 }),
    voteAnswer({ approvalCount: '2' }),
    voteAnswer({ approvalCount: MAX_VOTE_APPROVAL_COUNT + 1 }),
    voteAnswer({ approvalCount: 0, abstained: false }),
    voteAnswer({ approvalCount: 2, abstained: true }),
    voteAnswer({ abstained: 'true' }),
    voteAnswer({ tool: 'rein_poll_result' }),
  ];
  for (const result of shapes) {
    assert.equal(send(observe(buildGuard(), { result })), undefined, JSON.stringify(result.details));
  }
  // The recorded nought is a legal count and a legal abstention.
  assert.ok(send(observe(buildGuard(), { result: voteAnswer({ approvalCount: 0, abstained: true }) })));
});

test('a malformed, unrecognized or unreadable answer is refused rather than guessed at', () => {
  for (const result of [
    undefined,
    null,
    'not an object',
    42,
    [],
    {},
    { details: undefined },
    { details: {} },
    { content: [{ type: 'text', text: 'not json' }] },
  ]) {
    assert.equal(send(observe(buildGuard(), { result })), undefined, JSON.stringify(result));
  }
});

test('a second call in the same run disqualifies the run rather than rewriting it', () => {
  // After a ballot, any further call means the run's reply covers more than this one ballot.
  const secondCalls = [
    { toolName: VOTE_GUARD_TOOL_NAME, result: voteAnswer() },
    { toolName: POLL_RESULT_GUARD_TOOL_NAME, result: { details: { ok: true } } },
    { toolName: 'rein_member_status', result: { details: { ok: true } } },
    { toolName: 'rein_proposal_collect', result: { details: { ok: true } } },
  ];
  for (const second of secondCalls) {
    const guard = observe(buildGuard());
    assert.equal(guard.pendingCount(), 1);
    observe(guard, second);
    assert.equal(guard.pendingCount(), 1, 'the run stays remembered as a refusal');
    assert.equal(send(guard), undefined, JSON.stringify(second));
  }
  // A round read that is not the tool's own provisional answer is not a legal first step either, so the
  // ballot after it is never rewritten as a single ballot confirmation.
  for (const read of [
    { details: { ok: true } },
    provisionalAnswer({ ok: true }),
    provisionalAnswer({ status: 'final' }),
  ]) {
    const late = observe(buildGuard(), { toolName: POLL_RESULT_GUARD_TOOL_NAME, result: read });
    observe(late);
    assert.equal(send(late), undefined, JSON.stringify(read.details));
  }
});

test('a run with no verified ballot, no run id or another run is left alone', () => {
  // A recognized sibling only, no ballot anywhere in the run.
  assert.equal(
    send(observe(buildGuard(), { toolName: 'rein_member_status', result: { details: {} } })),
    undefined,
  );
  // A missing run id arms nothing and replaces nothing.
  const noRun = observe(buildGuard(), { runId: undefined });
  assert.equal(noRun.pendingCount(), 0);
  assert.equal(send(noRun), undefined);
  // A ballot in another run never rewrites this run's reply.
  assert.equal(send(observe(buildGuard(), { runId: OTHER_RUN })), undefined);
});

test('non-final dispatch kinds and non-Slack surfaces are never rewritten', () => {
  for (const options of [
    { kind: 'progress' },
    { kind: 'tool' },
    { kind: undefined },
    { channel: 'discord' },
    { channel: undefined },
  ]) {
    const guard = observe(buildGuard());
    assert.equal(send(guard, options), undefined, JSON.stringify(options));
  }
});

test('one reply is judged once: the run is consumed and a later payload is untouched', () => {
  const guard = observe(buildGuard());
  assert.ok(send(guard));
  assert.equal(guard.pendingCount(), 0);
  assert.equal(send(guard), undefined);
});

test('a payload with no text is left alone, and it consumes the run', () => {
  const guard = observe(buildGuard());
  assert.equal(send(guard, { payload: { replyToId: '1700000000.000100' } }), undefined);
  assert.equal(guard.pendingCount(), 0);
  assert.equal(send(guard), undefined);
});

// --- The live read-then-vote chain ---------------------------------------------------------------
// Case 6 asks a director to approve a candidate by its spoken title, and the title-to-id mapping is
// only visible from a round read, so the live turn is one provisional `rein_poll_result` followed
// by one successful `rein_poll_vote` under a single run id. That one chain arms the guard; the read
// alone does not, and no other order or count does.

test('the live read-then-vote chain arms the guard through Tool Search and the provisional host error', () => {
  // A provisional read alone replaces nothing.
  const readOnly = buildGuard();
  observeViaToolSearch(readOnly, {
    result: wrappedResult(provisionalAnswer(), POLL_RESULT_READ_TOOL_NAME),
    error: 'provisional',
  });
  assert.equal(readOnly.pendingCount(), 1);
  assert.equal(send(readOnly), undefined);

  // The same read, then the ballot, both as Tool Search dispatches: the guard delivers its own wording.
  const guard = buildGuard();
  observeViaToolSearch(guard, {
    result: wrappedResult(provisionalAnswer(), POLL_RESULT_READ_TOOL_NAME),
    error: 'provisional',
  });
  observeViaToolSearch(guard, { result: wrappedResult(voteAnswer({ approvalCount: 1 })) });
  const outcome = send(guard);
  assert.ok(outcome);
  assert.equal(outcome.payload.text, approvedText(1));
  for (const forbidden of FORBIDDEN_IN_MEMBER_TEXT) {
    assert.ok(!outcome.payload.text.includes(forbidden), `member text leaked ${forbidden}`);
  }
});

test('the live provisional read stamped with the generic host failure still arms the chain', () => {
  // The live Gateway reports the provisional round read as a failed call and stamps its generic
  // `failed` on the dispatcher event rather than carrying the tool's own `provisional` code through.
  // The failure code and the validated provisional envelope have to be read together, or a live case-6
  // read-then-vote turn loses its rewrite and the model's own prose reaches the director.
  const readOnly = buildGuard();
  observeViaToolSearch(readOnly, {
    result: wrappedResult(provisionalAnswer(), POLL_RESULT_READ_TOOL_NAME),
    error: HOST_FAILED_ERROR,
  });
  assert.equal(readOnly.pendingCount(), 1, 'the validated provisional read is remembered');
  assert.equal(send(readOnly), undefined, 'the read alone replaces nothing');

  const guard = buildGuard();
  observeViaToolSearch(guard, {
    result: wrappedResult(provisionalAnswer(), POLL_RESULT_READ_TOOL_NAME),
    error: HOST_FAILED_ERROR,
  });
  observeViaToolSearch(guard, { result: wrappedResult(voteAnswer({ approvalCount: 1 })) });
  const outcome = send(guard);
  assert.ok(outcome, 'the live chain must still rewrite the reply');
  assert.equal(outcome.payload.text, approvedText(1));
  for (const forbidden of FORBIDDEN_IN_MEMBER_TEXT) {
    assert.ok(!outcome.payload.text.includes(forbidden), `member text leaked ${forbidden}`);
  }

  // The same host code on a direct (non-dispatcher) read is the same chain.
  const direct = buildGuard();
  observeProvisionalRead(direct, { error: HOST_FAILED_ERROR });
  observe(direct);
  const directOutcome = send(direct);
  assert.ok(directOutcome, 'a direct read with the generic host failure arms too');
  assert.equal(directOutcome.payload.text, approvedText(1));
});

test('the generic host failure alone never arms: only the validated provisional envelope is read through', () => {
  // The host's `failed` code is trusted only after the answer has been fully validated as the tool's own
  // provisional envelope. Every other shape is a real failure, even under the same host code, and the
  // ballot that follows it is never rewritten as a single ballot confirmation.
  const shapes = [
    { details: { tool: POLL_RESULT_READ_TOOL_NAME, ok: false, status: 'error', error: 'poll_rejected' } },
    provisionalAnswer({ ok: true }),
    provisionalAnswer({ status: 'closed' }),
    provisionalAnswer({ status: 'rejected' }),
    provisionalAnswer({ error: 'poll_rejected' }),
    provisionalAnswer({ narration: { ...provisionalAnswer().details.narration, kind: 'final' } }),
    provisionalAnswer({ narration: { ...provisionalAnswer().details.narration, outcome: 'winner' } }),
    provisionalAnswer({ narration: { ...provisionalAnswer().details.narration, finalized: true } }),
    provisionalAnswer({ narration: undefined }),
    { details: {} },
    undefined,
  ];
  for (const result of shapes) {
    const guard = observeProvisionalRead(buildGuard(), { result, error: HOST_FAILED_ERROR });
    observe(guard, { result: voteAnswer() });
    assert.equal(send(guard), undefined, JSON.stringify(result?.details ?? result));
  }
});

test('the chain works for direct calls, and the ballot may approve two or abstain', () => {
  for (const [overrides, expected] of [
    [{ approvalCount: 2 }, approvedText(2)],
    [{ approvalCount: 0, abstained: true }, abstainedText()],
  ]) {
    const guard = buildGuard();
    observeProvisionalRead(guard);
    observe(guard, { result: voteAnswer(overrides) });
    const outcome = send(guard);
    assert.ok(outcome, JSON.stringify(overrides));
    assert.equal(outcome.payload.text, expected);
  }
});

test('a provisional read without a host error, and one that names no round, still arm', () => {
  // A host that does not stamp the provisional code, and a read whose answer names no stored round: the
  // pair still counts, because the wording comes from the ballot alone.
  const noHostError = buildGuard();
  observeProvisionalRead(noHostError, { error: '' });
  observe(noHostError);
  assert.ok(send(noHostError));

  const noRound = buildGuard();
  observeProvisionalRead(noRound, { result: provisionalAnswer({ pollId: undefined }) });
  observe(noRound);
  assert.ok(send(noRound));
});

test('the chain must be one read and one ballot on the same round, in that order', () => {
  // A ballot on a different round than the read named is not the same chain.
  const wrongPoll = buildGuard();
  observeProvisionalRead(wrongPoll);
  observe(wrongPoll, { result: voteAnswer({ pollId: OTHER_POLL }) });
  assert.equal(send(wrongPoll), undefined);

  // The read and the ballot in the other order.
  const wrongOrder = buildGuard();
  observe(wrongOrder);
  observeProvisionalRead(wrongOrder);
  assert.equal(send(wrongOrder), undefined);

  // Two reads, then the ballot.
  const twoReads = buildGuard();
  observeProvisionalRead(twoReads);
  observeProvisionalRead(twoReads);
  observe(twoReads);
  assert.equal(send(twoReads), undefined);

  // A failed ballot after the read, and a second ballot after a successful one.
  const failedVote = buildGuard();
  observeProvisionalRead(failedVote);
  observe(failedVote, {
    result: voteAnswer({ ok: false, recorded: false, error: 'too_many_approvals' }),
  });
  assert.equal(send(failedVote), undefined);

  const secondVote = buildGuard();
  observeProvisionalRead(secondVote);
  observe(secondVote);
  observe(secondVote);
  assert.equal(send(secondVote), undefined);
});

test('a read that is not the tool own provisional answer is refused, and the ballot after it too', () => {
  const shapes = [
    // A closed round, a cancelled round read back as anything but provisional, a denied read.
    provisionalAnswer({ ok: true }),
    provisionalAnswer({ status: 'closed' }),
    provisionalAnswer({ status: 'rejected' }),
    provisionalAnswer({ error: 'poll_rejected' }),
    provisionalAnswer({ narration: { ...provisionalAnswer().details.narration, kind: 'final' } }),
    provisionalAnswer({ narration: { ...provisionalAnswer().details.narration, outcome: 'winner' } }),
    provisionalAnswer({ narration: { ...provisionalAnswer().details.narration, finalized: true } }),
    provisionalAnswer({ narration: undefined }),
    { details: {} },
    undefined,
  ];
  for (const result of shapes) {
    const guard = buildGuard();
    observeProvisionalRead(guard, { result });
    observe(guard, { result: voteAnswer() });
    assert.equal(send(guard), undefined, JSON.stringify(result?.details ?? result));
  }
  // A host error that is not the tool's own provisional code is a real failure, not a preparatory read.
  const hostError = buildGuard();
  observeProvisionalRead(hostError, { error: 'tool_call_failed' });
  observe(hostError);
  assert.equal(send(hostError), undefined);
});

test('the poll guard clears its own clarification on the ballot, so the chain keeps one reply', () => {
  // In a live Gateway the poll guard sees the same two calls: it arms its open-round clarification for
  // the read and clears it when the ballot arrives, so the two guards never both hold an entry. The
  // reply hooks then run in registration order (the ballot guard, then the poll guard), and the poll
  // guard hands back no payload of its own for this run, so the host keeps the ballot sentence.
  const voteGuard = createVoteReplyGuard({ now: () => 0, stateKey: isolatedStoreKey() });
  const pollGuard = createPollReplyGuard({ now: () => 0, stateKey: isolatedStoreKey() });
  const readEvent = {
    toolName: POLL_RESULT_READ_TOOL_NAME,
    params: {},
    runId: RUN,
    error: 'provisional',
    result: provisionalAnswer(),
  };
  const voteEvent = { toolName: VOTE_GUARD_TOOL_NAME, params: {}, runId: RUN, result: voteAnswer() };
  for (const guard of [voteGuard, pollGuard]) {
    guard.afterToolCall(readEvent);
    guard.afterToolCall(voteEvent);
  }
  assert.equal(pollGuard.pendingCount(), 0, 'the ballot clears the poll guard own round entry');
  const payload = unsafeFinalPayload();
  const first = voteGuard.replyPayloadSending({
    payload,
    kind: VOTE_GUARD_FINAL_KIND,
    channel: VOTE_GUARD_CHANNEL,
    runId: RUN,
  });
  assert.ok(first);
  assert.equal(first.payload.text, approvedText(1));
  const second = pollGuard.replyPayloadSending({
    payload: first.payload,
    kind: POLL_GUARD_FINAL_KIND,
    channel: POLL_GUARD_CHANNEL,
    runId: RUN,
  });
  assert.equal(second, undefined, 'the poll guard must hand back no payload of its own for this run');
});

// --- One call on two channels ---------------------------------------------------------------------
// A live Gateway reports a single business call to `after_tool_call` twice: once under the tool's own
// name and once inside the Tool Search `tool_call` envelope, both carrying the same guest outcome
// (`runtime/openclaw/tmp/gateway.log:1469-1472` shows the pair for the sibling collect tool).
// Counting the pair as two calls disqualified every live case-6 turn, so the two channels' adjacent
// reports of one call count once. What tells the pair from two genuine calls is the verified answer the
// two channels agree on, never a tool-call identifier the host passes.

test('one business call reported on both channels arms, in either order', () => {
  for (const [label, steps] of [
    ['direct then dispatched', [guard => observe(guard), guard => observeViaToolSearch(guard)]],
    ['dispatched then direct', [guard => observeViaToolSearch(guard), guard => observe(guard)]],
  ]) {
    const guard = buildGuard();
    steps[0](guard);
    assert.equal(guard.pendingCount(), 1, label);
    steps[1](guard);
    assert.equal(guard.pendingCount(), 1, `${label}: the second report must not count as a call`);
    const outcome = send(guard);
    assert.ok(outcome, label);
    assert.equal(outcome.payload.text, approvedText(1), label);
    for (const forbidden of FORBIDDEN_IN_MEMBER_TEXT) {
      assert.ok(!outcome.payload.text.includes(forbidden), `${label}: member text leaked ${forbidden}`);
    }
  }
});

test('the live read-then-vote chain arms when each call arrives on both channels', () => {
  // The live `failed` host code on the provisional read is the regression this pairing must not break,
  // so both host codes are driven through the pair.
  for (const hostError of [HOST_FAILED_ERROR, 'provisional']) {
    const read = {
      direct: guard => observeProvisionalRead(guard, { error: hostError }),
      dispatched: guard =>
        observeViaToolSearch(guard, {
          result: wrappedResult(provisionalAnswer(), POLL_RESULT_READ_TOOL_NAME),
          error: hostError,
        }),
    };
    const vote = {
      direct: guard => observe(guard),
      dispatched: guard => observeViaToolSearch(guard),
    };
    for (const [label, channels] of [
      ['direct then dispatched', ['direct', 'dispatched']],
      ['dispatched then direct', ['dispatched', 'direct']],
    ]) {
      const guard = buildGuard();
      for (const channel of channels) read[channel](guard);
      assert.equal(guard.pendingCount(), 1, `${hostError} ${label}: the paired read is one call`);
      for (const channel of channels) vote[channel](guard);
      const outcome = send(guard);
      assert.ok(outcome, `${hostError} ${label}`);
      assert.equal(outcome.payload.text, approvedText(1), `${hostError} ${label}`);
    }
  }
  // The read alone, on both channels, still replaces nothing: the pair arms on the ballot, not the read.
  const readOnly = buildGuard();
  observeProvisionalRead(readOnly, { error: HOST_FAILED_ERROR });
  observeViaToolSearch(readOnly, {
    result: wrappedResult(provisionalAnswer(), POLL_RESULT_READ_TOOL_NAME),
    error: HOST_FAILED_ERROR,
  });
  assert.equal(send(readOnly), undefined);
});

test('a repeat of one call is a second call, so the run is disqualified', () => {
  // The same call twice on one channel: there is no other channel to pair with, and two same-channel
  // reports cannot be told from two genuine calls, so the run is refused rather than rewritten.
  const sameChannel = buildGuard();
  observe(sameChannel);
  observe(sameChannel);
  assert.equal(send(sameChannel), undefined, 'the same call twice on one channel');
  const sameChannelDispatcher = buildGuard();
  observeViaToolSearch(sameChannelDispatcher);
  observeViaToolSearch(sameChannelDispatcher);
  assert.equal(send(sameChannelDispatcher), undefined, 'the same call twice on the dispatcher channel');

  // One call is reported on two channels at most: a third report of the same answer is a further call.
  const repeatedPair = buildGuard();
  observe(repeatedPair);
  observeViaToolSearch(repeatedPair);
  observeViaToolSearch(repeatedPair);
  assert.equal(send(repeatedPair), undefined, 'a third report of the same call');
});

test('two ballots are two calls whatever channel each arrives on', () => {
  // The other channel, but a different recorded answer: the two reports disagree, so they are two calls.
  for (const [label, steps] of [
    [
      'direct then dispatched',
      [
        guard => observe(guard),
        guard => observeViaToolSearch(guard, { result: wrappedResult(voteAnswer({ approvalCount: 2 })) }),
      ],
    ],
    [
      'dispatched then direct',
      [
        guard => observeViaToolSearch(guard),
        guard => observe(guard, { result: voteAnswer({ approvalCount: 2 }) }),
      ],
    ],
  ]) {
    const guard = buildGuard();
    for (const step of steps) step(guard);
    assert.equal(send(guard), undefined, label);
  }

  // Two genuine ballots, each reported on both channels, are never read as one call.
  const twoBallots = buildGuard();
  observe(twoBallots);
  observeViaToolSearch(twoBallots);
  observe(twoBallots, { result: voteAnswer({ approvalCount: 2 }) });
  observeViaToolSearch(twoBallots, { result: wrappedResult(voteAnswer({ approvalCount: 2 })) });
  assert.equal(send(twoBallots), undefined, 'a second ballot, both channels');
});

test('a sibling tool disqualifies the run through either channel', () => {
  const siblingDirect = guard =>
    observe(guard, { toolName: 'rein_member_status', result: { details: { ok: true } } });
  const siblingDispatched = guard =>
    observeViaToolSearch(guard, {
      result: wrappedResult({ details: { tool: 'rein_member_status', ok: true } }, 'rein_member_status'),
    });
  for (const [label, steps] of [
    ['sibling first, bare', [siblingDirect, guard => observe(guard)]],
    ['sibling first, dispatched', [siblingDispatched, guard => observe(guard)]],
    ['ballot bare, sibling dispatched', [guard => observe(guard), siblingDispatched]],
    ['ballot dispatched, sibling bare', [guard => observeViaToolSearch(guard), siblingDirect]],
    ['sibling on both channels', [siblingDirect, siblingDispatched]],
  ]) {
    const guard = buildGuard();
    for (const step of steps) step(guard);
    assert.equal(send(guard), undefined, label);
  }
});

// --- Tool Search dispatch ------------------------------------------------------------------------
// On a live Gateway the ballot tool is reached through Tool Search: the host runs one outer dispatcher
// tool named `tool_call`, so `after_tool_call` reports that outer name and the dispatcher's envelope
// rather than the guest tool.

test('a Tool Search dispatch arms the guard through the host tool identity', () => {
  const guard = observeViaToolSearch(buildGuard());
  assert.equal(guard.pendingCount(), 1);
  const outcome = send(guard);
  assert.ok(outcome);
  assert.equal(outcome.payload.text, approvedText(1));
  for (const forbidden of FORBIDDEN_IN_MEMBER_TEXT) {
    assert.ok(!outcome.payload.text.includes(forbidden), `member text leaked ${forbidden}`);
  }
});

test('a model-authored dispatcher id can neither arm nor clear the guard', () => {
  // The outer params name the ballot tool while the host envelope names another tool the guard knows:
  // the params are ignored, so the run is disqualified by that other tool instead of armed.
  const spoofed = buildGuard();
  observeViaToolSearch(spoofed, {
    result: wrappedResult({ details: { tool: 'rein_member_status', ok: true } }, 'rein_member_status'),
  });
  assert.equal(send(spoofed), undefined);

  // The outer params name an unrelated tool while the host envelope names the ballot tool: the envelope
  // wins, so the guard arms.
  const real = observeViaToolSearch(buildGuard(), { params: { id: 'rein_status', args: {} } });
  assert.equal(real.pendingCount(), 1);
  assert.ok(send(real));

  // A dispatch whose guest the guard cannot name still keeps the outer dispatcher name, which is in the
  // observed set: the run is disqualified, never rewritten from an envelope it cannot read.
  const unnamed = buildGuard();
  observeViaToolSearch(unnamed, {
    result: {
      details: { tool: { id: 'openclaw:rein-operations:bash', name: 'bash', source: 'openclaw' }, result: { details: {} } },
    },
  });
  assert.equal(send(unnamed), undefined);

  // A `tool_call` envelope with no usable host identity or guest outcome arms nothing either.
  for (const result of [
    { details: { tool: { name: VOTE_GUARD_TOOL_NAME } } },
    { details: {} },
    {},
    'not an object',
  ]) {
    const guard = buildGuard();
    observeViaToolSearch(guard, { result });
    assert.equal(send(guard), undefined, JSON.stringify(result));
  }
});

// --- Shared store, bound and failure modes --------------------------------------------------------

test('two loaded guard instances meet on the shared store', () => {
  // A live Gateway loads this plugin more than once, so the hook that arms and the hook that reads can
  // run in different module graphs. Both instances below take the production default store, and the run
  // id is this test's own, so the arm in one instance is what the other finds.
  const armed = createVoteReplyGuard({ now: () => 0 });
  const reader = createVoteReplyGuard({ now: () => 0 });
  const sharedRun = 'run-case6-shared-instances';
  armed.afterToolCall({
    toolName: VOTE_GUARD_TOOL_NAME,
    params: {},
    runId: sharedRun,
    result: voteAnswer({ approvalCount: 2 }),
  });
  const outcome = reader.replyPayloadSending({
    payload: unsafeFinalPayload(),
    kind: VOTE_GUARD_FINAL_KIND,
    channel: VOTE_GUARD_CHANNEL,
    runId: sharedRun,
  });
  assert.ok(outcome, 'the shared store must carry the arm to the other instance');
  assert.equal(outcome.payload.text, approvedText(2));
  // Consumed once, and an isolated store never sees it: the two keys stay apart.
  const isolated = createVoteReplyGuard({ now: () => 0, stateKey: isolatedStoreKey() });
  assert.equal(isolated.pendingCount(), 0);
  assert.equal(
    isolated.replyPayloadSending({
      payload: unsafeFinalPayload(),
      kind: VOTE_GUARD_FINAL_KIND,
      channel: VOTE_GUARD_CHANNEL,
      runId: sharedRun,
    }),
    undefined,
  );
});

test('the vote guard store is its own slot, so the poll guard never reads a ballot entry', () => {
  // The registration order in index.ts puts the poll guard before this guard, and the poll guard clears
  // its own entry when it observes the ballot tool. A ballot-only run therefore leaves the poll guard
  // empty and the two stores apart, whatever order the reply hooks run in.
  const voteGuard = createVoteReplyGuard({ now: () => 0 });
  const pollGuard = createPollReplyGuard({ now: () => 0 });
  const run = 'run-case6-cross-guard';
  voteGuard.afterToolCall({
    toolName: VOTE_GUARD_TOOL_NAME,
    params: {},
    runId: run,
    result: voteAnswer(),
  });
  pollGuard.afterToolCall({
    toolName: VOTE_GUARD_TOOL_NAME,
    params: {},
    runId: run,
    result: voteAnswer(),
  });
  const payload = { payload: unsafeFinalPayload(), kind: 'final', channel: 'slack', runId: run };
  assert.equal(pollGuard.replyPayloadSending({ ...payload, channel: POLL_GUARD_CHANNEL, kind: POLL_GUARD_FINAL_KIND }), undefined);
  const outcome = voteGuard.replyPayloadSending(payload);
  assert.ok(outcome);
  assert.equal(outcome.payload.text, approvedText(1));
});

test('an unbounded stream of runs cannot grow the store past its bound', () => {
  const guard = createVoteReplyGuard({ now: () => 0, stateKey: isolatedStoreKey(), maxEntries: 4 });
  for (let index = 0; index < 12; index += 1) {
    guard.afterToolCall({
      toolName: VOTE_GUARD_TOOL_NAME,
      params: {},
      runId: `run-case6-${index}`,
      result: voteAnswer(),
    });
  }
  assert.equal(guard.pendingCount(), 4);
});

test('a remembered reply expires once its ttl passes', () => {
  let clock = 0;
  const guard = createVoteReplyGuard({
    now: () => clock,
    stateKey: isolatedStoreKey(),
    ttlMs: 1000,
  });
  observe(guard);
  assert.equal(guard.pendingCount(), 1);
  clock = 1001;
  assert.equal(guard.pendingCount(), 0);
  assert.equal(send(guard), undefined);
});

test('a malformed event never throws out of either hook', () => {
  const guard = buildGuard();
  for (const event of [undefined, null, 'not an object', 42, [], {}]) {
    assert.equal(guard.afterToolCall(event), undefined);
    assert.equal(guard.replyPayloadSending(event), undefined);
  }
  // A throwing getter is the same class of failure: the hooks stay open and quiet.
  const hostile = {
    get toolName() {
      throw new Error('hostile');
    },
  };
  assert.equal(guard.afterToolCall(hostile), undefined);
  const hostilePayload = {
    get kind() {
      throw new Error('hostile');
    },
  };
  assert.equal(guard.replyPayloadSending(hostilePayload), undefined);
});

// --- Entry wiring ---------------------------------------------------------------------------------

/** Register the real plugin with a fake host api and hand back the hooks it registered. */
function registerPlugin() {
  process.env.REIN_VOTE_GUARD_TEST_BASE_URL = 'https://backend.rein.example';
  process.env.REIN_VOTE_GUARD_TEST_CALLER = 'rein-agent';
  process.env.REIN_VOTE_GUARD_TEST_CREDENTIAL = 'guard-test-agent-credential';
  process.env.REIN_VOTE_GUARD_TEST_CONFIRM = 'vote-guard-test-proposal-confirmation-key-0001';
  const hooks = [];
  plugin.register({
    registrationMode: 'full',
    pluginConfig: {
      foundationDb: {
        enabled: true,
        platform: 'slack',
        workspaces: [
          { platform: 'slack', workspaceId: 'T0123456ABC', nativeChannelIds: ['C_PROPOSAL', 'C_BOARD'] },
        ],
        proposalChannelIds: ['C_PROPOSAL'],
        boardChannelIds: ['C_BOARD'],
        backendApiBaseUrlEnvVar: 'REIN_VOTE_GUARD_TEST_BASE_URL',
        agentCallerIdEnvVar: 'REIN_VOTE_GUARD_TEST_CALLER',
        agentCredentialEnvVar: 'REIN_VOTE_GUARD_TEST_CREDENTIAL',
        proposalConfirmationKeyEnvVar: 'REIN_VOTE_GUARD_TEST_CONFIRM',
      },
    },
    registerTool() {},
    logger: { info() {}, warn() {}, error() {} },
    on(hookName, handler, options) {
      hooks.push({ hookName, handler, options });
    },
  });
  return hooks;
}

test('the real entry registers the vote guard hooks, matched to the ballot and the siblings', () => {
  const hooks = registerPlugin();
  const voteArm = hooks.find(
    hook =>
      hook.hookName === 'after_tool_call' &&
      JSON.stringify(hook.options?.matcher) === JSON.stringify([...VOTE_REPLY_GUARD_TOOL_NAMES]),
  );
  assert.ok(voteArm, 'the entry must register the ballot after_tool_call hook');

  // Three reply hooks are registered in this order: the collect guard's, this guard's, and the poll
  // guard's last, so a run that also read the round keeps the poll guard's narration as the final word.
  const replyHooks = hooks.filter(hook => hook.hookName === 'reply_payload_sending');
  assert.equal(replyHooks.length, 3, 'every reply guard must register its reply hook');
  const voteReply = replyHooks[1].handler;

  // A direct call round-trips through the registered handlers.
  voteArm.handler({
    toolName: VOTE_GUARD_TOOL_NAME,
    params: {},
    runId: RUN,
    result: voteAnswer({ approvalCount: 2 }),
  });
  const outcome = voteReply({
    payload: unsafeFinalPayload(),
    kind: VOTE_GUARD_FINAL_KIND,
    channel: VOTE_GUARD_CHANNEL,
    runId: RUN,
  });
  assert.ok(outcome, 'the registered reply hook must replace the matching final payload');
  assert.equal(outcome.payload.text, approvedText(2));

  // The live shape: one ballot reaches the registered hook twice, bare and then inside the dispatcher
  // envelope, and the pair is one call. This is the case whose two reports used to disqualify the run.
  voteArm.handler({
    toolName: VOTE_GUARD_TOOL_NAME,
    params: {},
    runId: RUN,
    result: voteAnswer(),
  });
  voteArm.handler({
    toolName: TOOL_SEARCH_DISPATCHER_TOOL_NAME,
    params: { id: VOTE_GUARD_TOOL_NAME },
    runId: RUN,
    result: wrappedResult(voteAnswer()),
  });
  const paired = voteReply({
    payload: unsafeFinalPayload(),
    kind: VOTE_GUARD_FINAL_KIND,
    channel: VOTE_GUARD_CHANNEL,
    runId: RUN,
  });
  assert.ok(paired, 'one call reported on both channels must still arm the registered reply hook');
  assert.equal(paired.payload.text, approvedText(1));

  // A live Tool Search dispatch does too.
  voteArm.handler({
    toolName: TOOL_SEARCH_DISPATCHER_TOOL_NAME,
    params: { id: VOTE_GUARD_TOOL_NAME },
    runId: RUN,
    result: wrappedResult(voteAnswer()),
  });
  assert.ok(
    voteReply({
      payload: unsafeFinalPayload(),
      kind: VOTE_GUARD_FINAL_KIND,
      channel: VOTE_GUARD_CHANNEL,
      runId: RUN,
    }),
    'a Tool Search dispatch must arm the registered reply hook',
  );

  // The live read-then-vote chain round-trips too: one provisional round read, carrying the host's own
  // `provisional` error, and then the ballot, both through Tool Search.
  voteArm.handler({
    toolName: TOOL_SEARCH_DISPATCHER_TOOL_NAME,
    params: { id: POLL_RESULT_READ_TOOL_NAME },
    runId: RUN,
    error: 'provisional',
    result: wrappedResult(provisionalAnswer(), POLL_RESULT_READ_TOOL_NAME),
  });
  voteArm.handler({
    toolName: TOOL_SEARCH_DISPATCHER_TOOL_NAME,
    params: { id: VOTE_GUARD_TOOL_NAME },
    runId: RUN,
    result: wrappedResult(voteAnswer({ approvalCount: 2 })),
  });
  const chained = voteReply({
    payload: unsafeFinalPayload(),
    kind: VOTE_GUARD_FINAL_KIND,
    channel: VOTE_GUARD_CHANNEL,
    runId: RUN,
  });
  assert.ok(chained, 'the live read-then-vote chain must arm the registered reply hook');
  assert.equal(chained.payload.text, approvedText(2));

  // A second observed call in the run is load-bearing: without it a multi-step turn would be rewritten
  // as a single ballot confirmation.
  voteArm.handler({
    toolName: VOTE_GUARD_TOOL_NAME,
    params: {},
    runId: RUN,
    result: voteAnswer(),
  });
  voteArm.handler({
    toolName: POLL_RESULT_GUARD_TOOL_NAME,
    params: {},
    runId: RUN,
    result: { details: { ok: true } },
  });
  assert.equal(
    voteReply({
      payload: unsafeFinalPayload(),
      kind: VOTE_GUARD_FINAL_KIND,
      channel: VOTE_GUARD_CHANNEL,
      runId: RUN,
    }),
    undefined,
    'a second tool call in the run must leave the run reply untouched',
  );

  // The two sibling guards keep their own hooks and matchers, so this addition changed nothing for
  // case 3 and case 7.
  const collectArm = hooks.find(
    hook =>
      hook.hookName === 'after_tool_call' &&
      hook.options?.matcher?.includes('rein_proposal_collect'),
  );
  assert.ok(collectArm, 'the collect guard must keep its own after_tool_call hook');
  assert.deepEqual(collectArm.options, { matcher: [...COLLECT_REPLY_GUARD_TOOL_NAMES] });
  const pollArm = hooks.find(
    hook =>
      hook.hookName === 'after_tool_call' &&
      JSON.stringify(hook.options?.matcher) === JSON.stringify([...POLL_REPLY_GUARD_TOOL_NAMES]),
  );
  assert.ok(pollArm, 'the poll guard must keep its own after_tool_call hook');
});
