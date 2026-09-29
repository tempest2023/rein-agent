# Slack test app: local OAuth setup (separate from the governance app)

This guide covers one local, separate Slack app that mints **user** OAuth tokens for the five Rein
governance test identities, so the harness can post as a real human. It is development scaffolding, not the
governance app.

Current state: the app exists in the test workspace as **`A0C5L0X22DN`**, created blank with **PKCE
enabled** and the user scope **`chat:write`**. The redirect URL is the remaining piece. Slack's app
settings UI refuses `http://localhost`, so this flow registers the HTTPS address of a local quick
tunnel and passes that same address to the helper through `SLACK_TEST_REDIRECT_URI`, while the helper
keeps listening on plain `http://127.0.0.1:8765`.

Do not add user scopes to the existing governance app. Adding `chat:write` as a user scope there would
let any authorizing Board member's token post as them, which collides with the app-scope boundary in
[decisions.md](decisions.md). The governance app does need two **bot** scopes for the D13 email
match — `users:read` and `users:read.email` — and those are not installed yet; keep them on the
governance app and keep them out of this test app.

## What the app is

[slack-governance-test-app-manifest.json](slack-governance-test-app-manifest.json) is the reviewable record of the
intended configuration:

| Item | Value |
| --- | --- |
| Redirect URL | `https://<quick-tunnel-host>/oauth/callback` |
| User scope | `chat:write` only |
| Bot scopes | none (`features` is empty) |
| Socket Mode | disabled |
| PKCE | enabled |
| Token rotation | disabled |
| Org deploy, multi-workspace | disabled |

A desktop redirect is not allowed to request bot scopes, which is why the scope list is user-only.
The manifest contains no credential and is safe to review and commit; the client ID it produces is
also non-secret, and the app has **no client secret** in this flow.

## What this app is not: the identity email lookup

Slack sender identity for the governance slice is resolved on the **governance bot app**, not here (D13 in
[decisions.md](decisions.md)). That bot calls `users.info` with the bot scopes `users:read` and
`users:read.email`, normalizes the sender's profile email, and requires an exact match to exactly one
`<env>_contact_identities` row. The resolver exists in local code (`slack-email-lookup.ts`) with
local tests, but it is opt-in and off by default (`foundationDb.identityEmailMatch` defaults to `disabled`),
and those scopes and the governance bot token are not installed or configured, so nothing in this
guide should be read as claiming the lookup is live.

This test app keeps its single user scope `chat:write` and takes no bot scope. Adding bot scopes here
would not help the identity path, because the lookup runs on the app that receives the inbound
message, and it would blur the line between a human message-injection tool and the governance app.

## Redirect URL: quick tunnel plus loopback listener

Slack requires the registered redirect URL to be HTTPS, and the helper's listener stays on loopback.
A quick tunnel bridges the two:

```sh
cloudflared tunnel --url http://127.0.0.1:8765
```

The command prints a host such as `https://<random>.trycloudflare.com`. The redirect URL is that host
plus the helper's path, so `https://<random>.trycloudflare.com/oauth/callback`. Register it in the app
and pass the identical string to `SLACK_TEST_REDIRECT_URI`.

The redirect URL has to be byte-identical in three places, or Slack answers `bad_redirect_uri`:

1. the Slack app's **OAuth & Permissions** redirect URL,
2. the `redirect_uri` in the authorize request the helper prints, and
3. the `redirect_uri` the helper sends to `oauth.v2.access`.

The helper validates the value **before** it starts a listener: it must be HTTPS, must name a host,
must not carry userinfo, a query string or a fragment, and its path must be exactly `/oauth/callback`.
It also refuses a loopback host under HTTPS, because `https://localhost` cannot receive Slack's
redirect. A misconfigured value fails immediately and locally instead of after a human has consented.

A quick tunnel gets a fresh random host each time it starts, so the registered URL changes with it.
Re-register the new address before the next consent round, and keep the tunnel running while you
consent. The helper never starts, configures or authenticates a tunnel; it only validates the URL.

