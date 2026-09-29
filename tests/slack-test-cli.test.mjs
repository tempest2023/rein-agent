// Tests for the local Slack test harness. All Slack traffic is mocked; no network call is made and
// no message is sent. Every test asserts that token values never leak into output or errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SLACK_TEST_OPTIONAL_IDENTITIES,
  SLACK_TEST_CHANNELS,
  SLACK_TEST_IDENTITIES,
  SLACK_TEST_TEAM_ID,
  HarnessError,
  activeIdentities,
  assertAllowedChannel,
  assertCaseKey,
  assertTokenFresh,
  assessTokenFreshness,
  clientMsgIdForKey,
  idempotencyKey,
  loadUserTokens,
  lookupLedger,
  readJsonTokenDoc,
  redactTokens,
  resolveOptionalIdentities,
  verifyAllIdentities,
} from '../scripts/slack-test-lib.mjs';
import { runSend } from '../scripts/slack-test-cli.mjs';

const TOKEN = id => `xoxp-test-${id}-secret-value`;
const LEAD = SLACK_TEST_IDENTITIES[0];
const MEMBER = SLACK_TEST_IDENTITIES[1];
const CHANNEL = SLACK_TEST_CHANNELS[0].id;
const BOARD = SLACK_TEST_CHANNELS[1].id;
const MENTION = 'U0C5G9Y8HLG';

/**
 * Tests must never touch the real local run ledger. Every send in this file passes an in-memory
 * ledger so a repeated test run cannot be skipped and no state is written under `runtime/`.
 */
const EMPTY_LEDGER = Object.freeze({});

/**
 * Structural UUID check. Group lengths plus the version and variant nibbles are asserted explicitly
 * rather than with one character-class regex, which keeps the failure message readable.
 */
function assertUuidV5(id, label) {
  const groups = String(id).split('-');
  assert.equal(groups.length, 5, `${label}: expected five UUID groups, got ${JSON.stringify(id)}`);
  assert.deepEqual(groups.map(group => group.length), [8, 4, 4, 4, 12], `${label}: wrong group lengths`);
  assert.match(id, /^[0-9a-f-]+$/, `${label}: non-hex characters`);
  assert.equal(groups[2][0], '5', `${label}: version nibble must be 5`);
  assert.ok('89ab'.includes(groups[3][0]), `${label}: variant nibble must be 8, 9, a or b`);
}

/** Token map for all five accounts, plus the `meta` block the OAuth helper writes. */
function fixtureTokens({ meta = {} } = {}) {
  const tokens = new Map(SLACK_TEST_IDENTITIES.map(identity => [identity.id, TOKEN(identity.id)]));
  return { tokens, meta };
}

/**
 * Mock Slack Web API. `authUser` maps account id -> user id returned by auth.test, so a test can
 * deliberately return the wrong user for one account. `identities` widens the recognised account set
 * (e.g. an enrolled `guest`); it defaults to the five required identities. Records every call.
 */
function mockFetch({ authUser = {}, teamId = SLACK_TEST_TEAM_ID, postResponse, authOk = true, identities = SLACK_TEST_IDENTITIES } = {}) {
  const calls = [];
  const overrides = new Map(Object.entries(authUser));
  const fetchImpl = async (url, init) => {
    const method = String(url).split('/api/')[1];
    const token = (init?.headers?.Authorization ?? '').replace('Bearer ', '');
    calls.push({ method, token, init, url });
    const body = init?.body;
    const json = payload => ({ status: 200, json: async () => payload });

    if (method === 'auth.test') {
      const accountId = identities.map(item => item.id).find(id => TOKEN(id) === token);
      const identity = identities.find(item => item.id === accountId);
      if (!identity || authOk === false) return json({ ok: false, error: 'invalid_auth' });
      return json({
        ok: true,
        team_id: teamId,
        team: 'Rein Test',
        user_id: overrides.get(accountId) ?? identity.expectedUserId,
        user: identity.id,
        url: `https://rein-test.slack.com/`,
      });
    }
    if (method === 'chat.postMessage') {
      return json(postResponse ?? {
        ok: true,
        channel: CHANNEL,
        ts: '1758900000.000100',
        message: { permalink: `https://rein-test.slack.com/archives/${CHANNEL}/p1758900000000100` },
      });
    }
    return json({ ok: false, error: 'unknown_method' });
  };
  return { calls, fetchImpl };
}

