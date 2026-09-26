import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MVP_FEEDBACK_TOOL_NAMES,
  createMvpFeedbackToolRegistration,
} from '../plugins/rein-operations/mvp-feedback-tools.ts';

// Focused fake-reader and fake-writer tests for the three post-result feedback tools. No live
// database or Slack call is made. The fakes record every argument, so each test also proves which
// calls a refusal avoided, and the scripted writer decides what the stored database would have
// answered. The database stays the authority for the material gate: the fake `applyProposalRevision`
// refuses an unapproved material revision exactly as the recorded trigger does, so a tool that
// skipped its own check would still fail these tests.
//
// Feedback is a Board call in every test. The voters on a passed proposal are the directors, so the
// comment, the suggested revision, the approval and the apply all arrive from a current director
// inside the approved Board channel, and the proposal the revision names must be in its selected
// state.
//
// The two sides of the rule differ. `rein_mvp_revision_apply` is the Agent accepting a reasonable
// ordinary suggestion in the caller's turn, so a title or summary revision becomes effective with no
// further approval and reports `ordinaryRevisionApplicationDecision: 'agent_accepts_ordinary'`. A
// material revision keeps the hard gate and is refused with `revision_not_approved` until a current
// director's approval is recorded.

const TEAM = 'T0123456ABC';
const PROPOSAL_CHANNEL = 'C_PROPOSAL';
const BOARD_CHANNEL = 'C_BOARD';
const SENDER = 'U0123456ABC';
const CONTACT = '11111111-1111-4111-8111-111111111111';
const OTHER_CONTACT = '22222222-2222-4222-8222-222222222222';
const PROPOSAL = '33333333-3333-4333-8333-333333333333';
const OTHER_PROPOSAL = '44444444-4444-4444-8444-444444444444';
const REVISION = '55555555-5555-4555-8555-555555555555';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const URL_ENV = 'REIN_SUPABASE_URL';
const KEY_ENV = 'REIN_SUPABASE_SERVICE_ROLE_KEY';
const SECRET = 'sb_secret_unit_test_0000000000000000';
const RECORDED_AT = '2026-09-24T10:30:00.000Z';
const APPROVED_AT = '2026-09-24T11:00:00.000Z';

