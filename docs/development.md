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
- 首期个人身份账户只允许本人 open_id 单聊；API 拒绝 group 目的地，避免把个人卡片内容发到未经授权的群。
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

实现在 `scripts/acceptance/`：`scripts/feishu-acceptance.mjs` 只是入口转发，参数、输出与退出码保持不变；
框架提供脱敏（`redact.mjs`）、HTTP 调用（`http.mjs`）、轮询断言（`poll.mjs`）、场景描述（`scenario.mjs`）
与记录渲染（`record.mjs`）。后续真机链路场景按 `{ setup, prompt, read, until, assertions }` 注册，不各写一套脚本；
当前只有只读自检，单聊/群聊等场景驱动器尚未接入。

输出的每条结果都带证据来源，记录里同样保留该列：

- `platform-real`：平台真实推送或真实用户交互，可支撑真机验收勾选。
- `local-real`：真实凭据或真实平台 API 由本地发起，可证明配置与连通，不可勾选真机项。
- `synthetic`：假凭据或 mock，只能证明代码路径。

等待人工动作超时或读取状态失败记 `blocked`：它表示没有等到操作，不等于被测系统失败，与 `skip` 一样不计入验收。

### 验收场景编排

```bash
bun run feishu:acceptance -- --list-scenarios
bun run feishu:acceptance -- --scenario dm --open-id ou_xxx
bun run feishu:acceptance -- --scenario group --chat-id oc_xxx --open-id ou_xxx
bun run feishu:acceptance -- --scenario rounds --open-id ou_xxx
bun run feishu:acceptance -- --scenario reject --chat-id oc_xxx \
  --open-id ou_授权成员 --other-open-id ou_未授权成员
```

场景需要访问控制台 API，按部署形态提供两种凭据（二选一，**不要写进仓库**）：

- #34 之后：先在浏览器完成飞书登录，把 `adpulse_session` 的值放进 `ADPULSE_SESSION_COOKIE`，
  并把 `PUBLIC_ORIGIN` 设为浏览器实际 origin（副作用请求会带同源 `Origin`）。
- 未升级的部署：仍可用 `CONSOLE_TOKEN`。

场景先跑一遍只读自检作为前置：存在 `fail` 即中止，避免在错配置上让人白点。`--skip-preflight` 只供本地调试，不能用于真机留证。

- `dm`：建会话 → 等第 1 轮卡片送达 → 提示点击「继续观察」→ 提示点击「确认已阅」；断言投递、`rounds`、`inbox`、`version`、`snapshots`、结束确认卡，并记录点击后的观测区间。
- `group`：与 `dm` 同一套往返判据，收件人为群 `chat_id`；群成员不自动获得决策权，
  `allowedActorIds` 仍只含 `--open-id` 指定的成员。
- `reject`：群聊下先让 `--other-open-id` 那位点一次，断言 `rejected/forbidden` 且
  `version`/快照/轮次不变；再让授权成员点一次，断言正常生效且被拒记录不被改写。
  需要第二个真实用户配合，缺人时该场景无法取证。
- `failure`：不需要人工点击。收件人故意不可达，断言「业务侧成功（`version`/快照/
  `inbox processed`）与投递失败（`delivery=failed` + 发送任务 failed）分离」，
  再用 `POST /api/jobs/{id}/retry` 验证重试复用同一 `delivery.id`（投递条数不增加）。
- `db-down`：停库注入，需同时满足 `--managed-db` 与 `DATABASE_URL` 指向本脚本自建的
  一次性库（`127.0.0.1:5433/adpulse_acceptance`）；否则整步记 `skip`，**不会**停任何其它库。
  断言：停库时回调返回 5xx 且无成功 ACK；恢复后同一事件只处理一次。
  一次性容器只由本脚本创建（名称前缀 `adpulse-acceptance-`、label `adpulse.acceptance=1`、
  固定端口 5433），默认运行结束即清理，`--keep` 保留；不接受任意容器名或端口，不使用 `sudo`。
- `rounds`：只需点一次卡片建立已答轮次，其余由脚本提交并断言旧卡、同轮重复被拒（`already_handled`），以及过期会话提交被拒（`expired`）；过期分支要求短有效期会话能及时送出第 1 轮卡片，否则记 `skip`。

场景会新建验收会话并按提示请你在飞书客户端点击，不删除或改写既有数据。断言结果标为 `platform-real`（由真实点击驱动）。

