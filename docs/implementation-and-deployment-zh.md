# Rein Agent 开发、验证与部署记录

## 当前交付边界

Rein Agent 继续以官方 OpenClaw 源码作为运行时，业务代码只放在 `plugins/rein-operations/`。本次交付是**可重复验证的本地业务核心与开发演练**，不是已接入真实成员和资金的 NGO 生产系统。已确认的一项：**P0 用 Slack 作为唯一聊天平台**；**过渡期内成员、董事与可用资金以组织自有数据库为准**（Foundation 站点 Supabase，隔离的 `dev_*` 与 `prod_*` 表集），Slack 帐号只有在显式关联到社群记录后才起作用。仍未确认的是：加权投票与董事权重、权威会员名册的具体来源与同步方式、可用资金来源与其责任人、网站 API、材料保存期限和异常负责人。投票形态已确认（只投赞成票、没有反对、弃权不产生赞成票、按类型候选名额与每人批准额度、赞成票最高者通过、全员弃权不产生赢家、最高票并列不宣布正式赢家），但各类型的具体数值与平票口径仍待登记。`config/operations.example.json` 保持未批准状态；空白值不能解释为授权。

**没有生产连接器验收。** 「Slack P0」与「自有数据库」是已确认的产品方向，不是已连通的集成：真实 Slack 应用与工作区尚未接入，两个迁移未提交也未应用到任何线上环境，没有任何真实聊天、数据库或资金接口的端到端证据。本文件其余部分把本地 SQL 与自动测试的结果，与真实 Slack／生产环境的验收严格分开陈述。

业务核心覆盖提案与身份资格、投票计数与资金竞争、活动跟进与成果材料的确定性规则。`ledger.ts` 为本地演练提供原子快照、操作幂等回执和审计记录。外部频道、支付和网站发布均未连接。OpenClaw 插件默认提供状态、提案模拟和投票模拟工具；四个提案工具只在明确配置后注册，且帐号只取自宿主可信上下文。治理工具桥 `governance-tool-bridge.ts` 尚未在插件入口注册，也没有已批准的实时名册与平台。任何工具参数中自称的会员身份都不能视作已认证身份。

MVP 方向已落地 9 个工具，且**只在显式 `mvp` 配置块下注册**：只读的 `rein_mvp_my_status` 与 `rein_mvp_funds`（`foundation-db-reader.ts`、`mvp-read-tools.ts`）；写入的 `rein_mvp_proposal_submit`、`rein_mvp_poll_open`、`rein_mvp_vote`、`rein_mvp_poll_result`（`foundation-db-writer.ts`、`mvp-write-tools.ts`）；以及结果反馈的 `rein_mvp_proposal_comment_suggest`、`rein_mvp_revision_approve`、`rein_mvp_revision_apply`（`mvp-feedback-tools.ts`）。启用 `mvp` 时合成模拟器与旧提案工具被隐藏；未启用时它们照旧。真实 Slack 工作区与真实数据库都尚未接入，两个迁移也尚未应用到线上。