Slack rejects the legacy `http://localhost:8765/oauth/callback` form in the settings UI.
`SLACK_TEST_ALLOW_LOCALHOST_REDIRECT=1` exists only for an app that already accepted a localhost
redirect; it is not a way to register a new one.

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `SLACK_TEST_CLIENT_ID` | yes | The app's client ID. Non-secret, in the form `1234.5678`. |
| `SLACK_TEST_REDIRECT_URI` | yes | The HTTPS tunnel redirect URL registered in the app, ending in `/oauth/callback`. |
| `SLACK_TEST_OAUTH_PORT` | no | Loopback port; defaults to `8765`. |
| `SLACK_TEST_ALLOW_LOCALHOST_REDIRECT` | no | Opt out of the HTTPS requirement for an app that already accepted a loopback redirect. |

## PKCE is a one-way setting

Slack's PKCE documentation states that enabling PKCE marks the app as a public client and that this
**cannot be disabled without contacting Slack support**. Treat the setting, and the app, as permanent.

Create a separate app for this purpose rather than toggling the governance app, and do not reuse this
app for anything else. If the redirect URL or the scope list ever needs to change, agree that first.

The related consequence: with PKCE enabled, **any refresh token Slack issues expires after 30 days**,
instead of lasting indefinitely. The helper records `expiresAt` and `refreshTokenExpiresAt` in the
token file so this is visible rather than surprising.

## Before you start

1. Use only the five sandbox test accounts. Do not authorize a real member's account, and do not point
   this app at a production or governance workspace.
2. Confirm each test account is a member of the two approved test channels listed under
   *Test accounts, approved channels and CLI* below, since `chat:write` posts as that person.
3. Expect **five separate consent rounds**, one per account. A single install cannot produce five user
   tokens; each round returns one `authed_user` token for the person who consented.

## Steps

1. Start the quick tunnel and copy its HTTPS host, as described above. Leave it running.
2. Set the redirect URL in the app's **OAuth & Permissions** page to
   `https://<quick-tunnel-host>/oauth/callback`. To record the intent for review, the manifest can be
   re-pasted after replacing the placeholder host `your-quick-tunnel-host.example.com` with the real
   tunnel host; a manifest cannot carry the real host because the host changes on every tunnel start.
3. Copy the **Client ID** from **Basic Information** into the shell that runs the helper, together
   with the same redirect URL, for example:

   ```sh
   export SLACK_TEST_CLIENT_ID=1234.5678
   export SLACK_TEST_REDIRECT_URI=https://<quick-tunnel-host>/oauth/callback
   ```

4. Pre-flight one account without touching Slack. `--dry-run` prints the authorize URL and the redirect
   that must be registered, then exits without starting a listener or exchanging anything:

   ```sh
   node scripts/slack-test-oauth.mjs start --account lead --dry-run
   ```

   Confirm the printed redirect matches the app character for character. A mismatch only surfaces at
   Slack as `bad_redirect_uri`, after consent.
5. Run one real round per account, in any order:

   ```sh
   node scripts/slack-test-oauth.mjs start --account lead
   ```

   The helper prints the authorize URL, waits on the loopback port, receives exactly one callback,
   exchanges the code with `code_verifier` and no client secret, verifies the result with `auth.test`,
   and writes the token. Repeat with `member`, `dir1`, `dir2`, `dir3`.
6. Sign in as the intended test account for each round and approve the single `chat:write` request.
   Confirm Slack shows the expected account before approving; the helper refuses a result whose user
   or workspace does not match the account you asked for.
7. Verify with the harness, which never prints a token:

   ```sh
   node scripts/slack-test-cli.mjs whoami
   ```

## Test accounts, approved channels and CLI

### Five sandbox test accounts

Five sandbox Slack identities back the local governance Slack test harness. They are **test** accounts in the
dedicated test workspace `T0C4GRL55HB`, not real members and not operations accounts. Each holds a
user OAuth token (`xoxp-`, user scope `chat:write` only) minted by the local test app described above.
The harness verifies every token with `auth.test` and refuses any workspace or identity mismatch.

Prioritize these five accounts for future scenario tests: they are the only identities with verified
user tokens, and each can post as a real human into the two approved test channels below.

