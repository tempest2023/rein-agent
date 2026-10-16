import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareGenerationEvidence, datasetDigest, evaluationPromptDigest, loadEvaluationDataset,
  replayRoutingEvaluation, runEvaluationPolicyControls, runRoutingEvaluation, sanitizeDecisionOutcome,
  scoreRoutingRecords, validateEvaluationDataset } from '../scripts/subscription-routing-evaluation.mjs';
import { offlineEvaluation, parseEvaluationArguments, writeEvaluationReport } from '../scripts/evaluate-subscription-routing.mjs';
import { hostedEvaluationSettings, parseHostedEvaluationArguments } from '../scripts/evaluate-subscription-routing-hosted.mjs';

const all = () => loadEvaluationDataset();
const subset = (...ids) => { const dataset = all(); dataset.cases = dataset.cases.filter(item => ids.includes(item.id)); return dataset; };
const answer = (route = 'brief', task = 'simple', independent = .99, p = .99) => ({ status: 'ok', result: {
  model: 'jev-recorded-fixture', answers: {
    route: { type: 'choice', choice: route, probabilities: { [route]: p } },
    task: { type: 'choice', choice: task, probabilities: { [task]: .99 } },
    contextIndependent: { type: 'boolean', probabilityTrue: independent },
  }, usage: { inputTokens: 11, outputTokens: 2 } } });

test('corpus is explicitly AI-authored, unreviewed, varied and free of probe CASE markers', () => {
  const dataset = all();
  assert.match(dataset.provenance, /AI-authored/);
  assert.equal(dataset.reviewStatus, 'operator-review-pending');
  assert.equal(dataset.cases.length, 66);
  for (const category of ['simple', 'contextual', 'research', 'coding', 'complex', 'control'])
    assert.ok(dataset.cases.filter(item => item.category === category).length >= 6);
  assert.ok(dataset.cases.filter(item => item.category === 'simple').length >= 24);
  assert.ok(dataset.cases.some(item => /[\u4e00-\u9fff]/u.test(item.prompt)));
  assert.ok(dataset.cases.some(item => item.priorContext.length));
  assert.ok(!JSON.stringify(dataset).includes('CASE_'));
  assert.match(dataset.limitations.join(' '), /not a representative traffic distribution/);
  assert.match(dataset.limitations.join(' '), /not.*blind benchmark/);
});

test('structural validation rejects label/config contradictions and duplicate IDs', () => {
  for (const mutate of [
    d => d.cases.push(structuredClone(d.cases[0])),
    d => d.cases[0].expected.evaluate = false,
    d => d.cases[0].expected.contextIndependent = false,
    d => d.cases[0].expected.routing = 'manual',
    d => d.config.routes[0].gatewayModel = 'actual/live-model',
    d => d.config.gateway.managed = { binaryPath: '/foreign/magpie', homeDir: '/foreign/home' },
    d => d.config.allowPaidUsage = true,
    d => d.cases[0].rubric.push(structuredClone(d.cases[0].rubric[0])),
  ]) { const dataset = all(); mutate(dataset); assert.throws(() => validateEvaluationDataset(dataset), /evaluation_invalid/); }
});

test('reviewed labels are accepted without mutating the source; unknown review statuses are rejected', () => {
  const pending = subset('simple-greeting');
  const reviewed = structuredClone(pending);
  reviewed.reviewStatus = 'operator-reviewed';
  const source = JSON.stringify(reviewed);
  assert.deepEqual(validateEvaluationDataset(reviewed), reviewed);
  assert.equal(JSON.stringify(reviewed), source);
  assert.equal(pending.reviewStatus, 'operator-review-pending');
  for (const status of [undefined, null, '', 'reviewed', 'Operator-reviewed', true, {}]) {
    const invalid = structuredClone(reviewed); invalid.reviewStatus = status;
    assert.throws(() => validateEvaluationDataset(invalid), error => error.message === 'subscription_evaluation_invalid');
  }
});

