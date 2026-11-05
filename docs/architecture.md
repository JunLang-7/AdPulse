# 架构导览

本文说明**当前代码如何组织和运行**，不是已通过评审的产品/架构定稿。设计讨论应按 XEngineer 规范在 Issue 中确认，进入开发后的变更另写增量设计。

## 当前范围

已实现的是「决策交互子系统」：
输入信号与方案 → 生成候选卡片 → 异步投递 → 接收选择 → 更新内部方案 → 下一轮或结束确认。

它不自动执行广告操作。默认策略只提供确认、继续观察和忽略；真实策略变更通过可替换的 PolicyEngine 产生并由内核校验。继续观察目前立即进入下一轮，不代表已接入定时采集。

- 飞书：已实现原生 HTTP 出入站代码，尚未完成真实应用真机联调。
- 企微 / 钉钉：尚未实现原生接入；可通过相同契约扩展。
- Web：已实现 API、OpenAPI 和类型化 SDK；没有完整控制台页面。
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
| [console](../apps/console/src/) | 根据 OpenAPI 生成类型的客户端 SDK |

编译期依赖：channels/storage → core；runtime → core/channels/storage；应用入口 → runtime。
core 不依赖具体 IM、HTTP、数据库驱动或应用入口。依赖边界由 [测试](../tests/boundaries.test.mjs) 检查。

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
- Inbox：pending / processed / rejected。
- Delivery：pending / sent / failed。
- Job：pending / running / done / failed。

模型见 [model.ts](../packages/core/src/state/model.ts)，实际 DDL 与索引见 [postgres.ts](../packages/storage/src/postgres.ts)。
当前为七张 id + jsonb 表，采用应用层引用关系；尚无版本化迁移和分页，面向小规模验证。

## 任务与发送语义

[Worker](../packages/core/src/worker.ts) 使用数据库抢占任务、60 秒租约、租约令牌回写保护、指数退避和失败状态；失败任务可由所属控制台用户手动重试。

网络发送在事务外进行。飞书发送重用 delivery.id 为 uuid，平台去重窗口为一小时。
**系统不承诺跨平台端到端 exactly-once**：外部已发送但本地未回写时，重试仍可能造成重复，尤其在去重窗口以外。

当前尚无租约续期或过期投递自动撤销；旧卡点击会被内核拒绝，但长期积压仍可能送达旧卡。单独扩容 worker 必须连接同一 PostgreSQL，不能使用两个独立内存存储。

## 控制台与验证

[OpenAPI](../contracts/openapi.json) 是 REST 契约；[SDK](../apps/console/src/index.ts) 是前端访问入口。
控制台使用静态 Bearer token 映射到一个用户，尚不是多租户权限系统。

测试覆盖重复/并发选择、事务回滚、越权/过期、方案限制、慢提案版本冲突、租约恢复、平台协议和 SDK→HTTP 链路。PostgreSQL 集成测试需独立测试库；未配置时会跳过。

运行方式、环境变量与演示见 [开发指南](development.md)。
