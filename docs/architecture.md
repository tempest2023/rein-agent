# Architecture

OpenClaw is the agent runtime. This repository vendors its official source and adds Rein Protocol
Foundation behaviour as plugins, so the runtime can be updated without carrying a fork.

## How OpenClaw is included

`vendor/openclaw` is an official OpenClaw git submodule, kept on a detached reviewed commit. The
repository records that commit as the submodule pointer, and
`.github/workflows/openclaw.yml` fails the build if a checkout has modified tracked upstream files.
Read the live values instead of trusting a number in prose:

```sh
git -C vendor/openclaw rev-parse HEAD
git ls-tree HEAD vendor/openclaw
node -p "require('./vendor/openclaw/package.json').version"
```

Updating is a reviewed pin bump, never a merge into a fork: fetch the requested ref, rebuild, run
the checks, then commit the new pointer. See [upstream](upstream.md). Local work never runs against
a global `~/.openclaw` profile; `scripts/openclaw.mjs` points the upstream CLI at
`runtime/openclaw/openclaw.json`.

## Extension boundary

The rule is plugin-first: Rein code lives in Rein-owned packages under `plugins/`, never in
`vendor/openclaw/src/` or `vendor/openclaw/extensions/`.

```mermaid
flowchart LR
  Chat[Slack: P0 platform confirmed] --> Gateway[OpenClaw gateway, vendored and pinned]
  Gateway --> Plugin[plugins/rein-operations: Rein-owned]
  Plugin --> Domain[Deterministic local operations modules]
  Domain --> Records[Local rehearsal ledger; production store pending]
  Domain --> Outbox[Local intent ledger and injected outbox runner]
  Outbox --> Chat
  Outbox --> Website[Foundation website adapter: deferred from v0.1]
  Admin[Authorized operators] --> Domain
  Upstream[Upstream OpenClaw releases] -. reviewed pin bump .-> Gateway
  Data[Foundation backend API: governance reads and writes, identity resolution and binding] -. one authenticated service; no database credential in the Agent .-> Domain
```

Discord is not drawn: no Discord surface is connected, and its general-participant scope (onboarding,
free-resource navigation and participation paths only) stays deferred behind D12 while Slack remains
the single P0 platform.

`plugins/rein-operations` registers `rein_status`, `rein_simulate_proposal` and
`rein_simulate_vote` through the public `openclaw/plugin-sdk/plugin-entry` entry point. Four v2 proposal tools are registered only with explicit single-platform, channel and storage configuration. They use host-supplied sender identity and local durable proposal records; the default three tools have no external effects. The deterministic
proposal and governance modules can be exercised locally; authoritative registry syncing, live voting,
budgets, website publishing and production adapters remain pending. A manifest declaration is not
an authorization check.

An explicit `foundationDb` configuration block instead registers twelve backend-backed tools — the
reads `rein_member_status`, `rein_funds`, `rein_poll_candidates` and `rein_vote_type_resolve`, the
writes `rein_governance_proposal_submit`, `rein_poll_open`, `rein_poll_vote` and `rein_poll_result`,
the read-only field-collection tool `rein_proposal_collect`, and the post-result feedback tools
`rein_proposal_comment_suggest`, `rein_revision_approve` and `rein_revision_apply` — and suppresses
the synthetic simulators and the legacy proposal bridge. The block names the backend, not a
database: `platform`, `workspaces` (each an `id` with a non-empty native channel ID list),
`proposalChannelIds`, `boardChannelIds`, the environment variables for the backend base URL, the
Agent caller ID and the Agent credential, and the optional `voteTypeAliases`. Every governance read
and write, identity resolution and identity binding is one authenticated call to that backend; the
Agent holds no database credential and fails closed when `foundationDb.enabled` is absent or false.
No live backend is connected yet.

Nothing else is registered. The remaining deterministic modules, including the weighted governance
rounds, are exercised through their module APIs in local tests and stay unregistered because v0.1
excludes their surfaces. The activity, change, oversight and outbox cores are unreachable from this
runtime slice; their implementation moved to a follow-up PR.

The required provider boundaries and timeout recovery rules are specified in
[P0 integration contracts](integration-contracts.md).