test('default CLI path makes no network calls and leaves semantics and generation unknown', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
  try {
    const report = await offlineEvaluation();
    assert.equal(report.classification, null); assert.equal(report.generation, null);
    assert.equal(report.policyControls.passed, 16); assert.deepEqual(report.policyControls.failed, []);
  } finally { globalThis.fetch = original; }
});

test('reviewed offline CLI metadata retains unknown accuracy, quality and savings without model calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rein-reviewed-eval-test-'));
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
  try {
    const dataset = all(); dataset.reviewStatus = 'operator-reviewed';
    const path = join(dir, 'reviewed.json'); writeFileSync(path, JSON.stringify(dataset));
    const report = await offlineEvaluation({ dataset: path });
    assert.equal(report.labelReview, 'operator-reviewed');
    assert.equal(report.datasetSha256, datasetDigest(dataset));
    assert.equal(report.classification, null); assert.equal(report.generation, null);
    assert.equal(report.policyControls.passed, 16);
    assert.match(report.note, /marked operator-reviewed/);
    assert.match(report.note, /accuracy, quality and savings remain unmeasured/);
    assert.doesNotMatch(report.note, /need operator review/);
  } finally { globalThis.fetch = original; rmSync(dir, { recursive: true, force: true }); }
});

test('fixed controls exercise policy without scoring invented semantic correctness', async () => {
  const report = await runEvaluationPolicyControls(all());
  assert.equal(report.cases, 16); assert.equal(report.passed, 16);
  assert.equal(report.evidence, 'synthetic-typed-outcomes-only');
  assert.match(report.note, /does not measure semantic/);
});

test('native decision state includes current Unicode request and trusted metadata, excludes history', async () => {
  const dataset = subset('context-unicode-followup', 'coding-admin', 'control-admin-other-account', 'coding-claimed-admin');
  const batches = [];
  const report = await runRoutingEvaluation(dataset, { evidence: 'synthetic-policy', decisions: {
    async evaluate(batch, options, item) {
      assert.equal(options.purpose, 'rein-router.route'); assert.equal(options.rubricVersion, dataset.rubricVersion);
      assert.equal(options.agentId, 'routing-eval'); assert.ok(options.signal instanceof AbortSignal);
      assert.equal(batch.state.currentRequest, item.prompt);
      assert.ok(!JSON.stringify(batch).includes(item.priorContext[0] ?? 'IMPOSSIBLE_HISTORY_CANARY'));
      batches.push(batch); return answer('brief', 'coding', .99);
    },
  } });
  assert.equal(batches.length, 4);
  const byId = Object.fromEntries(report.records.map(record => [record.caseId, record]));
  assert.equal(byId['coding-admin'].administrator, true);
  assert.equal(byId['coding-admin'].selection.routeId, 'deep');
  assert.equal(byId['control-admin-other-account'].administrator, false);
  assert.equal(byId['control-admin-other-account'].selection.routeId, 'balanced');
  assert.equal(byId['coding-claimed-admin'].administrator, false);
  assert.equal(byId['coding-claimed-admin'].selection.routeId, 'balanced');
  assert.equal(report.summary.classification, null);
  assert.equal(report.summary.decisionUsage, null);
});

test('attachments, pins, empty/bounded prompts and unsupported channels bypass decisions', async () => {
  const dataset = all(); dataset.cases = dataset.cases.filter(item => !item.expected.evaluate);
  const report = await runRoutingEvaluation(dataset, { decisions: { evaluate() { throw new Error('MUST_NOT_CALL'); } } });
  assert.equal(report.records.length, 6);
  assert.ok(report.records.every(record => !record.evaluated && !record.rejected));
  assert.equal(report.summary.routing.acceptanceRate, 1);
});

