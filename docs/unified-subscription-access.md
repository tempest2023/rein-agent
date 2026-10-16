# Unified subscription access and dynamic routing

For installation and operator commands in Chinese, see the
[Model Router and Dynamic Router quickstart](model-router-quickstart-zh.md).

Status: opt-in repository feature; live acceptance for all four providers is **pending**. The
[example configuration](../config/subscription-router.example.json) is disabled, contains synthetic
model IDs and limits, and marks every billing source unverified. It is not a discovered provider
catalog. Provider sign-in, subscription/API access and token refresh belong to Magpie. Rein
connects OpenClaw to that gateway without implementing or restricting provider plans. Nothing
in this feature activates a live profile.

Nori is a Foundation-operated NGO agent serving the general public through Discord and Slack.
The operator owns the provider connections; members do not need separate provider accounts.
Channel, sender and session identities control privacy, permissions and routing context, not the
provider's billing account. Rein does not require each Discord or Slack member to connect a
separate provider account.

On 2026-10-15 the operator confirmed a China Bailian **Personal** Token Plan with monthly
allowance remaining and no active add-on packs, and clarified that no Claude subscription is
currently connected. Claude support is a future, plan-agnostic adapter requirement: Pro, Max,
Team and other accounts supported by Claude Code use the same bridge. Model access and limits
come from the connected account; Rein does not require Max, fabricate model entitlements or
route differently merely because a plan has a different name.
Use the model catalog and authentication methods exposed by the connected Magpie instance.

## Product contract

| Requirement | Behavior |
| --- | --- |
| R-SUB1 | Preserve existing OpenClaw agents, tools, channel adapters, identity checks, sessions and workflows. Add Rein code through the plugin SDK; keep `vendor/openclaw` unchanged. |
| R-SUB2 | Serve OpenAI, Claude, Google and Bailian through one local Magpie gateway, with an extensible operator-declared route catalog. Provider authentication and protocol implementation remain in Magpie. |
| R-SUB3 | Support explicit manual routes and an automatic route; use only the configured fallback list, in order. An empty fallback list authorizes no alternate route after model failure. |
| R-SUB4 | Expose the requested route, actual served provider/model when available, effort and declared billing source. Distinguish operator declarations from provider billing evidence. |
| R-SUB5 | Leave provider sign-in, token storage, refresh, rotation and reauthentication to Magpie and its supported native clients. Rein receives only a gateway credential. |
| R-SUB6 | Default to subscription or coding-plan routes. Additional paid inference requires explicit configuration; hosted Jev has a separate paid opt-in. Fail closed when a route or credential is unverified or unavailable. |
| R-SUB7 | Use Jev to distinguish self-contained everyday questions from contextual, research and coding tasks in Discord and Slack. Prefer a capable default when uncertain, and use trusted administrator context and per-route thinking effort. Measure token savings and answer quality before claiming improvement. |

OpenClaw sends its ordinary model request to the Rein `rein-magpie` provider. The `rein-router`
plugin maps `rein-magpie/auto` to an eligible configured route through the host decision runtime;
manual aliases address a declared route directly. Magpie translates protocols, performs the model
request and handles the upstream account lifecycle. Existing OpenClaw tools continue through their
existing execution and permission checks. Routing never grants administrator authority.

The plugin's route choice does not remove conversation history, workspace instructions, memory or
tools. Identifying a self-contained question can reduce model and reasoning cost; reducing the
context itself needs a separately verified OpenClaw context policy. Frequent model changes can
also reduce cache reuse, so total input, cached input, output, reasoning tokens and task success
must be measured together.

## Compatibility and billing boundaries

