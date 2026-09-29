import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MVP_COLLECT_TOOL_NAMES,
  MAX_COLLECT_TOKEN_LENGTH,
  COLLECT_TTL_MS,
  createMvpCollectToolRegistration,
} from '../plugins/rein-operations/mvp-collect-tools.ts';
import {
  COLLECT_TOKEN_CAP,
  MAX_DRAFT_DOCUMENT_BYTES,
  MAX_DRAFT_TOKEN_LENGTH,
  draftPreview,
  issueProposalDraft,
  verifyProposalDraft,
} from '../plugins/rein-operations/mvp-proposal-draft.ts';
import {
  issueProposalConfirmation,
  maxDocumentBytesForToken,
  verifyProposalConfirmation,
} from '../plugins/rein-operations/mvp-proposal-confirmation.ts';

// Focused fake-reader and fake-writer tests for `rein_proposal_collect`, the read-only multi-turn
// field-collection tool. No live database or Slack call is made. The fakes record every call, so each
// test also proves that the collection tool reached no write path, and the scripted reader/writer
// decides what the stored database would have answered.

const TEAM = 'T0123456ABC';
const PROPOSAL_CHANNEL = 'C_PROPOSAL';
const BOARD_CHANNEL = 'C_BOARD';
const SENDER = 'U0123456ABC';
const CONTACT = '11111111-1111-4111-8111-111111111111';
const OTHER_CONTACT = '22222222-2222-4222-8222-222222222222';
const VOTE_TYPE = 'event_budget';
const URL_ENV = 'REIN_SUPABASE_URL';
const KEY_ENV = 'REIN_SUPABASE_SERVICE_ROLE_KEY';
const CONFIRM_ENV = 'REIN_PROPOSAL_CONFIRMATION_KEY';
const SECRET = 'sb_secret_unit_test_0000000000000000';
const SIGNING_KEY = 'unit-test-proposal-draft-signing-key-0001';
const NOW = '2026-09-27T10:00:00.000Z';
const LATER = '2026-09-27T10:30:00.000Z';

const baseConfig = Object.freeze({
  enabled: true,
  platform: 'slack',
  slackTeamId: TEAM,
  environment: 'dev',
  proposalChannelIds: [PROPOSAL_CHANNEL],
  boardChannelIds: [BOARD_CHANNEL],
  supabaseUrlEnvVar: URL_ENV,
  supabaseServiceKeyEnvVar: KEY_ENV,
  proposalConfirmationKeyEnvVar: CONFIRM_ENV,
});

const contributor = (overrides = {}) => ({
  status: 'resolved',
  reason: 'resolved',
  contactId: CONTACT,
  isActiveContributor: true,
  isDirector: false,
  httpStatus: null,
  ...overrides,
});

function createFakes({
  member = contributor(),
  configuredVoteTypes = [VOTE_TYPE],
  proposals = [],
  reads,
} = {}) {
  const calls = { member: [], listVoteTypes: [], getProposal: [] };
  const reader = {
    async resolveSlackMember(slackUserId) {
      calls.member.push(slackUserId);
      return member;
    },
  };
  const writer = {
    async listVoteTypes(input = {}) {
      calls.listVoteTypes.push(input);
      if (reads?.listVoteTypes) return reads.listVoteTypes(input);
      return { ok: true, status: 'found', reason: 'vote_types', voteTypes: configuredVoteTypes, httpStatus: 200 };
    },
    async getProposal(id) {
      calls.getProposal.push(id);
      if (reads?.getProposal) return reads.getProposal(id);
      const found = proposals.find(proposal => proposal.id === id);
      if (!found) {
        return { ok: false, status: 'rejected', reason: 'proposal_not_found', proposal: null, httpStatus: 200 };
      }
      return { ok: true, status: 'found', reason: 'proposal', proposal: found, httpStatus: 200 };
    },
  };
  return { reader, writer, calls };
}

const CLOCK = { at: new Date(NOW) };