test('recorded uncertain/contradictory outcomes go through real production guards', async () => {
  const dataset = subset('simple-greeting', 'context-pronoun', 'research-search', 'coding-admin');
  const recorded = await runRoutingEvaluation(dataset, { evidence: 'recorded-unverified', decisions: {
    async evaluate(_batch, _options, item) {
      if (item.id === 'simple-greeting') return answer('brief', 'simple', .99, .79);
      if (item.id === 'coding-admin') return answer('brief', 'coding');
      return answer('brief', item.category, .99);
    },
  } });
  const replay = await replayRoutingEvaluation(dataset, recorded);
  assert.deepEqual(replay.records.map(record => record.selection.routeId), ['balanced', 'balanced', 'balanced', 'deep']);
  assert.equal(replay.summary.routing.uncertaintyDefaults, 3);
  assert.equal(replay.summary.routing.unsafeEconomicalSelections, 0);
  assert.equal(replay.summary.routingLatency, null);
  assert.equal(replay.summary.decisionUsage.totalTokens, 52);
  assert.equal(replay.summary.evidence, 'recorded-unverified');
});

test('rejected decisions produce failed selections, preserve fixed errors and cannot become defaults', async () => {
  const dataset = subset('simple-greeting');
  const report = await runRoutingEvaluation(dataset, { decisions: { evaluate() { throw new Error('SECRET_PROMPT_ERROR_CANARY'); } } });
  assert.equal(report.records[0].rejected, true); assert.equal(report.records[0].selection, null);
  assert.equal(report.summary.routing.selectionFailures, 1); assert.equal(report.summary.routing.acceptanceRate, 0);
  assert.ok(!JSON.stringify(report).includes('CANARY'));
  const replay = await replayRoutingEvaluation(dataset, report);
  assert.equal(replay.records[0].rejected, true);
});

test('replay requires exact corpus/rubric identity and one outcome per expected call', async () => {
  const dataset = subset('simple-greeting');
  const recorded = await runRoutingEvaluation(dataset, { decisions: { evaluate: async () => answer() } });
  for (const mutate of [
    a => a.datasetSha256 = '0'.repeat(64),
    a => a.rubricVersion = 'old-rubric',
    a => a.records.push(structuredClone(a.records[0])),
    a => a.records = [],
    a => a.records[0].outcome = null,
    a => a.records[0].evaluated = false,
  ]) { const bad = structuredClone(recorded); mutate(bad); await assert.rejects(() => replayRoutingEvaluation(dataset, bad), /evaluation_invalid/); }
});

test('reviewed summaries and replay use the exact reviewed dataset identity without upgrading pending evidence', async () => {
  const pending = subset('simple-greeting');
  const reviewed = structuredClone(pending); reviewed.reviewStatus = 'operator-reviewed';
  const options = { evidence: 'recorded-unverified', decisions: { evaluate: async () => answer() } };
  const pendingRecord = await runRoutingEvaluation(pending, options);
  const reviewedRecord = await runRoutingEvaluation(reviewed, options);
  assert.notEqual(reviewedRecord.datasetSha256, pendingRecord.datasetSha256);
  assert.equal(reviewedRecord.summary.labelReview, 'operator-reviewed');
  assert.match(reviewedRecord.summary.classification.note, /operator-reviewed synthetic labels/);
  assert.doesNotMatch(reviewedRecord.summary.classification.note, /unreviewed/);
  assert.match(reviewedRecord.summary.classification.note, /not a traffic benchmark or demonstrated correctness guarantee/);
  assert.match(pendingRecord.summary.classification.note, /proposed, unreviewed synthetic labels/);
  assert.equal(reviewedRecord.summary.generation, null);
  const replay = await replayRoutingEvaluation(reviewed, reviewedRecord);
  assert.equal(replay.datasetSha256, reviewedRecord.datasetSha256);
  assert.equal(replay.summary.labelReview, 'operator-reviewed');
  assert.equal(replay.summary.classification.note, reviewedRecord.summary.classification.note);
  assert.deepEqual(replay.records.map(record => record.selection), reviewedRecord.records.map(record => record.selection));
  await assert.rejects(() => replayRoutingEvaluation(reviewed, pendingRecord), /evaluation_invalid/);
  await assert.rejects(() => replayRoutingEvaluation(pending, reviewedRecord), /evaluation_invalid/);
});

