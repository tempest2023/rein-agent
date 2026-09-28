# Rein Agent MVP 十个 Slack 演练案例

这些案例对应**已确认的 MVP 纵向切片**：Slack 身份解析（邮箱匹配） → Contributor 提案 → Board 只投赞成票的批准投票与结果 → 只读资金快照。范围与延后项见[决策登记册](decisions.md)，逐项证据见 [AC01–AC20 验收矩阵](p0-acceptance-matrix.md)。

**当前一律为合成演练，不是上线验收。** 所有帐号、频道、提案、金额与投票都是虚构数据；尚未接入真实 Slack 工作区，Agent 也尚未连接数据库——**本轮不含任何实机安装或联调（no live setup）**。两个 MVP 迁移已在姊妹仓库 `tempest2023/ReinProtocolFoundation` 的分支 `tempest/agent-mvp-schema-and-welcome-email`（PR #13，当前提交 `f15c7ea`）提交并应用到已链接的 `BeneficenceProtocol` 项目，两套 `dev_*` 与 `prod_*` 对象都在同一事务里建成（2026-09-27 以 `supabase migration list --linked` 只读核对）；姊妹仓库另有第三个迁移 `20260927103000_rein_mvp_ballot_cast_at_db_clock.sql`（选票 `cast_at` 改由数据库时钟决定），**已提交但尚未应用**。**已应用不等于已使用**：没有任何工具真的读写过任一表集，两套数据也都未核对，也没有端到端证据。每条案例里的「用户可见」回复目前只是**期望行为**，其中尚未实现的对话引导已在各案例与[验收缺口](#验收缺口)标出；只有连上沙盒工作区与隔离数据库、并留下提供方证据之后，才可以逐条改判。

**工具只把结果返回到调用它的那一轮，不自动回帖。** 每个案例的「工具 / 数据库」断言才是当前**已实现能力**，可以在合成演练里逐项复核；「用户可见」一栏描述 Agent 应如何用自然语言回应，属于验收目标而不是既成事实。

## 阅读方式

每条案例分三块：

- **对话**：合成帐号在提案频道或 Board 频道的自然语言往返，包含追问与后续轮次。
- **用户可见**：Agent 回应里应出现的内容（期望行为，含尚未实现的引导）。
- **工具 / 数据库**：工具返回字段与数据库写入结果（已实现能力，可被合成演练复核）。

