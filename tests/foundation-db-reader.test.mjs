import test from 'node:test';
import assert from 'node:assert/strict';
import { createFoundationDbReader } from '../plugins/rein-operations/foundation-db-reader.ts';

// Fake-transport tests for the server-side Supabase reader. No live database is contacted: every
// request goes to an injected fetch that records the exact URL, query parameters and headers.

const SECRET = 'sb_secret_test_0000000000000000000000';
const BASE_URL = 'https://project-ref.supabase.co';
const TEAM = 'T0123456ABC';
const USER = 'U0123456ABC';
const CONTACT = '11111111-1111-4111-8111-111111111111';
const CONTRIBUTOR = '22222222-2222-4222-8222-222222222222';
const OTHER_CONTACT = '99999999-9999-4999-8999-999999999999';
const VERIFIED_AT = '2026-09-20T00:00:00+00:00';

function createFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace(/^\/rest\/v1\//, '');
    calls.push({ url, table, params: parsed.searchParams, init });
    const handler = handlers[table];
    if (handler === undefined) throw new Error(`unexpected request for ${table}`);
    const value = typeof handler === 'function' ? handler(parsed.searchParams, init) : handler;
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

function readerFor(handlers, config = {}) {
  const { fetchImpl, calls } = createFetch(handlers);
  const reader = createFoundationDbReader({
    supabaseUrl: BASE_URL,
    serviceRoleKey: SECRET,
    environment: 'dev',
    slackTeamId: TEAM,
    fetch: fetchImpl,
    ...config,
  });
  return { reader, calls };
}

const linkRow = (overrides = {}) => ({
  slack_team_id: TEAM,
  slack_user_id: USER,
  contact_id: CONTACT,
  status: 'verified',
  verified_at: VERIFIED_AT,
  verified_by: 'ops@rein.example',
  revoked_at: null,
  ...overrides,
});

const linkedHandlers = (overrides = {}) => ({
  dev_rein_slack_links: [linkRow()],
  dev_community_contacts: [{ id: CONTACT }],
  dev_contributors: [{ id: CONTRIBUTOR, contact_id: CONTACT, status: 'active' }],
  dev_people: [{ contact_id: CONTACT, contributor_id: CONTRIBUTOR, person_type: 'director' }],
  ...overrides,
});

const closedMember = (status, reason) => ({
  status,
  reason,
  contactId: null,
  isActiveContributor: false,
  isDirector: false,
  httpStatus: null,
});

test('a verified link resolves to the canonical contact, an active Contributor and a director', async () => {
  const { reader, calls } = readerFor(linkedHandlers());

  const result = await reader.resolveSlackMember(USER);

  assert.deepEqual(result, {
    status: 'resolved',
    reason: 'resolved',
    contactId: CONTACT,
    isActiveContributor: true,
    isDirector: true,
    httpStatus: null,
  });
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.deepEqual(
    calls.map(call => call.table),
    ['dev_rein_slack_links', 'dev_community_contacts', 'dev_contributors', 'dev_people'],
  );
  for (const call of calls) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.body, undefined);
    assert.equal(call.init.headers.apikey, SECRET);
    assert.equal(call.init.headers.authorization, `Bearer ${SECRET}`);
    assert.ok(call.url.startsWith(`${BASE_URL}/rest/v1/dev_`), call.url);
    assert.ok(!call.url.includes(SECRET));
  }
  assert.equal(calls[0].params.get('slack_team_id'), `eq.${TEAM}`);
  assert.equal(calls[0].params.get('slack_user_id'), `eq.${USER}`);
  assert.equal(
    calls[0].params.get('select'),
    'slack_team_id,slack_user_id,contact_id,status,verified_at,verified_by,revoked_at',
  );
  assert.equal(calls[3].params.get('or'), `(contact_id.eq.${CONTACT},contributor_id.eq.${CONTRIBUTOR})`);
});