| 代码 | 已实现内容 | 尚需接入 |
| --- | --- | --- |
| `proposals.ts` | 权威会员记录与帐号链接、Contributor 资格、提案版本与确认、完整性检查、显式授权的零预算路径、资助路由 | 真实会员名册与可信平台请求者 |
| `proposal-store.ts` | 提案状态在本地账本的事务化保存、重启恢复、幂等回执及旧版本写入拒绝 | 生产数据库、名册同步和备份迁移 |
| `proposal-tool-bridge.ts` | 可选的 OpenClaw v2 提案创建、修订、确认与提交工具；只读取宿主可信发送者及频道，在写入前复核调用有效性 | 批准的平台与频道、权威名册同步及真实聊天验收 |
| `registry-snapshot.ts` | 校验权威名册快照的版本、时效、帐号冲突和有效角色；每次查询重查时效 | 权威提供方、更新流程和组织批准的最长快照年龄 |
| `governance.ts` | 冻结轮次、资格与截止、票据替换/回避/计数、预算竞争与待分配状态 | 正式投票入口、批准的计票规则、权威可用资金 |
| `governance-store.ts` | 治理轮次本地持久化与被拒投票审计 | 生产数据库及正式计票入口 |
| `governance-tool-bridge.ts` | 使用 OpenClaw v2 可信发送者、董事频道与当前名册快照的投票/回避/轮次结果工具工厂 | 组织批准的规则、真实名册提供方与平台接入；`index.ts` 当前未注册该工具桥，且无已批准的实时名册与平台 |
| `activities.ts` | 三维状态、任务提醒、材料与渠道同意、成果审核、财务记录区分、外部效果意图与异常；任务完成后自动取消追办提醒；提醒派发必须显式配置 IANA 时区；每个活动至多一篇规范文章，文章回链是独立的 `post_article_link` 意图；资金额度调整单列为 `finance.approve_adjust` 审计事件；未决超支的恢复分四步且顺序固定：授权提高上限（`finance.approve`）→ 单独补预留（`finance.reserve`）→ 记录付款 → 结算，任一步都不能由普通结算或模型改写；未付清的承诺不允许结算 | 频道、网站、注册、财务提供方；真实可用资金核对 |
| `ledger.ts` | 单文件事务、幂等回执和本地审计；供演练的 store 端口使用 | 生产数据库、备份、迁移与访问控制 |
| `request-context.ts` | 从 OpenClaw 的可信发送者/频道上下文绑定帐号，未配置平台与频道时拒绝；提供最终写入前的调用有效性检查，以及随名册撤销实时变化的 Contributor 查询 | 选定平台、会员名册和业务工具绑定 |
| `oversight.ts` | 按范围暂停/恢复、异常去重与处理、周报、授权策略与未发出的待处理意图 | 真正的通知派发、监督界面与已批准的运营策略 |
| `changes.ts` | 活动变更分类、负责人交接与取消的确定性计划；保留待执行指令与通知意图 | 将计划以事务方式应用到活动、报名、提醒及财务记录，并投递通知 |
| `change-coordinator.ts` | 将已接受的变更中少量有明确活动核心 API 的指令交接执行，包括治理批准后的资金申请与额度记录；先记待执行标记，再记逐项结果；无法执行的指令逐项保留原因 | 跨核心原子事务、提醒/报名/负责人等完整传播、异常交接后的人工核对 |
| `outbox-runner.ts` | 外部意图的受众检查、确认闸门、按幂等键查重、未知结果恢复及提供方回执写回 | 具备幂等键语义的单平台和网站提供方；生产环境任务调度 |
| `index.ts` | 默认注册 `rein_status`、`rein_simulate_proposal`、`rein_simulate_vote`；明确配置后再注册四个提案工具；启用 `mvp` 配置块时改为注册 9 个 MVP 工具（2 读 + 4 写 + 3 个结果反馈），并隐藏合成模拟器与旧提案工具 | 活动、成果、发布与监督等完整业务工具 |
| `foundation-db-reader.ts` / `mvp-read-tools.ts` | 只读身份关联与可用资金快照，暴露 `rein_mvp_my_status`、`rein_mvp_funds` | 真实数据库连接与已审阅的迁移 |
| `foundation-db-writer.ts` / `mvp-write-tools.ts` | 提案提交、打开投票、投票与结果四个写工具；写入 `rein_mvp_proposals`、`rein_mvp_polls`、`rein_mvp_ballots`，并读取 `rein_mvp_vote_types` 取该类型的名额与批准额度 | 真实数据库连接；不产生任何付款或预留 |
| `mvp-feedback-tools.ts`（配合 `foundation-db-writer.ts` 与 `mvp-proposal-feedback.ts`） | 结果公布后的反馈三工具：`rein_mvp_proposal_comment_suggest` 记录评论或修订建议，`rein_mvp_revision_approve` 记录现任董事对重大修订的批准，`rein_mvp_revision_apply` 使已记录的修订成为生效版本；写入 `rein_mvp_proposal_revisions` 并经 `rein_mvp_approve_revision` 批准 | 真实数据库连接与真实 Slack 验收；不产生任何付款或预留 |

对 PRD R08 补充了一个实际运营中的边界：标成“零申请额”但仍要求报销的提案，应先补足金额，再进入董事评选；不能误走零预算快速通道。这一说明已同步到中英文 PRD。文章事实确认现在必须由活动负责人执行，且依赖服务端提供的 Contributor 资格查询；调用参数自称“active”不会获得发布资格。

