# Rein Agent

<img src="workspace/avatars/rein-agent.png" alt="Nori official avatar" width="192" height="192">

[English](README.md)

Rein Protocol Foundation 的组织运营 Agent：管理员、秘书与线上主持人。

帮助成员把活动想法变成真实行动：受理提案、整理材料、主持 Board 经费评选、推进筹备、收集成果、
协助发布，并让组织负责人集中处理真正需要决策的事项。

**状态：本地业务核心已实现；仅有合成开发演练，无生产接入。** 官方 OpenClaw 源码以 git submodule
形式固定在经过评审的 commit 上。Rein 插件默认提供状态、合成提案及合成投票三个只读工具；
只有在明确配置唯一平台、批准的原生频道及本地存储后才会注册四个提案工具。另有提案、治理、
活动和本地账本模块。

已确认的 P0 切片是一条 Slack 纵向流程：把 Slack 帐号关联到社群记录、提交简单的 Contributor 提案、
完成一次简单的 Board 投票并公布结果、读取资金快照。合成演练确实经由**真实 Slack 提供方**（测试工作区、
合成测试身份）与**真实 Supabase 提供方**（读写已链接的 `dev_*` 表集、行均为合成数据）跑过；未发生的是
生产使用：没有真实成员名册，未写入任何 `prod_*` 业务表，也没有生产部署。切片已落地 12 个工具，对接组织自有数据库：
只读的 `rein_member_status`、`rein_funds`、`rein_poll_candidates`、`rein_vote_type_resolve`，
只读字段采集的 `rein_proposal_collect`，写入的 `rein_governance_proposal_submit`、
`rein_poll_open`、`rein_poll_vote`、`rein_poll_result`，以及结果反馈的
`rein_proposal_comment_suggest`、`rein_revision_approve`、`rein_revision_apply`。
它们**只在显式启用 `foundationDb` 配置块时注册**，且启用后会隐藏合成模拟器与旧提案工具。

接口名称为 `rein_member_status`、`rein_funds`、`rein_poll_candidates`、`rein_vote_type_resolve`、
`rein_governance_proposal_submit`、`rein_poll_open`、`rein_poll_vote`、`rein_poll_result`、
`rein_proposal_collect`、`rein_proposal_comment_suggest`、`rein_revision_approve` 与
`rein_revision_apply`；配置块为 `foundationDb`；表为 `<env>_rein_vote_types`、`<env>_rein_proposals`、
`<env>_rein_polls`、`<env>_rein_ballots` 与 `<env>_rein_proposal_revisions`；RPC 为
`<env>_rein_finalize_poll` 与 `<env>_rein_approve_revision`。这些是 v0.1 初版名称；早期开发构建使用带阶段
前缀的工具名、阶段命名的配置块与带阶段前缀的表／RPC。稳定名称由姊妹仓库中一份已提交的向前迁移
`20260927110000_rein_governance_names.sql` 引入，排在已提交的 `20260927103000` 迁移之后。
两份迁移现均**已应用到已链接项目**（project ref `ksgyfyysnojqrwfuyqwe`，2026-09-28 只读核对）。
改名迁移的过渡兼容视图与 RPC 包装已由后续已应用迁移
`20260929045543_remove_stage_compatibility_objects.sql` 删除，因此已链接 schema 现在只以稳定
`<env>_rein_*` 名称应答。**已应用不等于代码已实机验证**：代码在真实环境上的端到端验证仍然缺位。

该切片此前的两个数据库迁移已在姊妹仓库提交，并已应用到已链接的 `BeneficenceProtocol` 项目
（2026-09-27 只读核对）。两者都在同一事务里定义 `dev_*` 与 `prod_*` 两套对象，因此已应用的 schema
覆盖两个前缀。演练证据显示工具确实读写过 `dev_*` 前缀（行为合成数据），`prod_*` 前缀始终为 0 行。
此处不主张任何生产使用或部署。

尚未接入真实成员名册、Discord、官网或生产数据集；演练只在测试 Slack 工作区与已链接的 `dev_*` 表集上运行。
实机证据取自**改名前的构建**，当前 PR head **改名后尚未在真实 Slack 重跑**。通过投票只是决策记录：
付款、预留与发布均未启用；加权投票、法定人数、回避、预算竞争、活动空间、提醒、文章与监督仍属延后项。
参见[开发与部署记录](docs/implementation-and-deployment-zh.md)。
逐项验收状态见 [P0 验收矩阵](docs/p0-acceptance-matrix.md)；十案例最终结论见
[v0.1 治理验收记录（2026-09-28）](docs/governance-acceptance-2026-09-28.md)：案例 2–10 按合成开发证据通过，
案例 1 由负责人决定跳过、**未通过**。

## 仓库结构

| 路径 | 用途 |
| --- | --- |
| `vendor/openclaw` | 官方 OpenClaw 源码（git submodule，固定在单个 commit）。属于上游，可直接使用，不要修改。 |
| `plugins/rein-operations` | Rein 功能的唯一实现位置；含确定性业务模块、三个默认只读工具、四个提案工具，以及 12 个需显式配置的数据库 Slack 工具（4 读、1 个只读字段采集、4 写、3 个结果反馈）。 |
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
- [v0.1 治理验收记录（2026-09-28）](docs/governance-acceptance-2026-09-28.md)
- [待决事项](docs/decisions.md)
- [Nori 正式头像](assets/brand/README.md)

## 协作

需求建议不等于组织政策；实现必须追溯到 PRD 的 R / US / AC 编号。参见 [贡献指南](CONTRIBUTING.md)。
许可尚未选定，当前未授予开源许可。
