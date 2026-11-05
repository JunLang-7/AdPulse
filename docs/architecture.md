# 架构导览

本文是面向开发与运行的**当前实现导览**，随代码维护，不是产品/架构设计定稿。当前交接基线为已合并的 [#3](https://github.com/JunLang-7/AdPulse/pull/3) 与 [#5](https://github.com/JunLang-7/AdPulse/pull/5)。历史设计 [#2](https://github.com/JunLang-7/AdPulse/issues/2) 不回写；下一阶段讨论见待评审的 [#6](https://github.com/JunLang-7/AdPulse/issues/6)，新增设计与变更继续由 Issue 承载。

## 当前范围

已实现的是「决策交互子系统」：
输入信号与方案 → 生成候选卡片 → 异步投递 → 接收选择 → 更新内部方案 → 下一轮或结束确认。

它不自动执行广告操作。默认策略只提供确认、继续观察和忽略；真实策略变更通过可替换的 PolicyEngine 产生并由内核校验。继续观察目前立即进入下一轮，不代表已接入定时采集。

- 飞书：已实现原生 HTTP 出入站代码，尚未完成真实应用真机联调。
- 企微 / 钉钉：尚未实现原生接入；可通过相同契约扩展。
- Web：已有 API、OpenAPI、类型化客户端和最小控制台：会话列表、详情、选项提交、轮次/投递/快照摘要。尚无创建表单、完整证据追溯、策略差异及失败任务恢复界面。
- 信号采集、比较基线、提醒分级与去重：不在当前子系统中。

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
当前为七张 id + jsonb 表，采用应用层引用关系；尚无版本化迁移和分页，面向小规模验证。

## 任务与发送语义

[Worker](../packages/core/src/worker.ts) 使用数据库抢占任务、60 秒租约、租约令牌回写保护、指数退避和失败状态；失败任务可由所属控制台用户手动重试。

网络发送在事务外进行。飞书发送重用 delivery.id 为 uuid，平台去重窗口为一小时。
**系统不承诺跨平台端到端 exactly-once**：外部已发送但本地未回写时，重试仍可能造成重复，尤其在去重窗口以外。

发送前已检查会话/轮次的有效期与状态：失效的 pending 投递标记 cancelled，不调用渠道；decision 卡还要求轮次 open、会话 awaiting_input，confirmation 卡也会因过期或会话取消而被抑制。这不是撤回平台上已送达的卡片，也不能消除检查后到实际发送之间的竞态；旧卡点击仍由内核拒绝。

当前尚无租约续期、Session 自动过期状态或面向用户的完整失效原因提示。单独扩容 worker 必须连接同一 PostgreSQL，不能使用两个独立内存存储。

## 控制台与验证

[OpenAPI](../contracts/openapi.json) 是 REST 契约；[adpulse-client.ts](../apps/console/src/adpulse-client.ts) 通过生成类型提供前端访问入口。界面只展示已有能力：侧栏为会话列表，底部为使用文档/问题反馈，不设占位页面。

控制台选择接口返回 202 只表示 inbox 已接收。当前界面提交后仅失效查询一次，尚未持续跟踪异步终态，可能要刷新才能看到最终处理结果；完善此行为见 [#11](https://github.com/JunLang-7/AdPulse/issues/11)。投递的 sent 表示渠道发送成功回执，不证明接收人已阅读。

控制台使用静态 Bearer token 映射到一个用户，尚不是多租户权限系统。Vite 会将开发 token 注入浏览器，打包时也会进入前端产物，不能把此方案作为公开部署的安全认证。

测试覆盖重复/并发选择、事务回滚、越权/过期、方案限制、慢提案版本冲突、租约恢复、平台协议和 SDK→HTTP 链路。PostgreSQL 集成测试需独立测试库；未配置时会跳过。

运行方式、环境变量与演示见 [开发指南](development.md)。
