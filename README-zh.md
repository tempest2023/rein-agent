# Rein Agent

<img src="workspace/avatars/rein-agent.png" alt="Rein Agent Bot Icon" width="192" height="192">

[English](README.md)

Rein Protocol Foundation 的组织运营 Agent：管理员、秘书与线上主持人。

帮助成员把活动想法变成真实行动：受理提案、整理材料、主持 Board 经费评选、推进筹备、收集成果、
协助发布，并让组织负责人集中处理真正需要决策的事项。

**状态：本地业务核心已实现，尚未接入线上系统。** 官方 OpenClaw 源码以 git submodule
形式固定在经过评审的 commit 上。Rein 插件默认提供状态、合成提案及合成投票三个只读工具；
只有在明确配置唯一平台、批准的原生频道及本地存储后才会注册四个提案工具。另有提案、治理、
活动和本地账本模块。

已确认的 P0 MVP 是一条 Slack 纵向切片：把 Slack 帐号关联到社群记录、提交简单的 Contributor 提案、
完成一次简单的 Board 投票并公布结果、读取资金快照。切片已落地 6 个工具，对接组织自有数据库：
`rein_mvp_my_status` 与 `rein_mvp_funds` 只读，`rein_mvp_proposal_submit`、`rein_mvp_poll_open`、
`rein_mvp_vote`、`rein_mvp_poll_result` 会写入提案、投票与选票。它们**只在显式启用 `mvp` 配置块时注册**，
且启用后会隐藏合成模拟器与旧提案工具。该切片对应的两个数据库迁移目前只存在于姊妹仓库本地，
均未应用到线上环境。

尚未接入任何 Slack 工作区、Discord、官网或真实成员数据，也尚未连上真实数据库。通过投票只是决策记录：
付款、预留与发布均未启用；加权投票、法定人数、回避、预算竞争、活动空间、提醒、文章与监督仍属延后项。
参见[开发与部署记录](docs/implementation-and-deployment-zh.md)。
逐项验收状态见 [P0 验收矩阵](docs/p0-acceptance-matrix.md)。

## 仓库结构

| 路径 | 用途 |
| --- | --- |
| `vendor/openclaw` | 官方 OpenClaw 源码（git submodule，固定在单个 commit）。属于上游，可直接使用，不要修改。 |
| `plugins/rein-operations` | Rein 功能的唯一实现位置；含确定性业务模块、三个默认只读工具、四个提案工具，以及 6 个需显式配置的 MVP Slack 工具（2 读 4 写）。 |
| `workspace/` | 与 OpenClaw 兼容的 Agent 工作区模板：身份、策略与头像。 |
| `config/operations.example.json` | 拟定的业务配置。它不是 OpenClaw 原生配置，也没有任何执行器加载它。 |
| `scripts/` | 本地初始化、CLI 包装与上游更新脚本。 |
| `tests/` | 使用 Node test runner 的插件边界与更新脚本检查。 |
| `docs/` | PRD、架构、决策登记、部署与上游更新手册。 |

## 插件优先的开发规则

Rein 的功能全部以 Rein 自有插件的形式放在 `plugins/` 下，通过官方插件 SDK 与 manifest 加载。
`vendor/openclaw` 与上游保持完全一致，因此升级只需评审并推进 submodule 指针。任何 Rein 提交都不得
修改 `vendor/openclaw/src/` 或 `vendor/openclaw/extensions/` 中被跟踪的文件，CI 会在出现改动时失败。

`config/operations.example.json` 只是设计输入，不构成运行时约束；治理参数留空，未经明确授权不启动
真实业务。

## 环境要求

- Node.js `>=24.16.0 <25` 或 `>=26.1.0`（推荐 Node 26），与上游 `engines` 一致。
- pnpm `12.4.2`，由 `package.json` 的 `packageManager` 固定；执行 `corepack enable` 即会使用该版本。
- 支持 submodule 的 git。

本工作副本中可能已安装被 git 忽略的本地工具链，可同时满足以上两项：

```sh
export PATH="$PWD/.toolchain/node_modules/.bin:$PATH"
```

## 快速开始

```sh
git clone --recurse-submodules https://github.com/tempest2023/rein-agent.git
cd rein-agent
pnpm install                                        # 仅安装 Rein workspace 包
pnpm --dir vendor/openclaw install --frozen-lockfile
pnpm --dir vendor/openclaw build
pnpm run setup:local                                # 生成隔离的本地网关配置
pnpm run check
pnpm test
pnpm openclaw plugins inspect rein-operations --runtime --json
```

若仓库已克隆但未带 submodule，先执行 `git submodule update --init --recursive`。
`pnpm run setup:local` 会在 `runtime/openclaw/openclaw.json`（已被 git 忽略，权限 0600）写入隔离配置：
随机生成的网关 token、仅回环地址的 18791 端口、指向本仓库 `workspace/` 的工作区，并启用
`rein-operations` 插件。聊天平台与模型保持未配置。完整步骤见 [部署准备](docs/setup.md)，更新与回滚
见 [更新 OpenClaw](docs/upstream.md)。

## 三种工作角色

| 角色 | 工作 |
| --- | --- |
| 管理员 | 核验身份、追踪活动与权限、维护异常和审计记录 |
| 秘书 | 整理提案、议程、任务与成果；提醒缺项；生成运营周报 |
| 线上主持人 | 按已授权规则介绍提案、开启与关闭投票、解释结果与下一步 |

Agent 不替 Board 作资源分配决定，不执行真实付款，不自动授予身份；线下活动仍由人负责。

## P0 闭环

Contributor 提案 → 信息确认与评估 → 零预算授权快速通道 / Board 经费评选 → 活动空间与筹备 → 人执行 →
成果验收 → 已授权官网发布与结算记录。

活动状态、资金状态和发布状态独立保存。第二聊天平台、社交媒体图文与 DAO 接入属于后续阶段。

## 产品与设计

- [中文 PRD](docs/PRD-agent-community-operations-zh.md) · [English PRD](docs/PRD-agent-community-operations.md)
- [组织使命与治理蓝图（源项目快照）](PROJECT.md)
- [文档来源与上下文](docs/provenance.md)
- [架构与集成边界](docs/architecture.md)
- [部署准备](docs/setup.md)
- [更新 OpenClaw](docs/upstream.md)
- [P0 实施与验收清单](docs/roadmap.md)
- [待决事项](docs/decisions.md)
- [正式 Bot Icon 与设计历史](assets/brand/README.md)

## 协作

需求建议不等于组织政策；实现必须追溯到 PRD 的 R / US / AC 编号。参见 [贡献指南](CONTRIBUTING.md)。
许可尚未选定，当前未授予开源许可。