test('the production environment reads the prod_ tables', async () => {
  const { reader, calls } = readerFor(
    {
      prod_rein_slack_links: [linkRow()],
      prod_community_contacts: [{ id: CONTACT }],
      prod_contributors: [{ id: CONTRIBUTOR, contact_id: CONTACT, status: 'active' }],
      prod_people: [{ contact_id: CONTACT, contributor_id: null, person_type: 'core_contributor' }],
    },
    { environment: 'prod' },
  );

  const result = await reader.resolveSlackMember(USER);

  assert.equal(reader.tablePrefix, 'prod_');
  assert.equal(result.status, 'resolved');
  assert.equal(result.isActiveContributor, true);
  assert.equal(result.isDirector, false);
  assert.ok(calls.every(call => call.url.includes('/rest/v1/prod_')), 'every request uses the prod_ prefix');
});

test('an unlinked Slack account fails closed before any member record is read', async () => {
  const { reader, calls } = readerFor({ dev_rein_slack_links: [] });

  const result = await reader.resolveSlackMember(USER);

  assert.deepEqual(result, closedMember('identity_not_linked', 'identity_not_linked'));
  assert.equal(calls.length, 1);
});

test('duplicate links for one Slack account are ambiguous and resolve to nothing', async () => {
  const { reader } = readerFor(linkedHandlers({ dev_rein_slack_links: [linkRow(), linkRow()] }));

  const result = await reader.resolveSlackMember(USER);

  assert.equal(result.status, 'identity_link_ambiguous');
  assert.equal(result.contactId, null);
  assert.equal(result.isActiveContributor, false);
  assert.equal(result.isDirector, false);
});

test('a revoked link resolves to nothing even though it keeps its verification record', async () => {
  const { reader, calls } = readerFor(
    linkedHandlers({
      dev_rein_slack_links: [linkRow({ status: 'revoked', revoked_at: '2026-09-21T00:00:00+00:00' })],
    }),
  );

  const result = await reader.resolveSlackMember(USER);

  assert.deepEqual(result, closedMember('identity_link_revoked', 'identity_link_revoked'));
  assert.equal(calls.length, 1);
});

test('a malformed link row fails closed with a specific reason', async (t) => {
  const cases = [
    ['a row for another Slack user', [linkRow({ slack_user_id: 'U9999999XYZ' })], 'link_row_out_of_scope'],
    ['a row with no contact id', [linkRow({ contact_id: null })], 'link_contact_id_malformed'],
    ['a contact id that is not a UUID', [linkRow({ contact_id: 'contact-1' })], 'link_contact_id_malformed'],
    ['an unknown status', [linkRow({ status: 'pending' })], 'link_status_malformed'],
    ['a verified row without verified_at', [linkRow({ verified_at: null })], 'link_verification_missing'],
    ['a verified row without verified_by', [linkRow({ verified_by: null })], 'link_verification_missing'],
    ['a verified row that also claims revoked_at', [linkRow({ revoked_at: VERIFIED_AT })], 'link_revoked_at_unexpected'],
    [
      'a revoked row without revoked_at',
      [linkRow({ status: 'revoked', revoked_at: null })],
      'link_revocation_missing',
    ],
    ['a row that is not an object', [null], 'link_row_malformed'],
  ];
  for (const [name, rows, reason] of cases) {
    await t.test(name, async () => {
      const { reader } = readerFor(linkedHandlers({ dev_rein_slack_links: rows }));
      const result = await reader.resolveSlackMember(USER);
      assert.equal(result.status, 'identity_link_malformed');
      assert.equal(result.reason, reason);
      assert.equal(result.contactId, null);
      assert.equal(result.isActiveContributor, false);
      assert.equal(result.isDirector, false);
    });
  }
});

test('a link whose canonical contact is absent or ambiguous fails closed', async (t) => {
  await t.test('absent contact', async () => {
    const { reader } = readerFor(linkedHandlers({ dev_community_contacts: [] }));
    const result = await reader.resolveSlackMember(USER);
    assert.equal(result.status, 'member_record_malformed');
    assert.equal(result.reason, 'contact_missing');
  });
  await t.test('two contact rows for one id', async () => {
    const { reader } = readerFor(linkedHandlers({ dev_community_contacts: [{ id: CONTACT }, { id: CONTACT }] }));
    const result = await reader.resolveSlackMember(USER);
    assert.equal(result.reason, 'contact_ambiguous');
  });
  await t.test('a contact row for a different id', async () => {
    const { reader } = readerFor(linkedHandlers({ dev_community_contacts: [{ id: OTHER_CONTACT }] }));
    const result = await reader.resolveSlackMember(USER);
    assert.equal(result.reason, 'contact_row_malformed');
  });
});

