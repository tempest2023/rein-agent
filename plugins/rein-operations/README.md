# Rein Operations — local OpenClaw plugin

The native plugin is separate from `vendor/openclaw` and imports only the public `openclaw/plugin-sdk/plugin-entry` seam. `rein_status` reports the development state. `rein_simulate_proposal` checks synthetic fields without granting approval; `rein_simulate_vote` runs a synthetic round with explicitly supplied rules and ballots. An explicitly configured, single-platform proposal bridge can additionally register `rein_proposal_create`, `rein_proposal_revise`, `rein_proposal_confirm` and `rein_proposal_submit`. It takes the account from OpenClaw's trusted v2 tool context and writes to a local proposal ledger. No registrar, payment, Board-vote or external publication tool is enabled. Real platform and registry adapters remain pending.

An explicit `mvp` config block registers nine database-backed tools instead of the simulators and
the proposal bridge: the reads `rein_mvp_my_status` and `rein_mvp_funds`, the writes
`rein_mvp_proposal_submit`, `rein_mvp_poll_open`, `rein_mvp_vote` and `rein_mvp_poll_result`, and the
post-result feedback tools `rein_mvp_proposal_comment_suggest`, `rein_mvp_revision_approve` and
`rein_mvp_revision_apply`. The block names server environment variables for the Supabase URL and
key; no credential, project URL, Slack team ID or private contact identifier reaches a result. Every
tool reaches the database through the server-only key over PostgREST, no tool posts a Slack message,
and no tool authorizes, reserves or pays money.

Post-result feedback follows one confirmed rule with two sides. An **ordinary** revision, one that
moves only the title or the summary, is accepted and made effective by the Agent itself: the Agent
may apply a reasonable ordinary suggestion in the caller's turn through `rein_mvp_revision_apply`,
with no separate Board approval. A **material** revision — budget, location, schedule, personnel or
the major event flow, with schedule material in the current implementation — cannot take effect
until a current director records an approval through `rein_mvp_revision_approve`; the database
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
