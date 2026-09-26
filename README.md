# Rein Agent

<img src="workspace/avatars/rein-agent.png" alt="Rein Agent Bot Icon" width="192" height="192">

[中文说明](README-zh.md)

Rein Protocol Foundation's operations agent: an administrator, secretary, and online facilitator.

Rein Agent helps members turn activity ideas into real-world action. It receives proposals,
organizes materials, facilitates Board funding decisions, coordinates preparation, collects
outcomes, and supports publishing—so organizational leaders can focus on decisions that truly
require their attention.

**Status: local business-core development; no live integrations.** The official OpenClaw source is
included as a git submodule pinned to a reviewed commit. The Rein-owned plugin exposes a read-only
status tool and synthetic proposal/vote simulation tools. Four proposal tools are available only after
an operator explicitly configures one platform, approved native channels and local storage.
Deterministic business modules plus a local ledger support development rehearsals.

The confirmed P0 MVP is one Slack vertical slice: link a Slack account to a community record, submit a
simple Contributor proposal, run a simple Board vote with a posted result, and read a funds snapshot.
Six MVP tools exist against the organization's own database — `rein_mvp_my_status` and
`rein_mvp_funds` are read-only, and `rein_mvp_proposal_submit`, `rein_mvp_poll_open`, `rein_mvp_vote`
and `rein_mvp_poll_result` write proposals, polls and ballots. They register **only** when an explicit
`mvp` config block enables them, and enabling it hides the simulators and the legacy proposal tools.
Two database migrations for that slice exist locally in the sibling Foundation repository and neither
is applied to a live environment.

No Slack workspace, Discord, Foundation website or real member data is connected, and no live database
is wired. A passed vote is a decision record: payments, reservations and publishing are not enabled,
and weighted voting, quorum, recusal, competing-budget allocation, activities, reminders, articles and
oversight remain deferred. See the [implementation and deployment record](docs/implementation-and-deployment-zh.md).

## Repository layout

| Path | Purpose |
| --- | --- |
| `vendor/openclaw` | Official OpenClaw source as a git submodule, pinned to one reviewed commit. Upstream-owned; use it, do not edit it. |
| `plugins/rein-operations` | Rein-owned business modules; three default status/simulation tools, four proposal tools, and nine MVP Slack tools (two read, four write, three result-feedback) that register only with explicit platform/channel/storage configuration. |
| `workspace/` | OpenClaw-compatible agent workspace template: identity, policy and avatar. |
| `config/operations.example.json` | Proposed business configuration. Not native OpenClaw config, and nothing loads it. |
| `scripts/` | Local bootstrap, CLI wrapper and upstream update helpers. |
| `tests/` | Node test runner checks for the plugin boundary and the update script. |
| `docs/` | PRDs, architecture, decision register, setup and upstream-update runbooks. |

## Plugin-first development rule

Rein functionality is implemented as Rein-owned plugins under `plugins/`, loaded through the
documented plugin SDK and manifest. `vendor/openclaw` stays byte-identical to upstream so the
submodule pointer can move forward with a reviewed fetch and rebuild. No Rein commit may modify
tracked files in `vendor/openclaw/src/` or `vendor/openclaw/extensions/`, and CI rejects uncommitted changes in the upstream checkout.

`config/operations.example.json` is a design input, not runtime enforcement. Governance parameters
remain unset, and real operations must not start without explicit authorization.

## Requirements

- Node.js `>=24.16.0 <25` or `>=26.1.0` (Node 26 recommended). This mirrors upstream `engines`.
- pnpm `12.4.2`, pinned by `packageManager` in `package.json`; enable it with `corepack enable`.
- git with submodule support.

A gitignored local toolchain may already be installed in this working copy and can satisfy both
without touching your shell `PATH`. It must exist at `.toolchain/`; the commands below fail if that
directory is missing. Run pnpm through the pinned local toolchain with `npm run toolchain:pnpm`:

```sh
npm run toolchain:pnpm -- --version   # expect 12.4.2
npm run toolchain:pnpm -- exec node -v   # expect v24.16.x
```

## Quick start

