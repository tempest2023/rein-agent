import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIncludedQuotaError, wrapQuotaErrors } from '../plugins/rein-router/quota.mjs';

const canonical = '429 subscription quota limit reached; automatic quota refresh required (included allowance exhausted)';
const message = (errorMessage = '402: Synthetic included quota exhausted', overrides = {}) => ({
  role: 'assistant', content: [], stopReason: 'error', errorMessage, errorCode: '402',
  errorType: 'insufficient_quota', errorBody: 'PRIVATE-ERROR-BODY-CANARY',
  api: 'openai-completions', provider: 'rein-magpie', model: 'fixture/google:none',
  usage: { input: 0, output: 0 }, timestamp: 1, ...overrides,
});
function source(events, final = events.at(-1)?.error ?? events.at(-1)?.message) {
  return {
    resultCalls: 0,
    async *[Symbol.asyncIterator]() { yield* events; },
    result() { this.resultCalls++; return Promise.resolve(final); },
  };
}

for (const text of [
  '402: Synthetic included quota exhausted',
  'HTTP 402 Payment Required: Your subscription allowance is exhausted.',
  '429: The subscription quota limit has been reached.',
  '429 coding-plan usage limit exceeded',
  '402 coding_plan allowance depleted',
  '402: The included allowance was used up.',
  '402: Your subscription has insufficient quota.',
]) test(`recognizes explicit included allowance exhaustion: ${text}`, () => {
  const original = message(text, { errorCode: undefined });
  const normalized = normalizeIncludedQuotaError(original);
  assert.notEqual(normalized, original);
  assert.equal(normalized.errorMessage, canonical);
  assert.equal(normalized.errorCode, '429');
  assert.equal(normalized.errorType, 'rate_limit_error');
  assert.equal(normalized.provider, original.provider); assert.equal(normalized.model, original.model);
  assert.equal(normalized.content, original.content); assert.equal(normalized.usage, original.usage);
  assert.ok(!normalized.errorBody.includes('CANARY'));
  assert.equal(original.errorMessage, text); assert.equal(original.errorCode, undefined);
});

test('structured subscription scope and numeric status can supply bounded error evidence', () => {
  const original = message('Quota exhausted.', { status: 402, errorCode: undefined, errorType: 'subscription_limit' });
  // Underscore-separated wire types are not natural-language source claims.
  assert.equal(normalizeIncludedQuotaError(original), original);
  const explicit = { ...original, errorType: 'subscription quota', errorMessage: 'Allowance exhausted.' };
  assert.equal(normalizeIncludedQuotaError(explicit).errorMessage, canonical);
});

for (const text of [
  '402: insufficient quota',
  '402: Quota exhausted',
  '402: Insufficient credits for the subscription quota.',
  '402: Subscription quota exceeded; insufficient balance.',
  '402: Subscription quota exhausted; payment is required.',
  '402: Subscription quota exhausted; billing hard limit.',
  '429: Subscription quota exceeded; invalid API key.',
  '429: Subscription quota exceeded; gateway key rejected.',
  '429: Subscription quota exceeded; authentication failed.',
  '402: Included allowance is available.',
]) test(`preserves unproven quota or gateway billing/auth failure: ${text}`, () => {
  const original = message(text, { errorCode: undefined });
  assert.equal(normalizeIncludedQuotaError(original), original);
});

test('401/403 gateway authentication failures and unrelated status are untouched', () => {
  for (const status of [400, 401, 403, 500]) {
    const original = message(`${status}: Included subscription quota exhausted`, { errorCode: String(status) });
    assert.equal(normalizeIncludedQuotaError(original), original);
  }
});

test('successful and cancelled messages ignore stale error text', () => {
  for (const stopReason of ['stop', 'toolUse', 'aborted']) {
    const original = message(undefined, { stopReason });
    assert.equal(normalizeIncludedQuotaError(original), original);
  }
});