function captureConsole(fn) {
  const out = [];
  const err = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => err.push(args.join(' '));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = originalLog;
      console.error = originalError;
    })
    .then(value => ({ value, out: out.join('\n'), err: err.join('\n') }));
}

test('identity mismatch stops the send before any message is posted', async () => {
  // `member` authenticates as a different user than the mapping requires.
  const { calls, fetchImpl } = mockFetch({
    authUser: { member: 'U0C4L74033P' },
  });
  const { tokens, meta } = fixtureTokens();

  await assert.rejects(
    () => runSend(
      { accountId: 'member', channelId: CHANNEL, caseKey: 'case-a1', text: 'hello' },
      { tokens, meta, fetchImpl },
    ),
    error => {
      assert.ok(error instanceof HarnessError);
      assert.equal(error.code, 'user-mismatch');
      assert.match(error.message, /expected U0C5KLD8Z5E/);
      return true;
    },
  );

  assert.equal(calls.filter(call => call.method === 'chat.postMessage').length, 0, 'no message may be sent');
});

test('workspace mismatch stops the send', async () => {
  const { calls, fetchImpl } = mockFetch({ teamId: 'T0WRONGWRONG' });
  const { tokens, meta } = fixtureTokens();
  await assert.rejects(
    () => runSend({ accountId: 'lead', channelId: CHANNEL, caseKey: 'case-a2', text: 'case a2 probe' }, { tokens, meta, fetchImpl, ledger: EMPTY_LEDGER }),
    error => error.code === 'team-mismatch',
  );
  assert.equal(calls.filter(call => call.method === 'chat.postMessage').length, 0);
});

test('unknown channel is refused before auth and send', async () => {
  const { calls, fetchImpl } = mockFetch();
  const { tokens, meta } = fixtureTokens();
  await assert.rejects(
    () => runSend({ accountId: 'lead', channelId: 'C0PRODUCTION', caseKey: 'case-a3', text: 'case a3 probe' }, { tokens, meta, fetchImpl, ledger: EMPTY_LEDGER }),
    error => error.code === 'channel-not-allowed',
  );
  assert.equal(calls.length, 0, 'the channel check must run before any Slack call');
});

