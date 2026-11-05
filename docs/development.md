# 开发与验证

## 1. 环境

- Bun 1.4.4：依赖、workspace 与脚本入口。
- Node.js：实际运行 API、worker、测试与 SDK 校验；CI 使用 Node.js 24。
- PostgreSQL 16：持久化运行与集成测试；本地内存演示可不安装。

```bash
bun install --frozen-lockfile
bun run build
bun run test
bun run sdk:check
```

只维护 bun.lock；不要使用 bun --bun 将服务切换到 Bun 运行时。
typecheck/build 都通过 TypeScript project references 检查并生成产物。修改 OpenAPI 后运行 bun run sdk:generate，再运行 sdk:check。

## 2. 不接真实 IM 的本地演示

```bash
cp .env.example .env
# 编辑 .env，将 CONSOLE_TOKEN 换成随机长字符串。
bun run build
bun run start
```

另一个终端、在仓库根目录执行：

```bash
bun run demo
```

Bun 会为脚本加载 .env；Node 子进程继承环境变量。
demo 脚本调用生成契约的 SDK，固定使用 demo 收件账户：
创建会话 → 第一轮选择继续观察 → 第二轮确认 → 收到结束确认。
成功时打印 completed、2 个轮次、3 个策略快照和 3 次模拟投递。

注意：
- 不发送任何真实 IM 消息；demo: 开头的消息 ID 是模拟回执。
- 默认 reviewPolicy 不修改预算，不调用模型或采集新信息。
- 内存演示退出后数据丢失。
- 不要在无共享数据库时拆开 API 与独立 worker。
- 使用其他端口时，为 demo 设置 API_BASE_URL，如 http://127.0.0.1:3001。

## 3. 持久化与独立 worker

准备专用开发数据库，设置 DATABASE_URL。首次启动自动创建当前七张表和索引。
这只用于首次建库，未来结构变更需要版本化迁移。

API 默认内嵌 worker。需要分进程时：

```bash
# 两个进程必须指向相同 DATABASE_URL、使用相同账户配置。
EMBED_WORKER=0 bun run start
# 另一个终端
bun run worker
```

DEMO_MODE=1 配合 DATABASE_URL 可以持久化模拟投递；关闭演示则必须配置真实渠道账户。
独立 worker 不需要 CONSOLE_TOKEN，但需要 DATABASE_URL 与出站账户凭据。

## 4. 飞书接入

仅支持固定租户的企业内部自建应用；不是自定义群 webhook 机器人，也不是商店应用的多租户授权流程。

在 .env 中设置：

| 配置 | 用途 |
| --- | --- |
| DEMO_MODE=0 | 禁用模拟账户 |
| DATABASE_URL | 持久化数据库 |
| CONSOLE_TOKEN / CONSOLE_USER_ID | 控制台鉴权与固定用户 |
| FEISHU_ACCOUNT_ID | 本地账户名，默认 feishu-internal |
| FEISHU_APP_ID / FEISHU_APP_SECRET | 应用鉴权 |
| FEISHU_TENANT_KEY | 限定租户 |
| FEISHU_VERIFICATION_TOKEN | 校验回调来源 |
| FEISHU_ENCRYPT_KEY | 原始请求签名与 AES 解密 |

在飞书开发者后台启用机器人、消息发送权限和应用可用范围，并配置新版 card.action.trigger 回调。
公开 HTTPS 地址转发到：

```text
https://你的域名/webhooks/feishu-internal
```

账户名须与 FEISHU_ACCOUNT_ID 一致。API 只监听 127.0.0.1，需可信反向代理；代理不能重序列化 JSON，必须保留原始请求体和 x-lark-* 签名头。服务器需校时。

创建 Session 时：
- accountId 使用配置的账户名。
- user 收件人使用 open_id，group 收件人使用 chat_id。
- allowedActorIds 使用明确允许点击的用户 open_id；群成员不自动获得决策权。
- 身份与权限还会在内核检查，actionRef 不是免认证令牌。

当前已用合成签名、AES 密文和模拟 HTTP API 测试协议；尚无真实凭据的真机联调证据。

## 5. 控制台接口

接口清单见 contracts/openapi.json；业务层调用示例见 scripts/demo.mjs。
前端通过 apps/console 导出的 createConsoleClient 使用生成类型，不手写另一套 HTTP 契约。

- /api/* 要求 Authorization: Bearer <CONSOLE_TOKEN>。
- 创建与选择要求 UUID 格式 Idempotency-Key。
- 同一幂等键重试返回原操作；新操作使用新键。
- POST /api/choices 返回 202 仅表示已接收；查询 inbox 或会话详情获知 processed/rejected。
- 会话详情包含轮次、actionRef、策略快照、投递和失败任务。
- POST /api/jobs/{jobId}/retry 仅允许所属用户重试 failed 任务。
- /healthz 只证明 HTTP 进程可响应，不是数据库/worker 就绪检查。

这是单一固定控制台用户的开发认证方案，没有完整页面、登录/SSO、RBAC 或多租户能力。

## 6. PostgreSQL 集成测试

TEST_DATABASE_URL 必须指向独立、可丢弃的测试数据库，不能使用生产数据库。
测试会建表并写入会话、事件和任务；重复执行会保留测试数据。

例如启动一次性容器：

```bash
docker run --rm -d --name adpulse-test-db \
  -e POSTGRES_PASSWORD=local-test-password \
  -e POSTGRES_DB=adpulse_test \
  -p 127.0.0.1:5433:5432 postgres:16-alpine

# 等 pg_isready 返回成功后运行；容器刚启动时可能需要重试。
docker exec adpulse-test-db pg_isready -U postgres -d adpulse_test

TEST_DATABASE_URL=postgres://postgres:local-test-password@127.0.0.1:5433/adpulse_test bun run test

docker stop adpulse-test-db
```

未设置 TEST_DATABASE_URL 时，该集成测试明确显示 SKIP，其余测试仍执行。
CI 会启动 PostgreSQL service 并设置此变量，避免把跳过误判为完整验收。

## 7. 扩展与现有限制

新接 IM：在 channels 中实现 InboundChannel 和 OutboundChannel，构造 ChannelAccount，在 runtime 注册。增加原始请求/ACK、渲染、账户隔离与重试测试；不要把平台字段或 HTTP 响应移入 core。

更换策略：实现 PolicyEngine 并通过 compose 注入。候选必须带冻结的 changes 和 complete 标志；内核不信任模型的边界判断，会重复校验变更和操作者。

生产前仍需：
真实平台验收、正式认证、数据保留策略、版本化数据库迁移、分页、限流/监控、过期投递抑制和长任务租约续期。消息端到端不承诺 exactly-once。

设计过程草稿遵循 XEngineer 规范：本地评审稿保存在被忽略的 .local/designs 中，确认后归档到 Issue；本次未自动发布 Issue 或执行 PR 合并。
