# MVP Slack acceptance record (2026-09-28)

This is the final state of the ten synthetic Slack rehearsal cases in
[the ten MVP rehearsals](agent-test-cases-zh.md), reviewed against the local evidence reports under
the gitignored `runtime/` directory.

**Cases 2-10 are accepted on synthetic development evidence. Case 1 was skipped by the owner and is
not passed.** Nothing in this record is a production acceptance. The rehearsals did run against a
real Slack provider and a real Supabase provider: synthetic test identities exchanged messages in an
approved real test Slack workspace, and the tools read and wrote the linked `dev_*` schema. What must
not be inferred is production use: no real member registry was involved, no `prod_*` business table
was written, and owner operations, publishing and payments were not exercised.

This record intentionally publishes none of the identifiers, message timings, member data, database
row identifiers or credentials that appear in the underlying reports. It cites conclusions and
observable behavior only.

## Scope and limits

- All messages were sent by synthetic test identities in two approved test channels of a real test
  Slack workspace (a provider-backed workspace, not a stub). Every database row involved is synthetic
  data in the linked `dev_*` schema of a real Supabase project; the tools did read and write that
  `dev_*` schema.
- Every `prod_*` business table stayed at zero rows across the runs, so there was no production
  business write. No migration was pushed to the production environment, no deployment was made, and
  no payment or funds provider was called.
- The live evidence was collected on the **pre-rename build**, where the tools, config block and
  tables still carried the historical `rein_mvp_*` names. The current PR head renames the tool
  interfaces, the config block, the tables and the RPCs to their long-term names. That head has unit
  and loader-level validation (the test suite, the manifest tool contract and `verify:plugin`) but
  **no live Slack retest after the rename**.
- Two base migrations are applied to the linked schema and define both the `dev_*` and `prod_*`
  objects. The later ballot-clock migration and the rename migration are committed in the sibling
  Foundation repository but are **not applied**.
- The verdicts below are the synthetic dev, case-document rubric outcome. They are not a release
  approval, and several cases keep explicit limitations.

## Case verdicts

| Case | Verdict | Basis | Retained limitation |
| --- | --- | --- | --- |
| 1 | **Skipped by owner; not passed** | No run | The unresolved-identity path needs an account with no verified identity link, and the D13 profile-email path needs the bot scopes plus an enabled config; the runner had neither. |
| 2 | Accepted (synthetic dev) | Inactive-Contributor refusal with a human next step and no write; active-Contributor two-step prepare/confirm submission with zero spending authorization | The tool-level `contributor_status_required` code was proven at module level; the natural-language turns stopped at the status read. |
| 3 | Accepted (synthetic dev) | One read-only field-collection call returned the missing fields, stored nothing and did not submit; the reply guard replaced the final Slack text with its own wording and carried no internal type code | Validation covers the two-turn collection path only; the submit / prepared-answer path was not exercised. |
| 4 | Accepted (synthetic dev) | Prepare turn wrote nothing; confirm turn wrote one proposal row whose proposer came from the trusted sender, read back through channel history | The next step is conversational text, not a structured field; the case does not require one. |
| 5 | Accepted (synthetic dev) | Ambiguous spoken alias reported as ambiguous and not guessed; unique configured label resolved to one stored type; read-only candidate listing; a fresh round after the overlap fix froze the oldest free candidate within the type's own cap | The over-limit reason code was proven at module level only; a cross-type "what can I vote on" question is still answered by a type-scoped read plus Agent prose. |
| 6 | Accepted (synthetic dev) | Voting by spoken title resolved a frozen candidate and wrote one ballot; omitted candidates clarified instead of silently abstaining; over-limit request refused with no ballot; same-title ambiguity clarified without a vote; the final build recorded the two/one/abstain shape and a title-only two-item vote, each delivered as the guard's fixed sentence | No deterministic title parser; not validated in a production workspace. |
| 7 | Accepted (synthetic dev) | Before the deadline the read is provisional with no counts or winner; after it the finalize RPC records the outcome and the reply carried winner, participation and abstention counts with no money movement; a `no_winner` tie round was exercised | Delivery remains model-relayed with no dedicated narration or reply tool. |
| 8 | Accepted (synthetic dev) | Ordinary title/summary revision applied by the Agent with no separate approval; material budget/schedule revision refused until a current director's approval is recorded, then applied; channel and role boundaries refused out-of-scope calls; repeat approval returned the recorded row | An active Contributor as feedback author remains an open product question (the database row allows it; the registered tools require a current director). |
| 9 | Accepted (synthetic dev) | Known-currency read returned amount, currency and recorded time from the read-only snapshot; unknown currency returned `unknown` / `no_snapshot` with a null amount and never displayed zero; a no-currency question clarified first and made no tool call; all funds turns were read-only and left the rows unchanged | The currency clarification is a workspace-prompt rule, not a deterministic guard; balances are test fixtures, not real funds. |
| 10 | Accepted (synthetic dev) | A request to pay and reserve against a passed vote was refused with the record-only explanation and a human next step | The result-is-not-a-funding-decision sub-item is carried by the read-only case 7 and case 9 turns; the payment-request runs made no tool calls. |

## Release gates that remain

- Apply the rename migration before enabling agent code that calls the long-term table and RPC names;
  the deployed database still answers on the historical names.
- Apply the pending migrations in order to the production environment as its own approved decision;
  production data writes are not covered by this acceptance.
- Re-run the cases against a live workspace on the post-rename build; this head has only unit and
  loader-level validation for the renamed interfaces.
- Install and configure the `users:read` / `users:read.email` bot scopes and enable the opt-in email
  identity match before claiming case 1.
- Decide the remaining product questions: the highest-count tie rule, whether an active Contributor
  may author feedback, deterministic spoken-to-tool mappings, and a dedicated result narration or
  reply surface.

## Evidence handling

The conclusions above are grounded in the gitignored reports under `runtime/`: the audit matrix
`runtime/ten-case-evidence-audit.md`, the final acceptance record `runtime/mvp-acceptance-complete-2026-09-28.md`
(it replaces the earlier `runtime/mvp-acceptance-handoff-2026-09-27.md`, which no longer exists),
the per-case evidence files, and the run log `runtime/mvp-test-log.md`. Those files retain the raw
identifiers, timings and fixture data and stay out of the repository; this record is the sanitized
public summary. Failed and partial historical runs listed in those reports are not erased by the
acceptance verdicts.