test('happy path posts as the verified user with the real mention and no token in output', async () => {
  const { calls, fetchImpl } = mockFetch();
  const { tokens, meta } = fixtureTokens();

  const { value, out } = await captureConsole(() =>
    runSend(
      { accountId: 'lead', channelId: BOARD, caseKey: 'case-happy', text: 'Please review the proposal.' },
      { tokens, meta, fetchImpl, ledger: EMPTY_LEDGER },
    ),
  );

  assert.equal(value, 0);
  const posts = calls.filter(call => call.method === 'chat.postMessage');
  assert.equal(posts.length, 1, 'exactly one message is posted');
  assert.equal(posts[0].token, TOKEN('lead'), 'the lead user token authenticates the post');
  assert.notEqual(posts[0].token, 'xoxb-bot-token');

  const body = posts[0].init.body;
  assert.equal(body.get('channel'), BOARD);
  assert.match(body.get('text'), new RegExp(`<@${MENTION}>`));
  assert.equal(body.get('dedupe'), null, 'the undocumented dedupe field must not be sent');
  assert.equal(body.get('client_msg_id'), await clientMsgIdForKey(idempotencyKey('case-happy', 'lead', BOARD)));
  assertUuidV5(body.get('client_msg_id'), 'client_msg_id');

  assert.match(out, /Sent as/);
  assert.match(out, /permalink: https:\/\/rein-test\.slack\.com\/archives\//);
  for (const identity of SLACK_TEST_IDENTITIES) {
    assert.ok(!out.includes(TOKEN(identity.id)), `output must not contain the ${identity.id} token`);
  }
});

test('dry run performs no post', async () => {
  const { calls, fetchImpl } = mockFetch();
  const { tokens, meta } = fixtureTokens();
  const { value, out } = await captureConsole(() =>
    runSend({ accountId: 'lead', channelId: CHANNEL, caseKey: 'case-dry', text: 'dry run probe', dryRun: true }, { tokens, meta, fetchImpl, ledger: EMPTY_LEDGER }),
  );
  assert.equal(value, 0);
  assert.equal(calls.filter(call => call.method === 'chat.postMessage').length, 0);
  assert.match(out, /Dry run/);
});

test('an expired or reauth-flagged token is refused with no unsafe send', async () => {
  const { calls, fetchImpl } = mockFetch();
  const expired = fixtureTokens({
    meta: { accounts: { lead: { expiresAt: '2020-01-01T00:00:00Z', refreshTokenRequired: true } } },
  });
  await assert.rejects(
    () => runSend({ accountId: 'lead', channelId: CHANNEL, caseKey: 'case-exp', text: 'expired probe' }, { ...expired, fetchImpl, ledger: EMPTY_LEDGER }),
    error => error.code === 'token-expired',
  );
  assert.equal(calls.length, 0, 'an expired token must not be presented to Slack');

  const needsReauth = fixtureTokens({
    meta: { accounts: { lead: { refreshTokenRequired: true, refreshToken: 'xoxe-mock-refresh' } } },
  });
  await assert.rejects(
    () => runSend({ accountId: 'lead', channelId: CHANNEL, caseKey: 'case-reauth', text: 'reauth probe' }, { ...needsReauth, fetchImpl, ledger: EMPTY_LEDGER }),
    error => error.code === 'reauth-required',
  );
});

test('a fresh rotating token with a refresh token still sends as the user', async () => {
  // Mirrors the OAuth helper's real metadata: every rotating account records a refresh token and
  // sets refreshTokenRequired, while the freshly issued access token is valid for another hour.
  const { calls, fetchImpl } = mockFetch();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const { tokens, meta } = fixtureTokens({
    meta: {
      asOf: new Date().toISOString(),
      team: SLACK_TEST_TEAM_ID,
      accounts: {
        lead: {
          userId: LEAD.expectedUserId,
          refreshTokenRequired: true,
          refreshToken: 'xoxe-mock-refresh-token',
          expiresAt: future,
        },
      },
    },
  });

  const { value, out } = await captureConsole(() =>
    runSend(
      { accountId: 'lead', channelId: CHANNEL, caseKey: 'case-rotating', text: 'rotating token probe' },
      { tokens, meta, fetchImpl, ledger: EMPTY_LEDGER },
    ),
  );

  assert.equal(value, 0, 'a fresh rotating token must be usable');
  const posts = calls.filter(call => call.method === 'chat.postMessage');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].token, TOKEN('lead'));
  assert.equal(out.includes('xoxe-mock-refresh-token'), false, 'the refresh token must never be printed');
  assert.equal(out.includes(TOKEN('lead')), false, 'the access token must never be printed');
});

test('a rotating token inside the safety window is refused before any Slack call', async () => {
  const { calls, fetchImpl } = mockFetch();
  const soon = new Date(Date.now() + 30_000).toISOString();
  const { tokens, meta } = fixtureTokens({
    meta: { accounts: { lead: { refreshTokenRequired: true, refreshToken: 'xoxe-mock', expiresAt: soon } } },
  });
  await assert.rejects(
    () => runSend({ accountId: 'lead', channelId: CHANNEL, caseKey: 'case-near-exp', text: 'near expiry probe' }, { tokens, meta, fetchImpl, ledger: EMPTY_LEDGER }),
    error => error.code === 'token-expired',
  );
  assert.equal(calls.length, 0, 'a near-expiry token must not be presented to Slack');
});

