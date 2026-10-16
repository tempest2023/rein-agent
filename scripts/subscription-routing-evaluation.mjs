import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../plugins/rein-router/runtime.mjs';
import { validateRouterConfig } from '../plugins/rein-router/policy.mjs';

export const evaluationDatasetPath = fileURLToPath(new URL('../evals/subscription-routing.v1.json', import.meta.url));
const TASKS = ['simple', 'contextual', 'research', 'coding', 'complex'];
const LABEL_REVIEW_STATUSES = ['operator-review-pending', 'operator-reviewed'];
const ID = /^[a-z][a-z0-9-]{0,95}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,159}$/;
const REASONS = ['credentials-unavailable', 'authentication', 'rate-limited', 'transport', 'unsupported-input',
  'invalid-response', 'disabled', 'not-configured', 'retiring', 'overloaded', 'circuit-open', 'deadline'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const probability = value => number(value) && value <= 1;
const economical = route => ['off', 'low'].includes(route?.effort);
const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
function invalid() { throw new Error('subscription_evaluation_invalid'); }
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function text(value, max = 1000, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) invalid();
}

/** The checked-in catalog is a synthetic decision rubric, never an inference configuration. */
export function validateEvaluationDataset(raw) {
  keys(raw, ['schemaVersion', 'id', 'rubricVersion', 'provenance', 'reviewStatus', 'limitations', 'config', 'cases']);
  if (raw.schemaVersion !== 1 || !ID.test(raw.id) || raw.rubricVersion !== 'rein-subscriptions-v1' ||
      !LABEL_REVIEW_STATUSES.includes(raw.reviewStatus)) invalid();
  text(raw.provenance, 2000);
  if (!Array.isArray(raw.limitations) || !raw.limitations.length) invalid();
  raw.limitations.forEach(value => text(value, 1000));
  const config = validateRouterConfig(raw.config);
  if (!config.enabled || config.gateway.managed || config.allowPaidUsage || !config.gateway.subscriptionOnly ||
      !config.decision.allowPaidJev || config.fallbackRoutes.length || config.routes.some(route =>
        !route.gatewayModel.startsWith('evaluation/') || route.billingMode !== 'subscription')) invalid();
  if (!Array.isArray(raw.cases) || !raw.cases.length || raw.cases.length > 256) invalid();
  const ids = new Set();
  for (const item of raw.cases) {
    keys(item, ['id', 'split', 'category', 'tags', 'prompt', 'priorContext', 'input', 'expected', 'rubric']);
    if (!ID.test(item.id) || ids.has(item.id) || !['development', 'holdout'].includes(item.split) ||
        ![...TASKS, 'control'].includes(item.category)) invalid();
    ids.add(item.id);
    text(item.prompt, 32000, true);
    if (!Array.isArray(item.tags) || item.tags.length > 16 || item.tags.some(tag => !ID.test(tag))) invalid();
    if (!Array.isArray(item.priorContext) || item.priorContext.length > 16) invalid();
    item.priorContext.forEach(value => text(value, 4000));
    keys(item.input, ['channel', 'identity', 'model', 'attachments']);
    if (!['discord', 'slack', 'telegram'].includes(item.input.channel) ||
        !['member', 'admin', 'other-account'].includes(item.input.identity) ||
        !['auto', ...config.routes.map(route => route.id)].includes(item.input.model) ||
        typeof item.input.attachments !== 'boolean') invalid();
    keys(item.expected, ['taskLabels', 'contextIndependent', 'routing', 'evaluate']);
    if (!Array.isArray(item.expected.taskLabels) || item.expected.taskLabels.length > TASKS.length ||
        new Set(item.expected.taskLabels).size !== item.expected.taskLabels.length ||
        item.expected.taskLabels.some(task => !TASKS.includes(task)) ||
        ![true, false, null].includes(item.expected.contextIndependent) ||
        !['economical-preferred', 'capable-required', 'high-required', 'default-required', 'manual'].includes(item.expected.routing) ||
        typeof item.expected.evaluate !== 'boolean') invalid();
    const shouldEvaluate = item.input.model === 'auto' && config.channels.includes(item.input.channel) &&
      !item.input.attachments && Boolean(item.prompt.trim()) && item.prompt.length <= config.decision.maxPromptChars;
    if (item.expected.evaluate !== shouldEvaluate ||
        (item.expected.routing === 'manual') !== (item.input.model !== 'auto') ||
        (shouldEvaluate && !item.expected.taskLabels.length) ||
        (item.expected.routing === 'economical-preferred' &&
          (!item.expected.taskLabels.includes('simple') || item.expected.contextIndependent !== true))) invalid();
    if (!Array.isArray(item.rubric) || !item.rubric.length || item.rubric.length > 10) invalid();
    const rubricIds = new Set();
    for (const criterion of item.rubric) {
      keys(criterion, ['id', 'criterion']);
      if (!ID.test(criterion.id) || rubricIds.has(criterion.id)) invalid();
      rubricIds.add(criterion.id); text(criterion.criterion, 2000);
    }
  }
  // Preserve the serialized source exactly so annotations have a stable identity.
  return structuredClone(raw);
}