test('error normalization preserves event order and tool events without mutating the source', async () => {
  const original = message();
  const start = { type: 'start', partial: { role: 'assistant', content: [] } };
  const tool = { type: 'toolcall_end', contentIndex: 0, toolCall: { id: 'tool-1', name: 'read', arguments: {} }, partial: {} };
  const error = { type: 'error', reason: 'error', error: original };
  const input = source([start, tool, error], original);
  const wrapped = wrapQuotaErrors(input);
  const events = [];
  for await (const event of wrapped) events.push(event);
  assert.equal(events[0], start); assert.equal(events[1], tool);
  assert.notEqual(events[2], error); assert.equal(events[2].error.errorMessage, canonical);
  assert.equal(await wrapped.result(), events[2].error);
  assert.equal(original.errorMessage, '402: Synthetic included quota exhausted');
  assert.equal(error.error, original);
});

test('result normalizes independently of event consumption and calls source result once', async () => {
  const original = message(); const input = source([], original); const wrapped = wrapQuotaErrors(input);
  const first = wrapped.result(); assert.equal(wrapped.result(), first);
  assert.equal((await first).errorMessage, canonical); assert.equal(input.resultCalls, 1);
});

test('successful stream events and result preserve exact references', async () => {
  const final = message('stale quota error', { stopReason: 'toolUse', content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: {} }] });
  const event = { type: 'done', reason: 'toolUse', message: final };
  const wrapped = wrapQuotaErrors(source([event], final)); const events = [];
  for await (const output of wrapped) events.push(output);
  assert.equal(events[0], event); assert.equal(await wrapped.result(), final);
});

test('aborted stream event and result pass through without normalization or fallback work', async () => {
  const final = message(undefined, { stopReason: 'aborted' });
  const event = { type: 'error', reason: 'aborted', error: final };
  const wrapped = wrapQuotaErrors(source([event], final)); const events = [];
  for await (const output of wrapped) events.push(output);
  assert.equal(events[0], event); assert.equal(await wrapped.result(), final);
});

test('iterator cancellation propagates return to its source', async () => {
  let closed = false;
  const final = message(undefined, { stopReason: 'aborted' });
  const input = { async *[Symbol.asyncIterator]() { try { yield { type: 'start' }; yield { type: 'error', reason: 'aborted', error: final }; } finally { closed = true; } },
    result: async () => final };
  const wrapped = wrapQuotaErrors(input);
  for await (const _event of wrapped) break;
  assert.equal(closed, true); assert.equal(await wrapped.result(), final);
});

test('producer cancellation and result rejection preserve the original thrown error', async () => {
  const abort = new DOMException('Synthetic cancelled request', 'AbortError');
  const input = { async *[Symbol.asyncIterator]() { throw abort; }, result: async () => { throw abort; } };
  const wrapped = wrapQuotaErrors(input);
  await assert.rejects(async () => { for await (const _event of wrapped) {} }, error => error === abort);
  await assert.rejects(wrapped.result(), error => error === abort);
});

test('async StreamFn sources are wrapped after resolving, with promise rejection unchanged', async () => {
  const original = message(); const wrapped = await wrapQuotaErrors(Promise.resolve(source([], original)));
  assert.equal((await wrapped.result()).errorMessage, canonical);
  const abort = new DOMException('Synthetic cancelled stream setup', 'AbortError');
  await assert.rejects(wrapQuotaErrors(Promise.reject(abort)), error => error === abort);
});

test('oversized/nonmessage evidence remains unchanged and invalid streams fail clearly', () => {
  const oversized = message(`402 included quota exhausted ${'x'.repeat(16384)}`);
  assert.equal(normalizeIncludedQuotaError(oversized), oversized);
  for (const value of [null, undefined, '402 included quota exhausted', {}]) assert.equal(normalizeIncludedQuotaError(value), value);
  assert.throws(() => wrapQuotaErrors({}), /rein_router_quota_stream_invalid/);
});