function build({
  config = baseConfig,
  fakes = createFakes(),
  ctx: overrides = {},
  channel = PROPOSAL_CHANNEL,
  now,
} = {}) {
  const guard = { calls: 0 };
  const ctx = {
    messageChannel: 'slack',
    nativeChannelId: channel,
    requesterSenderId: SENDER,
    assertInvocationCurrent() {
      guard.calls += 1;
    },
    ...overrides,
  };
  const registration = createMvpCollectToolRegistration({
    config,
    reader: fakes.reader,
    writer: fakes.writer,
    signingKey: SIGNING_KEY,
    now: now ?? (() => CLOCK.at),
  });
  const tools = registration.create(ctx);
  return {
    registration,
    tools,
    guard,
    ctx,
    calls: fakes.calls,
    tool: () => tools.find(item => item.name === 'rein_proposal_collect'),
  };
}

test('no collect tool registers without an explicit enabled block', () => {
  for (const config of [undefined, {}, { enabled: false }, { enabled: 'true' }]) {
    const fakes = createFakes();
    const registration = createMvpCollectToolRegistration({ config, reader: fakes.reader, writer: fakes.writer });
    assert.equal(registration.create({ messageChannel: 'slack' }), null);
    assert.equal(registration.contextVersion, 2);
  }
  assert.deepEqual([...MVP_COLLECT_TOOL_NAMES], ['rein_proposal_collect']);
});

test('an enabled but incomplete block fails loudly instead of registering silently', () => {
  const fakes = createFakes();
  const cases = [
    [{ ...baseConfig, platform: 'discord' }, /platform must be "slack"/],
    [{ ...baseConfig, slackTeamId: undefined }, /slackTeamId must be one Slack team ID/],
    [{ ...baseConfig, proposalChannelIds: [] }, /proposalChannelIds must list at least one/],
    [{ ...baseConfig, environment: 'staging' }, /environment must be 'dev' or 'prod'/],
    [{ ...baseConfig, supabaseUrlEnvVar: undefined }, /supabaseUrlEnvVar must name a server environment variable/],
  ];
  for (const [config, expected] of cases) {
    assert.throws(
      () => createMvpCollectToolRegistration({ config, reader: fakes.reader, writer: fakes.writer, signingKey: SIGNING_KEY }),
      expected,
    );
  }
  for (const missing of ['listVoteTypes', 'getProposal']) {
    const partial = { ...fakes.writer, [missing]: undefined };
    assert.throws(
      () =>
        createMvpCollectToolRegistration({
          config: baseConfig,
          reader: fakes.reader,
          writer: partial,
          signingKey: SIGNING_KEY,
        }),
      /must implement listVoteTypes and getProposal/,
      missing,
    );
  }
});

test('the signing key is read from the server environment and never appears in a result', async () => {
  assert.throws(
    () => createMvpCollectToolRegistration({ config: baseConfig, env: {} }),
    error => error.code === 'foundation_db_env_value_missing' && error.message.includes(URL_ENV),
  );
  assert.throws(
    () => createMvpCollectToolRegistration({ config: baseConfig, env: { [URL_ENV]: 'https://project-ref.supabase.co' } }),
    error => error.code === 'foundation_db_env_value_missing' && error.message.includes(KEY_ENV),
  );
  const built = build({ fakes: createFakes() });
  const result = await built.tool().execute('call-1', { title: 'September meetup' });
  assert.ok(!JSON.stringify(result.details).includes(SECRET), 'the service key must not appear');
  assert.ok(!JSON.stringify(result.details).includes(SIGNING_KEY), 'the signing key must not appear');
});

