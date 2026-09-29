import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSlackEmailLookup,
  normalizeEmailAddress,
  SLACK_USERS_INFO_URL,
} from '../plugins/rein-operations/slack-email-lookup.ts';

// Fake-transport tests for the optional Slack email lookup. No live Slack call is made: every
// request goes to an injected fetch that records the exact URL and headers.

// Shaped like a bot token but synthetic: it is not a credential, and every test asserts it never
// leaves the Authorization header.
const TOKEN = 'xoxb-test-000000000000000000000000';
const TEAM = 'T0123456ABC';
const USER = 'U0123456ABC';

function lookupFor(handler, config = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const value = typeof handler === 'function' ? handler(url, init) : handler;
    if (value instanceof Error) throw value;
    return value;
  };
  const lookup = createSlackEmailLookup({
    botToken: TOKEN,
    slackTeamId: TEAM,
    fetch: fetchImpl,
    ...config,
  });
  return { lookup, calls };
}

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const profile = (overrides = {}) => ({
  ok: true,
  user: {
    id: USER,
    team_id: TEAM,
    deleted: false,
    is_bot: false,
    profile: { email: 'Member@Rein.Example' },
    ...overrides,
  },
});

test('a human profile resolves to a normalized address and keeps the token in the header only', async () => {
  const { lookup, calls } = lookupFor(jsonResponse(profile()));

  const result = await lookup.lookupEmail(USER);

  assert.deepEqual(result, {
    status: 'found',
    reason: 'found',
    normalizedEmail: 'member@rein.example',
    httpStatus: null,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!calls[0].url.includes(TOKEN), 'the token never appears in a URL');
  assert.ok(calls[0].url.startsWith(`${SLACK_USERS_INFO_URL}?`), calls[0].url);
  assert.equal(new URL(calls[0].url).searchParams.get('user'), USER);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('a trimmed and padded address is normalized the way the database stores it', async () => {
  const { lookup } = lookupFor(jsonResponse(profile({ profile: { email: '  Member@Rein.Example  ' } })));

  const result = await lookup.lookupEmail(USER);

  assert.equal(result.status, 'found');
  assert.equal(result.normalizedEmail, 'member@rein.example');
});

test('a deleted account fails closed without an address', async () => {
  const { lookup } = lookupFor(jsonResponse(profile({ deleted: true })));

  const result = await lookup.lookupEmail(USER);

  assert.deepEqual(result, {
    status: 'deleted',
    reason: 'user_deleted',
    normalizedEmail: null,
    httpStatus: 200,
  });
});

test('a bot or app account is never a human identity, whatever address it publishes', async () => {
  for (const overrides of [{ is_bot: true }, { is_app_user: true }]) {
    const { lookup } = lookupFor(jsonResponse(profile(overrides)));
    const result = await lookup.lookupEmail(USER);
    assert.equal(result.status, 'not_human');
    assert.equal(result.reason, 'user_not_human');
    assert.equal(result.normalizedEmail, null);
  }
});

test('a profile from another workspace fails closed instead of matching this team', async () => {
  const { lookup } = lookupFor(jsonResponse(profile({ team_id: 'T9999999XYZ' })));

  const result = await lookup.lookupEmail(USER);

  assert.deepEqual(result, {
    status: 'wrong_team',
    reason: 'team_mismatch',
    normalizedEmail: null,
    httpStatus: 200,
  });
});

test('a missing or unusable address fails closed as a fixed reason, never as an empty match', async () => {
  const cases = [
    ['a profile without the email key', profile({ profile: {} })],
    ['a blank address', profile({ profile: { email: '   ' } })],
    ['an address with no domain', profile({ profile: { email: 'member@' } })],
    ['an address with a filter separator', profile({ profile: { email: 'member,other@rein.example' } })],
    ['a non-string address', profile({ profile: { email: 42 } })],
  ];
  for (const [name, payload] of cases) {
    const { lookup } = lookupFor(jsonResponse(payload));
    const result = await lookup.lookupEmail(USER);
    assert.equal(result.status, 'no_email', name);
    assert.equal(result.reason, 'email_missing', name);
    assert.equal(result.normalizedEmail, null, name);
  }
});

test('a provider failure is a fixed reason and never echoes provider text', async () => {
  const cases = [
    ['user_not_found', 'not_found', 'user_not_found'],
    ['user_not_visible', 'not_found', 'user_not_found'],
    ['user_deleted', 'deleted', 'user_deleted'],
    ['invalid_auth', 'unavailable', 'auth_error'],
    ['missing_scope', 'unavailable', 'auth_error'],
    ['token_revoked', 'unavailable', 'auth_error'],
    ['some_new_error', 'unavailable', 'slack_error'],
  ];
  for (const [error, status, reason] of cases) {
    const { lookup } = lookupFor(jsonResponse({ ok: false, error }));
    const result = await lookup.lookupEmail(USER);
    assert.equal(result.status, status, error);
    assert.equal(result.reason, reason, error);
    assert.equal(result.normalizedEmail, null, error);
  }
  // An error code this module has never seen is still mapped to a fixed reason rather than echoed.
  const novel = lookupFor(jsonResponse({ ok: false, error: 'brand_new_provider_text' }));
  const result = await novel.lookup.lookupEmail(USER);
  assert.equal(result.reason, 'slack_error');
  assert.ok(!JSON.stringify(result).includes('brand_new_provider_text'));
});

test('a provider error that carries a token-shaped string still comes back as a fixed reason', async () => {
  const { lookup } = lookupFor(jsonResponse({ ok: false, error: TOKEN }));

  const result = await lookup.lookupEmail(USER);

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'slack_error');
  assert.ok(!JSON.stringify(result).includes(TOKEN), 'a token in provider text never reaches the caller');
});

test('an HTTP failure carries its status and separates a rejected token from a server error', async () => {
  const cases = [
    [new Response('nope', { status: 401 }), 'auth_error', 401],
    [new Response('nope', { status: 403 }), 'auth_error', 403],
    [new Response('nope', { status: 500 }), 'http_error', 500],
  ];
  for (const [response, reason, httpStatus] of cases) {
    const { lookup } = lookupFor(response);
    const result = await lookup.lookupEmail(USER);
    assert.equal(result.status, 'unavailable', reason);
    assert.equal(result.reason, reason);
    assert.equal(result.httpStatus, httpStatus);
  }
});

test('a transport failure and a malformed body fail closed rather than throwing', async () => {
  const calls = [];
  const transport = createSlackEmailLookup({
    botToken: TOKEN,
    slackTeamId: TEAM,
    fetch: async (url, init) => {
      calls.push({ url, init });
      throw new Error('socket hang up');
    },
  });
  assert.deepEqual(await transport.lookupEmail(USER), {
    status: 'unavailable',
    reason: 'transport_error',
    normalizedEmail: null,
    httpStatus: null,
  });

  const notJson = lookupFor(new Response('<html>slow down</html>', { status: 200 }));
  assert.equal((await notJson.lookup.lookupEmail(USER)).reason, 'response_malformed');

  const notAnObject = lookupFor(new Response(JSON.stringify([{ user: {} }]), { status: 200 }));
  assert.equal((await notAnObject.lookup.lookupEmail(USER)).reason, 'response_malformed');

  const noUser = lookupFor(jsonResponse({ ok: true }));
  assert.equal((await noUser.lookup.lookupEmail(USER)).reason, 'response_malformed');
});

test('a Slack user ID outside the plain identifier form is rejected without a call', async () => {
  const { lookup, calls } = lookupFor(jsonResponse(profile()));

  for (const value of ['', '   ', 'U1,2', 'U1)or(1.eq.1', 'U'.repeat(80)]) {
    const result = await lookup.lookupEmail(value);
    assert.deepEqual(result, {
      status: 'invalid_request',
      reason: 'slack_user_id_invalid',
      normalizedEmail: null,
      httpStatus: null,
    });
  }
  const notAString = await lookup.lookupEmail(42);
  assert.equal(notAString.status, 'invalid_request');
  assert.equal(calls.length, 0);
});

test('invalid lookup configuration is rejected at construction without echoing the token', () => {
  const attempts = [
    [{ botToken: '' }, 'botToken is required'],
    [{ botToken: '   ' }, 'botToken is required'],
    [{ botToken: TOKEN, slackTeamId: '' }, 'slackTeamId'],
    [{ botToken: TOKEN, slackTeamId: 'not a team id' }, 'slackTeamId'],
    [{ botToken: TOKEN, slackTeamId: TEAM, timeoutMs: 0 }, 'timeoutMs'],
    [{ botToken: TOKEN, slackTeamId: TEAM, timeoutMs: 1.5 }, 'timeoutMs'],
    [{ botToken: TOKEN, slackTeamId: TEAM, fetch: 'not a function' }, 'fetch implementation is required'],
  ];
  for (const [config, expected] of attempts) {
    let error = null;
    try {
      createSlackEmailLookup(config);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error, `expected construction to be rejected: ${expected}`);
    assert.match(error.message, new RegExp(expected));
    assert.ok(!error.message.includes(TOKEN), 'the configuration error never echoes the token');
  }
});

test('the lookup is frozen and normalizeEmailAddress matches the database normalization', () => {
  const { lookup } = lookupFor(jsonResponse(profile()));

  assert.ok(Object.isFrozen(lookup));
  assert.deepEqual(Object.keys(lookup), ['lookupEmail']);

  assert.equal(normalizeEmailAddress('  Member@Rein.Example '), 'member@rein.example');
  assert.equal(normalizeEmailAddress('first.last+tag@sub.rein.example'), 'first.last+tag@sub.rein.example');
  for (const value of ['', '   ', 'member', 'member@', '@rein.example', 'member@rein', 'a,b@rein.example', 42, null]) {
    assert.equal(normalizeEmailAddress(value), null, String(value));
  }
  assert.equal(normalizeEmailAddress(`${'a'.repeat(250)}@rein.example`), null);
});