test('async normalization waits for shared evidence and runs once across concurrent event/result consumers', async () => {
  const original = message('401: Synthetic upstream token expired', { errorCode: '401' });
  const errorEvent = { type: 'error', reason: 'error', error: original };
  const start = { type: 'start', partial: { role: 'assistant', content: [] } };
  const input = source([start, errorEvent], original);
  const normalized = { ...original, errorCode: '502', errorMessage: 'Synthetic safe upstream authentication failure' };
  let releaseEvidence;
  const evidence = new Promise(resolve => { releaseEvidence = resolve; });
  let evidenceStarted;
  const started = new Promise(resolve => { evidenceStarted = resolve; });
  let calls = 0;
  const wrapped = wrapQuotaErrors(input, async received => {
    assert.equal(received, original); calls++;
    evidenceStarted();
    await evidence;
    return normalized;
  });
  const iterator = wrapped[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value, start);
  const firstError = iterator.next();
  const final = wrapped.result();
  assert.equal(wrapped.result(), final);
  let errorEmitted = false;
  void firstError.then(() => { errorEmitted = true; });
  await started;
  assert.equal(calls, 1);
  assert.equal(errorEmitted, false);
  releaseEvidence();
  const error = (await firstError).value;
  assert.equal(error.error, normalized);
  assert.equal(await final, normalized);
  assert.notEqual(error, errorEvent);
  assert.equal((await iterator.next()).done, true);
  assert.equal(calls, 1);
  assert.equal(input.resultCalls, 1);
  assert.equal(original.errorCode, '401');
});

test('synchronous custom normalization preserves exact event/result objects', async () => {
  const original = message();
  const event = { type: 'error', reason: 'error', error: original };
  const normalized = { ...original, errorCode: 'custom' };
  let calls = 0;
  const wrapped = wrapQuotaErrors(source([event], original), received => {
    assert.equal(received, original); calls++; return normalized;
  });
  const final = await wrapped.result();
  const events = [];
  for await (const output of wrapped) events.push(output);
  assert.equal(final, normalized);
  assert.equal(events[0].error, normalized);
  assert.equal(calls, 1);
});

test('an async normalizer returning its input preserves the source error event reference', async () => {
  const original = message(); const event = { type: 'error', reason: 'error', error: original };
  const wrapped = wrapQuotaErrors(source([event], original), async value => value);
  const events = [];
  for await (const output of wrapped) events.push(output);
  assert.equal(events[0], event);
  assert.equal(await wrapped.result(), original);
});

test('custom normalization bypasses successful and aborted messages without starting lookup work', async () => {
  let calls = 0;
  for (const stopReason of ['stop', 'toolUse', 'aborted']) {
    const final = message('401: Synthetic stale authentication text', { stopReason });
    const event = stopReason === 'aborted'
      ? { type: 'error', reason: 'aborted', error: final }
      : { type: 'done', reason: stopReason, message: final };
    const wrapped = wrapQuotaErrors(source([event], final), async () => { calls++; throw new Error('must not run'); });
    const events = [];
    for await (const output of wrapped) events.push(output);
    assert.equal(events[0], event);
    assert.equal(await wrapped.result(), final);
  }
  assert.equal(calls, 0);
});

for (const mode of ['throw', 'reject']) {
  test(`custom normalization ${mode} retains exact rejection identity and shares one failure`, async () => {
    const original = message(); const failure = new Error('Synthetic evidence lookup failed'); let calls = 0;
    const wrapped = wrapQuotaErrors(source([{ type: 'error', reason: 'error', error: original }], original), () => {
      calls++;
      if (mode === 'throw') throw failure;
      return Promise.reject(failure);
    });
    await assert.rejects(async () => { for await (const _event of wrapped) {} }, error => error === failure);
    await assert.rejects(wrapped.result(), error => error === failure);
    assert.equal(calls, 1);
  });
}

test('source cancellation bypasses async normalization and preserves its exact rejection', async () => {
  const abort = new DOMException('Synthetic caller cancellation', 'AbortError'); let calls = 0;
  const input = { async *[Symbol.asyncIterator]() { throw abort; }, result: async () => { throw abort; } };
  const wrapped = wrapQuotaErrors(input, async () => { calls++; return message(); });
  await assert.rejects(async () => { for await (const _event of wrapped) {} }, error => error === abort);
  await assert.rejects(wrapped.result(), error => error === abort);
  assert.equal(calls, 0);
});