test('evidence sanitizer drops raw payload/header/error fields and validates bounded typed usage', () => {
  const raw = answer();
  raw.headers = { authorization: 'SECRET_CANARY' }; raw.error = 'SECRET_CANARY'; raw.result.request = 'PRIVATE_PROMPT_CANARY';
  raw.provenance = { runtimeGeneration: 'SECRET_CANARY' };
  assert.ok(!JSON.stringify(sanitizeDecisionOutcome(raw)).includes('CANARY'));
  for (const mutate of [
    a => a.result.model = 'Bearer_SECRET_CANARY',
    a => a.result.answers.contextIndependent.probabilityTrue = 1.1,
    a => a.result.answers.route.probabilities.brief = -1,
    a => a.result.usage.inputTokens = 1e13,
    a => a.result.answers.extra = { type: 'choice', choice: 'private' },
  ]) { const bad = answer(); mutate(bad); assert.throws(() => sanitizeDecisionOutcome(bad), /evaluation_invalid/); }
});

test('semantic metrics are separate from policy evidence and incomplete decision usage stays unknown', async () => {
  const dataset = subset('simple-greeting', 'context-pronoun');
  const report = await runRoutingEvaluation(dataset, { evidence: 'recorded-unverified', decisions: { async evaluate() { return answer(); } } });
  assert.equal(report.summary.classification.taskAccuracy, .5);
  assert.equal(report.summary.classification.contextAccuracy, .5);
  assert.equal(report.summary.routing.unsafeEconomicalSelections, 1);
  assert.equal(report.summary.routing.economicalPrecision, .5);
  assert.equal(report.summary.routing.economicalRecall, 1);
  delete report.records[0].outcome.result.usage;
  assert.equal(scoreRoutingRecords(dataset, report.records).decisionUsage.totalTokens, null);
  assert.equal(scoreRoutingRecords(dataset, report.records, { evidence: 'synthetic-policy' }).classification, null);
});

const generation = dataset => {
  const item = dataset.cases[0];
  const common = { caseId: item.id, promptSha256: evaluationPromptDigest(item), toolSnapshotSha256: '1'.repeat(64),
    settingsSha256: '2'.repeat(64), grade: { 'task-success': true }, latencyMs: 100 };
  return { schemaVersion: 1, datasetId: dataset.id, datasetSha256: datasetDigest(dataset), rubricVersion: dataset.rubricVersion,
    usageSemantics: 'reported-total-nonadditive-detail-buckets', baseline: { routeId: 'balanced', model: 'vendor/fixed-capable', effort: 'medium' },
    records: [
      { ...common, arm: 'baseline', routeId: 'balanced', model: 'vendor/fixed-capable', effort: 'medium',
        usage: { totalTokens: 100, inputTokens: 80, cacheReadTokens: 50, outputTokens: 20, reasoningTokens: 10 } },
      { ...common, arm: 'routed', routeId: 'brief', model: 'vendor/economical', effort: 'off',
        usage: { totalTokens: 70, inputTokens: 50, cacheReadTokens: 20, outputTokens: 20, reasoningTokens: 0 },
        decisionUsage: { inputTokens: 25, outputTokens: 10 }, latencyMs: 80 },
    ] };
};

test('paired scoring includes Jev overhead and never double-counts cache or reasoning detail', () => {
  const dataset = subset('simple-greeting'), evidence = generation(dataset);
  const report = compareGenerationEvidence(dataset, evidence);
  assert.equal(report.pairedCases, 1); assert.equal(report.baseline.totalTokens, 100);
  assert.equal(report.routed.modelTokens.totalTokens, 70); assert.equal(report.decisionTokens, 35);
  assert.equal(report.routed.totalTokens, 105); assert.equal(report.tokenChangeFraction, .05);
  assert.equal(report.taskSuccessDelta, 0); assert.equal(report.routed.latency.p50Ms, 80);
  assert.equal(report.evidence, 'supplied-grades-and-provider-usage-unverified');
});

test('reviewed labels do not verify imported generation grades, usage or representative savings', () => {
  const dataset = subset('simple-greeting'); dataset.reviewStatus = 'operator-reviewed';
  const report = compareGenerationEvidence(dataset, generation(dataset));
  assert.equal(report.labelReview, 'operator-reviewed');
  assert.equal(report.evidence, 'supplied-grades-and-provider-usage-unverified');
  assert.match(report.note, /Grades and usage require source\/operator review/);
  assert.match(report.note, /no billing, representative savings or statistical non-inferiority claim is inferred/);
});

