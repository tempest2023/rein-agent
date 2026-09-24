# Rein Agent

<img src="workspace/avatars/rein-agent.png" alt="Rein Agent Bot Icon" width="192" height="192">

[中文说明](README-zh.md)

Rein Protocol Foundation's operations agent: an administrator, secretary, and online facilitator.

Rein Agent helps members turn activity ideas into real-world action. It receives proposals,
organizes materials, facilitates Board funding decisions, coordinates preparation, collects
outcomes, and supports publishing—so organizational leaders can focus on decisions that truly
require their attention.

**Status: runtime source vendored, plugin scaffold in place, no live integrations.** The official
OpenClaw source is included as a git submodule pinned to a reviewed commit, and one Rein-owned
plugin package is scaffolded with a single read-only tool. Slack, Discord, the Foundation website
and real member data are not connected. Voting, durable storage and automated publishing are not
implemented. The source build, real plugin loader, and authenticated local gateway invocation of
`rein_status` have been verified.

## Repository layout

| Path | Purpose |
| --- | --- |
| `vendor/openclaw` | Official OpenClaw source as a git submodule, pinned to one reviewed commit. Upstream-owned; use it, do not edit it. |
| `plugins/rein-operations` | The only place Rein behaviour lives. Today it registers one read-only tool, `rein_status`. |
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

A gitignored local toolchain may already be installed in this working copy and can satisfy both:

```sh
export PATH="$PWD/.toolchain/node_modules/.bin:$PATH"
```

## Quick start

```sh
git clone --recurse-submodules https://github.com/tempest2023/rein-agent.git
cd rein-agent
pnpm install                                        # Rein workspace packages only
pnpm --dir vendor/openclaw install --frozen-lockfile
pnpm --dir vendor/openclaw build
pnpm run setup:local                                # isolated local gateway config
pnpm run check
pnpm test
pnpm openclaw plugins inspect rein-operations --runtime --json
```

If the repository is already cloned without submodules, run
`git submodule update --init --recursive` first. `pnpm run setup:local` writes an isolated config at
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
- [Updating OpenClaw](docs/upstream.md)
- [P0 implementation and acceptance checklist](docs/roadmap.md)
- [Open decisions](docs/decisions.md)
- [Official Bot Icon and design history](assets/brand/README.md)

## Contributing

Product suggestions are not organizational policy. Every implementation must trace back to a PRD
requirement, user story, or acceptance criterion (`R`, `US`, or `AC`). See the
[contribution guide](CONTRIBUTING.md). A license has not yet been selected, so no open-source
license is currently granted.
