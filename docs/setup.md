# Setup and local runtime

This is the local bootstrap for the vendored OpenClaw runtime and the `rein-operations` plugin. It
configures no chat platform, no model provider and no business tool, and it activates no governance
policy.

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
pnpm install
```

Upstream is a separate workspace with its own lockfile. Install and build it in place:

```sh
pnpm --dir vendor/openclaw install --frozen-lockfile
pnpm --dir vendor/openclaw build
```

`vendor/openclaw` is a full source checkout, so the `openclaw` launcher resolves TypeScript sources
and needs this install and build before it can run. The current upstream `build` also produces the Control UI assets the gateway dashboard serves. Prefer `pnpm --dir vendor/openclaw ...` (or `pnpm -C`) so the pinned pnpm
version from upstream's own `packageManager` applies.

## 3. Create the isolated local config

```sh
pnpm run setup:local
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
pnpm run check    # scaffold files, unapproved example policy, source hashes, AC01-AC20
pnpm test         # plugin boundary and upstream update script fixtures
```

`check` proves the repository scaffold is intact. It says nothing about a running agent.

## 5. Inspect the plugin

```sh
pnpm openclaw plugins list --verbose
pnpm openclaw plugins inspect rein-operations --runtime --json
pnpm verify:plugin
pnpm openclaw plugins doctor
```

`--runtime` reports what the gateway actually registered, which is stronger than reading the
manifest. Expect exactly one tool, `rein_status`, and no enabled business capability.

## 6. Run the gateway locally

```sh
pnpm openclaw gateway run
```

From a second terminal:

```sh
pnpm openclaw gateway health --port 18791
pnpm smoke:gateway
pnpm openclaw doctor
```

`pnpm smoke:gateway` calls the read-only `rein_status` through the authenticated local HTTP endpoint without printing the token. It needs no model API key.

Reveal the generated shared token only when a client needs it, and treat the output as a secret:

```sh
pnpm openclaw gateway auth-token --show
```

`scripts/openclaw.mjs` sets `OPENCLAW_STATE_DIR=runtime/openclaw` and
`OPENCLAW_CONFIG_PATH=runtime/openclaw/openclaw.json` before delegating to the upstream CLI, so
local work does not touch a global `~/.openclaw` profile.

## What is still unconfigured

- No chat platform, model provider or credential is connected.
- `config/operations.example.json` is a design input, not native OpenClaw configuration, and
  nothing loads it.
- Identity, proposals, voting, budget, outcome and publishing behaviour does not exist yet. The
  plugin exposes only the read-only `rein_status`.
- Governance parameters, storage, hosting and website contracts remain unresolved; see
  [decisions](decisions.md).

## Before any real operation

1. Run `pnpm run check` and `pnpm test`. They validate the scaffold and the plugin boundary only.
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