活动核心本次还收紧了若干确定性边界：任务标记完成后，用于追办该任务的提醒自动取消（原因记为 `task_completed`），不再打扰；提醒派发在未显式配置 IANA 时区时以 `timezone_required` 拒绝，核心不提供组织默认时区；每个活动至多保留一篇规范文章，重复草稿或再次确认会被 `publication_exists` 拒绝，发布回链走独立的 `post_article_link` 意图，只在文章已发布且意图带有规范 URL 时投递到活动自己的聊天空间，文章记录本身不声称回链已送达，回执时间 `linkReturnedAt` 只在投递拿到送达回执（或对账确认）后写入，普通确认或模型输出都不会写入该时间；对已承诺资金的额度调整记入 `finance.approve_adjust` 审计事件，且不得低于已预留或已支付的金额；记录结算时若实际支出超过已记录付款则以 `unpaid_obligation` 拒绝，已记录的超支被冻结，恢复必须走相互独立、顺序固定的四步——授权提高上限（`finance.approve`）、补预留（`finance.reserve`）、记录付款、结算——任一步都不能由普通结算或模型改写。可用资金目前只在本地演练账本上核对，尚未接入真实资金来源做可用性验证。

## P0 MVP 纵向切片：范围与现状

已确认的 MVP 只包含四步：Slack 身份关联 → Contributor 简单提案 → Board 只投赞成票的简单批准投票与结果 →
只读资金快照。范围与延后项见[决策登记册](decisions.md)和 [PRD §2.3](PRD-agent-community-operations.md)。计票规则为：只投赞成票、没有反对选项、弃权等于不投赞成票、每名有资格董事权重相同、适用按类型配置的每人批准额度、赞成票最高者通过；**全员弃权不产生赢家**，**最高票并列时不宣布正式赢家，也不得私自打破平局，平票口径仍待确认**。通过投票只是决策记录，不移动资金。

| MVP 步骤 | 当前代码 | 仍缺 |
| --- | --- | --- |
| Slack 身份关联 | `registry-snapshot.ts`、`request-context.ts`，以及只读的 `foundation-db-reader.ts`（测试见 `tests/foundation-db-reader.test.mjs`） | Slack 应用、已批准的工作区与频道 ID，以及未提交、未上线（姊妹仓库 `git grep rein_mvp HEAD` 无结果）的身份关联迁移 |
| Contributor 提案 | `proposals.ts`、`proposal-store.ts`、可选的四工具提案桥，以及 MVP 模式下注册的 `rein_mvp_proposal_submit`（`mvp-write-tools.ts`） | 接入 Slack 对话，以及数据库中「有效 Contributor」的权威来源 |
| Board 批准投票与结果 | `mvp-write-tools.ts` 注册 `rein_mvp_poll_open`、`rein_mvp_vote`、`rein_mvp_poll_result`（`foundation-db-writer.ts` 为落库方，`mvp-vote-tally.ts` 为等权计票模块）；开票工具从已存投票类型取候选名额并自行组装候选池（含此前未入选的提案），投票工具只收 `approvedProposalIds`、受该轮 `maxApprovalsPerVoter` 约束、空数组即弃权，截止后由 `rein_mvp_finalize_poll` 落库结果；`governance.ts` 仍保留旧的加权轮次模型且不注册 | 按类型的具体名额与批准额度数值、已批准的投票名单与平票规则的确认；尚未经过真实 Slack 验收 |
| 只读资金快照 | `foundation-db-reader.ts` 读取只追加快照，`mvp-read-tools.ts` 在已批准的 Board 频道提供 `rein_mvp_funds` | 真实数据库连接与已审阅的快照表；对应迁移是姊妹仓库的未跟踪工作区文件，未提交、未应用到线上 |
| 结果公布后的反馈与修订（C15／D10／D11） | `mvp-feedback-tools.ts` 注册 `rein_mvp_proposal_comment_suggest`、`rein_mvp_revision_approve`、`rein_mvp_revision_apply`，写入 `rein_mvp_proposal_revisions` 并经 `rein_mvp_approve_revision` 批准；只改标题或摘要的普通修订由 Agent 自行接受并生效，重大修订（预算、地点、日程、人员、活动主流程）在记录到现任董事批准前被 `revision_not_approved` 拒绝 | 真实数据库连接与真实 Slack 验收；是否允许有效 Contributor 作为反馈作者仍待确认（数据库行允许，注册工具要求现任董事） |

