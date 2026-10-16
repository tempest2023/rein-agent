# Model Router 与 Dynamic Router 中文快速上手

本文适用于包含 `plugins/rein-router` 的本仓库源码版本。所有命令在仓库根目录执行；
OpenClaw 命令通过仓库包装器使用 `runtime/openclaw/openclaw.json`。

| 模式 | 用途 | 需要安装什么 |
| --- | --- | --- |
| Model Router | 通过统一网关使用已配置的模型，手动选模、固定思考强度、显示路由来源 | `rein-router` 与项目内 Magpie |
| Dynamic Router | 根据当前问题选择模型及对应思考强度；不确定时使用能力较强的默认路由 | 上述组件，加上 OpenClaw 的 TypeSafe 插件和 Jev API Key |

两种模式共用 `rein-router`。先完成第一部分，再按需开启第二部分。Provider 登录、协议适配、
token 保存和刷新由 Magpie 处理。完整字段与验收说明见[详细指南](unified-subscription-access.md)。

## 一、Model Router：安装、配置、使用

### 1. 安装依赖

需要 Node.js `>=24.16.0 <25` 或 `>=26.1.0`、pnpm `12.4.2`、Git 和 Go。
Magpie 模块会选择固定的 Go `1.26.8` 工具链；首次准备需要下载依赖。
已有仓库本地 `.toolchain` 时，可先在当前终端执行：

```sh
export PATH="$PWD/.toolchain/node_modules/.bin:$PATH"
node --version
pnpm --version
```

