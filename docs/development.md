# 开发与验证

## 1. 环境

- Bun 1.4.4：依赖、workspace 与脚本入口。
- Node.js 24+（`engines.node >= 24`）：实际运行 API、worker、测试与 SDK 校验；CI 使用 Node.js 24。
- 测试文件为 TypeScript（`tests/*.test.ts`），由 `node --test` 直接运行：Node 的类型剔除非编译，只执行可擦除语法。
- PostgreSQL 16：持久化运行与集成测试；本地内存演示可不安装。

```bash
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run test
bun run sdk:check
bun run --cwd apps/console typecheck
bun run --cwd apps/console build
```

只维护 bun.lock；不要使用 bun --bun 将服务切换到 Bun 运行时。
根目录 typecheck/build 通过 TypeScript project references 检查并生成后端产物；`tests/tsconfig.json` 额外对测试代码做一次不产物（`noEmit`）的类型检查，关闭 `noUncheckedIndexedAccess`、其余保持 strict。控制台的类型检查与 Vite bundle 构建需单独执行，CI 同样检查这两项，不能只用后端构建代替前端验证。修改 OpenAPI 后运行 bun run sdk:generate，再运行 sdk:check。

## 2. 不接真实 IM 的本地演示

```powershell
Copy-Item .env.example .env
# 使用专用 Feishu 测试应用填写 FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_TENANT_KEY，
# 并把 Feishu OAuth 回调登记为 PUBLIC_ORIGIN/auth/feishu/callback。
bun run build
bun run start
```

POSIX shell 使用 `cp .env.example .env`。

启动控制台并在浏览器打开 `PUBLIC_ORIGIN`，完成飞书企业账号登录后，另一个终端可执行：

从浏览器开发者工具（Application/存储 → Cookies）复制当前登录的 `adpulse_session` 值，只在当前终端注入；不要提交到仓库或写入脚本。

```powershell
$env:ADPULSE_SESSION_COOKIE = "粘贴 adpulse_session 的值"
bun run demo
```

POSIX shell 使用 `export ADPULSE_SESSION_COOKIE="..."`。

start、worker、demo 脚本均显式使用 `node --env-file=.env` 加载仓库根目录的 .env；实际运行时是 Node.js。
demo 脚本直接调用同源 HTTP API，固定使用 demo 收件账户；控制台页面则使用生成类型的客户端：
创建会话 → 第一轮选择继续观察 → 第二轮确认 → 收到结束确认。
成功时打印 completed、2 个轮次、3 个策略快照和 3 次模拟投递。

注意：
- 不发送任何真实 IM 消息；demo: 开头的消息 ID 是模拟回执。
- 默认 reviewPolicy 不修改预算，不调用模型或采集新信息。
- 内存演示退出后数据丢失。
- 不要在无共享数据库时拆开 API 与独立 worker。
- 使用其他端口时，为 demo 设置 API_BASE_URL，如 http://127.0.0.1:3001。

## 3. 持久化与独立 worker

准备专用、可丢弃的开发数据库，设置 DATABASE_URL。首次启动会建立 schema baseline 并按版本应用迁移；不要把生产库或旧 operator/test 数据库用于 Issue #34 试验。

API 默认内嵌 worker。需要分进程时：

```powershell
# 两个进程必须指向相同 DATABASE_URL、使用相同账户配置。
$env:EMBED_WORKER = "0"; bun run start
# 另一个终端
bun run worker
```

POSIX shell 使用 `EMBED_WORKER=0 bun run start`。

DEMO_MODE=1 配合 DATABASE_URL 可以持久化模拟投递；关闭演示则必须配置真实渠道账户。
独立 worker 不处理浏览器登录，但需要 DATABASE_URL 与出站账户凭据。

## 4. 飞书接入

仅支持固定租户的企业内部自建应用；不是自定义群 webhook 机器人，也不是商店应用的多租户授权流程。

在 .env 中设置：

