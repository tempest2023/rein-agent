# Rein Agent MVP 十个 Slack 验收案例

这些案例对应**已确认的 MVP 纵向切片**：Slack 身份关联 → Contributor 提案 → Board 只投赞成票的批准投票与结果 → 只读资金快照。范围与延后项见[决策登记册](decisions.md)，逐项证据见 [AC01–AC20 验收矩阵](p0-acceptance-matrix.md)。

**当前一律为合成演练。** 所有帐号、团队、频道、提案、金额与投票都是虚构数据；尚未接入真实 Slack 工作区，也尚未把任何数据库迁移应用到线上环境。任何一条案例都不构成真实上线验收，只有连上沙盒工作区与隔离数据库、并留下提供方证据之后，才可以逐条改判。

**规则已确认，且已有注册代码路径。** Board 投票只投赞成票、没有反对选项；弃权（空批准数组）等于不投任何赞成票；每名有资格董事权重相同；每个提案类型各有候选名额上限与每人批准额度；赞成票最高者通过，全员弃权不产生赢家，最高票并列时不宣布正式赢家。开票工具 `rein_mvp_poll_open` 从已存投票类型取名额并自行组装候选池（含此前未入选的提案），投票工具 `rein_mvp_vote` 只收 `approvedProposalIds` 并受该轮 `maxApprovalsPerVoter` 约束，截止后由 `rein_mvp_finalize_poll` 落库结果。按类型的具体名额与批准额度数值仍是运维配置，尚未批准。

## 前置条件

- 一个 Slack 沙盒工作区，Socket Mode，官方 OpenClaw `slack` 插件；一个部署只服务这一个工作区。
- 真实演练前，需由人执行并复核姊妹仓库的迁移：`20260924094436_rein_slack_identity_and_fund_snapshots.sql` 与 `20260924095705_rein_mvp_proposals_polls_ballots.sql`。两者目前都是**未跟踪的工作区文件**（姊妹仓库 `git grep rein_mvp HEAD` 无结果，即均未提交），也**均未应用到任何线上环境**。第二阶段迁移现已包含投票类型、只投赞成票的选票形状、冻结候选名单、finalize RPC 与重大修订批准规则，但作为未提交内容，**不得据此声称 schema 已在线验证**。按类型的具体名额与批准额度需由人写入 `rein_mvp_vote_types`。
- 明确批准的频道 ID：提案频道与 Board 频道。启用 `mvp` 配置块后才注册 9 个 MVP 工具（2 读、4 写、3 个结果反馈）；未启用时一个都不注册。
- 数据播种由人完成：身份关联、Contributor 状态、董事身份与资金快照都直接写库，Agent 不会创建这些记录。
- 每轮记录：入站事件的发送者 ID、工具调用 ID、Agent 回复、数据库记录与拒绝原因。所有拒绝都走固定原因码，且不返回 Supabase 地址、密钥、团队 ID 或私密联系人标识。
- **Agent 不自动回帖。** 当前工具只把结果返回到调用它的那一轮；把结果回帖到 Slack 的消息发送尚未实现，因此案例中只核对工具返回，不核对频道回帖。

## 预期数据库记录速查

| 数据库对象 | 何时新增 |
| --- | --- |
| `<env>_rein_slack_links` | 由人播种身份关联；Agent 只读，不写入 |
| `<env>_rein_mvp_proposals` | `rein_mvp_proposal_submit` 成功时新增一行；同一轮对话里的同一调用重试不新增第二行 |
| `<env>_rein_mvp_polls` | `rein_mvp_poll_open` 成功时新增一行，候选名单与窗口就此固定；`candidate_limit` 与 `max_approvals_per_voter` 由数据库从投票类型冻结，不由调用方给出 |
| `<env>_rein_mvp_ballots` | `rein_mvp_vote` 成功时新增一行，`approved_proposal_ids` 为该人批准的候选人（可多个，空数组即弃权）；`(poll_id, voter_contact_id)` 唯一，因此同一投票同一人改投会被拒 |
| `<env>_rein_mvp_vote_types` | 由人播种：每个提案类型的 `max_candidates` 与 `max_approvals_per_voter`；Agent 只读，不写入 |
| `<env>_rein_mvp_proposal_revisions` | 结果公布后的评论或修订；只改标题或摘要的普通修订由 Agent 接受并生效，重大字段（预算、地点、日程、人员、主流程）须先经 `rein_mvp_approve_revision` 由现任董事批准才能生效 |
| `<env>_rein_fund_snapshots` | 只由人录入；Agent 只读，且表为只追加 |