准备源码与本地运行环境：

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm --dir vendor/openclaw install --frozen-lockfile
pnpm --dir vendor/openclaw build
pnpm run setup:local
pnpm run magpie:setup
pnpm run magpie -- version
```

`setup:local` 会保留已有 OpenClaw 配置；首次运行才创建默认本地配置。
Magpie 安装在 `.toolchain/magpie-bin`，私有配置在 `runtime/magpie`，无需全局安装。

### 2. 在 Magpie 中连接模型提供方

```sh
pnpm run magpie:ui
```

在打开的本地界面中连接你要使用的账号或 API 路由。OpenAI 的官方订阅接入选择
Magpie 的 **ChatGPT API** Provider；其他提供方使用 Magpie 对应的原生配置流程。

| 提供方 | 路由命名示例，具体模型以 Magpie 目录为准 |
| --- | --- |
| OpenAI | `chatgpt-api/<实际模型>` |
| Google | 配置后的 Google Provider ID，例如 `gemini/<实际模型>` |
| Claude | `claude/<实际模型>` |
| 中国区百炼 Token Plan | `bailian-token-plan/<实际模型>` |

界面启动器会关闭 Magpie 自动更新，以保留项目固定版本。后续更新见[Magpie 升级流程](magpie-upgrade-zh.md)。
配置结束后，在启动终端按 Ctrl-C 关闭界面，再查看模型目录：

```sh
pnpm run magpie -- --allow-subscription-accounts models
```

已有本仓库百炼 Token Plan 配置时，可在网关与配置界面停止后复用它：

```sh
pnpm run magpie:import-bailian
```

Provider 凭据放在 Magpie 的私有存储中；下面的 Router 配置只引用网关凭据的环境变量名。

### 3. 创建 Router 配置

```sh
mkdir -p runtime/magpie
chmod 700 runtime/magpie
```

把下面的 JSON 保存为 `runtime/magpie/router.quickstart.local.json`。这是可编辑模板：
模型 ID、上下文窗口与输出上限需要替换，默认保持关闭。也可参考[完整四 Provider 示例](../config/subscription-router.example.json)。

```json
{
  "enabled": false,
  "gateway": {
    "baseUrl": "http://127.0.0.1:3425/v1",
    "apiKeyEnvVar": "REIN_MAGPIE_GATEWAY_KEY",
    "subscriptionOnly": true,
    "managed": {
      "binaryPath": "/absolute/path/rein-agent/.toolchain/magpie-bin/magpie",
      "homeDir": "/absolute/path/rein-agent/runtime/magpie/home",
      "allowSubscriptionAccounts": true
    }
  },
  "routes": [
    {
      "id": "general", "provider": "OpenAI",
      "gatewayModel": "chatgpt-api/example-general-model",
      "billingSource": "chatgpt-subscription-allowance",
      "billingMode": "subscription", "billingVerified": false,
      "purpose": "处理需要上下文的对话、资源检索、网页总结和无法确定复杂度的任务。",
      "effort": "medium", "contextWindow": 32768, "maxTokens": 4096
    },
    {
      "id": "quick", "provider": "Google",
      "gatewayModel": "gemini/example-flash-model",
      "billingSource": "google-subscription-allowance",
      "billingMode": "subscription", "billingVerified": false,
      "purpose": "处理简单、独立、无需历史上下文的一般问答。",
      "effort": "off", "contextWindow": 32768, "maxTokens": 4096
    },
    {
      "id": "code", "provider": "Anthropic",
      "gatewayModel": "claude/example-code-model",
      "billingSource": "claude-subscription-allowance",
      "billingMode": "subscription", "billingVerified": false,
      "purpose": "处理复杂开发、调试、代码评审及管理员指派的编码任务。",
      "effort": "high", "contextWindow": 32768, "maxTokens": 4096
    }
  ],
  "defaultRoute": "general",
  "fallbackRoutes": [],
  "allowPaidUsage": false,
  "channels": ["discord", "slack"],
  "adminSenders": [],
  "decision": {
    "allowPaidJev": false,
    "timeoutMs": 3000,
    "minProbability": 0.8,
    "maxPromptChars": 4000
  }
}
```

自动填入当前仓库的绝对路径，并保护这个本地文件：

```sh
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { magpiePaths } from './scripts/magpie-dependency.mjs';
const file = 'runtime/magpie/router.quickstart.local.json';
const config = JSON.parse(readFileSync(file, 'utf8'));
const paths = magpiePaths();
config.gateway.managed.binaryPath = paths.binary;
config.gateway.managed.homeDir = paths.homeDir;
writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
chmodSync(file, 0o600);
NODE
```

然后编辑该本地 JSON：

1. `routes[].gatewayModel` 使用 Magpie 中的精确 `provider/model` ID，填写真实模型限制和计费标签。
   提供方只是示例，`general` 可指向任意已接入的合适模型，同时更新 `provider` 与 `billingSource`。
   删除尚未连接的路由；只保留 `general` 也可以先使用 Model Router。改名时同步更新 `defaultRoute`。
2. 确认每个保留路由的计费来源与额外用量设置后，把对应 `billingVerified` 改为 `true`，最后设置
   `enabled: true`。此标记记录你的配置确认，不会自动查询 Provider 账单。
3. 保持 `allowPaidUsage: false`、`gateway.subscriptionOnly: true`，避免配置额外付费推理路由。
   仅使用 Model Router 时保持 `decision.allowPaidJev: false`，无需 Jev Key。
4. `fallbackRoutes` 默认为空。若希望**自动模式**在失败后按顺序尝试已配置路由，可改为
   `"fallbackRoutes": ["general", "code"]`；必须只写保留的路由 ID，已经尝试过的模型会跳过。
   手动选定的模型始终保持锁定。

### 4. 准备网关 Key，并生成 OpenClaw 配置片段

先停止使用同一 Magpie 私有目录的配置界面和 OpenClaw 网关：

```sh
pnpm run magpie:prepare-key runtime/magpie/router.quickstart.local.json
node scripts/subscription-config.mjs runtime/magpie/router.quickstart.local.json > runtime/magpie/openclaw-router.fragment.json
```

第一条命令创建或复用限定到这些模型的网关 Key，保存到私有 `runtime/magpie/gateway.env`。
第二条仅生成 JSON 片段。启用匹配的 managed 配置后，仓库 OpenClaw 包装器自动读取网关 Key。

备份并把片段合并到目标 `runtime/openclaw/openclaw.json`：

```sh
cp -p runtime/openclaw/openclaw.json "runtime/openclaw/openclaw.before-router.$(date +%Y%m%d-%H%M%S).json"
```

- 合并 `models.providers`、`agents.defaults.models` 和 `plugins.entries` 字典。
- 将片段的 `plugins.allow`、`plugins.load.paths` 追加到原数组并去重。
- 片段默认把对话模型设为 `rein-magpie/auto`；也可以把 `agents.defaults.model.primary` 设为
  `rein-magpie/general` 来固定默认模型。原 `model` 若是字符串，改用片段中的 `{ primary, fallbacks }` 对象。
  仅接入某个现有 Agent 时，保持全局默认模型不变，按该 profile 支持的格式设置目标 Agent 的 `model`；
  Provider 目录和插件仍需全局注册。
- 保留现有 Agent、工作区、工具权限和频道配置。保留全部 `auto` 与路由模型定义，每个 ID 只出现一次。
  使用 Rein 路由的 Agent，其生效的 `model.fallbacks` 应与 Router 的 `fallbackRoutes` 顺序一致。

Router 源 JSON 是生成器输入；实际运行读取 OpenClaw 中的 `plugins.entries.rein-router.config`。
以后修改源 JSON 后，也要重新生成、合并片段并重启。

### 5. 启动与使用

```sh
pnpm run openclaw plugins inspect rein-router --runtime --json
pnpm run openclaw plugins doctor
pnpm run openclaw gateway run
```

另开终端检查健康状态，端口使用目标 OpenClaw 配置中的值，首次本地初始化默认是 `18791`：

```sh
pnpm run openclaw gateway health --port 18791
```

OpenClaw 启动后管理 Magpie 进程。`3425` 是 Magpie 的模型网关端口，`18791` 是上述 OpenClaw 示例端口。
在原生 Slack/Discord 模型选择器中选择 `rein-magpie/general`、`rein-magpie/quick` 等模型。
隔离版 Rein Discord 沿用[现有 profile 约束](discord-user-isolation.md)，支持以下命令；
选择仅作用于当前发送者的当前受众与 session，且只能选择已保留的路由：

| 命令 | 行为 |
| --- | --- |
| `/model` | 查看当前选择和可用路由 |
| `/model general` | 固定使用 `general`，失败后也不会切到其他路由 |
| `/model quick` | 固定使用 `quick` |
| `/model code` | 固定使用高思考强度的 `code` |
| `/model auto` | 使用自动模式与显式配置的回退列表；未开启 Jev 时使用 `defaultRoute` |

需要会话路由详情时，将可选工具 `rein_route_status` 显式加入目标 Agent 的工具允许列表，
然后让 Agent 查看路由状态。它区分配置的模型/计费来源与观察到的实际服务模型。
详见[状态工具配置](unified-subscription-access.md#authentication-and-billing-evidence)。

## 二、Dynamic Router：安装、配置、使用

### 1. 启用 TypeSafe，并配置 Jev Key

先完成第一部分，停止运行中的 OpenClaw 网关。TypeSafe 源码已随固定的
`vendor/openclaw/extensions/typesafe` 提供，第一部分的构建步骤已准备对应运行环境。
它使用同版本 OpenClaw 的 decision API。详见[上游 TypeSafe 文档](../vendor/openclaw/docs/plugins/typesafe.md)。

Jev 分类调用单独计费，与模型订阅额度分开。准备 Jev API Key，通过交互提示保存到 OpenClaw Secret Store：

```sh
pnpm run openclaw secrets store set TYPESAFE_API_KEY --kind secret --allow-host api.typesafe.ai
```

Router 配置中不填写 Key 原文。若已经使用环境变量 `JEV_API_KEY`，也可在下面的 `apiKey` 位置改用
`{ source: 'env', provider: 'default', id: 'JEV_API_KEY' }`，并让启动 OpenClaw 的进程继承该变量。

### 2. 生成 Dynamic Router 配置片段

以下命令更新本地 Router 的 Jev 开关，并生成包含 `rein-router` 与 `typesafe` 的完整增量片段：

```sh
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildOpenClawFragment } from './plugins/rein-router/policy.mjs';
const file = 'runtime/magpie/router.quickstart.local.json';
const config = JSON.parse(readFileSync(file, 'utf8'));
config.decision = { ...config.decision, allowPaidJev: true };
const fragment = buildOpenClawFragment(config, resolve('plugins/rein-router'));
fragment.plugins.allow.push('typesafe');
fragment.plugins.load.paths.push(resolve('vendor/openclaw/extensions/typesafe'));
fragment.plugins.entries.typesafe = {
  enabled: true,
  config: { apiKey: { source: 'store', provider: 'default', id: 'TYPESAFE_API_KEY' } }
};
fragment.agents.defaults.decisionModel = 'typesafe/jev-latest';
writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
chmodSync(file, 0o600);
const output = 'runtime/magpie/openclaw-dynamic.fragment.json';
writeFileSync(output, JSON.stringify(fragment, null, 2) + '\n', { mode: 0o600 });
console.log('已生成 ' + output);
NODE
```

按第一部分的方法，把 `openclaw-dynamic.fragment.json` 合并到目标 OpenClaw 配置。
其中三项缺一不可：TypeSafe 已启用且凭据可用、`decisionModel` 已选择、
`rein-router.config.decision.allowPaidJev` 为 `true`。这不会打开 LLM 的 `allowPaidUsage`。

`jev-latest` 是上游别名；需要固定分类器版本时，在已验证的可用版本中选择具体 ID。
只为部分 Agent 开启时，把 `decisionModel` 配置到目标 Agent。

### 3. 配置路由策略和管理员

在 Router 源 JSON 中调整以下字段，再重新生成、合并片段：

| 字段 | 示例及作用 |
| --- | --- |
| `routes[].purpose` | 描述模型适合的任务，作为 Jev 选择依据 |
| `routes[].effort` | `off`、`low`、`medium`、`high`；需要不同强度时声明不同路由 |
| `defaultRoute` | 例如 `general`；分类不确定、不可用或附件场景的默认路由 |
| `decision.minProbability` | 默认 `0.8`；简单且无需上下文的判断也需满足阈值，才允许选择非默认的低强度路由 |
| `decision.timeoutMs` / `maxPromptChars` | 默认 `3000` 毫秒 / `4000` 字符；限制分类等待时间与输入规模 |
| `fallbackRoutes` | 推理失败后允许尝试的路由顺序；与分类不确定时使用默认模型是两件事 |

管理员编码任务需要高思考强度路由。可将下面的字段合并到 Router 源 JSON，替换为真实平台身份，
并保证至少一条路由的 `effort` 是 `high`：

```json
{
  "adminSenders": [
    { "channel": "discord", "accountId": "default", "senderId": "YOUR_DISCORD_USER_ID" },
    { "channel": "slack", "accountId": "default", "senderId": "YOUR_SLACK_USER_ID" }
  ]
}
```

只保留实际使用的条目。`accountId` 是 OpenClaw 的频道账号 ID，`senderId` 是平台用户 ID；
它们来自可信消息入口，不能用显示名或用户自称管理员代替。该设置只影响路由，不授予工具权限。

### 4. 使用与关闭动态模式

重启 OpenClaw 后，在模型选择器中选择 `rein-magpie/auto`；隔离版 Rein Discord 可使用 `/model auto`。
普通消息即可触发分类，用户无需给每条消息写模型名。手动选择具体路由会跳过 Jev 并保持锁定。

简单且独立的问答可使用 `quick`；资源检索、网页总结和需要上下文的任务使用能力较强的路由。
不确定时使用 `defaultRoute`。现有历史上下文、工具和权限检查继续由原 Agent 处理。

仅当前 session 退出自动模式：选择 `rein-magpie/general` 或在隔离版 Discord 执行 `/model general`。
关闭本 Router 的 Jev 分类：将源配置的 `decision.allowPaidJev` 改为 `false`，重新生成并合并
Model Router 片段后重启。要关闭目标 Agent 的全部 Jev 决策，将其 `decisionModel` 设为
`""`（空字符串会覆盖继承值），或禁用 TypeSafe。
关闭 Jev 后，`auto` 使用 `defaultRoute`，仍保留显式配置的推理回退。

## 升级 Magpie

按[Magpie 升级流程](magpie-upgrade-zh.md)完成停服备份、更新锁定提交、项目内构建、
兼容性回归和回滚准备。维护者通过升级 PR 跟进上游；使用者应用已合并的升级。
`magpie:setup` 只构建仓库锁定的版本，不会自动追踪上游最新版。

## 常用维护命令

| 命令 | 用途 |
| --- | --- |
| `pnpm run magpie:setup` | 构建当前锁定版本；升级前先按升级流程备份并更新版本锁定 |
| `pnpm run magpie -- version` | 查看准备好的项目内 Magpie 版本 |
| `pnpm run magpie:ui` | 打开原生 Provider 配置界面；与 managed 网关错开运行 |
| `pnpm run magpie -- --allow-subscription-accounts models` | 查看 Magpie 模型目录 |
| `pnpm run magpie -- --allow-subscription-accounts accounts` | 查看项目私有账号；刷新/重新登录使用 Magpie 原生流程 |
| `pnpm run magpie:prepare-key --replace runtime/magpie/router.quickstart.local.json` | 模型目录变更后，在网关停止状态替换项目 Key；重新生成并合并片段后重启 |
| `pnpm run openclaw plugins inspect rein-router --runtime --json` | 检查 Router 加载与注册 |
| `pnpm run openclaw plugins doctor` | 检查插件配置问题 |
| `pnpm run openclaw gateway health --port 18791` | 检查目标 OpenClaw 网关健康，按实际配置替换端口 |
| `pnpm run verify:subscriptions` | 合成 Discord 路由与工具探针，无真实 Provider 调用 |
| `pnpm run verify:subscriptions:slack` | 合成 Slack 路由与工具探针，无真实 Slack 连接 |
| `pnpm run check` | 仓库文档与配置骨架检查 |

常见问题：

- **片段生成失败**：确认源配置 `enabled: true`、每条保留路由 `billingVerified: true`、模型和路径已替换。
- **启动提示 `provider.models` 无效**：使用生成器输出的完整目录；`auto` 和每个路由 ID 都必须恰好出现一次。
- **准备 Key 提示 `existing_environment_conflict`**：已有项目 Key 的模型范围不同。
  确认需要切换模型目录后，停止网关并使用上表的 `--replace` 命令。
- **一直走默认模型**：检查当前是否选择 `auto`，以及 TypeSafe、Key、`decisionModel`、`allowPaidJev` 和频道范围；
  低置信度、需要上下文、超长输入或附件也会使用默认路由。
- **提示 profile busy / 端口被占用**：先关闭原生配置界面或同目录的网关。关闭状态无法确认时保留的锁，
  按[进程恢复说明](unified-subscription-access.md#project-local-magpie-lifecycle)检查后处理。

四 Provider 的真实账号验收及净 Token 节省仍需分别验证；本指南描述安装和配置方法。