```sh
git clone --recurse-submodules https://github.com/tempest2023/rein-agent.git
cd rein-agent
npm run toolchain:pnpm -- install                                     # Rein workspace packages only
npm run toolchain:pnpm -- --dir vendor/openclaw install --frozen-lockfile
npm run toolchain:pnpm -- --dir vendor/openclaw build
npm run toolchain:pnpm -- run setup:local                             # isolated local gateway config
npm run toolchain:pnpm -- run check
npm run toolchain:pnpm -- test
npm run toolchain:pnpm -- run verify:plugin
npm run toolchain:pnpm -- run verify:proposal-tools
npm run toolchain:pnpm -- openclaw plugins list --verbose
npm run toolchain:pnpm -- openclaw plugins inspect rein-operations --runtime --json
npm run toolchain:pnpm -- openclaw plugins doctor
npm run toolchain:pnpm -- openclaw gateway run                        # terminal 1; Ctrl-C to stop
npm run toolchain:pnpm -- openclaw gateway health --port 18791        # terminal 2, after "ready"
npm run toolchain:pnpm -- run smoke:gateway                           # terminal 2, after "ready"
```

`npm run toolchain:pnpm -- <args>` forwards everything after `--` to the toolchain pnpm, so
every command above runs from a default shell without a `PATH` export: `-- install` and
`-- --dir vendor/openclaw install --frozen-lockfile` reach pnpm directly, while `-- run <script>`,
`-- test` and `-- openclaw <args>` reach the package scripts and the upstream CLI through the
toolchain's own Node, so they work even when the ambient `node` is older. With no argument after
`--`, `toolchain:pnpm` prints pnpm's own help. The inline `npm run <script>` form works too, but it
uses your ambient Node. If you prefer to put the toolchain on `PATH` instead, prepend its bin
directory once: `export PATH="$PWD/.toolchain/node_modules/.bin:$PATH"`; after that, plain
`pnpm run check`, `pnpm test` and `pnpm openclaw ...` replace the wrapped forms.

If the repository is already cloned without submodules, run
`git submodule update --init --recursive` first. `npm run toolchain:pnpm -- run setup:local` writes an isolated config at
`runtime/openclaw/openclaw.json` (gitignored, mode 0600) with a generated gateway token, a loopback
binding on port 18791, the `workspace/` directory and the `rein-operations` plugin enabled.
Channels and models stay unconfigured. See [setup](docs/setup.md) for the full bootstrap and
[updating OpenClaw](docs/upstream.md) for the reviewed pin update and rollback.

## Three operating roles

| Role | Responsibilities |
| --- | --- |
| Administrator | Verify identity, track activities and permissions, and maintain exception and audit records |
| Secretary | Organize proposals, agendas, tasks, and outcomes; follow up on missing items; prepare weekly operations summaries |
| Online facilitator | Present proposals under approved rules, open and close voting, and explain results and next steps |

Rein Agent does not make resource-allocation decisions for the Board, execute real payments, or grant
organizational roles. People remain responsible for offline activity execution.

## P0 operating loop

Contributor proposal → information confirmation and evaluation → authorized zero-budget fast track /
Board funding decision → activity space and preparation → human execution → outcome acceptance →
authorized website publication and settlement record.

Activity, finance, and publication states are tracked independently. A second chat platform,
social-media image and text publishing, and DAO integration belong to later phases.

## Product and design

- [English PRD](docs/PRD-agent-community-operations.md) · [中文 PRD](docs/PRD-agent-community-operations-zh.md)
- [Foundation mission and governance blueprint](PROJECT.md)
- [Source provenance and context](docs/provenance.md)
- [Architecture and integration boundaries](docs/architecture.md)
- [Setup and local runtime](docs/setup.md)
- [Development, verification, deployment and ten Agent rehearsals](docs/implementation-and-deployment-zh.md)
- [P0 requirement evidence matrix](docs/p0-acceptance-matrix.md)
- [Provider integration contracts](docs/integration-contracts.md)
- [Updating OpenClaw](docs/upstream.md)
- [P0 implementation and acceptance checklist](docs/roadmap.md)
- [Open decisions](docs/decisions.md)
- [Official Bot Icon and design history](assets/brand/README.md)

## Contributing

Product suggestions are not organizational policy. Every implementation must trace back to a PRD
requirement, user story, or acceptance criterion (`R`, `US`, or `AC`). See the
[contribution guide](CONTRIBUTING.md). A license has not yet been selected, so no open-source
license is currently granted.
