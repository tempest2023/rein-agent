// Loaded only by the explicit isolated evaluator; no channels or model inference.
import { writeFileSync } from 'node:fs';
import { loadEvaluationDataset, runRoutingEvaluation } from '__REIN_EVALUATION_MODULE__';

export default {
  id: 'rein-routing-evaluation',
  name: 'Isolated subscription routing evaluation',
  register(api) {
    const controller = new AbortController();
    let work;
    api.registerService({
      id: 'rein-routing-evaluation',
      async start() {
        work = (async () => {
          try {
            const dataset = loadEvaluationDataset(process.env.REIN_EVALUATION_DATASET);
            let calls = 0;
            const maximum = Number(process.env.REIN_EVALUATION_MAX_CALLS);
            if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256 ||
                dataset.cases.filter(item => item.expected.evaluate).length > maximum) throw new Error('evaluation_call_budget');
            const local = Boolean(api.runtime.config?.current?.()?.plugins?.entries?.typesafe?.config?.baseUrl);
            const report = await runRoutingEvaluation(dataset, { evidence: local ? 'native-typesafe-local-synthetic' : 'native-typesafe-hosted', signal: controller.signal,
              decisions: { async evaluate(batch, options) {
                if (++calls > maximum) throw new Error('evaluation_call_budget');
                return api.runtime.decisions.evaluate(batch, options);
              } } });
            report.callCount = calls;
            writeFileSync(process.env.REIN_EVALUATION_REPORT, JSON.stringify(report), { mode: 0o600, flag: 'wx' });
          } catch {
            // A host error can reflect credentials/evidence. Only a fixed status leaves this process.
            writeFileSync(process.env.REIN_EVALUATION_REPORT, '{"failed":true}', { mode: 0o600, flag: 'wx' });
          }
        })();
        await work;
      },
      async stop() { controller.abort(); await work; },
    });
  },
};
