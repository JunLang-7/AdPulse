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

### 分阶段创建推广任务

新建任务依次收集推广内容、人群与卖点、投放渠道，最后核对和创建。每阶段都可以回上一步修改。产品或服务名称是唯一必填项，其他阶段可留空提交，也可切换到直接填表。观察范围可写“只看小红书新品试用活动”，日期未定时可留空。第一份报表和成本目标确认后，再按报表口径补齐提醒条件。

“补充说明或文件”支持 UTF-8 的 TXT、Markdown、CSV，文件在浏览器里转为可编辑的文字。本阶段的选项和补充文字在点击“提交本阶段”后才发送到模型服务，上限 2,500 字。阶段结果只用于本次待确认草稿，金额、日期和提醒条件由用户补充。整理服务不可用时，可选择按已填写内容继续。

模型调用在服务端通过 pi-ai 统一适配。API 进程默认读取 `DEEPSEEK_API_KEY`。使用另一供应商的 HTTPS OpenAI-compatible 网关时，在 API 进程的本地 `.env` 中同时设置：

```dotenv
TASK_DRAFT_PROVIDER=openai-compatible
TASK_DRAFT_GATEWAY_BASE_URL=https://gateway.example/v1
TASK_DRAFT_GATEWAY_MODEL=your-model-id
TASK_DRAFT_GATEWAY_API_KEY=
```

由部署者选择一个提供方。网关需支持 Chat Completions 的 SSE 和 JSON 输出，界面只显示任务流程。密钥留在服务端。正式使用前，部署者须核对所选服务对提交内容的处理与保留条款。

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

账户名须与 FEISHU_ACCOUNT_ID 一致。API 只监听 127.0.0.1，需可信反向代理；代理不能重序列化 JSON，否则 `x-lark-*` 签名校验会失败。平台校验回调地址时只发加密体、不带签名头，但卡片回调必须带，所以整条链路仍须保留原始请求体和签名头。服务器需校时（±300s），且 challenge 需在 1 秒内返回。

创建 Session 时：
- accountId 使用配置的账户名。
- user 收件人使用 open_id，group 收件人使用 chat_id。
- allowedActorIds 使用明确允许点击的用户 open_id；群成员不自动获得决策权。
- 身份与权限还会在内核检查，actionRef 不是免认证令牌。

当前已用合成签名、AES 密文和模拟 HTTP API 测试协议；尚无真实凭据的真机联调证据。

### 真机联调自检

```bash
bun run build
bun run feishu:acceptance -- --public-url https://你的域名/webhooks/feishu-internal \
  --chat-id oc_xxx --open-id ou_xxx
```

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

## 7. 受限来源采集（默认关闭）

采集器默认不联网：只有设置 `SOURCES_ENABLED=1` 时，worker 里的 `runSources` 才会按 Asia/Shanghai 08/12/16/20 轮询两个 allowlist 站点。未设置时第一次 tick 即退出，不产生请求。

运维命令（需要 `DATABASE_URL`；只有 `sync` 会联网）：

```bash
bun run sources status                  # 每站最近一次运行、outcome、失败原因、条目数
bun run sources list weichai_news       # 只看 active 条目
bun run sources sync weichai_news       # 手动跑一次，受每日配额与 15 分钟限速约束
bun run sources prune haier_news        # 手动清理 30 天前的快照（调度器也会每日自动执行）
bun run sources purge haier_news        # 清空内容并保留身份，防止重新入库
bun run sources resume haier_news <operator>   # 解除 stopped，记录操作人
```

排障顺序：先 `status` 看 `lastOutcome` 与 `lastReason`；`stopped` 不会自行恢复，确认站点正常后再 `resume`；收到下架或投诉时直接 `purge`。

行为约束（与 [#41](https://github.com/JunLang-7/AdPulse/issues/41) 一致）：每站每日最多 6 次请求（5 次列表 + 1 次 robots）；403/429 或连续 3 次失败即停止；失败不改动已有条目；快照保留 30 天。

测试用**人造 HTML fixture**，不访问真实站点，因此本地跑测试不会产生任何外发请求。

## 8. 扩展与现有限制

新接 IM：在 channels 中实现 InboundChannel 和 OutboundChannel，构造 ChannelAccount，在 runtime 注册。增加原始请求/ACK、渲染、账户隔离与重试测试；不要把平台字段或 HTTP 响应移入 core。

更换策略：实现 PolicyEngine 并通过 compose 注入。候选必须带冻结的 changes 和 complete 标志；内核不信任模型的边界判断，会重复校验变更和操作者。

生产前仍需：
真实平台验收、正式认证、数据保留策略、旧库结构迁移的执行与演练（版本化迁移已就位）、分页、限流/监控、失效原因提示和长任务租约续期。发送前已有过期/失效投递抑制，但不撤回已送达卡片，也不能完全消除检查与发送间的竞态。消息端到端不承诺 exactly-once。

设计过程遵循 XEngineer 规范：工程提案与设计澄清由 Issue 承载，进入开发即定稿只读，变更新开增量说明；本文仅随实现维护使用方式。当前已合并交互内核与最小控制台，下一阶段待评审提案见 [#6](https://github.com/JunLang-7/AdPulse/issues/6)。
