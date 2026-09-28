# MVP integration contracts: Slack, database, and money boundary

The MVP vertical slice is Slack identity, a Contributor proposal, a Board approval vote with a
result, and a read-only funds snapshot. This file lists what each boundary must supply, and what the
MVP deliberately does not do. Broader provider work for activities, publishing and oversight is
deferred; see [decisions](decisions.md).

## Slack (official OpenClaw `slack` plugin)

| Item | Requirement |
| --- | --- |
| Transport | Socket Mode against the official plugin that ships in the pinned upstream checkout; no public webhook path is required. |
| Credentials | A bot token and an app-level token, supplied through the server environment or the runtime's own secret store. No token, signing secret or team ID may appear in this repository, in plugin config, or in any tool result. |
| Workspace | Exactly one Slack workspace per installation. |
| Sender | The acting user comes from the runtime's trusted per-message sender (`requesterSenderId`), which admitted channel and group messages carry the same way as DMs. No tool argument, display name or role label establishes identity; the community identity behind that sender is resolved as described below. |
| Sender email lookup | The receiving bot resolves the trusted sender's current Slack profile email with `users.info`, which requires the governance app to hold the bot scopes `users:read` and `users:read.email`. This path is opt-in and not installed: no Slack workspace is connected, and until the scopes are installed on the governance app the sender stays unresolved. The local human test user app keeps `chat:write` as its only scope and carries no bot scope, so it cannot perform this lookup. |
| Email to community record | The returned email is normalized and must match exactly one `<env>_contact_identities` row. The contact and its current Contributor or director role are derived from that row at request time. Resolution never creates, updates or persists a Slack link, and the Slack team stays fixed operator configuration. |
| Legacy link rows | `<env>_rein_slack_links` is retained as a legacy and revocation record, not as a grant. A `revoked` row vetoes the sender, and a `verified` row whose contact conflicts with the matched email also vetoes the sender. The Agent writes no link row. |
| Unresolved sender | A missing or hidden profile email, an email that matches no row or more than one row, or a matched row with no usable contact fails closed: the sender may ask questions but cannot submit, vote or act, and no governance record is written. |
| Channels | Explicitly approved proposal and Board channel IDs, in native Slack form. A call from any other channel is refused before any database access. |
| Missing team ID | The trusted tool context carries the platform, the channel and the sender, but no Slack team or workspace ID. The team is fixed operator configuration, so pointing one installation at several workspaces would resolve senders against the wrong community records. |
| Outbound messages | The MVP tools return results to the calling turn and do not post to Slack on their own. The result tool in particular only returns the result; nothing auto-posts it back to the channel. Any future posting must persist intent plus an idempotency key before delivery. |

## Database (organization's own Supabase project)

Members, directors, Slack identity links, proposals, polls, ballots and available-funds figures live
in the organization's own database, not in this repository. Development and production share one
project with isolated `dev_*` and `prod_*` table sets; the environment selector has no implicit
default.