启用 `mvp` 配置块时注册 9 个工具：2 个只读（`rein_mvp_my_status`、`rein_mvp_funds`）、4 个写入（`rein_mvp_proposal_submit`、`rein_mvp_poll_open`、`rein_mvp_vote`、`rein_mvp_poll_result`）与 3 个结果反馈工具（`rein_mvp_proposal_comment_suggest`、`rein_mvp_revision_approve`、`rein_mvp_revision_apply`），同时隐藏合成模拟器与旧提案工具；未显式启用时不注册 MVP 工具。所有工具都用服务端密钥经 PostgREST 访问数据库，不向 Slack 主动发消息，也从不回显密钥、Supabase 地址、团队 ID 或私密联系人标识。

**结果公布后的修订规则（C15／D10／D11），两侧分界明确。** 只改**标题或摘要**的修订属于普通修订：Agent 可以接受其中合理的建议，并在调用方所在的回合里用 `rein_mvp_revision_apply` 直接使其生效，**不需要**另行取得 Board 批准，也没有第二条批准 RPC。涉及**预算、地点、日程、人员或活动主流程**的修订属于重大修订：在记录到现任董事的批准（`rein_mvp_revision_approve`，数据库侧为 `rein_mvp_approve_revision`）之前，写入层与数据库触发器都会以 `revision_not_approved` 拒绝生效。当前实现把 `schedule` 视为重大字段，因此**日期或时间的承诺变更走重大闸门**。工具层把三个反馈调用都限制在已批准的 Board 频道，并要求发送者本人的社群记录当前是董事（投票人即 Board）；数据库行另外允许**有效 Contributor** 作为修订作者（`author_contact_id`），这是数据库层的放宽，当前注册的工具并未开放。评论只记录文本、不改提案版本。任何修订都不移动、不预留、不支付资金。


**候选池由 Agent 组装，但开票仍由人发起。** `rein_mvp_poll_open` 由已批准 Board 频道里的现任董事按**投票类型**开一轮：工具读该类型自己的 `max_candidates`，再调用 `listCandidateProposals` 从库里组装候选池（同一类型的 `submitted`／`unselected` 提案，`unselected` 的近期提案优先重新列出），由数据库冻结候选名单与两个上限。调用方**不能**再提交候选列表、名额或选项名——`options`、`candidateIds`、`maxApprovalsPerVoter` 等参数会被 `policy_argument_rejected` 拒绝，`options` 走写入层还会得到 `legacy_options_unsupported`。因此 C14/D08 的「近期提案 + 此前未入选提案」组装与按类型候选名额已有注册代码路径。

仍有两项未落地：**具体名额与批准额度数值**是运维配置（Events 示例为 10 属示例值，不是全局固定政策），需由人写入 `rein_mvp_vote_types`；**目前也没有「据某条提案自动开票」的入口**——轮次由董事选类型发起，而不是由提案触发，提案与投票之间没有外键，`rein_mvp_proposal_submit` 与 `rein_mvp_poll_open` 仍是两次独立写入。

结果在**截止时间之前只是临时读数**：截止前 `rein_mvp_poll_result` 只报告 `closed = false`、`status = 'provisional'`、`official = false`，不给任何计数与赢家；到点后由 `rein_mvp_finalize_poll` 按已入库选票计数并落库结果。结果只读取数据库已接受的选票，不按今天的名单重算资格；被拒绝的票不写库。**结果只返回当前调用，不会自动回帖到 Slack。**

**两条边界必须分开。** 一轮由数据库在截止时决定，不由调用方决定：截止前 `rein_mvp_poll_result` 返回 `status = 'provisional'`、`ok = false`、`official = false`，只给出该轮可读事实（`closed = false`、`closesAt`、已入库票数），**不给任何计数与赢家**；到点后工具提交 `rein_mvp_finalize_poll`，由数据库关闭该轮并落库结果。全员弃权（没有任何候选人得到赞成票）时，按已确认规则落库 `outcome = 'no_winner'`、`winner = null`。最高赞成票并列时同样落库 `outcome = 'no_winner'`、`winner = null`，与全员弃权共用同一个「无赢家」结果，`approvals` 照实返回各候选人得票，便于 Board 自读记录。平票口径是**尚未确认的规则**：在确认前不得对外宣布为组织正式规则，也不得私自打破平局。