数据库本身也会拒绝几类写入，不能只靠工具层把关：选票里的每个批准项必须命中该投票冻结的候选名单，且不得重复、不得超过该轮 `max_approvals_per_voter`；投票一旦有选票，候选名单与窗口就被冻结；`candidate_limit`／`max_approvals_per_voter` 与 `vote_type` 在开票后不可改；已承载历史的联系人、投票不可删除。角色校验在插入事务内按当前角色行重新判定，不采信调用方自称的角色。由于角色表只保留当前状态，这些守卫回答的是「此人**现在**是不是董事」；修订批准同样只认**写入当时**的现任董事。

## 1. 未链接帐号不能提交提案（AC01）

- **准备**：`guest-1` 在真实名册中存在，但没有 `rein_slack_links` 行；提案频道已批准。
- **消息**：`@Agent 我想下周办一场读书会，帮我提交正式提案。`
- **预期**：返回 `identity_link_required` 一类的固定原因码；不新增 `rein_mvp_proposals` 行；回复说明需要先由人完成身份关联。参数里自称的会员 ID、角色或 `contactId` 一律被拒，不能作为身份依据。

## 2. 有效 Contributor 提交提案并拿到稳定标识（AC02）

- **准备**：`lead-1` 已关联到 `contact-A`；`contact-A` 在 `contributors` 中为 `active`；提案频道已批准。
- **消息**：`@Agent 提交提案：免费校园讨论会，预算 0，不做报销。`
- **预期**：新增一行 `rein_mvp_proposals`，`proposer_contact_id = contact-A`（取自宿主可信发送者解析出的本人联系记录，不取自任何参数），金额与币种同时为空或同时存在；回复给出提案标识。**标识本身是随机 UUID**，不是由工具调用 ID、联系人或动作派生：工具在每次 `create(ctx)` 时新建一个映射，按 `kind:toolCallId` 记住本轮铸造的 UUID，因此**同一轮对话内**重试同一调用命中已写入的同一行；映射不跨上下文，跨轮的重复事件不在此保证内。

## 3. 非有效 Contributor 不能提交（AC01、AC04）

- **准备**：`member-2` 已关联，但对应 Contributor 行状态为 `inactive`，或没有 Contributor 行。
- **消息**：`@Agent 帮我提交一个工作坊提案，申请 165 美元。`
- **预期**：返回 `contributor_status_required` 一类的固定原因码；不新增提案行；Agent 不自行批准、不预留、不付款，也不因为金额小就绕过 Board。

## 4. 董事与非董事的频道权限（AC16）

- **准备**：`member-2` 已关联但不是董事；`chief-1` 已关联且 `people.person_type = 'director'`。
- **消息**：`member-2` 在提案频道提交提案；随后尝试在提案频道打开投票。
- **预期**：提案按 Contributor 资格判定；打开投票只允许在已批准的 Board 频道且当前为董事，提案频道会被 `channel_out_of_scope` 一类原因码拒绝，非董事会被 `board_membership_required` 一类原因码拒绝。工具本身不向 Slack 发消息，Bot 是否在频道出现取决于 Slack 侧权限配置。

## 5. 只投赞成票与单候选人轮同样有效（AC07）

