# Rein Agent

<img src="workspace/avatars/rein-agent.png" alt="Rein Agent Bot Icon" width="192" height="192">

[中文说明](README-zh.md)

Rein Protocol Foundation's operations agent: an administrator, secretary, and online facilitator.

Rein Agent helps members turn activity ideas into real-world action. It receives proposals, organizes materials, facilitates Board funding decisions, coordinates preparation, collects outcomes, and supports publishing—so organizational leaders can focus on decisions that truly require their attention.

**Status: repository initialized; implementation preparation in progress.** OpenClaw has been selected as the runtime. This repository currently contains the agent workspace template, bilingual requirements, and implementation plan. Slack, Discord, the Foundation website, and real member data are not connected. Voting, durable storage, and automated publishing are not yet implemented.

## Product and design

- [English PRD](docs/PRD-agent-community-operations.md) · [中文 PRD](docs/PRD-agent-community-operations-zh.md)
- [Foundation mission and governance blueprint](PROJECT.md)
- [Source provenance and context](docs/provenance.md)
- [Architecture and integration boundaries](docs/architecture.md)
- [P0 implementation and acceptance checklist](docs/roadmap.md)
- [Deployment preparation](docs/setup.md) · [Open decisions](docs/decisions.md)
- [Official Bot Icon and design history](assets/brand/README.md)

## Three operating roles

| Role | Responsibilities |
| --- | --- |
| Administrator | Verify identity, track activities and permissions, and maintain exception and audit records |
| Secretary | Organize proposals, agendas, tasks, and outcomes; follow up on missing items; prepare weekly operations summaries |
| Online facilitator | Present proposals under approved rules, open and close voting, and explain results and next steps |

Rein Agent does not make resource-allocation decisions for the Board, execute real payments, or grant organizational roles. People remain responsible for offline activity execution.

## Getting started locally

```sh
git clone https://github.com/tempest2023/rein-agent.git
cd rein-agent
node scripts/check.mjs
```

The repository check requires Node.js 22 or later and has no npm dependencies. A passing check confirms that the documentation and templates are structurally complete; it does not mean the agent is production-ready.

`workspace/` is an OpenClaw-compatible agent workspace template. Complete the [deployment preparation](docs/setup.md) before connecting a runtime. `config/operations.example.json` is a proposed business-configuration structure; **it is not native OpenClaw configuration, and no executor currently loads it**. Governance parameters remain unset, and real operations must not start without explicit authorization.

## P0 operating loop

Contributor proposal → information confirmation and evaluation → authorized zero-budget fast track / Board funding decision → activity space and preparation → human execution → outcome acceptance → authorized website publication and settlement record.

Activity, finance, and publication states are tracked independently. A second chat platform, social-media image and text publishing, and DAO integration belong to later phases.

## Contributing

Product suggestions are not organizational policy. Every implementation must trace back to a PRD requirement, user story, or acceptance criterion (`R`, `US`, or `AC`). See the [contribution guide](CONTRIBUTING.md). A license has not yet been selected, so no open-source license is currently granted.
