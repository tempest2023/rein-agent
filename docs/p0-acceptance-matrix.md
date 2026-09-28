# P0 acceptance evidence matrix

This matrix tracks the PRD's AC01–AC20 against **current evidence**. “Core tested” means synthetic inputs exercised deterministic Rein-owned modules. It does not mean the real chat, member registry, website or finance provider has passed. A production result requires the provider evidence in the last column. The ten synthetic Slack
rehearsal cases and their final verdicts are in the [MVP Slack acceptance record](mvp-acceptance-2026-09-28.md).

## MVP slice versus deferred work

The strict P0 MVP is the four steps in [PRD §2.3](PRD-agent-community-operations.md): Slack identity
→ Contributor proposal → simple Board vote and result → read-only funds snapshot. In scope:
AC01–AC04, plus the parts of AC05–AC07 and AC16–AC17 those steps exercise. AC08–AC14 and AC18–AC20
belong to the deferred remainder and stay open until their phase starts.

**Build state: current PR head 2026-09-28** (the earlier 2026-09-24 build state is superseded; the
date below no longer describes the present tool set). The current PR head carries the long-term
`rein_*` interface names in the plugin and config, with the database-side rename migration still
unapplied, and has **no live Slack retest after the rename**. It has **12 database-backed tools —
four reads
(`rein_member_status`, `rein_funds`, `rein_poll_candidates`, `rein_vote_type_resolve`), one read-only
field collector (`rein_proposal_collect`), four writes and three post-result feedback tools — and they
register only when an explicit `foundationDb` config block enables them; enabling it hides the
synthetic simulators and the legacy proposal bridge.

| Tool | Kind | Code |
| --- | --- | --- |
| `rein_member_status` | read | `foundation-db-reader.ts`, `mvp-read-tools.ts` |
| `rein_funds` | read | `foundation-db-reader.ts`, `mvp-read-tools.ts` |
| `rein_poll_candidates` | read | `foundation-db-reader.ts`, `mvp-read-tools.ts` |
| `rein_vote_type_resolve` | read | `mvp-vote-type-resolve.ts`, `mvp-read-tools.ts` |
| `rein_proposal_collect` | read | `mvp-collect-tools.ts` |
| `rein_governance_proposal_submit` | write | `foundation-db-writer.ts`, `mvp-write-tools.ts` |
| `rein_poll_open` | write | `foundation-db-writer.ts`, `mvp-write-tools.ts` |
| `rein_poll_vote` | write | `foundation-db-writer.ts`, `mvp-write-tools.ts` |
| `rein_poll_result` | write | `mvp-vote-tally.ts`, `mvp-write-tools.ts` |
| `rein_proposal_comment_suggest` | write | `mvp-feedback-tools.ts`, `foundation-db-writer.ts` |
| `rein_revision_approve` | write | `mvp-feedback-tools.ts`, `foundation-db-writer.ts` |
| `rein_revision_apply` | write | `mvp-feedback-tools.ts`, `foundation-db-writer.ts` |

Those tool names, and the `foundationDb` config block, are the current stable interfaces; the source
files that hold them keep their historical `mvp-*.ts` filenames.

Post-result feedback is the one place where a confirmed rule has two asymmetric sides. An
**ordinary** revision, moving only the title or the summary, is accepted and made effective by the
Agent itself: `rein_revision_apply` succeeds with no separate approval recorded, in the caller's
turn. A **material** revision — budget, location, schedule, personnel or the major event flow, with
`schedule` material in the current implementation — is refused with `revision_not_approved` until a
current director records an approval through `rein_revision_approve`. All three calls are
limited to the approved Board channel and to a current director, because the voters are the Board;
the stored revision row additionally permits an **active Contributor** as its author, which is a
database-level allowance the registered tools do not currently expose. A comment applies nothing,
and no revision moves money.

Four deliberate MVP shapes are worth stating plainly. A poll is defined by a **stored vote type**,
not by a caller: `rein_poll_open` reads that type's own candidate cap, assembles the candidate
pool from stored proposals (offering recently unselected ones too) and lets the database freeze the
list, so no caller supplies candidates, a cap or an option label. There is still **no automatic
proposal-to-poll link** in the sense that no tool opens a poll *from* a proposal: the round is opened
by a director naming a vote type, and the agent then assembles the pool. Ballots are
**approve-only**: `rein_poll_vote` takes `approvedProposalIds`, refuses an entry outside the poll's
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

