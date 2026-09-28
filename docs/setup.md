# Setup and local runtime

This is the local bootstrap for the vendored OpenClaw runtime and the `rein-operations` plugin. It
configures no chat platform or model provider and activates no governance policy. Its proposal and
vote tools default to synthetic simulation; the database-backed MVP Slack tools described at the end
of this file register only when an operator explicitly enables them.

## Prerequisites

- Node.js `>=24.16.0 <25` or `>=26.1.0` (Node 26 recommended). This mirrors upstream `engines`; the
  source runtime does not run on Node 22.
- pnpm `12.4.2`. `package.json` pins it through `packageManager`, so run `corepack enable` and the
  pinned version is selected automatically. Installing `pnpm@12.4.2` directly also works.
- git with submodule support.
- Network access for the first dependency install.

This repository may carry a gitignored local toolchain that satisfies both versions. Use it by
prepending its bin directory:

```sh
export PATH="$PWD/.toolchain/node_modules/.bin:$PATH"
node --version   # expect a supported release, for example v24.16.x
pnpm --version   # expect 12.4.2
```

The default path needs no `PATH` change: the `toolchain:pnpm` script runs the pinned local toolchain
through `npx`, so it works from a plain shell even when the ambient `node` is older. It requires
`.toolchain/` to exist in the checkout; the command fails if that directory is missing.

```sh
npm run toolchain:pnpm -- --version      # expect 12.4.2
npm run toolchain:pnpm -- exec node -v   # expect a supported release, for example v24.16.x
```

Everything after `--` is forwarded to the toolchain pnpm, so the install and build commands in the
other sections also work as `npm run toolchain:pnpm -- <args>`. The tables below list the exact form
for every script in this file; none of them needs a `PATH` export.

| Command | Runs |
| --- | --- |
| `npm run toolchain:pnpm -- install` | root Rein workspace install |
| `npm run toolchain:pnpm -- --dir vendor/openclaw install --frozen-lockfile` | upstream install |
| `npm run toolchain:pnpm -- --dir vendor/openclaw build` | upstream build, including the Control UI |
| `npm run toolchain:pnpm -- run setup:local` | `setup:local`, the isolated local config |
| `npm run toolchain:pnpm -- run check` | `check`, the scaffold and policy checks |
| `npm run toolchain:pnpm -- test` | `test`, the Node test runner suite |
| `npm run toolchain:pnpm -- run verify:plugin` | `verify:plugin`, loader-level plugin check |
| `npm run toolchain:pnpm -- run verify:proposal-tools` | `verify:proposal-tools`, loader-level v2 check |
| `npm run toolchain:pnpm -- openclaw plugins list --verbose` | upstream CLI through the toolchain |
| `npm run toolchain:pnpm -- openclaw plugins inspect rein-operations --runtime --json` | runtime tool report |
| `npm run toolchain:pnpm -- openclaw plugins doctor` | plugin diagnostics |
| `npm run toolchain:pnpm -- openclaw gateway run` | local gateway, foreground |
| `npm run toolchain:pnpm -- openclaw gateway health --port 18791` | gateway health from a second terminal |
| `npm run toolchain:pnpm -- openclaw doctor` | runtime doctor |
| `npm run toolchain:pnpm -- run smoke:gateway` | authenticated `rein_status` call, gateway-level smoke test |
| `npm run toolchain:pnpm -- openclaw gateway auth-token --show` | reveals the shared token |

`npm run toolchain:pnpm -- run <script>`, `-- test`, and `-- openclaw <args>` execute through the
toolchain's own Node, so they work from a default shell even when the ambient `node` is older than
this repository's `engines` range. Passing no argument after `--` prints pnpm's own help. The
unwrapped form, `pnpm run <script>` or `pnpm openclaw <args>`, is equivalent only after the optional
`PATH` export below or another pnpm `12.4.2` on a supported Node.

If you prefer the unwrapped commands, enable the toolchain once for that shell:

```sh
export PATH="$PWD/.toolchain/node_modules/.bin:$PATH"   # optional; makes plain pnpm and node resolve to the toolchain
```

## 1. Clone with the runtime source

```sh
git clone --recurse-submodules https://github.com/tempest2023/rein-agent.git
cd rein-agent
```

If the repository is already cloned without submodules, run
`git submodule update --init --recursive` first.

## 2. Install dependencies

The root install covers the Rein workspace packages only:

```sh
npm run toolchain:pnpm -- install                                     # Rein workspace packages only
```

Upstream is a separate workspace with its own lockfile. Install and build it in place:

```sh
npm run toolchain:pnpm -- --dir vendor/openclaw install --frozen-lockfile   # upstream install
npm run toolchain:pnpm -- --dir vendor/openclaw build                       # upstream build, including the Control UI
```