test('missing routed decision usage leaves total and token comparison unknown', () => {
  const dataset = subset('simple-greeting'), evidence = generation(dataset);
  delete evidence.records[1].decisionUsage;
  const report = compareGenerationEvidence(dataset, evidence);
  assert.equal(report.decisionTokens, null); assert.equal(report.routed.totalTokens, null);
  assert.equal(report.tokenChangeFraction, null);
});

test('paired scoring rejects incompatible prompts, contexts, rubrics, settings and mutable baseline', () => {
  const dataset = subset('simple-greeting');
  for (const mutate of [
    a => a.rubricVersion = 'older',
    a => a.records[1].promptSha256 = '0'.repeat(64),
    a => a.records[1].toolSnapshotSha256 = '3'.repeat(64),
    a => a.records[1].settingsSha256 = '4'.repeat(64),
    a => a.records[1].grade = { invented: true },
    a => a.records[0].model = 'vendor/different-baseline',
    a => a.records[0].effort = 'off',
    a => a.records.push(structuredClone(a.records[0])),
    a => delete a.records[0].usage.totalTokens,
    a => a.usageSemantics = 'sum-every-field',
  ]) { const bad = generation(dataset); mutate(bad); assert.throws(() => compareGenerationEvidence(dataset, bad), /evaluation_invalid/); }
  const changed = structuredClone(dataset.cases[0]); changed.priorContext.push('Additional context.');
  assert.notEqual(evaluationPromptDigest(changed), evaluationPromptDigest(dataset.cases[0]));
});

test('unpaired generation evidence is reported without quality or token conclusions', () => {
  const dataset = subset('simple-greeting'), evidence = generation(dataset);
  evidence.records.pop(); const report = compareGenerationEvidence(dataset, evidence);
  assert.equal(report.pairedCases, 0); assert.equal(report.unpairedCases, 1);
  assert.equal(report.taskSuccessDelta, null); assert.equal(report.tokenChangeFraction, null);
});