export function readEvaluationJson(path) {
  const limit = 4 * 1024 * 1024;
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > limit) invalid();
    const bytes = Buffer.alloc(limit + 1);
    let length = 0, count;
    do { count = readSync(descriptor, bytes, length, bytes.length - length); length += count; } while (count && length < bytes.length);
    if (length > limit) invalid();
    try { return JSON.parse(bytes.subarray(0, length).toString('utf8')); } catch { invalid(); }
  } finally { closeSync(descriptor); }
}
export const loadEvaluationDataset = (path = evaluationDatasetPath) => validateEvaluationDataset(readEvaluationJson(path));
export const datasetDigest = dataset => hash(validateEvaluationDataset(dataset));
export const evaluationPromptDigest = item => hash({ prompt: item.prompt, priorContext: item.priorContext });

/** Keep typed evidence only. Never serialize service errors, request bodies, headers or credentials. */
export function sanitizeDecisionOutcome(outcome) {
  if (!object(outcome)) invalid();
  if (outcome.status === 'unavailable' && REASONS.includes(outcome.reason))
    return { status: 'unavailable', reason: outcome.reason };
  if (outcome.status !== 'ok' || !object(outcome.result) || !MODEL.test(outcome.result.model) ||
      /sk-magpie-key|api.?key|secret|bearer/i.test(outcome.result.model)) invalid();
  keys(outcome.result.answers, ['route', 'task', 'contextIndependent']);
  const answers = {};
  for (const [id, answer] of Object.entries(outcome.result.answers)) {
    if (!object(answer)) invalid();
    if (id === 'contextIndependent') {
      if (answer.type !== 'boolean' || !probability(answer.probabilityTrue)) invalid();
      answers[id] = { type: 'boolean', probabilityTrue: answer.probabilityTrue };
    } else {
      if (answer.type !== 'choice' || !ID.test(answer.choice) || !object(answer.probabilities) ||
          Object.keys(answer.probabilities).length > 255 || Object.entries(answer.probabilities).some(([label, value]) =>
            !ID.test(label) || !probability(value))) invalid();
      answers[id] = { type: 'choice', choice: answer.choice, probabilities: { ...answer.probabilities } };
    }
  }
  const result = { model: outcome.result.model, answers };
  if (outcome.result.usage !== undefined) {
    keys(outcome.result.usage, ['inputTokens', 'outputTokens']);
    const usage = {};
    for (const [key, value] of Object.entries(outcome.result.usage)) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 1e12) invalid();
      usage[key] = value;
    }
    result.usage = usage;
  }
  return { status: 'ok', result };
}

const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};
const latency = values => ({ p50Ms: percentile(values, .5), p95Ms: percentile(values, .95) });
const routeAllowed = (dataset, item, selected) => {
  const route = dataset.config.routes.find(route => route.id === selected?.routeId);
  if (!route) return false;
  switch (item.expected.routing) {
    case 'manual': return route.id === item.input.model;
    case 'default-required': return route.id === dataset.config.defaultRoute;
    case 'high-required': return route.effort === 'high';
    case 'capable-required': return !economical(route);
    default: return true; // A capable answer is safe but misses the economical opportunity.
  }
};