| 配置 | 用途 |
| --- | --- |
| DEMO_MODE=0 | 禁用模拟账户 |
| DATABASE_URL | 持久化数据库 |
| PUBLIC_ORIGIN | 浏览器实际访问的 origin；生产必须 HTTPS，OAuth 回调为 `/auth/feishu/callback` |
| FEISHU_APP_ID / FEISHU_APP_SECRET | 飞书 OAuth 应用凭据；仅服务端使用，短期访问令牌只用于身份核验、不持久化 |
| FEISHU_TENANT_KEY | 服务端核验授权身份所属企业 |
| FEISHU_ACCOUNT_ID | 机器人本地账户名，默认 feishu-internal |
| FEISHU_VERIFICATION_TOKEN | 校验回调来源 |
| FEISHU_ENCRYPT_KEY | 原始请求签名与 AES 解密 |

在飞书开发者后台启用机器人、消息发送权限和应用可用范围，并配置新版 card.action.trigger 回调。
公开 HTTPS 地址转发到：

```text
https://你的域名/webhooks/feishu-internal
```

账户名须与 FEISHU_ACCOUNT_ID 一致。API 只监听 127.0.0.1，需可信反向代理；代理不能重序列化 JSON，否则 `x-lark-*` 签名校验会失败。平台校验回调地址时只发加密体、不带签名头，但卡片回调必须带，所以整条链路仍须保留原始请求体和签名头。服务器需校时（±300s），且 challenge 需在 1 秒内返回。

创建 Session 时：
- accountId 使用配置的账户名。
- user 收件人使用 open_id，group 收件人使用 chat_id。
- allowedActorIds 使用明确允许点击的用户 open_id；群成员不自动获得决策权。
- 身份与权限还会在内核检查，actionRef 不是免认证令牌。

当前已用合成签名、AES 密文和模拟 HTTP API 测试协议；尚无真实凭据的真机联调证据。

### 真机联调自检

```powershell
bun run build
bun run feishu:acceptance -- --public-url https://你的域名/webhooks/feishu-internal --chat-id oc_xxx --open-id ou_xxx
```

POSIX shell 可用反斜杠续行；这里使用单行以便在 Windows PowerShell 中直接执行。

只读、脱敏探测：本地配置项、离线协议自检（真实 encrypt key 构造的验签/解密/身份拒绝/卡片动作）、
平台连通（`tenant_access_token`、租户匹配、机器人启用状态、时钟偏差）、可选收件人、本机 `/healthz`，
以及公网回调的未鉴权拒绝（401/403）与自签 challenge 往返。它不发送业务消息、不写业务数据，也**不能替代真机验收**：
平台触发的 challenge、单聊/群聊点击链路、失败与拒绝场景仍需人工执行。

`fail` 需先处理，`skip` 不计入验收，退出码非 0 表示存在 `fail`。
加 `--write` 会在 `docs/acceptance/records/` 生成验收记录骨架（该目录默认不入库）。
操作步骤与判读标准见[飞书真机联调 runbook](acceptance/feishu-e2e.md)。
服务端尚无专用的回调 ACK 时延指标，需按 runbook 第 9 节用代理日志等替代取数。

## 5. Web 控制台与接口

保持上述 API 在 127.0.0.1:3000 运行，另一个终端启动控制台：

```bash
cd apps/console
bun run dev
# 默认 http://localhost:5173/sessions
```

已有会话列表与详情，可查看轮次、选项、投递和快照摘要，并提交选择。当前没有创建会话表单，可先运行 `bun run demo` 生成演示记录；该脚本生成的是已完成会话。创建可操作的会话可参考脚本中的 POST /api/sessions 调用。

Vite 将同源 `/api`、`/auth`、`/webhooks` 请求代理到 127.0.0.1:3000，控制台与 API 不做跨域部署。`PUBLIC_ORIGIN` 必须与浏览器 origin 完全一致；Feishu 后台须登记 `${PUBLIC_ORIGIN}/auth/feishu/callback`。

登录采用 Feishu OAuth authorization code + PKCE；服务端检查授权用户的 tenant scope，身份键包含 platform、application、tenant、ID 类型和外部 ID。首次验证自动建立个人用户；不保存 access/refresh token，不提供静态 Bearer 或开发绕过。浏览器 session cookie 为 HttpOnly、SameSite=Lax，生产设置 Secure；服务端固定 8 小时绝对过期且不滑动，退出会撤销 session。所有有副作用的 `/api/*` 请求还必须携带与 `PUBLIC_ORIGIN` 一致的 `Origin`。控制台在受保护 API 返回 401 时携带经校验的站内 `returnTo` 跳转登录，退出会撤销会话并清空本地查询缓存。

