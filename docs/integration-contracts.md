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
| Sender | The acting user comes from the runtime's trusted per-message sender (`requesterSenderId`), which admitted channel and group messages carry the same way as DMs. No tool argument, display name or role label establishes identity. |
| Channels | Explicitly approved proposal and Board channel IDs, in native Slack form. A call from any other channel is refused before any database access. |
| Missing team ID | The trusted tool context carries the platform, the channel and the sender, but no Slack team or workspace ID. The team is fixed operator configuration, so pointing one installation at several workspaces would resolve senders against the wrong community records. |
| Outbound messages | The MVP tools return results to the calling turn and do not post to Slack on their own. The result tool in particular only returns the result; nothing auto-posts it back to the channel. Any future posting must persist intent plus an idempotency key before delivery. |

## Database (organization's own Supabase project)

Members, directors, Slack identity links, proposals, polls, ballots and available-funds figures live
in the organization's own database, not in this repository. Development and production share one
project with isolated `dev_*` and `prod_*` table sets; the environment selector has no implicit
default.

Two migrations exist locally in the sibling Foundation repository and are **not applied to any live
environment**:

| Migration | Adds |
| --- | --- |
| `20260924094436_rein_slack_identity_and_fund_snapshots.sql` | `rein_slack_links` and append-only `rein_fund_snapshots`, in both table sets |
| `20260924095705_rein_mvp_proposals_polls_ballots.sql` | `rein_mvp_proposals`, `rein_mvp_polls` and `rein_mvp_ballots`, in both table sets |

Required contract properties:

- One identity link maps one Slack team/user pair to one community record. Display names never
  establish identity, and one person with several accounts must resolve to one canonical contact.
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

**Provisional.** The approve-only wording above is the confirmed product rule, but the local
migrations and the registered tools have not yet been shown to enforce it. As inspected, the tools
still accept a generic option list and a per-ballot choice, and count a unique highest option. Re-read
the plugin and schema after the pending update lands, and treat any enforcement claim here as
unverified until that review.

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

1. Review and apply both migrations to the isolated `dev_*` set, then to `prod_*` only after a
   separate decision. Never apply them from a script that also runs the Agent.
2. Seed identity links, Contributor and director records, and an initial funds snapshot by hand, or
   through a reviewed administrative path. Do not seed fabricated people into a live environment.
3. Create the Slack app, enable Socket Mode, install it into the single target workspace, and invite
   the bot to the approved proposal and Board channels.
4. Record the approved native channel IDs and the one workspace ID in operator configuration, and
   point the two Supabase environment variables at server-side secrets.
5. Enable the `mvp` config block explicitly. Until then, no MVP tool is registered.

## Not in this slice

Weighted voting, quorum, recusal, competing-budget allocation, zero-budget fast track, activity
spaces, reminders, outcome collection, articles, website publication, weekly oversight and pause
controls stay deferred, and their local modules remain unregistered. Payment, signing, identity
escalation and any on-chain or DAO migration remain outside the Agent.