const baseConfig = Object.freeze({
  enabled: true,
  platform: 'slack',
  slackTeamId: TEAM,
  environment: 'dev',
  proposalChannelIds: [PROPOSAL_CHANNEL],
  boardChannelIds: [BOARD_CHANNEL],
  supabaseUrlEnvVar: URL_ENV,
  supabaseServiceKeyEnvVar: KEY_ENV,
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

const director = (overrides = {}) => contributor({ isDirector: true, ...overrides });

/** One stored proposal row, as `getProposal` returns it. */
const proposalRecord = (overrides = {}) => ({
  id: PROPOSAL,
  proposerContactId: OTHER_CONTACT,
  title: 'Repair workshop',
  summary: 'Fix the roof tiles',
  voteType: 'event_budget',
  requestedMinor: null,
  currency: null,
  status: 'selected',
  createdAt: RECORDED_AT,
  ...overrides,
});

/**
 * One recorded revision row, as `getRevision` returns it. `version` stays null until it becomes
 * effective, `approvedByContactId` stays null until a current director approves it, and a comment is
 * the row with no changed fields.
 */
const revisionRecord = (overrides = {}) => ({
  id: REVISION,
  proposalId: PROPOSAL,
  version: null,
  authorContactId: CONTACT,
  changedFields: ['title'],
  title: 'Repair workshop (revised)',
  summary: null,
  requestedMinor: null,
  currency: null,
  location: null,
  schedule: null,
  personnel: null,
  eventFlow: null,
  note: 'Shorter title',
  approvedByContactId: null,
  approvedAt: null,
  recordedAt: RECORDED_AT,
  ...overrides,
});

/** The material gate the sibling trigger implements, applied to the stored row. */
const MATERIAL_FIELDS = ['budget', 'location', 'schedule', 'personnel', 'event_flow'];
const isMaterial = (fields) => fields.some(field => MATERIAL_FIELDS.includes(field));

/** One applied proposal row, as `applyProposalRevision` returns it. */
const appliedRecord = (revision, overrides = {}) => ({
  proposalId: revision.proposalId,
  status: 'selected',
  version: 2,
  effectiveRevisionId: revision.id,
  title: revision.changedFields.includes('title') ? revision.title : 'Repair workshop',
  summary: revision.changedFields.includes('summary') ? revision.summary : null,
  requestedMinor: revision.changedFields.includes('budget') ? revision.requestedMinor : null,
  currency: revision.changedFields.includes('budget') ? revision.currency : null,
  location: revision.changedFields.includes('location') ? revision.location : null,
  schedule: revision.changedFields.includes('schedule') ? revision.schedule : null,
  personnel: revision.changedFields.includes('personnel') ? revision.personnel : null,
  eventFlow: revision.changedFields.includes('event_flow') ? revision.eventFlow : null,
  ...overrides,
});

function createFakes({ member = contributor(), proposal = proposalRecord(), revision, inserts } = {}) {
  const calls = {
    member: [],
    getProposal: [],
    getRevision: [],
    recordProposalRevision: [],
    approveProposalRevision: [],
    applyProposalRevision: [],
  };
  const reader = {
    async resolveSlackMember(slackUserId) {
      calls.member.push(slackUserId);
      return member;
    },
  };
  const storedRevision = revision ?? null;
  const writer = {
    async getProposal(id) {
      calls.getProposal.push(id);
      if (inserts?.getProposal) return inserts.getProposal(id);
      if (!proposal || proposal.id !== id) {
        return { ok: false, status: 'rejected', reason: 'proposal_not_found', proposal: null, httpStatus: 200 };
      }
      return { ok: true, status: 'found', reason: 'proposal', proposal, httpStatus: 200 };
    },
    async getRevision(id) {
      calls.getRevision.push(id);
      if (inserts?.getRevision) return inserts.getRevision(id);
      if (!storedRevision || storedRevision.id !== id) {
        return { ok: false, status: 'rejected', reason: 'revision_not_found', revision: null, httpStatus: 200 };
      }
      return { ok: true, status: 'found', reason: 'revision', revision: storedRevision, httpStatus: 200 };
    },
    async recordProposalRevision(input) {
      calls.recordProposalRevision.push(input);
      if (inserts?.recordProposalRevision) return inserts.recordProposalRevision(input);
      return {
        ok: true,
        status: 'inserted',
        reason: 'inserted',
        revision: revisionRecord({
          id: input.id,
          proposalId: input.proposalId,
          authorContactId: input.authorContactId,
          changedFields: [...input.changedFields],
          title: input.title ?? null,
          summary: input.summary ?? null,
          requestedMinor: input.requestedMinor ?? null,
          currency: input.currency ?? null,
          location: input.location ?? null,
          schedule: input.schedule ?? null,
          personnel: input.personnel ?? null,
          eventFlow: input.eventFlow ?? null,
          note: input.note ?? null,
        }),
        httpStatus: 201,
      };
    },
    async approveProposalRevision(input) {
      calls.approveProposalRevision.push(input);
      if (inserts?.approveProposalRevision) return inserts.approveProposalRevision(input);
      const base = storedRevision ?? revisionRecord({ id: input.revisionId });
      return {
        ok: true,
        status: 'updated',
        reason: 'approved',
        revision: { ...base, approvedByContactId: input.approverContactId, approvedAt: APPROVED_AT },
        httpStatus: 200,
      };
    },
    async applyProposalRevision(input) {
      calls.applyProposalRevision.push(input);
      if (inserts?.applyProposalRevision) return inserts.applyProposalRevision(input);
      const target = storedRevision ?? revisionRecord({ id: input.revisionId });
      // The trigger's own rules, restated in the fake so a tool that wrote before checking cannot
      // pass: a comment is never applied, an applied revision is refused, and a material revision
      // without a recorded approval is refused by name.
      if (target.changedFields.length === 0) {
        return { ok: false, status: 'rejected', reason: 'revision_is_comment', version: null, httpStatus: 200 };
      }
      if (target.version !== null) {
        return { ok: false, status: 'rejected', reason: 'revision_already_applied', version: null, httpStatus: 200 };
      }
      if (isMaterial(target.changedFields) && target.approvedByContactId === null) {
        return { ok: false, status: 'rejected', reason: 'revision_not_approved', version: null, httpStatus: 200 };
      }
      return {
        ok: true,
        status: 'updated',
        reason: 'revision_applied',
        version: appliedRecord(target),
        httpStatus: 200,
      };
    },
  };
  return { reader, writer, calls };
}

function build({ config = baseConfig, fakes = createFakes(), ctx: overrides = {}, env, channel = BOARD_CHANNEL } = {}) {
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
  const registration = createMvpFeedbackToolRegistration({
    config,
    reader: fakes.reader,
    writer: fakes.writer,
    env,
  });
  const tools = registration.create(ctx);
  return {
    registration,
    tools,
    guard,
    ctx,
    calls: fakes.calls,
    tool: name => tools.find(item => item.name === name),
  };
}

// ---------------------------------------------------------------------------------------------
// Registration contract
// ---------------------------------------------------------------------------------------------

test('no feedback tool registers without an explicit enabled block', () => {
  for (const config of [undefined, {}, { enabled: false }, { enabled: 'true' }]) {
    const fakes = createFakes();
    const registration = createMvpFeedbackToolRegistration({ config, reader: fakes.reader, writer: fakes.writer });
    assert.equal(registration.create({ messageChannel: 'slack' }), null);
    assert.equal(registration.contextVersion, 2);
  }
  assert.deepEqual([...MVP_FEEDBACK_TOOL_NAMES], [
    'rein_mvp_proposal_comment_suggest',
    'rein_mvp_revision_approve',
    'rein_mvp_revision_apply',
  ]);
});

test('the injected writer must implement every feedback method', () => {
  for (const missing of [
    'getProposal',
    'getRevision',
    'recordProposalRevision',
    'approveProposalRevision',
    'applyProposalRevision',
  ]) {
    const fakes = createFakes();
    const partial = { ...fakes.writer, [missing]: undefined };
    assert.throws(
      () => createMvpFeedbackToolRegistration({ config: baseConfig, reader: fakes.reader, writer: partial }),
      /must implement getProposal, getRevision, recordProposalRevision, approveProposalRevision and applyProposalRevision/,
      missing,
    );
  }
});

test('the Supabase key is read from the server environment and never appears in the tools', () => {
  assert.throws(
    () => createMvpFeedbackToolRegistration({ config: baseConfig, env: {} }),
    error => error.code === 'mvp_env_value_missing' && error.message.includes(URL_ENV),
  );
  assert.throws(
    () =>
      createMvpFeedbackToolRegistration({
        config: baseConfig,
        env: { [URL_ENV]: 'https://project-ref.supabase.co' },
      }),
    error => error.code === 'mvp_env_value_missing' && error.message.includes(KEY_ENV),
  );

  const registration = createMvpFeedbackToolRegistration({
    config: baseConfig,
    env: { [URL_ENV]: 'https://project-ref.supabase.co', [KEY_ENV]: SECRET },
  });
  const tools = registration.create({
    messageChannel: 'slack',
    nativeChannelId: BOARD_CHANNEL,
    requesterSenderId: SENDER,
    assertInvocationCurrent() {},
  });
  assert.deepEqual(tools.map(tool => tool.name), [...MVP_FEEDBACK_TOOL_NAMES]);
  assert.ok(!JSON.stringify(tools).includes(SECRET));
  assert.ok(!JSON.stringify(tools).includes('project-ref.supabase.co'));
});

test('an enabled-but-incomplete block fails loudly instead of registering part of the slice', () => {
  const fakes = createFakes();
  const incomplete = { ...baseConfig, boardChannelIds: [] };
  assert.throws(
    () => createMvpFeedbackToolRegistration({ config: incomplete, reader: fakes.reader, writer: fakes.writer }),
    /boardChannelIds must list at least one/,
  );
  assert.throws(
    () =>
      createMvpFeedbackToolRegistration({
        config: { ...baseConfig, platform: 'discord' },
        reader: fakes.reader,
        writer: fakes.writer,
      }),
    /platform must be "slack"/,
  );
});

// ---------------------------------------------------------------------------------------------
// rein_mvp_proposal_comment_suggest
// ---------------------------------------------------------------------------------------------

test('a current director records one comment on a proposal that passed', async () => {
  const fakes = createFakes({ member: director() });
  const { tool, calls, guard } = build({ fakes });

  const result = await tool('rein_mvp_proposal_comment_suggest').execute('call-1', {
    proposalId: PROPOSAL,
    note: 'Could the venue be nearer the station?',
  });

  assert.equal(result.details.ok, true);
  assert.equal(result.details.status, 'inserted');
  assert.equal(result.details.kind, 'comment');
  assert.deepEqual(result.details.changedFields, []);
  assert.deepEqual(result.details.materialFields, []);
  assert.equal(result.details.approvalRequired, false, 'a comment has no approval gate');
  assert.equal(result.details.recorded, true);
  assert.equal(result.details.applied, false);
  assert.equal(
    result.details.ordinaryRevisionApplicationDecision,
    'agent_accepts_ordinary',
    'an ordinary revision needs no second approval',
  );
  assert.equal(result.details.approvalGate, null, 'a comment names no approval gate');
  assert.equal(result.details.authorizesSpending, false);

  assert.deepEqual(calls.member, [SENDER]);
  assert.deepEqual(calls.getProposal, [PROPOSAL]);
  const sent = calls.recordProposalRevision[0];
  assert.match(sent.id, UUID_V4, 'the revision identifier is a fresh v4 UUID, never an argument');
  assert.equal(sent.proposalId, PROPOSAL);
  assert.equal(sent.authorContactId, CONTACT, 'the author is the resolved sender record');
  assert.deepEqual(sent.changedFields, []);
  assert.equal(sent.note, 'Could the venue be nearer the station?');
  assert.equal(guard.calls, 1, 'the invocation guard runs once before the write');
  assert.ok(!JSON.stringify(result.details).includes(CONTACT), 'the private contact id is not returned');
});

test('an ordinary title or summary suggestion carries exactly its named fields', async () => {
  const fakes = createFakes({ member: director() });
  const { tool, calls } = build({ fakes });

  const result = await tool('rein_mvp_proposal_comment_suggest').execute('call-2', {
    proposalId: PROPOSAL,
    changedFields: ['title', 'summary'],
    title: '  Repair workshop, second session  ',
    summary: 'Two sessions instead of one',
    note: 'The room is free for two hours',
  });

  assert.equal(result.details.ok, true);
  assert.equal(result.details.kind, 'suggestion');
  assert.deepEqual(result.details.changedFields, ['title', 'summary']);
  assert.deepEqual(result.details.materialFields, [], 'a title and summary revision is ordinary');
  assert.equal(result.details.approvalRequired, false);
  assert.equal(result.details.applied, false, 'recording an ordinary suggestion applies nothing');
  assert.equal(
    result.details.ordinaryRevisionApplicationDecision,
    'agent_accepts_ordinary',
    'the Agent may accept a reasonable ordinary suggestion without a further approval',
  );
  assert.equal(result.details.approvalGate, null, 'an ordinary revision has no approval gate');
  assert.equal(result.details.authorizesSpending, false);

  const sent = calls.recordProposalRevision[0];
  assert.deepEqual(sent.changedFields, ['title', 'summary']);
  assert.equal(sent.title, 'Repair workshop, second session', 'the title is trimmed');
  assert.equal(sent.summary, 'Two sessions instead of one');
  assert.ok(!Object.hasOwn(sent, 'requestedMinor'), 'an unnamed field carries no value');
  assert.ok(!Object.hasOwn(sent, 'location'));
});

test('a material suggestion names its gate and still writes only the named fields', async () => {
  const fakes = createFakes({ member: director() });
  const { tool, calls } = build({ fakes });

  const result = await tool('rein_mvp_proposal_comment_suggest').execute('call-3', {
    proposalId: PROPOSAL,
    changedFields: ['schedule', 'budget'],
    schedule: 'Saturdays 18:00, 90 minutes',
    requestedMinor: 90000,
    currency: 'usd',
    note: 'Moving to the weekend and raising the cap',
  });

  assert.equal(result.details.ok, true);
  assert.deepEqual(result.details.materialFields, ['schedule', 'budget'], 'the stored order is kept');
  assert.equal(result.details.approvalRequired, true, 'a material revision names its approval gate');
  assert.equal(
    result.details.approvalGate,
    'director_approval_required',
    'a material revision keeps the recorded director approval gate',
  );
  assert.equal(result.details.recorded, true);
  assert.equal(result.details.applied, false, 'recording a material suggestion never applies it');

  const sent = calls.recordProposalRevision[0];
  assert.equal(sent.requestedMinor, 90000);
  assert.equal(sent.currency, 'USD', 'a currency code is normalized to upper case');
  assert.equal(sent.schedule, 'Saturdays 18:00, 90 minutes');
  assert.ok(!Object.hasOwn(sent, 'title'));
  assert.ok(!Object.hasOwn(sent, 'location'));
});

test('a field value without its name is refused, and a named field without its value is refused', async () => {
  for (const [args, code] of [
    [{ proposalId: PROPOSAL, note: 'n', title: 'Unnamed title' }, 'revision_field_value_unexpected'],
    [{ proposalId: PROPOSAL, note: 'n', changedFields: ['title'] }, 'revision_field_value_required'],
    [{ proposalId: PROPOSAL, note: 'n', location: 'Somewhere' }, 'revision_field_value_unexpected'],
    [
      { proposalId: PROPOSAL, note: 'n', requestedMinor: 100, currency: 'USD' },
      'revision_budget_unexpected',
    ],
    [{ proposalId: PROPOSAL, note: 'n', changedFields: ['budget'], requestedMinor: 100 }, 'revision_budget_invalid'],
    [
      { proposalId: PROPOSAL, note: 'n', changedFields: ['budget'], requestedMinor: 100, currency: 'dollars' },
      'revision_budget_invalid',
    ],
    [{ proposalId: PROPOSAL, note: 'n', changedFields: ['venue'], venue: 'X' }, 'changed_fields_invalid'],
    [{ proposalId: PROPOSAL, note: 'n', changedFields: ['title', 'title'], title: 'X' }, 'changed_fields_invalid'],
    [{ proposalId: PROPOSAL }, 'revision_field_value_required'],
  ]) {
    const fakes = createFakes({ member: director() });
    const result = await build({ fakes })
      .tool('rein_mvp_proposal_comment_suggest')
      .execute('call-4', args);
    assert.equal(result.details.ok, false, JSON.stringify(args));
    assert.equal(result.details.error, code, JSON.stringify(args));
    assert.deepEqual(fakes.calls.recordProposalRevision, [], `${code} writes nothing`);
  }
});

test('a suggestion for an unknown proposal is refused and writes no revision', async () => {
  const fakes = createFakes({ member: director() });
  const result = await build({ fakes })
    .tool('rein_mvp_proposal_comment_suggest')
    .execute('call-5', { proposalId: OTHER_PROPOSAL, note: 'Anything about it' });
  assert.equal(result.details.ok, false);
  assert.equal(result.details.error, 'proposal_not_found');
  assert.deepEqual(fakes.calls.recordProposalRevision, []);
  assert.deepEqual(fakes.calls.getProposal, [OTHER_PROPOSAL]);
});

test('a same-turn retry of the feedback call is the same record, and a later turn is a new one', async () => {
  const fakes = createFakes({ member: director() });
  const { tool, calls } = build({ fakes });

  await tool('rein_mvp_proposal_comment_suggest').execute('call-7', { proposalId: PROPOSAL, note: 'Same note' });
  await tool('rein_mvp_proposal_comment_suggest').execute('call-7', { proposalId: PROPOSAL, note: 'Same note' });
  assert.equal(calls.recordProposalRevision.length, 2);
  assert.equal(
    calls.recordProposalRevision[0].id,
    calls.recordProposalRevision[1].id,
    'a same-turn retry reaches the record it already wrote',
  );

  const second = createFakes({ member: director() });
  await build({ fakes: second })
    .tool('rein_mvp_proposal_comment_suggest')
    .execute('call-7', { proposalId: PROPOSAL, note: 'Same note' });
  assert.notEqual(
    calls.recordProposalRevision[0].id,
    second.calls.recordProposalRevision[0].id,
    'a new turn mints a new record',
  );
});

test('the record identifier is minted per tool call, so two different calls stay distinct', async () => {
  const fakes = createFakes({ member: director() });
  const { tool, calls } = build({ fakes });
  await tool('rein_mvp_proposal_comment_suggest').execute('call-a', { proposalId: PROPOSAL, note: 'One' });
  await tool('rein_mvp_proposal_comment_suggest').execute('call-b', { proposalId: PROPOSAL, note: 'Two' });
  assert.notEqual(calls.recordProposalRevision[0].id, calls.recordProposalRevision[1].id);
});

test('a missing host tool call id is refused instead of inventing a record identifier', async () => {
  for (const toolCallId of [undefined, '', '   ']) {
    const fakes = createFakes({ member: director() });
    const result = await build({ fakes })
      .tool('rein_mvp_proposal_comment_suggest')
      .execute(toolCallId, { proposalId: PROPOSAL, note: 'Note' });
    assert.equal(result.details.error, 'tool_call_id_required', String(toolCallId));
    assert.deepEqual(fakes.calls.recordProposalRevision, []);
  }
});

// ---------------------------------------------------------------------------------------------
// rein_mvp_revision_apply
// ---------------------------------------------------------------------------------------------

test('an ordinary revision is applied and the database version comes back', async () => {
  const revision = revisionRecord({ changedFields: ['title'], title: 'Repair workshop (revised)' });
  const fakes = createFakes({ member: director(), revision });
  const { tool, calls, guard } = build({ fakes });

  const result = await tool('rein_mvp_revision_apply').execute('call-1', { revisionId: REVISION });

  assert.equal(result.details.ok, true);
  assert.equal(result.details.applied, true);
  assert.equal(result.details.reason, 'revision_applied');
  assert.equal(result.details.version, 2, 'the version is the database answer');
  assert.equal(result.details.effectiveRevisionId, REVISION);
  assert.deepEqual(result.details.changedFields, ['title']);
  assert.deepEqual(result.details.materialFields, []);
  assert.equal(result.details.approvalRequired, false);
  assert.equal(result.details.approvalGate, null, 'an ordinary revision has no approval gate');
  assert.equal(
    result.details.acceptedBy,
    'agent',
    'the Agent accepts a reasonable ordinary suggestion in the caller turn',
  );
  assert.equal(result.details.ordinaryRevisionApplicationDecision, 'agent_accepts_ordinary');
  assert.equal(result.details.authorizesSpending, false);
  assert.equal(result.details.appliedFields.title, 'Repair workshop (revised)');
  assert.deepEqual(calls.applyProposalRevision, [{ revisionId: REVISION }]);
  assert.equal(guard.calls, 1);
  assert.deepEqual(calls.member, [SENDER]);
});

test('a material revision is refused before approval with the approval gate named', async () => {
  const revision = revisionRecord({
    changedFields: ['budget'],
    title: null,
    requestedMinor: 250000,
    currency: 'USD',
    note: 'Raise the cap',
  });
  const fakes = createFakes({ member: director(), revision });
  const { tool, calls, guard } = build({ fakes });

  const result = await tool('rein_mvp_revision_apply').execute('call-2', { revisionId: REVISION });

  assert.equal(result.details.ok, false);
  assert.equal(result.details.error, 'revision_not_approved');
  assert.equal(result.details.status, 'refused');
  assert.equal(result.details.applied, false);
  assert.equal(result.details.approvalRequired, true);
  assert.equal(result.details.approvalGate, 'director_approval_required');
  assert.equal(result.details.approvalRecorded, false);
  assert.deepEqual(result.details.materialFields, ['budget']);
  assert.equal(result.details.authorizesSpending, false);
  assert.deepEqual(calls.applyProposalRevision, [], 'the material gate refuses before any write');
  assert.equal(guard.calls, 0, 'the guard is only reached once the gate is passed');
});

test('a material revision takes effect only after a director records an approval', async () => {
  const pending = revisionRecord({
    changedFields: ['location'],
    title: null,
    location: 'Room 204, engineering building',
    note: 'Closer to the station',
  });
  const fakes = createFakes({ member: director(), revision: pending });
  const approveBuild = build({ fakes });
  const applied = build({
    fakes: createFakes({
      member: director(),
      revision: { ...pending, approvedByContactId: OTHER_CONTACT, approvedAt: APPROVED_AT },
    }),
  });

  const refused = await approveBuild.tool('rein_mvp_revision_apply').execute('call-3', { revisionId: REVISION });
  assert.equal(refused.details.error, 'revision_not_approved');

  const accepted = await applied.tool('rein_mvp_revision_apply').execute('call-4', { revisionId: REVISION });
  assert.equal(accepted.details.ok, true);
  assert.equal(accepted.details.applied, true);
  assert.equal(accepted.details.approved, true, 'the recorded approval is what let it take effect');
  assert.equal(accepted.details.acceptedBy, 'director_approved');
  assert.equal(accepted.details.approvalGate, 'director_approval_required');
  assert.deepEqual(accepted.details.materialFields, ['location']);
  assert.equal(accepted.details.appliedFields.location, 'Room 204, engineering building');
});

test('a stored material revision that carries an approval is applied without a second approval', async () => {
  const revision = revisionRecord({
    changedFields: ['event_flow'],
    title: null,
    eventFlow: 'Doors, talk, then a 30 minute Q&A',
    approvedByContactId: OTHER_CONTACT,
    approvedAt: APPROVED_AT,
  });
  const fakes = createFakes({ member: director(), revision });
  const result = await build({ fakes }).tool('rein_mvp_revision_apply').execute('call-5', { revisionId: REVISION });
  assert.equal(result.details.ok, true);
  assert.equal(result.details.applied, true);
  assert.deepEqual(fakes.calls.approveProposalRevision, [], 'applying never records an approval of its own');
});

test('a comment is refused and an already applied revision is reported instead of applied twice', async () => {
  const comment = revisionRecord({ changedFields: [], title: null, note: 'Nice work' });
  const pending = revisionRecord({ changedFields: ['title'] });

  // An ordinary revision is applied once, and a later call reports the stored version instead of
  // writing a second one.
  const firstApply = createFakes({ member: director(), revision: pending });
  const first = await build({ fakes: firstApply }).tool('rein_mvp_revision_apply').execute('call-5', {
    revisionId: REVISION,
  });
  assert.equal(first.details.applied, true);
  const appliedTwice = createFakes({ member: director(), revision: { ...pending, version: 2 } });
  const second = await build({ fakes: appliedTwice }).tool('rein_mvp_revision_approve').execute('call-6', {
    revisionId: REVISION,
  });
  assert.equal(second.details.error, 'revision_already_applied');
  assert.deepEqual(appliedTwice.calls.approveProposalRevision, []);

  const commentApplyFakes = createFakes({ member: director(), revision: comment });
  const commentApply = await build({ fakes: commentApplyFakes })
    .tool('rein_mvp_revision_apply')
    .execute('call-7', { revisionId: REVISION });
  assert.equal(commentApply.details.error, 'revision_is_comment');
  assert.deepEqual(commentApplyFakes.calls.applyProposalRevision, []);

  const commentApproveFakes = createFakes({ member: director(), revision: comment });
  const commentApprove = await build({ fakes: commentApproveFakes })
    .tool('rein_mvp_revision_approve')
    .execute('call-8', { revisionId: REVISION });
  assert.equal(commentApprove.details.error, 'revision_is_comment');
  assert.deepEqual(commentApproveFakes.calls.approveProposalRevision, []);
});

test('an unknown revision is refused and applies nothing', async () => {
  const fakes = createFakes({ member: director() });
  const result = await build({ fakes }).tool('rein_mvp_revision_apply').execute('call-8', { revisionId: REVISION });
  assert.equal(result.details.error, 'revision_not_found');
  assert.deepEqual(fakes.calls.applyProposalRevision, []);
});

// ---------------------------------------------------------------------------------------------
// rein_mvp_revision_approve
// ---------------------------------------------------------------------------------------------

test('a current director records the approval a material revision needs', async () => {
  const revision = revisionRecord({
    changedFields: ['personnel'],
    title: null,
    personnel: 'Led by CO-2 with CO-1 supporting',
    note: 'Swapping the lead',
  });
  const fakes = createFakes({ member: director(), revision });
  const { tool, calls, guard } = build({ fakes });

  const result = await tool('rein_mvp_revision_approve').execute('call-1', { revisionId: REVISION });

  assert.equal(result.details.ok, true);
  assert.equal(result.details.approved, true);
  assert.equal(result.details.repeated, false);
  assert.equal(result.details.approvedAt, APPROVED_AT);
  assert.deepEqual(result.details.materialFields, ['personnel']);
  assert.equal(result.details.approvalRequired, true);
  assert.equal(result.details.authorizesSpending, false);
  assert.deepEqual(calls.approveProposalRevision, [{ revisionId: REVISION, approverContactId: CONTACT }]);
  assert.equal(guard.calls, 1);
  assert.ok(!JSON.stringify(result.details).includes(CONTACT), 'the approver contact id is never returned');
});

test('a repeat approval by the same director is the recorded one, never a second', async () => {
  const revision = revisionRecord({
    changedFields: ['budget'],
    title: null,
    requestedMinor: 5000,
    currency: 'USD',
    approvedByContactId: CONTACT,
    approvedAt: APPROVED_AT,
  });
  const fakes = createFakes({
    member: director(),
    revision,
    inserts: {
      approveProposalRevision: async () => ({
        ok: true,
        status: 'existing',
        reason: 'existing_approved',
        revision,
        httpStatus: 200,
      }),
    },
  });
  const result = await build({ fakes }).tool('rein_mvp_revision_approve').execute('call-2', { revisionId: REVISION });
  assert.equal(result.details.ok, true);
  assert.equal(result.details.repeated, true);
  assert.equal(result.details.approved, true);
  assert.equal(result.details.approvedAt, APPROVED_AT);
});

test('a comment carries nothing to approve and an applied revision takes no further approval', async () => {
  const comment = revisionRecord({ changedFields: [], title: null, note: 'Nice work' });
  const commentFakes = createFakes({ member: director(), revision: comment });
  const commentResult = await build({ fakes: commentFakes })
    .tool('rein_mvp_revision_approve')
    .execute('call-3', { revisionId: REVISION });
  assert.equal(commentResult.details.error, 'revision_is_comment');
  assert.deepEqual(commentFakes.calls.approveProposalRevision, []);

  const applied = revisionRecord({ version: 2 });
  const appliedFakes = createFakes({ member: director(), revision: applied });
  const appliedResult = await build({ fakes: appliedFakes })
    .tool('rein_mvp_revision_approve')
    .execute('call-4', { revisionId: REVISION });
  assert.equal(appliedResult.details.error, 'revision_already_applied');
  assert.deepEqual(appliedFakes.calls.approveProposalRevision, []);
});

// ---------------------------------------------------------------------------------------------
// Scope, identity and argument refusals
// ---------------------------------------------------------------------------------------------

test('a non-director cannot comment, suggest, approve or apply', async () => {
  for (const [name, args] of [
    ['rein_mvp_proposal_comment_suggest', { proposalId: PROPOSAL, note: 'Note' }],
    ['rein_mvp_proposal_comment_suggest', { proposalId: PROPOSAL, changedFields: ['title'], title: 'T', note: 'N' }],
    ['rein_mvp_revision_approve', { revisionId: REVISION }],
    ['rein_mvp_revision_apply', { revisionId: REVISION }],
  ]) {
    const fakes = createFakes({ member: contributor({ isActiveContributor: true }) });
    const result = await build({ fakes }).tool(name).execute('call-1', args);
    assert.equal(result.details.ok, false, name);
    assert.equal(result.details.error, 'board_membership_required', name);
    assert.deepEqual(fakes.calls.recordProposalRevision, [], name);
    assert.deepEqual(fakes.calls.approveProposalRevision, [], name);
    assert.deepEqual(fakes.calls.applyProposalRevision, [], name);
  }
});

test('feedback on a proposal that did not pass is refused before any write', async () => {
  for (const status of ['submitted', 'unselected', 'withdrawn']) {
    const proposal = proposalRecord({ status });
    const commentFakes = createFakes({ member: director(), proposal });
    const comment = await build({ fakes: commentFakes })
      .tool('rein_mvp_proposal_comment_suggest')
      .execute('call-1', { proposalId: PROPOSAL, note: 'Note' });
    assert.equal(comment.details.error, 'proposal_not_selected', status);
    assert.deepEqual(commentFakes.calls.recordProposalRevision, [], status);

    const revisionFakes = createFakes({
      member: director(),
      proposal,
      revision: revisionRecord({ changedFields: ['title'] }),
    });
    const applied = await build({ fakes: revisionFakes })
      .tool('rein_mvp_revision_apply')
      .execute('call-2', { revisionId: REVISION });
    assert.equal(applied.details.error, 'proposal_not_selected', status);
    assert.deepEqual(revisionFakes.calls.applyProposalRevision, [], status);

    const approveFakes = createFakes({
      member: director(),
      proposal,
      revision: revisionRecord({ changedFields: ['budget'] }),
    });
    const approve = await build({ fakes: approveFakes })
      .tool('rein_mvp_revision_approve')
      .execute('call-3', { revisionId: REVISION });
    assert.equal(approve.details.error, 'proposal_not_selected', status);
    assert.deepEqual(approveFakes.calls.approveProposalRevision, [], status);
  }
});

test('a feedback tool refuses an unlinked account, an unknown account and a revoked link', async () => {
  for (const [member, code] of [
    [{ ...contributor({ contactId: null }), status: 'identity_not_linked', isActiveContributor: false }, 'identity_link_required'],
    [{ status: 'identity_link_ambiguous', reason: 'ambiguous', contactId: null, isActiveContributor: false, isDirector: false, httpStatus: null }, 'identity_link_required'],
    [{ status: 'identity_link_revoked', reason: 'revoked', contactId: null, isActiveContributor: false, isDirector: false, httpStatus: null }, 'identity_link_required'],
  ]) {
    const fakes = createFakes({ member });
    const result = await build({ fakes }).tool('rein_mvp_revision_apply').execute('call-1', { revisionId: REVISION });
    assert.equal(result.details.error, code);
    assert.deepEqual(fakes.calls.applyProposalRevision, []);
  }
});

test('a linked active Contributor who is not a director cannot leave feedback', async () => {
  const fakes = createFakes({ member: contributor({ isActiveContributor: true, isDirector: false }) });
  const result = await build({ fakes })
    .tool('rein_mvp_proposal_comment_suggest')
    .execute('call-1', { proposalId: PROPOSAL, note: 'Note' });
  assert.equal(result.details.error, 'board_membership_required');
  assert.deepEqual(fakes.calls.recordProposalRevision, []);
});

test('every tool refuses an out-of-scope platform, channel or missing sender before any call', async () => {
  for (const [name, args] of [
    ['rein_mvp_proposal_comment_suggest', { proposalId: PROPOSAL, note: 'Note' }],
    ['rein_mvp_revision_approve', { revisionId: REVISION }],
    ['rein_mvp_revision_apply', { revisionId: REVISION }],
  ]) {
    for (const [overrides, code] of [
      [{ messageChannel: 'discord' }, 'platform_out_of_scope'],
      [{ requesterSenderId: undefined }, 'trusted_requester_unavailable'],
      [{ nativeChannelId: 'C_OTHER' }, 'channel_out_of_scope'],
      [{ nativeChannelId: undefined }, 'channel_out_of_scope'],
      [{ messageChannel: undefined }, 'platform_out_of_scope'],
    ]) {
      const fakes = createFakes();
      const { tool } = build({ fakes, ctx: overrides });
      const result = await tool(name).execute('call-1', args);
      assert.equal(result.details.ok, false, `${name} ${code}`);
      assert.equal(result.details.error, code, `${name} ${code}`);
      assert.deepEqual(fakes.calls.getProposal, []);
      assert.deepEqual(fakes.calls.getRevision, []);
      assert.deepEqual(fakes.calls.recordProposalRevision, []);
      assert.deepEqual(fakes.calls.approveProposalRevision, []);
      assert.deepEqual(fakes.calls.applyProposalRevision, []);
      assert.deepEqual(fakes.calls.member, [], `${name} resolves no identity outside its scope`);
    }
  }
});

test('every feedback tool is limited to the Board channel', async () => {
  for (const [name, args] of [
    ['rein_mvp_proposal_comment_suggest', { proposalId: PROPOSAL, note: 'Note' }],
    ['rein_mvp_revision_approve', { revisionId: REVISION }],
    ['rein_mvp_revision_apply', { revisionId: REVISION }],
  ]) {
    const fakes = createFakes({ member: director() });
    const refused = await build({ fakes, channel: PROPOSAL_CHANNEL }).tool(name).execute('call-1', args);
    assert.equal(refused.details.error, 'channel_out_of_scope', name);
    assert.deepEqual(fakes.calls.member, [], `${name} resolves no identity outside the Board channel`);
  }
});

test('a missing or stale host invocation guard produces no write and no apply', async () => {
  const noGuard = createFakes({ member: director() });
  const comment = await build({
    fakes: noGuard,
    ctx: { assertInvocationCurrent: undefined },
  })
    .tool('rein_mvp_proposal_comment_suggest')
    .execute('call-1', { proposalId: PROPOSAL, note: 'Note' });
  assert.equal(comment.details.error, 'current_invocation_guard_unavailable');
  assert.deepEqual(noGuard.calls.recordProposalRevision, []);

  const stale = createFakes({
    member: director(),
    revision: revisionRecord({ changedFields: ['title'] }),
  });
  const applied = await build({
    fakes: stale,
    ctx: {
      assertInvocationCurrent() {
        throw Object.assign(new Error('turn closed'), { code: 'invocation_not_current' });
      },
    },
  })
    .tool('rein_mvp_revision_apply')
    .execute('call-2', { revisionId: REVISION });
  assert.equal(applied.details.error, 'invocation_not_current');
  assert.deepEqual(stale.calls.applyProposalRevision, [], 'a stale turn cannot apply a revision');

  const approveFakes = createFakes({ member: director(), revision: revisionRecord({ changedFields: ['budget'] }) });
  const approve = await build({
    fakes: approveFakes,
    ctx: {
      assertInvocationCurrent() {
        throw Object.assign(new Error('turn closed'), { code: 'invocation_not_current' });
      },
    },
  })
    .tool('rein_mvp_revision_approve')
    .execute('call-3', { revisionId: REVISION });
  assert.equal(approve.details.error, 'invocation_not_current');
  assert.deepEqual(approveFakes.calls.approveProposalRevision, [], 'a stale turn cannot approve');
});

test('an actor, a role or a policy argument is refused and never reaches a write', async () => {
  for (const [name, args] of [
    ['rein_mvp_proposal_comment_suggest', { proposalId: PROPOSAL, note: 'n', authorContactId: OTHER_CONTACT }],
    ['rein_mvp_proposal_comment_suggest', { proposalId: PROPOSAL, note: 'n', role: 'director' }],
    ['rein_mvp_proposal_comment_suggest', { proposalId: PROPOSAL, note: 'n', material: false }],
    ['rein_mvp_revision_approve', { revisionId: REVISION, approverContactId: OTHER_CONTACT }],
    ['rein_mvp_revision_approve', { revisionId: REVISION, isDirector: true }],
    ['rein_mvp_revision_apply', { revisionId: REVISION, approved: true }],
    ['rein_mvp_revision_apply', { revisionId: REVISION, version: 99 }],
    ['rein_mvp_revision_apply', { revisionId: REVISION, skipApproval: true }],
  ]) {
    const fakes = createFakes({ member: director() });
    for (const channel of [BOARD_CHANNEL]) {
      const result = await build({ fakes, channel }).tool(name).execute('call-1', args);
      assert.equal(result.details.ok, false, `${name} ${Object.keys(args).join(',')}`);
      assert.ok(
        ['actor_argument_rejected', 'policy_argument_rejected'].includes(result.details.error),
        `${name} ${result.details.error}`,
      );
    }
    assert.deepEqual(fakes.calls.recordProposalRevision, []);
    assert.deepEqual(fakes.calls.approveProposalRevision, []);
    assert.deepEqual(fakes.calls.applyProposalRevision, []);
  }
});

test('the acting account is never taken from an argument', async () => {
  const fakes = createFakes({ member: director({ contactId: OTHER_CONTACT }) });
  const result = await build({ fakes })
    .tool('rein_mvp_proposal_comment_suggest')
    .execute('call-1', { proposalId: PROPOSAL, note: 'Mine', author: CONTACT });
  assert.equal(result.details.error, 'actor_argument_rejected');
  assert.deepEqual(fakes.calls.recordProposalRevision, []);

  const resolved = createFakes({ member: director({ contactId: OTHER_CONTACT }) });
  await build({ fakes: resolved })
    .tool('rein_mvp_proposal_comment_suggest')
    .execute('call-2', { proposalId: PROPOSAL, note: 'Mine' });
  assert.equal(
    resolved.calls.recordProposalRevision[0].authorContactId,
    OTHER_CONTACT,
    'the author is the resolved sender record',
  );
});

// ---------------------------------------------------------------------------------------------
// Output hygiene
// ---------------------------------------------------------------------------------------------

test('no tool result leaks a private contact id, the team id, a credential or the proposal author', async () => {
  const commentFakes = createFakes({ member: director() });
  const comment = build({ fakes: commentFakes });
  const boardFakes = createFakes({
    member: director(),
    revision: revisionRecord({
      changedFields: ['budget'],
      title: null,
      requestedMinor: 1000,
      currency: 'USD',
      approvedByContactId: OTHER_CONTACT,
      approvedAt: APPROVED_AT,
    }),
  });
  const board = build({ fakes: boardFakes });
  const outputs = [
    await comment.tool('rein_mvp_proposal_comment_suggest').execute('call-1', {
      proposalId: PROPOSAL,
      note: 'A note',
    }),
    await board.tool('rein_mvp_revision_approve').execute('call-2', { revisionId: REVISION }),
    await board.tool('rein_mvp_revision_apply').execute('call-3', { revisionId: REVISION }),
  ];
  const serialized = JSON.stringify(outputs.map(output => output.details));
  for (const secret of [CONTACT, OTHER_CONTACT, TEAM, SECRET, 'project-ref.supabase.co', SENDER]) {
    assert.ok(!serialized.includes(secret), `the result must not include ${secret}`);
  }
  assert.ok(!serialized.includes('contactId'));
  assert.ok(!serialized.toLowerCase().includes('authorizesspending": true'));
  assert.ok(!serialized.includes(URL_ENV));
  assert.ok(!serialized.includes(KEY_ENV));
});

test('an unavailable provider is never reported as a missing proposal or revision', async () => {
  const proposalFakes = createFakes({
    member: director(),
    inserts: {
      getProposal: async () => ({ ok: false, status: 'unavailable', reason: 'transport_error', proposal: null, httpStatus: null }),
    },
  });
  const comment = await build({ fakes: proposalFakes })
    .tool('rein_mvp_proposal_comment_suggest')
    .execute('call-1', { proposalId: PROPOSAL, note: 'Note' });
  assert.equal(comment.details.error, 'proposal_lookup_unavailable');
  assert.deepEqual(proposalFakes.calls.recordProposalRevision, []);

  const revisionFakes = createFakes({
    member: director(),
    inserts: {
      getRevision: async () => ({ ok: false, status: 'unavailable', reason: 'transport_error', revision: null, httpStatus: null }),
    },
  });
  const applied = await build({ fakes: revisionFakes })
    .tool('rein_mvp_revision_apply')
    .execute('call-2', { revisionId: REVISION });
  assert.equal(applied.details.error, 'revision_lookup_unavailable');
  assert.deepEqual(revisionFakes.calls.applyProposalRevision, []);
});

test('a database refusal is reported with its own reason code, never as success', async () => {
  const commentFakes = createFakes({
    member: director(),
    inserts: {
      recordProposalRevision: async () => ({
        ok: false,
        status: 'rejected',
        reason: 'revision_rejected',
        revision: null,
        httpStatus: 403,
      }),
    },
  });
  const comment = await build({ fakes: commentFakes })
    .tool('rein_mvp_proposal_comment_suggest')
    .execute('call-1', { proposalId: PROPOSAL, note: 'Note' });
  assert.equal(comment.details.ok, false);
  assert.equal(comment.details.error, 'revision_rejected');
  assert.equal(comment.details.recorded, false);
  assert.equal(comment.details.authorizesSpending, false);

  const applyFakes = createFakes({
    member: director(),
    revision: revisionRecord({ changedFields: ['title'] }),
    inserts: {
      applyProposalRevision: async () => ({
        ok: false,
        status: 'rejected',
        reason: 'revision_apply_rejected',
        version: null,
        httpStatus: 403,
      }),
    },
  });
  const applied = await build({ fakes: applyFakes }).tool('rein_mvp_revision_apply').execute('call-2', {
    revisionId: REVISION,
  });
  assert.equal(applied.details.ok, false);
  assert.equal(applied.details.error, 'revision_apply_rejected');
});

test('a same-turn retry of apply answers with the record it already wrote', async () => {
  const revision = revisionRecord({ changedFields: ['title'] });
  const fakes = createFakes({
    member: director(),
    revision,
    inserts: {
      applyProposalRevision: async () => ({
        ok: true,
        status: 'updated',
        reason: 'revision_applied',
        version: appliedRecord(revision),
        httpStatus: 200,
      }),
    },
  });
  const { tool, calls } = build({ fakes });
  const first = await tool('rein_mvp_revision_apply').execute('call-9', { revisionId: REVISION });
  const second = await tool('rein_mvp_revision_apply').execute('call-9', { revisionId: REVISION });
  assert.equal(first.details.version, second.details.version);
  assert.equal(calls.applyProposalRevision.length, 2, 'the retry reaches the same request');
  assert.deepEqual(calls.applyProposalRevision[0], calls.applyProposalRevision[1]);
});