test('a member without a Contributor row still resolves, and director follows the contact link', async () => {
  const { reader, calls } = readerFor(
    linkedHandlers({
      dev_contributors: [],
      dev_people: [{ contact_id: CONTACT, contributor_id: null, person_type: 'director' }],
    }),
  );

  const result = await reader.resolveSlackMember(USER);

  assert.deepEqual(result, {
    status: 'resolved',
    reason: 'resolved',
    contactId: CONTACT,
    isActiveContributor: false,
    isDirector: true,
    httpStatus: null,
  });
  assert.equal(calls[3].params.get('or'), null);
  assert.equal(calls[3].params.get('contact_id'), `eq.${CONTACT}`);
});

test('an inactive Contributor is not active, while a director linked through the Contributor row still counts', async () => {
  const { reader, calls } = readerFor(
    linkedHandlers({
      dev_contributors: [{ id: CONTRIBUTOR, contact_id: CONTACT, status: 'inactive' }],
      dev_people: [{ contact_id: null, contributor_id: CONTRIBUTOR, person_type: 'director' }],
    }),
  );

  const result = await reader.resolveSlackMember(USER);

  assert.equal(result.status, 'resolved');
  assert.equal(result.isActiveContributor, false);
  assert.equal(result.isDirector, true);
  assert.equal(calls[3].params.get('or'), `(contact_id.eq.${CONTACT},contributor_id.eq.${CONTRIBUTOR})`);
});

test('director is derived from person_type only, never from free-text role or publication state', async () => {
  const { reader, calls } = readerFor(
    linkedHandlers({
      dev_people: [
        {
          contact_id: CONTACT,
          contributor_id: CONTRIBUTOR,
          person_type: 'core_contributor',
          role: 'Director',
          publication_status: 'published',
        },
      ],
    }),
  );

  const result = await reader.resolveSlackMember(USER);

  assert.equal(result.status, 'resolved');
  assert.equal(result.isDirector, false);
  assert.equal(result.isActiveContributor, true);
  assert.equal(calls[3].params.get('select'), 'contact_id,contributor_id,person_type');
});

test('malformed member records fail closed instead of downgrading silently', async (t) => {
  const cases = [
    [
      'an unknown Contributor status',
      { dev_contributors: [{ id: CONTRIBUTOR, contact_id: CONTACT, status: 'pending' }] },
      'contributor_status_malformed',
    ],
    [
      'a Contributor row bound to another contact',
      { dev_contributors: [{ id: CONTRIBUTOR, contact_id: OTHER_CONTACT, status: 'active' }] },
      'contributor_contact_mismatch',
    ],
    [
      'two Contributor rows for one contact',
      {
        dev_contributors: [
          { id: CONTRIBUTOR, contact_id: CONTACT, status: 'active' },
          { id: CONTRIBUTOR, contact_id: CONTACT, status: 'active' },
        ],
      },
      'contributor_ambiguous',
    ],
    [
      'an unknown person_type',
      { dev_people: [{ contact_id: CONTACT, contributor_id: CONTRIBUTOR, person_type: 'staff' }] },
      'person_type_malformed',
    ],
    [
      'a person row outside the resolved member',
      { dev_people: [{ contact_id: OTHER_CONTACT, contributor_id: null, person_type: 'director' }] },
      'person_row_out_of_scope',
    ],
    [
      'a person row with a malformed identifier',
      { dev_people: [{ contact_id: 'nope', contributor_id: null, person_type: 'director' }] },
      'person_identifier_malformed',
    ],
    ['a person row that is not an object', { dev_people: [null] }, 'person_row_malformed'],
  ];
  for (const [name, overrides, reason] of cases) {
    await t.test(name, async () => {
      const { reader } = readerFor(linkedHandlers(overrides));
      const result = await reader.resolveSlackMember(USER);
      assert.equal(result.status, 'member_record_malformed');
      assert.equal(result.reason, reason);
      assert.equal(result.contactId, null);
      assert.equal(result.isDirector, false);
    });
  }
});