技术前提（单工作区、频道、迁移、播种、`foundationDb` 配置块、记录口径与数据库对象速查）移到了[附录 A](#附录-a运维与技术前提)，让 Contributor 侧提示保持日常语气。规则口径与代码路径的依据是 [决策登记册](decisions.md)（D04、D05、D06、D08、D09、D10、D11、D13）与 [AC01–AC20 验收矩阵](p0-acceptance-matrix.md)。

身份解析按 D13：Agent 取发送者的**当前 Slack 资料邮箱**，比对唯一一条 `<env>_contact_identities` 记录，联系人与当前角色在每次请求重新推导，不落库新关联；保留的关联行只作撤销或冲突否决。下文说某人「身份已解析」，指的就是这种邮箱匹配成立，而不是「有一条人工建的关联行」。

## 1. Slack 邮箱对不上（或没有邮箱）的新人问「怎么提案」（AC01）

- **准备**：`guest-1` 是正常受邀加入的人，提案频道已批准；但他的 Slack 资料邮箱隐藏或缺失，或该邮箱在 `<env>_contact_identities` 里对不上唯一一行（没有对应行，或同一邮箱对应多行）。这是**身份未解析**的情形，不是「已有人替他建好关联、只差连上」的普通状态。
- **对话**：
  - 用户：`@Agent 你好，我刚进社群，下周想办个读书会，要怎么才能正式提一个提案？`
  - Agent（期望）：说明 Agent 无法从 Slack 资料邮箱确认他的社群身份（邮箱缺失、隐藏，或对不上唯一一条社群邮箱记录），所以还不能以本人社群记录提交；给出人工下一步——请人核对或补齐邮箱与社群记录的对应关系——但不替他提交。
- **用户可见**：给出「先由人核对邮箱与社群记录的对应关系 → 再在提案频道提交」的下一步；不声称已经提交或已经立项，也不把邮箱对不上说成「已受理、只差一步关联」。
- **工具 / 数据库**：
  - 身份解析按 D13 **失败关闭**：资料邮箱缺失、隐藏、对不上任何行、命中多行，或命中的记录没有可用联系人时，都不解析出联系人与角色；`rein_member_status` 不给出可用的联系人／角色。
  - 若本轮调用 `rein_governance_proposal_submit`，返回 `ok = false` 并失败关闭；`<env>_rein_proposals` 不新增行。
  - **原因码随实现而定。** 邮箱解析路径（D13）已在本地代码与测试中就绪，但默认关闭（`foundationDb.identityEmailMatch` 默认 `disabled`），Bot scope 与 Bot token 也未安装／未配置，未启用时现有读取器仍走关联表；演练时必须读取当前注册工具的实际返回值，不要引用 `identity_not_linked`、`identity_link_required` 之类的固定字面量，也不要断言所有未解析路径都返回同一个词。参数里自称的 `contactId`、`memberId` 或角色一律不作为身份依据。
- **缺口**：D13 的邮箱解析（`users.info` 加 `users:read`／`users:read.email` 两个 Bot scope）**已在本地代码与测试中就绪，但默认关闭**（`foundationDb.identityEmailMatch` 默认 `disabled`），scope 与 Bot token 均未安装／未配置，未启用时现有实现仍按关联表解析；因此本条既是「身份未解析即失败关闭」的期望行为，也是当前验收缺口，见[验收缺口](#验收缺口)。「怎么才能提案」的分步对话引导同样只有 `workspace/AGENTS.md` 的持久原则引导，尚无确定性流程，也未经真实对话验证。

## 2. 已关联但非有效 Contributor 想提案（AC01、AC04）

- **准备**：`member-2` 的 Slack 资料邮箱能对上唯一一条 `<env>_contact_identities` 记录，但对应 Contributor 行状态为 `inactive`，或根本没有 Contributor 行。
- **对话**：
  - 用户：`@Agent 帮我提交一个工作坊提案吧，预算 165 美元，用来买材料。`
  - Agent（期望）：说明正式提交需要当前有效的 Contributor 记录，你目前不满足；可以帮你联系管理员确认状态。
- **用户可见**：说明被拒的原因与人工下一步；不因为金额小就绕过 Board，也不声称已受理。
- **工具 / 数据库**：
  - `rein_governance_proposal_submit` 返回 `ok = false`、`error = 'contributor_status_required'`。
  - `<env>_rein_proposals` 不新增行；Agent 不自行批准、不预留、不付款。

## 3. 有效 Contributor 想法很模糊，Agent 追问缺的字段（AC02）

- **准备**：`lead-1` 已关联到 `contact-A`，且 `contact-A` 在 `contributors` 中为 `active`；提案频道已批准。
- **对话**：
  - 用户：`@Agent 我想搞个社区分享会，大概五十人，别的地方还没想好，能帮我提吗？`
  - Agent（期望）：先把缺的字段一次问清——提案类型、标题、预计金额与币种、大致时间——这一轮先不提交。
  - 用户：`预算大概 300 美元吧，标题就叫「九月社区分享会」。`
  - Agent（期望）：确认提案类型（由运营配置的投票类型决定），补齐后再提交。
- **用户可见**：追问缺哪些字段、为什么现在还不能提交；不编造金额、币种或时间。
- **工具 / 数据库**：
  - 在 `title`、`voteType` 且 `requestedMinor`+`currency` 成对出现之前，**不调用** `rein_governance_proposal_submit`，`<env>_rein_proposals` 不新增行。
  - 字段齐全后才提交；金额与币种必须同时为空或同时存在（见案例 4）。
- **缺口**：MVP 没有多轮草稿工具，也没有确定性的「缺字段 / 需补充信息」流程；workspace 已加入持久原则引导，但案例 3 的追问仍由 Agent 临场完成，且未经真实对话验证，属目标验收缺口，见[验收缺口](#验收缺口)。

## 4. 有效 Contributor 补齐并提交，拿到标识与下一步（AC02）

- **准备**：同案例 3，`lead-1` 是有效 Contributor，提案频道已批准。
- **对话**：
  - 用户：`@Agent 就是一场九月社区分享会，预算 300 美元，摘要写「场地与茶歇」。`
  - Agent（期望）：把口语里的活动映射到运营配置的提案类型——类型名是内部配置（例如 `event_budget`），由 Agent 决定，**不由提案人口述**——再调用 `rein_governance_proposal_submit`，并把要点读回给提案人确认。
  - Agent（期望）：回报提案标识，并说明下一步——它会进入该投票类型的候选池，由现任董事在 Board 频道开票；通过只是决策记录，不移动资金。
- **用户可见**：给出 `proposalId` 与下一步说明。**用户不需要知道内部投票类型名，「下一步」也只是对话引导，没有结构化的 next-steps 字段。**
- **工具 / 数据库**：
  - `rein_governance_proposal_submit` 返回 `ok = true`、`proposalId` 为随机 UUID、`voteType` 为**运营配置里的类型名**（由 Agent 映射，不由用户口述）、`requestedMinor = 30000`、`currency = 'USD'`、`recorded = true`、`authorizesSpending = false`。
  - `<env>_rein_proposals` 新增一行，`proposer_contact_id` 取自宿主可信发送者解析出的本人联系记录，不取自任何参数。
  - 同一轮对话内重试同一次调用命中同一行，不新增第二行。
- **缺口**：没有「口语 → 运营配置投票类型」的确定性解析器；映射靠 workspace 的持久原则与运营配置，未经真实对话验证，见[验收缺口](#验收缺口)。

## 5. 现任董事问「有什么可投」并在 Board 频道开票（AC16）

- **准备**：`chief-1` 已关联且 `people.person_type = 'director'`；Board 频道已批准；`rein_vote_types` 中已由人配置 `event_budget` 一行的 `max_candidates` 与 `max_approvals_per_voter`。
- **对话**：
  - 用户：`@Agent 这周有什么可以投票的？帮我开一轮活动类提案的投票，这周五晚上八点截止。`
  - Agent（期望）：说明开票按**投票类型**发起、候选池由 Agent 从库里组装；把「活动类提案」这类口语说法映射到运营配置里的投票类型（内部名例如 `event_budget`，**不由董事口述**）；若无法确定对应的配置类型，先请董事澄清，不猜；回报 `pollId` 与截止时间。
- **用户可见**：给出 `pollId`、候选来自库中该类型的提案、以及截止时间；不声称已经通知了谁。
- **工具 / 数据库**：
  - `rein_poll_open(voteType: 'event_budget', title, closesAt)` 返回 `ok = true` 与 `pollId`。
  - 候选池由工具从库组装；调用方不能传候选或名额：`candidateIds`、`options`、`maxApprovalsPerVoter` 等参数被 `policy_argument_rejected` 拒绝，`options` 走到写入层还会得到 `legacy_options_unsupported`。
  - `<env>_rein_polls` 新增一行，候选名单与窗口就此冻结，`candidate_limit` 与 `max_approvals_per_voter` 由数据库从投票类型冻结。
  - 非董事返回 `board_membership_required`，在提案频道调用返回 `channel_out_of_scope`，都在写库前拒绝。
- **缺口**：没有「列出当前可投票提案」的只读工具；workspace 的持久原则要求不要承诺未连接的能力，所以「这周有什么可以投票的」只能由人或其他手段回答。把「活动类提案」映射到配置类型名同样没有确定性解析器，靠 workspace 的持久原则与运营配置，也未经真实对话验证；两者都属目标验收缺口，见[验收缺口](#验收缺口)。

## 6. 董事用自然语言投票，含弃权（AC07）

- **准备**：一轮已打开的投票，候选冻结为两条提案「九月社区分享会」与「读书会第二场」（落到库里是各自的提案 UUID）；该轮投票类型的 `maxApprovalsPerVoter` 已由人配置为 2。三名已关联董事在 Board 频道。
- **对话**：
  - 董事 A：`@Agent 我投「九月社区分享会」那一场。`
  - 董事 B：`@Agent 分享会和读书会两场我都投。`
  - 董事 C：`@Agent 这轮我弃权，不投任何提案。`
  - Agent（期望）：用开轮时拿到的候选提案 ID 把标题指代映射成 `rein_poll_vote` 的 `approvedProposalIds`（A 一条、B 两条），标题有歧义时先问清是哪一条；弃权映射为空数组（或不传该参数）。
- **用户可见**：确认每人的票已记录、弃权等于不投任何赞成票；投标人只需要说提案名字，不需要知道字段名或 ID。
- **工具 / 数据库**：
  - 三次 `rein_poll_vote` 成功；董事 A 的 `approvalCount = 1`，董事 B 的 `approvalCount = 2`（因为该轮 `maxApprovalsPerVoter = 2`），董事 C 的 `approvalCount = 0`、`abstained = true`；每次 `replaced = false`、`authorizesSpending = false`。
  - 每人批复数受该轮 `maxApprovalsPerVoter` 限制：若该类型只允许 1 票、而有人想批准两条，会被 `too_many_approvals` 拒绝；候选必须在冻结名单内，越界由工具与数据库双重拒绝。
  - `<env>_rein_ballots` 新增三行，`approved_proposal_ids` 为该人批准的候选人 UUID（可多个，空数组即弃权）；`(poll_id, voter_contact_id)` 唯一。
- **缺口**：没有「提案标题 → 提案 ID」的确定性解析器；workspace 已加入持久原则引导（用开轮已知的候选 ID、有歧义就先问），但没有确定性流程，也未经真实对话验证，见[验收缺口](#验收缺口)。

## 7. 截止前后的状态与结果，解释赢家与结果记录（AC06、AC07）

- **准备**：一轮投票，截止时间跨越当前时刻；已有董事投出的选票。提问者是 Board 频道里的现任董事——`rein_poll_result` 只服务已批准 Board 频道，公开频道的 Contributor 不能调用它。
- **对话**：
  - 董事：`@Agent 这一轮现在怎么样了？`
  - Agent（期望）：截止前只能给「临时读数」，不给计数与赢家。
  - 董事：`@Agent 现在结果出来了吗？谁赢了？`
  - Agent（期望）：截止后给出赢家与票数，并强调这只是决策记录。
- **用户可见**：截止前说明「还没有正式结果」；截止后同时给出赢家、参与人数与弃权数，并解释结果不移动资金。
- **工具 / 数据库**：
  - 截止前 `rein_poll_result` 返回 `status = 'provisional'`、`ok = false`、`closed = false`、`official = false`、`outcome = null`、`winner = null`、`counts = null`，只给 `closesAt`、`totalBallots` 等可读事实。
  - 截止后由 `rein_finalize_poll` 由数据库落库结果，工具返回 `ok = true`、`closed = true`、`official = true`、`outcome`（`'winner'` 或 `'no_winner'`）、`winner`、`counts`（各候选人得票）、`totalBallots`、`abstainCount`（截止后参与总数与各候选人票数**仍可读**）。
  - 再次查询已关闭的一轮返回 `repeated = true`，回放该轮已落库的结果，不重新计票。
- **缺口**：没有专门的结果叙述或回帖工具，工具只返回原始结果字段；workspace 的持久原则要求 Agent 依据这些字段自己讲清楚，且**不得声称结果已回帖到频道**。叙述话术的可用性未经真实对话验证，属目标验收缺口，见[验收缺口](#验收缺口)。

## 8. 已通过提案的反馈：普通标题/摘要 vs 需要董事批准的预算/日程（AC07 补充，D10/D11）

- **准备**：一个已通过（`status = 'selected'`）的提案；发送者是 Board 频道内、社群记录当前为董事。
- **对话**：
  - 用户：`@Agent 把标题改成「读书会第二场」，摘要改成「改为两场」，其他都别动。`
  - Agent（期望）：记录建议并直接生效，说明这是普通修订、不需要另行批准。
  - 用户：`@Agent 预算改成 200 美元，时间推迟一周。`
  - Agent（期望）：说明预算与日程属于重大字段，要由现任董事批准后才能生效。
  - 用户（董事）：`@Agent 那这次改动我批准。`
  - Agent（期望）：记录批准，然后应用。
- **用户可见**：区分「普通修订：Agent 可自行接受生效」与「重大修订：要一位现任董事批准」；不声称任何修订会移动资金。
- **工具 / 数据库**：
  - 普通修订：`rein_proposal_comment_suggest` 返回 `materialFields = []`、`approvalRequired = false`；`rein_revision_apply` 返回 `applied = true`、`acceptedBy = 'agent'`、`version` 与 `effectiveRevisionId` 由数据库分配、`authorizesSpending = false`。
  - 重大修订未批准：`materialFields` 含 `budget`、`schedule`，`approvalRequired = true`；`rein_revision_apply` 返回 `error = 'revision_not_approved'`、`applied = false`，提案生效版本不变，不写任何财务记录。
  - 重大修订已批准：`rein_revision_approve` 返回 `approved = true`（重复调用返回已记录的那一条）；随后 apply 返回 `applied = true`、`acceptedBy = 'director_approved'`。
  - 三个反馈工具都限已批准的 Board 频道与**当前**董事（非董事返回 `board_membership_required`，提案频道返回 `channel_out_of_scope`）；评论只写文本、不改生效版本。
- **缺口**：是否允许有效 Contributor 作为反馈作者尚未确认——数据库行允许 `author_contact_id` 指向有效 Contributor，但当前注册的工具要求现任董事，见[验收缺口](#验收缺口)。

## 9. 自然的资金询问：已知快照与未知币种，都不假设为 0（AC15）

- **准备**：`rein_fund_snapshots` 中有 `USD` 的快照；没有任何 `EUR` 快照。发送者是 Board 频道的现任董事。
- **对话**：
  - 用户：`@Agent 我们现在还有多少 USD 可用？`
  - Agent（期望）：给出最新快照的金额、币种与记录时间，并说明它只是人工录入的只读快照。
  - 用户：`@Agent 那 EUR 呢？`
  - Agent（期望）：明确说「未知」，不显示 0，也不推断余额。
- **用户可见**：已知时给金额 + 币种 + 记录时间；未知时如实报未知。
- **工具 / 数据库**：
  - 已知：`rein_funds` 返回 `status = 'snapshot'`、`ok = true`、`currency = 'USD'`、`availableMinor`（整数最小单位）、`recordedAt`、`recordedBy`、`sourceNote`、`authorizesSpending = false`。
  - 未知：返回 `status = 'unknown'`、`ok = false`、`reason = 'no_snapshot'`、`availableMinor = null`、`currency = 'EUR'`；**不显示 0，也不推断余额**。
  - `rein_funds` 只读，限已批准 Board 频道与现任董事；绝不占用、预留、批准或付款。
- **缺口**：把「还有多少」「那 EUR 呢」这类自然语言映射成带 `currency` 参数的调用属于对话引导；workspace 的持久原则要求缺币种时先问，但没有确定性流程，也未经真实对话验证，属目标验收缺口，见[验收缺口](#验收缺口)。

## 10. 已通过提案被要求直接付款/预留，拒绝并给出人工下一步（AC04、AC08、AC15）

- **准备**：一个已通过的投票，以及一条由人录入的资金快照。
- **对话**：
  - 用户：`@Agent 读书会的提案已经过了，你直接把这 300 美元打给场地并预留出来吧。`
  - Agent（期望）：拒绝，说明通过只是决策记录，不预留、不付款。
- **用户可见**：给出人工下一步——付款与记账由有权限的人在 Agent 之外完成；不承诺已付款或已预留。
- **工具 / 数据库**：
  - `rein_poll_result` 返回的是投票结果（`outcome`、`winner`）而不是资助决定，且只把结果返回当前调用。
  - 不改变 `rein_fund_snapshots`，不产生任何财务记录；整套 MVP 工具中没有可支付或预留的路径。
  - 预算竞争与分配金额属于延后项，MVP 不实现。

## 补充回归测试

以下边界是**实现层角落**，不属于上面十个主案例；它们由模块级自动测试覆盖，演练时只需引用测试结果，不必重演对话。

- **最高票并列与全员弃权**：`tests/mvp-vote-tally.test.mjs` 覆盖 `no_winner`、`winner = null`、`tiedProposalIds`、`reasons = ['tie_at_highest_count']`，并区分「平票」与「全员弃权、每人 0 票」。平票口径**尚未确认**，当前按「无赢家」落库，不得私自打破平局。
- **迟到票**：`tests/mvp-write-tools.test.mjs`、`tests/mvp-rehearsal.test.mjs` 覆盖截止后投票返回 `poll_closed`、不写选票行。
- **截止由库决定、候选与上限冻结**：`tests/mvp-write-tools.test.mjs`、`tests/mvp-rehearsal.test.mjs` 覆盖冻结候选名单、`maxApprovalsPerVoter` 上限与开票后窗口不可改。
- **重复与重放**：`tests/mvp-vote-tally.test.mjs`、`tests/proposal-store.test.mjs`、`tests/foundation-db-writer.test.mjs` 覆盖同一轮内 exact duplicate、相同 `approvedProposalIds` 重放视为同一记录、改动后的批准集合被拒（`replaced = false`）；跨轮**不主张** exactly-once。
- **单候选人轮同样有效、弃权计参与不计票**：`tests/mvp-vote-tally.test.mjs`、`tests/mvp-rehearsal.test.mjs`。
- **结果反馈与修订**：`tests/mvp-feedback-tools.test.mjs`（工程记录为 34/34）、`tests/mvp-proposal-feedback.test.mjs` 覆盖普通修订由 Agent 接受生效、重大修订在记录到现任董事批准前以 `revision_not_approved` 拒绝、评论不改版本。
- **频道与角色边界**：`tests/request-context.test.mjs`、`tests/foundation-db-reader.test.mjs` 覆盖未批准频道、缺失可信发送者、董事身份解析。

## 验收缺口

以下是**期望行为但当前实现不足**的部分，按现状如实标记为验收缺口，不得当作已通过。案例 1、3、4、5、6、7、9 里的对话引导都属于这一类：**Agent 的引导话术是验收目标，不是已实现能力。** `workspace/AGENTS.md` 只给出**持久的组织运营原则**（身份、缺字段追问、Board 投票、结果、资金、应对歧义与人工下一步）；它**不列举任何工具名、字段或配置**，因此不含确定性的口语映射，也不是经过验证的确定性流程。下面把口语映射到具体工具与字段（`voteType`／`pollId`／`approvedProposalIds` 等）的对应关系是**本测试与部署文档范围内的实现细节**，随版本变化，必须对照当前注册的工具核实后才能作为验收依据。

- **对话引导只有原则层，没有确定性流程（案例 1、3、4、5、6、7、9）**：分步引导、追问缺字段、把口语映射到配置的类型名、解释可投票范围、把口语转成工具参数、叙述结果、把口语资金询问转成 `currency`，目前在 `workspace/AGENTS.md` 中有持久原则引导，但没有确定性代码流程，也没有真实对话验证；可复核的证据仍然只有工具返回与数据库记录。
- **没有「列出可投票提案」的只读工具**：案例 5 里「这周有什么可以投票的」目前无法由工具回答，开票是董事按投票类型发起。
- **没有自然语言到类型／ID 的解析器**：案例 4、5、6 里从口语活动到运营配置类型名、从提案标题或指代到 `voteType`／`pollId`／`approvedProposalIds` 的解析尚未实现，只有原则层引导与工具描述。
- **自然语言到 `approvedProposalIds` 的映射（含弃权）没有专用解析**：案例 6 只靠 `workspace/AGENTS.md` 的持久原则与工具描述，没有解析工具，也未经真实对话验证。
- **多轮补齐字段没有草稿工具**：案例 3 的追问完全由 Agent 引导完成。
- **提案提交没有结构化下一步字段**：案例 4 的「下一步」只是对话文本。
- **没有结果叙述或回帖**：案例 7 的解释性叙述与频道回帖都未实现，工具只返回结果字段。
- **反馈作者范围未确认**：数据库行允许有效 Contributor 作为 `author_contact_id`，当前注册工具只接受现任董事。
- **平票口径未确认**：当前按「无赢家」落库，不得对外宣布为组织正式规则。
- **Slack 邮箱身份解析已在本地实现，但默认关闭（案例 1）**：D13 规定的 `users.info` 资料邮箱匹配与 `<env>_contact_identities` 唯一行匹配已落在 `slack-email-lookup.ts` 与读取器的邮箱优先路径中，并有本地测试；`users:read`／`users:read.email` 两个 Bot scope 与 Bot token 尚未安装／未配置，`foundationDb.identityEmailMatch` 默认 `disabled`，未启用时读取器仍按 `rein_slack_links` 关联表解析。因此案例 1 的「邮箱对不上或缺失即失败关闭」在本地测试中已有覆盖，但尚未经真实工作区验收。
- **没有任何真实端到端验收**：以上全部为合成演练；真实 Slack 工作区与提供方证据都还没有接入，Agent 也尚未连接已应用迁移的数据库。
- **命名与改名迁移（新增）**：审查要求移除工具、表、配置与 skill 中的 `mvp` 命名。插件与配置现已改用长期名称（`rein_member_status`、`rein_funds`、`rein_governance_proposal_submit`、`rein_poll_open`、`rein_poll_vote`、`rein_poll_result`、`rein_proposal_comment_suggest`、`rein_revision_approve`、`rein_revision_apply` 与 `foundationDb` 配置块）；数据库侧的改名由向前迁移 `20260927110000_rein_governance_names.sql` 完成，它排在已提交的 `20260927103000` 之后，重命名物理表与两个 RPC 并保留旧名兼容视图与包装。该迁移**已在 PR #13（head `f15c7ea`）提交但尚未应用到已链接项目**，必须**先应用它、再启用使用新名称的 Agent 代码**；在此之前线上数据库只认旧名，也不得声称新名称已在任一环境生效。接口见[服务方接口契约](integration-contracts.md#naming-and-the-rename-migration)。

## 附录 A：运维与技术前提

以下内容由人执行并复核；Agent 不参与建表、播种、建应用或写入凭据。所有值都必须替换为**已批准**的唯一平台、原生频道 ID 与隔离环境；仓库中不得出现令牌、签名密钥或工作区 ID。

- **一个部署只服务一个 Slack 工作区。** 使用 Socket Mode 与官方 OpenClaw `slack` 插件；v2 工具上下文不携带团队 ID，因此 `slackTeamId` 必须正好是被服务的那个工作区。
- **只放服务端环境变量引用。** Supabase 地址与密钥只从 `supabaseUrlEnvVar`、`supabaseServiceKeyEnvVar` 指向的服务端环境变量读取，绝不写入配置或结果。
- **迁移由人执行。** 前两个迁移已在姊妹仓库分支 `tempest/agent-mvp-schema-and-welcome-email`（PR #13，当前提交 `f15c7ea`，原提交 `4bd5ce8`）提交，并按文件名顺序应用到已链接的 `BeneficenceProtocol` 项目：`20260924094436_rein_slack_identity_and_fund_snapshots.sql`（身份关联表与只追加的可用资金快照表）与 `20260924095705_rein_mvp_proposals_polls_ballots.sql`（提案、投票、选票三张表，投票类型表、修订记录表与 `effective_revision_id` 列，以及冻结候选名单、按当前董事校验选票、`rein_finalize_poll` 计票与 `rein_approve_revision` 重大修订批准）。两个迁移都在同一事务里定义 `dev_*` 与 `prod_*` 两套对象，`supabase migration list --linked` 又是项目级，因此两套 schema 都已建成；2026-09-27 只读核对时两个版本都显示为已应用。第三个迁移 `20260927103000_rein_mvp_ballot_cast_at_db_clock.sql`（选票 `cast_at` 改由数据库时钟决定）**已在 `32977bfb` 提交，但尚未应用到已链接项目**，要生效仍需一次人工执行的 `supabase db push`；目前不得声称该时钟规则已在任一环境生效。**但已应用不是已使用**：Agent 尚未连接，没有任何工具真的读过或写过任一表集，两套数据也都未核对，**不得据此声称 schema 已被端到端验证**。按类型的具体名额与批准额度需由人写入 `rein_vote_types`。
- **播种由人完成。** 邮箱到联系人的对应关系（`<env>_contact_identities`，每行一个规范化邮箱与一个唯一联系人）、Contributor 的 `active` 状态、董事的 `person_type`、第一条可用资金快照，以及每个提案类型在 `rein_vote_types` 中的 `max_candidates` 与 `max_approvals_per_voter` 都由人直接写库或走已复核的管理路径；Agent 不创建这些记录，也不提供注册工具。
- **身份邮箱解析需要 Bot scope（尚未安装）。** D13 的邮箱匹配要求治理 Bot 应用装 `users:read` 与 `users:read.email` 两个 Bot scope；目前**未安装**，Bot token 也未配置，且 `foundationDb.identityEmailMatch` 默认 `disabled`，未启用时读取器仍按关联表解析，因此该路径不能用于真实演练。本地人工测试用户应用保持只用 `chat:write`，不加 Bot scope。
- **显式启用 `foundationDb` 配置块。** 启用后注册 9 个 MVP 工具（2 读、4 写、3 个结果反馈），并隐藏合成模拟器与旧提案工具；未设置 `enabled: true` 时一个都不注册。
- **每轮记录。** 记录入站事件的发送者 ID、工具调用 ID、Agent 回复、数据库记录与拒绝原因。所有拒绝都走固定原因码，且不返回 Supabase 地址、密钥、团队 ID 或私密联系人标识。
- **Agent 不自动回帖。** 当前工具只把结果返回到调用它的那一轮；把结果回帖到 Slack 的消息发送尚未实现，因此各案例只核对工具返回，不核对频道回帖。

### 预期数据库记录速查

| 数据库对象 | 何时新增 |
| --- | --- |
| `<env>_contact_identities` | 由人播种：每行一个规范化邮箱与一个社群联系人；身份按邮箱在这里精确匹配（D13），Agent 只读，不写入 |
| `<env>_rein_slack_links` | **遗留记录**：不再作为身份凭据，保留下来只作撤销与冲突否决（`revoked` 否决该发送者；`verified` 但与邮箱匹配结果的联系人冲突也否决）。Agent 只读，不写入 |
| `<env>_rein_proposals` | `rein_governance_proposal_submit` 成功时新增一行；同一轮对话里的同一调用重试不新增第二行 |
| `<env>_rein_polls` | `rein_poll_open` 成功时新增一行，候选名单与窗口就此固定；`candidate_limit` 与 `max_approvals_per_voter` 由数据库从投票类型冻结，不由调用方给出 |
| `<env>_rein_ballots` | `rein_poll_vote` 成功时新增一行，`approved_proposal_ids` 为该人批准的候选人（可多个，空数组即弃权）；`(poll_id, voter_contact_id)` 唯一，同一投票同一人改投会被拒 |
| `<env>_rein_vote_types` | 由人播种：每个提案类型的 `max_candidates` 与 `max_approvals_per_voter`；Agent 只读，不写入 |
| `<env>_rein_proposal_revisions` | 结果公布后的评论或修订；只改标题或摘要的普通修订由 Agent 接受并生效，重大字段（预算、地点、日程、人员、主流程）须先经 `rein_approve_revision` 由现任董事批准才能生效 |
| `<env>_rein_fund_snapshots` | 只由人录入；Agent 只读，且表为只追加 |

数据库本身也会拒绝几类写入，不能只靠工具层把关：选票里的每个批准项必须命中该投票冻结的候选名单，且不得重复、不得超过该轮 `max_approvals_per_voter`；投票一旦有选票，候选名单与窗口就被冻结；`candidate_limit`／`max_approvals_per_voter` 与 `vote_type` 在开票后不可改；已承载历史的联系人、投票不可删除。角色校验在插入事务内按当前角色行重新判定，不采信调用方自称的角色。由于角色表只保留当前状态，这些守卫回答的是「此人**现在**是不是董事」；修订批准同样只认**写入当时**的现任董事。

## 尚未覆盖的部分

活动空间与提醒、成果与官网文章、监督与周报、加权投票与法定人数、回避、预算竞争、付款与结算，以及任何链上或 DAO 迁移都不在本轮案例内。它们的本地模块继续不注册，也不应被描述成 MVP 的一部分。
