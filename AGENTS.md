# Repository development instructions

This repository develops Rein Agent for Rein Protocol Foundation on OpenClaw. Read README.md,
docs/architecture.md, docs/decisions.md and the relevant PRD sections before changing behavior.
`workspace/AGENTS.md` is the runtime agent policy template, not authority to operate real accounts
during repository development.

## Where code goes

- Rein behavior lives in Rein-owned packages under `plugins/`. Prefer a new plugin package or a new
  tool over growing an existing file into a framework.
- `vendor/openclaw` is an official OpenClaw source submodule. Treat it as read-only: never edit its
  tracked files, and never commit Rein code into it. `.github/workflows/openclaw.yml` fails when
  `git -C vendor/openclaw status --porcelain` is non-empty.
- Import public entry points such as `openclaw/plugin-sdk/plugin-entry` only. Do not reach into
  upstream internals, and do not build a replacement generic agent framework.
- A manifest declaration or prompt is not an authorization check.

## Runtime and toolchain

- Require Node.js `>=24.16.0 <25` or `>=26.1.0` (Node 26 recommended) and pnpm `12.4.2` through the
  `packageManager` pin. The repository may carry a gitignored local toolchain; enable it with
  `export PATH="$PWD/.toolchain/node_modules/.bin:$PATH"`.
- Upstream installs separately: `pnpm --dir vendor/openclaw install --frozen-lockfile`, then
  `pnpm --dir vendor/openclaw build` (including the Control UI at the current pin). The root
  `pnpm install` covers Rein workspace packages only.
- Keep local gateway state under `runtime/` through `scripts/openclaw.mjs`; do not point development
  at a global `~/.openclaw` profile.
- Move the runtime pin only through `pnpm upstream:update <ref>`, followed by a rebuild,
  the checks below and a submodule pointer commit. Read docs/upstream.md first, and consult current
  official OpenClaw documentation before runtime integrations.

## Product rules

- Preserve confirmed requirements vs proposed defaults. Do not activate governance defaults
  implicitly.
- P0 uses exactly one chat platform, still undecided.
- Identity, authorization, deadline, vote, budget and idempotency rules belong in deterministic
  services; prompts alone cannot enforce them.
- Keep activity, finance and publication states separate. No autonomous payment, signing or
  identity/weight escalation.
- Never commit credentials, live member data, complaints, board ballots, runtime memory or
  financial records.

## Verification

- Run `pnpm run check` for scaffold and documentation changes, and `pnpm test` for plugin or script
  changes. Add behavioral tests when business logic is implemented.
- Do not claim an integration works without real verification. Document incomplete adapters
  honestly, and say which runtime commit and checks the claim rests on.