test('case key maps to a stable UUID client_msg_id and a distinct one per case', async () => {
  const key = idempotencyKey('case-uuid', 'lead', CHANNEL);
  const first = await clientMsgIdForKey(key);
  const second = await clientMsgIdForKey(key);
  assert.equal(first, second, 'the same case must produce the same client_msg_id');
  assertUuidV5(first, 'case-uuid');

  const other = await clientMsgIdForKey(idempotencyKey('case-uuid-2', 'lead', CHANNEL));
  assert.notEqual(first, other, 'a different case must produce a different client_msg_id');
  assert.notEqual(
    await clientMsgIdForKey(idempotencyKey('case-uuid', 'lead', BOARD)),
    first,
    'the same case in another channel must be distinct',
  );
});

test('a case already recorded in the local ledger is skipped without a second post', async () => {
  const { calls, fetchImpl } = mockFetch();
  const { tokens, meta } = fixtureTokens();
  const ledger = {
    [idempotencyKey('case-repeat', 'lead', CHANNEL)]: {
      ts: '1758900000.000100',
      channel: CHANNEL,
      permalink: `https://rein-test.slack.com/archives/${CHANNEL}/p1758900000000100`,
      sentAt: '2026-09-26T12:00:00.000Z',
      account: 'lead',
    },
  };

  const { value, out } = await captureConsole(() =>
    runSend({ accountId: 'lead', channelId: CHANNEL, caseKey: 'case-repeat', text: 'repeat probe' }, { tokens, meta, fetchImpl, ledger }),
  );

  assert.equal(value, 0);
  assert.equal(calls.length, 0, 'a repeat must not touch Slack at all');
  assert.match(out, /already ran/);
  assert.match(out, /skipping/);
});

test('the ledger is not consulted when skipIfSent is false', async () => {
  const { calls, fetchImpl } = mockFetch();
  const { tokens, meta } = fixtureTokens();
  const ledger = { [idempotencyKey('case-force', 'lead', CHANNEL)]: { ts: '1', sentAt: '2026-01-01T00:00:00Z' } };
  const { value } = await captureConsole(() =>
    runSend(
      { accountId: 'lead', channelId: CHANNEL, caseKey: 'case-force', text: 'force probe' },
      { tokens, meta, fetchImpl, ledger, skipIfSent: false },
    ),
  );
  assert.equal(value, 0);
  assert.equal(calls.filter(call => call.method === 'chat.postMessage').length, 1);
});

test('lookupLedger only matches the exact case, account and channel triple', () => {
  const ledger = { [idempotencyKey('case-x', 'lead', CHANNEL)]: { ts: '1' } };
  assert.ok(lookupLedger(ledger, 'case-x', 'lead', CHANNEL));
  assert.equal(lookupLedger(ledger, 'case-x', 'member', CHANNEL), null);
  assert.equal(lookupLedger(ledger, 'case-x', 'lead', BOARD), null);
  assert.equal(lookupLedger(ledger, 'case-y', 'lead', CHANNEL), null);
});

test('send without explicit text is refused before any Slack call', async () => {
  const { calls, fetchImpl } = mockFetch();
  const { tokens, meta } = fixtureTokens();
  await assert.rejects(
    () => runSend({ accountId: 'lead', channelId: CHANNEL, caseKey: 'case-no-text' }, { tokens, meta, fetchImpl, ledger: EMPTY_LEDGER }),
    error => error.code === 'text-required',
  );
  assert.equal(calls.length, 0, 'a generic send must not reach Slack');
});

