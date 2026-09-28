import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import plugin from '../plugins/rein-operations/index.ts';
import { MVP_WRITE_TOOL_NAMES } from '../plugins/rein-operations/mvp-write-tools.ts';
import { MVP_FEEDBACK_TOOL_NAMES } from '../plugins/rein-operations/mvp-feedback-tools.ts';
import { COLLECT_REPLY_GUARD_TOOL_NAMES } from '../plugins/rein-operations/mvp-collect-reply-guard.ts';
import {
  MAX_POLL_NOTE_LENGTH,
  POLL_GUARD_CHANNEL,
  POLL_GUARD_FINAL_KIND,
  POLL_REPLY_GUARD_MAX_ENTRIES,
  POLL_REPLY_GUARD_SHARED_STATE_KEY,
  POLL_REPLY_GUARD_TOOL_NAMES,
  POLL_REPLY_GUARD_TTL_MS,
  POLL_REPLY_GUARD_WRITE_TOOL_NAMES,
  POLL_RESULT_GUARD_TOOL_NAME,
  TOOL_SEARCH_DISPATCHER_TOOL_NAME,
  createPollReplyGuard,
} from '../plugins/rein-operations/mvp-poll-reply-guard.ts';

// Focused tests for the case-7 outbound guard. They drive the guard's own hooks with plain objects, so
// no host, gateway, Slack API or database is involved, and each test asserts on the exact payload
// handed back, which is the only thing the guard is allowed to change. The notes below are built from
// the same fragments `rein_poll_result` builds its own sentence from, and one test proves those
// fragments are still literally in that tool's source, so a fixture cannot drift away from the tool.

const writeToolsSource = readFileSync(
  fileURLToPath(new URL('../plugins/rein-operations/mvp-write-tools.ts', import.meta.url)),
  'utf8',
);

// The tool's own fixed sentences, byte for byte, with the recorded figures substituted the way the
// tool substitutes them.
const PROVISIONAL_NOTE = '本轮还没有结束，所以还没有结果：现在没有赢家，也没有票数与参与人数。';
const WINNER_LEAD = '本轮投票已结束，最高赞成票的候选人是：';
const NO_WINNER_LEAD = '本轮投票已结束，记录的结果是无赢家，票数已按规则记录在案。';
const NO_WINNER_RULE =
  '请注意：平票如何处理的规则尚未确认，这条记录不代表组织已经通过或采纳了任何规则。';
const NO_FUNDS = '这是一条决策记录，不移动任何资金。';
// The tool's own count clause for the recorded winner: the number of *approvals* the winner took,
// printed right after the title. Case 7 requires the winner and its count in one reply, so this
// fragment is what the guard fences on, and the "count is on record" wording is the tool's fallback
// for a record that cannot say how many approvals the winner took.
const winnerCountClause = count => `本轮该候选人获得赞成 ${count} 票。`;
const WINNER_COUNT_RECORDED = '本轮该候选人获得赞成票数已记录在案。';
// The case-7 Chinese acceptance text, read from the document itself: the driver case, the winner
// wording and the no-winner wording all state the required content, and the no-winner note must carry
// none of the winner wording.
const casesSource = readFileSync(
  fileURLToPath(new URL('../docs/agent-test-cases-zh.md', import.meta.url)),
  'utf8',
);
const CASE_7 = casesSource.slice(casesSource.indexOf('## 7.'), casesSource.indexOf('## 8.'));
/** One line of the case-7 section, or null when the document no longer carries it. */
const case7Line = needle => CASE_7.split('\n').find(line => line.includes(needle)) ?? null;
// The lead and the two instructions of the guard's own open-round clarification. The guard keeps
// them private, so they are repeated here as the fence: a change to the guard's wording fails these
// cases instead of quietly matching whatever the guard now says.
const PROVISIONAL_OPEN_LEAD =
  '本轮还没有结束，所以还没有结果：现在没有赢家，也没有票数与参与人数。';
const PROVISIONAL_SELECT_INSTRUCTION =
  '如果要投票，请回复候选的编号；如果这一轮弃权，也请直接说明弃权。';
const PROVISIONAL_UNCLEAR_INSTRUCTION =
  '这一轮的候选名称暂时无法完整确定，请说明你指的是哪一条提案，或直接说明弃权。';
const ballotSentence = (ballots, abstentions) =>
  `本轮有 ${ballots} 位董事参与投票，其中 ${abstentions} 位弃权。`;
const winnerNote = (title, ballots = 2, abstentions = 0, winnerCount = 2) =>
  `${WINNER_LEAD}${title}。${winnerCountClause(winnerCount)}${ballotSentence(ballots, abstentions)}${NO_FUNDS}`;
/** The same winner sentence when the record cannot say how many approvals the winner took. */
const winnerNoteWithoutCount = (title, ballots = 2, abstentions = 0) =>
  `${WINNER_LEAD}${title}。${WINNER_COUNT_RECORDED}${ballotSentence(ballots, abstentions)}${NO_FUNDS}`;
const noWinnerNote = (ballots = 3, abstentions = 1) =>
  `${NO_WINNER_LEAD}${ballotSentence(ballots, abstentions)}${NO_WINNER_RULE}${NO_FUNDS}`;

const RUN = 'run-case7-1';
const OTHER_RUN = 'run-case7-2';
const POLL = '33333333-3333-4333-8333-333333333333';
const CANDIDATE_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const CANDIDATE_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const VOTER_CONTACT = '99999999-9999-4999-8999-999999999999';
const TITLE_A = 'September community sharing session';
const TITLE_B = 'October reading group';

/**
 * One successful `rein_poll_result` answer, shaped as the tool returns it. The recorded count of
 * the winner (`narration.counts[winner]`) is the figure the sentence prints, so the fixture keeps the
 * two together the way the tool does.
 */
function winnerAnswer(overrides = {}) {
  const winnerCount = 2;
  const note = winnerNote(TITLE_A, 2, 0, winnerCount);
  const candidateProposals = [
    { proposalId: CANDIDATE_A, title: TITLE_A },
    { proposalId: CANDIDATE_B, title: TITLE_B },
  ];
  const details = {
    tool: POLL_RESULT_GUARD_TOOL_NAME,
    ok: true,
    status: 'inserted',
    reason: 'finalized',
    pollId: POLL,
    pollStatus: 'closed',
    closesAt: '2026-09-24T11:00:00.000Z',
    closed: true,
    official: true,
    outcome: 'winner',
    winner: CANDIDATE_A,
    counts: { [CANDIDATE_A]: winnerCount },
    totalBallots: 2,
    abstainCount: 0,
    proposalsRecorded: 2,
    candidates: [CANDIDATE_A, CANDIDATE_B],
    candidateProposals,
    candidateTitlesResolved: true,
    ambiguousCandidateTitles: [],
    finalized: true,
    repeated: false,
    authorizesSpending: false,
    narration: {
      kind: 'final',
      delivery: 'model_relayed',
      finalized: true,
      settled: true,
      record: 'decided',
      pollId: POLL,
      candidateProposals,
      candidateTitlesResolved: true,
      ambiguousCandidateTitles: [],
      outcome: 'winner',
      winner: CANDIDATE_A,
      winnerTitle: TITLE_A,
      counts: { [CANDIDATE_A]: winnerCount },
      totalBallots: 2,
      abstainCount: 0,
      authorizesSpending: false,
      note,
    },
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(details) }],
    details: { ...details, ...overrides },
  };
}