| Account | Environment variable | Slack user id | Role (dev fixture) |
| --- | --- | --- | --- |
| `lead` (sending identity) | `SLACK_USER_TOKEN_LEAD` | `U0C4V074CTW` | Contributor (active) |
| `member` | `SLACK_USER_TOKEN_MEMBER` | `U0C5KLD8Z5E` | Contributor (inactive) |
| `dir1` | `SLACK_USER_TOKEN_DIR1` | `U0C4L74033P` | Director |
| `dir2` | `SLACK_USER_TOKEN_DIR2` | `U0C4T82EPPB` | Director |
| `dir3` | `SLACK_USER_TOKEN_DIR3` | `U0C4L74QGCD` | Director |

The role column names seeded `dev_*` community fixtures in the local development database, not Slack
permissions and not real member records. The role is resolved from the current database rows at
request time (`dev_contributors` / `dev_directors`), and the operator's OAuth token neither grants
nor changes any role. Scenario mapping: AC02 (`lead-1`, active Contributor) is `lead`; AC03 / AC04
(`member-2`, inactive Contributor) is `member`; AC04 / AC05 / AC06 / R1 (current directors) are
`dir1` / `dir2` / `dir3`. The unmatched-email case needs a separate Slack user whose profile email
matches no `<env>_contact_identities` row, or whose profile email is hidden; none of these five
accounts represents that case. Under D13 identity is resolved from that email match, so no account
here relies on a `dev_rein_slack_links` row.

### Optional `guest` account for the unmatched-email case

The harness also supports one **optional** sixth identity, `guest`, for the unmatched-email case
above. It is off until an operator provisions it, because its Slack user id does not exist at build
time: the account must first be invited to `T0C4GRL55HB`, and its id recorded. Nothing about it is
hardcoded, and the five accounts above are unaffected whether or not it exists.

Provisioning is two gitignored values, kept out of the repository exactly like the tokens:

| Value | Environment variable | JSON key | Meaning |
| --- | --- | --- | --- |
| Slack user id | `SLACK_USER_ID_GUEST` | `REIN_SLACK_USER_ID_GUEST` | The invited account's member id, e.g. `U0123ABCDEF` |
| User token | `SLACK_USER_TOKEN_GUEST` | `REIN_SLACK_USER_TOKEN_GUEST` | The `xoxp-` token minted by the local test app |

The account is enrolled **only** when the user id is present and shaped like a real member id. A token
alone never enrolls it, and a value that looks like a token is refused rather than treated as an id,
so a misplaced token can never be read as an identity. Once enrolled, `guest` behaves like any other
account: `auth.test` must resolve it to the configured id in `T0C4GRL55HB`, it may only post in the
approved test channels, and the same local run ledger and `client_msg_id` dedupe apply. When the id is
configured but the token is missing, the load reports `missing-tokens` for `guest` instead of silently
continuing.

Authorize it with the same helper, once its id is configured:

```sh
node scripts/slack-test-oauth.mjs start --account guest
```

Do not provide a real member for this account: it exists to be a person the Agent **cannot** match to
a community record, so it should hold no verified `dev_rein_slack_links` row and an email that matches
no `<env>_contact_identities` row. This harness support is preparation only; inviting the account,
minting its token and running the case are separate operator steps.

User ids and channel ids are non-secret Slack identifiers; the harness source
`scripts/slack-test-lib.mjs` holds the same lists.

### Approved test channels

Test messages may go to these two channels only; the harness refuses any other channel id.

| Channel | Id | Harness label |
| --- | --- | --- |
| `#rein-agent-test` | `C0C4L0YN814` | `proposal` |
| `#rein-board-test` | `C0C5KGG01A4` | `board` |

### Safe CLI commands

Load the tokens into the shell environment, then run the harness; no command prints a token value. The
ambient `node` here is v22, outside this repository's engines range, so every example uses the pinned
toolchain binary `./.toolchain/node_modules/.bin/node` (v24.16.0).

