# Rein Agent

Rein Protocol Foundation 的组织运营 Agent：管理员、秘书与线上主持人。

帮助成员把活动想法变成真实行动：受理提案、整理材料、主持 Board 经费评选、推进筹备、收集成果、协助发布，并让组织负责人集中处理真正需要决策的事项。

**状态：初始化 / 开发前准备。** 已确定采用 OpenClaw；此仓库提供工作区模板、双语需求与实施计划。尚未接入 Slack、Discord、官网或真实成员数据，尚未实现投票、持久化和自动发布。

## 产品与设计

- [中文 PRD](docs/PRD-agent-community-operations-zh.md) · [English PRD](docs/PRD-agent-community-operations.md)
- [组织使命与治理蓝图（源项目快照）](PROJECT.md)
- [文档来源与上下文](docs/provenance.md)
- [架构与集成边界](docs/architecture.md)
- [P0 实施与验收清单](docs/roadmap.md)
- [部署准备](docs/setup.md) · [待决事项](docs/decisions.md)
- [角色形象设计](assets/brand/README.md)

## 三种工作角色

| 角色 | 工作 |
| --- | --- |
| 管理员 | 核验身份、追踪活动与权限、维护异常和审计记录 |
| 秘书 | 整理提案、议程、任务与成果；提醒缺项；生成运营周报 |
| 线上主持人 | 按已授权规则介绍提案、开启与关闭投票、解释结果与下一步 |

Agent 不替 Board 作资源分配决定，不执行真实付款，不自动授予身份；线下活动仍由人负责。

## 本地开始

```sh
git clone https://github.com/tempest2023/rein-agent.git
cd rein-agent
node scripts/check.mjs
```

需要 Node.js 22 或更新版本进行仓库检查，无 npm 依赖。检查通过只代表文档与模板结构完整，不代表可上线。

`workspace/` 是可用于 OpenClaw 的 Agent 工作区模板。连接运行时之前，完成 [部署准备](docs/setup.md)。`config/operations.example.json` 是拟定的业务配置结构，**不是 OpenClaw 原生配置，也尚无执行器加载它**。治理参数留空，未经明确授权不启动真实业务。

## P0 闭环

Contributor 提案 → 信息确认与评估 → 零预算授权快速通道 / Board 经费评选 → 活动空间与筹备 → 人执行 → 成果验收 → 已授权官网发布与结算记录。

活动状态、资金状态和发布状态独立保存。第二聊天平台、社交媒体图文与 DAO 接入属于后续阶段。

## 协作

需求建议不等于组织政策；实现必须追溯到 PRD 的 R / US / AC 编号。参见 [贡献指南](CONTRIBUTING.md)。许可尚未选定，当前未授予开源许可。