/** One recorded no-winner round: a tie and an all-abstain round both read this way. */
function noWinnerAnswer(overrides = {}) {
  const candidateProposals = [
    { proposalId: CANDIDATE_A, title: TITLE_A },
    { proposalId: CANDIDATE_B, title: TITLE_B },
  ];
  const details = {
    tool: POLL_RESULT_GUARD_TOOL_NAME,
    ok: true,
    status: 'inserted',
    reason: 'finalized',
    pollId: POLL,
    pollStatus: 'closed',
    closed: true,
    official: true,
    outcome: 'no_winner',
    winner: null,
    counts: { [CANDIDATE_A]: 1, [CANDIDATE_B]: 1 },
    totalBallots: 3,
    abstainCount: 1,
    candidateProposals,
    finalized: true,
    repeated: false,
    authorizesSpending: false,
    narration: {
      kind: 'final',
      delivery: 'model_relayed',
      finalized: true,
      settled: true,
      record: 'decided',
      pollId: POLL,
      candidateProposals,
      outcome: 'no_winner',
      winner: null,
      winnerTitle: null,
      counts: { [CANDIDATE_A]: 1, [CANDIDATE_B]: 1 },
      totalBallots: 3,
      abstainCount: 1,
      authorizesSpending: false,
      note: noWinnerNote(),
    },
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(details) }],
    details: { ...details, ...overrides },
  };
}