```sh
set -a; . ./.env; set +a                             # load .env for this shell only
./.toolchain/node_modules/.bin/node scripts/slack-test-cli.mjs tokens
./.toolchain/node_modules/.bin/node scripts/slack-test-cli.mjs whoami
./.toolchain/node_modules/.bin/node scripts/slack-test-cli.mjs tokens --file .env

# Dry run: verifies identity, approved channel and body without posting anything.
./.toolchain/node_modules/.bin/node scripts/slack-test-cli.mjs send \
  --case case-02-contributor-proposal \
  --channel C0C4L0YN814 \
  --text '提议人 test：贡献者提案（本地演练，无决策含义）' \
  --account lead \
  --dry-run
```

Quote the case key and body (`'...'`, never bare `<...>`, which the shell reads as redirection) and
always pass an explicit `--channel`. `--channel` defaults to the proposal channel `C0C4L0YN814`; pass
`C0C5KGG01A4` for `#rein-board-test`. Those two ids are the only channels the harness accepts, and it
appends the required mention to the body itself. Drop `--dry-run` only when a real test message is
intended; the harness records each `--case` in `runtime/slack-test-runs.json` and skips a repeat.

Prefer a sourced `.env` or `--file .env` over `export` on the command line, and never `cat`, `echo`,
`grep` or paste `.env` into a prompt, shell history, log, issue or chat message.

### What these tokens can and cannot prove

- User tokens are for **message injection**: the harness posts as a real human in the two test
  channels, which is what the governance scenarios need for authentic-looking traffic.
- They are **not** bot app credentials. The harness has no bot scopes and refuses any token that
  resolves to a bot identity, so a passing run says nothing about the governance bot app.
- A passing `tokens`/`whoami`/`send` run proves identity, workspace membership and posting only. Full
  scenario acceptance still requires the governed end-to-end flow against the configured governance tools and
  local storage; treat the CLI as injecting the input, not as the acceptance result.

## Where tokens live

Tokens are written to a gitignored local path, mode `0600`, replaced atomically:

| Path | Contents |
| --- | --- |
| `runtime/slack-test-tokens.json` | Five `REIN_SLACK_USER_TOKEN_*` user tokens, plus one `meta` object holding non-secret account metadata |

`runtime/` is already gitignored, and `meta` carries bookkeeping such as `userId`, `scope`,
`expiresAt` and `refreshTokenRequired` so the plain token keys stay strings that the harness can read.
Never copy these values into a tracked file, an issue, a chat message or documentation.

No helper command prints a token, a refresh token or an authorization code. Only account ids, the
authorize URL, the redirect that must be registered, and verification results reach stdout; error text
is passed through a token-redaction backstop before it is printed.

The client ID is not a secret. The client **secret** does not exist for this app and is never needed;
if you ever find yourself pasting one, the flow is wrong.

## Rotation and revocation

Token rotation is disabled in this manifest, so no refresh token is issued and access tokens do not
expire on their own. That is the simplest correct setting for a short test window. If Slack does return
refresh fields, the helper stores `refreshToken`, `expiresAt` and `refreshTokenExpiresAt` and prints a
reminder that the refresh token dies 30 days after issue. The helper records rotation data but does not
perform the refresh exchange; treat that as a follow-up, not a supported path.

To revoke: remove the app from the workspace, or revoke the individual user grant, then delete the local
token file. Anyone who authorized appears under the app's **Users** list and can withdraw consent there.
Because PKCE cannot be turned off, revoking access is the only way to retire this app: plan the app as
permanent and turn it off by revocation, not by reconfiguring it.

If a token is suspected to be exposed, revoke first and reauthorize that account; do not try to
"rotate" a leaked token in place.

## Limits to keep in mind

- A user token posts as that human, so it is bound by that person's channel membership and their own
  Slack permissions. A test account outside the two channels cannot post.
- This app does not receive events; Socket Mode is off and there is no bot identity. Inbound message
  handling stays with the existing bot-identity app.
- Consenting is a human action in a browser. The helper never opens a browser and never authorizes on
  your behalf; it only prints the URL.
- The tunnel is part of the security surface: whoever holds the tunnel address can reach the loopback
  listener while it waits. Keep the window short, and let the helper close the listener after one
  callback.
- Retire these tokens when the test window closes. They are development credentials, not operations
  credentials.