The reviewed Magpie source is
[`95e7c6bcc07629897f6703c31eaef477fcee4a13`](https://github.com/yetone/magpie/tree/95e7c6bcc07629897f6703c31eaef477fcee4a13).
Magpie is a pinned, project-local headless dependency. Explicit bootstrap prepares its source and
binary; the router can manage the resulting process for the OpenClaw gateway lifecycle. Runtime
startup does not clone, build, download or globally install Magpie. Its loopback gateway is
`http://127.0.0.1:3425`; OpenAI-compatible clients use `/v1`. It translates streaming and tool calls
between supported APIs. An operator can also configure an existing local gateway. The deployed
Magpie version must be checked against these assumptions.
[Magpie integration contract](https://github.com/yetone/magpie/blob/95e7c6bcc07629897f6703c31eaef477fcee4a13/docs/integrating.md).

Keeping Magpie as an unmodified executable lets upstream own its protocol adapters, account
refresh and native-client bridges. The Rein plugin owns the OpenClaw SDK boundary, routing policy
and process lifecycle. Upgrades require changing one dependency pin and passing the gateway and
native-host probes; Rein does not maintain a Magpie fork or embed its Go internals in OpenClaw.
For the reviewed upgrade workflow, including private-profile backups, pin updates, compatibility
checks and rollback commands, see the [Magpie upgrade guide (Chinese)](magpie-upgrade-zh.md).

| Provider | Magpie route | Rein integration responsibility |
| --- | --- | --- |
| OpenAI | `chatgpt-api/<model>` for official Sign in with ChatGPT; `codex/<model>` is a separate Magpie adapter | Preserve the selected route, tools, effort and billing label; never replace it with an API-key route automatically. |
| Claude | `claude/<model>` through Magpie's Claude Code bridge | Use the same adapter for Pro, Max, Team or other Magpie-supported accounts; no tier whitelist. |
| Google | The configured Magpie Google provider, such as `gemini/<model>` or `antigravity/<model>` | Use the actual gateway catalog and preserve the chosen authentication/billing source. |
| Bailian Token Plan, China | `bailian-token-plan/<model>` using the dedicated plan preset | Preserve the existing key and dedicated endpoints; do not substitute general DashScope API access. |

OpenAI's official SIWC flow uses OAuth with ChatGPT plan-usage permission and the public Responses
API. The pinned Magpie version already implements its `chatgpt-api` provider; Rein delegates
sign-in, refresh, request formatting and provider errors to Magpie. A normal API key is a separate
billing route. [Official inference contract](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

For the existing China Token Plan, the Anthropic base is
`https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic` and the Chat Completions base is
`https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`. Magpie's native preset
provides both. The existing local catalog contains `auto` and `qwen3.8-flash`; an explicit model
is easier to correlate with served-model evidence. This plan uses `billingMode: "subscription"`.
The older Coding Plan is a different preset/product and remains supported through the generic
route schema when configured explicitly.

The no-extra-paid-usage requirement stays at the integration boundary: paid routes require both
explicit paid switches, fallback is an ordered allowlist, and the gateway key is restricted to
configured model members. Configure Magpie's own allowance/credit controls for the connected
accounts. Do not infer billing from a model name or claim that configuration alone proves a
provider invoice. Existing prepaid packs can be consumed by the provider after monthly allowance;
the bounded Bailian live probe therefore retains an explicit add-on-pack declaration.

## Project-local Magpie lifecycle

Prepare Magpie explicitly through the repository toolchain:

```sh
npm run toolchain:pnpm -- run magpie:setup
npm run toolchain:pnpm -- run magpie -- version
```

The single version pin lives in `plugins/rein-router/magpie.lock.json`. Bootstrap checks out that
revision under the ignored `.toolchain/magpie`, builds `.toolchain/magpie-bin/magpie`, and verifies
the result. It requires Git and Go; the pinned Magpie module specifies Go 1.26.8, so Go's automatic
toolchain selection may download that toolchain and module dependencies during this explicit
step. Bootstrap does not authenticate providers, activate OpenClaw or install a global binary.

The `magpie` package script runs the prepared binary with project-local paths under
`runtime/magpie/{home,config,state,cache,data,tmp}`. Gateway startup belongs to the OpenClaw
service; the operator wrapper does not start `serve`. Use this
wrapper for operator commands so setup, account configuration and the managed process use the
same protected local stores. Keys and tokens stay in ignored runtime storage or the approved
environment secret flow, never tracked configuration. Provider commands can contact live
services; the operator must choose and authorize those commands explicitly. The wrapper rejects
credential literals in arguments and credit-spending enablement. It defaults to subscription
discovery off; authorized account setup/read commands use
`npm run toolchain:pnpm -- run magpie -- --allow-subscription-accounts <command>`.

To let the router own the gateway process, add an absolute-path `managed` block to the local
router configuration:

```json5
{
  gateway: {
    baseUrl: "http://127.0.0.1:3425/v1",
    apiKeyEnvVar: "REIN_MAGPIE_GATEWAY_KEY",
    subscriptionOnly: true,
    managed: {
      binaryPath: "/absolute/path/rein-agent/.toolchain/magpie-bin/magpie",
      homeDir: "/absolute/path/rein-agent/runtime/magpie/home",
      allowSubscriptionAccounts: false,
    },
  },
}
```

The OpenClaw plugin service verifies the bootstrap receipt and binary digest, starts its
foreground `serve` process, checks the pinned version and exact restricted model catalog using
the managed key with `Origin: null`, and owns its shutdown. It refuses to adopt an existing
process on the requested port. A missing binary, occupied port,
failed readiness check or child-process exit fails closed; runtime startup performs no build,
download or automatic restart. An externally managed gateway remains available by omitting
`gateway.managed`.

OpenClaw prepares separate plugin instances for model runs. A Rein-owned process registry lets
those instances observe the actual service owner's readiness, scoped to the plugin source, host
state directory and complete normalized router policy. Only service startup publishes ownership;
prepared hooks cannot start or adopt a gateway. Shutdown fences readiness before cleanup, and
unstarted instance disposal cannot stop another instance's service. Credential rotation still
invalidates the owning manager's readiness. This bridge uses standard JavaScript state rather
than OpenClaw private runtime imports.
Concurrent shutdown requests share one cleanup operation; the service refuses a restart until
that operation settles.

The service, CLI wrapper and offline import share a private profile lock. Controlled shutdown
captures the owned process tree, including native clients in separate sessions, and checks PID
start identities before final signals. If cleanup cannot be established, routing remains closed
and the lock is retained. Inspect the recorded owner PID and the private runtime before removing
a stale `.rein-magpie.lock`; a crashed parent cannot establish the ancestry of already detached
clients. Native subscription bridge recovery still needs live acceptance.

Reuse the configured China Bailian Token Plan and prepare a key restricted to the local router's
exact catalog without changing the working OpenClaw profile:

```sh
npm run toolchain:pnpm -- run magpie:import-bailian
npm run toolchain:pnpm -- run magpie:prepare-key runtime/magpie/router.local.json
```

The importer reads the existing environment SecretRef and writes only the private Magpie
provider store. Key preparation captures secret-bearing native output privately and publishes
`runtime/magpie/gateway.env` with mode 0600 only after verifying the exact model restriction.
It refuses to silently expand an existing key's scope. Prepare the local router JSON first;
these commands neither enable routes nor attest their billing sources.

For an intentional catalog change, stop the gateway, review the new eligible routes and run
`npm run toolchain:pnpm -- run magpie:prepare-key --replace runtime/magpie/router.local.json`.
Replacement verifies the new scope, revokes only the old project-owned key and atomically
publishes its replacement. Without that explicit flag, a scope change is refused. Failed
publication after revocation leaves the old credential unusable, so recovery fails closed.

After explicitly enabling the matching project-managed router in the working profile, the
repository's `openclaw` wrapper loads only its declared key from that protected environment file.
Disabled, unrelated and externally managed profiles do not read it. A conflicting existing value
fails closed. The existing `runtime/openclaw/.env` remains unchanged; no secret belongs in shell
arguments, tracked JSON or a generated merge fragment.

Native subscription-account discovery is off by default. Set `allowSubscriptionAccounts: true`
only when explicitly configuring the intended ChatGPT/Claude accounts and their native client
access. It does not enable paid overages. Provider authentication and account access stay in
Magpie; the router enforces its declared model routes and explicit fallback policy.

The simplest account setup uses Magpie's native configuration page:

```sh
npm run toolchain:pnpm -- run magpie:ui
```

The launcher uses the verified project-local binary, the same private profile as the managed
gateway, and an ephemeral loopback page. Magpie opens the browser and handles provider sign-in,
account management, tokens and model discovery. Choose its ChatGPT API provider for the official
SIWC route; Claude, Google and other providers use Magpie's corresponding native setup flows.
`--no-open` leaves browser opening to the operator. No global installation or OpenClaw profile
activation occurs. Close the page process with Ctrl-C before starting the managed gateway; the
shared profile lock prevents simultaneous owners, and an occupied gateway port is refused.

Before opening the page, the launcher runs Magpie's own `update auto off` command in that private
profile. Configuration failure prevents startup. This keeps the verified binary pinned; upgrade
the dependency through a reviewed lock-file change and `magpie:setup`. That command builds the
locked revision; it does not discover or select a newer upstream release. Upstream update
monitoring and upgrade-PR creation are currently manual.

Twelve launcher unit tests cover fixed arguments, isolation, contention, updater setup, normal exit and signal
cleanup. The opt-in native check uses the actual pinned binary in a fresh synthetic profile: it
starts with automatic updates enabled and verifies they are disabled, authenticated HTML/settings,
the exact gateway catalog, zero model requests and removal
of both listeners and the lock after SIGTERM. CI runs it after building Magpie. Reproduce it with:

```sh
REIN_RUN_NATIVE_MAGPIE_UI=1 npm run toolchain:pnpm -- exec node --test tests/magpie-ui-native.test.mjs
```

With the managed gateway stopped, sign in through the protected project profile, one command at
a time:

```sh
npm run toolchain:pnpm -- run magpie -- --allow-subscription-accounts accounts add codex
npm run toolchain:pnpm -- run magpie -- --allow-subscription-accounts quota credits off
npm run toolchain:pnpm -- run magpie -- --allow-subscription-accounts accounts add claude
```

Codex opens Magpie's browser OAuth flow. Claude requires the genuine installed Claude Code
executable and opens its subscription sign-in flow in a private account directory. Complete
these browser steps yourself; do not paste sign-in tokens into chat or copy global credential
stores. Check Claude's account-side extra-usage setting before inference. Discover the resulting
models, review the eligible account list and update the restricted gateway key before activation.
Repeat the Codex credit opt-out after adding another eligible Codex account.

For native `codex/...` routes, managed startup also reads the private saved and current account
identities and requires each one in Magpie's `codexNoCredits` preference before starting.
Missing coverage, API-key authentication or ambiguous identities fail with
`rein_magpie_codex_credit_configuration_required`. This audit reads no account-wide usage API
and reveals no account name or token. Both explicit paid switches are required to bypass it.
Quota readings can lag, so this guard does not replace provider-side overage controls or billing
acceptance. The CLI wrapper refuses credit enablement, including uppercase `ON`.

## Router configuration

Copy the example to an untracked local file. Replace its synthetic models, account/sender IDs
and context/output limits with the values from your configured Magpie instance. The example uses
native SIWC and China Token Plan namespaces and remains disabled until those billing sources
are configured. `billingVerified: true` records that the operator has checked the selected
allowance or API billing source and overage settings; it is not a provider authorization document
or a legal-eligibility gate. It is required for enabled configurations and does not itself query a
provider billing service.

| Field | Contract |
| --- | --- |
| `enabled` | `false` by default. An enabled valid configuration is required for fragment generation. |
| `gateway.baseUrl` | Loopback HTTP/HTTPS base ending exactly in `/v1`, without credentials, query or fragment. |
| `gateway.apiKeyEnvVar` | Name of the environment secret holding a restricted Magpie gateway key; example `REIN_MAGPIE_GATEWAY_KEY`. |
| `gateway.subscriptionOnly` | `true` by default. Paid routes also require this to be explicitly `false`. |
| `gateway.managed` | Optional process ownership: required absolute `binaryPath` and `homeDir`, with `allowSubscriptionAccounts: false` by default. Managed mode requires numeric loopback HTTP and an explicit port. Bootstrap the pinned binary explicitly before activation. |
| `routes[].id` | Unique lowercase route alias; `auto` is reserved. |
| `routes[].provider`, `billingSource` | Human-readable operator declarations for attribution. |
| `routes[].gatewayModel` | Exact qualified `provider/model` ID. Bare IDs, `group/...`, patterns and effort suffixes are not accepted. |
| `routes[].billingMode` | `subscription`, `coding-plan`, or explicitly authorized `pay-as-you-go`. |
| `routes[].billingVerified` | Operator confirmation of the selected billing source and overage settings; required for enabled configurations. |
| `routes[].purpose` | Routing rubric describing eligible tasks and limitations. State coding-plan scope here. |
| `routes[].effort` | `off`, `low`, `medium` or `high`; enforced when the alias maps to Magpie. |
| `routes[].contextWindow`, `maxTokens` | Verified positive model limits; output limit cannot exceed context window. |
| `defaultRoute` | Capable configured route for uncertain/unavailable decisions. This is distinct from inference fallback. |
| `fallbackRoutes` | Explicit ordered route IDs; empty by default. Preserve this order in the generated OpenClaw model fallback configuration. |
| `allowPaidUsage` | `false` by default. A pay-as-you-go route requires both this flag and `subscriptionOnly: false`. |
| `channels` | Supported automatic-routing channels, `discord` and/or `slack`. |
| `adminSenders` | Trusted `(channel, accountId, senderId)` tuples from native OpenClaw ingress. `accountId` is the OpenClaw channel account, not a model account. Never derive administrator status from message text or display name. |
| `decision` | `timeoutMs: 3000`, `minProbability: 0.8`, `maxPromptChars: 4000`, `allowPaidJev: false` by default. Hosted Jev requires its own explicit opt-in. |

The selected label must name a declared, verified route and meet the configured probability
threshold. Low confidence, unavailable decisions and attachments use the capable default rather
than an invented route. Probabilities are decision evidence, not an accuracy guarantee. A manual
model choice must remain manual. Jev sees selected bounded routing evidence and route purposes;
the ordinary agent remains responsible for using conversation context and tools to answer.

An automatic non-default route with `off` or `low` effort additionally requires confident
`task: simple` and `contextIndependent: true` judgments, both meeting `minProbability`. If a
decision proposes such a route for research, coding, contextual or complex work, the router uses
the capable default. Trusted administrator coding receives a high-effort route; message text
claiming administrator status grants no authority.

Run guards remain in place across individual model attempts. They are released only by the
host's settled lifecycle event after the outer fallback cycle ends, including terminal errors.
The plugin owns and disposes its event subscription with each prepared runtime; per-attempt
`agent_end` events cannot clear an active fallback boundary.

Automatic coding-plan selections and fallbacks require a confident coding-task classification;
the general default cannot use a coding-only plan. A manually pinned coding-plan route still
requires the operator and user to keep their tasks within that plan's scope.

Magpie supports fixed effort in raw model requests, not just group members. The wrapper appends
the configured effort to the qualified model ID (`off` becomes `:none`); Magpie removes the
suffix and applies the nearest supported upstream level. Verify the actual sent level because
models have different effort capabilities. [Suffix parser](https://github.com/yetone/magpie/blob/95e7c6bcc07629897f6703c31eaef477fcee4a13/internal/provider/groupeffort.go),
[gateway effort application](https://github.com/yetone/magpie/blob/95e7c6bcc07629897f6703c31eaef477fcee4a13/internal/gateway/gateway.go#L2291).

Alibaba documents `reasoning_effort: none` as thinking off for `qwen3.8-flash`, and supports low
and medium effort directly. Keep Chat passthrough for the imported Token Plan provider; do not
combine `reasoning_effort` with `thinking_budget` or add contradictory `enable_thinking`
overrides. Actual plan-specific tool and effort behavior still needs live verification.
[Alibaba Chat API reasoning controls](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions/).

## Prepare and review a local profile

1. Keep the working OpenClaw profile and its agents, workspace, channel adapters and plugin
   configuration. Follow [setup](setup.md) for the supported Node/pnpm toolchain. Back up the local
   configuration before merging a fragment.
2. Prepare the project-local Magpie dependency explicitly, then use its CLI to configure supported
   subscriptions in the dedicated local Magpie home. Leave native client credentials in their
   managed stores. Use Magpie's `bailian-token-plan` preset for the existing China Token Plan,
   preserving its Anthropic host and selecting reviewed explicit models. The OpenClaw profile's
   protected `runtime/openclaw/.env` already supplies `BAILIAN_TOKEN_PLAN_API_KEY`; explicit local
   provisioning must transfer it through the approved secret flow into Magpie's protected
   provider store. The managed process does not inherit provider-key environment variables or
   automatically migrate the existing profile. The router does not copy a direct provider key
   into its configuration or tool output. Do not put keys in the
   repository or paste secret literals into shell commands or shell history. Configure Google
   through Magpie's supported native routes and use the connected account's exposed model catalog.
3. Create a named Magpie gateway key for Rein. Restrict it to the exact reviewed models and
   accounts; inspect the catalog using that same key. This is the enforcement boundary if other
   API providers exist in Magpie. Use a generated managed key beginning `sk-magpie-key-`; the
   transport rejects arbitrary loopback tokens and custom-value keys. The reviewed Magpie
   accepts ordinary loopback requests without an enabled key, including unknown key values.
   Rein therefore forces `Origin: null` on every model call and metadata GET: Magpie's documented
   null-origin guard requires an enabled gateway key and rejects an unknown key with HTTP 403
   before routing. This needs no LAN exposure or network-setting change. Inspect the catalog
   using both that key and `Origin: null`; a generated-looking key prefix alone provides no
   authentication guarantee. Keep the key in the environment variable named by
   `gateway.apiKeyEnvVar`, using the generated SecretRef. Fully qualified model names alone do
   not disable provider-level fallbacks.
   [Magpie keyed-caller guard](https://github.com/yetone/magpie/blob/95e7c6bcc07629897f6703c31eaef477fcee4a13/internal/gateway/cors.go#L34).
4. Review each allowed provider's fallback list and account settings. Remove unapproved paid
   paths. Keep Rein out of Magpie automatic groups and classifier-driven groups; the Rein plugin
   owns dynamic route selection. Disable automatic groups in a dedicated Magpie profile if
   appropriate, or leave other clients' groups intact and exclude them from Rein's key/catalog.
   Exact-model requests can still reach a provider's own fallback, so key restrictions and
   provider settings must agree with Rein's catalog.
5. For every eligible Codex account, turn **Use credits** off. Magpie's default permits credit
   spending after allowance exhaustion. Use the project-local CLI:
   `npm run toolchain:pnpm -- run magpie -- --allow-subscription-accounts quota credits <account> off`;
   verify the setting and account identity. Also review
   upstream extra-usage, purchased-credit and auto-reload settings. These changes require the
   operator's live-account authorization and are not performed by the generator.
6. Verify the model limits, endpoint, billing source and overage controls for every local route. Set its
   `billingVerified` flag, choose the capable default and explicit fallback list, then enable the
   local router configuration. Keep hosted Jev off unless separately authorized.
7. Generate a merge fragment for review:

   ```sh
   node scripts/subscription-config.mjs /absolute/path/router.local.json /absolute/path/rein-agent/plugins/rein-router
   ```

   The optional plugin path defaults to this checkout's `plugins/rein-router`. The script prints
   a fragment and performs no live writes, secret resolution, provider calls, sign-in or profile
   activation. Merge dictionaries and append required plugin allow/load entries; do not replace
   existing agents, allowed plugins, model providers or channel settings with the fragment.
   The disabled example intentionally cannot generate an enabled fragment.
8. Inspect the merged local configuration and run the repository's checks/loader probe before
   explicitly activating the target profile. Manual model names are `rein-magpie/<route-id>`;
   automatic routing uses `rein-magpie/auto`. Do not enable additional inference fallbacks in a
   second configuration layer.

The fragment selects the router as the default model. To opt in only one existing agent, merge
the model/allowlist fields into that agent's supported configuration instead of changing the
global default. The plugin does not replace unrelated agents or their fallback settings. Rein
agents' explicit ladders must match `fallbackRoutes` in order; the runtime guard also rejects an
unapproved provider or catalog fallback introduced by another run configuration layer.

Native Slack and Discord retain their normal model-selection commands. The isolated Rein Discord
adapter enables only `/model`, `/model auto`, and `/model <route-id>` when the router is enabled
and allowlisted for Discord. Selection is stored for the authenticated sender's current audience
and session. Named manual routes remain pinned and disable native fallback; `auto` restores
dynamic routing and its configured fallback ladder. `/new`, `/reset`, and `/forget` retain their
existing isolated-session behavior. No general administrative command surface is enabled.

Magpie's gateway key controls and account settings are external prerequisites; the Rein config
does not edit them. Quota readings can lag and an in-flight request can cross a threshold. No
local router can guarantee that an upstream account with paid overage enabled will never spend
money. [Gateway/account reference](https://github.com/yetone/magpie/blob/95e7c6bcc07629897f6703c31eaef477fcee4a13/docs/reference.md),
[Codex credit control implementation](https://github.com/yetone/magpie/blob/95e7c6bcc07629897f6703c31eaef477fcee4a13/internal/cli/quota_cli.go#L44).

## Configure Jev separately

The router uses OpenClaw's native decision runtime and the official `typesafe` plugin; it does
not create another Jev HTTP client or read a Jev environment key independently. The pinned
OpenClaw source is `4a11f89e840b2bb3eedcad2820ab25b8520905b6`. Its
[TypeSafe plugin instructions](../vendor/openclaw/docs/plugins/typesafe.md) describe the supported
SecretRef, host decision role and source-checkout installation. A released installation can have
a different plugin/API version, so verify compatibility rather than assuming an npm package is
available or equivalent.

Hosted Jev is a **separate paid API service**, even when all conversational routes use existing
subscriptions. To authorize it, prepare a protected `TYPESAFE_API_KEY` in OpenClaw's secret store,
merge the following fields, and explicitly set the local router's `decision.allowPaidJev` to
`true`. Append `typesafe` to the existing plugin allowlist; preserve all other entries. Select the
decision role only for intended agents if the default should not apply globally.

Settings → Secrets supports this setup. The equivalent CLI prompts without echoing the key:

```sh
npm run toolchain:pnpm -- run openclaw secrets store set TYPESAFE_API_KEY --kind secret --allow-host api.typesafe.ai
```

```json5
{
  plugins: {
    // Append "typesafe" to the existing plugins.allow list.
    entries: {
      typesafe: {
        enabled: true,
        config: {
          apiKey: { source: "store", provider: "default", id: "TYPESAFE_API_KEY" },
        },
      },
    },
  },
  agents: { defaults: { decisionModel: "typesafe/jev-latest" } },
}
```

The config generator does not enable TypeSafe, select a decision model or create a secret. The
host prepares the SecretRef for each request; use its normal secret refresh flow when rotating
the key. Clearing the decision role or disabling TypeSafe makes decisions unavailable. The
router then uses its configured capable default, without starting a paid decision request.

TypeSafe's official wire contract is `POST https://api.typesafe.ai/v1/systemone` with bearer
authentication and `{model, state, questions}`. A Choice question has instructions and an option
rubric; the response supplies the selected label and probabilities. Jev IDs and pricing evolve;
`jev-latest` is an upstream alias, not a pinned version or quality promise.
[Official API](https://docs.typesafe.ai/api), [model versions and pricing](https://docs.typesafe.ai/models).

## Authentication and billing evidence

Magpie manages token refresh and rotation. In the reviewed implementation Codex rotation writes
back to the native credential store; Google tokens refresh in memory. Claude subscription
generation runs through the genuine Claude Code process with caller tools bridged over MCP. A
revoked/expired sign-in requires the supported account reauthentication flow, never a switch to
an unrelated paid key. [Account lifecycle](https://github.com/yetone/magpie/blob/95e7c6bcc07629897f6703c31eaef477fcee4a13/docs/subsystems/providers-accounts.md),
[Claude bridge](https://github.com/yetone/magpie/blob/95e7c6bcc07629897f6703c31eaef477fcee4a13/docs/subsystems/claude-subscription-bridge.md).

Collect local evidence under the operator's authorization; keep credentials and account/member
identifiers out of commits. Use the named key and opaque request identifier to correlate:

- Magpie reply headers `X-Magpie-Provider` and `X-Magpie-Model` identify the gateway provider and
  selected gateway member. The member name does not establish the vendor's actual model snapshot.
- `GET /v1/magpie/route?session=<id>` records the requested member, attempts, final member, effort
  and vendor-reported `served` model; `/v1/magpie/usage/requests` provides retained request records.
- `npm run toolchain:pnpm -- run magpie -- --allow-subscription-accounts quota --json` or
  `/v1/magpie/quotas` for account allowance readings; a restricted key may
  require its owner's explicit quota-visibility setting.
- `npm run toolchain:pnpm -- run magpie -- usage --csv today` for request/account reconciliation. Its `providerAccount`, provider
  key fingerprint, `host`, requested `req`, actual `served`, tokens and effort are useful route
  evidence. API-price cost estimates and session labels do not prove the billed allowance.
- The provider's own usage/billing dashboard before and after each acceptance case. Bailian plan
  usage may require its console; absent telemetry is **unknown**, not zero usage or free billing.

Use these records to verify the actual serving path; `billingSource` and `billingVerified` in Rein
remain operator declarations. [Usage fields](https://github.com/yetone/magpie/blob/95e7c6bcc07629897f6703c31eaef477fcee4a13/internal/usage/usage.go),
[CSV CLI](https://github.com/yetone/magpie/blob/95e7c6bcc07629897f6703c31eaef477fcee4a13/internal/cli/usage_cli.go).

The transport forces `Origin: null`, creates a fresh opaque `X-Magpie-Session` UUID for each model
call and requests `X-Magpie-Response-Model: vendor`. After a successful response it reads only that
call's completed route trace, with a 750 ms deadline, a 64 KiB response limit, no redirects and the
same restricted gateway key and null-origin authentication guard. The trace must match the
requested member and any available response-header identity. Missing, unfinished, inconsistent or
unavailable trace evidence leaves the vendor snapshot unknown.

The optional `rein_route_status` tool reports only the current session's declared route, billing
source and observed OpenClaw alias. Observed `provider`, `gatewayMember`, `vendorServedModel`,
`effort` and `evidence` are separate fields; a successful member header alone cannot fill
`vendorServedModel`. Evidence remains gateway-reported and does not establish a billed allowance.
The tool does not fetch account-wide usage or expose other sessions, credentials, prompts,
replies, the full route catalog or gateway settings. Use public-safe provider and billing-source
labels because these declarations can appear in channel replies.

To opt in, add the exact name `rein_route_status` to the intended agent's effective tool allowlist.
For the isolated Rein Discord profile, explicitly add it to `tools.allow` while the router is
enabled and allowlisted for Discord. Its reviewed per-turn cap permits this one optional tool
only under that opt-in; the existing tool surface stays unchanged otherwise. Tool invocation
retains the authenticated sender's per-audience session and current-invocation checks.

The opaque trace identifier does not replace OpenClaw's conversation or Magpie's native bridge
affinity. In the reviewed source, account affinity uses the client's native session headers or a
digest of the first user turn, independently of `X-Magpie-Session`. Custom providers need an
additional check: Magpie substitutes this header into ExtraBody values containing `${sessionId}`.
Such a custom cache/session field receives a fresh value per call; do not assume it is stable
across turns. [Conversation identity](https://github.com/yetone/magpie/blob/95e7c6bcc07629897f6703c31eaef477fcee4a13/internal/gateway/gateway.go#L5818),
[custom ExtraBody substitution](https://github.com/yetone/magpie/blob/95e7c6bcc07629897f6703c31eaef477fcee4a13/internal/provider/extrabody.go#L117).

Run offline verification through the repository toolchain:

```sh
npm run toolchain:pnpm -- test
npm run toolchain:pnpm -- run check
npm run toolchain:pnpm -- run verify:subscriptions
npm run toolchain:pnpm -- run verify:subscriptions:slack
```

Both native probes start isolated temporary OpenClaw state and loopback fixture endpoints. They
use the real TypeSafe adapter with a local fake System One service, without contacting hosted
Jev. The default subscription probe exercises the isolated Rein Discord adapter, all four
synthetic routes, streamed tool round trips, scoped manual switching, administrator effort and
configured quota fallback. The Slack probe uses the public channel ingress SDK to exercise five
turns: a simple question, trusted administrator coding, a false administrator claim, the same
sender in a different account and a manual model pin. It verifies trusted channel/account/sender
scope, separate sessions, four decision evaluations and five native tool round trips. It uses no
Slack token, SDK connection or live Slack workspace.

To exercise the reviewed Magpie gateway implementation itself, use the prepared clean checkout
and run the optional mode:

```sh
npm run toolchain:pnpm -- run magpie:setup
npm run toolchain:pnpm -- run verify:subscriptions --magpie-checkout .toolchain/magpie
npm run toolchain:pnpm -- run verify:subscriptions:managed
```

The harness checks the exact revision and rejects tracked source changes. Its isolated Go
fixture runs Magpie's real gateway with synthetic custom Chat Completions providers, a generated
managed key and loopback upstreams. The pinned module specifies Go 1.26.8; an installed Go with
automatic toolchain selection downloads that toolchain and dependencies when needed. The first
build therefore needs network access; inference and decision fixtures remain local. The probe
verifies four routes and their actual upstream effort, streaming tool calls, excluded paid
fallback, unknown-key rejection and distinct gateway-member/vendor-snapshot evidence. It does
not test the native Codex, Claude Code or Google subscription bridges, real Bailian credentials,
token refresh or purchased-plan entitlement.

The managed lifecycle probe uses the prepared headless binary through the real OpenClaw
`registerService` lifecycle, with a fresh synthetic provider and key. It checks native readiness,
the pinned version, exact model scope and profile lock, then verifies that shutdown closes the
owned gateway and releases the lock. It performs no inference and contacts no live accounts.

The opt-in native inference regression uses a fresh synthetic Bailian-shaped provider, dummy
credentials and a loopback upstream with all external TLS tunnels refused:

```sh
REIN_RUN_NATIVE_BAILIAN_SYNTHETIC=1 npm run toolchain:pnpm -- exec node --test tests/bailian-subscription-probe-native.test.mjs
```

It verifies the managed service readiness bridge across prepared OpenClaw instances, two bounded
model requests, a real tool continuation, served-model/effort evidence, usage and lock cleanup.
CI runs it after preparing the pinned binary; the normal Node suite skips this dependency-heavy
test. It establishes native managed inference behavior with synthetic upstreams, not entitlement
or real-provider billing.

The existing China Token Plan can be checked locally without activating its disabled router:

```sh
npm run toolchain:pnpm -- run verify:subscriptions:bailian
```

This dry-run verifies the imported plan endpoints, original credential match and exact
single-model gateway key scope. It performs no inference. The live integration check requires
`--live` and `--prepaid-addons=absent` or `--prepaid-addons=acknowledged`. The add-on declaration
makes the provider's possible prepaid-pack consumption explicit; the probe does not audit
provider eligibility or request authorization documents. Use `absent` when no active add-on
pack exists; `acknowledged` explicitly accepts consumption of already purchased packs.

The live check creates temporary OpenClaw state, uses the production router and managed Magpie
profile, and permits TLS only to the dedicated China Token Plan host. It sends one local test
request for a harmless echo tool and its continuation, with thinking off, bounded output, at most
two SDK model calls and no Jev or fallback. It connects to no Slack/Discord workspace and leaves
the working OpenClaw profile unchanged. Its safe report records served-model/tool/usage evidence;
reconcile the provider subscription ledger before accepting billing. Uncertain process cleanup
retains private evidence for inspection instead of asserting success.

The transport recognizes explicit included/subscription/coding-plan allowance exhaustion in
HTTP 402/429 terminal errors and presents it to OpenClaw as a subscription rate-limit window.
This prevents one exhausted upstream allowance from disabling the shared gateway credential.
Upstream authentication normalization is also conditional: a matching response identity or
completed request trace must establish that HTTP 401/403 came from the exact requested gateway
member. Only then can the failure request reauthentication for that upstream account while an
explicitly configured eligible fallback remains available. A 403 additionally needs clear token
or authentication evidence. An actual gateway-key failure, unmatched identity, unproven quota
error or credit/payment failure keeps its native failure behavior and can stop every alias behind
the shared credential. Recognition is intentionally narrow; new gateway error formats require
validation before expanding it.

## Acceptance record

The versioned [routing evaluation corpus](../evals/subscription-routing.v1.json) contains 66
AI-authored synthetic prompts with proposed task, context, route and answer-rubric labels. Review
these labels against the intended workload before calibration. Its visible development/holdout
split is not a blind benchmark or a representative sample of production traffic.

After reviewing and correcting labels and rubrics, save a separate dataset with
`reviewStatus: "operator-reviewed"` and use `--dataset /absolute/path/reviewed-dataset.json`.
The status is an operator declaration; it does not establish task quality or representativeness.
Keep the published v1 corpus and its hosted report unchanged. Reviewing or changing a corpus
changes its digest, so the original classifier report cannot be replayed as evidence for the
revised dataset; a new hosted run requires separate authorization.

```sh
npm run toolchain:pnpm -- run eval:subscriptions
```

This default command validates the corpus and runs 16 fixed typed-outcome controls through the
production selection policy, with no network or model calls. It leaves classification accuracy,
answer quality and savings unknown. Recorded typed decisions can be replayed with `--replay
/absolute/path/decisions.json`; import paired generation evidence with `--generation
/absolute/path/generation.json`. Optional `--output` creates a new private report and refuses to
overwrite an existing file. The replay recomputes policy choices instead of trusting recorded
route selections.

The optional hosted classifier runner uses the same production routing hooks and native
TypeSafe adapter in fresh OpenClaw state, with no Magpie, conversational model calls, tools or
channels. It requires an enabled, allowed TypeSafe role in a selected configuration, a populated
environment SecretRef, explicit paid authorization and a call-count ceiling:

```sh
npm run toolchain:pnpm -- run eval:subscriptions:hosted --allow-paid-jev --openclaw-config /absolute/path/evaluation-profile.json --max-calls 60 --output /absolute/path/new-decisions.json
```

The checked-in corpus currently requires 60 decision evaluations. The runner accepts only an
environment SecretRef (`source: "env"`, `provider: "default"`) for the isolated evaluation; it
does not resolve or copy the production SecretStore. Prepare an evaluation profile referencing
the intended protected environment variable, with `typesafe/jev-latest` (or a reviewed pinned Jev
version) as its default decision model. The production router continues to support the normal
store SecretRef described above. Never put the key value in the profile or command arguments.
Reports record validated labels, decision usage and latency; unavailable or rejected decisions
produce an incomplete result and unsuccessful exit. An explicitly authorized 60-call hosted run
completed on 2026-10-15 using `jev-1.13.0`. Its [redacted evaluation record](subscription-routing-evaluation-2026-10-15.md)
reports 21 of 24 proposed economical opportunities selected and no unsafe economical selections
against the synthetic labels. Label review, generation quality and net savings remain pending.

Paired generation evidence must identify the dataset, rubric and prompt/context digests, use the
same tool snapshot and generation settings, and retain a fixed capable baseline. Grade both arms
against the same per-case rubric. Measure end-to-end latency, including decision and tool time;
record provider token totals and the available cache/reasoning details without adding overlapping
buckets. Routed totals include measured Jev tokens; missing decision usage leaves the token
comparison unknown. Imported grades and usage remain unverified evidence until reviewed against
their sources. Neither the evaluator nor the hosted classifier performs generation calls.

Repository tests and loader probes use synthetic routes, senders, decisions and transport stubs.
They can establish local policy and OpenClaw plugin compatibility; they cannot establish a
provider's entitlement, billing classification or answer quality. No live subscription call,
Slack/Discord message, token refresh or quota-exhaustion experiment is authorized by running them.

Local verification on 2026-10-14 passed the full Node test suite, scaffold checks, the existing
operations-plugin loader checks and native Discord isolation. The subscription probes established
the four synthetic routes with real host streaming/tool loops, scoped manual selections,
administrator effort and simulated included-allowance fallback, with five decision evaluations
through the emulated gateway and four through the actual pinned Magpie gateway.
The actual gateway also passed the restricted model catalog, excluded-paid-fallback,
member/vendor-snapshot and identified-upstream HTTP 401 fallback cases, including a completed
tool round trip on the configured OpenAI fallback. With forced `Origin: null`, it rejected an
unknown-key GET and an unknown-key model POST naming the excluded paid provider with HTTP 403;
the excluded provider received no call. The emulated gateway separately confirmed that a genuine
gateway HTTP 401 stops the shared credential. The native Slack probe passed all five turns and
four decision evaluations, including capable-default handling of coding claims without trusted
administrator scope and of an account mismatch. These results establish local adapter and
synthetic gateway behavior; live subscription bridges, billing, authentication refresh and answer
quality remain unverified.

The project-local headless build and native managed lifecycle probe also passed. The existing
China Token Plan credential was copied offline into the ignored private Magpie profile; its
original OpenClaw config and environment file were preserved. A disabled local router and
single-model gateway key were prepared. The actual private gateway passed metadata/catalog
readiness and clean shutdown with no inference. These checks establish setup and lifecycle
behavior, not live Token Plan billing or tool-call acceptance.

Further local verification passed the 66-case corpus validation and 16 policy controls, a native
service-start evaluation through the real TypeSafe adapter against a local synthetic server, and
the strict managed inference regression above. The latter completed exactly two capped requests
and one native echo tool continuation with observed effort and vendor model, then released its
profile lock. Process cleanup and terminal fallback settlement also have focused regression
coverage. The separately authorized hosted Jev classification run has completed. The live Bailian
tool round trip also passed; native OpenAI, Claude and Google calls remain pending.
The earlier full Node run passed 1,000 tests with one opt-in native test skipped; that native test
passed separately with the prepared binary. Scaffold validation and source-credential checks
also passed. Neither upstream checkout contains tracked changes.

Follow-up verification on 2026-10-15 passed 24 focused evaluator tests after fixing support for
operator-reviewed datasets. The published v1 corpus and hosted report retained their original
digests. Five existing tests from the pinned Magpie provider package also passed: Codex atomic
rotation preserves its account and private file mode, an in-flight rotation survives caller
cancellation, revoked Codex credentials refresh first, Claude refusal tracks the credential
version, and Google refresh updates memory. These tests use synthetic credentials, isolated
homes and loopback servers with external provider HTTP blocked. CI runs the same anchored test
selection from the reviewed checkout; they do not establish genuine account refresh or billing.

Six pinned Magpie gateway tests also passed, including six account-handoff subcases: native Claude
bridge turn continuity, effort changes, resumed sessions, tool-result account preservation, CLI
effort arguments and removal of inherited gateway authentication overrides. These are upstream
component tests with a fake Claude process, rather than live Claude or full OpenClaw-to-Claude
acceptance. The [CI workflow](../.github/workflows/openclaw.yml) runs both native suites with an
empty starting environment, isolated home/temp directories and the pinned Go toolchain. Some
upstream shell fixtures interpolate temporary paths without quoting; use a private space-free
temporary directory when reproducing them. Both suites passed locally; no upstream source
changes were needed.

The [live Bailian acceptance record](bailian-subscription-acceptance-2026-10-15.md) verifies exactly
two requests to the dedicated China Token Plan host, `qwen3.8-flash` as both requested and served
model, thinking off, one native echo tool continuation and clean managed shutdown. Jev and
fallback stayed disabled. After integrating the latest Discord isolation base, the full Node run
passed 1,035 tests with two optional native
tests skipped; the managed Bailian synthetic probe and native configuration UI test both passed
separately.
The operator chose code delivery first; remaining live account acceptance is deferred. The local
configuration UI has been stopped, and the working OpenClaw profile remains inactive.

| Acceptance criterion | Required evidence | Current result |
| --- | --- | --- |
| AC-SUB1 | Each of the four provider families answers through OpenClaw/Magpie, performs a tool call and resumes after its tool result. Verify the actual gateway model, streaming and integration behavior. | Bailian live round trip passed; OpenAI, Claude and Google live tests pending; no Claude account is currently connected |
| AC-SUB2 | Manual model selection stays on its declared route; automatic routing changes eligible models while preserving agents, tools and workflows. | Live pending; synthetic policy/probe evidence only |
| AC-SUB3 | Correlate each served provider/model/effort with gateway usage and the configured allowance/billing source; no new paid charge. An unverified route cannot activate. | Live pending; configuration labels are not provider-side billing records |
| AC-SUB4 | Simulated rate limits, authentication errors and model failures obey the exact fallback list. Empty fallback returns failure. No paid route or unapproved Magpie path is attempted. | Live pending; synthetic failure coverage only |
| AC-SUB5 | Supported token refresh/rotation preserves the account and allowance source; revoked credentials require reauthentication or an explicitly configured eligible fallback. | Live pending |
| AC-SUB6 | A labeled Slack/Discord evaluation set covers common self-contained questions, contextual follow-ups, research/web summaries and trusted-admin coding. Compare task success, token totals, cache reuse, effort and latency against a fixed capable baseline; verify uncertainty handling and manual overrides. | 60 hosted Jev decisions and six bypass controls recorded; all proposed route envelopes satisfied. Label review and paired generation evidence pending; savings not claimed |

Test account exhaustion through mocks first. Live verification needs an authorized account,
upstream spend controls and redacted retained evidence. Keep all six live criteria pending until
that evidence exists; partial provider success does not meet all-four-provider acceptance.