**重放保护是有限的。** 提案与投票标识是运行时为单轮对话创建工具上下文时，为每个 `(toolCallId, action)` 对新建的随机 UUID，并在该上下文内记忆化；因此**同一轮对话内** `execute` 重试会命中同一行并被报为 exact duplicate，而记忆化不跨上下文。但工具调用 ID 不是可信入站消息 ID：Slack 事件被重新投递、或在新一轮里重试，都会生成新标识并写入第二条记录。跨进程的 exactly-once 需要可信的宿主事件 ID，目前不能声称已经具备。

一个部署只服务一个 Slack 工作区：在频道策略允许的前提下，频道／群组消息与私聊一样会带来可信的逐消息发送者（`requesterSenderId`），因此频道消息并不比私聊更弱；但 v2 工具上下文不携带 Slack 团队／工作区 ID，团队必须由配置固定，把同一部署指向多个工作区会让发送者对应到错误的社群记录。

加权投票、参与门槛与法定人数、回避、预算竞争与排序、付款与结算、活动空间与提醒、成果与文章、官网发布、监督与周报、第二平台与链上迁移都保持延后；相关本地模块继续不注册。已延后的单元不应被描述成 MVP 的一部分。

## MVP Slack Socket Mode 部署手册（单工作区）

以下步骤把 MVP 切片接到**一个** Slack 沙盒工作区与一个隔离数据库。每一步都需要人执行并复核；Agent 不参与建表、播种、建应用或写入凭据。全部完成前不要指向生产数据，也不要把任何真实成员资料或凭据写入仓库。

1. **准备官方 Slack 插件与 Socket Mode。** 使用 `vendor/openclaw` 里随固定提交一起发布的官方 `slack` 插件，走 Socket Mode，不需要公网回调地址。在 Slack 侧创建应用、启用 Socket Mode、安装到唯一的目标工作区，并把 Bot 邀请进已批准的提案频道与 Board 频道。官方插件按 `mode: socket` 解析凭据：Socket Mode 需要 bot token 与 app-level token；签名密钥只在 HTTP 模式下才需要。
2. **只放服务端环境变量引用。** 凭据只通过服务端环境变量或运行时自带的密钥存储注入，配置里只写变量名。仓库中不得出现任何令牌、签名密钥或工作区 ID；`scripts/check.mjs` 也会拒绝在插件文件里出现形如 JWT 或 `sb_secret_` 的字面量。工作区 ID 不是密钥，但同样不进仓库：它写进部署侧配置。
3. **数据库迁移由人执行。** 先在隔离库的 `dev_*` 表集按文件名顺序应用姊妹仓库的两个迁移，并复核结果：
   - `20260924094436_rein_slack_identity_and_fund_snapshots.sql`：身份关联表与只追加的可用资金快照表。
   - `20260924095705_rein_mvp_proposals_polls_ballots.sql`：提案、投票、选票三张表，投票类型表 `rein_mvp_vote_types`（含 `max_candidates` 与 `max_approvals_per_voter`）、修订记录表 `rein_mvp_proposal_revisions` 与 `effective_revision_id` 列，以及冻结候选名单、按当前董事校验选票、`rein_mvp_finalize_poll` 计票与 `rein_mvp_approve_revision` 重大修订批准的触发器与 RPC。
   两者都**尚未提交**（姊妹仓库中为未跟踪文件）且**尚未应用**到线上；`prod_*` 表集要另做一次独立决定后再执行，不要用同一条自动化脚本顺带跑完。迁移不含具体的名额／批准额度数值：`rein_mvp_vote_types` 的行由人播种，结果由 RPC 在截止时按已存选票计算，不含政策默认值。