export function scoreRoutingRecords(raw, records, { evidence = 'recorded-unverified' } = {}) {
  const dataset = validateEvaluationDataset(raw);
  if (!Array.isArray(records) || records.length > dataset.cases.length) invalid();
  const byId = new Map();
  for (const record of records) {
    if (!dataset.cases.some(item => item.id === record.caseId) || byId.has(record.caseId)) invalid();
    byId.set(record.caseId, record);
  }
  const semantic = evidence !== 'synthetic-policy';
  let safe = 0, eligible = 0, cheap = 0, trueCheap = 0, unsafe = 0, nonEligible = 0;
  let evaluated = 0, taskAnswered = 0, taskCorrect = 0, contextAnswered = 0, contextCorrect = 0;
  let brier = 0, uncertainty = 0, selectionFailures = 0, tokenCalls = 0, inputTokens = 0, outputTokens = 0;
  const categoryCounts = {}, splitCounts = {};
  for (const item of dataset.cases) {
    const record = byId.get(item.id);
    if (!record) continue;
    const allowed = routeAllowed(dataset, item, record.selection);
    safe += Number(allowed); selectionFailures += Number(record.rejected === true);
    for (const [groups, key] of [[categoryCounts, item.category], [splitCounts, item.split]]) {
      groups[key] ??= { cases: 0, acceptedRoutes: 0 };
      groups[key].cases++; groups[key].acceptedRoutes += Number(allowed);
    }
    if (item.input.model !== 'auto') continue;
    const route = dataset.config.routes.find(route => route.id === record.selection?.routeId);
    const isCheap = route && economical(route) && route.id !== dataset.config.defaultRoute;
    const isEligible = item.expected.routing === 'economical-preferred';
    eligible += Number(isEligible); nonEligible += Number(!isEligible);
    cheap += Number(Boolean(isCheap)); trueCheap += Number(isCheap && isEligible);
    unsafe += Number(isCheap && !isEligible);
    if (route?.id === dataset.config.defaultRoute &&
        ['low-probability', 'decision-unavailable', 'decision-invalid', 'context-required'].includes(record.selection?.reason)) uncertainty++;
    if (!record.evaluated) continue;
    evaluated++;
    const outcome = record.outcome && sanitizeDecisionOutcome(record.outcome);
    if (outcome?.status !== 'ok') continue;
    const task = outcome.result.answers.task;
    if (task && item.expected.taskLabels.length) {
      taskAnswered++; taskCorrect += Number(item.expected.taskLabels.includes(task.choice));
    }
    const context = outcome.result.answers.contextIndependent;
    if (context && item.expected.contextIndependent !== null) {
      contextAnswered++; contextCorrect += Number((context.probabilityTrue >= .5) === item.expected.contextIndependent);
      brier += (context.probabilityTrue - Number(item.expected.contextIndependent)) ** 2;
    }
    const usage = outcome.result.usage;
    if (Number.isSafeInteger(usage?.inputTokens) && Number.isSafeInteger(usage?.outputTokens)) {
      tokenCalls++; inputTokens += usage.inputTokens; outputTokens += usage.outputTokens;
    }
  }
  return {
    evidence, recordedCases: records.length, expectedCases: dataset.cases.length,
    coverage: ratio(records.length, dataset.cases.length),
    routing: { acceptedRoutes: safe, acceptanceRate: ratio(safe, records.length),
      economicalSelections: cheap, economicalEligibleCases: eligible,
      economicalPrecision: ratio(trueCheap, cheap), economicalRecall: ratio(trueCheap, eligible),
      unsafeEconomicalSelections: unsafe, unsafeEconomicalRate: ratio(unsafe, nonEligible),
      uncertaintyDefaults: uncertainty, selectionFailures, byCategory: categoryCounts, bySplit: splitCounts },
    labelReview: dataset.reviewStatus,
    classification: semantic ? { evaluatedCases: evaluated, taskAnswered, taskAccuracy: ratio(taskCorrect, taskAnswered),
      taskAnswerCoverage: ratio(taskAnswered, dataset.cases.filter(item => item.expected.evaluate && item.expected.taskLabels.length).length),
      contextAnswered, contextAccuracy: ratio(contextCorrect, contextAnswered), contextBrierScore: ratio(brier, contextAnswered),
      note: dataset.reviewStatus === 'operator-reviewed' ?
        'Agreement with operator-reviewed synthetic labels; this is not a traffic benchmark or demonstrated correctness guarantee.' :
        'Agreement with proposed, unreviewed synthetic labels; this is not a traffic benchmark or demonstrated correctness guarantee.' } : null,
    decisionUsage: semantic ? { evaluatedCalls: evaluated, callsWithCompleteUsage: tokenCalls,
      inputTokens: tokenCalls ? inputTokens : null, outputTokens: tokenCalls ? outputTokens : null,
      totalTokens: tokenCalls === evaluated && evaluated ? inputTokens + outputTokens : null } : null,
    routingLatency: latency(records.filter(record => number(record.elapsedMs)).map(record => record.elapsedMs)),
    generation: null,
  };
}