`vendor/openclaw` is a full source checkout, so the `openclaw` launcher resolves TypeScript sources
and needs this install and build before it can run. The current upstream `build` also produces the Control UI assets the gateway dashboard serves. Prefer `pnpm --dir vendor/openclaw ...` (or `pnpm -C`) so the pinned pnpm
version from upstream's own `packageManager` applies; the wrapped form above does the same and takes
its pnpm from the local toolchain instead of the ambient install.

## 3. Create the isolated local config

```sh
npm run toolchain:pnpm -- run setup:local
```

`scripts/init-local.mjs` writes `runtime/openclaw/openclaw.json` (file mode 0600, parent directory
0700) unless that file already exists, in which case it is preserved and reported. The generated
config is deliberately narrow:

| Key | Value |
| --- | --- |
| `gateway.mode` | `local`; the gateway refuses to start without it |
| `gateway.bind` / `gateway.port` | `loopback` / `18791`, away from the upstream default |
| `gateway.auth` | `token`, 32 random bytes as hex |
| `agents.defaults.workspace` | this repository's `workspace/` directory |
| `plugins.allow`, `plugins.load.paths`, `plugins.entries` | `rein-operations`, loaded from `plugins/rein-operations` |

`plugins.allow` is the global plugin allowlist. This local demo allows only Rein. When configuring a model provider or chat channel, add its exact plugin ID to this list (for example `openai` or `slack`) as part of that setup, otherwise the integration remains disabled. This does not change upstream code or an existing global profile.

The source directory must be writable for ignored dependency, cache and build outputs; only tracked upstream source files are treated as read-only.

`runtime/` is gitignored. No channel, model provider or credential is configured, and no business
tool is enabled.

## 4. Run the structural checks and tests

```sh
npm run toolchain:pnpm -- run check    # scaffold files, unapproved example policy, source hashes, AC01-AC20
npm run toolchain:pnpm -- test         # plugin boundary and upstream update script fixtures
```

`check` proves the repository scaffold is intact. Business module tests exercise local rules; they
do not prove a live chat or website integration.

## 5. Inspect the plugin

```sh
npm run toolchain:pnpm -- openclaw plugins list --verbose
npm run toolchain:pnpm -- openclaw plugins inspect rein-operations --runtime --json
npm run toolchain:pnpm -- run verify:plugin
npm run toolchain:pnpm -- run verify:proposal-tools
npm run toolchain:pnpm -- openclaw plugins doctor
```

`--runtime` reports what the gateway actually registered, which is stronger than reading the
manifest. With no `foundationDb` block configured, expect three tools - `rein_status`,
`rein_simulate_proposal` and `rein_simulate_vote` - and no live business action. Configuring the
optional `proposalTools` block adds the four legacy proposal tools; configuring `foundationDb`
instead registers the twelve database-backed tools and hides both the simulators and the legacy
proposal tools. The twelve are `rein_member_status`, `rein_funds`, `rein_poll_candidates`,
`rein_vote_type_resolve`, `rein_governance_proposal_submit`, `rein_poll_open`, `rein_poll_vote`,
`rein_poll_result`, `rein_proposal_collect`, `rein_proposal_comment_suggest`, `rein_revision_approve`
and `rein_revision_apply`. `verify:plugin` checks all of this through the
real loader; `verify:proposal-tools` does the same for the four v2 proposal tools.

`rein_status` reports which of these groups are registered through
`foundationDbReadToolsEnabled`, `foundationDbWriteToolsEnabled`,
`foundationDbCollectToolsEnabled` and `foundationDbFeedbackToolsEnabled`. A malformed `foundationDb`
block is refused with
`foundation_db_config_invalid`, and a named server environment variable that is unset or empty is
refused with `foundation_db_env_value_missing`; both name the offending key or variable and never
echo the secret itself.

## 6. Run the gateway locally

```sh
npm run toolchain:pnpm -- openclaw gateway run       # foreground; stop it with Ctrl-C when finished
```

From a second terminal:

```sh
npm run toolchain:pnpm -- openclaw gateway health --port 18791
npm run toolchain:pnpm -- run smoke:gateway
npm run toolchain:pnpm -- openclaw doctor
```

`npm run toolchain:pnpm -- run smoke:gateway` calls the read-only `rein_status` through the
authenticated local HTTP endpoint without printing the token. It needs no model API key, and it
needs the gateway to have printed `ready`; a refused connection during startup is not a tool
failure. `gateway health` is the unauthenticated readiness probe for the same port, and
`openclaw doctor` reports the runtime configuration state.

Reveal the generated shared token only when a client needs it, and treat the output as a secret:

```sh
npm run toolchain:pnpm -- openclaw gateway auth-token --show
```

`scripts/openclaw.mjs` sets `OPENCLAW_STATE_DIR=runtime/openclaw` and
`OPENCLAW_CONFIG_PATH=runtime/openclaw/openclaw.json` before delegating to the upstream CLI, so
local work does not touch a global `~/.openclaw` profile.