4. **播种也由人做。** 身份关联、Contributor 的 `active` 状态、董事的 `person_type`、第一条可用资金快照，以及每个提案类型在 `rein_mvp_vote_types` 中的 `max_candidates` 与 `max_approvals_per_voter` 都由人直接写库或走已复核的管理路径；Agent 不会创建这些记录，也不提供注册工具。具体名额与批准额度属运维配置，须组织批准后再写入；不要往真实环境灌入虚构人员。
5. **记录已批准的频道 ID 与那一个工作区。** 提案频道与 Board 频道的原生 Slack 频道 ID 都要事先批准并写进配置；`slackTeamId` 必须正好是被服务的那个工作区。一个部署只服务一个工作区，因为 v2 工具上下文不带团队 ID；把同一部署指向多个工作区会让发送者匹配到错误的社群记录。
6. **显式启用 `mvp` 配置块。** 在隔离网关的 `runtime/openclaw/openclaw.json` 中，为 `plugins.entries.rein-operations.config` 增加 `mvp` 对象，字段为 `enabled`、`platform: "slack"`、`slackTeamId`、`environment`（`dev` 或 `prod`，无隐式默认）、`proposalChannelIds`、`boardChannelIds`、`supabaseUrlEnvVar` 与 `supabaseServiceKeyEnvVar`。未设置 `enabled: true` 时 9 个 MVP 工具都不注册。
7. **先验后接。** 依次运行 `npm run toolchain:pnpm -- run check`、`npm run toolchain:pnpm -- test`、`npm run toolchain:pnpm -- run verify:plugin`，再用 `npm run toolchain:pnpm -- openclaw plugins doctor`，以及 `npm run toolchain:pnpm -- openclaw plugins inspect rein-operations --runtime --json` 确认实际注册的是这 9 个 MVP 工具、且合成模拟器与旧提案工具已隐藏。用 `docs/agent-test-cases-zh.md` 的十个合成案例（另见结果反馈补充案例）逐条演练，并保留发送者 ID、工具调用 ID 与数据库记录。

**没有任何自动付款。** 通过投票只是决策记录：不预留、不付款、不改动资金快照。付款、报销与结算始终由有权限的人在 Agent 之外完成；预算竞争与分配金额不在 MVP 内。

## 部署到本地隔离环境

1. 获取仓库和官方运行时：

   ```sh
   git clone --recurse-submodules https://github.com/tempest2023/rein-agent.git
   cd rein-agent
   node --version # 环境需要 >=24.16.0 <25 或 >=26.1.0；命令本身交由本地工具链执行
   npm run toolchain:pnpm -- --version # 12.4.2
   npm run toolchain:pnpm -- exec node -v # 期望 v24.16.x
   ```

2. 安装与构建：

   ```sh
   npm run toolchain:pnpm -- install
   npm run toolchain:pnpm -- --dir vendor/openclaw install --frozen-lockfile
   npm run toolchain:pnpm -- --dir vendor/openclaw build
   npm run toolchain:pnpm -- run setup:local
   ```

`setup:local` 只创建 `runtime/openclaw/openclaw.json`，绑定本机回环地址并生成网关令牌。该目录被 Git 忽略；不要复制到共享仓库。

`npm run toolchain:pnpm -- <参数>` 会把 `--` 之后的所有参数转交给仓库内固定的本地工具链 pnpm（`package.json` 中的 `toolchain:pnpm`），因此无需 `export PATH`。`-- install`、`-- --dir vendor/openclaw install` 直接抵达 pnpm；`-- run <脚本>`、`-- test`、`-- openclaw <参数>` 则通过工具链自带的 Node 执行，即使系统里的 `node` 版本偏旧也可用。`--` 后不写参数时打印 pnpm 自身的帮助。若确实要把工具链放进 `PATH`，可在该终端执行一次 `export PATH="$PWD/.toolchain/node_modules/.bin:$PATH"`，之后 `pnpm run check`、`pnpm test`、`pnpm openclaw ...` 与上面的包装形式等价。未使用包装也不导出 `PATH` 时，请确认环境里的 pnpm 恰好是 `12.4.2` 且 Node 在受支持范围内。

3. 验证和启动：

   ```sh
   npm run toolchain:pnpm -- run check
   npm run toolchain:pnpm -- test
   npm run toolchain:pnpm -- run verify:plugin
   npm run toolchain:pnpm -- run verify:proposal-tools
   npm run toolchain:pnpm -- openclaw plugins list --verbose
   npm run toolchain:pnpm -- openclaw plugins inspect rein-operations --runtime --json
   npm run toolchain:pnpm -- openclaw gateway run
   ```

   另开终端执行 `npm run toolchain:pnpm -- openclaw gateway health --port 18791`（未鉴权就绪探测）与 `npm run toolchain:pnpm -- run smoke:gateway`。该调用只检查隔离网关的状态工具，不会创建活动、频道或文章。