test('a vague first message reports the exact required gaps and writes nothing', async () => {
  const built = build({ fakes: createFakes() });
  const result = await built.tool().execute('call-1', { summary: 'community sharing session, about fifty people' });
  assert.equal(result.details.ok, true);
  assert.equal(result.details.status, 'collecting');
  assert.equal(result.details.recorded, false);
  assert.equal(result.details.submitted, false);
  assert.equal(result.details.authorizesSpending, false);
  assert.deepEqual(result.details.missingFields, ['title', 'voteType', 'requestedMinor+currency']);
  assert.deepEqual(result.details.advisoryMissingFields, ['approximateWhen']);
  assert.equal(result.details.readyForSubmit, false);
  // The prompts are human-safe: no tool name, field name or implementation term.
  const spoken = result.details.nextPrompt.join(' ');
  assert.ok(!/rein_|voteType|requestedMinor|currency|draftToken|missingFields/.test(spoken), spoken);
  assert.equal(built.calls.listVoteTypes.length, 1);
  // Collection reaches no write method: the fake writer exposes only read methods, and no getProposal
  // read happens for a fresh draft with no carried identifier.
  assert.deepEqual(built.calls.getProposal, []);
});

test('a carried draft merges the later fields and drops them from the missing list', async () => {
  const fakes = createFakes();
  const first = build({ fakes });
  const one = await first.tool().execute('call-1', { summary: 'community sharing session' });
  const second = build({ fakes, now: () => new Date(LATER) });
  const two = await second.tool().execute('call-2', {
    draftToken: one.details.draftToken,
    title: 'September community sharing session',
    requestedMinor: 30000,
    currency: 'usd',
  });
  assert.deepEqual(two.details.missingFields, ['voteType']);
  assert.equal(two.details.collected.title, 'September community sharing session');
  assert.equal(two.details.collected.summary, 'community sharing session');
  assert.equal(two.details.collected.requestedMinor, 30000);
  assert.equal(two.details.collected.currency, 'USD');
  assert.equal(two.details.recorded, false);
});

test('every required field present still does not submit', async () => {
  const built = build({ fakes: createFakes() });
  const result = await built.tool().execute('call-1', {
    title: 'September community sharing session',
    voteType: VOTE_TYPE,
    requestedMinor: 30000,
    currency: 'USD',
    approximateWhen: 'next weekend',
  });
  assert.equal(result.details.ok, true);
  assert.deepEqual(result.details.missingFields, []);
  assert.deepEqual(result.details.advisoryMissingFields, []);
  assert.equal(result.details.readyForSubmit, true);
  // Nothing is submitted: the answer says so, and there is no proposal identifier to report.
  assert.equal(result.details.submitted, false);
  assert.equal(result.details.recorded, false);
  assert.equal(result.details.proposalId, null);
  assert.equal(result.details.authorizesSpending, false);
});

test('a carried rough timing is reported as advice that must be confirmed in the summary', async () => {
  const built = build({ fakes: createFakes() });
  const withWhen = await built.tool().execute('call-1', { title: 'Meetup', approximateWhen: 'sometime in October' });
  assert.equal(withWhen.details.collected.approximateWhen, 'sometime in October');
  assert.deepEqual(withWhen.details.advisoryMissingFields, []);
  assert.match(withWhen.details.summaryConfirmationRequired, /summary/);
  const withoutWhen = await built.tool().execute('call-9', { title: 'Meetup' });
  assert.equal(withoutWhen.details.collected.approximateWhen, null);
  assert.deepEqual(withoutWhen.details.advisoryMissingFields, ['approximateWhen']);
  assert.equal(withoutWhen.details.summaryConfirmationRequired, null);
});

test('the amount and its currency travel as one pair or not at all', async () => {
  const built = build({ fakes: createFakes() });
  for (const args of [
    { requestedMinor: 30000 },
    { currency: 'USD' },
    { requestedMinor: 30000.5, currency: 'USD' },
    { requestedMinor: -1, currency: 'USD' },
    { requestedMinor: 30000, currency: 'dollars' },
  ]) {
    const result = await built.tool().execute('call-1', args);
    assert.equal(result.details.ok, false, JSON.stringify(args));
    // A refusal carries a fixed reason code and no write, so it never claims a recorded draft.
    assert.ok(typeof result.details.error === 'string' && result.details.error.length > 0);
    assert.equal(result.details.recorded, undefined);
  }
  const withPair = await built.tool().execute('call-2', { requestedMinor: 30000, currency: 'usd' });
  assert.equal(withPair.details.collected.requestedMinor, 30000);
  assert.equal(withPair.details.collected.currency, 'USD');
});

