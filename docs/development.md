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

start、worker、demo 脚本均显式使用 `node --env-file=.env` 加载仓库根目录的 .env；实际运行时是 Node.js。
demo 脚本直接调用 HTTP API，固定使用 demo 收件账户；控制台页面则使用生成类型的客户端：
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

## 5. Web 控制台与接口

保持上述 API 在 127.0.0.1:3000 运行，另一个终端启动控制台：

```bash
cd apps/console
bun run dev
# 默认 http://localhost:5173/sessions
```

已有会话列表与详情，可查看轮次、选项、投递和快照摘要，并提交选择。当前没有创建会话表单，可先运行 `bun run demo` 生成演示记录；该脚本生成的是已完成会话。创建可操作的会话可参考脚本中的 POST /api/sessions 调用。

Vite 将同源 `/api`、`/webhooks` 请求代理到 127.0.0.1:3000，默认不需要 CORS 配置。改 API 端口时需同时调整 Vite proxy 目标与 demo 的 API_BASE_URL；API_BASE_URL 不会自动修改 proxy。`VITE_API_BASE_URL` 可单独覆盖浏览器请求地址，跨域部署需另行配置。

控制台从根目录 .env 读取配置，`VITE_CONSOLE_TOKEN` 未设置时使用 CONSOLE_TOKEN。**该 token 会进入浏览器与构建产物，只适用于受控开发环境，禁止把带真实 token 的静态产物公开发布。** API 的静态 token 不是正式登录系统。

接口清单见 contracts/openapi.json；HTTP 调用示例见 scripts/demo.mjs。页面通过 apps/console/src/adpulse-client.ts 的 consoleClient 使用生成类型，不手写另一套 HTTP 契约。

- /api/* 要求 Authorization: Bearer <CONSOLE_TOKEN>。
- 创建与选择要求 UUID 格式 Idempotency-Key。
- 创建会话：同 owner 的已有 requestId 返回原会话，目前不比较新旧创建请求体。
- 提交选择：同一 sourceId + eventId、同规范化内容返回原 inbox；同键不同内容返回 409。一次操作的网络重试应复用键，新操作用新键。
- POST /api/choices 返回 202 仅表示已接收；查询 GET /api/choices/{inboxId} 或会话详情获知 processed/rejected/failed。路径中的 inboxId 需 URL 编码。
- 当前 Web 提交后只触发一次查询失效，尚未跟踪异步终态，必要时刷新详情核对。此限制由 [#11](https://github.com/JunLang-7/AdPulse/issues/11) 跟进；不能把按钮请求成功视为策略已变更。
- 会话详情包含轮次、actionRef、策略快照、投递和失败任务。
- POST /api/jobs/{jobId}/retry 仅允许所属用户重试 failed 任务。
- /healthz 只证明 HTTP 进程可响应，不是数据库/worker 就绪检查。

这是单一固定控制台用户的开发认证方案。已有最小会话页面，尚无登录/SSO、RBAC、多租户、完整策略差异或任务恢复界面；任务重试目前通过 API。sent 只代表渠道发送回执，不代表用户已读。

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
真实平台验收、正式认证、数据保留策略、版本化数据库迁移、分页、限流/监控、失效原因提示和长任务租约续期。发送前已有过期/失效投递抑制，但不撤回已送达卡片，也不能完全消除检查与发送间的竞态。消息端到端不承诺 exactly-once。

设计过程遵循 XEngineer 规范：工程提案与设计澄清由 Issue 承载，进入开发即定稿只读，变更新开增量说明；本文仅随实现维护使用方式。当前已合并交互内核与最小控制台，下一阶段待评审提案见 [#6](https://github.com/JunLang-7/AdPulse/issues/6)。

## 8. 下一阶段规格与验证记录

[效果证据闭环修订稿](proposals/effect-evidence-loop.md) 对齐 #6–#12 的任务边界、比较规则、补证流程、去重和 Web 验收，尚未实现；不以现有 demo 代替这些验收。

环境基线为本节顶部的 Bun/Node 版本；完整验证须同时运行第 1 节的根目录与控制台命令。记录所用 commit、操作系统、实际 Node/Bun 版本、命令结果与跳过项；PostgreSQL 未运行应明确标注。远端 CI 和本地结果分别附证据，合并不等于已提交独立 Review。
