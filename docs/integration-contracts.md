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

Two migrations live in the sibling Foundation repository `tempest2023/ReinProtocolFoundation`. They
are tracked in commit `4bd5ce8` ("Add the Rein Agent MVP Slack identity, fund snapshot, and
governance schema", 2026-09-26) on branch `tempest/agent-mvp-schema-and-welcome-email`, with pgTAP
coverage in `supabase/tests/rein_mvp_governance.sql`, `supabase/tests/rls.sql` and
`supabase/tests/environment_parity.sql`. Both are **applied to the linked project**, verified
read-only on 2026-09-27 with `supabase migration list --linked` against project ref
`ksgyfyysnojqrwfuyqwe` (project name `BeneficenceProtocol`), which lists both as remote:

| Migration | Adds |
| --- | --- |
| `20260924094436_rein_slack_identity_and_fund_snapshots.sql` | `rein_slack_links` and append-only `rein_fund_snapshots`, in both table sets |
| `20260924095705_rein_mvp_proposals_polls_ballots.sql` | `rein_mvp_proposals`, `rein_mvp_polls` and `rein_mvp_ballots`, in both table sets |

**Applied order and compatibility.** They apply in filename order after the earlier community
migrations (the `202608120001` and `202608130001` families, which already provide
`<env>_contact_identities`): `20260924094436` first, then `20260924095705`. The second migration is
additive to the first and defines the phase-2 shapes this slice uses (vote types, the approve-only
ballot, the frozen candidate list, the `<env>_rein_mvp_finalize_poll` and
`<env>_rein_mvp_approve_revision` RPCs), so the two are forward-compatible when applied in that
order. The application was verified against the linked project with `DATABASE_ENVIRONMENT=dev`, so
the applied rows are the `dev_*` table set; the `prod_*` set was not exercised and stays a separate
decision. A later sibling change may add a further migration on top of `4bd5ce8`; that change is not
part of this verified set, and no document here should be read as claiming it is applied.

**What the applied migrations do not prove.** Applying a migration is not the same as the Agent
using it. No Slack workspace is connected, the Agent has no live database connection, and no
end-to-end read, write or vote has run against the linked project. Every tool result in this PR is
from local modules and synthetic tests.

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
`rein_mvp_poll_open` refuses a caller-supplied candidate list, cap or option label
(`policy_argument_rejected`, and `legacy_options_unsupported` at the write layer) and assembles the
pool from stored proposals of the named vote type; `rein_mvp_vote` accepts `approvedProposalIds`
only, an empty list is the abstention, and the database freezes the candidate list and both limits
at insert time. The local migrations are the source of that enforcement. They are reviewed and
committed in the sibling Foundation repository (`tempest2023/ReinProtocolFoundation`) and applied to
the linked `BeneficenceProtocol` project's `dev_*` set, but no registered tool has exercised them
against that project: the enforcement described above is proven by local tests only, and nothing
here is a live end-to-end result. The concrete per-type cap and approval-budget values remain
unapproved operator configuration.

## Pending release gate: MVP naming removal

A pre-launch review asks for the `mvp` naming to be removed across tools, tables, config and skills.
That rename is **not done in this PR and must not be read as done**. Because the two migrations above
are already applied to the linked project, the table and RPC names cannot be edited in place: the
rename needs a **forward-compatibility migration** that creates the new names, keeps the existing
`<env>_rein_mvp_*` names working for callers during the transition, and moves them over in a
reviewed step. Until that migration exists and is applied, every current name below is authoritative:

| Interface | Names that would move |
| --- | --- |
| Registered tools | `rein_mvp_my_status`, `rein_mvp_funds`, `rein_mvp_proposal_submit`, `rein_mvp_poll_open`, `rein_mvp_vote`, `rein_mvp_poll_result`, `rein_mvp_proposal_comment_suggest`, `rein_mvp_revision_approve`, `rein_mvp_revision_apply` |
| Plugin config block | the `mvp` object under `plugins.entries.rein-operations.config`, including its `enabled` flag |
| Tables | `<env>_rein_mvp_proposals`, `<env>_rein_mvp_polls`, `<env>_rein_mvp_ballots`, `<env>_rein_mvp_vote_types`, `<env>_rein_mvp_proposal_revisions` |
| RPCs | `<env>_rein_mvp_finalize_poll`, `<env>_rein_mvp_approve_revision` |
| Docs and skills | every reference to the names above, including this file, the acceptance matrix, the decision register and the agent test cases |

The gate is a release condition, not a defect in this PR: the tables and RPCs are already applied to
the linked dev project, so a rename is a schema change with its own review, not a wording edit.

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

1. Both migrations are already applied to the linked project's `dev_*` set, in filename order; apply
   them to `prod_*` only after a separate decision, and to any new environment in the same order.
   Never apply them from a script that also runs the Agent.
2. Seed the email-to-contact identity rows (`<env>_contact_identities`), Contributor and director
   records, and an initial funds snapshot by hand, or through a reviewed administrative path. Do not
   seed fabricated people into a live environment.
3. Create the Slack app, enable Socket Mode, install it into the single target workspace with the
   bot scopes `users:read` and `users:read.email` that the email resolver needs, and invite the bot
   to the approved proposal and Board channels. Until those scopes are installed on the governance
   app, the resolver stays off and every sender is unresolved.
4. Record the approved native channel IDs and the one workspace ID in operator configuration, and
   point the two Supabase environment variables at server-side secrets.
5. Enable the `mvp` config block explicitly. Until then, no MVP tool is registered.

## Not in this slice

Weighted voting, quorum, recusal, competing-budget allocation, zero-budget fast track, activity
spaces, reminders, outcome collection, articles, website publication, weekly oversight and pause
controls stay deferred, and their local modules remain unregistered. Payment, signing, identity
escalation and any on-chain or DAO migration remain outside the Agent.