test('the placeholder body is only used with the explicit opt-in', async () => {
  const { calls, fetchImpl } = mockFetch();
  const { tokens, meta } = fixtureTokens();
  const { value } = await captureConsole(() =>
    runSend(
      { accountId: 'lead', channelId: CHANNEL, caseKey: 'case-placeholder', allowDefaultText: true },
      { tokens, meta, fetchImpl, ledger: EMPTY_LEDGER },
    ),
  );
  assert.equal(value, 0);
  const post = calls.find(call => call.method === 'chat.postMessage');
  assert.ok(post, 'the opt-in path posts');
  assert.match(post.init.body.get('text'), /case-placeholder/);
  assert.match(post.init.body.get('text'), new RegExp(`<@${MENTION}>`));
});

test('token freshness allows unknown expiry but refuses the safety window', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  assert.equal(assessTokenFreshness({}, 'lead', { now }).usable, true, 'no expiry recorded is usable');

  const soon = new Date(now + 30_000).toISOString();
  assert.equal(assessTokenFreshness({ accounts: { lead: { expiresAt: soon } } }, 'lead', { now }).code, 'token-expired');

  const later = new Date(now + 3_600_000).toISOString();
  assert.equal(assessTokenFreshness({ accounts: { lead: { expiresAt: later } } }, 'lead', { now }).usable, true);

  assert.throws(
    () => assertTokenFresh({ accounts: { lead: { expiresAt: '2020-01-01T00:00:00Z' } } }, 'lead', { now }),
    error => error.code === 'token-expired',
  );
});

test('channel allowlist and case-key validation are strict', () => {
  assert.equal(assertAllowedChannel(CHANNEL).id, CHANNEL);
  assert.equal(assertAllowedChannel(BOARD).label, 'board');
  assert.equal(assertAllowedChannel(CHANNEL.toLowerCase()).id, CHANNEL, 'ids are case-insensitive');
  for (const bad of ['C0PRODUCTION', 'general', '', 'D0123456789']) {
    assert.throws(() => assertAllowedChannel(bad), error => error.code === 'channel-not-allowed');
  }
  assert.equal(assertCaseKey('case-01'), 'case-01');
  for (const bad of ['short', 'has space', '', 'a'.repeat(129)]) {
    assert.throws(() => assertCaseKey(bad), error => error.code === 'invalid-case-key');
  }
});

test('token store reads flat keys, ignores the meta block, and rejects bot tokens', () => {
  const { tokens, meta } = readJsonTokenDoc({
    REIN_SLACK_USER_TOKEN_LEAD: TOKEN('lead'),
    REIN_SLACK_USER_TOKEN_MEMBER: TOKEN('member'),
    SLACK_USER_TOKEN_DIR1: TOKEN('dir1'),
    REIN_SLACK_USER_TOKEN_DIR2: 'xoxb-not-a-user-token',
    meta: { accounts: { lead: { expiresAt: '2030-01-01T00:00:00Z' } } },
  });
  assert.equal(tokens.get('lead'), TOKEN('lead'));
  assert.equal(tokens.get('member'), TOKEN('member'));
  assert.equal(tokens.get('dir1'), TOKEN('dir1'), 'the SLACK_USER_TOKEN_* alias is accepted');
  assert.equal(tokens.has('dir2'), false, 'a bot token is never accepted as a user token');
  assert.equal(meta.accounts.lead.expiresAt, '2030-01-01T00:00:00Z');
});

