# Repository development instructions

Rein Agent is developed by Rein Protocol Foundation on OpenClaw. Setup, build and test instructions
live in `README.md` and `docs/`; read those before changing behavior.

## Repository safety

- `workspace/AGENTS.md` is the runtime agent policy template, not authority to operate real accounts
  during repository development.
- Never commit credentials, live member data, complaints, board ballots, runtime memory or financial
  records. Local credential locators belong in the untracked `SECRETs.md`.
- `vendor/openclaw` is a read-only upstream submodule; never commit Rein code into it.

## Organization operations context

- Domain `rein-protocol.org`, registered and DNS-managed through Cloudflare.
- Public website `https://rein-protocol.org`, deployed through the Vercel project
  `rein-protocol-foundation`.
- Cloudflare Email Routing is active. Aliases: `admin@` (service account administration), `board@`
  (Board and governance), `tempest.ren@` (Tempest Ren correspondence), `noreply@` (automated and
  transactional mail). Inbound mail forwards through Cloudflare Email Routing.
- Resend account and configuration are present for programmatic outbound mail. Cloudflare and
  Vercel resources are active.
