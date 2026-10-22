# Nori browser automation

This integration implements the operator's requested browser login capability using
[Vercel Labs agent-browser v0.39.1](https://github.com/vercel-labs/agent-browser/releases/tag/v0.39.1).
It supports the recovery principle in US15 / AC17 and the information boundary in AC16;
it does not implement deferred publishing or payment workflows.

The official discovery Skill is copied **unchanged** into
`workspace/skills/agent-browser`, with its Apache-2.0 license. The installer takes the
official `skills/` and `skill-data/` directories from the same pinned npm package.
`agent-browser skills get core` serves the version-matched upstream instructions.
`nori-browser` adds Nori's invocation, account and recovery rules. No upstream
OpenClaw source or browser engine is modified; this is a CLI/Skill integration.

## Install and discover

Use the existing Node toolchain from [setup](setup.md). Supported hosts are macOS and
glibc Linux on arm64/x64, with `tar` available. Bootstrap downloads the pinned npm archive,
verifies its SHA-512 integrity and the native binary's SHA-256, and extracts just the
host binary plus official skills into `.toolchain/agent-browser/0.39.1`. It does not
run npm lifecycle scripts, install globally, or update itself.

```sh
npm run toolchain:pnpm -- run browser:setup
npm run toolchain:pnpm -- run browser:setup --check
npm run toolchain:pnpm -- run browser -- --version
npm run toolchain:pnpm -- run browser -- skills get core
npm run toolchain:pnpm -- run browser -- install
```

Upstream can automatically discover an installed system Chrome (including this local
Mac's Chrome). `install` is needed when there is no suitable browser and downloads the
browser managed by upstream. To explicitly select one, point
`NORI_BROWSER_EXECUTABLE_PATH` to an installed Chrome executable; on macOS:

```sh
export NORI_BROWSER_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
```

Launch Nori through the repository's `openclaw` script. Its environment now prepends
`bin/` to PATH, so the official Skill's `agent-browser` commands reach the Nori wrapper.
For an already-running gateway, restart it through this entry point when convenient.
For another supervisor, arrange the same PATH (and a supported Node) or use the absolute
`node /path/to/rein-agent/scripts/agent-browser.mjs` fallback in the Nori Skill.
Workspace skills are discovered natively; an existing skill allowlist needs both
`nori-browser` and `agent-browser`. No config merge, exec permission expansion or gateway
restart is performed automatically. Sandboxed or remote execution must have this CLI
and its private storage on the actual execution host; host installation alone is insufficient.

The inspected local profile uses this repository's `workspace/` with no explicit
skill allowlist or tool overrides. Installation preserves that config. This feature is
for the trusted operator profile: do not grant a public community agent arbitrary host
exec or mount these credentials into its sandbox. Skill text and session names do not
enforce authorization or multi-user isolation.

## Enroll credentials locally

Choose an alias for an authorized account. Run enrollment directly in an operator terminal,
using a secret prompt or a password manager piped to stdin. For example, in bash/zsh:

```sh
python3 -c 'import getpass; print(getpass.getpass("Password: "))' | \
  npm run --silent toolchain:pnpm -- --silent run browser -- auth save foundation-admin \
    --url https://app.example.com/login --username operator@example.com --password-stdin
npm run toolchain:pnpm -- run browser -- auth list
npm run toolchain:pnpm -- run browser -- auth show foundation-admin
```

The example URL/user are placeholders. Upstream also supports `--username-selector`,
`--password-selector` and `--submit-selector` on `auth save`. Use them for site-specific
forms. The wrapper rejects `--password` and login URL/provider overrides. Never put
passwords in chat, shell history, committed files, screenshots or model-visible tool input.
`auth delete foundation-admin` deletes just that credential, not existing signed-in sessions.

## Login, reuse and recovery

Use one stable session per account/task, always before the command:

```sh
npm run toolchain:pnpm -- run browser -- --session admin-report ensure-login foundation-admin \
  --url https://app.example.com/dashboard \
  --authenticated-selector '[data-testid="account-menu"]' \
  --login-selector 'form[data-testid="login"]'
npm run toolchain:pnpm -- run browser -- --session admin-report snapshot -i
npm run toolchain:pnpm -- run browser -- --session admin-report close
```

Choose actual site selectors, including a signed-in indicator present on the login landing
page and protected destination. The helper opens the read-only destination, verifies the
saved origin, and reuses a signed-in session. On an unambiguous login page it invokes
native `auth login` once, verifies the resulting signed-in page, and returns to the destination.
It never considers submission alone proof of authentication. Unknown pages or challenges
stop with `manual_intervention_required` and exit code 2; CLI/transport failures exit 1.
For delayed SPAs, first use the official wait/snapshot workflow to identify reliable indicators;
the helper stops if its initial indicators are ambiguous.

The wrapper also waits for native socket/PID cleanup after `close`: v0.39.1 acknowledges
closure before shutting down its daemon, so immediately reopening on a fast Linux host
can otherwise race the old daemon. A pending shutdown times out without replaying commands.

Nori's Skill records the pending task step, invokes recovery when login expires, obtains a
fresh snapshot, and continues. The deterministic helper restores authentication only;
it cannot infer or replay an arbitrary business transaction. A lost response requires
checking the result before repeating any consequential action. Cross-origin SSO, MFA,
passkeys and CAPTCHA use the official headed/manual workflow and may interrupt automation.

## Storage and boundaries

The wrapper derives a namespace from the checkout's real path and `NORI_BROWSER_INSTANCE`
(default `operator`). An instance is a local storage grouping, **not** a chat identity or
authorization mechanism. Set a fixed instance in the trusted supervisor if needed; do not
derive privileged instances from user messages. Browser commands require `--session`.

- The 256-bit key is created once at `runtime/agent-browser/<instance>/encryption-key`
  (0600; containing directory 0700), excluded by the existing `runtime/` gitignore.
- Official Auth Vault files stay at `~/.agent-browser/auth/<namespace>-<alias>.json`.
  The wrapper prefixes aliases because upstream namespaces do **not** scope the vault.
  `auth list` enumerates only this instance's alias names. Other profiles are not decrypted.
- Official cookies/localStorage snapshots stay at
  `~/.agent-browser/namespaces/<namespace>/state/sessions/`. Both vault and saved sessions
  use AES-256-GCM through the same explicit key. `--restore` is supplied for every named
  session. Native sockets live in the namespace's `run/` directory.
- The wrapper ignores inherited `AGENT_BROWSER_*` settings and loads its explicit empty
  config, avoiding accidental personal config, provider or CDP attachment. Its local
  workflow rejects namespace, profile, saved-state, remote-browser and upgrade overrides.
  Use individual commands; batch mode cannot apply the wrapper's credential alias mapping.

Back up the key, encrypted vault files and session directory together. Moving the checkout
changes its namespace; plan migration explicitly. If the key is missing while data exists,
the wrapper stops instead of generating a replacement. Do not delete a live session's key.
Closing a session saves state; deleting a vault profile does not revoke server sessions.
Use the site's logout/revocation and scoped `state clear` when retiring an account.

These files and the key remain accessible to the owning OS account. Encryption at rest is
not protection from arbitrary code run as that account. Namespace separation is not an
OS sandbox. Site output can still contain private data. Use an isolated OS account or
container for stronger separation. Upstream v0.39.1 rejects `--allowed-domains` combined
with `--restore`; this integration does not claim a browser egress allowlist.

## Verification and upgrade

```sh
npm run toolchain:pnpm -- run check
npm run toolchain:pnpm -- test
npm run toolchain:pnpm -- run verify:browser
```

The browser probe uses a temporary, loopback-only fixture with synthetic credentials. It
checks actual native login, encrypted disk state, restart reuse, server-side expiry and
one re-login, then resumes a single synthetic action without duplicate submission. It
cleans its fixture credential, namespace and key. Unit tests cover ambiguous/challenge
pages, origin mismatch, failed results, missing keys and session/credential isolation.
This is not live website or model-driven Nori acceptance; those depend on the account's
login flow and existing exec permissions.

For upgrades, review the upstream release, update `config/agent-browser.lock.json` from
the registry integrity and official release asset digests, refresh the unmodified official
discovery Skill/license, rerun setup and both test layers. Keep the old prepared version
until validation passes. There is no automatic CLI upgrade or browser install during a task.