test('a supplied vote type is checked against the operator table and never guessed', async () => {
  const built = build({ fakes: createFakes() });
  const ok = await built.tool().execute('call-1', { voteType: VOTE_TYPE });
  assert.equal(ok.details.collected.voteType, VOTE_TYPE);
  assert.deepEqual(ok.details.missingFields, ['title', 'requestedMinor+currency']);

  const notConfigured = await built.tool().execute('call-2', { voteType: 'event' });
  assert.equal(notConfigured.details.error, 'vote_type_not_configured');
  assert.deepEqual(notConfigured.details.configuredVoteTypes, [VOTE_TYPE]);

  const malformed = await built.tool().execute('call-3', { voteType: 'Event Budget' });
  assert.equal(malformed.details.error, 'vote_type_invalid');

  const unreadable = build({
    fakes: createFakes({
      reads: { listVoteTypes: () => ({ ok: false, status: 'rejected', reason: 'vote_types_unavailable', voteTypes: null, httpStatus: null }) },
    }),
  });
  const outage = await unreadable.tool().execute('call-4', { voteType: VOTE_TYPE });
  assert.equal(outage.details.error, 'vote_type_configuration_unavailable');
});

test('collection is limited to the approved proposal channel and to an active Contributor', async () => {
  const boardCall = build({ channel: BOARD_CHANNEL });
  const outOfScope = await boardCall.tool().execute('call-1', { title: 'Meetup' });
  assert.equal(outOfScope.details.error, 'channel_out_of_scope');
  assert.equal(boardCall.calls.member.length, 0);

  const unlinked = build({ fakes: createFakes({ member: contributor({ status: 'unresolved', contactId: null }) }) });
  assert.equal((await unlinked.tool().execute('call-1', { title: 'Meetup' })).details.error, 'identity_link_required');

  const inactive = build({ fakes: createFakes({ member: contributor({ isActiveContributor: false }) }) });
  assert.equal((await inactive.tool().execute('call-1', { title: 'Meetup' })).details.error, 'contributor_status_required');

  // A read outage is reported as an unavailable identity check, never as an unlinked account.
  const unavailable = build({ fakes: createFakes({ member: contributor({ status: 'unavailable', contactId: null }) }) });
  assert.equal((await unavailable.tool().execute('call-1', { title: 'Meetup' })).details.error, 'identity_check_unavailable');

  const missingSender = build({ ctx: { requesterSenderId: '' } });
  assert.equal((await missingSender.tool().execute('call-1', { title: 'Meetup' })).details.error, 'trusted_requester_unavailable');
});

test('an actor or policy argument is refused before any read', async () => {
  const built = build({ fakes: createFakes() });
  for (const args of [{ title: 'Meetup', memberId: 'member-1' }, { title: 'Meetup', role: 'director' }, { title: 'Meetup', candidateIds: [] }]) {
    const result = await built.tool().execute('call-1', args);
    assert.ok(['actor_argument_rejected', 'policy_argument_rejected'].includes(result.details.error), JSON.stringify(args));
  }
  assert.equal(built.calls.member.length, 0);
});