test('loadUserTokens reads the helper JSON file and reports missing accounts without values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rein-slack-tokens-'));
  try {
    const path = join(dir, 'slack-test-tokens.json');
    const doc = {};
    for (const identity of SLACK_TEST_IDENTITIES) doc[identity.json] = TOKEN(identity.id);
    doc.meta = { asOf: '2026-09-26T00:00:00Z', accounts: { lead: { userId: LEAD.expectedUserId } } };
    writeFileSync(path, JSON.stringify(doc), { mode: 0o600 });

    const loaded = loadUserTokens({ env: {}, paths: [path] });
    for (const identity of SLACK_TEST_IDENTITIES) assert.equal(loaded.tokens.get(identity.id), TOKEN(identity.id));
    assert.equal(loaded.meta.accounts.lead.userId, LEAD.expectedUserId);

    const partial = join(dir, 'partial.json');
    writeFileSync(partial, JSON.stringify({ REIN_SLACK_USER_TOKEN_LEAD: TOKEN('lead') }), { mode: 0o600 });
    assert.throws(
      () => loadUserTokens({ env: {}, paths: [partial] }),
      error => {
        assert.equal(error.code, 'missing-tokens');
        assert.match(error.message, /member/);
        assert.ok(!error.message.includes(TOKEN('lead')), 'the error must not include token values');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a nested accounts wrapper is accepted as a compatibility fallback', () => {
  const { tokens } = readJsonTokenDoc({
    accounts: { lead: { accessToken: TOKEN('lead') }, member: TOKEN('member') },
  });
  assert.equal(tokens.get('lead'), TOKEN('lead'));
  assert.equal(tokens.get('member'), TOKEN('member'));
});

test('all five identities verify when every token and mapping matches', async () => {
  const { fetchImpl, calls } = mockFetch();
  const { tokens } = fixtureTokens();
  const verified = await verifyAllIdentities(tokens, { fetchImpl });
  assert.equal(verified.size, 5);
  assert.equal(verified.get('lead').userId, LEAD.expectedUserId);
  assert.equal(verified.get('dir3').userId, SLACK_TEST_IDENTITIES[4].expectedUserId);
  assert.equal(calls.filter(call => call.method === 'auth.test').length, 5);
  assert.equal(calls.filter(call => call.method === 'chat.postMessage').length, 0);
});

test('an auth failure is reported without echoing the token', async () => {
  const { fetchImpl } = mockFetch({ authOk: false });
  const { tokens } = fixtureTokens();
  await assert.rejects(
    () => verifyAllIdentities(tokens, { fetchImpl }),
    error => {
      assert.equal(error.code, 'auth-failed');
      assert.ok(!error.message.includes(TOKEN('lead')));
      return true;
    },
  );
});

test('redaction removes any accidental token echo', () => {
  const text = redactTokens(`failed with ${TOKEN('lead')} and xoxp-1234567890-abcd`);
  assert.ok(!text.includes('xoxp-'));
  assert.match(text, /\[redacted-user-token\]/);
});

test('a bot identity reported by auth.test is refused', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = String(url).split('/api/')[1];
    calls.push({ method, init });
    if (method === 'auth.test') {
      return {
        status: 200,
        json: async () => ({
          ok: true,
          team_id: SLACK_TEST_TEAM_ID,
          user_id: LEAD.expectedUserId,
          user: 'lead',
          bot_id: 'B0BOT',
        }),
      };
    }
    return { status: 200, json: async () => ({ ok: false, error: 'unknown_method' }) };
  };
  const { tokens } = fixtureTokens();
  await assert.rejects(
    () => verifyAllIdentities(tokens, { fetchImpl }),
    error => error.code === 'bot-token',
  );
});

test('the five required identities are unchanged and guest is optional with no hardcoded id', () => {
  assert.deepEqual(
    SLACK_TEST_IDENTITIES.map(i => i.id),
    ['lead', 'member', 'dir1', 'dir2', 'dir3'],
    'the five required identities must not change',
  );
  assert.deepEqual(SLACK_TEST_OPTIONAL_IDENTITIES.map(i => i.id), ['guest']);
  const guest = SLACK_TEST_OPTIONAL_IDENTITIES[0];
  assert.equal(guest.expectedUserId, undefined, 'the optional id must not be hardcoded');
  assert.equal(guest.idEnv, 'SLACK_USER_ID_GUEST');
  assert.equal(guest.env, 'SLACK_USER_TOKEN_GUEST');
});

