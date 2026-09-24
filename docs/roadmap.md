# Implementation roadmap

Everything below is planned, not completed software. Initialization delivers documentation, workspace templates, the official OpenClaw source submodule, and a local read-only plugin with integration checks.

| Milestone | Deliverable | Acceptance |
| --- | --- | --- |
| M0: decisions and contracts | Policy decisions, runtime version, one chat platform, storage and tool contracts | §16 decisions assigned and required fields explicitly approved |
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