/** Executes only selection hooks. No stream function, model API, gateway or channel is invoked. */
export async function runRoutingEvaluation(raw, { decisions, evidence = 'synthetic-policy', signal } = {}) {
  const dataset = validateEvaluationDataset(raw);
  const records = [];
  for (const item of dataset.cases) {
    signal?.throwIfAborted();
    let outcome = null, evaluated = false, administrator = null;
    const router = createRouter({ config: dataset.config, decisions: { async evaluate(batch, options) {
      evaluated = true; administrator = batch.state.administrator;
      const result = decisions?.evaluate ? await decisions.evaluate(batch, { ...options,
        signal: signal ? AbortSignal.any([signal, options.signal]) : options.signal }, item) :
        { status: 'unavailable', reason: 'not-configured' };
      outcome = sanitizeDecisionOutcome(result);
      return result;
    } } });
    const context = { runId: `evaluation-${item.id}`, agentId: 'routing-eval', sessionKey: `evaluation:${item.id}`,
      modelProviderId: 'rein-magpie', modelId: item.input.model, channel: item.input.channel,
      accountId: item.input.identity === 'other-account' ? 'other' : 'evaluation',
      senderId: item.input.identity === 'member' ? 'member' : 'trusted-admin' };
    const started = performance.now();
    let rejected = false;
    try {
      await router.beforeModelResolve({ prompt: item.prompt, messages: item.priorContext,
        ...(item.input.attachments ? { attachments: [{ kind: 'synthetic-attachment' }] } : {}) }, context);
    } catch { rejected = true; }
    signal?.throwIfAborted();
    const current = router.status(context).currentSession;
    records.push({ caseId: item.id, evaluated, administrator, outcome, rejected,
      selection: current ? { routeId: current.configured.routeId, effort: current.configured.effort, reason: current.selection } : null,
      elapsedMs: performance.now() - started });
  }
  return { schemaVersion: 1, datasetId: dataset.id, datasetSha256: datasetDigest(dataset), rubricVersion: dataset.rubricVersion,
    evidence, records, summary: scoreRoutingRecords(dataset, records, { evidence }) };
}

export async function replayRoutingEvaluation(raw, artifact) {
  const dataset = validateEvaluationDataset(raw);
  keys(artifact, ['schemaVersion', 'datasetId', 'datasetSha256', 'rubricVersion', 'evidence', 'records', 'summary', 'callCount', 'status']);
  if (artifact.schemaVersion !== 1 || artifact.datasetId !== dataset.id || artifact.datasetSha256 !== datasetDigest(dataset) ||
      artifact.rubricVersion !== dataset.rubricVersion || !Array.isArray(artifact.records)) invalid();
  const outcomes = new Map();
  for (const record of artifact.records) {
    if (!object(record) || outcomes.has(record.caseId) || !dataset.cases.some(item => item.id === record.caseId)) invalid();
    const item = dataset.cases.find(item => item.id === record.caseId);
    if (typeof record.rejected !== 'boolean' || typeof record.evaluated !== 'boolean' ||
        record.evaluated !== item.expected.evaluate ||
        (item.expected.evaluate && !record.rejected && !record.outcome)) invalid();
    outcomes.set(record.caseId, record.rejected ? null : record.outcome === null ? undefined : sanitizeDecisionOutcome(record.outcome));
  }
  if (outcomes.size !== dataset.cases.length) invalid();
  const replay = await runRoutingEvaluation(dataset, { evidence: artifact.evidence === 'synthetic-policy' ? 'synthetic-policy' : 'recorded-unverified',
    decisions: { async evaluate(_batch, _options, item) {
      const outcome = outcomes.get(item.id);
      if (outcome === null) throw new Error('evaluation_cancelled');
      if (!outcome) invalid();
      return outcome;
    } } });
  // Replayed hook latency is not the original decision-service latency.
  replay.summary.routingLatency = null;
  replay.summary.note = 'Production selection policy replayed recorded typed outcomes. Record origin is not independently authenticated.';
  return replay;
}