test('guest is enrolled only when its user id is configured, and default stays at five', () => {
  assert.deepEqual(activeIdentities({ env: {} }).map(i => i.id), ['lead', 'member', 'dir1', 'dir2', 'dir3']);
  const enrolled = activeIdentities({ env: { SLACK_USER_ID_GUEST: 'U0ABCDEF123' } });
  assert.deepEqual(enrolled.map(i => i.id), ['lead', 'member', 'dir1', 'dir2', 'dir3', 'guest']);
  assert.equal(enrolled.at(-1).expectedUserId, 'U0ABCDEF123');
  // A token-shaped or malformed id must not enroll the account, and must never be echoed as an id.
  assert.deepEqual(activeIdentities({ env: { SLACK_USER_ID_GUEST: 'xoxp-secret' } }).map(i => i.id), ['lead', 'member', 'dir1', 'dir2', 'dir3']);
  assert.deepEqual(resolveOptionalIdentities({ env: { SLACK_USER_ID_GUEST: 'nope' } }), []);
});

test('guest verifies through auth.test with its configured id and never leaks its token', async () => {
  const guestId = 'U0ABCDEF123';
  const tokens = new Map([...SLACK_TEST_IDENTITIES.map(i => [i.id, TOKEN(i.id)]), ['guest', TOKEN('guest')]]);
  const identities = activeIdentities({ env: { SLACK_USER_ID_GUEST: guestId } });
  const { fetchImpl, calls } = mockFetch({ identities });
  const verified = await verifyAllIdentities(tokens, { fetchImpl, identities });
  assert.equal(verified.get('guest').userId, guestId);
  assert.equal(calls.filter(call => call.method === 'auth.test').length, 6);
  for (const [, token] of tokens) assert.ok(!JSON.stringify([...verified.values()]).includes(token));
});

test('guest is refused when the token resolves to a different user', async () => {
  const tokens = new Map([...SLACK_TEST_IDENTITIES.map(i => [i.id, TOKEN(i.id)]), ['guest', TOKEN('guest')]]);
  const identities = activeIdentities({ env: { SLACK_USER_ID_GUEST: 'U0ABCDEF123' } });
  const { fetchImpl } = mockFetch({ identities, authUser: { guest: 'U0DIFFERENT1' } });
  await assert.rejects(
    verifyAllIdentities(tokens, { fetchImpl, identities }),
    error => error instanceof HarnessError && error.code === 'user-mismatch',
  );
});

test('an enrolled guest without a token is a missing-tokens error, not a silent skip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rein-slack-guest-'));
  try {
    const path = join(dir, 'slack-test-tokens.json');
    const doc = {};
    for (const identity of SLACK_TEST_IDENTITIES) doc[identity.json] = TOKEN(identity.id);
    writeFileSync(path, JSON.stringify(doc), { mode: 0o600 });
    assert.throws(
      () => loadUserTokens({ env: { SLACK_USER_ID_GUEST: 'U0ABCDEF123' }, paths: [path] }),
      error => {
        assert.equal(error.code, 'missing-tokens');
        assert.match(error.message, /guest/);
        return true;
      },
    );
    // The same file loads cleanly when the optional account is not enrolled.
    const loaded = loadUserTokens({ env: {}, paths: [path] });
    assert.equal(loaded.tokens.has('guest'), false);
    assert.equal(loaded.tokens.size, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an optional guest token key in the document is recognised without enrolling the account', () => {
  const doc = {};
  for (const identity of SLACK_TEST_IDENTITIES) doc[identity.json] = TOKEN(identity.id);
  doc.REIN_SLACK_USER_TOKEN_GUEST = TOKEN('guest');
  const { tokens } = readJsonTokenDoc(doc);
  assert.equal(tokens.get('guest'), TOKEN('guest'));
  // Recognition of the token key does not enroll the identity; enrolment needs the configured id.
  assert.deepEqual(activeIdentities({ env: {} }).map(i => i.id), ['lead', 'member', 'dir1', 'dir2', 'dir3']);
});