4. 真正试点前，需在 `docs/decisions.md` 记录批准人、政策版本、生效时间及一个聊天平台。接入该平台的可信帐号 ID 与权威会员记录、资金来源和网站服务后，再实现并测试相应适配器。对外工具必须在写入前按真实请求者、资源和受众重新鉴权。合成测试通过不等于真实适配器可用。

   提供方须满足[聊天、身份、资金与网站接口契约](integration-contracts.md)，尤其要支持超时后的按幂等键查询和明确的权限范围。

   若仅试运行提案工具，在隔离网关的 `runtime/openclaw/openclaw.json` 中，对 `plugins.entries.rein-operations.config` 添加下列对象，并把值替换为**已批准**的唯一平台、原生频道 ID 和本地绝对路径：

   ```json
   {
     "proposalTools": {
       "enabled": true,
       "platform": "discord",
       "allowedNativeChannelIds": ["APPROVED_NATIVE_PROPOSAL_CHANNEL_ID"],
       "statePath": "/ABSOLUTE/PATH/TO/runtime/rein-proposals.json"
     }
   }
   ```

   `discord` 仅示意配置格式，并非组织已选择的平台；也可填 `slack`，P0 只能启用一个。未明确设置 `enabled: true` 时四个提案业务工具不注册。当前插件尚未连接权威名册提供方，因此即使启用这四个工具，正式确认与提交也会返回 `authoritative_registry_required`；草稿与修订可用于隔离试运行。测试中的合成名册授权回调不能用于生产。当前工具调用 ID 只保证同一次调用重试的幂等，无法代替可信入站消息 ID 的跨调用唯一性验收。

   若要试运行 MVP 切片，请改用同一个配置文件里的 `mvp` 块（完整步骤见上面的部署手册）：`enabled`、`platform: "slack"`、`slackTeamId`、`environment`（`dev` 或 `prod`，无隐式默认）、`proposalChannelIds`、`boardChannelIds`、`supabaseUrlEnvVar` 与 `supabaseServiceKeyEnvVar`。Supabase 地址与密钥只从服务端环境变量读取，绝不写入配置；启用 `mvp` 后注册 9 个 MVP 工具（含写入与结果反馈），并隐藏合成模拟器与旧提案工具。`slackTeamId` 必须是被服务的那一个工作区；两个迁移尚未提交、据报告也未应用到线上，因此目前只能对着隔离数据库演练，不要指向生产数据。

## 十个 Agent 演练案例

这些案例已改写为 **MVP Slack 场景**，使用**合成帐号、虚构频道与虚构活动**。它们是当前可执行的证据形式：模块级自动测试加上隔离环境的合成演练。**在接入真实 Slack 工作区与隔离数据库之前，每一例都只算合成演练，不能当作上线验收。**

逐步消息、准备数据、预期数据库记录与真实提供方证据见 [十个 MVP 验收案例](agent-test-cases-zh.md)。

| # | MVP Slack 场景 | 必须观察的结果 | 对应验收 |
| --- | --- | --- | --- |
| 1 | 未链接的成员想在提案频道提交读书会提案 | 返回 `identity_not_linked`；不写提案表；参数里自称的会员 ID 与角色一律无效 | AC01 |
| 2 | 有效 Contributor 在提案频道提交零预算提案 | 提案表新增一行且关联本人联系人；返回稳定标识，同一次调用重试指向同一行 | AC02 |
| 3 | 已关联但 Contributor 状态为 `inactive` 的成员申请 165 美元 | 无资格被拒；不写提案表；Agent 不自批、不预留、不付款 | AC01、AC04 |
| 4 | 非董事在提案频道尝试打开投票；董事在 Board 频道尝试 | 非董事与错误频道都在写库前被拒；只有当前董事可在已批准 Board 频道开票 | AC16 |
| 5 | 单个候选 `A` 的一轮：两名董事投 `A`，一名董事弃权 | 三张票落库；空批准数组即弃权，不贡献赞成票；只有一个候选的一轮同样有效；开票名额来自该轮投票类型，每人上限为该轮 `maxApprovalsPerVoter` | AC07 |
| 6 | 分别查询一个最高票并列的投票与一个全员弃权的投票 | 两者截止后都落库 **`outcome = 'no_winner'`**、`winner = null`；都不能被读成“通过”；再次读取已关闭轮次会回放该轮已落库的结果（`repeated = true`），不重新计票 | AC07 |
| 7 | 董事在截止时间之后投票 | 返回 `poll_closed`；不写选票表；截止前查询返回 `provisional`、`official = false`，不给计数与赢家 | AC06 |
| 8 | 重复提交同一提案、重放同一张票、再改动批准集合 | 提案重试返回同一记录；相同 `approvedProposalIds` 重放视为同一票；改动后的批准集合被拒（`replaced = false`），不覆盖 | AC17 |
| 9 | 董事在 Board 频道查询一个没有任何快照的币种 | 明确报“未知”，不显示 0、不推断余额；读取方不占用、不预留、不付款 | AC15 |
| 10 | 有人要求 Agent 依据已通过的投票直接付款并预留资金 | 明确拒绝：通过只是决策记录；不预留、不付款、不改动资金快照、不产生财务记录 | AC04、AC08、AC15 |

