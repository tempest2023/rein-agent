# Repository development instructions

This repository develops Rein Agent for Rein Protocol Foundation on OpenClaw.
Read README.md, docs/architecture.md, docs/decisions.md and the relevant PRD sections before changing behavior.
`workspace/AGENTS.md` is the runtime agent policy template, not authority to operate real accounts during repository development.

- Preserve confirmed requirements vs proposed defaults. Do not activate governance defaults implicitly.
- P0 uses exactly one chat platform, still undecided. Do not build a replacement generic agent framework.
- Identity, authorization, deadline, vote, budget and idempotency rules belong in deterministic services; prompts alone cannot enforce them.
- Keep activity, finance and publication states separate. No autonomous payment, signing or identity/weight escalation.
- Never commit credentials, live member data, complaints, board ballots, runtime memory or financial records.
- Do not claim integrations work without real verification. Document incomplete adapters honestly.
- Run `node scripts/check.mjs` for scaffold changes; add behavioral tests when business logic is implemented.
- Consult current official OpenClaw docs before runtime integrations; pin the tested version when selecting it.