test('the draft token is bound to the proposer, the payload and the window', async () => {
  const payload = {
    proposerContactId: CONTACT,
    title: 'Meetup',
    summary: null,
    voteType: VOTE_TYPE,
    requestedMinor: 30000,
    currency: 'USD',
    approximateWhen: null,
  };
  const issued = issueProposalDraft(payload, null, SIGNING_KEY, new Date(NOW));
  assert.equal(issued.ok, true);
  assert.equal(issued.expiresAt, new Date(Date.parse(NOW) + COLLECT_TTL_MS).toISOString());
  assert.deepEqual(verifyProposalDraft(issued.token, CONTACT, SIGNING_KEY, new Date(LATER)), { ok: true, payload });
  // Another proposer cannot open it, and an expired window is refused.
  assert.equal(verifyProposalDraft(issued.token, OTHER_CONTACT, SIGNING_KEY, new Date(LATER)).reason, 'draft_token_invalid');
  assert.equal(
    verifyProposalDraft(issued.token, CONTACT, SIGNING_KEY, new Date(Date.parse(issued.expiresAt) + 1)).reason,
    'draft_token_expired',
  );
  // A tampered token, a foreign key and a foreign prefix are all refused.
  assert.equal(verifyProposalDraft(`${issued.token}tamper`, CONTACT, SIGNING_KEY, new Date(LATER)).reason, 'draft_token_invalid');
  assert.equal(verifyProposalDraft(issued.token, CONTACT, 'another-signing-key-0002', new Date(LATER)).reason, 'draft_token_invalid');
  assert.equal(verifyProposalDraft('rein_proposal_confirm.rpc2.1.abc', CONTACT, SIGNING_KEY, new Date(LATER)).reason, 'draft_token_invalid');
  assert.equal(verifyProposalDraft('', CONTACT, SIGNING_KEY, new Date(LATER)).reason, 'draft_token_required');
});

test('a draft token is never accepted as a submit confirmation, and the reverse', () => {
  const payload = {
    proposerContactId: CONTACT,
    title: 'Meetup',
    summary: null,
    voteType: VOTE_TYPE,
    requestedMinor: 30000,
    currency: 'USD',
    approximateWhen: null,
  };
  const draft = issueProposalDraft(payload, null, SIGNING_KEY, new Date(NOW));
  const confirmation = issueProposalConfirmation(payload, SIGNING_KEY, new Date(NOW));
  assert.equal(draft.ok, true);
  assert.equal(confirmation.ok, true);
  // A draft token has its own envelope prefix, so the confirmation module refuses it outright.
  assert.ok(draft.token.startsWith('rein_proposal_draft.rpd1.'));
  assert.ok(confirmation.token.startsWith('rein_proposal_confirm.rpc2.'));
  assert.notEqual(draft.token, confirmation.token);
  // The draft verifier refuses a confirmation token: its prefix is not the draft prefix.
  assert.equal(verifyProposalDraft(confirmation.token, CONTACT, SIGNING_KEY, new Date(LATER)).reason, 'draft_token_invalid');
  // The confirmation verifier refuses a draft token in the other direction: it names the draft
  // purpose, so its envelope is not a confirmation envelope at all.
  assert.deepEqual(verifyProposalConfirmation(draft.token, payload, SIGNING_KEY, new Date(LATER)), {
    ok: false,
    reason: 'proposal_confirmation_invalid',
  });
});

test('no segment of a draft token reveals the contact id or the written text', () => {
  const payload = {
    proposerContactId: CONTACT,
    title: 'September community sharing session',
    summary: 'Venue and tea break',
    voteType: VOTE_TYPE,
    requestedMinor: 30000,
    currency: 'USD',
    approximateWhen: 'next weekend',
  };
  const issued = issueProposalDraft(payload, null, SIGNING_KEY, new Date(NOW));
  assert.equal(issued.ok, true);
  const segments = issued.token.split('.');
  assert.deepEqual(segments.slice(0, 2), ['rein_proposal_draft', 'rpd1']);
  for (const segment of segments) {
    assert.ok(!segment.includes(CONTACT), 'the contact id must not appear');
    assert.ok(!segment.includes('September community sharing session'), 'the title must not appear');
    assert.ok(!segment.includes('tea break') && !segment.includes('Tea break'), 'the summary must not appear');
    assert.ok(!segment.includes('next weekend'), 'the rough timing must not appear');
  }
  const decoded = Buffer.from(segments[3], 'base64url').toString('utf8');
  assert.ok(!/September|tea break|Venue/i.test(decoded), 'no readable plaintext may survive');
});