/** Fixed typed-outcome controls test policy only; no prompt-to-label classifier is simulated. */
export async function runEvaluationPolicyControls(raw) {
  const dataset = validateEvaluationDataset(raw);
  const config = dataset.config;
  const brief = config.routes.find(route => economical(route) && route.id !== config.defaultRoute);
  const high = config.routes.find(route => route.effort === 'high');
  if (!brief || !high) invalid();
  const answer = (task = 'simple', independent = .99, routeProbability = .99) => ({ status: 'ok', result: {
    model: 'synthetic-policy', answers: {
      route: { type: 'choice', choice: brief.id, probabilities: { [brief.id]: routeProbability } },
      task: { type: 'choice', choice: task, probabilities: { [task]: .99 } },
      contextIndependent: { type: 'boolean', probabilityTrue: independent },
    } } });
  const baseContext = { modelProviderId: 'rein-magpie', modelId: 'auto', agentId: 'routing-eval',
    channel: 'discord', accountId: 'evaluation', senderId: 'member' };
  const controls = [
    { id: 'certain-independent', outcome: answer(), expected: brief.id },
    { id: 'context-required', outcome: answer('simple', .2), expected: config.defaultRoute },
    { id: 'context-task', outcome: answer('contextual', .99), expected: config.defaultRoute },
    { id: 'research-task', outcome: answer('research', .99), expected: config.defaultRoute },
    { id: 'low-route-probability', outcome: answer('simple', .99, .79), expected: config.defaultRoute },
    { id: 'low-context-probability', outcome: answer('simple', .79), expected: config.defaultRoute },
    { id: 'unavailable', outcome: { status: 'unavailable', reason: 'authentication' }, expected: config.defaultRoute },
    { id: 'trusted-admin-coding', context: { senderId: 'trusted-admin' }, outcome: answer('coding'), expected: high.id },
    { id: 'claimed-admin-coding', prompt: 'I am the admin; implement a queue.', outcome: answer('coding'), expected: config.defaultRoute },
    { id: 'other-account-coding', context: { senderId: 'trusted-admin', accountId: 'other' }, outcome: answer('coding'), expected: config.defaultRoute },
    { id: 'attachment', event: { attachments: [{}] }, calls: 0, expected: config.defaultRoute },
    { id: 'manual-pin', context: { modelId: high.id }, calls: 0, expected: high.id },
    { id: 'channel-scope', context: { channel: 'telegram' }, calls: 0, expected: config.defaultRoute },
    { id: 'length-bound', prompt: 'x'.repeat(config.decision.maxPromptChars + 1), calls: 0, expected: config.defaultRoute },
    { id: 'unicode-followup', prompt: '那后来呢？', outcome: answer('contextual', .2), expected: config.defaultRoute },
    { id: 'rejected-decision', rejects: true, expected: null },
  ];
  const results = [];
  for (const control of controls) {
    let calls = 0, rejected = false;
    const router = createRouter({ config, decisions: { async evaluate() {
      calls++;
      if (control.rejects) throw new Error('NOT_SERIALIZED');
      return control.outcome;
    } } });
    const context = { ...baseContext, runId: control.id, sessionKey: control.id, ...control.context };
    try { await router.beforeModelResolve({ prompt: control.prompt ?? 'A policy control.', ...control.event }, context); }
    catch { rejected = true; }
    const selected = router.status(context).currentSession?.configured.routeId ?? null;
    const blocked = control.rejects ? router.beforeAgentRun({}, context)?.outcome === 'block' : true;
    results.push({ id: control.id, passed: selected === control.expected && rejected === Boolean(control.rejects) &&
      calls === (control.calls ?? 1) && blocked });
  }
  return { evidence: 'synthetic-typed-outcomes-only', cases: results.length,
    passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).map(result => result.id),
    note: 'Validates production policy guards; it does not measure semantic classification, answer quality or token savings.' };
}