结果公布后的反馈与修订单列为[补充案例 R1](agent-test-cases-zh.md)，不与上面十个主要案例合并编号。

## 验证口径与未完成项

2026-09-24 本地验证基于官方 OpenClaw 固定提交 `4a11f89e840b2bb3eedcad2820ab25b8520905b6`、Node 24.16.0 和 pnpm 12.4.2。下表记录当时使用已配置本地工具链 `PATH` 的原始命令；上方无须导出 `PATH` 的封装命令是后续日常运行方式。封装形式本轮单独验证了 `check`，其余历史结果不冒充封装命令的实测结果：

| 命令 | 结果 |
| --- | --- |
| `pnpm run check` | 通过，检查结构、未批准配置、PRD 哈希、插件工具清单与 `mvp` 配置模式约束 |
| `pnpm test` | 通过，退出码 0：完整套件 618 项全部通过、失败 0。其中结果反馈 `mvp-feedback-tools` 34/34（普通修订由 Agent 接受生效、重大修订在记录到现任董事批准前以 `revision_not_approved` 拒绝）、`mvp-rehearsal` 4/4、`mvp-vote-tally` 19/19、`foundation-db-writer` 196/196。已关闭轮次的回放缺陷修复已落地，`rein_mvp_poll_result` 对已关闭轮次返回该轮已落库的结果并标记 `repeated` |
| `pnpm run verify:plugin` | 通过，退出码 0。这是**加载器级**验证，不是真实平台验收：真实 OpenClaw loader 在默认未启用配置下导入三个只读工具；并在临时隔离配置下确认 9 个 MVP 工具（读写与结果反馈）注册、合成模拟器与旧提案工具已隐藏，且密钥不出现在加载器输出中。它只证明工具注册与插件加载正确，不证明任何 Slack 工作区、数据库或提供方连通 |
| `pnpm run verify:proposal-tools` | 通过，退出码 0。同为**加载器级**验证：真实 OpenClaw loader 在临时隔离配置下注册四个 v2 提案工具；未连接真实平台 |
| `pnpm --dir plugins/rein-operations pack --dry-run` | 通过，退出码 0：打包清单包含 `mvp-feedback-tools.ts` 与 `mvp-proposal-feedback.ts`，即结果反馈模块确实随包发布，而非只存在于工作区 |
| `pnpm run smoke:gateway` | 通过，隔离网关经认证调用 `rein_status` |
| `git -C vendor/openclaw status --porcelain` | 无修改 |

`npm run toolchain:pnpm -- run smoke:gateway` 需要等待网关输出 `ready` 后执行；启动期间连接被拒绝不代表工具失败。上述结果未覆盖真实聊天、网站或资金接口。`tests/p0-rehearsal.test.mjs` 将两个活动流程跨模块串联；它以待处理外部意图而非假造的频道或文章收尾。


AC09、AC14 的外部频道/网站唯一性、AC16 的真实频道私密隔离，以及 AC20 的两条端到端真实流程，需要选定平台和提供方契约后验证；目前不能标为通过。支付、签名、提升会员身份和权重始终由有权限的人与独立流程处理。

投递器是可注入提供方的本地模块，不会自行连上真实平台。跨进程同时处理同一意图时，仍须由提供方按 Rein 幂等键保证唯一性；核心回执接口校验标识、键和文章链接，但无法自行验证提供方真实性。变更协调器能执行活动取消、暂停等少量有核心 API 的动作；报名页、提醒、负责人权限及财务复核仍被明确保留，无法声称已传播。跨核心事务被中断时，待执行标记维持“结果不明”供人工核对，因此 AC11 仍需完整执行器和真实提供方验收。

上表是一次 2026-09-24 的记录，不是持续保证；MVP 工具尚无真实数据库端到端证据，也尚未经过 Slack 应用验收。

完整的逐项证据与尚缺验收见 [AC01–AC20 验收矩阵](p0-acceptance-matrix.md)。