/** One round that is still open: the readable window and frozen candidates, and no outcome at all. */
function provisionalAnswer(overrides = {}) {
  const candidateProposals = [
    { proposalId: CANDIDATE_A, title: TITLE_A },
    { proposalId: CANDIDATE_B, title: TITLE_B },
  ];
  const details = {
    tool: POLL_RESULT_GUARD_TOOL_NAME,
    ok: false,
    status: 'provisional',
    error: 'provisional',
    reason: 'poll_still_open',
    pollId: POLL,
    pollStatus: 'open',
    closesAt: '2026-09-24T11:00:00.000Z',
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

/** The model's own (unsafe) final reply: it echoes field names, reason codes and a voter identifier. */
const unsafeFinalPayload = () => ({
  text:
    '本轮结果：status=existing_finalized，repeated=true，delivery=model_relayed，' +
    `totalBallots=2，abstainCount=0，winner=${CANDIDATE_A}，voter=${VOTER_CONTACT}`,
  replyToId: '1700000000.000100',
  media: [{ url: 'https://example.invalid/result.png' }],
  metadata: { silentReply: false },
});

/** A store key no other guard in this file shares, for tests that want one instance in isolation. */
const isolatedStoreKey = () => Symbol('rein-mvp-poll-guard-test-instance');

const buildGuard = (options = {}) =>
  createPollReplyGuard({ now: () => 0, stateKey: isolatedStoreKey(), ...options });

/**
 * Arm the guard with one result answer. Omitted options fall back to the winner answer, and an
 * explicit `runId: undefined` genuinely omits the field, so a test can prove what a missing run id
 * does instead of silently reusing the default.
 */
function arm(guard, options = {}) {
  const result = Object.hasOwn(options, 'result') ? options.result : winnerAnswer();
  const event = { toolName: POLL_RESULT_GUARD_TOOL_NAME, params: {}, toolCallId: 'call-1', result };
  const runId = Object.hasOwn(options, 'runId') ? options.runId : RUN;
  if (runId !== undefined) event.runId = runId;
  if (options.error !== undefined) event.error = options.error;
  guard.afterToolCall(event);
  return guard;
}

/** Feed one closing write through the guard. Only its host identity matters to the guard. */
function observeWrite(guard, toolName = 'rein_poll_vote', options = {}) {
  const event = { toolName, params: {}, toolCallId: 'call-write-1' };
  const runId = Object.hasOwn(options, 'runId') ? options.runId : RUN;
  if (runId !== undefined) event.runId = runId;
  if (options.error !== undefined) event.error = options.error;
  guard.afterToolCall(event);
  return guard;
}

/** Send one payload through the guard. An explicit `undefined` genuinely omits the field. */
const send = (guard, options = {}) => {
  const event = { payload: options.payload ?? unsafeFinalPayload(), sessionKey: 'sess-1' };
  event.kind = Object.hasOwn(options, 'kind') ? options.kind : POLL_GUARD_FINAL_KIND;
  event.channel = Object.hasOwn(options, 'channel') ? options.channel : POLL_GUARD_CHANNEL;
  event.runId = Object.hasOwn(options, 'runId') ? options.runId : RUN;
  return guard.replyPayloadSending(event);
};

/** One `tool_call` envelope around a guest result, as the live host reports it. */
function wrappedResult(guest, toolNameOverride) {
  const name = toolNameOverride ?? POLL_RESULT_GUARD_TOOL_NAME;
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

/** Arm the guard through the outer `tool_call` dispatcher, exactly as the host reports it. */
function armViaToolSearch(guard, options = {}) {
  const event = {
    toolName: TOOL_SEARCH_DISPATCHER_TOOL_NAME,
    // The model-authored outer params: the guard must never consult these for identity.
    params: options.params ?? { id: POLL_RESULT_GUARD_TOOL_NAME, args: {} },
    toolCallId: 'call-ts-1',
    result: Object.hasOwn(options, 'result') ? options.result : wrappedResult(winnerAnswer()),
  };
  event.runId = Object.hasOwn(options, 'runId') ? options.runId : RUN;
  // The live host stamps `error` on the outer event for a provisional guest answer, so a test that
  // wants the real dispatch shape has to be able to set it.
  if (options.error !== undefined) event.error = options.error;
  guard.afterToolCall(event);
  return guard;
}

const FORBIDDEN_IN_MEMBER_TEXT = [
  'existing_finalized',
  'repeated',
  'delivery',
  'model_relayed',
  'official',
  'finalized',
  'settled',
  'authorizesSpending',
  'abstainCount',
  'totalBallots',
  'winnerTitle',
  'candidateProposals',
  'pollId',
  'narration',
  'rein_',
  'tool_call',
  CANDIDATE_A,
  CANDIDATE_B,
  POLL,
  VOTER_CONTACT,
];

test('the guard names one result tool, one surface, one dispatch kind and one bounded fence', () => {
  assert.equal(POLL_RESULT_GUARD_TOOL_NAME, 'rein_poll_result');
  assert.equal(POLL_GUARD_CHANNEL, 'slack');
  assert.equal(POLL_GUARD_FINAL_KIND, 'final');
  assert.equal(TOOL_SEARCH_DISPATCHER_TOOL_NAME, 'tool_call');
  assert.ok(POLL_REPLY_GUARD_TTL_MS > 0);
  assert.ok(POLL_REPLY_GUARD_MAX_ENTRIES >= 1);
  assert.match(POLL_REPLY_GUARD_SHARED_STATE_KEY, /mvp-poll-reply-guard\.v1$/);
  // The matcher admits the result tool, every closing write and the Tool Search dispatcher, and
  // nothing else.
  assert.deepEqual([...POLL_REPLY_GUARD_TOOL_NAMES], [
    POLL_RESULT_GUARD_TOOL_NAME,
    ...POLL_REPLY_GUARD_WRITE_TOOL_NAMES,
    TOOL_SEARCH_DISPATCHER_TOOL_NAME,
  ]);
  // The closing list is exactly the write tools this MVP block registers, minus the result tool: a
  // missing write could rewrite a reply that is about that write, so the two lists stay tied.
  const registeredWrites = [...MVP_WRITE_TOOL_NAMES, ...MVP_FEEDBACK_TOOL_NAMES].filter(
    name => name !== POLL_RESULT_GUARD_TOOL_NAME,
  );
  assert.deepEqual([...POLL_REPLY_GUARD_WRITE_TOOL_NAMES].sort(), registeredWrites.sort());
  // The note fence clears the longest sentence the tool can build: its fixed wording plus one stored
  // title, which the tool and the database writer both cap at 200 characters.
  const titleCap = Number(/const MAX_TITLE_LENGTH = (\d+);/.exec(writeToolsSource)?.[1]);
  assert.ok(Number.isSafeInteger(titleCap) && titleCap > 0, 'the tool title cap must be readable');
  assert.ok(
    MAX_POLL_NOTE_LENGTH > titleCap + NO_FUNDS.length,
    'the note fence must clear the tool own longest sentence',
  );
});

test('the fixture sentences are the ones the result tool builds, so they cannot drift', () => {
  // The fixed fragments and the counted sentence, exactly as `rein_poll_result` composes them. A
  // change to the tool wording fails here instead of silently emptying the guard.
  for (const fragment of [PROVISIONAL_NOTE, WINNER_LEAD, NO_WINNER_LEAD, NO_WINNER_RULE, NO_FUNDS]) {
    assert.ok(writeToolsSource.includes(fragment), `the tool no longer builds ${fragment}`);
  }
  assert.ok(
    writeToolsSource.includes(
      '本轮有 ${finalization.ballots} 位董事参与投票，其中 ${finalization.abstentions} 位弃权。',
    ),
    'the tool no longer builds the counted sentence the note repeats',
  );
  // The winner's count clause, in both shapes the tool builds: the printed count and the fallback for
  // a record that cannot say how many approvals the winner took. Case 7 requires the count, so a
  // wording change that dropped it has to fail here.
  for (const fragment of [
    '本轮该候选人获得赞成 ${winnerApprovals} 票。',
    WINNER_COUNT_RECORDED,
  ]) {
    assert.ok(writeToolsSource.includes(fragment), `the tool no longer builds ${fragment}`);
  }
});

test('the delivered winner sentence carries the recorded count beside the winner, not just the title', () => {
  // The case-7 gap: before this, the winner reply named the candidate and the participation totals but
  // never a count for the winner, while case 7 asks for "赢家与票数" together. The guard now refuses a
  // winner sentence that omits the count, so the wording the director hears always has one.
  const outcome = send(arm(buildGuard()));
  assert.ok(outcome);
  assert.equal(outcome.payload.text, winnerNote(TITLE_A));
  assert.ok(outcome.payload.text.includes(winnerCountClause(2)), outcome.payload.text);
  assert.ok(outcome.payload.text.includes(TITLE_A), outcome.payload.text);
  // It is an approval count, never a ballot figure: the two recorded totals stay separate, so a
  // proposal type that lets one voter approve twice can never be printed as "more ballots than
  // directors voted".
  assert.ok(outcome.payload.text.includes('赞成 2 票'), outcome.payload.text);
  assert.ok(!outcome.payload.text.includes('2.0'), outcome.payload.text);
});

test('the case-7 acceptance text still asks for the winner and its count', () => {
  // The delivered sentence is not the guard's own invention: case 7 asks for the winner and its count
  // in one reply, states the participation total as a user-visible fact, and pins the winner wording.
  // Read the document here so a change to the criterion fails instead of going unnoticed.
  assert.ok(CASE_7.length > 0, 'case 7 must be readable from docs/agent-test-cases-zh.md');
  assert.ok(
    case7Line('给出赢家与票数') !== null,
    'case 7 must still ask for the winner and its count together',
  );
  assert.ok(
    case7Line('同时给出赢家、参与人数与弃权数') !== null,
    'case 7 must still describe the winner wording as naming the winner and the two counts',
  );
  // The two counts the guard and the tool agree on: the winner's approvals and the ballots. Neither
  // may be presented as the other, and case 7 keeps them as separate recorded figures.
  assert.ok(
    case7Line('各候选人得票') !== null && case7Line('各候选人票数**仍可读**') !== null,
    'case 7 must still publish the per-candidate counts and the participation total as distinct figures',
  );
});

test('a validated winner note replaces only the matching final Slack payload', () => {
  const guard = arm(buildGuard());
  assert.equal(guard.pendingCount(), 1);
  const original = unsafeFinalPayload();
  const outcome = send(guard);
  assert.ok(outcome, 'the guard must return a replacement result');
  const replacement = outcome.payload;

  // The member hears the tool's own sentence, byte for byte.
  assert.equal(replacement.text, winnerNote(TITLE_A));
  // Only the text changed: everything else the host set is preserved.
  assert.equal(replacement.replyToId, original.replyToId);
  assert.deepEqual(replacement.media, original.media);
  assert.deepEqual(replacement.metadata, original.metadata);
  // The payload handed in by the host is not mutated in place.
  assert.equal(original.text, unsafeFinalPayload().text);
  assert.notEqual(replacement.text, original.text);

  // No internal vocabulary, identifier or voter survives into the member-facing text, and the case-7
  // content is all there: the winner by title, the two recorded figures, and no funds movement.
  for (const forbidden of FORBIDDEN_IN_MEMBER_TEXT) {
    assert.ok(!replacement.text.includes(forbidden), `member text leaked ${forbidden}`);
  }
  assert.ok(replacement.text.includes(TITLE_A), replacement.text);
  assert.ok(replacement.text.includes('2 位董事参与投票'), replacement.text);
  assert.ok(replacement.text.includes('0 位弃权'), replacement.text);
  assert.ok(replacement.text.includes('不移动任何资金'), replacement.text);
});

test('a recorded no-winner round is delivered with its uncertainty and no winner', () => {
  const guard = arm(buildGuard(), { result: noWinnerAnswer() });
  const outcome = send(guard);
  assert.ok(outcome);
  assert.equal(outcome.payload.text, noWinnerNote());
  for (const forbidden of FORBIDDEN_IN_MEMBER_TEXT) {
    assert.ok(!outcome.payload.text.includes(forbidden), `member text leaked ${forbidden}`);
  }
  // The record names no winner and no candidate, keeps the unconfirmed rule, and moves no money.
  assert.ok(!outcome.payload.text.includes(TITLE_A), outcome.payload.text);
  assert.ok(!outcome.payload.text.includes(TITLE_B), outcome.payload.text);
  assert.ok(outcome.payload.text.includes('无赢家'), outcome.payload.text);
  assert.ok(outcome.payload.text.includes('尚未确认'), outcome.payload.text);
  assert.ok(outcome.payload.text.includes('不移动任何资金'), outcome.payload.text);
  assert.ok(outcome.payload.text.includes('3 位董事参与投票'), outcome.payload.text);
  assert.ok(outcome.payload.text.includes('1 位弃权'), outcome.payload.text);
});

test('an open-round provisional read becomes the guard own numbered clarification', () => {
  // An open round answers with the frozen candidates rather than an outcome; the model's own reply to
  // that read is the reply that leaked attempted voters and field names. The guard rebuilds it: the
  // frozen titles in order as a numbered list, the no-result lead, and the pick-a-number-or-abstain
  // instruction. Case 6's clarification survives because the director still reads the candidate names.
  const guard = arm(buildGuard(), { result: provisionalAnswer() });
  assert.equal(guard.pendingCount(), 1, 'a provisional read arms the guard own clarification');
  const original = unsafeFinalPayload();
  const outcome = send(guard);
  assert.ok(outcome, 'the matching final payload must be replaced');
  const text = outcome.payload.text;

  // The frozen titles are present in the frozen order, numbered from one, and the director is told how
  // to answer. Nothing else the host set changes.
  assert.ok(text.includes(`${PROVISIONAL_OPEN_LEAD}`), text);
  assert.ok(text.includes('这一轮的候选如下：'), text);
  assert.ok(text.includes(`1. ${TITLE_A}`), text);
  assert.ok(text.includes(`2. ${TITLE_B}`), text);
  assert.ok(text.indexOf(`1. ${TITLE_A}`) < text.indexOf(`2. ${TITLE_B}`), 'frozen order is kept');
  assert.ok(text.includes('请回复候选的编号'), text);
  assert.ok(text.includes('弃权'), text);
  assert.equal(outcome.payload.replyToId, original.replyToId);
  assert.deepEqual(outcome.payload.media, original.media);

  // No implementation vocabulary, and above all no identifier or voter: only the stored titles travel.
  for (const forbidden of FORBIDDEN_IN_MEMBER_TEXT) {
    assert.ok(!text.includes(forbidden), `provisional text leaked ${forbidden}`);
  }
  assert.ok(!text.includes(CANDIDATE_A) && !text.includes(CANDIDATE_B), 'no candidate id may appear');
  assert.ok(!text.includes(VOTER_CONTACT), 'no voter may appear');
  // The closed-round figures never appear before the round closes: no count, no participants.
  assert.ok(!/参与投票/.test(text) && !/位弃权/.test(text), 'an open round publishes no count');
  assert.ok(!text.includes('最高赞成票'), 'an open round names no winner');
});

test('an open round whose frozen titles are unreadable asks which candidate instead of listing', () => {
  // A title the database could not answer for, or two frozen titles that cannot be told apart, is
  // exactly the case-6 clarification. The guard must not print a numbered list it cannot vouch for; it
  // says so and asks, and the model's prose is still not delivered.
  const shapes = [
    // One frozen title unresolved: `candidateTitlesResolved` says so and the row is null.
    provisionalAnswer({
      narration: {
        ...provisionalAnswer().details.narration,
        candidateTitlesResolved: false,
        candidateProposals: [
          { proposalId: CANDIDATE_A, title: TITLE_A },
          { proposalId: CANDIDATE_B, title: null },
        ],
      },
    }),
    // Two frozen candidates carrying the same title, named as ambiguous by the tool.
    provisionalAnswer({
      narration: {
        ...provisionalAnswer().details.narration,
        ambiguousCandidateTitles: [TITLE_A],
        candidateProposals: [
          { proposalId: CANDIDATE_A, title: TITLE_A },
          { proposalId: CANDIDATE_B, title: TITLE_A },
        ],
      },
    }),
    // The ambiguity flags disagree with the rows: the guard repeats the comparison itself and refuses.
    provisionalAnswer({
      narration: {
        ...provisionalAnswer().details.narration,
        candidateTitlesResolved: true,
        ambiguousCandidateTitles: [],
        candidateProposals: [
          { proposalId: CANDIDATE_A, title: TITLE_A },
          { proposalId: CANDIDATE_B, title: TITLE_A },
        ],
      },
    }),
  ];
  for (const [index, result] of shapes.entries()) {
    const guard = arm(buildGuard(), { result });
    assert.equal(guard.pendingCount(), 1, `shape ${index} must still arm a clarification`);
    const outcome = send(guard);
    assert.ok(outcome, `shape ${index} must replace the model prose`);
    const text = outcome.payload.text;
    assert.ok(text.includes(PROVISIONAL_OPEN_LEAD), text);
    assert.ok(text.includes('请说明你指的是哪一条提案'), text);
    // No numbered list, no candidate title presented as a choice, no identifier and no voter.
    assert.ok(!text.includes('这一轮的候选如下：'), text);
    assert.ok(!/^\s*\d+\.\s/m.test(text), text);
    for (const forbidden of [...FORBIDDEN_IN_MEMBER_TEXT, TITLE_A, TITLE_B]) {
      assert.ok(!text.includes(forbidden), `shape ${index} leaked ${forbidden}`);
    }
  }
});

test('a cancelled round reads back with the same open-round clarification', () => {
  // A cancelled round is over but holds no outcome, so it reads back provisional too and is answered
  // the same way rather than delivered as the model wrote it.
  const guard = arm(buildGuard(), {
    result: provisionalAnswer({ reason: 'poll_not_open', pollStatus: 'cancelled', closed: true }),
  });
  const outcome = send(guard);
  assert.ok(outcome);
  assert.ok(outcome.payload.text.includes(`1. ${TITLE_A}`), outcome.payload.text);
  for (const forbidden of FORBIDDEN_IN_MEMBER_TEXT) {
    assert.ok(!outcome.payload.text.includes(forbidden), `member text leaked ${forbidden}`);
  }
});

test('an open-round read in the same run replaces a sentence armed by a closed round', () => {
  // A run that read a closed round and then read an open one is answering the open round, so the
  // open-round clarification replaces the closed round's outcome rather than being delivered over it -
  // both for a direct call and for a Tool Search dispatch. The closed round's entry must never win.
  const direct = arm(buildGuard());
  assert.equal(direct.pendingCount(), 1);
  direct.afterToolCall({
    toolName: POLL_RESULT_GUARD_TOOL_NAME,
    params: {},
    runId: RUN,
    result: provisionalAnswer(),
  });
  assert.equal(direct.pendingCount(), 1, 'the provisional clarification replaces the closed sentence');
  const directOutcome = send(direct);
  assert.ok(directOutcome);
  assert.ok(directOutcome.payload.text.includes('这一轮的候选如下：'), directOutcome.payload.text);
  assert.notEqual(directOutcome.payload.text, winnerNote(TITLE_A));

  const dispatched = armViaToolSearch(buildGuard());
  assert.equal(dispatched.pendingCount(), 1);
  dispatched.afterToolCall({
    toolName: TOOL_SEARCH_DISPATCHER_TOOL_NAME,
    params: { id: POLL_RESULT_GUARD_TOOL_NAME },
    runId: RUN,
    result: wrappedResult(provisionalAnswer()),
  });
  assert.equal(dispatched.pendingCount(), 1);
  const dispatchedOutcome = send(dispatched);
  assert.ok(dispatchedOutcome);
  assert.ok(dispatchedOutcome.payload.text.includes('这一轮的候选如下：'), dispatchedOutcome.payload.text);
});

test('the same run is answered once and then swept', () => {
  const guard = arm(buildGuard());
  assert.ok(send(guard));
  assert.equal(guard.pendingCount(), 0);
  // A second payload for the same run is delivered exactly as the host made it.
  assert.equal(send(guard), undefined);
});

test('a run with no recognized result is untouched', () => {
  const guard = buildGuard();
  assert.equal(send(guard), undefined);
  assert.equal(guard.pendingCount(), 0);
  // A result in another run never licenses a replacement in this one, and that other run keeps its
  // own entry: isolation is per run, not per guard.
  arm(guard, { runId: OTHER_RUN });
  assert.equal(send(guard), undefined);
  assert.equal(guard.pendingCount(), 1);
});

test('a closing write in the same run clears the remembered sentence', () => {
  // Each registered write closes the run it is observed in: that run's reply is the write outcome, so
  // the remembered sentence must be dropped rather than delivered over it.
  for (const toolName of POLL_REPLY_GUARD_WRITE_TOOL_NAMES) {
    const guard = arm(buildGuard());
    assert.equal(guard.pendingCount(), 1, toolName);
    observeWrite(guard, toolName);
    assert.equal(guard.pendingCount(), 0, toolName);
    assert.equal(send(guard), undefined, toolName);
  }
});

test('a failed write also clears the remembered sentence', () => {
  // A write that errored is still a write: its outcome is what the run must deliver, so the clearing
  // does not depend on the write succeeding.
  const guard = arm(buildGuard());
  observeWrite(guard, 'rein_poll_vote', { error: 'tool failed' });
  assert.equal(guard.pendingCount(), 0);
  assert.equal(send(guard), undefined);
});

test('a write in another run never clears this run sentence', () => {
  const guard = arm(buildGuard());
  observeWrite(guard, 'rein_poll_vote', { runId: OTHER_RUN });
  assert.equal(guard.pendingCount(), 1);
  assert.ok(send(guard));
});

test('a write with no run id clears nothing and arms nothing', () => {
  const guard = arm(buildGuard());
  observeWrite(guard, 'rein_poll_vote', { runId: undefined });
  assert.equal(guard.pendingCount(), 1);
});

test('a missing run id arms nothing and replaces nothing', () => {
  const guard = buildGuard();
  arm(guard, { runId: undefined });
  assert.equal(guard.pendingCount(), 0);
  assert.equal(send(guard), undefined);
  assert.equal(send(guard, { runId: undefined }), undefined);
});

test('non-final dispatch kinds and non-Slack surfaces are never rewritten', () => {
  for (const kind of ['tool', 'block']) {
    const guard = arm(buildGuard());
    assert.equal(send(guard, { kind }), undefined, kind);
    // The entry survives the bypass, so the eventual final reply is still guarded.
    assert.equal(guard.pendingCount(), 1);
    assert.ok(send(guard, { kind: POLL_GUARD_FINAL_KIND }));
  }
  for (const channel of ['discord', 'telegram', undefined]) {
    const guard = arm(buildGuard());
    assert.equal(send(guard, { channel }), undefined, String(channel));
    assert.equal(guard.pendingCount(), 1);
  }
});

test('a failed result call, or another tool answer, never arms a replacement', () => {
  const failed = arm(buildGuard(), { error: 'tool failed' });
  assert.equal(failed.pendingCount(), 0);
  assert.equal(send(failed), undefined);
  // An answer that names another tool is refused even when it carries this tool's sentence.
  const other = arm(buildGuard(), {
    result: {
      details: { tool: 'rein_poll_open', ok: true, narration: { kind: 'final', note: noWinnerNote() } },
    },
  });
  assert.equal(other.pendingCount(), 0);
  assert.equal(send(other), undefined);
});

// --- Provisional reads ride a host-reported error ------------------------------------------------
// The host treats any truthy `details.error`, or `details.ok: false`, as a tool error, so the vendor
// sets `event.error` for a *successful* provisional read: the tool stamps `error: 'provisional'` on
// that one envelope. These cases pin the one error the guard still reads through, directly and through
// the live Tool Search dispatch, and pin every other error to the fail-open refusal.

test('a live provisional read arms the guard even though the host flags it as an error', () => {
  // The root cause: the provisional envelope answers `ok: false` with `error: 'provisional'`, so the
  // host reports `event.error = 'provisional'` for a read that plainly succeeded. Before this fix the
  // guard returned on any `event.error` and case 6's clarification could never arm.
  const guard = arm(buildGuard(), {
    result: provisionalAnswer(),
    error: 'provisional',
  });
  assert.equal(guard.pendingCount(), 1, 'a validated provisional read must arm despite event.error');
  const outcome = send(guard);
  assert.ok(outcome, 'the matching final payload must be replaced');
  assert.ok(outcome.payload.text.includes(`1. ${TITLE_A}`), outcome.payload.text);
  assert.ok(outcome.payload.text.includes('这一轮的候选如下：'), outcome.payload.text);
  for (const forbidden of FORBIDDEN_IN_MEMBER_TEXT) {
    assert.ok(!outcome.payload.text.includes(forbidden), `member text leaked ${forbidden}`);
  }
});

test('a live provisional read arms through the Tool Search dispatch with its real error envelope', () => {
  // The live shape: the outer `tool_call` dispatcher carries the guest provisional answer and the host
  // stamps `event.error` on the outer event. The guard unwraps the host identity, reads the guest
  // outcome, and admits the one provisional error code.
  const guard = armViaToolSearch(buildGuard(), {
    result: wrappedResult(provisionalAnswer()),
    error: 'provisional',
  });
  assert.equal(guard.pendingCount(), 1);
  const outcome = send(guard);
  assert.ok(outcome);
  assert.ok(outcome.payload.text.includes(`1. ${TITLE_A}`), outcome.payload.text);
  assert.ok(outcome.payload.text.includes(`2. ${TITLE_B}`), outcome.payload.text);
  // The clarification still publishes no identifier, no voter and no count.
  for (const forbidden of FORBIDDEN_IN_MEMBER_TEXT) {
    assert.ok(!outcome.payload.text.includes(forbidden), `member text leaked ${forbidden}`);
  }
  assert.ok(!outcome.payload.text.includes(CANDIDATE_A) && !outcome.payload.text.includes(CANDIDATE_B));
});

test('a malformed or non-provisional error never arms, even with a provisional-looking answer', () => {
  const provisional = provisionalAnswer();
  const shapes = [
    // A real failure code riding a provisional-shaped envelope is still a failure: refused.
    { result: provisional, error: 'tool failed' },
    { result: provisional, error: 'validation error' },
    { result: provisional, error: 'PROVISIONAL ' },
    { result: provisional, error: 'provisional-error' },
    { result: provisional, error: 'provisional: the round is still open' },
    // A provisional answer whose envelope disagrees with the tool's own open-round read: `ok` is not
    // false, the status or narration kind is not provisional, an outcome is claimed, or the read is
    // marked finalized. None of these is the validated shape, so the matching error is not admitted.
    { result: provisionalAnswer({ ok: true }), error: 'provisional' },
    { result: provisionalAnswer({ status: 'error' }), error: 'provisional' },
    {
      result: provisionalAnswer({
        narration: { ...provisional.details.narration, kind: 'final' },
      }),
      error: 'provisional',
    },
    {
      result: provisionalAnswer({
        narration: { ...provisional.details.narration, outcome: 'winner' },
      }),
      error: 'provisional',
    },
    {
      result: provisionalAnswer({
        narration: { ...provisional.details.narration, finalized: true },
      }),
      error: 'provisional',
    },
    // The provisional error code riding an answer that is not this tool at all.
    {
      result: { details: { tool: 'rein_poll_open', ok: false, status: 'provisional' } },
      error: 'provisional',
    },
  ];
  for (const [index, shape] of shapes.entries()) {
    const guard = buildGuard();
    arm(guard, shape);
    assert.equal(
      guard.pendingCount(),
      0,
      `shape ${index}: ${JSON.stringify(shape).slice(0, 160)}`,
    );
    assert.equal(send(guard), undefined);
  }
});

test('a final-round read is still refused when the host reports an error', () => {
  // The provisional allowance is the only hole in the error fence: a closed-round answer that arrived
  // with any host error is not read, so its sentence never arms.
  const guard = arm(buildGuard(), { result: winnerAnswer(), error: 'provisional' });
  assert.equal(guard.pendingCount(), 0);
  assert.equal(send(guard), undefined);
});

test('an empty error string is no error at all, so a provisional answer arms on the plain path', () => {
  // The error fence only bites on a non-empty `event.error`. An empty string (like `undefined` or
  // `null`) is the host saying it reported no error, so the provisional read arms through the ordinary
  // provisional branch rather than through the error allowance.
  const guard = arm(buildGuard(), { result: provisionalAnswer(), error: '' });
  assert.equal(guard.pendingCount(), 1);
  const outcome = send(guard);
  assert.ok(outcome);
  assert.ok(outcome.payload.text.includes(`1. ${TITLE_A}`), outcome.payload.text);
});

test('a malformed, unrecognized or over-long answer is refused rather than guessed at', () => {
  const winner = winnerAnswer();
  const shapes = [
    // No result object at all.
    { result: undefined },
    { result: 'not an object' },
    // Structured answer with no narration.
    { result: { details: { tool: POLL_RESULT_GUARD_TOOL_NAME, ok: true, outcome: 'winner' } } },
    { result: { content: [{ type: 'text', text: 'not json' }], details: null } },
    // A final kind that is not the recorded outcome, or that carries no outcome at all.
    {
      result: {
        details: {
          tool: POLL_RESULT_GUARD_TOOL_NAME,
          ok: false,
          narration: { kind: 'final', note: winnerNote(TITLE_A) },
        },
      },
    },
    {
      result: {
        details: {
          tool: POLL_RESULT_GUARD_TOOL_NAME,
          ok: true,
          narration: { kind: 'final', note: winnerNote(TITLE_A) },
        },
      },
    },
    // An outcome kind, or a narration kind, this guard does not narrate.
    {
      result: {
        details: {
          ...winner.details,
          narration: { ...winner.details.narration, outcome: 'tie' },
        },
      },
    },
    {
      result: {
        details: {
          ...winner.details,
          narration: { ...winner.details.narration, kind: 'summary' },
        },
      },
    },
    // An empty or over-long note.
    {
      result: {
        details: { ...winner.details, narration: { ...winner.details.narration, note: '   ' } },
      },
    },
    {
      result: {
        details: {
          ...winner.details,
          narration: {
            ...winner.details.narration,
            note: winnerNote('S'.repeat(MAX_POLL_NOTE_LENGTH + 1)),
          },
        },
      },
    },
  ];
  for (const shape of shapes) {
    const guard = buildGuard();
    arm(guard, shape);
    assert.equal(guard.pendingCount(), 0, JSON.stringify(shape).slice(0, 120));
    assert.equal(send(guard), undefined);
  }
});

test('a note carrying implementation vocabulary or an identifier is refused', () => {
  const winner = winnerAnswer();
  const unspeakable = [
    // Transport metadata and reason codes the director must never hear.
    `${winnerNote(TITLE_A)} delivery=model_relayed`,
    `${winnerNote(TITLE_A)} existing_finalized`,
    `${winnerNote(TITLE_A)} repeated=true`,
    `${winnerNote(TITLE_A)} official=true`,
    `${winnerNote(TITLE_A)} narration`,
    `${winnerNote(TITLE_A)} rein_poll_result`,
    // A voter, or a stored record identifier in place of a title.
    `${noWinnerNote()} voter=${VOTER_CONTACT}`,
    winnerNote(POLL),
  ];
  for (const note of unspeakable) {
    const guard = buildGuard();
    arm(guard, {
      result: { details: { ...winner.details, narration: { ...winner.details.narration, note } } },
    });
    assert.equal(guard.pendingCount(), 0, note);
    assert.equal(send(guard), undefined);
  }
});

test('a sentence that does not match the recorded outcome is refused', () => {
  const winner = winnerAnswer();
  const noWinner = noWinnerAnswer();
  const provisional = provisionalAnswer();
  const mismatched = [
    // A winner answer whose sentence never names the recorded winner.
    { ...winner.details, narration: { ...winner.details.narration, note: winnerNote(TITLE_B) } },
    // A winner answer that reads as a no-winner record.
    { ...winner.details, narration: { ...winner.details.narration, note: noWinnerNote() } },
    // A winner sentence that omits the winner's count: the recorded count is right there in
    // `narration.counts`, so the delivered reply has to print it instead of dropping the figure.
    {
      ...winner.details,
      narration: { ...winner.details.narration, note: winnerNoteWithoutCount(TITLE_A) },
    },
    // A winner sentence whose count is not the count the answer published for that same winner, so a
    // count recorded for another candidate cannot be delivered beside this one.
    {
      ...winner.details,
      narration: { ...winner.details.narration, note: winnerNote(TITLE_A, 2, 0, 1) },
    },
    {
      ...winner.details,
      narration: { ...winner.details.narration, note: winnerNote(TITLE_A, 2, 0, 9) },
    },
    // The count clause pinned to the wrong candidate: the winner's title is absent and the count rides
    // the runner-up's name, which is exactly the mismatch the pairing check exists to catch.
    {
      ...winner.details,
      narration: {
        ...winner.details.narration,
        note: `${WINNER_LEAD}${TITLE_B}。${winnerCountClause(2)}${NO_FUNDS}`,
      },
    },
    // A no-winner answer that names a winner or a winning title.
    { ...noWinner.details, narration: { ...noWinner.details.narration, winnerTitle: TITLE_A } },
    { ...noWinner.details, narration: { ...noWinner.details.narration, winner: CANDIDATE_A } },
    // A no-winner sentence that carries a candidate's count, which would read as a standing the record
    // does not hold.
    {
      ...noWinner.details,
      narration: {
        ...noWinner.details.narration,
        note: `${NO_WINNER_LEAD}${winnerCountClause(1)}${ballotSentence(3, 1)}${NO_WINNER_RULE}${NO_FUNDS}`,
      },
    },
    // A no-winner sentence that reads as the winner wording, count and all.
    {
      ...noWinner.details,
      narration: {
        ...noWinner.details.narration,
        note: `${WINNER_LEAD}${TITLE_A}。${winnerCountClause(1)}${NO_FUNDS}`,
      },
    },
    // A no-winner sentence that names the winning candidate anyway, or drops the unconfirmed rule.
    {
      ...noWinner.details,
      narration: { ...noWinner.details.narration, note: `${WINNER_LEAD}${TITLE_A}。${NO_FUNDS}` },
    },
    {
      ...noWinner.details,
      narration: {
        ...noWinner.details.narration,
        note: `${NO_WINNER_LEAD}${ballotSentence(3, 1)}${NO_FUNDS}`,
      },
    },
    // A sentence that never says the record moves no money.
    {
      ...winner.details,
      narration: {
        ...winner.details.narration,
        note: `${WINNER_LEAD}${TITLE_A}。${ballotSentence(2, 0)}`,
      },
    },
    // An open-round read is answered by the guard's own clarification, never by the tool's outcome
    // wording, but a provisional answer that claims to be the recorded outcome is a shape the guard
    // does not recognize: it arms nothing rather than narrating an outcome it cannot vouch for.
    {
      ...provisional.details,
      narration: { ...provisional.details.narration, outcome: 'winner' },
    },
  ];
  for (const [index, shape] of mismatched.entries()) {
    const guard = buildGuard();
    arm(guard, { result: { details: shape } });
    assert.equal(guard.pendingCount(), 0, `shape ${index}: ${JSON.stringify(shape).slice(0, 160)}`);
    assert.equal(send(guard), undefined);
  }
});

test('a host payload with no text is left alone, and it consumes the run', () => {
  const guard = arm(buildGuard());
  assert.equal(send(guard, { payload: { replyToId: '1700000000.000100' } }), undefined);
  // The unusable payload still consumed the run, so the next one is not rewritten either.
  assert.equal(guard.pendingCount(), 0);
  assert.equal(send(guard), undefined);
});

// --- Tool Search dispatch ------------------------------------------------------------------------
// On a live Gateway the result tool is reached through Tool Search: the host runs one outer
// dispatcher tool named `tool_call`, so `after_tool_call` reports that outer name and the dispatcher's
// envelope rather than the guest tool.

test('a Tool Search dispatch arms the guard through the host tool identity', () => {
  const guard = armViaToolSearch(buildGuard());
  assert.equal(guard.pendingCount(), 1);
  const outcome = send(guard);
  assert.ok(outcome);
  assert.equal(outcome.payload.text, winnerNote(TITLE_A));
  for (const forbidden of FORBIDDEN_IN_MEMBER_TEXT) {
    assert.ok(!outcome.payload.text.includes(forbidden), `member text leaked ${forbidden}`);
  }
});

test('a model-authored dispatcher id can neither arm nor clear the guard', () => {
  // The outer params name the result tool while the host envelope names something else: the params are
  // ignored, so nothing arms.
  const spoofed = buildGuard();
  armViaToolSearch(spoofed, { result: wrappedResult(winnerAnswer(), 'rein_status') });
  assert.equal(spoofed.pendingCount(), 0);
  assert.equal(send(spoofed), undefined);

  // The outer params name an unrelated tool while the host envelope names the result tool: the
  // envelope wins, so the guard arms.
  const real = armViaToolSearch(buildGuard(), { params: { id: 'rein_status', args: {} } });
  assert.equal(real.pendingCount(), 1);
  assert.ok(send(real));

  // A `tool_call` envelope with no usable host identity or guest outcome arms nothing.
  for (const result of [
    { details: { tool: { name: POLL_RESULT_GUARD_TOOL_NAME } } },
    { details: {} },
    {},
    'not an object',
  ]) {
    const guard = buildGuard();
    armViaToolSearch(guard, { result });
    assert.equal(guard.pendingCount(), 0, JSON.stringify(result));
  }
});

test('a dispatched closing write clears the run through the host identity too', () => {
  const guard = armViaToolSearch(buildGuard());
  assert.equal(guard.pendingCount(), 1);
  guard.afterToolCall({
    toolName: TOOL_SEARCH_DISPATCHER_TOOL_NAME,
    params: { id: POLL_RESULT_GUARD_TOOL_NAME },
    runId: RUN,
    toolCallId: 'call-ts-2',
    result: wrappedResult({ details: { tool: 'rein_poll_vote', ok: true } }, 'rein_poll_vote'),
  });
  assert.equal(guard.pendingCount(), 0);
  assert.equal(send(guard), undefined);
});

test('two loaded guard instances meet on the shared store', () => {
  // A live Gateway loads this plugin more than once, so the hook that arms and the hook that reads can
  // run in different module graphs. Both instances below take the production default store, and the
  // run id is this test's own, so the arm in one instance is what the other finds.
  const armed = createPollReplyGuard({ now: () => 0 });
  const reader = createPollReplyGuard({ now: () => 0 });
  const sharedRun = 'run-case7-shared-instances';
  armed.afterToolCall({
    toolName: POLL_RESULT_GUARD_TOOL_NAME,
    params: {},
    runId: sharedRun,
    result: winnerAnswer(),
  });
  const outcome = reader.replyPayloadSending({
    payload: unsafeFinalPayload(),
    kind: POLL_GUARD_FINAL_KIND,
    channel: POLL_GUARD_CHANNEL,
    runId: sharedRun,
  });
  assert.ok(outcome, 'the shared store must carry the arm to the other instance');
  assert.equal(outcome.payload.text, winnerNote(TITLE_A));
  // Consumed once, and an isolated store never sees it: the two keys stay apart.
  const isolated = createPollReplyGuard({ now: () => 0, stateKey: isolatedStoreKey() });
  assert.equal(isolated.pendingCount(), 0);
  assert.equal(
    isolated.replyPayloadSending({
      payload: unsafeFinalPayload(),
      kind: POLL_GUARD_FINAL_KIND,
      channel: POLL_GUARD_CHANNEL,
      runId: sharedRun,
    }),
    undefined,
  );
});

test('an unbounded stream of runs cannot grow the store past its bound', () => {
  const guard = createPollReplyGuard({ now: () => 0, stateKey: isolatedStoreKey(), maxEntries: 4 });
  for (let index = 0; index < 12; index += 1) {
    guard.afterToolCall({
      toolName: POLL_RESULT_GUARD_TOOL_NAME,
      params: {},
      runId: `run-case7-${index}`,
      result: winnerAnswer(),
    });
  }
  assert.equal(guard.pendingCount(), 4);
});

test('a remembered sentence expires once its ttl passes', () => {
  let clock = 0;
  const guard = createPollReplyGuard({
    now: () => clock,
    stateKey: isolatedStoreKey(),
    ttlMs: 1000,
  });
  arm(guard);
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
  process.env.REIN_POLL_GUARD_TEST_URL = 'https://project-ref.supabase.co';
  process.env.REIN_POLL_GUARD_TEST_KEY = 'sb_secret_poll_guard_test_0000000000000000';
  process.env.REIN_POLL_GUARD_TEST_CONFIRM = 'poll-guard-test-proposal-confirmation-key-0001';
  const hooks = [];
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
        supabaseUrlEnvVar: 'REIN_POLL_GUARD_TEST_URL',
        supabaseServiceKeyEnvVar: 'REIN_POLL_GUARD_TEST_KEY',
        proposalConfirmationKeyEnvVar: 'REIN_POLL_GUARD_TEST_CONFIRM',
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

test('the real entry registers the poll guard hooks, matched to the result tool and the writes', () => {
  const hooks = registerPlugin();
  const pollArm = hooks.find(
    hook =>
      hook.hookName === 'after_tool_call' &&
      JSON.stringify(hook.options?.matcher) === JSON.stringify([...POLL_REPLY_GUARD_TOOL_NAMES]),
  );
  assert.ok(pollArm, 'the entry must register the poll-result after_tool_call hook');
  assert.deepEqual(pollArm.options, { matcher: [...POLL_REPLY_GUARD_TOOL_NAMES] });
  // Every MVP reply guard registers a reply hook, the collect guard's first and the poll guard's last,
  // so the last one is this guard's own handler.
  const replyHooks = hooks.filter(hook => hook.hookName === 'reply_payload_sending');
  assert.equal(replyHooks.length, 3, 'every MVP reply guard must register its reply hook');
  const pollReply = replyHooks[replyHooks.length - 1].handler;

  // A direct call round-trips through the registered handlers.
  pollArm.handler({
    toolName: POLL_RESULT_GUARD_TOOL_NAME,
    params: {},
    runId: RUN,
    result: winnerAnswer(),
  });
  const outcome = pollReply({
    payload: unsafeFinalPayload(),
    kind: POLL_GUARD_FINAL_KIND,
    channel: POLL_GUARD_CHANNEL,
    runId: RUN,
  });
  assert.ok(outcome, 'the registered reply hook must replace the matching final payload');
  assert.equal(outcome.payload.text, winnerNote(TITLE_A));

  // A live Tool Search dispatch does too.
  pollArm.handler({
    toolName: TOOL_SEARCH_DISPATCHER_TOOL_NAME,
    params: { id: POLL_RESULT_GUARD_TOOL_NAME },
    runId: RUN,
    result: wrappedResult(winnerAnswer()),
  });
  const dispatched = pollReply({
    payload: unsafeFinalPayload(),
    kind: POLL_GUARD_FINAL_KIND,
    channel: POLL_GUARD_CHANNEL,
    runId: RUN,
  });
  assert.ok(dispatched, 'a Tool Search dispatch must arm the registered reply hook');

  // The matcher admitting the writes is load-bearing: without them a write reply would be rewritten.
  pollArm.handler({
    toolName: POLL_RESULT_GUARD_TOOL_NAME,
    params: {},
    runId: RUN,
    result: winnerAnswer(),
  });
  pollArm.handler({
    toolName: 'rein_poll_vote',
    params: {},
    runId: RUN,
    result: { details: { ok: true } },
  });
  assert.equal(
    pollReply({
      payload: unsafeFinalPayload(),
      kind: POLL_GUARD_FINAL_KIND,
      channel: POLL_GUARD_CHANNEL,
      runId: RUN,
    }),
    undefined,
    'a write in the run must leave the run reply untouched',
  );

  // The collect guard keeps its own hook and matcher, so this addition changed nothing about case 3.
  const collectArm = hooks.find(
    hook =>
      hook.hookName === 'after_tool_call' &&
      JSON.stringify(hook.options?.matcher) === JSON.stringify([...COLLECT_REPLY_GUARD_TOOL_NAMES]),
  );
  assert.ok(collectArm, 'the collect guard must keep its own after_tool_call hook');
  assert.deepEqual(collectArm.options, { matcher: [...COLLECT_REPLY_GUARD_TOOL_NAMES] });
});