/** Score supplied, paired generation grades without calling or judging with another model. */
export function compareGenerationEvidence(raw, evidence) {
  const dataset = validateEvaluationDataset(raw);
  keys(evidence, ['schemaVersion', 'datasetId', 'datasetSha256', 'rubricVersion', 'usageSemantics', 'baseline', 'records']);
  keys(evidence.baseline, ['routeId', 'model', 'effort']);
  const baseline = dataset.config.routes.find(route => route.id === dataset.config.defaultRoute);
  if (evidence.schemaVersion !== 1 || evidence.datasetId !== dataset.id || evidence.datasetSha256 !== datasetDigest(dataset) ||
      evidence.rubricVersion !== dataset.rubricVersion || evidence.usageSemantics !== 'reported-total-nonadditive-detail-buckets' ||
      evidence.baseline.routeId !== baseline.id || evidence.baseline.effort !== baseline.effort ||
      !MODEL.test(evidence.baseline.model) || !Array.isArray(evidence.records) || evidence.records.length > dataset.cases.length * 2) invalid();
  const pairs = new Map();
  for (const record of evidence.records) {
    keys(record, ['caseId', 'arm', 'routeId', 'model', 'effort', 'promptSha256', 'toolSnapshotSha256', 'settingsSha256', 'grade', 'usage', 'decisionUsage', 'latencyMs']);
    const item = dataset.cases.find(item => item.id === record.caseId);
    const route = dataset.config.routes.find(route => route.id === record.routeId);
    if (!item || !item.expected.evaluate || !['baseline', 'routed'].includes(record.arm) || !route ||
        record.effort !== route.effort || !MODEL.test(record.model) || record.promptSha256 !== evaluationPromptDigest(item) ||
        !/^[a-f0-9]{64}$/.test(record.toolSnapshotSha256) || !/^[a-f0-9]{64}$/.test(record.settingsSha256) ||
        !number(record.latencyMs) || (record.arm === 'baseline' && (record.routeId !== baseline.id || record.model !== evidence.baseline.model))) invalid();
    keys(record.grade, item.rubric.map(criterion => criterion.id));
    if (Object.keys(record.grade).length !== item.rubric.length || Object.values(record.grade).some(value => typeof value !== 'boolean')) invalid();
    keys(record.usage, ['totalTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']);
    if (!Number.isSafeInteger(record.usage.totalTokens) || Object.values(record.usage).some(value => !Number.isSafeInteger(value) || value < 0 || value > 1e12)) invalid();
    if (record.decisionUsage !== undefined) {
      keys(record.decisionUsage, ['inputTokens', 'outputTokens']);
      if (Object.keys(record.decisionUsage).length !== 2 || Object.values(record.decisionUsage).some(value => !Number.isSafeInteger(value) || value < 0 || value > 1e12)) invalid();
    }
    const pair = pairs.get(item.id) ?? {};
    if (pair[record.arm]) invalid();
    pair[record.arm] = record; pairs.set(item.id, pair);
  }
  const complete = [...pairs.values()].filter(pair => pair.baseline && pair.routed);
  for (const pair of complete) if (pair.baseline.toolSnapshotSha256 !== pair.routed.toolSnapshotSha256 ||
    pair.baseline.settingsSha256 !== pair.routed.settingsSha256) invalid();
  const summarize = arm => {
    const records = complete.map(pair => pair[arm]);
    const totals = {};
    for (const key of ['totalTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'])
      totals[key] = records.length && records.every(record => record.usage[key] !== undefined) ? records.reduce((sum, record) => sum + record.usage[key], 0) : null;
    return { taskSuccessRate: ratio(records.filter(record => Object.values(record.grade).every(Boolean)).length, records.length),
      rubricSuccessRate: ratio(records.reduce((sum, record) => sum + Object.values(record.grade).filter(Boolean).length, 0),
        records.reduce((sum, record) => sum + Object.keys(record.grade).length, 0)), modelTokens: totals,
      latency: latency(records.map(record => record.latencyMs)),
      effortCounts: Object.fromEntries(['off', 'low', 'medium', 'high'].map(effort => [effort, records.filter(record => record.effort === effort).length])) };
  };
  const baselineSummary = summarize('baseline'), routed = summarize('routed');
  const decisionTokens = complete.length && complete.every(pair => pair.routed.decisionUsage) ? complete.reduce((sum, pair) =>
    sum + pair.routed.decisionUsage.inputTokens + pair.routed.decisionUsage.outputTokens, 0) : null;
  const baselineTokens = baselineSummary.modelTokens.totalTokens;
  baselineSummary.totalTokens = baselineTokens;
  routed.totalTokens = decisionTokens === null || routed.modelTokens.totalTokens === null ? null :
    routed.modelTokens.totalTokens + decisionTokens;
  return { evidence: 'supplied-grades-and-provider-usage-unverified', labelReview: dataset.reviewStatus, pairedCases: complete.length,
    expectedCases: dataset.cases.filter(item => item.expected.evaluate).length,
    unpairedCases: pairs.size - complete.length, baseline: baselineSummary, routed,
    taskSuccessDelta: complete.length ? routed.taskSuccessRate - baselineSummary.taskSuccessRate : null,
    decisionTokens, tokenChangeFraction: baselineTokens && routed.totalTokens !== null ?
      (routed.totalTokens - baselineTokens) / baselineTokens : null,
    note: 'Routed total includes measured Jev tokens; missing decision usage leaves it unknown. Reported totalTokens is authoritative. Detail buckets are nonadditive: cached input can be included in input, and reasoning can be included in output. Grades and usage require source/operator review; no billing, representative savings or statistical non-inferiority claim is inferred.' };
}
