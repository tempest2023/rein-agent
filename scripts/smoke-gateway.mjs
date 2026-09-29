import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { environment } from './runtime-env.mjs';
const config = JSON.parse(readFileSync(environment().OPENCLAW_CONFIG_PATH, 'utf8'));
assert.equal(config.gateway.bind, 'loopback', 'Smoke test is limited to the local development gateway');
assert.equal(config.gateway.auth.mode, 'token');
assert.equal(typeof config.gateway.auth.token, 'string');

// The Rein plugin exposes three distinct tool surfaces. Which one is live is decided by the
// runtime config, so the smoke test derives the expected surface from the same config instead of
// hardcoding one mode. The register entry mirrors plugins/rein-operations/index.ts exactly.
const register = config.plugins?.entries?.['rein-operations'];
const pluginConfig = register?.config ?? {};
const mvpEnabled = Boolean(pluginConfig.foundationDb && typeof pluginConfig.foundationDb === 'object' && pluginConfig.foundationDb.enabled === true);
const proposalEnabled = Boolean(
  pluginConfig.proposalTools &&
    typeof pluginConfig.proposalTools === 'object' &&
    pluginConfig.proposalTools.enabled === true,
);
const MVP_READ_TOOL_NAMES = [
  'rein_member_status',
  'rein_funds',
  'rein_poll_candidates',
  'rein_vote_type_resolve',
];
const MVP_WRITE_TOOL_NAMES = [
  'rein_governance_proposal_submit',
  'rein_poll_open',
  'rein_poll_vote',
  'rein_poll_result',
];
const MVP_COLLECT_TOOL_NAMES = [
  'rein_proposal_collect',
];
const MVP_FEEDBACK_TOOL_NAMES = [
  'rein_proposal_comment_suggest',
  'rein_revision_approve',
  'rein_revision_apply',
];
const PROPOSAL_TOOL_NAMES = [
  'rein_proposal_create',
  'rein_proposal_revise',
  'rein_proposal_confirm',
  'rein_proposal_submit',
];
const expectedImplemented = mvpEnabled
  ? ['rein_status', ...MVP_READ_TOOL_NAMES, ...MVP_WRITE_TOOL_NAMES, ...MVP_COLLECT_TOOL_NAMES, ...MVP_FEEDBACK_TOOL_NAMES]
  : ['rein_status', 'rein_simulate_vote', 'rein_simulate_proposal', ...(proposalEnabled ? PROPOSAL_TOOL_NAMES : [])];

const response = await fetch(`http://127.0.0.1:${config.gateway.port}/tools/invoke`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.gateway.auth.token}` },
  body: JSON.stringify({ tool: 'rein_status', args: {} }),
  signal: AbortSignal.timeout(15000),
});
assert.equal(response.status, 200, 'Start the local gateway and confirm rein_status is allowed');
const body = await response.json();
assert.equal(body.ok, true);
assert.equal(body.result.details.automationEnabled, false);
assert.deepEqual(
  body.result.details.implemented,
  expectedImplemented,
  `rein_status must report the ${mvpEnabled ? 'MVP' : proposalEnabled ? 'proposal' : 'default legacy'} tool surface`,
);
// Mode-specific invariants keep the tool surface unambiguous: MVP hides the simulators and the
// legacy proposal tools, and the default entry keeps them while reporting MVP features off.
assert.equal(body.result.details.foundationDbReadToolsEnabled, mvpEnabled);
assert.equal(body.result.details.foundationDbWriteToolsEnabled, mvpEnabled);
assert.equal(body.result.details.foundationDbCollectToolsEnabled, mvpEnabled);
assert.equal(body.result.details.foundationDbFeedbackToolsEnabled, mvpEnabled);
assert.equal(body.result.details.proposalToolsEnabled, proposalEnabled && !mvpEnabled);
assert.equal(body.result.details.formalProposalActionsEnabled, false);
const surface = mvpEnabled ? 'MVP' : proposalEnabled ? 'legacy proposal' : 'default legacy/simulation';
console.log(
  `Live gateway verified (${surface} surface): authenticated rein_status invocation succeeded; ${body.result.details.implemented.length} tools reported; no business automation enabled.`,
);