test('database failures resolve to an unavailable result rather than throwing or resolving', async (t) => {
  const cases = [
    ['a transport failure', () => { throw new Error('socket hang up'); }, 'transport_error', null],
    ['an unauthorized response', () => new Response('nope', { status: 401 }), 'http_error', 401],
    ['a body that is not JSON', () => new Response('<html>down</html>', { status: 200 }), 'response_malformed', 200],
    ['a JSON body that is not an array', () => new Response(JSON.stringify({ message: 'oops' }), { status: 200 }), 'response_malformed', 200],
  ];
  for (const [name, handler, reason, httpStatus] of cases) {
    await t.test(name, async () => {
      const { reader } = readerFor(linkedHandlers({ dev_rein_slack_links: handler }));
      const result = await reader.resolveSlackMember(USER);
      assert.equal(result.status, 'unavailable');
      assert.equal(result.reason, reason);
      assert.equal(result.httpStatus, httpStatus);
      assert.equal(result.contactId, null);
      assert.equal(result.isActiveContributor, false);
      assert.equal(result.isDirector, false);
      assert.ok(!JSON.stringify(result).includes(SECRET));
    });
  }
});

test('a Slack user ID outside the plain identifier form is rejected without querying the database', async () => {
  const { reader, calls } = readerFor({});

  for (const value of ['', '   ', 'U1,2', 'U1)or(1.eq.1', 'U'.repeat(80)]) {
    const result = await reader.resolveSlackMember(value);
    assert.deepEqual(result, closedMember('invalid_request', 'slack_user_id_invalid'));
  }
  const notAString = await reader.resolveSlackMember(42);
  assert.equal(notAString.status, 'invalid_request');
  assert.equal(calls.length, 0);
});

test('available funds read the newest human-entered snapshot as integer minor units', async () => {
  const { reader, calls } = readerFor({
    dev_rein_fund_snapshots: [
      {
        currency: 'USD',
        available_minor: 125000,
        recorded_at: '2026-09-23T18:00:00+00:00',
        recorded_by: 'finance@rein.example',
        source_note: 'Board allocation',
      },
    ],
  });

  const result = await reader.readAvailableFunds('USD');

  assert.deepEqual(result, {
    status: 'snapshot',
    reason: 'snapshot',
    currency: 'USD',
    availableMinor: 125000,
    recordedAt: '2026-09-23T18:00:00+00:00',
    recordedBy: 'finance@rein.example',
    sourceNote: 'Board allocation',
    httpStatus: null,
    authorizesSpending: false,
  });
  const call = calls[0];
  assert.equal(call.table, 'dev_rein_fund_snapshots');
  assert.equal(call.init.method, 'GET');
  assert.equal(call.params.get('currency'), 'eq.USD');
  assert.equal(call.params.get('order'), 'recorded_at.desc,created_at.desc');
  assert.equal(call.params.get('limit'), '1');
  assert.equal(call.params.get('select'), 'currency,available_minor,recorded_at,recorded_by,source_note');
});

test('a currency with no recorded snapshot is an explicit unknown, not a number', async () => {
  const { reader } = readerFor({ dev_rein_fund_snapshots: [] });

  const result = await reader.readAvailableFunds('USD');

  assert.deepEqual(result, {
    status: 'unknown',
    reason: 'no_snapshot',
    currency: 'USD',
    availableMinor: null,
    recordedAt: null,
    recordedBy: null,
    sourceNote: null,
    httpStatus: null,
    authorizesSpending: false,
  });
});