## What is still unconfigured

- No chat platform, model provider or credential is connected.
- `config/operations.example.json` is a design input, not native OpenClaw configuration, and
  nothing loads it.
- The MVP slice exists as code but is not wired to anything: no Slack workspace and no live database
  connection. Two base migrations are applied to the linked `BeneficenceProtocol` project (the
  `20260924094436` identity/funds migration and the `20260924095705` proposals/polls/ballots
  migration, in filename order); the `20260927103000` clock migration and the `20260927110000`
  rename migration are also **applied** there as of 2026-09-28. Applied schema is not Agent use: no
  tool has used the new names live, and the twelve tools stay unregistered until an operator enables
  them explicitly. There is no deployment or live use of these tools to report.
- The opt-in Slack identity email match is implemented and locally tested but disabled by default;
  the governance app's `users:read` and `users:read.email` bot scopes and its bot token are not
  installed or configured, so senders still resolve through the retained link table.
- Budget, outcome, publishing and oversight behaviour does not exist in the MVP. Weighted voting,
  quorum, recusal and competing-budget allocation are deferred.
- Governance parameters, storage, hosting and website contracts remain unresolved; see
  [decisions](decisions.md).

## Optional: enabling the database-backed Slack tools locally

The slice needs a Slack app in Socket Mode, one target workspace, approved proposal and Board
channel IDs, and a database whose migrations have been reviewed and applied by a person. The database
names in this guide are the stable ones: the plugin now calls the tables and RPCs
`<env>_rein_proposals`, `<env>_rein_polls`, `<env>_rein_ballots`, `<env>_rein_vote_types`,
`<env>_rein_proposal_revisions`, `<env>_rein_finalize_poll` and `<env>_rein_approve_revision`. Those
names arrive through the forward migration `20260927110000_rein_governance_names.sql`, ordered after
the committed `20260927103000`; both are **applied** to the linked project as of 2026-09-28, so the
new names resolve there. The migration keeps the old `<env>_rein_mvp_*` names reachable as
compatibility views and wrappers, so old-name callers still work during the transition. Applying the
migration is not Agent use: the live code path has no end-to-end result.
Those aliases are a transition aid, not the long-term contract: they can be retired once every
old-name client has been replaced and verified on the new `<env>_rein_*` names, and the migration
that drops them must not be applied before that.
The plugin config names server environment variables rather than carrying credentials:

```json
{
  "foundationDb": {
    "enabled": true,
    "platform": "slack",
    "slackTeamId": "T01234567",
    "environment": "dev",
    "proposalChannelIds": ["APPROVED_PROPOSAL_CHANNEL_ID"],
    "boardChannelIds": ["APPROVED_BOARD_CHANNEL_ID"],
    "supabaseUrlEnvVar": "REIN_SUPABASE_URL",
    "supabaseServiceKeyEnvVar": "REIN_SUPABASE_SERVICE_KEY",
    "proposalConfirmationKeyEnvVar": "REIN_PROPOSAL_CONFIRMATION_KEY",
    "identityEmailMatch": "disabled",
    "slackBotTokenEnvVar": "REIN_SLACK_BOT_TOKEN"
  }
}
```

`environment` has no implicit default and selects the `dev_` or `prod_` table set. `slackTeamId` must
be the single workspace this installation serves. Enable this only against an isolated database. The
two migrations are applied to the linked `BeneficenceProtocol` project and define both the `dev_*`
and `prod_*` objects, but the Agent has no connection to it and neither set has verified data, so
treat every environment as unseeded until a human runs the reviewed seeding steps. The full sequence
is in the
[deployment runbook](implementation-and-deployment-zh.md).

All four `*EnvVar` fields name server environment variables; the values are read from the server
process and never stored in plugin config, results or logs. Set them on the deployment side:

- `REIN_SUPABASE_URL` is the bare project URL. It must be `https`, except for a loopback address
  (`http://localhost` or `http://127.0.0.1`) during local development, so the key is never sent over
  a plaintext network hop.
- `REIN_SUPABASE_SERVICE_KEY` is the server-only Supabase key. Both key generations work: a legacy
  `service_role` JWT is presented in `apikey` and `Authorization: Bearer`, while a modern
  `sb_secret_` key is presented in `apikey` only, because Supabase rejects it as a bearer token.
- `REIN_PROPOSAL_CONFIRMATION_KEY` is a random server-only secret of at least 32 bytes, used to sign
  the short-lived proposal confirmation token. Generate it once per deployment, for example with
  `openssl rand -base64 48`, keep it out of the repository, and rotate it only if it may have leaked:
  rotating invalidates any confirmation prepared before the rotation, which the proposer can simply
  re-prepare.