The Agent's tools have been exercised against real providers in the synthetic rehearsals: synthetic
test identities in a real test Slack workspace, reading and writing the linked `dev_*` Supabase
schema with synthetic rows, while every `prod_*` business table stayed at zero. The rows below remain
synthetic dev and module-level evidence, not a production pass. One installation serves one Slack
workspace; the pinned runtime supplies a trusted per-message sender in admitted channel and group
messages as well as in DMs, but no team ID. Slack sender identity is specified by D13 as an exact
match between the sender's Slack profile email and one `<env>_contact_identities` row, which needs
the governance app's `users:read` and `users:read.email` bot scopes; the resolver is implemented in
local code with tests, but it is opt-in and off by default (`foundationDb.identityEmailMatch` defaults to
`disabled`), and the email resolver's scopes and bot token are not installed or configured, so no live
workspace exercises that resolver and the retained link table stays the read path until it is
enabled. Two
migrations are **tracked in the sibling Foundation repository**
(`tempest2023/ReinProtocolFoundation`) on branch `tempest/agent-mvp-schema-and-welcome-email` (PR
#13, open). Its current committed head is `08542ad09932a4cefb62f230a9bdcf9fd4d32dfe` ("Adopt
long-term Rein governance names with legacy passthroughs", 2026-09-27); the earlier clock commit
`32977bfb6cd6ae73b81aa4b396f9ae1cb67d2ac8` ("Make the database clock authoritative for ballot
`cast_at`") is its parent, and the two MVP schema files were first authored at `4bd5ce8` ("Add the
Rein Agent MVP Slack identity, fund snapshot, and governance schema"). Both MVP migrations are
**applied to the linked project**:
`supabase/migrations/20260924094436_rein_slack_identity_and_fund_snapshots.sql` (identity links,
append-only funds snapshots) and
`supabase/migrations/20260924095705_rein_mvp_proposals_polls_ballots.sql` (proposals, polls, ballots)
were verified read-only on 2026-09-27 with `supabase migration list --linked` against project ref
`ksgyfyysnojqrwfuyqwe` (project name `BeneficenceProtocol`), applied in filename order. Each
migration creates the `dev_*` and `prod_*` objects in the same transaction, and `migration list` is
project-level, so the applied schema covers both prefixes; the app's `DATABASE_ENVIRONMENT=dev`
default selects which prefix a request reads and is not proof that only the `dev_*` schema exists.
A third sibling migration, `20260927103000_rein_mvp_ballot_cast_at_db_clock.sql`, was committed at
`32977bfb` and remains at the current head `08542ad`, but is **not applied** to the linked project,
so its clock authority is not in effect anywhere. A fourth sibling migration,
`20260927110000_rein_governance_names.sql`, is committed in PR #13 at head `08542ad` and also
**not applied**: it renames the physical tables and the two RPCs to their long-term names and keeps
the `<env>_rein_mvp_*` names reachable as compatibility views and RPC wrappers. Apply it after
`20260927103000` and before enabling agent code that calls the new names. The sibling code's local
pgTAP suite stands at 187/187 assertions at that same commit, run twice in an isolated container.
The phase-two migration carries the vote types, the approve-only ballot shape, the
frozen candidate list, the finalize RPC and the material-revision approval rule this document
describes, with pgTAP coverage in the sibling repository. The rehearsal runs did read and write the
linked `dev_*` tables, but on the **pre-rename build** (the historical `rein_mvp_*` interfaces) and
with synthetic rows only; the `prod_*` business tables were never written, and no live Slack retest
has run against the current post-rename head, so no schema claim here should be treated as a live
end-to-end result on the current head.

The Supabase/PostgREST boundary itself has a local integration test,
`tests/foundation-db-gateway.test.mjs`: it runs the reader and writer against a real HTTP loopback
server that simulates the PostgREST routes and the Supabase gateway's header rules, covering both a
modern `sb_secret_` key and a legacy `service_role` JWT, and asserting that a 401 becomes
`auth_error` while a 5xx stays `http_error`. That is a transport-level test, not a live project or a
real PostgREST instance.

| AC | Current evidence | Status | Evidence still required for launch |
| --- | --- | --- | --- |
| AC01 | `proposals.test.mjs` rejects formal submission by an unidentified account; `proposal-tool-bridge.test.mjs` proves a first unidentified sender can draft using host identity and cannot confirm; `foundation-db-reader.test.mjs` resolves a sender only through a verified identity link in the configured team. The D13 email resolver — trusted sender to a `users.info` profile email, exact match to one `<env>_contact_identities` row, contact and current role derived per request, a `revoked` or conflicting `verified` link row vetoing, and a missing, hidden, unmatched or ambiguous email failing closed — is implemented in local code and covered by `slack-email-lookup.test.mjs` and `foundation-db-reader.test.mjs`, but it is opt-in and off by default, so the reader still resolves through the link table unless `foundationDb.identityEmailMatch` is enabled. | Local tool, link-based reader and email resolver tested; the resolver is implemented but disabled by default, and its bot scopes and token are not installed or configured | The installed `users:read` and `users:read.email` scopes, a configured bot token, the resolver enabled against a live workspace, and a selected-platform sender joined to the authoritative current member registry. A normally invited member whose profile email is unmatched or missing is expected to fail closed as unidentified rather than to be treated as an ordinary unlinked user. |
| AC02 | `proposals.test.mjs` checks fields, versions and reconfirmation; `proposal-tool-bridge.test.mjs` exercises guarded create/revise/confirm/submit calls. | Local tool tested | Real chat conversation that gathers fields across messages and returns the confirmed summary. |
| AC03 | `proposals.test.mjs` checks explicit zero-budget authorization and blockers. | Core tested | Approved policy scope, responsible exception handler and real fast-track rehearsal. |
| AC04 | `proposals.test.mjs` routes complete funding requests to governance, including small amounts. | Core tested | Live Board round presentation and provider-backed proposal records. |
| AC05 | `p0-rehearsal.test.mjs` and `governance.test.mjs` freeze versions, roster, weights and rules; `foundation-db-writer.test.mjs` and `mvp-rehearsal.test.mjs` assemble a round's candidate pool from stored proposals of the named vote type, re-offering recently unselected ones, bounded by that type's own cap. The round-persistence test moved to a follow-up PR with `governance-store.ts`. The concrete cap values are still unapproved configuration. | Local modules and MVP tools tested; plus a synthetic dev run against the linked `dev_*` schema in the rehearsal workspace (type-scoped `rein_poll_candidates` read and candidate-pool opening). No production provider acceptance | Approved per-type cap values, authoritative finance availability and delivered Board briefing. |
| AC06 | `governance.test.mjs` rejects invalid, ineligible and late ballots; `foundation-db-reader.test.mjs` resolves the member and director role from the database; `mvp-write-tools.test.mjs` refuses a late ballot and a choice outside a stored poll's options. The refused-ballot audit, authoritative-registry eligibility and host-bound vote-tool checks moved to a follow-up PR with `governance-store.ts`, `registry-snapshot.ts` and `governance-tool-bridge.ts`. | Local modules tested; database tools registered only under explicit `foundationDb` config | Trusted sender-to-member identity, explicit vote confirmation in Slack, private ballot access, and a real round audit. |
| AC07 | `governance.test.mjs` covers replacement, recusal, abstention, quorum, ties and thresholds; `mvp-vote-tally.test.mjs` covers one equal weight per eligible member, an empty approval list casting no approval and a tie or empty poll producing `no_winner`; `mvp-write-tools.test.mjs` and `mvp-rehearsal.test.mjs` exercise the registered tools' approve-only enforcement, the per-poll `maxApprovalsPerVoter` bound, the frozen candidate list and the deadline that decides a round. `mvp-feedback-tools.test.mjs` covers the post-result rule in both directions: an ordinary title or summary revision is applied by the Agent with no separate approval, a material revision is refused with `revision_not_approved` until a current director's approval is recorded, a comment applies nothing, and every feedback call is Board-scoped. The Board-scoped recusal and retry checks in the host-bound vote bridge moved to a follow-up PR with `governance-tool-bridge.ts`. The per-type maximum approvals and candidate cap are confirmed rules (C08, C14, D08, D09) with concrete values still unapproved configuration. | Local modules and database tools tested, including the post-result feedback tools; database tools registered only under explicit `foundationDb` config | Confirmation of the highest-count tie rule, the approved per-type values, an approved voter list, the feedback author scope and a real round audit. Weighted, quorum and recusal rules are deferred from the MVP. |
| AC08 | `governance.test.mjs` reports shortfall and holds allocation when funds are unknown or insufficient. | Core tested; deferred from the MVP | Atomic reservation against an authoritative finance source under concurrent rounds. The MVP does not allocate one budget across competing proposals. |
| AC09 | Local implementation moved to a follow-up PR with `activities.ts` and `outbox-runner.ts`: a unique space intent plus provider receipt lookup and same-key retry against a fake provider. | Moved to follow-up PR | Provider receipt/lookup proving one real event space across timeout and retry. |
| AC10 | Local implementation moved to a follow-up PR with `activities.ts`: task completion cancelling chasing reminders, snooze, quiet hours, reminder suppression and the explicit timezone requirement for dispatch. | Moved to follow-up PR | Scheduled runner and delivered notification evidence under the chosen platform. |
| AC11 | Local implementation moved to a follow-up PR with `changes.ts` and `change-coordinator.ts`: change planning and guards plus a narrow durable handoff into guarded activity actions while retaining unsupported work. | Moved to follow-up PR | Transactional application to activity, registration, reminder and finance owners; actual recipient notifications for time, location, lead or cancellation changes. |
| AC12 | Local implementation moved to a follow-up PR with `activities.ts`: outcome fields and specific missing items. | Moved to follow-up PR | Real event channel intake and permissions for incremental materials. |
| AC13 | Local implementation moved to a follow-up PR with `activities.ts`: alternative materials and channel-specific consent. | Moved to follow-up PR | Website adapter excluding unauthorized media and handling withdrawal. |
| AC14 | Local implementation moved to a follow-up PR with `activities.ts` and `outbox-runner.ts`: lead fact confirmation, a single canonical article per activity, the separate `post_article_link` return intent, and consent/content/receipt checks before `published`. | Moved to follow-up PR | One real article with canonical URL; timeout recovery and correction. |
| AC15 | `foundation-db-reader.test.mjs` and `mvp-read-tools.test.mjs` cover the read-only funds snapshot the MVP exposes. The activity finance rules (`finance.approve_adjust`, the ordered overspend recovery, blocked settlement of unpaid obligations) moved to a follow-up PR with `activities.ts`. | Read-only snapshot reader tested; activity finance moved to follow-up PR; payment paths deferred from the MVP | Finance-owner reconciliation against actual records, plus real available-funds verification; no payment execution by Agent. The MVP shows a read-only snapshot only. |
| AC16 | `request-context.test.mjs` rejects unapproved channels and missing trusted senders. | Core tested | Platform permission test showing Board and private event data never appear in public or another event scope. |
| AC17 | `ledger.test.mjs` and `proposal-store.test.mjs` cover local idempotency and stale-process conflicts; `p0-rehearsal.test.mjs` exercises the ledger-backed proposal store across a restart. The refused-ballot audit and fake-provider uncertain receipt lookup moved to a follow-up PR with `governance-store.ts` and `outbox-runner.ts`. | Core tested | Kill/restart drill around live provider calls, uncertain receipt lookup and voting fairness decision. |
| AC18 | Local implementation moved to a follow-up PR with `oversight.ts`: routine progress separated from outstanding exceptions in a weekly summary. | Moved to follow-up PR | Real-source weekly summary delivered to authorized oversight recipients. |
| AC19 | Local implementation moved to a follow-up PR with `oversight.ts`: scoped pause/resume and retained work. | Moved to follow-up PR | Operator controls in real deployment and proof that no paused effect is sent. |
| AC20 | `p0-rehearsal.test.mjs` chains a synthetic zero-budget proposal and a synthetic funded proposal from identity link through the proposal core (US02, US04, US05, US15) and a frozen weighted governance round with deterministic allocation (US06, US07), using the ledger-backed proposal store across a restart. Activity execution, outcome and publication segments moved to a follow-up PR with `activities.ts` and are no longer asserted here. | Synthetic rehearsal passed for the proposal and governance chain | Two sandbox runs with real selected-platform and website adapters plus finance reconciliation. |

The integration requirements are in [provider contracts](integration-contracts.md), and the deployment/test instructions are in [the Chinese delivery record](implementation-and-deployment-zh.md). None of the rows is marked as a production pass until its provider evidence exists.

## Naming and the rename migration

A pre-launch review asked for the `mvp` naming to be removed from tools, tables, config and skills.
The plugin and configuration now use the stable names in the table above: the twelve tools and the
`foundationDb` config block. The database reaches matching names through the forward migration
`20260927110000_rein_governance_names.sql`, tracked as a release gate in
[provider contracts](integration-contracts.md#naming-and-the-rename-migration). It is committed in PR
#13 (at head `08542ad`) but **not applied** to the linked project; it renames the physical tables and
the two RPCs and keeps the earlier `<env>_rein_mvp_*` table and RPC names reachable as compatibility
views and wrappers during
the transition. Apply it after `20260927103000` and before enabling agent code that calls the new
names. Source file and test filenames keep their historical `mvp-*.mjs` names, which are not
interfaces.

The caller-facing names move with the plugin, so a caller that hits a malformed `foundationDb` block
or an unset named variable now reads `foundation_db_config_invalid` or
`foundation_db_env_value_missing`, and `rein_status` reports `foundationDbReadToolsEnabled`,
`foundationDbWriteToolsEnabled`, `foundationDbCollectToolsEnabled` and `foundationDbFeedbackToolsEnabled`.
These are code interfaces, not
schema, so they need no migration. The `<env>_rein_mvp_*` compatibility views and RPC wrappers stay
until the old-name clients are replaced and verified on the new `<env>_rein_*` names; a later
migration removes them, and they must never be dropped while an old client is still active.