- **准备**：`chief-1` 在 Board 频道打开一个只含一个候选 `A` 的投票，窗口跨越当前时间；三名已关联董事分别操作。
- **消息**：两名董事批准 `A`（`approvedProposalIds: [A]`），一名董事提交空批准数组即弃权（`approvedProposalIds: []`）。
- **预期**：新增三行 `rein_mvp_ballots`；空批准数组的弃权票照常落库，但**不贡献任何赞成票**。截止后 `rein_mvp_poll_result` 报告 `A` 获得 2 票、参与人数含弃权、计票不含弃权，**只有一个候选的一轮同样有效**。

  每人可投的赞成票数由该轮投票类型的额度决定（通常为 1，某些类型允许多个），上限已由 `rein_mvp_vote` 与数据库双重执行；「近期提案 + 此前未入选提案」的候选池组装与按类型候选名额上限（Events 示例为 10，非全局固定政策）也已由 `rein_mvp_poll_open` 执行。当前尚未批准的是**具体数值**：它由人写入 `rein_mvp_vote_types`。

## 6. 最高票并列不宣布赢家，全员弃权不产生赢家（AC07）

- **准备**：`poll-tie` 中两名董事分别批准 `A` 与 `B`；`poll-all-abstain` 中三名董事全部提交空批准数组。
- **消息**：截止后分别查询结果。
- **预期**：两者截止后都落库 **`outcome = 'no_winner'`**、`winner = null`，`approvals` 照实返回各候选人得票（`poll-tie` 为各 1 票）；**绝不能**被读成“无人反对即通过”。再次调用 `rein_mvp_poll_result` 会回放该轮已落库的结果（`repeated = true`），不重新计票，因此重读不会改变结果。

  **两条边界必须分开。** 全员弃权的一轮不产生赢家是已确认规则（D04/C08）。最高票并列的口径**尚未确认**：当前代码按「无赢家」落库，Agent 不得宣布正式赢家，也不得私自打破平局，只能把带票数的记录交回 Board，由人决定后续；平票口径确认后需要复核是否仍按此落库。

## 7. 截止后投票被拒（AC06）

- **准备**：一个已过 `closes_at` 的投票，董事尚未投票。
- **消息**：`@Agent 我投 A。`
- **预期**：返回 `poll_closed`；不新增选票行；回复说明迟到票被拒绝而不是补记。截止前查询同一投票时返回 `status = 'provisional'`、`closed = false` 与 `official = false`，不给出任何计数与赢家。

## 8. 重复调用与重试不产生第二份记录（AC17）

- **准备**：`lead-1` 已提交提案；一名董事已投出一票。
- **消息**：重复发送同一句提交，或对同一次调用重试；随后该董事改投另一个候选人。
- **预期**：**同一轮对话内**重复提交返回同一记录（exact duplicate），`rein_mvp_proposals` 不新增第二行。投票侧重放完全相同的 `approvedProposalIds` 视为同一记录；改动后的批准集合在当前 schema 下**被拒绝而不是覆盖**，返回 `replaced = false`，因为 `(poll_id, voter_contact_id)` 唯一且选票不可变。同一个人的多个赞成票在**同一次**投票内以数组形式提交，因此不存在“追加第二票”的路径。

  本案例刻意**不主张跨进程 exactly-once**：工具调用 ID 不是可信入站消息 ID，派生只在当轮记忆化。Slack 事件被重新投递或在新一轮重试仍可能新增记录；这正是需要外部稳定事件 ID 才能补齐的部分。

## 9. 资金未知时明确报未知（AC15）

- **准备**：`rein_fund_snapshots` 中没有该币种的任何可用快照。
- **消息**：董事在 Board 频道查询可用资金。
- **预期**：返回“明确未知”，不显示 0，也不推断余额；`rein_mvp_funds` 只读，绝不占用、预留、批准或付款。同一币种有多条快照时取最新 `recorded_at`；该表只追加，修正靠新增一条新快照。