test('the draft fence and the advertised cap are one bound, so no minted token can exceed the cap', () => {
  // The issuer's check, the fence and the schema cap have to be the same number rather than three
  // derivations of it, so the equality is asserted directly instead of trusting the arithmetic.
  assert.equal(MAX_COLLECT_TOKEN_LENGTH, COLLECT_TOKEN_CAP, 'the schema cap is the draft cap');
  assert.equal(MAX_COLLECT_TOKEN_LENGTH, MAX_DRAFT_TOKEN_LENGTH, 'the schema cap is the issuer cap');
  // A document that exactly fills the fence still mints a token inside the cap.
  const filler = 'a'.repeat(MAX_DRAFT_DOCUMENT_BYTES);
  const oversized = issueProposalDraft(
    {
      proposerContactId: CONTACT,
      title: 'Meetup',
      summary: filler,
      voteType: VOTE_TYPE,
      requestedMinor: null,
      currency: null,
      approximateWhen: null,
    },
    null,
    SIGNING_KEY,
    new Date(NOW),
  );
  // Whatever the fence admits, the cap holds: over the fence refuses, and inside stays under the cap.
  if (oversized.ok) {
    assert.ok(oversized.token.length <= COLLECT_TOKEN_CAP);
    assert.ok(oversized.token.length <= MAX_COLLECT_TOKEN_LENGTH);
  } else {
    assert.equal(oversized.reason, 'draft_document_too_large');
  }
  const farTooLong = issueProposalDraft(
    {
      proposerContactId: CONTACT,
      title: 'Meetup',
      summary: 'a'.repeat(MAX_DRAFT_DOCUMENT_BYTES * 2),
      voteType: VOTE_TYPE,
      requestedMinor: null,
      currency: null,
      approximateWhen: null,
    },
    null,
    SIGNING_KEY,
    new Date(NOW),
  );
  assert.equal(farTooLong.ok, false);
  assert.equal(farTooLong.reason, 'draft_document_too_large');
});

