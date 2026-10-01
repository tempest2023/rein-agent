import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin from '../plugins/rein-operations/index.ts';

test('real SDK entry registers declared tools and reports no active operations', async () => {
  const registered = [];
  const manifest = JSON.parse(readFileSync(new URL('../plugins/rein-operations/openclaw.plugin.json', import.meta.url)));
  plugin.register({ registerTool(tool) { registered.push(tool); } });
  assert.equal(plugin.id, manifest.id);
  assert.deepEqual(registered.map(t => t.name), manifest.contracts.tools.slice(0, 3));
  assert.equal(registered.length, 3);
  const result = await registered[0].execute('test', {});
  assert.equal(result.details.automationEnabled, false);
  assert.deepEqual(result.details.implemented, ['rein_status', 'rein_simulate_vote', 'rein_simulate_proposal']);
  assert.ok(Object.values(result.details.integrations).every(value => value === 'not-connected'));
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
});

test('proposal tools register only with explicit one-platform configuration and bind to v2 context', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../plugins/rein-operations/openclaw.plugin.json', import.meta.url)));
  const dir = mkdtempSync(join(tmpdir(), 'rein-plugin-proposals-'));
  try {
    const registrations = [];
    plugin.register({
      registrationMode: 'full',
      pluginConfig: { proposalTools: { enabled: true, platform: 'discord', allowedNativeChannelIds: ['proposal-room'], statePath: join(dir, 'state.json') } },
      registerTool(tool, options) { registrations.push({ tool, options }); },
    });
    const proposal = registrations.find(entry => entry.tool.contextVersion === 2);
    assert.ok(proposal);
    const status = registrations.find(entry => entry.tool.name === 'rein_status');
    const statusResult = await status.tool.execute('status-call', {});
    assert.equal(statusResult.details.proposalToolsEnabled, true);
    assert.equal(statusResult.details.integrations.chat, 'host-context-only');
    assert.equal(statusResult.details.formalProposalActionsEnabled, false);
    assert.equal(statusResult.details.integrations.memberRegistry, 'not-connected');
    assert.equal(statusResult.details.automationEnabled, false);
    assert.deepEqual(proposal.options.names, manifest.contracts.tools.slice(3, 7));
    const tools = proposal.tool.create({
      messageChannel: 'discord', nativeChannelId: 'proposal-room', requesterSenderId: 'sender-1',
      assertInvocationCurrent() {},
    });
    assert.deepEqual(tools.map(tool => tool.name), manifest.contracts.tools.slice(3, 7));
    const created = await tools[0].execute('call-1', { fields: { title: 'Draft event' } });
    assert.equal(created.details.ok, true);
    assert.equal(created.details.result.proposal.ownerAccount.accountId, 'sender-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enabled proposal tools reject incomplete or ambiguous runtime configuration', () => {
  const registerTool = () => {};
  for (const proposalTools of [
    { enabled: true, platform: 'discord', allowedNativeChannelIds: [], statePath: '/tmp/proposals.json' },
    { enabled: true, platform: 'telegram', allowedNativeChannelIds: ['room'], statePath: '/tmp/proposals.json' },
    { enabled: true, platform: 'slack', allowedNativeChannelIds: ['room'], statePath: 'relative.json' },
  ]) {
    assert.throws(() => plugin.register({ pluginConfig: { proposalTools }, registerTool }), /require one platform/);
  }
});

test('governance simulation rejects missing rules without recording official votes', async () => {
  const registered = [];
  plugin.register({ registerTool(tool) { registered.push(tool); } });
  const tool = registered.find(item => item.name === 'rein_simulate_vote');
  const result = await tool.execute('test', { roundJson: JSON.stringify({ roster: [], proposals: [], roundId: 'R' }), ballotsJson: '[]' });
  assert.equal(result.details.simulationOnly, true);
  assert.match(result.details.error, /rules/);
});

test('governance simulation runs explicit synthetic rules through the real plugin tool', async () => {
  const registered = [];
  plugin.register({ registerTool(tool) { registered.push(tool); } });
  const tool = registered.find(item => item.name === 'rein_simulate_vote');
  const round = {
    roundId: 'synthetic-round', rules: {
      rulesVersion: 'synthetic-policy',
      participation: { minMemberFraction: { numerator: 1, denominator: 2 }, minWeightFraction: { numerator: 1, denominator: 2 } },
      approval: { strictMajorityFraction: { numerator: 1, denominator: 2 }, requireNonAbstainingVote: true },
      tie: { outcome: 'not_passed' }, voteReplacement: { allowed: true }, allocation: { rule: 'no_auto_allocation' },
    },
    opensAt: '2026-09-01T00:00:00Z', closesAt: '2026-09-01T00:45:00Z', currency: 'USD', budgetAvailableMinor: 0,
    roster: [{ memberId: 'm1', weight: 3 }, { memberId: 'm2', weight: 2 }, { memberId: 'm3', weight: 1 }],
    proposals: [{ proposalId: 'p1', version: 'v1', leadMemberId: 'lead', requestedAmountMinor: 0 }],
  };
  const ballots = [
    { proposalId: 'p1', memberId: 'm1', choice: 'approve', castAt: '2026-09-01T00:10:00Z' },
    { proposalId: 'p1', memberId: 'm2', choice: 'reject', castAt: '2026-09-01T00:11:00Z' },
  ];
  const result = await tool.execute('test', { roundJson: JSON.stringify(round), ballotsJson: JSON.stringify(ballots) });
  assert.equal(result.details.simulationOnly, true);
  assert.deepEqual(result.details.receipts.map(receipt => receipt.accepted), [true, true]);
  assert.equal(result.details.result.proposals[0].status, 'passed');
});

test('proposal simulation identifies missing information and never authorizes approval', async () => {
  const registered = [];
  plugin.register({ registerTool(tool) { registered.push(tool); } });
  const tool = registered.find(item => item.name === 'rein_simulate_proposal');
  const missing = await tool.execute('test', { fieldsJson: JSON.stringify({ title: 'Campus discussion' }), now: '2026-09-23T00:00:00Z' });
  assert.equal(missing.details.simulationOnly, true);
  assert.equal(missing.details.route.path, 'needs_information');
  const fields = {
    title: 'Campus discussion', eventType: 'reading_group', purpose: 'Study AI safety', audience: 'Students', format: 'in_person',
    schedule: { startAt: '2026-10-10T18:00:00Z', timeZone: 'America/Los_Angeles', durationMinutes: 90 },
    location: { venue: 'Room 204', venueConfirmed: true }, capacity: { expectedAttendance: 15, registration: 'open' },
    program: { agenda: 'Two papers' }, fees: { charged: false },
    budget: { requestedAmountMinor: 0, reimbursementExpected: false, hiddenCostsConfirmed: true, contractualCommitments: false },
    risks: { notes: 'None known' }, deliverables: { summary: true, photoRestrictions: 'no_photos' },
  };
  const complete = await tool.execute('test', { fieldsJson: JSON.stringify(fields), now: '2026-09-23T00:00:00Z' });
  assert.equal(complete.details.completeness.complete, true);
  assert.equal(complete.details.route.path, 'needs_exception');
  assert.equal(complete.details.route.reason, 'zero_budget_policy_not_authorized');
});

test('governance mode registers the database-backed read tools instead of the simulators and legacy proposal tools', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../plugins/rein-operations/openclaw.plugin.json', import.meta.url)));
  const dir = mkdtempSync(join(tmpdir(), 'rein-plugin-governance-'));
  process.env.REIN_TEST_GOVERNANCE_BACKEND_URL = 'https://rein.example.org';
  process.env.REIN_TEST_GOVERNANCE_CALLER_ID = 'rein-agent';
  process.env.REIN_TEST_GOVERNANCE_CREDENTIAL = 'plugin-test-agent-credential-0000000000';
  process.env.REIN_TEST_GOVERNANCE_CONFIRMATION_KEY = 'plugin-test-proposal-confirmation-key-0001';
  try {
    const registrations = [];
    plugin.register({
      registrationMode: 'full',
      pluginConfig: {
        foundationDb: {
          enabled: true,
          platform: 'slack',
          workspaces: [
            { platform: 'slack', workspaceId: 'T0123456ABC', nativeChannelIds: ['C_PROPOSAL', 'C_BOARD'] },
          ],
          backendApiBaseUrlEnvVar: 'REIN_TEST_GOVERNANCE_BACKEND_URL',
          agentCallerIdEnvVar: 'REIN_TEST_GOVERNANCE_CALLER_ID',
          agentCredentialEnvVar: 'REIN_TEST_GOVERNANCE_CREDENTIAL',
          proposalChannelIds: ['C_PROPOSAL'],
          boardChannelIds: ['C_BOARD'],
          proposalConfirmationKeyEnvVar: 'REIN_TEST_GOVERNANCE_CONFIRMATION_KEY',
        },
        // Configured but superseded: governance mode exposes the real read slice, not local rehearsals.
        proposalTools: { enabled: true, platform: 'slack', allowedNativeChannelIds: ['C_PROPOSAL'], statePath: join(dir, 'state.json') },
      },
      registerTool(tool, options) { registrations.push({ tool, options }); },
    });

    assert.deepEqual(registrations.map(entry => entry.tool.name ?? entry.options.names.join(',')), [
      'rein_member_status,rein_funds,rein_poll_candidates,rein_vote_type_resolve',
      'rein_governance_proposal_submit,rein_poll_open,rein_poll_vote,rein_poll_result',
      'rein_proposal_collect',
      'rein_proposal_comment_suggest,rein_revision_approve,rein_revision_apply',
      'rein_identity_bind_start,rein_identity_bind_complete',
      'rein_status',
    ]);
    const governance = registrations.find(entry => entry.options?.names?.includes('rein_member_status'));
    assert.equal(governance.tool.contextVersion, 2);
    assert.deepEqual(governance.tool.create({
      messageChannel: 'slack',
      nativeChannelId: 'C_BOARD',
      requesterSenderId: 'U0123456ABC',
      assertInvocationCurrent() {},
    }).map(tool => tool.name), ['rein_member_status', 'rein_funds', 'rein_poll_candidates', 'rein_vote_type_resolve']);
    assert.deepEqual(governance.options.names, manifest.contracts.tools.slice(7, 11));

    const writes = registrations.find(entry => entry.options?.names?.includes('rein_poll_open'));
    assert.ok(writes, 'governance mode must register the write tools');
    assert.equal(writes.tool.contextVersion, 2);
    assert.deepEqual(writes.options.names, manifest.contracts.tools.slice(11, 15));
    assert.deepEqual(writes.tool.create({
      messageChannel: 'slack',
      nativeChannelId: 'C_BOARD',
      requesterSenderId: 'U0123456ABC',
      assertInvocationCurrent() {},
    }).map(tool => tool.name), [...writes.options.names]);

    // Multi-turn field collection registers from the same explicit block and is read-only.
    const collect = registrations.find(entry => entry.options?.names?.includes('rein_proposal_collect'));
    assert.ok(collect, 'governance mode must register the field-collection tool');
    assert.equal(collect.tool.contextVersion, 2);
    assert.deepEqual(collect.tool.create({
      messageChannel: 'slack',
      nativeChannelId: 'C_PROPOSAL',
      requesterSenderId: 'U0123456ABC',
      assertInvocationCurrent() {},
    }).map(tool => tool.name), ['rein_proposal_collect']);
    assert.deepEqual(collect.options.names, manifest.contracts.tools.slice(15, 16));

    // Post-result feedback registers from the same explicit block, with its own v2 factory.
    const feedback = registrations.find(entry => entry.options?.names?.includes('rein_revision_apply'));
    assert.ok(feedback, 'governance mode must register the post-result feedback tools');
    assert.equal(feedback.tool.contextVersion, 2);
    // Select by the feedback surface's own names rather than by manifest position, so a tool
    // appended to the manifest later cannot silently widen or shift this assertion.
    assert.deepEqual(
      feedback.options.names,
      manifest.contracts.tools.filter(name =>
        ['rein_proposal_comment_suggest', 'rein_revision_approve', 'rein_revision_apply'].includes(name),
      ),
    );
    assert.deepEqual(feedback.tool.create({
      messageChannel: 'slack',
      nativeChannelId: 'C_BOARD',
      requesterSenderId: 'U0123456ABC',
      sessionId: 'S0SESSION',
      assertInvocationCurrent() {},
    }).map(tool => tool.name), [
      'rein_proposal_comment_suggest',
      'rein_revision_approve',
      'rein_revision_apply',
    ]);

    // Identity binding registers from the same explicit block, through the same wrapped runtime.
    const identity = registrations.find(entry => entry.options?.names?.includes('rein_identity_bind_start'));
    assert.ok(identity, 'governance mode must register the identity bind tools');
    assert.equal(identity.tool.contextVersion, 2);
    assert.deepEqual(identity.options.names, [
      'rein_identity_bind_start',
      'rein_identity_bind_complete',
    ]);
    assert.deepEqual(identity.tool.create({
      sessionId: 'S0SESSION',
      messageChannel: 'slack',
      nativeChannelId: 'C_PROPOSAL',
      requesterSenderId: 'U0123456ABC',
      assertInvocationCurrent() {},
    }).map(tool => tool.name), [
      'rein_identity_bind_start',
      'rein_identity_bind_complete',
    ]);

    const status = registrations.find(entry => entry.tool.name === 'rein_status');
    const result = await status.tool.execute('status-call', {});
    assert.deepEqual(result.details.implemented, [
      'rein_status', 'rein_member_status', 'rein_funds',
      'rein_poll_candidates', 'rein_vote_type_resolve',
      'rein_governance_proposal_submit', 'rein_poll_open', 'rein_poll_vote', 'rein_poll_result',
      'rein_proposal_collect',
      'rein_proposal_comment_suggest', 'rein_revision_approve', 'rein_revision_apply',
      'rein_identity_bind_start', 'rein_identity_bind_complete',
    ]);
    assert.equal(result.details.foundationDbReadToolsEnabled, true);
    assert.equal(result.details.foundationDbWriteToolsEnabled, true);
    assert.equal(result.details.foundationDbCollectToolsEnabled, true);
    assert.equal(result.details.foundationDbFeedbackToolsEnabled, true);
    assert.equal(result.details.identityBindToolsEnabled, true);
    assert.equal(result.details.proposalToolsEnabled, false);
    assert.equal(result.details.automationEnabled, false);
    assert.equal(result.details.formalProposalActionsEnabled, false);
    assert.equal(result.details.integrations.chat, 'host-context-only');
    assert.equal(result.details.integrations.memberRegistry, 'backend-read-only');
    assert.equal(result.details.integrations.finance, 'backend-snapshot-read-only');
    assert.equal(result.details.integrations.identityBinding, 'backend-host-context-only');
    assert.ok(!result.content[0].text.includes('plugin-test-agent-credential-0000000000'));
    assert.ok(!result.content[0].text.includes('REIN_TEST_GOVERNANCE_CREDENTIAL'));
  } finally {
    delete process.env.REIN_TEST_GOVERNANCE_BACKEND_URL;
    delete process.env.REIN_TEST_GOVERNANCE_CALLER_ID;
    delete process.env.REIN_TEST_GOVERNANCE_CREDENTIAL;
    delete process.env.REIN_TEST_GOVERNANCE_CONFIRMATION_KEY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('governance mode refuses to load with an incomplete block or an unset referenced variable', () => {
  const registerTool = () => {};
  const base = {
    enabled: true,
    platform: 'slack',
    workspaces: [
      { platform: 'slack', workspaceId: 'T0123456ABC', nativeChannelIds: ['C_PROPOSAL', 'C_BOARD'] },
    ],
    backendApiBaseUrlEnvVar: 'REIN_TEST_GOVERNANCE_BACKEND_URL',
    agentCallerIdEnvVar: 'REIN_TEST_GOVERNANCE_CALLER_ID',
    agentCredentialEnvVar: 'REIN_TEST_GOVERNANCE_CREDENTIAL',
    proposalChannelIds: ['C_PROPOSAL'],
    boardChannelIds: ['C_BOARD'],
  };
  assert.throws(
    () => plugin.register({ pluginConfig: { foundationDb: { ...base, workspaces: [] } }, registerTool }),
    /workspaces must list at least one/,
  );
  // The backend names server environment variables; without them nothing registers silently.
  assert.throws(
    () => plugin.register({ pluginConfig: { foundationDb: { ...base, agentCredentialEnvVar: 'not a variable' } }, registerTool }),
    /must name a server environment variable/,
  );
  process.env.REIN_TEST_GOVERNANCE_BACKEND_URL = 'https://rein.example.org';
  process.env.REIN_TEST_GOVERNANCE_CALLER_ID = 'rein-agent';
  assert.throws(
    () => plugin.register({
      pluginConfig: { foundationDb: { ...base, agentCredentialEnvVar: 'REIN_TEST_ABSENT_CREDENTIAL' } },
      registerTool,
    }),
    error =>
      error.code === 'foundation_db_env_value_missing' &&
      error.message.includes('REIN_TEST_ABSENT_CREDENTIAL'),
  );
  delete process.env.REIN_TEST_GOVERNANCE_BACKEND_URL;
  delete process.env.REIN_TEST_GOVERNANCE_CALLER_ID;
  // The retired Supabase and Slack keys are operator errors, not silently ignored options.
  assert.throws(
    () => plugin.register({
      pluginConfig: { foundationDb: { ...base, slackTeamId: 'T0123456ABC' } },
      registerTool,
    }),
    /no longer accepted/,
  );
});
