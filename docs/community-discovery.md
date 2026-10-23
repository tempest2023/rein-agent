# 组织活动与资源查询

对应 PRD R01、R03、R25、US01、US02。Nori 通过 Foundation 后端查询 Website 使用的
已发布资源和活动。组织数据不从网页搜索、聊天历史或 `community-directory.json` 推断。
静态目录继续用于频道、讨论和贡献入口导航。

## 调用链和权限

`workspace/skills/rein-community-discovery/SKILL.md` → Rein 查询工具 →
`POST /api/ingress/relay` → `POST /api/agent/operations` → Website 的公开数据读取层。

工具仅在 `rein-operations.foundationDb.enabled=true` 且既有后端配置完整时注册。复用
`backendApiBaseUrlEnvVar`、`agentCallerIdEnvVar`、`agentCredentialEnvVar` 与 `workspaces`
配置，沿用宿主可信的 sender/channel/session 和每次调用生成的私有 proof。Agent 不持有
数据库凭证，不接受模型提供的账号、角色、环境或权限标记。

后端调用方需独立的 `community.read` scope，以及 `ingress.relay`；使用身份检查与绑定
功能时仍需相应的 `identity.*` scopes。`governance.read` 不替代 `community.read`。
后端现有 service caller 管理支持 scopes 配置；部署新代码不会自动给已有调用方加权限。

每次查询重新验证服务调用方、proof、平台／服务器／频道，以及当前账号的有效
Community Member link。Discord 或 Slack 完成关联的普通成员即可使用，不要求
Contributor 或 Board 身份。查询完成后再次检查 link；撤销、过期、缺失或换绑均不返回
数据。之前一轮查询成功不能替代本轮验证。

## 工具

| 工具 | 后端 operation | 参数 |
| --- | --- | --- |
| `rein_resources_search` | `community_resources_search` | 可选 query、language、difficulty、topic、resourceType、limit、offset |
| `rein_resource_get` | `community_resource_get` | 上次查询返回的记录 id |
| `rein_events_search` | `community_events_search` | 可选 query、city、format、startsAfter、startsBefore、limit、offset |
| `rein_event_get` | `community_event_get` | 上次查询返回的记录 id |

`query` 对标题和摘要作不区分大小写的字面子串匹配；language、difficulty 和 city 也是
字面子串，topic 为精确标签。resourceType 使用 Website 的类型值；format 为 online、
in_person 或 hybrid。未知字段和身份伪造参数都拒绝。筛选发生在数据库分页之前。

默认每页 3 条，最大 20 条，offset 最大 10000。仅当 hasMore 为 true 时使用 nextOffset
请求下一页，保持筛选条件不变。资源按 Website 编辑排序、发布时间、id 排序；活动按
创建时间、id 排序。活动页不是按最近场次全局排序。

活动搜索默认只查当前时刻之后开始的场次。startsAfter 包含边界，startsBefore 不包含
边界，均为带 UTC offset 的 ISO 时间。搜索返回符合窗口的场次，详情返回所有场次；
后端保留 IANA 时区与登记的报名状态，不推断名额或替成员报名。未发布／取消活动不会
出现在搜索或详情中；已关闭报名的已发布活动仍如实显示 closed。

## 结果与失败

成功结果携带 `source=foundation_catalog`、environment、retrievedAt、记录 id、正式链接、
updatedAt；资源另外有 verifiedAt。仅包含公开字段，不包括审核人、提交人、内部审批
备注、成员身份或凭证。查询不会缓存身份和业务结果，外部报名系统也不会被自动抓取。
DEV 结果必须标明开发验证，不能称为生产查询。数据库环境只由 Website 后端配置决定。

- found：有结果；empty：成功搜索但无匹配；not_found：详情不存在或已不再公开。
- community_member_required：查询失败，当前账号需要有效的 Community Member link。
- permission_denied：查询失败，服务调用方／频道等权限不足。
- invalid_request：筛选条件或 id 无效。
- unavailable：查询或身份无法核实，包含连接、超时和响应格式错误。

失败返回 `ok=false`、`status=failed`、失败提示和 `isError=true`，不附带旧数据。skill
要求明确告知失败；身份未绑定时可继续现有绑定流程，成功后重新调用查询工具。不能
通过网页、静态目录、另一个账号或历史结果绕过失败。技能文件自身是公开操作说明，
读取它不会授予数据权限。

## 配置与验证

先部署对应 Website 后端代码，再为已批准的调用方增加 `community.read`，然后重新
加载 Agent 插件。将 `workspace/skills/rein-community-discovery/SKILL.md` 一起同步到实际
运行 workspace。专用隔离 Discord 配置需把四个工具加入 `tools.allow`；示例已更新，
隔离适配器仅允许这份公开 skill 文件，不放开任意目录、脚本、符号链接或额外工具。

本地验证：

```sh
npm run toolchain:pnpm -- run check
npm run toolchain:pnpm -- exec node --test tests/community-tools.test.mjs tests/backend-boundary.test.mjs tests/plugin.test.mjs tests/discord-user-isolation.test.mjs
npm run toolchain:pnpm -- run verify:plugin
```

Website 配套测试覆盖 dispatcher 的真实认证链、普通成员资格、权限撤销、proof／频道
限制、过滤与分页、时间范围、数据失败和非公开字段。真实 Discord 验收需另行记录消息
进入、skill／工具调用、后端结果与最终回复，不能把单元测试当成真实查询。

已完成的验证及其边界见 [2026-10-20 验收记录](community-discovery-acceptance-2026-10-20.md)。