没人点击时步骤记 `blocked` 并且退出码非 0：本次结果不计入验收，完成动作后重跑即可。
真机上人往往不会立刻在客户端前，可用 `--step-timeout <秒>` 放宽单步人工窗口（例如 1800），
它只调整等待人工动作的时间，与 runbook 的 3 秒 ACK 预算无关。
加 `--write` 写入 `docs/acceptance/records/<UTC>-scenario-<id>.md`，同样默认不覆盖。

## 5. Web 控制台与接口

保持上述 API 在 127.0.0.1:3000 运行，另一个终端启动控制台：

```bash
cd apps/console
bun run dev
# 默认 http://localhost:5173/sessions
```

已有会话列表与详情，可查看轮次、选项、投递和快照摘要，并提交选择。当前没有创建会话表单，可先运行 `bun run demo` 生成演示记录；该脚本生成的是已完成会话。创建可操作的会话可参考脚本中的 POST /api/sessions 调用。

Vite 将同源 `/api`、`/auth`、`/webhooks` 请求代理到 127.0.0.1:3000，控制台与 API 不做跨域部署。`PUBLIC_ORIGIN` 必须与浏览器 origin 完全一致；Feishu 后台须登记 `${PUBLIC_ORIGIN}/auth/feishu/callback`。

登录采用 Feishu OAuth authorization code + S256 PKCE；按[授权码接口当前说明](https://open.feishu.cn/document/common-capabilities/sso/api/obtain-oauth-code)，该授权入口的 PKCE 暂时搭配 `https://open.feishu.cn/open-apis/authen/v2/oauth/token`，不混用 v3、不在失败后自动切换端点重试同一码；服务端检查授权用户的 tenant scope，身份键包含 platform、application、tenant、ID 类型和外部 ID。首次验证自动建立个人用户；不保存 access/refresh token，不提供静态 Bearer 或开发绕过。浏览器 session cookie 为 HttpOnly、SameSite=Lax，生产设置 Secure；服务端固定 8 小时绝对过期且不滑动，退出会撤销 session。所有有副作用的 `/api/*` 请求还必须携带与 `PUBLIC_ORIGIN` 一致的 `Origin`。控制台在受保护 API 返回 401 时携带经校验的站内 `returnTo` 跳转登录，退出会撤销会话并清空本地查询缓存。跨标签页登录或退出会通知其他标签页清除旧页面并重新验证；通知只含非凭据身份标识，不充当登录凭证。

机器人卡片动作按飞书 open_id 的应用/租户作用域映射到内部用户；仅当映射用户是会话 owner 且 open_id 在 `allowedActorIds` 中时才允许。尚未在控制台登录建立绑定的用户会被拒绝，需先登录一次；`GET /api/me` 返回本人的 `identities`，可用于创建会话时填写收件人与允许操作者。worker 执行平台动作时还在同一数据库事务内复核有效用户与完整作用域的绑定，入库后撤销的动作会被拒绝；控制台正常8小时到期不撤销机器人绑定。通知授权由 #35 单独处理，本映射不改变发送授权。

接口清单见 contracts/openapi.json；HTTP 调用示例见 scripts/demo.mjs。页面通过 apps/console/src/adpulse-client.ts 的 consoleClient 使用生成类型，不手写另一套 HTTP 契约。

- `/api/*` 要求有效的 `adpulse_session` cookie；`POST`、`PATCH`、`PUT`、`DELETE` 还要求同源 `Origin`。浏览器不得自行持久化或注入认证 token。
- 创建与选择要求 UUID 格式 Idempotency-Key。
- 创建会话：同 owner 的已有 requestId 返回原会话，目前不比较新旧创建请求体。
- 真实飞书账户创建会话时，用户收件人与 `allowedActorIds` 必须是当前用户自己的已验证身份（`/api/me` 的 `identities`）；服务端拒绝他人 open_id，避免通过操作者列表扩权。
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
真实平台验收、正式认证尚未经真实应用/HTTPS 环境验收、数据保留策略、旧库结构迁移的执行与演练（版本化迁移已就位）、分页、限流/监控、失效原因提示和长任务租约续期。发送前已有过期/失效投递抑制，但不撤回已送达卡片，也不能完全消除检查与发送间的竞态。消息端到端不承诺 exactly-once。

设计过程遵循 XEngineer 规范：工程提案与设计澄清由 Issue 承载，进入开发即定稿只读，变更新开增量说明；本文仅随实现维护使用方式。当前已合并交互内核与最小控制台，下一阶段待评审提案见 [#6](https://github.com/JunLang-7/AdPulse/issues/6)。
