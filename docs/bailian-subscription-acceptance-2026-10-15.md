# Bailian gateway integration acceptance — 2026-10-15

The existing China Bailian Token Plan completed a live tool round trip through OpenClaw,
the production Rein router and the project-local pinned Magpie gateway. The test used temporary
OpenClaw state and local channel ingress; it sent no Slack or Discord message and did not
activate Nori's working profile.

| Check | Observed result |
| --- | --- |
| Configured provider | `bailian-token-plan` |
| Requested and vendor-served model | `qwen3.8-flash` |
| Upstream model requests | Exactly two |
| Tool | `rein_probe_echo`, one execution and native continuation |
| Observed thinking | `none` on both requests |
| Output limit | 256 tokens per request |
| Framework-reported usage | 6,567 total tokens; 4,469 input, 50 output, 2,048 cache read, zero cache write |
| Upstream host | Exact dedicated China Token Plan TLS host |
| Jev / fallback | Both disabled |
| Prepaid add-on declaration | No active add-on packs, as supplied by the operator |
| Cleanup | Gateway stopped and profile lock released |

The test preserved the original OpenClaw configuration and used the imported dedicated plan key
with a single-model Magpie gateway key. It did not substitute a general API endpoint or key.
Usage values come from native OpenClaw events; the reported total is retained rather than
recomputed from provider-dependent detail buckets.

The private report is ignored at `runtime/magpie/bailian-live-report-2026-10-15.json`, mode `0600`.
Its SHA-256 is `be5504234b77e9fdfe10cef458833cb72fa8d393c5a903f75613b4a68f9e3305`.
It contains no credential literals; captured standard error is empty. No prompts, account
identifiers or credential contents are included in this public record.

This verifies the live integration and served model. The configured plan endpoint/key establish
the selected billing route; they are not a provider invoice or subscription-ledger reconciliation.
OpenAI, Claude and Google live round trips and the paired answer-quality/token comparison remain
separate acceptance work.

Reproduction uses the same bounded probe:

```sh
npm run toolchain:pnpm -- run verify:subscriptions:bailian --live --prepaid-addons=absent
```

Use the add-on declaration matching the current account state. Running this command makes real
model requests through the configured plan.
