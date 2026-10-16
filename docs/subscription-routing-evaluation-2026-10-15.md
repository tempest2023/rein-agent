# Jev routing evaluation — 2026-10-15

One explicitly authorized hosted evaluation completed 60 Jev decisions through OpenClaw's native
TypeSafe adapter and Rein's production routing hooks. All 66 cases satisfied their proposed route
envelopes, including six controls that bypassed Jev. Economical routing selected 21 of 24 proposed
opportunities, with no unsafe economical selections against these labels. This measures route
selection on synthetic inputs; answer quality and net token savings remain unknown.

## Method and evidence

The [versioned corpus](../evals/subscription-routing.v1.json) contains 66 AI-authored synthetic
cases with proposed labels and answer rubrics: 24 simple, 12 contextual, eight research, nine
coding, seven complex and six controls. Its 44 development and 22 holdout cases are both visible.
Operator label review is pending; this is neither a blind benchmark nor representative traffic.

The runner used `typesafe/jev-latest`; every evaluated response reported `jev-1.13.0`. An isolated
evaluation profile resolved an environment SecretRef without copying the key into configuration
or command arguments. The run had a 60-call ceiling and made exactly 60 classifier calls. No
Magpie inference, conversational generation, tools or Slack/Discord messages were invoked. Nori's
working configuration and the disabled local router were not activated.

| Evidence field | Value |
| --- | --- |
| Corpus ID / rubric | `rein-subscription-routing-v1` / `rein-subscriptions-v1` |
| Canonical dataset SHA-256 | `8f386f20a3af6d6ecdcf4d49ef271edb7fb665d5f8ebe45de8dfc59e4cae4c78` |
| Private report SHA-256 | `cbbef6022ea22bab52b902a3e2ccb1677194f107c732fdb947084a2676692f87` |
| Report | Ignored `runtime/magpie/jev-routing-report-2026-10-15.json`, mode `0600` |
| Report content | Typed decisions, synthetic case IDs, selections, usage and latency; no key or corpus prompt literals |
| Replay | Production policy reproduced all 66 recorded selections; 16 fixed policy controls passed |

The dataset digest is produced by the evaluator's `datasetDigest` function from the validated
JSON serialization, rather than the corpus file's original bytes. The private report digest uses
the saved file bytes.

The report is a local observation, without independent provider attestation. Offline replay checks
policy behavior from recorded outcomes and cannot authenticate those outcomes' origin.

## Observed results

| Measure | Result |
| --- | --- |
| Successful hosted decisions | 60 / 60 |
| Bypass controls | 6 / 6 |
| Cases satisfying proposed route envelopes | 66 / 66 |
| Automatic selections | 21 brief, 37 balanced, two deep |
| Proposed economical opportunities selected | 21 / 24 (87.5%) |
| Economical selections satisfying proposed labels | 21 / 21 |
| Unsafe economical selections against proposed labels | 0 |
| Task-label agreement | 59 / 60 (98.3%) |
| Context-label agreement at the scorer's 0.50 cutoff | 49 / 60 (81.7%) |
| Context probability Brier score | 0.1183 |
| Measured decision input / output tokens | 57,128 / 6,624 |
| Total decision tokens | 63,752 (1,062.5 per hosted decision on average) |
| Hosted-decision elapsed time, median / p95 | 162 / 245 ms |

Latency includes the local routing hook and native adapter and excludes the six bypass controls.
It excludes conversational generation and tools; it is not end-to-end task latency. The private
report's aggregate routing-latency field also includes bypass cases and has a different median.
Token counts are the usage reported by the adapter. Hosted Jev is separately billed; this run had
explicit paid-use authorization. No monetary amount or billing statement was verified.

For the 60 classified cases, if the other 39 selections used the same generation tokens as the
capable baseline, the 21 economical selections would each need to save about 3,036 generation
tokens on average just to offset the measured classifier overhead. This is a conditional
break-even calculation, not observed savings. Provider/model price differences alone do not
reduce token counts. The router preserves generation history and tools; effort changes may
alter reasoning tokens, which a paired generation run must measure.

## Disagreements and calibration

Three proposed economical opportunities retained the capable default because they did not meet
the configured 0.80 probability threshold:

| Synthetic case ID | Evidence below threshold |
| --- | --- |
| `simple-greeting` | Context independence 0.66 |
| `simple-thanks` | Brief route 0.78; context independence 0.48 |
| `simple-self-contained-summary` | Context independence 0.79 |

The only task-label disagreement was `context-missing-reference`: Jev returned `simple` with
probability 0.46, so uncertainty retained the capable default. All 11 context-label disagreements
were conservative predictions: Jev predicted that context was needed where the proposed label
said the question was independent. They occurred in `simple-thanks`, six research cases,
`coding-admin`, `control-admin-other-account`, `complex-planning` and `control-injection`.

Review the meaning of context independence for retrieval tasks and these labels before changing
prompts or thresholds. The run gives no reason to loosen the production threshold automatically.
No production policy was tuned on this result and no additional hosted calls were made.

## Remaining acceptance work

Use reviewed labels and representative consented or synthetic traffic for further evaluation.
Compare routed and fixed capable-baseline answers with identical prompt/context digests, tool
snapshots and generation settings, grading both against the same reviewed rubric. Include Jev's
measured token overhead in routed totals; short answers may not offset it. Capture end-to-end
latency, task success and available cache/reasoning details without double counting.

This classifier-only run establishes no conversational-model quality, net token savings, provider
allowance eligibility, billing guarantees, authentication refresh or live four-provider acceptance.
Those remain open in the [acceptance matrix](unified-subscription-access.md#acceptance-record).