test('CLI arguments and exclusive private reports cannot overwrite existing evidence', () => {
  assert.throws(() => parseEvaluationArguments(['--hosted']), /arguments_invalid/);
  assert.throws(() => parseEvaluationArguments(['--dataset', 'one', '--dataset', 'two']), /arguments_invalid/);
  assert.throws(() => parseEvaluationArguments(['--output']), /arguments_invalid/);
  const dir = mkdtempSync(join(tmpdir(), 'rein-routing-eval-test-'));
  try {
    const path = join(dir, 'report.json'); writeEvaluationReport(path, { valid: true });
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(() => writeEvaluationReport(path, { valid: false }));
    assert.equal(readFileSync(path, 'utf8'), '{\n  "valid": true\n}\n');
    writeFileSync(join(dir, 'invalid.json'), '{');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const hostedConfig = () => ({ agents: { defaults: { decisionModel: 'typesafe/jev-latest' } }, plugins: {
  allow: ['typesafe', 'other-plugin'], entries: { typesafe: { enabled: true,
    config: { apiKey: { source: 'env', provider: 'default', id: 'TYPESAFE_TEST_API_KEY' } } } } } });
const hostedOptions = () => ({ allowPaidJev: true, maxCalls: 60 });

test('hosted parser requires separate paid opt-in, explicit profile, bounded budget and output', () => {
  const args = ['--allow-paid-jev', '--openclaw-config', '/synthetic/profile.json', '--max-calls', '60', '--output', '/synthetic/new-report.json'];
  assert.equal(parseHostedEvaluationArguments(args).maxCalls, 60);
  for (const bad of [args.slice(1), [...args, '--allow-paid-jev'], args.slice(0, -2),
    args.map(value => value === '60' ? 'Infinity' : value), args.map(value => value === '60' ? '257' : value),
    [...args, '--api-key', 'SECRET_CANARY']]) assert.throws(() => parseHostedEvaluationArguments(bad), /hosted_evaluation_invalid/);
});

test('hosted settings retain only selected env SecretRef/model; never resolve/store literal credentials', () => {
  const config = hostedConfig(); config.credential = 'UNRELATED_SECRET_CANARY';
  const settings = hostedEvaluationSettings(config, { TYPESAFE_TEST_API_KEY: 'SECRET_CANARY' }, hostedOptions(), all());
  assert.deepEqual(settings, { model: 'typesafe/jev-latest', apiKey: { source: 'env', provider: 'default', id: 'TYPESAFE_TEST_API_KEY' } });
  assert.ok(!JSON.stringify(settings).includes('CANARY'));
});

test('hosted preflight rejects absent authorization/role/key, insufficient budget and alternate endpoints', () => {
  for (const mutate of [
    (c, e, o) => o.allowPaidJev = false,
    (c, e, o) => o.maxCalls = 59,
    (c, e) => delete e.TYPESAFE_TEST_API_KEY,
    c => c.plugins.enabled = false,
    c => c.plugins.allow = [],
    c => c.plugins.deny = ['typesafe'],
    c => c.plugins.entries.typesafe.enabled = false,
    c => c.agents.defaults.decisionModel = 'typesafe/kev-latest',
    c => c.plugins.entries.typesafe.config.baseUrl = 'http://127.0.0.1:8009',
    c => c.plugins.entries.typesafe.config.apiKey = 'SECRET_CANARY',
    c => c.plugins.entries.typesafe.config.apiKey.source = 'store',
    (c, e) => { c.plugins.entries.typesafe.config.apiKey.id = 'HOME'; e.HOME = 'SECRET_CANARY'; },
    (c, e) => { c.plugins.entries.typesafe.config.apiKey.id = 'REIN_EVALUATION_REPORT'; e.REIN_EVALUATION_REPORT = 'SECRET_CANARY'; },
  ]) {
    const config = hostedConfig(), env = { TYPESAFE_TEST_API_KEY: 'SECRET_CANARY' }, options = hostedOptions();
    mutate(config, env, options);
    assert.throws(() => hostedEvaluationSettings(config, env, options, all()), error =>
      error.message === 'subscription_hosted_evaluation_invalid');
  }
});

test('isolated fixture calls injected native decision capability only and preserves replayable typed evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rein-native-eval-fixture-test-'));
  const names = ['REIN_EVALUATION_DATASET', 'REIN_EVALUATION_REPORT', 'REIN_EVALUATION_MAX_CALLS'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    const dataset = subset('simple-greeting', 'coding-admin', 'control-manual-deep');
    writeFileSync(join(dir, 'dataset.json'), JSON.stringify(dataset));
    Object.assign(process.env, { REIN_EVALUATION_DATASET: join(dir, 'dataset.json'),
      REIN_EVALUATION_REPORT: join(dir, 'report.json'), REIN_EVALUATION_MAX_CALLS: '2' });
    const fixturePath = new URL('./fixtures/subscription-routing-evaluation.ts', import.meta.url);
    const modulePath = new URL('../scripts/subscription-routing-evaluation.mjs', import.meta.url).pathname;
    writeFileSync(join(dir, 'fixture.mjs'), readFileSync(fixturePath, 'utf8')
      .replace("'__REIN_EVALUATION_MODULE__'", JSON.stringify(decodeURIComponent(modulePath))));
    const fixture = (await import(pathToFileURL(join(dir, 'fixture.mjs')).href)).default;
    let service, calls = 0;
    fixture.register({ registerService(value) { service = value; }, runtime: { decisions: { async evaluate(batch, options) {
      calls++; assert.equal(options.agentId, 'routing-eval');
      return answer('brief', batch.state.administrator ? 'coding' : 'simple');
    } } } });
    await service.start();
    const artifact = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    assert.equal(calls, 2); assert.equal(artifact.callCount, 2);
    assert.deepEqual(artifact.records.map(record => record.selection.routeId), ['brief', 'deep', 'deep']);
    assert.equal((await replayRoutingEvaluation(dataset, artifact)).summary.evidence, 'recorded-unverified');
    await service.stop();
  } finally {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    rmSync(dir, { recursive: true, force: true });
  }
});
