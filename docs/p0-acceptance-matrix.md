# P0 acceptance evidence matrix

This matrix tracks the PRD's AC01–AC20 against **current evidence**. “Core tested” means synthetic inputs exercised deterministic Rein-owned modules. It does not mean the real chat, member registry, website or finance provider has passed. A production result requires the provider evidence in the last column.

## MVP slice versus deferred work

The strict P0 MVP is the four steps in [PRD §2.3](PRD-agent-community-operations.md): Slack identity
→ Contributor proposal → simple Board vote and result → read-only funds snapshot. In scope:
AC01–AC04, plus the parts of AC05–AC07 and AC16–AC17 those steps exercise. AC08–AC14 and AC18–AC20
belong to the deferred remainder and stay open until their phase starts.

Build state as of 2026-09-24. Two read tools, four write tools and three post-result feedback tools
exist and register only when an explicit `mvp` config block enables them; enabling it hides the
synthetic simulators and the legacy proposal bridge.

| Tool | Kind | Code |
| --- | --- | --- |
| `rein_mvp_my_status` | read | `foundation-db-reader.ts`, `mvp-read-tools.ts` |
| `rein_mvp_funds` | read | `foundation-db-reader.ts`, `mvp-read-tools.ts` |
| `rein_mvp_proposal_submit` | write | `foundation-db-writer.ts`, `mvp-write-tools.ts` |
| `rein_mvp_poll_open` | write | `foundation-db-writer.ts`, `mvp-write-tools.ts` |
| `rein_mvp_vote` | write | `foundation-db-writer.ts`, `mvp-write-tools.ts` |
| `rein_mvp_poll_result` | write | `mvp-vote-tally.ts`, `mvp-write-tools.ts` |
| `rein_mvp_proposal_comment_suggest` | write | `mvp-feedback-tools.ts`, `foundation-db-writer.ts` |
| `rein_mvp_revision_approve` | write | `mvp-feedback-tools.ts`, `foundation-db-writer.ts` |
| `rein_mvp_revision_apply` | write | `mvp-feedback-tools.ts`, `foundation-db-writer.ts` |

Post-result feedback is the one place where a confirmed rule has two asymmetric sides. An
**ordinary** revision, moving only the title or the summary, is accepted and made effective by the
Agent itself: `rein_mvp_revision_apply` succeeds with no separate approval recorded, in the caller's
turn. A **material** revision — budget, location, schedule, personnel or the major event flow, with
`schedule` material in the current implementation — is refused with `revision_not_approved` until a
current director records an approval through `rein_mvp_revision_approve`. All three calls are
limited to the approved Board channel and to a current director, because the voters are the Board;
the stored revision row additionally permits an **active Contributor** as its author, which is a
database-level allowance the registered tools do not currently expose. A comment applies nothing,
and no revision moves money.

Four deliberate MVP shapes are worth stating plainly. A poll is defined by a **stored vote type**,
not by a caller: `rein_mvp_poll_open` reads that type's own candidate cap, assembles the candidate
pool from stored proposals (offering recently unselected ones too) and lets the database freeze the
list, so no caller supplies candidates, a cap or an option label. There is still **no automatic
proposal-to-poll link** in the sense that no tool opens a poll *from* a proposal: the round is opened
by a director naming a vote type, and the agent then assembles the pool. Ballots are
**approve-only**: `rein_mvp_vote` takes `approvedProposalIds`, refuses an entry outside the poll's
frozen candidates or above the poll's own `maxApprovalsPerVoter`, and treats an empty list as the
abstention. A poll's counts are **provisional until the closing time**: before it the tool reports
`provisional`, `official: false` and no count or winner, and only at or after the deadline does the
finalize RPC close the round and store the outcome from the ballots the database already accepted.
A **highest-count tie is not an official outcome**: with the tie rule still unadopted, the stored
outcome is `no_winner` with a null winner, and the run never announces a winner it has no adopted
rule for. An all-abstain round is settled by the confirmed rule and also stores `no_winner`, which is
not the same as the undecided tie.

**Replay safety is limited.** Identifiers derive from the tool call ID, the acting contact and the
action, which makes a repeated call inside one turn an exact duplicate, but a tool call ID is not a
trusted inbound message ID and the derivation is memoized per turn. A re-delivered Slack event or a
retry in a new turn can still insert a second record, so these rows are not evidence of
cross-process exactly-once behaviour.