接口清单见 contracts/openapi.json；HTTP 调用示例见 scripts/demo.mjs。页面通过 apps/console/src/adpulse-client.ts 的 consoleClient 使用生成类型，不手写另一套 HTTP 契约。

- `/api/*` 要求有效的 `adpulse_session` cookie；`POST`、`PATCH`、`PUT`、`DELETE` 还要求同源 `Origin`。浏览器不得自行持久化或注入认证 token。
- 创建与选择要求 UUID 格式 Idempotency-Key。
- 创建会话：同 owner 的已有 requestId 返回原会话，目前不比较新旧创建请求体。
- 提交选择：同一 sourceId + eventId、同规范化内容返回原 inbox；同键不同内容返回 409。一次操作的网络重试应复用键，新操作用新键。
- POST /api/choices 返回 202 仅表示已接收；查询 GET /api/choices/{inboxId} 或会话详情获知 processed/rejected/failed。路径中的 inboxId 需 URL 编码。
- 当前 Web 提交后只触发一次查询失效，尚未跟踪异步终态，必要时刷新详情核对。此限制由 [#11](https://github.com/JunLang-7/AdPulse/issues/11) 跟进；不能把按钮请求成功视为策略已变更。
- 会话详情包含轮次、actionRef、策略快照、投递和失败任务。
- POST /api/jobs/{jobId}/retry 仅允许所属用户重试 failed 任务。
- /healthz 只证明 HTTP 进程可响应，不是数据库/worker 就绪检查。

目前每个 Feishu 企业身份对应一个个人 AdPulse 用户；尚无协作、分享、委派、产品级白名单、RBAC 或完整策略差异界面。任务重试目前通过 API。sent 只代表渠道发送回执，不代表用户已读。

## 6. PostgreSQL 集成测试

TEST_DATABASE_URL 必须指向独立、可丢弃的测试数据库，不能使用生产数据库。
测试会建表并写入会话、事件和任务；重复执行会保留测试数据。

例如启动一次性容器（PowerShell）：

```powershell
docker run --rm -d --name adpulse-test-db -e POSTGRES_PASSWORD=local-test-password -e POSTGRES_DB=adpulse_test -p 127.0.0.1:5433:5432 postgres:16-alpine

# 等 pg_isready 返回成功后运行；容器刚启动时可能需要重试。
docker exec adpulse-test-db pg_isready -U postgres -d adpulse_test

$env:TEST_DATABASE_URL = "postgres://postgres:local-test-password@127.0.0.1:5433/adpulse_test"
bun run test

docker stop adpulse-test-db
```

POSIX shell 将设置变量与执行合并为 `TEST_DATABASE_URL=... bun run test`。
集成测试覆盖迁移基线/版本幂等、并发首次登录复用同一用户、身份唯一索引与重连后的会话，以及原有的 serializable 决策、回滚和任务租约。

未设置 TEST_DATABASE_URL 时，该集成测试明确显示 SKIP，其余测试仍执行。
CI 会启动 PostgreSQL service 并设置此变量，避免把跳过误判为完整验收。

## 7. 扩展与现有限制

新接 IM：在 channels 中实现 InboundChannel 和 OutboundChannel，构造 ChannelAccount，在 runtime 注册。增加原始请求/ACK、渲染、账户隔离与重试测试；不要把平台字段或 HTTP 响应移入 core。

更换策略：实现 PolicyEngine 并通过 compose 注入。候选必须带冻结的 changes 和 complete 标志；内核不信任模型的边界判断，会重复校验变更和操作者。

生产前仍需：
真实平台验收、在专用可丢弃数据库验证 schema baseline 与版本化迁移、数据保留策略、分页、限流/监控、失效原因提示和长任务租约续期。已实现的认证尚未经过真实应用/HTTPS 环境验收。发送前已有过期/失效投递抑制，但不撤回已送达卡片，也不能完全消除检查与发送间的竞态。消息端到端不承诺 exactly-once。

设计过程遵循 XEngineer 规范：工程提案与设计澄清由 Issue 承载，进入开发即定稿只读，变更新开增量说明；本文仅随实现维护使用方式。当前已合并交互内核与最小控制台，下一阶段待评审提案见 [#6](https://github.com/JunLang-7/AdPulse/issues/6)。