- `REIN_SLACK_BOT_TOKEN` (named by `slackBotTokenEnvVar`) holds the governance app's bot token with
  `users:read` and `users:read.email`, and is read only when `identityEmailMatch` is `"enabled"`.

### Slack identity email match (opt-in, disabled by default)

D13 resolves a Slack sender by the sender's current profile email, matched exactly to one
`<env>_contact_identities` row. The resolver ships in `slack-email-lookup.ts` with local tests, but
it is opt-in and **off by default**: with `identityEmailMatch` absent or `"disabled"`, the reader
keeps resolving through the retained link table and `slackBotTokenEnvVar` is not read at all.

Enabling it is four human steps; none of them is an Agent action:

1. On the **governance** Slack app (not the local human test user app), add the bot scopes
   `users:read` and `users:read.email`, then reinstall the app in the single target workspace. Those
   scopes are not installed today.
2. Put that app's bot token in the server environment variable named by `slackBotTokenEnvVar`, for
   example `REIN_SLACK_BOT_TOKEN`. Keep the value in the deployment's own secret store, outside git;
   never paste it into plugin config, a prompt, a result or a log.
3. Set `identityEmailMatch` to `"enabled"` in the same `foundationDb` block, with `slackBotTokenEnvVar` naming
   that variable. An `"enabled"` mode without a valid variable name fails the configuration instead
   of silently falling back to the link table.
4. Seed one normalized email per contact in `<env>_contact_identities`. With no seeded rows the
   enabled resolver refuses every sender, and a missing or hidden profile email, an unmatched or
   ambiguous match, and a revoked or conflicting retained link row all fail closed.

The token is read from the server process only and never appears in plugin config, a status, a
result or a log. The lookup calls `users.info` for the trusted sender alone, and a profile from
another team is refused.

### Proposal author confirmation

A stored proposal must be the version its author confirmed (PRD §2.3 step 2). Because the MVP
proposal table has no draft status or confirmation column, the registered
`rein_governance_proposal_submit` tool enforces this in two steps instead of storing a draft row:

1. The first call, without `confirmationToken`, writes nothing and returns `status: "prepared"` with
   the canonical proposal text (`prepared`), a short-lived `confirmationToken`, and its `expiresAt`.
2. The Agent reads that text back to the proposer. Only after the proposer explicitly agrees does it
   call the tool again with `confirmationToken` returned unchanged and
   `confirmPronouncedByAuthor: true`.

The token is an HMAC-SHA256 signature over the proposer and the exact proposal fields, so changing
the title, the type, the amount or the currency after the preview is refused with
`proposal_confirmation_mismatch`, an expired token with `proposal_confirmation_expired`, a missing
statement or token with `proposal_confirmation_required`, and a token the server did not mint with
`proposal_confirmation_invalid`. The proposal identifier is derived from the confirmed text, so
re-confirming the same version returns the same record instead of inserting a second proposal.

The conversation is the requirement: the proposer has to confirm the prepared text. The token and
the boolean are only the technical gate that stops a tool call from standing in for that
confirmation.

## Before any real operation

1. Run `npm run toolchain:pnpm -- run check` and `npm run toolchain:pnpm -- test`. They validate the
   scaffold and the plugin boundary only.
2. Read the PRD and resolve the launch prerequisites in [decisions](decisions.md) with authorized
   owners.
3. Implement identity, policy, durable records, governance and outbox services as Rein-owned
   plugins with audited tool contracts. `config/operations.example.json` is a design input, not
   runtime enforcement.
4. Configure exactly one chat platform, its channel scopes and its credentials outside git. Wire
   the website adapter with least-privilege service credentials. Keep private runtime memory
   outside the repository and enforce shared-session isolation.
5. Use synthetic data in a separate sandbox to verify AC01-AC20, including outage recovery, budget
   competition and consent withdrawal. Record the tested runtime commit and the results.
6. Have the designated operators explicitly activate approved policies and scoped tools for a
   limited pilot. Verify pause, recovery and exception ownership before widening access.

Workspace prompts alone do not establish access control. Until services and policies are ready, use
the agent only for drafts and demonstrations with synthetic data.

## Updating the runtime

See [upstream](upstream.md) for the reviewed pin update, the post-update checklist and rollback.

## Verified baseline

On 2026-09-23, upstream commit `4a11f89e840b2bb3eedcad2820ab25b8520905b6`
passed a frozen dependency install and full source build using Node 24.16.0 and pnpm 12.4.2.
Repository checks, both tests, the real OpenClaw plugin loader, and an authenticated
`rein_status` call through the isolated local gateway passed. The temporary gateway
was stopped after verification. No live platform integration or model inference was tested.

The upstream UI build reports an advisory Mermaid bundle budget violation
(1555.8 KiB gzip versus 960 KiB); the build exits successfully. This is upstream
output, and no upstream source was modified to suppress it.
