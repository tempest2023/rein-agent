# Rein Operations — local OpenClaw plugin

The native plugin is separate from `vendor/openclaw` and imports only the public `openclaw/plugin-sdk/plugin-entry` seam. `rein_status` reports the development state. `rein_simulate_proposal` checks synthetic fields without granting approval; `rein_simulate_vote` runs a synthetic round with explicitly supplied rules and ballots. An explicitly configured, single-platform proposal bridge can additionally register `rein_proposal_create`, `rein_proposal_revise`, `rein_proposal_confirm` and `rein_proposal_submit`. It takes the account from OpenClaw's trusted v2 tool context and writes to a local proposal ledger. No registrar, payment, Board-vote or external publication tool is enabled. Real platform and registry adapters remain pending.

An explicit `foundationDb` config block registers twelve database-backed tools instead of the
simulators and the proposal bridge: the reads `rein_member_status`, `rein_funds`,
`rein_poll_candidates` and `rein_vote_type_resolve`, the writes `rein_governance_proposal_submit`,
`rein_poll_open`, `rein_poll_vote` and `rein_poll_result`, the read-only field-collection tool
`rein_proposal_collect`, and the post-result feedback tools `rein_proposal_comment_suggest`,
`rein_revision_approve` and `rein_revision_apply`. The block names server environment variables for
the Supabase URL and key,
plus one for the proposal confirmation signature; no credential, project URL, Slack team ID or
private contact identifier reaches a result. Every tool reaches the database through the server-only
key over PostgREST, no tool posts a Slack message, and no tool authorizes, reserves or pays money.

The longer interface names live in the database as `<env>_rein_proposals`, `<env>_rein_polls`,
`<env>_rein_ballots`, `<env>_rein_vote_types` and `<env>_rein_proposal_revisions` with the
`<env>_rein_finalize_poll` and `<env>_rein_approve_revision` RPCs. They replace the earlier
`<env>_rein_mvp_*` tables and RPCs through the committed forward migration
`20260927110000_rein_governance_names.sql`, ordered after the committed `20260927103000` migration;
the old table and RPC names stay reachable as compatibility views and RPC wrappers during the
transition. The migration is **not** applied to the linked project, so apply it before enabling this
code; until then the deployed database answers on the old names only.

`rein_governance_proposal_submit` stores a proposal only after its author has confirmed the exact version.
The first call prepares: it writes nothing and returns the canonical proposal text plus a
short-lived, server-signed `confirmationToken`. The Agent reads that text back to the proposer, and
only a second call carrying the unchanged token together with `confirmPronouncedByAuthor: true`
writes the row. The token binds the proposer and every proposal field, so an altered payload
(`proposal_confirmation_mismatch`), an expired token (`proposal_confirmation_expired`), a missing
statement or token (`proposal_confirmation_required`) and a token the server did not mint
(`proposal_confirmation_invalid`) all refuse before the database is touched. The proposal identifier
is derived from the confirmed text, so re-confirming the same version addresses the same record
instead of inserting a second proposal. The signing secret is the server-only environment variable
named by `proposalConfirmationKeyEnvVar`; it never appears in a token, a result or a log.

Slack sender identity follows D13 and is opt-in. `identityEmailMatch` is `"disabled"` by default, and
while it is disabled the reader resolves senders through the retained identity-link table and
`slackBotTokenEnvVar` is never read. Enabling it needs the governance app's bot scopes `users:read`
and `users:read.email` plus that app's bot token in the named server environment variable; a missing
or hidden profile email, an email that matches no `<env>_contact_identities` row or more than one,
and a revoked or conflicting retained link row all fail closed. The lookup ships in
`slack-email-lookup.ts` with local tests. The scopes and token are not installed or configured
today, no Slack workspace is connected, and nothing here is verified against a live workspace.

Post-result feedback follows one confirmed rule with two sides. An **ordinary** revision, one that
moves only the title or the summary, is accepted and made effective by the Agent itself: the Agent
may apply a reasonable ordinary suggestion in the caller's turn through `rein_revision_apply`,
with no separate Board approval. A **material** revision — budget, location, schedule, personnel or
the major event flow, with schedule material in the current implementation — cannot take effect
until a current director records an approval through `rein_revision_approve`; the database
trigger refuses it by name (`revision_not_approved`) until then. The tool layer limits all three
feedback calls to the approved Board channel and to a sender whose linked community record is a
current director, because the voters are the Board. The database row additionally permits an
**active Contributor** as the revision author (`author_contact_id`); that wider author set is a
database-level allowance that the registered tools do not currently expose. A comment applies
nothing. Nothing here is verified against a live Slack workspace or a live database: the tests are
local, synthetic or explicitly injected.

Manifest: `openclaw.plugin.json`. Runtime entry: `index.ts`. Artwork: `assets/icon.png` (approved Bot Icon). The source TypeScript entry is for local development; before publishing, build JavaScript, change the entry to `dist/index.js`, remove `private`, and verify the packed install. Do not publish the development package as-is.

The local `openclaw` development link uses this repository's pinned host; the peer dependency deliberately does not promise compatibility with untested future versions. Update it after compatibility verification. Plugin APIs are experimental.

New business tools belong here or in additional Rein-owned packages, never in upstream `src/` or `extensions/`. Use deterministic authorization and durable records, optional tools for side effects, and names prefixed `rein_`. A prompt, manifest declaration or user-supplied actor ID is not an authorization check. See [deployment and ten test cases](../../docs/implementation-and-deployment-zh.md).

See [setup](../../docs/setup.md) and [updating OpenClaw](../../docs/upstream.md).
