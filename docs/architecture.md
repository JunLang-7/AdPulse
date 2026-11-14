# 架构导览

本文是面向开发与运行的**当前实现导览**，随代码维护，不是产品/架构设计定稿。当前交接基线为已合并的 [#3](https://github.com/JunLang-7/AdPulse/pull/3)、[#5](https://github.com/JunLang-7/AdPulse/pull/5) 与堆叠合并的 [#26](https://github.com/JunLang-7/AdPulse/pull/26)、[#31](https://github.com/JunLang-7/AdPulse/pull/31)、[#32](https://github.com/JunLang-7/AdPulse/pull/32)、[#42](https://github.com/JunLang-7/AdPulse/pull/42)。历史设计 [#2](https://github.com/JunLang-7/AdPulse/issues/2) 不回写；下一阶段讨论见待评审的 [#6](https://github.com/JunLang-7/AdPulse/issues/6)，新增设计与变更继续由 Issue 承载。

## 当前范围

已实现的是「决策交互子系统」：
输入信号与方案 → 生成候选卡片 → 异步投递 → 接收选择 → 更新内部方案 → 下一轮或结束确认。

它不自动执行广告操作。默认策略只提供确认、继续观察和忽略；真实策略变更通过可替换的 PolicyEngine 产生并由内核校验。继续观察目前立即进入下一轮，不代表已接入定时采集。

- 飞书：已实现原生 HTTP 出入站代码，尚未完成真实应用真机联调。
- 企微 / 钉钉：尚未实现原生接入；可通过相同契约扩展。
- Web：已有 API、OpenAPI、类型化客户端和最小控制台：会话列表、详情、选项提交、轮次/投递/快照摘要。尚无创建表单、完整证据追溯、策略差异及失败任务恢复界面。
- 任务规则版本与效果证据：已实现固定 JSON 导入、不可变证据版本与幂等操作（#7、#8）。
- 期次比较与阈值判定：已实现显式选择当前/基线证据、严格可比性校验与补证跟进（#9）。
- 调查告警：已实现逻辑缺口告警、冻结期限与失效处理（#10、#55）；新候选可经 #83 的独立确认和部署闸门进入飞书单聊 outbox，默认关闭，不补历史。受控真机验收与试验实例迁移尚未执行，见开发指南 §5.4。
- 受限来源采集：已实现两站列表页的标题/链接采集，**默认关闭**，见下文「受限来源采集」（#41）。
- 主动通知（#37）：已实现批次/去重、09:30 调度与发送前重检、退订取消、记录与解释（PR1/PR2/PR4）；
  决策卡受控投递见 #83。**尚无订阅筛选生产者**（依赖 #38/#39），生产环境不会自动产生汇总，
  真实飞书推送未验收。
- 企业飞书身份登录与个人权限（#34）：已实现 OAuth + PKCE 登录、个人账号建立、可撤销的浏览器会话与按 open_id 的机器人身份映射（#43/#45/#48）；
  会话时效、滑动与重新验证见下文「控制台与验证」。
- 仍未实现：个人订阅筛选与推送（#37 的筛选与真机验收）、自动广告操作。

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

模型见 [model.ts](../packages/core/src/state/model.ts)，实际 DDL 与索引见 [postgres.ts](../packages/storage/src/postgres.ts)。
当前为 25 张 id + jsonb 表，采用应用层引用关系；结构变更走 `initialize()` 内的版本化迁移（版本 1–11，顺序、加法式，在 advisory lock 下执行）。尚无分页，面向小规模验证。

个人模型连接（#86 PR1）另有四张表（第 12 版迁移新增撤销墓碑：`userModelRevocations`，只含 owner、连接 id、凭据版本、原因与时间，用于恢复备份后重新执行删除）：`userModelConnections`（非敏感投影、版本、验证结果）、`userModelCredentials`（每条连接一份 AES-256-GCM 密文，密文与 nonce/tag 分列）、`userModelPreferences`（本人默认 `(connectionId, modelId)`）。唯一索引分别约束 `(ownerId, providerId)`、`(ownerId, connectionId)` 与 `ownerId`。加密端口在 core，实现在 runtime；AAD 绑定 owner/连接/凭据版本/目标地址/协议，主密钥不在数据库里。服务只在主密钥配置有效时装配，否则整个能力失败关闭。恢复备份会回滚墓碑表，因此必须先用 `bun run models:revocations --replay` 重放删除记录再对外服务；墓碑版本不低于凭据版本时拒绝解密。

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
- 未实现：卡片展示（归 #37）、语义去重（归 #38）、`gone` 推断（只取首屏，无法区分撤稿）。

## 控制台与验证

[OpenAPI](../contracts/openapi.json) 是 REST 契约；[adpulse-client.ts](../apps/console/src/adpulse-client.ts) 通过生成类型提供前端访问入口。界面只展示已有能力：侧栏为会话列表，底部为使用文档/问题反馈，不设占位页面。

控制台选择接口返回 202 只表示 inbox 已接收。当前界面提交后仅失效查询一次，尚未持续跟踪异步终态，可能要刷新才能看到最终处理结果；完善此行为见 [#11](https://github.com/JunLang-7/AdPulse/issues/11)。投递的 sent 表示渠道发送成功回执，不证明接收人已阅读。

「通知记录」（`/settings/notification-records`，`NotificationRecordService`）是 #37 的只读投影：
列出本人汇总批次、条目与投递回执，并说明「为什么收到/没收到」。它不发消息、不改状态，也不提供
按 id 直取的跨用户入口；详情见开发指南 §5.5。

控制台使用 Feishu OAuth authorization code + PKCE 建立身份绑定和 HttpOnly 会话。服务端以 platform、application、tenant、ID 类型和外部 ID 共同限定身份，不持久化 Feishu access/refresh token；session cookie 在生产环境为 Secure、HttpOnly、SameSite=Lax。会话时效随控制台上报的活动滑动：默认 24 小时无活动或登录起 7 天（以先到者为准）失效，勾选「记住我」为 7 天 / 30 天；旧版会话仍按 8 小时绝对过期。令牌轮换带短暂宽限期，敏感写入（当前为模型凭据写入/删除）要求最近 15 分钟内重新验证过飞书身份。副作用 API 请求校验同源 Origin。当前没有协作、分享、委派或产品级白名单，不是 RBAC 系统。 机器人入站动作同样按该作用域映射到内部用户，并要求操作者就是会话 owner；未建立绑定或非 owner 的动作会被拒绝，通知授权与身份映射分开。

测试覆盖重复/并发选择、事务回滚、越权/过期、方案限制、慢提案版本冲突、租约恢复、平台协议和 SDK→HTTP 链路。PostgreSQL 集成测试需独立测试库；未配置时会跳过。

运行方式、环境变量与演示见 [开发指南](development.md)。