test('the draft document fence holds exactly, in ASCII and in the widest encoding', () => {
  // The fence is only trustworthy if it is measured, not assumed: a fence a byte too generous mints a
  // token the schema's own `maxLength` rejects, which is the drift this pins. The fence is reproduced
  // from the advertised cap independently of the module, then a payload is placed exactly on it.
  const shape = (summary) => ({
    proposerContactId: CONTACT,
    title: 'Meetup',
    summary,
    voteType: VOTE_TYPE,
    requestedMinor: null,
    currency: null,
    approximateWhen: null,
  });
  const documentBytes = (summary) =>
    Buffer.byteLength(JSON.stringify({
      v: 1,
      proposerContactId: CONTACT,
      title: 'Meetup',
      summary,
      voteType: VOTE_TYPE,
      requestedMinor: null,
      currency: null,
      approximateWhen: null,
      proposalId: null,
    }), 'utf8');

  const asciiEmpty = documentBytes('');
  const asciiFiller = 'a'.repeat(MAX_DRAFT_DOCUMENT_BYTES - asciiEmpty);
  assert.equal(documentBytes(asciiFiller), MAX_DRAFT_DOCUMENT_BYTES, 'the ASCII payload sits on the fence');
  const minted = issueProposalDraft(shape(asciiFiller), null, SIGNING_KEY, new Date(NOW));
  assert.equal(minted.ok, true, JSON.stringify(minted));
  assert.ok(
    minted.token.length <= MAX_COLLECT_TOKEN_LENGTH,
    `the token minted on the fence stays inside the cap (${minted.token.length} > ${MAX_COLLECT_TOKEN_LENGTH})`,
  );
  assert.equal(
    verifyProposalDraft(minted.token, CONTACT, SIGNING_KEY, new Date(LATER)).ok,
    true,
    'the fence-edge token verifies',
  );

  // One byte past the fence is refused before a token exists, and the refusal names the size.
  const pastFence = `${asciiFiller}x`;
  assert.equal(documentBytes(pastFence), MAX_DRAFT_DOCUMENT_BYTES + 1, 'one byte past it');
  const outside = issueProposalDraft(shape(pastFence), null, SIGNING_KEY, new Date(NOW));
  assert.equal(outside.ok, false, 'a document one byte past the fence is refused');
  assert.equal(outside.reason, 'draft_document_too_large');

  // The same fence has to hold for text whose bytes are not its characters: a multi-byte summary may
  // not be measured as if every code point cost one byte, or the schema would reject its own token.
  const wideEmpty = documentBytes('');
  const wideChars = Math.floor((MAX_DRAFT_DOCUMENT_BYTES - wideEmpty) / 3);
  const widest = '中'.repeat(wideChars);
  assert.ok(
    documentBytes(widest) <= MAX_DRAFT_DOCUMENT_BYTES,
    'the widest summary used stays inside the fence',
  );
  const wideMinted = issueProposalDraft(shape(widest), null, SIGNING_KEY, new Date(NOW));
  assert.equal(wideMinted.ok, true, JSON.stringify(wideMinted));
  assert.ok(
    wideMinted.token.length <= MAX_COLLECT_TOKEN_LENGTH,
    `the multi-byte fence-edge token stays inside the cap (${wideMinted.token.length} > ${MAX_COLLECT_TOKEN_LENGTH})`,
  );

  // The fence the module enforces and the one its advertised cap implies are the same number.
  assert.equal(
    MAX_DRAFT_DOCUMENT_BYTES,
    maxDocumentBytesForToken(MAX_COLLECT_TOKEN_LENGTH),
    'the enforced fence is the one the advertised cap implies',
  );
});

test('a draft too large to seal is refused instead of returning an unusable token', async () => {
  const built = build({ fakes: createFakes() });
  const result = await built.tool().execute('call-1', { title: 'Meetup', summary: 'a'.repeat(4000) });
  // A 4000-character summary is legal for the schema; if it cannot be sealed the tool refuses with a
  // size reason instead of handing back a token the next call would reject.
  if (result.details.ok === false) {
    assert.equal(result.details.error, 'draft_document_too_large');
  } else {
    assert.ok(result.details.draftToken.length <= MAX_COLLECT_TOKEN_LENGTH);
  }
});

test('a carried draft whose token is tampered or expired is refused', async () => {
  const fakes = createFakes();
  const first = build({ fakes });
  const one = await first.tool().execute('call-1', { title: 'Meetup' });

  const tampered = build({ fakes, now: () => new Date(LATER) });
  assert.equal(
    (await tampered.tool().execute('call-2', { draftToken: `${one.details.draftToken}x` })).details.error,
    'draft_token_invalid',
  );

  // Past the one-hour window the same token is reported as expired, not as an altered one.
  const late = build({ fakes, now: () => new Date(Date.parse(NOW) + COLLECT_TTL_MS + 1000) });
  assert.equal(
    (await late.tool().execute('call-2', { draftToken: one.details.draftToken })).details.error,
    'draft_token_expired',
  );
});

