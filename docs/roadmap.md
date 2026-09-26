# Implementation roadmap

The local deterministic cores for proposals, governance, activities and a rehearsal ledger are implemented and tested. The milestones below remain open as **production acceptance**: trusted identity, chat and website adapters, approved policy, provider receipts and end-to-end pilot evidence are still required. See [implementation and deployment](implementation-and-deployment-zh.md).

For a requirement-by-requirement status, see the [P0 acceptance matrix](p0-acceptance-matrix.md).

The strict P0 MVP is the shorter slice in [PRD §2.3](PRD-agent-community-operations.md): Slack
identity, a simple Contributor proposal, a simple Board vote and result, and a read-only funds
snapshot. M0 is decided for the MVP (Slack, the organization's own database, simple one-person-one-vote).
M1/M2 as written below carry the deferred remainder, including zero-budget fast track, budget
allocation, competing proposals and the weighted round model; they do not block the MVP slice.

| Milestone | Deliverable | Acceptance |
| --- | --- | --- |
| M0: decisions and contracts | Policy decisions, runtime version, one chat platform, storage and tool contracts | MVP items decided (Slack, own database, one-person-one-vote); remaining §16 decisions assigned before their phase |
| M1: member to proposal | Identity linking, draft/version confirmation, evaluation and configured zero-budget path | AC01–AC04 |
| M2: facilitated evaluation | Snapshots, deterministic ballots/tally, cutoff, budget allocation and audit | AC05–AC08 |
| M3: execution | Unique spaces, scheduling, changes, cancellation and handover | AC09–AC11 |
| M4: outcomes | Evidence and consent, separate finance state, confirmed publication and corrections | AC12–AC15 |
| M5: reliable pilot | Audience permissions, durable recovery, exceptions and pause/resume | AC16–AC20 |

## P0 release evidence

- [ ] AC01–AC04: ineligible submission rejected; valid owner confirmation; policy-scoped zero-budget approval; every funded request routed to Board.
- [ ] AC05–AC08: frozen inputs; no proxy/late/ambiguous votes; configured abstention/recusal/quorum/ties; no overspend under concurrency.
- [ ] AC09–AC11: exactly one space after retries; reminders reflect actual status; cancellation/handover updates all effects.
- [ ] AC12–AC15: incremental evidence; alternatives to photos; final-version and rights confirmation; unique publication; finance statuses independent.
- [ ] AC16–AC19: private information isolation; outage recovery; accountable exception summaries; scoped pause and controlled recovery.
- [ ] AC20: end-to-end zero-budget and funded event rehearsals, including outcomes and settlement records.

P1 adds recurring communities, contributor growth, matching, feedback analysis and authorized social image/text publishing. P2 adds the second chat platform, cross-platform identity, multi-region coordination and governance evolution. No video, autonomous payments, signing, token issuance or on-chain voting in P0.
