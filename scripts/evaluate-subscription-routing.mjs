import { constants, closeSync, openSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareGenerationEvidence, datasetDigest, loadEvaluationDataset, readEvaluationJson,
  replayRoutingEvaluation, runEvaluationPolicyControls } from './subscription-routing-evaluation.mjs';

export function parseEvaluationArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { '--dataset': 'dataset', '--replay': 'replay', '--generation': 'generation', '--output': 'output' }[args[index]];
    if (!key || parsed[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--'))
      throw new Error('subscription_evaluation_arguments_invalid');
    parsed[key] = resolve(args[index + 1]);
  }
  return parsed;
}

/** Exclusive private output avoids overwriting source, credentials or previous evidence. */
export function writeEvaluationReport(path, value) {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); } finally { closeSync(descriptor); }
}

export async function offlineEvaluation(options = {}) {
  const dataset = loadEvaluationDataset(options.dataset);
  const policyControls = await runEvaluationPolicyControls(dataset);
  if (policyControls.failed.length) throw new Error('subscription_evaluation_policy_failed');
  const result = options.replay ? await replayRoutingEvaluation(dataset, readEvaluationJson(options.replay)) : {
    schemaVersion: 1, datasetId: dataset.id, datasetSha256: datasetDigest(dataset),
    mode: 'offline-structural-validation', labelReview: dataset.reviewStatus,
    cases: dataset.cases.length,
    byCategory: Object.fromEntries([...new Set(dataset.cases.map(item => item.category))].map(category =>
      [category, dataset.cases.filter(item => item.category === category).length])),
    bySplit: Object.fromEntries(['development', 'holdout'].map(split => [split, dataset.cases.filter(item => item.split === split).length])),
    classification: null, generation: null,
    note: dataset.reviewStatus === 'operator-reviewed' ?
      'No classifier or model called. Labels and rubrics are marked operator-reviewed; accuracy, quality and savings remain unmeasured.' :
      'No classifier or model called. Labels and rubrics need operator review; accuracy, quality and savings remain unmeasured.',
  };
  if (result.summary) result.summary.policyControls = policyControls;
  else result.policyControls = policyControls;
  if (options.generation) {
    const comparison = compareGenerationEvidence(dataset, readEvaluationJson(options.generation));
    if (result.summary) result.summary.generation = comparison;
    else result.generation = comparison;
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--') args.shift();
    const options = parseEvaluationArguments(args);
    const report = await offlineEvaluation(options);
    if (options.output) writeEvaluationReport(options.output, report);
    // Imported records are summarized; raw service outcomes never reach stdout.
    console.log(JSON.stringify(report.summary ?? report, null, 2));
  } catch {
    console.error('subscription_evaluation_failed'); process.exitCode = 1;
  }
}