The slice's migrations live in the sibling Foundation repository `tempest2023/ReinProtocolFoundation`,
which carries them on branch `tempest/agent-mvp-schema-and-welcome-email` (PR #13, open). The
committed branch head is `f15c7eabbc65a4ec998125632d62db05e9aec6f4` ("Adopt long-term Rein
governance names with legacy passthroughs", 2026-09-27); the two MVP schema commits below and the
clock commit `32977bfb6cd6ae73b81aa4b396f9ae1cb67d2ac8` ("Make the database clock authoritative
for ballot `cast_at`", 2026-09-27) are its ancestors, and the two schema files were first authored
at `4bd5ce8` ("Add the Rein Agent MVP Slack identity, fund snapshot, and governance schema",
2026-09-26). The sibling repo holds pgTAP coverage in
`supabase/tests/rein_mvp_governance.sql`, `supabase/tests/rls.sql` and
`supabase/tests/environment_parity.sql`, at a local plan count of 187 assertions (187/187, run
twice in an isolated container at the current sibling head). The two **applied** migrations are
verified read-only on 2026-09-27 with `supabase migration list --linked` against project ref
`ksgyfyysnojqrwfuyqwe` (project name `BeneficenceProtocol`), which lists both as remote:

| Migration | Adds |
| --- | --- |
| `20260924094436_rein_slack_identity_and_fund_snapshots.sql` | `rein_slack_links` and append-only `rein_fund_snapshots`, in both table sets |
| `20260924095705_rein_mvp_proposals_polls_ballots.sql` | proposals, polls and ballots (originally `rein_mvp_proposals`, `rein_mvp_polls` and `rein_mvp_ballots`), in both table sets |

The sibling branch now carries a third, **unapplied** migration:
`20260927103000_rein_mvp_ballot_cast_at_db_clock.sql`. It was committed at `32977bfb` and is still
present at the current head `f15c7ea`, but the linked remote project does not have it; the database
clock being authoritative for a ballot's `cast_at` is therefore **not in effect anywhere** yet.
Applying it needs its own reviewed `supabase db push`, and no document here may be read as claiming
it is applied.

A fourth sibling migration is committed in PR #13 but **unapplied**:
`20260927110000_rein_governance_names.sql`, committed at `f15c7ea` and ordered after `20260927103000`.
It renames the five physical tables from `<env>_rein_mvp_*` to their long-term names and renames the
two RPCs, then keeps the old table and RPC names reachable as read/write compatibility views and RPC
wrappers for the transition. It is not applied to the linked project, so the deployed database still
answers on the old names.

**Applied order and compatibility.** They apply in filename order after the earlier community
migrations (the `202608120001` and `202608130001` families, which already provide
`<env>_contact_identities`): `20260924094436` first, then `20260924095705`. The second migration is
additive to the first and defines the phase-2 shapes this slice uses (vote types, the approve-only
ballot, the frozen candidate list, the `<env>_rein_finalize_poll` and
`<env>_rein_approve_revision` RPCs, created at that time under the old `mvp` names), so the two are forward-compatible when applied in that order.
Each migration creates the `dev_*` and `prod_*` objects in the same transaction (the first defines
both table families explicitly, the second loops over `array['dev_', 'prod_']`), and `supabase
migration list --linked` is project-level, so the applied schema covers both prefixes. The local
app's `DATABASE_ENVIRONMENT=dev` is only a client-side default for which prefix a request reads; it
is not evidence that only the `dev_*` schema exists.

**Migration order to apply.** The sibling migrations apply in filename order after the
`202608120001` / `202608130001` families: `20260924094436`, `20260924095705`, `20260927103000`,
then `20260927110000`. The first two are already applied to the linked project; the third and fourth
are pending, and only a human-run `supabase db push` (or an equivalent reviewed step) puts them into
the linked project. Apply `20260927103000` before `20260927110000`, and apply the rename migration
`20260927110000` before enabling agent code that calls the new tool, table or RPC names; until then
the deployed schema and RPCs answer on the old `<env>_rein_mvp_*` names. When the clock migration is
applied, both the `dev_*` and `prod_*` guards are the ones that assign `NEW.cast_at := now()`
before the window check, because the sibling migration loops over both prefixes.

**What the applied migrations do not prove.** Applying a migration is not the same as the Agent
using it, and schema registration is not proof of any row. No Slack workspace is connected, the
Agent has no live database connection, and no end-to-end read, write or vote has run against either
prefix. Neither the `dev_*` nor the `prod_*` table set has verified data or verified Agent use, and
the `prod_*` set is not a separate schema step to schedule: the objects already exist there. Every
tool result in this PR is from local modules and synthetic tests.

Required contract properties:

- One `<env>_contact_identities` row maps one normalized email to one community contact, and the
  Slack MVP resolves a sender by a single exact email match against that table, deriving the contact
  and its current role at request time. Display names never establish identity, and one person with
  several Slack accounts that share one email resolves to one canonical contact. A retained link row
  is a veto rather than a grant: `revoked` blocks the sender, and `verified` with a conflicting
  contact blocks the sender. A missing, hidden, unmatched or ambiguous email fails closed instead of
  creating a link or a contact, and the resolver never writes a link row. The `<env>_contact_identities`
  table is part of the earlier community schema, which the linked project already carries, so the
  resolver's read target exists there; the email resolver itself is still off by default and has not
  been exercised against that project.
- `contributors.status = 'active'` is the only source of Contributor eligibility, and
  `people.person_type = 'director'` is the only source of Board eligibility. Free-text role fields
  are not consulted.
- **Ballots are approve-only.** A ballot records one or more approvals, or `abstain`, which means no
  approvals. There is no reject choice. The per-type maximum approvals per voter bounds how many
  approvals one voter may hold in a round, and the per-type candidate cap bounds how many candidates
  a round may carry; a round with a single candidate is valid. The counting rule is the highest
  approval count; an all-abstain round has no winner, and a highest-count tie must not be recorded as
  an official winner or silently broken.
- Poll options and the voting window are fixed when the poll is created; a change is a new poll, not
  an edit. Ballots are immutable and unique per poll and voter, so a repeated identical call is the
  same record and a changed choice is refused rather than overwritten.
- Every governance table enables RLS, grants nothing to `anon` or `authenticated`, and is reachable
  only by the server-side secret key. No credential is stored in plugin config; config names the
  environment variables instead.
- A funds figure is a human-entered snapshot in integer minor units with an explicit currency. It is
  append-only; a correction is a new row, and the newest `recorded_at` wins. An absent or unusable
  snapshot must be reported as explicitly unknown, never as zero.
- The schema also refuses writes it can reject on its own: `abstain` is a reserved option label, a
  ballot must name one of its poll's stored options (or `abstain`), a poll's options and window are
  frozen once a ballot exists, and deleting a contact or a poll that carries history is refused.
  Role checks run inside the inserting transaction against current role rows rather than trusting a
  caller-supplied role.
- Because role rows hold only current state, a database guard answers "is this person a director
  now". If role history becomes available, a guard should also accept someone who was a director
  when the record was written.

**Enforcement status.** The approve-only rule above is now the registered code path.
`rein_poll_open` refuses a caller-supplied candidate list, cap or option label
(`policy_argument_rejected`, and `legacy_options_unsupported` at the write layer) and assembles the
pool from stored proposals of the named vote type; `rein_poll_vote` accepts `approvedProposalIds`
only, an empty list is the abstention, and the database freezes the candidate list and both limits
at insert time. The local migrations are the source of that enforcement. They are reviewed and
committed in the sibling Foundation repository (`tempest2023/ReinProtocolFoundation`) and applied to
the linked `BeneficenceProtocol` project's `dev_*` set, but no registered tool has exercised them
against that project: the enforcement described above is proven by local tests only, and nothing
here is a live end-to-end result. The concrete per-type cap and approval-budget values remain
unapproved operator configuration.

## Naming and the rename migration

A pre-launch review asked for the `mvp` naming to be removed across tools, tables, config and skills.
The names below are the current, stable interfaces. The plugin and its configuration use them today;
the database reaches them through the forward migration `20260927110000_rein_governance_names.sql`,
which is committed in PR #13 (at head `f15c7ea`) but **not applied** to the linked project. The
migration renames the physical tables and RPCs and keeps the earlier `<env>_rein_mvp_*` table and RPC
names reachable as read/write compatibility views and RPC wrappers during the transition. Apply the
migration before enabling agent code that calls the new names; until then the deployed database still
answers on the old names.

| Interface | Current names |
| --- | --- |
| Registered tools | `rein_member_status`, `rein_funds`, `rein_governance_proposal_submit`, `rein_poll_open`, `rein_poll_vote`, `rein_poll_result`, `rein_proposal_comment_suggest`, `rein_revision_approve`, `rein_revision_apply` |
| Plugin config block | the `foundationDb` object under `plugins.entries.rein-operations.config`, including its `enabled` flag |
| Caller-visible refusal codes | `foundation_db_config_invalid` for a malformed `foundationDb` block, and `foundation_db_env_value_missing` for a named server environment variable that is unset or empty |
| `rein_status` flags | `foundationDbReadToolsEnabled`, `foundationDbWriteToolsEnabled`, `foundationDbFeedbackToolsEnabled` |
| Tables | `<env>_rein_proposals`, `<env>_rein_polls`, `<env>_rein_ballots`, `<env>_rein_vote_types`, `<env>_rein_proposal_revisions` |
| RPCs | `<env>_rein_finalize_poll`, `<env>_rein_approve_revision` |
| Compatibility names | `<env>_rein_mvp_*` tables and RPCs, kept alive by the rename migration's views and wrappers until callers move over |

The plugin's own names for tools, config, refusal codes and status flags are adopted in the code and
need no migration. The tables and RPCs are the part that lags, because the two base `20260924*`
migrations were applied under the old `mvp` names, so renaming them in place would edit applied
history; the forward migration `20260927110000_rein_governance_names.sql` does the rename instead.

The migration is a release gate, not a wording edit: the tables and RPCs are already applied to the
linked dev project, so the rename is a schema change with its own review. No document claims it is
applied or live.

PR #13 is still open, and the `20260927110000` migration now includes the rename work it needs to
stand on its own: in each environment it renames the ten helper and trigger functions alongside the
five tables and two RPCs, rewrites the bodies to the new physical table, helper and GUC names, and
renames the dependent triggers, constraints and indexes. The rename therefore no longer leans on the
old names it is replacing, and the migration keeps exactly ten old-name views and four old-name RPC
wrappers for compatibility. Because the migration is **not applied** to the linked project, editing
it before it is applied does not rewrite applied history; the two base `20260924*` migrations stay
applied and keep their historical filenames unchanged. Only after `20260927110000` is applied does it
become part of applied history and stop being editable.

**Compatibility retirement.** The `<env>_rein_mvp_*` views and RPC wrappers are a transition
mechanism, not the long-term contract. They stay in place while any runtime client still calls the
old names, because dropping a view or wrapper while an old client is active would break that client
with no replacement. The criterion for retirement is that the old-name clients have been replaced
and verified on the new `<env>_rein_*` names. Until that verification exists, the migration that
removes the views and wrappers is deferred and must never be merged or applied ahead of it.

## Money boundary

The MVP has no payment path. A passed vote is a decision record: it does not reserve, approve,
disburse or reconcile money, and it does not alter a funds snapshot. Payment, reimbursement and
settlement stay with authorized people outside the Agent, and the finance state machine in the
broader PRD is deferred.

## Recovery and replay

- Every refusal collapses to a fixed reason code. Provider text, the Supabase URL, the Slack team ID
  and the service key are never echoed to a caller.
- Proposal and poll identifiers derive from the tool call ID, the acting contact and the action.
  Repeating the same call inside the same turn addresses the same record and is reported as an exact
  duplicate instead of inserting a second row.
- **That is not exactly-once across processes.** A tool call ID is not a trusted inbound message ID,
  and the current derivation is only memoized per turn, so a re-delivered Slack event, a retry in a
  new turn, or two workers handling the same event can still produce two records. Exactly-once
  semantics need a stable platform event identity; until one is wired, callers must not assume it.
- A failed read is never reported as an empty result. If stored ballots cannot be read, there is no
  official result; if stored options cannot be counted, the poll reports unavailable rather than a
  zero-vote outcome.

## Provisioning and seeding

Everything below is a human step with a review; no Agent tool performs it.

1. The two base migrations (`20260924094436` and `20260924095705`) are already applied to the linked
   project in filename order and define both the `dev_*` and `prod_*` objects. The clock migration
   (`20260927103000`) and the rename migration (`20260927110000`) are still pending there. Apply the
   pending two in filename order, the clock migration first, then the rename; apply the rename before
   enabling agent code that calls the new names. Apply them to any new environment in the same order,
   and never from a script that also runs the Agent.
2. Seed the email-to-contact identity rows (`<env>_contact_identities`), Contributor and director
   records, and an initial funds snapshot by hand, or through a reviewed administrative path. Do not
   seed fabricated people into a live environment.
3. Create the Slack app, enable Socket Mode, install it into the single target workspace with the
   bot scopes `users:read` and `users:read.email` that the email resolver needs, and invite the bot
   to the approved proposal and Board channels. Until those scopes are installed on the governance
   app, the resolver stays off and every sender is unresolved.
4. Record the approved native channel IDs and the one workspace ID in operator configuration, and
   point the two Supabase environment variables at server-side secrets.
5. Enable the `foundationDb` config block explicitly. Until then, no database-backed tool is
   registered.

## Not in this slice

Weighted voting, quorum, recusal, competing-budget allocation, zero-budget fast track, activity
spaces, reminders, outcome collection, articles, website publication, weekly oversight and pause
controls stay deferred. The activity, change, oversight and outbox cores are unreachable from the
plugin entry and their implementation moved to a follow-up PR; the remaining deferred modules stay
unregistered. Payment, signing, identity escalation and any on-chain or DAO migration remain outside
the Agent.
