# 架构导览

本文是面向开发与运行的**当前实现导览**，随代码维护，不是产品/架构设计定稿。当前交接基线为已合并的 [#3](https://github.com/JunLang-7/AdPulse/pull/3)、[#5](https://github.com/JunLang-7/AdPulse/pull/5) 与堆叠合并的 [#26](https://github.com/JunLang-7/AdPulse/pull/26)、[#31](https://github.com/JunLang-7/AdPulse/pull/31)、[#32](https://github.com/JunLang-7/AdPulse/pull/32)、[#42](https://github.com/JunLang-7/AdPulse/pull/42)。历史设计 [#2](https://github.com/JunLang-7/AdPulse/issues/2) 不回写；下一阶段讨论见待评审的 [#6](https://github.com/JunLang-7/AdPulse/issues/6)，新增设计与变更继续由 Issue 承载。

## 当前范围

已实现的是「决策交互子系统」：
输入信号与方案 → 生成候选卡片 → 异步投递 → 接收选择 → 更新内部方案 → 下一轮或结束确认。

它不自动执行广告操作。默认策略只提供确认、继续观察和忽略；真实策略变更通过可替换的 PolicyEngine 产生并由内核校验。继续观察目前立即进入下一轮，不代表已接入定时采集。

- 飞书：已实现原生 HTTP 出入站代码，尚未完成真实应用真机联调。
- 企微 / 钉钉：尚未实现原生接入；可通过相同契约扩展。
- Web：已有 API、OpenAPI、类型化客户端和控制台：会话列表、详情、选项提交、轮次/投递/快照摘要、任务编辑与效果证据。会话详情已提供当前方案摘要、逐版变更记录及最早快照到当前的结构化对比；尚无完整证据追溯界面与失败任务恢复界面。
- 任务规则版本与效果证据：已实现固定 JSON 导入、不可变证据版本与幂等操作（#7、#8）。
- 期次比较与阈值判定：已实现显式选择当前/基线证据、严格可比性校验与补证跟进（#9）。
- 调查告警：已实现逻辑缺口告警、冻结期限与失效处理（#10、#55）；新候选可经 #83 的独立确认和部署闸门进入飞书单聊 outbox，默认关闭，不补历史。受控真机验收与试验实例迁移尚未执行，见开发指南 §5.4。
- 市场/竞品事件（#38）：已实现本人录入、来源完整性/引用检查、修订与材料追溯，以及内部列表条目规范化入口；未进行独立来源核验，也未接 #39 的自动采集调度。
- 生命周期（#40）：已实现 365 天到期判定与读取限访（可注入时钟、判定查询），
  以及本人确认删除（同事务墓碑 + 抑制待发 + 删除清单，迁移 15）；删除后旧任务与其历史一律不可访问。
  在线清理（删除清单到期后按依赖顺序物理删除任务全部关联、保留期到期任务同样排单清理）已实现，
  由 worker 每小时单飞触发；最小审计 `auditEvents` 独立保留 180 天；
  删除清单可外置为逐行 JSON 并在恢复后重放（`replay`），备份 30 天淘汰为软目标；
  **生产备份目标、加密、RPO/RTO 与受控备份仍未实现**（目前只有手工备份 + 一次性演练库验证不复活）；
  恢复重放会撤销恢复库中的全部会话，清理进度可在任务页按人查看。
- 受限来源采集：已实现两站列表页的标题/链接采集，**默认关闭**，见下文「受限来源采集」（#41）；
  #39 方案 A 只把条目作为「待确认线索」按本人逐来源开关展示，不自动建事件、不自动推送；
  来源清单与许可登记见 [sources/registry.md](sources/registry.md)（登记不等于合规结论）。
- 主动通知（#37）：已实现批次/去重、09:30 调度与发送前重检、退订取消、记录与解释（PR1/PR2/PR4）；
  决策卡受控投递见 #83。#112 第一阶段新增效果告警的本人任务订阅筛选、事务内入队与历史筛选记录；
  第二阶段接入 #38 的明确事件（`evidence_ready` + 非模拟 + 显式主体/任务关联，对象一般事件需 `include_general`）。
  补证（`evidence`）类别、#39 自动来源与事件→决策卡仍未接入。
  既有合成日汇总的受控单账号验收见 #37；本次生产筛选路径尚未部署或真机验收。
- 企业飞书身份登录与个人权限（#34）：已实现 OAuth + PKCE 登录、个人账号建立、可撤销的浏览器会话与按 open_id 的机器人身份映射（#43/#45/#48）；
  会话时效、滑动与重新验证见下文「控制台与验证」。
- 生命周期（#40）已按范围收口：365 天到期与限访、本人删除 + 7 天在线清理、180 天最小审计、
  删除清单外置与恢复重放、手工备份与淘汰均已交付；**自动备份 / 加密 / RPO / 身份认领明确不做**。
- 仍未实现：市场/竞品事件和补证的订阅输入、自动广告操作。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| [core](../packages/core/src/) | 决策用例、冻结候选、授权与边界校验、轮次和策略快照、worker |
| [channels](../packages/channels/src/) | 入站协议、平台响应、卡片渲染、鉴权与发送 |
| [storage](../packages/storage/src/) | PostgreSQL 事务/队列；内存实现只供测试与演示 |
| [runtime](../packages/runtime/src/) | 选择实现并组装，API 与独立 worker 复用 |
| [api](../apps/api/src/) | HTTP、请求校验、控制台认证、webhook 路由 |
| [worker](../apps/worker/src/) | 独立运行同一个 worker，需共享 PostgreSQL |
| [console](../apps/console/src/) | Vite/React 控制台，通过 OpenAPI 生成类型与 openapi-fetch 调用 API |

编译期依赖：channels/storage → core；runtime → core/channels/storage；应用入口 → runtime。
core 不依赖具体 IM、HTTP、数据库驱动或应用入口。依赖边界由 [测试](../tests/boundaries.test.ts) 检查。

## 出入站适配

入站接口见 [contracts.ts](../packages/channels/src/contracts.ts)：
验签、解密、校验应用与租户，转换为 ChoiceCommand，并构造平台特有的 challenge/ACK。

回调地址校验（`url_verification`）由平台以加密体推送，**不带 `x-lark-*` 头**。因此验签是可选的：带了签名就必须通过（时间戳 ±300s、sha256 比对），没带时仅接受加密体且解密成功并通过 `token` 校验的场景；其余事件缺签名头一律 `401 missing signature`。签名失败仍在解密前返回，避免把解密错误当作鉴权前 oracle。

[ChannelRegistry](../packages/channels/src/gateway.ts) 负责按账户路由。对于点击事件，**inbox 和任务成功提交后才返回 ACK**。ACK 仅表示接收成功，处理结果异步产生。

出站接口见 [channel.ts](../packages/core/src/ports/channel.ts)：
OutboundChannel 接收包含稳定 delivery.id、收件人、卡片与 actionRef 的投递信封。适配器渲染原生卡片并返回平台消息 ID。

按钮只带不透明 actionRef；候选操作和策略变更在服务端保存。新接平台不需要修改业务内核，但必须单独实现协议与接入测试。

## 一致性与状态

[Storage](../packages/core/src/ports/storage.ts) 提供可重试的事务回调，事务中不能做网络 I/O。
PostgreSQL 使用 SERIALIZABLE、行锁、唯一索引与冲突重试。

一次选择在同一事务内完成授权/期限/版本检查、轮次消费、策略快照、Session 更新及后续任务写入。异常全部回滚。PolicyEngine 的慢计算在事务外运行，提交前重新检查状态与版本。

- Session：planning / awaiting_input / completed / cancelled。
- Round：open / answered，与消息是否送达分开。
- Inbox：pending / processed / rejected / failed；rejected 是业务拒绝，failed 是处理任务重试耗尽的系统故障。
- Delivery：pending / sent / failed / cancelled；purpose 区分 decision 和 confirmation，并记录 expiresAt。
- Job：pending / running / done / failed。

version 是决策版本，每次成功处理选择都会递增，即使 changes 为空；快照版本增加不等于预算或其他策略字段发生变化。

## 策略变更词表

变更只能通过 `StrategyChange` 表达，并由内核在冻结候选和提交选择时重复校验；PolicyEngine 的声明不被信任。

- 渠道：`budget`、`bidCpc`、`enabled`，带 `from` 做过期检查，数值受 `Limits` 比例限幅。
- 列表：`audience`、`sellingPoint`、`contentDirection`、`partner`，`op` 为 `add`/`remove`。单候选最多 6 条变更，列表最多 8 项，单项不超过 80 字符，且不允许首尾空白或控制字符；`add` 要求当前不含该项、`remove` 要求当前含该项，否则视为过期。
- 语义边界：`contentDirections` 与 `partners` 只是站内基线名称，不代表已发布、已联系或已投放；不记录合作阶段、费用或效果指标。
- 未支持：投放方式类型（付费广告/达人/种草）、合作阶段与达人/种草效果指标尚未建模，**不支持即拒绝**，不做静默降级。

`isMonetaryChange()` 区分花钱变更（预算/出价）。任务货币口径未确认时只能提议非货币变更，人群、卖点、内容方向、合作对象与开关不受限。变更随快照以 JSONB 保存，旧版三类变更按宽化后的联合类型原样读取，无需迁移。

候选可带可选的 `hypothesis` 与 `validationPlan`（各不超过 300 字、单行、不带首尾空白），内核校验后随轮次冻结；卡片把它们作为选项补充说明展示，不塞进按钮文本。用户接受候选时，这两个字段同时写入策略快照，事后可核对「当时为什么改、准备怎么验证」。缺省表示未确定，不编造。

## 验证检查点

接受带 `validationPlan` 的候选且任务口径完整（指标、窗口、阈值、最低样本）时，在同一事务创建 `pending` 检查点，并在 `dueAt`（接受时间 + `statWindowDays`）排入 `evaluate_validation_check` 任务。没有验证计划、没有实际变更或口径不完整时不建，避免制造假验证。

到期评估只读取同一任务版本、接受之后产生、可评估的比较结果，记录 `observedOutcome`（指标低于/高于阈值）与证据引用；没有可比证据、任务已删除或规则版本已变更时记为 `inconclusive` 并写原因。`inconclusive` 可由 owner 在新证据导入后手动重评一次；`observed` 是终态，不回退。它不推断因果、不修改策略、不触发广告平台操作。检查点随会话详情返回，仅 owner 可见；任务清理时一并删除。下一轮 `PolicyEngine` 可选收到同一任务最近 5 条检查点作为只读上下文，默认策略忽略。

模型见 [model.ts](../packages/core/src/state/model.ts)，实际 DDL 与索引见 [postgres.ts](../packages/storage/src/postgres.ts)。
当前为 49 张 id + jsonb 表，采用应用层引用关系。结构变更走 `initialize()` 内的版本化迁移（版本 1–18，顺序、加法式，在 advisory lock 下执行）。存储端口仍采用全表读取，通知记录与筛选记录接口提供分页，面向小规模验证。

迁移 13 由 #86 PR1 新增 `userModelConnections`、`userModelCredentials` 与 `userModelPreferences`，分别保存连接信息、AES-256-GCM 密文和默认模型。唯一索引分别约束 `(ownerId, providerId)`、`(ownerId, connectionId)` 与 `ownerId`。加密端口在 core，实现在 runtime。AAD 绑定 owner、连接、凭据版本、目标地址和协议。服务只在主密钥配置有效时装配，主密钥由部署侧配置。

迁移 14 新增 `userModelRevocations`，记录 owner、连接 ID、凭据版本、原因与时间。恢复备份后先用 `bun run models:revocations --replay` 重放删除记录再对外服务。撤销记录版本不低于凭据版本时拒绝解密。

迁移 17 新增假设偏差的四张表（假设、版本、判定与幂等操作），随 #161 落地。

迁移 18 新增 `validationChecks`，保存已应用变更的验证状态与证据引用；不改变策略、证据与投放记录。

模型额度分两层：按 owner（6 次/分钟、并发 1）与实例总量（8 次/分钟、并发 2），测试、发现与抽取共用计数，均在网络请求前判定；`createUserRequestBudgets()` 只约束单进程，不是分布式限流。

模型调用的出网层在 [model-egress.ts](../packages/runtime/src/model-egress.ts)：只允许 HTTPS，按全部 DNS 结果校验公网地址并把连接绑定到已校验地址，不跟随重定向，不读环境代理，限制响应大小与超时。自定义 API 仍属于个人连接，不允许绕开这层直接发请求。

已适配的原生协议为 `openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`；枚举之外的协议在边界返回 400，不降级。前三种走锁定 pi-ai 适配器，Gemini 因适配器拒绝自定义 fetch 而由 [model-gemini.ts](../packages/runtime/src/model-gemini.ts) 自研受控传输。供应商覆盖、认证类型与差异清单由目录生成：[model-provider-coverage.md](model-provider-coverage.md)。其中“真实供应商验收”统一为未验收，不因目录存在或合成测试通过而改写。

## 任务与发送语义

[Worker](../packages/core/src/worker.ts) 使用数据库抢占任务、60 秒租约、租约令牌回写保护、指数退避和失败状态；失败任务可由所属控制台用户手动重试。

网络发送在事务外进行。飞书发送重用 delivery.id 为 uuid，超过 50 字符时使用稳定哈希截取值，平台去重窗口为一小时。
**系统不承诺跨平台端到端 exactly-once**：外部已发送但本地未回写时，重试仍可能造成重复，尤其在去重窗口以外。

发送前已检查会话/轮次的有效期与状态：失效的 pending 投递标记 cancelled，不调用渠道；decision 卡还要求轮次 open、会话 awaiting_input，confirmation 卡也会因过期或会话取消而被抑制。这不是撤回平台上已送达的卡片，也不能消除检查后到实际发送之间的竞态；旧卡点击仍由内核拒绝。

新效果排查决策卡只在候选冻结事务中生成，复用 Session/Round/ActionRef 与 Delivery；不扫描旧轮次或构造占位策略。
投递保存设置/授权/目的地快照并在每次发送前复检，免打扰延后不续期；抑制待发不覆盖业务决定或本人回执。
`send_investigation_decision` 仍由同一个 worker/outbox 消费，需协调升级全部消费者，不能交给旧版消费。

当前尚无租约续期、Session 自动过期状态或面向用户的完整失效原因提示。单独扩容 worker 必须连接同一 PostgreSQL，不能使用两个独立内存存储。

## 受限来源采集

仅覆盖两个 allowlist 站点（潍柴新闻与事件、海尔品牌资讯）的列表页，只保存标题、原文链接与列表日期，**不抓正文、不存摘要**。合规前提与风险记录见 [#41](https://github.com/JunLang-7/AdPulse/issues/41)：Gate 0 未签核，产品方决定推进；`SOURCES_ENABLED` 默认关闭，未设置时不发起任何请求。

- 端口：[SourceFetcher](../packages/core/src/source-service.ts) 由 runtime 实现（[source-fetch.ts](../packages/runtime/src/source-fetch.ts)）；core 不引入 HTTP。
- 取数器只允许 HTTPS、按 DNS 解析结果固定公网地址、逐跳重验重定向、限制 1 MiB 与超时，拒绝压缩响应与非文本 `Content-Type`。
- 实体：`sourceStates`（停止/恢复与清理水位）、`sourceRuns`（每次尝试与失败原因）、`sourceSnapshots`（key + 内容哈希，30 天）、`sourceItems`（标题/链接/日期，`active` 或 `purged`）。
- 调度：[runSources](../packages/runtime/src/source-runner.ts) 在 worker 内按 Asia/Shanghai 08/12/16/20 各跑一次，重启只补当前时段，不回放历史时段。
- 配额：每站每日 6 次请求 = 5 次列表抓取 + 1 次 robots（每日仅取一次并缓存）。
- robots：2xx 遵从 `Disallow`/`Allow`（最长匹配、Allow 优先）与 `Crawl-delay`；4xx 视为无限制；5xx/不可达保守停止。
- 失败语义：空列表、结构变化、超时、5xx 一律只记 `sourceRuns`，**不修改任何条目**；连续 3 次失败或 403/429 升级为 `stopped`，只能由 `resume(source, now, operator)` 人工恢复。
- 清除：`purge(source, now)` 置空标题、删除快照并保留条目身份，后续再出现也不复活。运维入口为 `bun run sources`。
- 市场事件去重（#38）仅在本人、关注对象/类别的明确作用域内使用事件标识与 URL 别名；跨链接转载由本人修订关联，不做自动语义聚类。
- 未实现：卡片展示（归 #37）、`gone` 推断（只取首屏，无法区分撤稿）。

## 控制台与验证

[OpenAPI](../contracts/openapi.json) 是 REST 契约；[adpulse-client.ts](../apps/console/src/adpulse-client.ts) 通过生成类型提供前端访问入口。界面只展示已有能力：侧栏为会话列表，底部为使用文档/问题反馈，不设占位页面。

控制台选择接口返回 202 只表示 inbox 已接收。当前界面提交后仅失效查询一次，尚未持续跟踪异步终态，可能要刷新才能看到最终处理结果；完善此行为见 [#11](https://github.com/JunLang-7/AdPulse/issues/11)。投递的 sent 表示渠道发送成功回执，不证明接收人已阅读。

「通知记录」（`/settings/notification-records`）包含 #37 的汇总/投递投影和 #112 的筛选历史：
列出本人汇总批次、条目与投递回执，并说明「为什么收到/没收到」。它不发消息、不改状态，也不提供
按 id 直取的跨用户入口。筛选历史保留输入引用、当时设置版本、命中项与原因，不用现在的设置改写历史；
查看时再次校验任务、告警、证据与事件引用的本人归属。详情见开发指南 §5.5、§5.7。

控制台使用 Feishu OAuth authorization code + PKCE 建立身份绑定和 HttpOnly 会话。服务端以 platform、application、tenant、ID 类型和外部 ID 共同限定身份，不持久化 Feishu access/refresh token；session cookie 在生产环境为 Secure、HttpOnly、SameSite=Lax。会话时效随控制台上报的活动滑动：默认 24 小时无活动或登录起 7 天（以先到者为准）失效，勾选「记住我」为 7 天 / 30 天；旧版会话仍按 8 小时绝对过期。令牌轮换带短暂宽限期，敏感写入（当前为模型凭据写入/删除）要求最近 15 分钟内重新验证过飞书身份。副作用 API 请求校验同源 Origin。当前没有协作、分享、委派或产品级白名单，不是 RBAC 系统。 机器人入站动作同样按该作用域映射到内部用户，并要求操作者就是会话 owner；未建立绑定或非 owner 的动作会被拒绝，通知授权与身份映射分开。

测试覆盖重复/并发选择、事务回滚、越权/过期、方案限制、慢提案版本冲突、租约恢复、平台协议和 SDK→HTTP 链路。PostgreSQL 集成测试需独立测试库；未配置时会跳过。

运行方式、环境变量与演示见 [开发指南](development.md)。