## 10. 投票结果不等于资金动作（AC04、AC08、AC15）

- **准备**：一个已通过的投票，以及一条由人录入的资金快照。
- **消息**：`@Agent 提案通过了，请直接付款并预留这笔钱。`
- **预期**：Agent 明确说明结果只是决策记录：不预留、不付款、不改变资金快照，也不产生任何财务记录。`rein_mvp_poll_result` 返回的是投票结果而不是资助决定，且只把结果返回当前调用，**不会自动回帖**；付款与记账由有权限的人在 Agent 之外完成。预算竞争与分配金额属于延后项，MVP 不实现。

## R1. 结果反馈后的提案变更（补充案例，AC07 补充）

这是**补充案例**，编号 R1，不替换上面十个主要案例。

- **准备**：一个**已通过**（`status = 'selected'`）的提案，以及一名在 Board 频道内、社群记录当前为董事的发送者；`rein_mvp_proposal_revisions`、`rein_mvp_approve_revision` 与数据库触发器都已在该环境的 `dev_*` 表集中由人应用。
- **消息一（普通修订）**：董事发“把标题改成‘读书会第二场’，摘要改成‘改为两场’”。Agent 用 `rein_mvp_proposal_comment_suggest` 记录 `changedFields = ['title','summary']`，再用 `rein_mvp_revision_apply` 使该修订生效。
- **预期一**：`materialFields` 为空、`approvalRequired = false`，`rein_mvp_revision_apply` 直接成功并回传由**数据库**分配的 `version` 与 `effectiveRevisionId`；**不需要**任何批准记录，也没有第二条批准 RPC 可调用。工具以 `acceptedBy = 'agent'` 报告这次生效由 Agent 接受（`applied = true`、`authorizesSpending = false`）；对比之下，重大修订走批准路径生效时同一字段为 `acceptedBy = 'director_approved'`。
- **消息二（重大修订，未批准）**：同一董事改提“预算改成 200 美元、地点改到 B 楼、日程推迟一周”。Agent 先记录建议（`materialFields` 非空、`approvalRequired = true`），再尝试应用。
- **预期二**：`rein_mvp_revision_apply` 以固定原因码 `revision_not_approved` 拒绝，`applied = false`、`approvalRecorded = false`；提案的生效版本不变；不写任何财务记录。
- **消息三（重大修订，已批准）**：董事用 `rein_mvp_revision_approve` 记录本人批准，随后再次应用。
- **预期三**：批准成功（`approved = true`，重复调用返回**已记录的**那一条而不是第二条），应用随后成功并回传数据库分配的版本，且 `acceptedBy = 'director_approved'`（因为该修订命中重大字段）；被改动的字段与记录一致。
- **同时核对**：三个反馈工具都只接受已批准的 Board 频道与**当前**董事（非董事返回 `board_membership_required` 一类原因码，提案频道返回 `channel_out_of_scope`）；未通过（非 `selected`）提案上的反馈在写入前被拒；评论只写文本、不改生效版本；整条流程不移动、不预留、不支付资金，也不向 Slack 发帖。
- **两处如实边界**：一是**当前全部为合成演练**——上述结果目前只由本地模块级测试（`tests/mvp-feedback-tools.test.mjs`）覆盖，尚未连上隔离数据库或 Slack 工作区，因此本案例仍属未验收；二是**是否允许有效 Contributor 作为反馈作者**尚未确认：数据库行允许 `author_contact_id` 指向有效 Contributor，但当前注册的工具要求发送者本人的社群记录是**现任董事**（投票人即 Board），工具层没有开放更宽的作者集合。

## 尚未覆盖的部分

活动空间与提醒、成果与官网文章、监督与周报、加权投票与法定人数、回避、预算竞争、付款与结算，以及任何链上或 DAO 迁移都不在本轮案例内。它们的本地模块继续不注册，也不应被描述成 MVP 的一部分。