test('a non-canonical spelling of a valid draft blob is refused instead of decoded', async () => {
  // Base64url drops the trailing bits that carry no byte, so one sealed draft blob also has sibling
  // spellings that decode to exactly the same bytes. The draft verifier has to reject those: taken as
  // a carried token, a sibling spelling would decode to a valid draft while standing in for the token
  // the server issued. The sibling is found by enumerating the final character, so the case is
  // exercised on every run instead of waiting for a blob whose last bits happen to be unused.
  const fakes = createFakes();
  const first = build({ fakes });
  const one = await first.tool().execute('call-1', { title: 'Meetup', summary: 'Venue and tea break' });
  assert.equal(one.details.ok, true, JSON.stringify(one.details));
  const parts = one.details.draftToken.split('.');
  assert.deepEqual(parts.slice(0, 2), ['rein_proposal_draft', 'rpd1']);
  const sealed = parts[3];
  const bytes = Buffer.from(sealed, 'base64url');
  assert.equal(bytes.toString('base64url'), sealed, 'the minted token is already canonical');
  assert.notEqual(bytes.length % 3, 0, 'the sealed blob leaves trailing bits, so a sibling spelling exists');

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const head = sealed.slice(0, -1);
  const alias = [...alphabet]
    .map(character => `${head}${character}`)
    .find(candidate => candidate !== sealed && Buffer.from(candidate, 'base64url').equals(bytes));
  assert.ok(alias, 'the trailing bits leave a sibling spelling for the alias case');
  assert.notEqual(alias, sealed);
  assert.ok(Buffer.from(alias, 'base64url').equals(bytes), 'the alias decodes to the same sealed bytes');
  assert.notEqual(
    alias,
    Buffer.from(alias, 'base64url').toString('base64url'),
    'the alias differs from its own canonical re-encoding',
  );

  const readsBefore = fakes.calls.listVoteTypes.length;
  const proposalsBefore = fakes.calls.getProposal.length;
  const aliased = build({ fakes, now: () => new Date(LATER) });
  const refused = await aliased
    .tool()
    .execute('call-2', { draftToken: [...parts.slice(0, 3), alias].join('.'), title: 'Meetup' });
  assert.equal(refused.details.error, 'draft_token_invalid', JSON.stringify(refused.details));
  // The alias is refused before any stored read: the refused turn adds no vote-type table read and no
  // proposal read, so a sibling spelling can never steer a database call while standing in for the
  // issued token.
  assert.equal(fakes.calls.listVoteTypes.length, readsBefore, 'the alias adds no vote-type read');
  assert.equal(fakes.calls.getProposal.length, proposalsBefore, 'the alias adds no proposal read');

  // Padding and an out-of-alphabet character are the same class of non-canonical input: each is a
  // spelling this module never mints, and each is refused rather than decoded.
  for (const malformed of [`${sealed}==`, `${sealed.slice(0, -1)}=`, `${sealed.slice(0, -1)}+`, `${sealed.slice(0, -1)}/`]) {
    const carried = build({ fakes: createFakes(), now: () => new Date(LATER) });
    const result = await carried
      .tool()
      .execute('call-3', { draftToken: [...parts.slice(0, 3), malformed].join('.'), title: 'Meetup' });
    assert.equal(result.details.error, 'draft_token_invalid', `"${malformed}" must be refused`);
  }

  // The same sealed bytes in their canonical spelling still resume the draft, so the refusal above
  // tracks the spelling and not the blob.
  const controlFakes = createFakes();
  const control = build({ fakes: controlFakes, now: () => new Date(LATER) });
  const resumed = await control
    .tool()
    .execute('call-4', { draftToken: one.details.draftToken, title: 'September community sharing session' });
  assert.equal(resumed.details.ok, true, JSON.stringify(resumed.details));
  assert.equal(resumed.details.collected.title, 'September community sharing session');
  assert.equal(resumed.details.collected.summary, 'Venue and tea break');
});

test('a fresh collect discards nothing silently: an empty argument clears a carried value', async () => {
  const fakes = createFakes();
  const first = build({ fakes });
  const one = await first.tool().execute('call-1', { title: 'Wrong title' });
  const second = build({ fakes, now: () => new Date(LATER) });
  const cleared = await second.tool().execute('call-2', { draftToken: one.details.draftToken, title: '' });
  assert.equal(cleared.details.collected.title, null);
  assert.ok(cleared.details.missingFields.includes('title'));
});