Workspace files under `workspace/` follow the
[official workspace documentation](https://docs.openclaw.ai/agent-workspace) and agent registration
follows the [agents CLI](https://docs.openclaw.ai/cli/agents). `config/operations.example.json` is a
design input; nothing loads it at runtime.

## P0 v0.1 vertical slice

The v0.1 slice is deliberately smaller than the PRD lifecycle: Slack identity, a simple Contributor
proposal, a simple Board approval vote with a recorded result, and a read-only funds snapshot.

```mermaid
flowchart LR
  Identify[Agent relays the event; the backend resolves a canonical verified link] --> Propose[Resolved Contributor submits a simple proposal]
  Propose --> Vote[Eligible directors record approvals or abstain]
  Vote --> Result[Agent records the result and returns it to the call]
  Funds[Latest human-entered funds snapshot] -. read-only .-> Result
  Result --> Human[People decide and pay outside the Agent]
```

| v0.1 step | Local code today | Still required |
| --- | --- | --- |
| Slack identity | `request-context.ts` binds a host sender; the plugin relays the ingress tuple through `backend-transport.ts` and resolves the sender through `backend-db-adapter.ts` and `governance-read-tools.ts`. Under D13 the backend resolves the contact and its current role from canonical verified links and returns a private signed proof bound to the sender, channel and caller; the Agent resolves nothing itself and reads no profile email. An unlinked sender can start a bind, which returns a website URL and completes with a short code the person carries back, with no email argument. | The connected backend service, the registered caller ID and credential, the approved workspace and channel IDs in `foundationDb.workspaces`, and the reviewed canonical links and role records behind the backend. The service's schema is committed in the sibling repository `tempest2023/ReinProtocolFoundation` (PR #13, head `78281fa`) and applied to the linked project, but no tool has exercised the backend end to end. |
| Contributor proposal | `proposals.ts` and `proposal-store.ts` with the optional proposal bridge, plus the backend-backed `rein_governance_proposal_submit` in `governance-write-tools.ts`. | A Slack conversation wired to the bridge plus the backend-backed active-Contributor source. |
| Board approval vote and result | `governance-write-tools.ts` registers `rein_poll_open`, `rein_poll_vote` and `rein_poll_result`. The round takes its candidate cap from the stored vote type and the tool reads the candidate pool from the backend itself, so no caller supplies candidates, a cap or an option label; an options-only call is refused with `legacy_options_unsupported`. `rein_poll_vote` accepts `approvedProposalIds` only, bounded by the poll's own `maxApprovalsPerVoter`, and an empty list is the abstention; the backend freezes the candidate list and both limits at insert time. `vote-tally.ts` counts a frozen eligible list at one equal weight per member, and `governance.ts` holds the older weighted round model that stays unregistered. | An approved voter list and confirmation of the highest-count tie rule. No tool posts to Slack, so the result returns to the calling turn only. |
| Read-only funds snapshot | `backend-db-adapter.ts` calls the backend's `available_funds` operation and `governance-read-tools.ts` exposes `rein_funds` to approved Board channels. | A live backend connection from the Agent. The snapshot schema is committed in the sibling repository `tempest2023/ReinProtocolFoundation` (PR #13, head `78281fa`) and applied to the linked project, but no tool has read it. |

Weighted rounds, quorum, recusal, competing-budget allocation, payments, activity spaces, reminders,
articles, website publication and oversight are deferred from v0.1. The activity, change,
oversight and outbox cores are unreachable from this runtime slice and their implementation moved to
a follow-up PR; the remaining deferred modules stay unregistered.

The pinned runtime supplies a trusted per-message sender (`requesterSenderId`) in an admitted Slack
DM and equally in an admitted channel or group message, so channel traffic is not a weaker source of
identity than a DM. The Agent turns that into a private, backend-signed proof: it relays the inbound
tuple (platform, workspace, user, channel, event) to the backend and receives the assertion bound to
it and to the calling Agent, which it presents on every later call. The proof is never a tool
argument, never a tool result and never a status field, and no tool accepts a model-supplied actor.
The community identity behind the sender is resolved under D13 by the backend alone, from canonical
verified links it holds; the Agent reads no profile or email, and one contact may hold several
bindings with consent. A sender the backend cannot resolve fails closed, and an unlinked sender can
start a bind that returns a website URL and completes with a short code the person carries back. The
transport and identity path ship in `backend-transport.ts`, `backend-db-adapter.ts` and
`ingress-proof.ts` with local synthetic tests, but no backend is connected and the Agent is not
deployed.

Channel roles are separated (D12). Slack is the internal governance surface for the core circle,
meaning core board members and core contributors; Board voting, fund review and event review happen
there. Discord is the general-participant surface and is a later, separate scope: it is not
connected, and in the early Agent period it carries onboarding, free-resource navigation and
participation paths only. A binding made on one platform or space is evidence for that surface
alone and never confers Slack governance rights; one platform's role or channel membership never
substitutes for another platform's eligibility check, and a contact may hold several bindings by
consent. Each platform's surface stays its own scope, and no generic cross-channel business
framework is planned.

## Proposed service boundaries

The v0.1 slice needs only the Identity, Proposals and Governance rows below, in the narrow form described
above, plus a read-only view of Finance. Activities, Outcomes and Oversight are deferred.

| Boundary | Responsibilities | PRD |
| --- | --- | --- |
| Identity | Verified platform-account bindings, each scoped to the platform and space it was made in; current role validity; audience scopes | R01–R03 |
| Proposals | Draft and confirmed versions; owner and material-change confirmation | R04–R09 |
| Governance | Frozen rounds; eligibility; explicit ballots; cutoff; configured tally and allocation | R10–R16 |
| Activities | Unique activity spaces; tasks, changes, handover and cancellation | R17–R20 |
| Finance | Authoritative available budget; atomic reservations; payment records entered by finance | R21–R22 |
| Outcomes | Evidence, acceptance, contributions and authorized publication | R23–R28 |
| Oversight | Exceptions, audit, scoped pauses and weekly summaries | §9, §11–13 |

Only local deterministic cores, an injected-provider outbox runner and a rehearsal ledger are implemented. Production services need
trusted adapter boundaries and provider contracts, not prompt text. Do not reuse the
Foundation's administrator-triggered application review as though it already handled this
lifecycle. Website APIs and authentication need an explicit contract.

## Proposed durable records

Member, IdentityLink, Proposal, ProposalVersion, Evaluation, GovernanceRound, VoterSnapshot, Ballot,
Allocation, Activity, Task, Reminder, Evidence, Consent, Publication, FinancialRecord, Exception,
AuditEvent and OutboxJob.

Keep immutable decision snapshots and append-only audit records. Money uses integer minor units and
an explicit currency. Store timestamps in UTC and display the configured local timezone.
Authorization checks include actor, action, resource and audience. Personal data has a separately
agreed retention policy.

For any external effect, persist intent and an idempotency key before delivery, store the provider
receipt, and reconcile uncertain outcomes before retrying. Allocate funds atomically across winning
proposals; do not resolve competition by processing order. Competing-proposal allocation is deferred
from v0.1. Database selection, migrations and provider contracts are pending.

## Three independent state dimensions

Activity: draft → confirmed → evaluating → awaiting_governance / needs_information → approved →
preparing → completed → accepted → archived; cancellation and pause are explicit transitions.

Finance: not_requested / requested / awaiting_allocation / reserved / partially_paid / paid /
awaiting_settlement / settled. Funding approval is never a payment receipt.

Publication: not_started / draft / awaiting_confirmation / ready / publishing / published / failed /
withdrawn. A confirmed version and channel-specific rights are required.

The activity core implements guarded local transitions for these dimensions. Cross-module change propagation and provider-backed recovery remain pending.

## Repository layout

| Path | Role |
| --- | --- |
| `vendor/openclaw` | Upstream runtime source; read-only, pinned by submodule pointer |
| `plugins/rein-operations` | Rein-owned plugin package and its manifest |
| `workspace/` | Agent workspace template consumed by the runtime |
| `scripts/` | Local bootstrap, CLI wrapper and upstream update helper |
| `tests/` | Node test runner checks for the plugin and the update script |
| `runtime/` | Gitignored local gateway state and config |