test('a malformed funds snapshot is unknown rather than a usable amount', async (t) => {
  const snapshot = (overrides = {}) => ({
    currency: 'USD',
    available_minor: 125000,
    recorded_at: '2026-09-23T18:00:00+00:00',
    recorded_by: 'finance@rein.example',
    source_note: null,
    ...overrides,
  });
  const cases = [
    ['a negative amount', [snapshot({ available_minor: -1 })], 'snapshot_amount_malformed'],
    ['a string amount', [snapshot({ available_minor: '125000' })], 'snapshot_amount_malformed'],
    ['a fractional amount', [snapshot({ available_minor: 12.5 })], 'snapshot_amount_malformed'],
    ['a missing amount', [snapshot({ available_minor: null })], 'snapshot_amount_malformed'],
    ['a currency mismatch', [snapshot({ currency: 'EUR' })], 'snapshot_currency_mismatch'],
    ['an unparseable recorded_at', [snapshot({ recorded_at: 'yesterday' })], 'snapshot_recorded_at_malformed'],
    ['an empty recorded_by', [snapshot({ recorded_by: '' })], 'snapshot_recorded_by_missing'],
    ['a non-text source_note', [snapshot({ source_note: 42 })], 'snapshot_source_note_malformed'],
    ['a row that is not an object', [null], 'snapshot_malformed'],
  ];
  for (const [name, rows, reason] of cases) {
    await t.test(name, async () => {
      const { reader } = readerFor({ dev_rein_fund_snapshots: rows });
      const result = await reader.readAvailableFunds('USD');
      assert.equal(result.status, 'unknown');
      assert.equal(result.reason, reason);
      assert.equal(result.availableMinor, null);
      assert.equal(result.authorizesSpending, false);
    });
  }
});

test('a funds provider failure is unavailable and never carries an amount', async () => {
  const { reader } = readerFor({
    dev_rein_fund_snapshots: () => new Response('server error', { status: 503 }),
  });

  const result = await reader.readAvailableFunds('USD');

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'http_error');
  assert.equal(result.httpStatus, 503);
  assert.equal(result.availableMinor, null);
  assert.equal(result.recordedAt, null);
  assert.equal(result.authorizesSpending, false);
});

test('an unsupported currency is rejected without querying the database', async () => {
  const { reader, calls } = readerFor({});

  for (const value of ['usd', 'US', 'USDX', '', 'US$']) {
    const result = await reader.readAvailableFunds(value);
    assert.equal(result.status, 'invalid_request');
    assert.equal(result.reason, 'currency_invalid');
    assert.equal(result.availableMinor, null);
  }
  assert.equal(calls.length, 0);
});

test('invalid reader configuration is rejected at construction without echoing the key', () => {
  const base = {
    supabaseUrl: BASE_URL,
    serviceRoleKey: SECRET,
    environment: 'dev',
    slackTeamId: TEAM,
    fetch: async () => new Response('[]'),
  };
  const attempts = [
    [{ ...base, serviceRoleKey: '' }, 'serviceRoleKey is required'],
    [{ ...base, supabaseUrl: '' }, 'supabaseUrl is required'],
    [{ ...base, supabaseUrl: 'not a url' }, 'absolute URL'],
    [{ ...base, supabaseUrl: 'ftp://project-ref.supabase.co' }, 'http or https'],
    [{ ...base, supabaseUrl: 'https://user:pass@project-ref.supabase.co' }, 'bare project URL'],
    [{ ...base, supabaseUrl: `${BASE_URL}/rest/v1/?x=1` }, 'bare project URL'],
    [{ ...base, environment: 'staging' }, "environment must be 'dev' or 'prod'"],
    [{ ...base, slackTeamId: '' }, 'slackTeamId'],
    [{ ...base, slackTeamId: 'not a team id' }, 'slackTeamId'],
    [{ ...base, fetch: 'not a function' }, 'fetch implementation is required'],
  ];
  for (const [config, expected] of attempts) {
    let error = null;
    try {
      createFoundationDbReader(config);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error, `expected construction to be rejected: ${expected}`);
    assert.match(error.message, new RegExp(expected));
    assert.ok(!error.message.includes(SECRET), 'the configuration error never echoes the key');
    assert.ok(!error.message.includes('sb_secret'), 'the configuration error never echoes the key');
  }
});

test('the reader exposes only the configured environment and its two read operations', () => {
  const { reader } = readerFor({});

  assert.equal(reader.environment, 'dev');
  assert.equal(reader.tablePrefix, 'dev_');
  assert.deepEqual(Object.keys(reader).sort(), ['environment', 'readAvailableFunds', 'resolveSlackMember', 'tablePrefix']);
  assert.ok(Object.isFrozen(reader));
});