The Agent has no live database connection and no real Slack workspace is wired: the rows below are
local module and synthetic-test evidence, not a production pass. One installation serves one Slack
workspace; the pinned runtime supplies a trusted per-message sender in admitted channel and group
messages as well as in DMs, but no team ID. Slack sender identity is specified by D13 as an exact
match between the sender's Slack profile email and one `<env>_contact_identities` row, which needs
the governance app's `users:read` and `users:read.email` bot scopes; the resolver is implemented in
local code with tests, but it is opt-in and off by default (`mvp.identityEmailMatch` defaults to
`disabled`), and the scopes and bot token are not installed or configured, so no live workspace or
database exercises it and the retained link table stays the read path until it is enabled. Two
migrations are **tracked in the sibling Foundation repository**
(`tempest2023/ReinProtocolFoundation`) at commit `4bd5ce8` ("Add the Rein Agent MVP Slack identity,
fund snapshot, and governance schema") on branch `tempest/agent-mvp-schema-and-welcome-email`, and
both are **applied to the linked project**:
`supabase/migrations/20260924094436_rein_slack_identity_and_fund_snapshots.sql` (identity links,
append-only funds snapshots) and
`supabase/migrations/20260924095705_rein_mvp_proposals_polls_ballots.sql` (proposals, polls, ballots)
were verified read-only on 2026-09-27 with `supabase migration list --linked` against project ref
`ksgyfyysnojqrwfuyqwe` (project name `BeneficenceProtocol`, `DATABASE_ENVIRONMENT=dev`), applied in
filename order. The phase-two migration carries the vote types, the approve-only ballot shape, the
frozen candidate list, the finalize RPC and the material-revision approval rule this document
describes, with pgTAP coverage in the sibling repository. Applied schema is still not exercised by
the Agent: no registered tool has read or written the linked tables, so no schema claim here should
be treated as a live end-to-end result.

The Supabase/PostgREST boundary itself has a local integration test,
`tests/foundation-db-gateway.test.mjs`: it runs the reader and writer against a real HTTP loopback
server that simulates the PostgREST routes and the Supabase gateway's header rules, covering both a
modern `sb_secret_` key and a legacy `service_role` JWT, and asserting that a 401 becomes
`auth_error` while a 5xx stays `http_error`. That is a transport-level test, not a live project or a
real PostgREST instance.

| AC | Current evidence | Status | Evidence still required for launch |
| --- | --- | --- | --- |
| AC01 | `proposals.test.mjs` rejects formal submission by an unidentified account; `proposal-tool-bridge.test.mjs` proves a first unidentified sender can draft using host identity and cannot confirm; `foundation-db-reader.test.mjs` resolves a sender only through a verified identity link in the configured team. The D13 email resolver — trusted sender to a `users.info` profile email, exact match to one `<env>_contact_identities` row, contact and current role derived per request, a `revoked` or conflicting `verified` link row vetoing, and a missing, hidden, unmatched or ambiguous email failing closed — is implemented in local code and covered by `slack-email-lookup.test.mjs` and `foundation-db-reader.test.mjs`, but it is opt-in and off by default, so the reader still resolves through the link table unless `mvp.identityEmailMatch` is enabled. | Local tool, link-based reader and email resolver tested; the resolver is implemented but disabled by default, and its bot scopes and token are not installed or configured | The installed `users:read` and `users:read.email` scopes, a configured bot token, the resolver enabled against a live workspace, and a selected-platform sender joined to the authoritative current member registry. A normally invited member whose profile email is unmatched or missing is expected to fail closed as unidentified rather than to be treated as an ordinary unlinked user. |
| AC02 | `proposals.test.mjs` checks fields, versions and reconfirmation; `proposal-tool-bridge.test.mjs` exercises guarded create/revise/confirm/submit calls. | Local tool tested | Real chat conversation that gathers fields across messages and returns the confirmed summary. |
| AC03 | `proposals.test.mjs` checks explicit zero-budget authorization and blockers. | Core tested | Approved policy scope, responsible exception handler and real fast-track rehearsal. |
| AC04 | `proposals.test.mjs` routes complete funding requests to governance, including small amounts. | Core tested | Live Board round presentation and provider-backed proposal records. |
| AC05 | `governance.test.mjs` freezes versions, roster, weights and rules; `governance-store.test.mjs` restores an explicitly approved round after restart; `foundation-db-writer.test.mjs` and `mvp-rehearsal.test.mjs` assemble a round's candidate pool from stored proposals of the named vote type, re-offering recently unselected ones, bounded by that type's own cap. The concrete cap values are still unapproved configuration. | Local modules and MVP tools tested; no live database | Approved per-type cap values, authoritative finance availability and delivered Board briefing. |
| AC06 | `governance.test.mjs` rejects invalid, ineligible and late ballots; `governance-store.test.mjs` audits refused attempts; `registry-snapshot.test.mjs` checks role expiry and identity conflicts; `governance-tool-bridge.test.mjs` binds votes to host identity and Board scope; `foundation-db-reader.test.mjs` resolves the member and director role from the database; `mvp-write-tools.test.mjs` refuses a late ballot and a choice outside a stored poll's options. | Local modules tested; MVP tools registered only under explicit `mvp` config | Trusted sender-to-member identity, explicit vote confirmation in Slack, private ballot access, and a real round audit. |
| AC07 | `governance.test.mjs` covers replacement, recusal, abstention, quorum, ties and thresholds; `governance-tool-bridge.test.mjs` checks Board-scoped recusal and retry behavior; `mvp-vote-tally.test.mjs` covers one equal weight per eligible member, an empty approval list casting no approval and a tie or empty poll producing `no_winner`; `mvp-write-tools.test.mjs` and `mvp-rehearsal.test.mjs` exercise the registered tools' approve-only enforcement, the per-poll `maxApprovalsPerVoter` bound, the frozen candidate list and the deadline that decides a round. `mvp-feedback-tools.test.mjs` covers the post-result rule in both directions: an ordinary title or summary revision is applied by the Agent with no separate approval, a material revision is refused with `revision_not_approved` until a current director's approval is recorded, a comment applies nothing, and every feedback call is Board-scoped. The per-type maximum approvals and candidate cap are confirmed rules (C08, C14, D08, D09) with concrete values still unapproved configuration. | Local modules and MVP tools tested, including the post-result feedback tools; MVP tools registered only under explicit `mvp` config | Confirmation of the highest-count tie rule, the approved per-type values, an approved voter list, the feedback author scope and a real round audit. Weighted, quorum and recusal rules are deferred from the MVP. |
| AC08 | `governance.test.mjs` reports shortfall and holds allocation when funds are unknown or insufficient. | Core tested; deferred from the MVP | Atomic reservation against an authoritative finance source under concurrent rounds. The MVP does not allocate one budget across competing proposals. |
| AC09 | `activities.test.mjs` records a unique space intent; `outbox-runner.test.mjs` exercises receipt lookup and same-key retry with a fake provider. | Core tested | Provider receipt/lookup proving one real event space across timeout and retry. |
| AC10 | `activities.test.mjs` covers task completion cancelling chasing reminders, snooze, quiet hours, reminder suppression and the explicit timezone requirement for dispatch. | Core tested | Scheduled runner and delivered notification evidence under the chosen platform. |
| AC11 | `changes.test.mjs` covers planning and guards; `change-coordinator.test.mjs` covers a narrow durable handoff into guarded activity actions while retaining unsupported work. | Partial local application; propagation incomplete | Transactional application to activity, registration, reminder and finance owners; actual recipient notifications for time, location, lead or cancellation changes. |
| AC12 | `activities.test.mjs` collects outcome fields and specific missing items. | Core tested | Real event channel intake and permissions for incremental materials. |
| AC13 | `activities.test.mjs` allows alternative materials and channel-specific consent. | Core tested | Website adapter excluding unauthorized media and handling withdrawal. |
| AC14 | `activities.test.mjs` requires lead fact confirmation, enforces a single canonical article per activity and tracks the separate `post_article_link` return intent; `outbox-runner.test.mjs` checks consent, content and receipt before `published`. | Core tested | One real article with canonical URL; timeout recovery and correction. |
| AC15 | `activities.test.mjs` keeps requested, approved, reserved, paid and settled amounts distinct, audits funding adjustments (`finance.approve_adjust`), and recovers an unresolved overspend only through the ordered steps approval (`finance.approve`) → reservation (`finance.reserve`) → payment → settlement; settling an unpaid obligation is blocked. `foundation-db-reader.test.mjs` and `mvp-read-tools.test.mjs` cover the read-only funds snapshot the MVP exposes. | Core tested and the read-only snapshot reader tested; payment paths deferred from the MVP | Finance-owner reconciliation against actual records, plus real available-funds verification; no payment execution by Agent. The MVP shows a read-only snapshot only. |
| AC16 | `request-context.test.mjs` rejects unapproved channels and missing trusted senders. | Core tested | Platform permission test showing Board and private event data never appear in public or another event scope. |
| AC17 | `ledger.test.mjs`, `proposal-store.test.mjs`, `governance-store.test.mjs`, activity/oversight/change/coordinator tests and `outbox-runner.test.mjs` cover local idempotency, stale-process conflicts, refused-ballot audit and fake-provider uncertain receipt lookup. | Core tested | Kill/restart drill around live provider calls, uncertain receipt lookup and voting fairness decision. |
| AC18 | `oversight.test.mjs` separates routine progress and outstanding exceptions in a weekly summary. | Core tested | Real-source weekly summary delivered to authorized oversight recipients. |
| AC19 | `oversight.test.mjs` covers scoped pause/resume and retained work. | Core tested | Operator controls in real deployment and proof that no paused effect is sent. |
| AC20 | `p0-rehearsal.test.mjs` chains synthetic zero-budget and funded activities through outcomes and finance records. | Synthetic rehearsal passed | Two sandbox runs with real selected-platform and website adapters plus finance reconciliation. |

The integration requirements are in [provider contracts](integration-contracts.md), and the deployment/test instructions are in [the Chinese delivery record](implementation-and-deployment-zh.md). None of the rows is marked as a production pass until its provider evidence exists.

## Pending release gate: MVP naming removal

A pre-launch review asks for the `mvp` naming to be removed from tools, tables, config and skills.
That rename is not done here and is tracked as a release gate in
[provider contracts](integration-contracts.md#pending-release-gate-mvp-naming-removal). Because the
two migrations are already applied to the linked project, it needs a forward-compatibility migration
that keeps the current `rein_mvp_*` tool names, the `mvp` config block and the `<env>_rein_mvp_*`
table and RPC names working while callers move over. Until that migration is reviewed and applied,
every name in this matrix stands as written.
