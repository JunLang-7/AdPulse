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

### 分阶段创建推广任务

新建任务依次收集推广内容、人群与卖点、投放渠道，最后核对和创建。每阶段都可以回上一步修改。产品或服务名称是唯一必填项，推广目标、人群、卖点和渠道都可多选。其他阶段可留空提交，也可切换到直接填表。保存后可从“查看推广效果”进入独立复盘页，上传符合 AdPulse 固定报表格式的文件、比较结果和查看任务修改记录。观察范围可写“只看小红书新品试用活动”，日期未定时可留空。第一份报表和成本目标确认后，再按报表口径补齐提醒条件。

第一次打开引导会把两种给建议的方式摆出来让用户选：整表单一次给（三个阶段的说明一起整理，每个字段的建议一次列出）或按阶段一次次给（每步只整理本阶段的字段）。选完记在浏览器本地，面板上的“填写方式 · 更换”随时可以改；存不下时不报错，下次打开再问一次。

“AI 辅助填写”支持选择或拖放 UTF-8 的 TXT、Markdown、CSV，以及文字型 PDF、Word（DOCX）、Excel（XLSX）。每份文件最多 8 MB，PDF 最多 40 页。浏览器先把文件文字转成可编辑预览，每阶段最多预览 30,000 字。中文 PDF 按需加载本机服务提供的 PDF.js 字符映射（[许可](../apps/console/public/licenses/pdfjs-cmaps.txt)）。没有可读取文字的页面会提示，扫描件需先识别文字。发送给模型的本阶段资料最多 2,500 字。较长的附件可编辑预览，或选择“用前 2,500 字整理全部”，预览内容会保留。点“一次整理全部字段”会把三个阶段的选项和补充资料一起发送，一次返回全部字段的建议：能在资料里找到原话的标“原话摘录”并默认勾选，由模型按资料整理的标“AI 建议”且默认不勾，两类都要用户自己挑，写入后才进表单。模型没给出的字段按“该写什么 + 示例”提示补齐，不再只回一句“没有可补充的建议”。“提交本阶段”只在本机校验并前进，不联网、不替用户写入建议。阶段结果只用于本次待确认草稿，金额、日期和提醒条件由用户补充。模型逐字摘录的内容会作为原文摘录展示；口语化或无法逐字摘录的内容会作为待核对建议（产品名称、目标、人群、卖点、渠道），默认勾选但不会直接改写表单，用户核对后应用。整理服务不可用时，可选择按已填写内容继续。

模型调用在服务端通过 pi-ai 统一适配。供应商与模型目录由锁定的 `@earendil-works/pi-ai` 生成，不逐家手写：

```bash
bun run model-catalog:generate
```

该命令写出 `packages/runtime/src/model-catalog.generated.ts`（供应商、协议、模型 ID 与可调用模型元数据）。提交前 `tests/model-catalog.test.ts` 会重新读取 SDK 比对，目录漂移即失败；不要手改生成文件。目录里是否“可直连”只表示 AdPulse 已接通个人 API Key + OpenAI Chat Completions / Responses / Anthropic Messages / Gemini 原生适配路径，不代表已对每家做过真实联调。

逐家覆盖与差异清单见 [model-provider-coverage.md](model-provider-coverage.md)，由 `bun run model-coverage:generate` 从同一目录生成并由测试守住。它把“目录存在 / 适配可用 / 本人已配置 / 真实供应商验收”分开记录，当前真实供应商验收为 0。

参考快照可用 `scripts/capture-harness-provider-data.mjs` 从下载的 `provider-data.generated.ts` 重新生成（命令见脚本头注释）；生成文档与测试都不联网。

与 Harness 参考提交的逐家差异见 [model-provider-diff-harness.md](model-provider-diff-harness.md)，由 `bun run model-diff:generate` 从 `docs/reference/harness-provider-data.json` 与同一目录渲染。参考快照固定提交 `e8f7b93`（其 pi-ai 依赖为 `^1.3.0`，本仓库锁 1.5.0），结论是供应商集合一致（各 42 家），差异在认证范围、协议接通与模型清单；参考快照不含模型清单，因此不做模型级比对。

右上角个人菜单 →“模型配置”打开统一窗口：左侧是本人连接、部署提供和目录分组，右侧是配置表单与“测试连接 / 保存并使用”。保存前会用固定合成短句测试所选模型；密钥只写、不回显，服务端加密保存，登出或重启后仍可用。未适配的原生协议、仅账号授权、云凭据链或账号/区域/部署名等额外参数的供应商会显示原因；提供可选 OAuth 不妨碍单独使用其个人 API Key 路径。自定义 API 只接受 HTTPS 公网地址，校验全部 DNS 结果并绑定地址、禁止重定向；可显式选择 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 或 Gemini API；Anthropic 基础地址不含版本段，SDK 会请求 `${baseUrl}/v1/messages`；Gemini 基础地址含 `/v1beta`，请求 `${baseUrl}/models/{Model ID}:streamGenerateContent?alt=sse`。

模型测试通过并保存后，连接显示「已连接」。可点「设为默认」供 AI 辅助填写使用，或在任务里点「用于本次任务」。「重新测试」用已加密保存的密钥发送固定测试样例。测试失败会清除通过标记并保留密钥。更换已连接的模型时，测试通过后才替换。部署未配置有效主密钥时，表单会说明原因并禁用个人测试和保存。已有部署提供的模型仍可选用。

API 进程仍可读取 `DEEPSEEK_API_KEY` 作为部署提供的默认路由。使用另一供应商的 HTTPS OpenAI-compatible 网关时，在 API 进程的本地 `.env` 中同时设置：

```dotenv
TASK_DRAFT_PROVIDER=openai-compatible
TASK_DRAFT_GATEWAY_BASE_URL=https://gateway.example/v1
TASK_DRAFT_GATEWAY_MODEL=your-model-id
TASK_DRAFT_GATEWAY_API_KEY=
```

这些路由在窗口里显示为“部署提供”，只有用户显式选中才会使用；用户自填密钥失败时不会自动回退到部署密钥或其他人的连接。任务页只保留一个轻量模型入口，选择只作用于本次任务，不写全局默认，也不改已完成操作的历史记录。

任务页的模型选择是本人连接 `connectionId` + `modelId`，抽取接口据此解密并调用；没有个人连接时仍可手填，部署未配置主密钥时也不会自动降级。旧的 `TASK_DRAFT_USER_KEYS_ENABLED` 内存连接仍保留给部署路由与兼容性，但界面不再用它保存个人密钥。

需要允许已认证用户通过界面连接临时 API 密钥时，部署者可设置 `TASK_DRAFT_USER_KEYS_ENABLED=1`。连接用固定合成短句验证，密钥在服务端内存按用户隔离，最多保留 8 小时，且可断开。服务重启会清空临时连接。部署时应通过受信任的 HTTPS 入口访问。

### 持久化模型凭据（#86 PR1）

启用个人连接前必须配置主密钥，否则个人连接接口不可用：

```dotenv
# 逗号分隔 keyId:base64(32 字节)；默认最后一支为 active。
MODEL_CREDENTIAL_KEYRING=v1:
# 轮换时指定哪一支用于新写入，旧 key 先保留到旧密文全部重加密完成。
MODEL_CREDENTIAL_ACTIVE_KEY=v1
```

- 加密：AES-256-GCM，每次随机 nonce；AAD 绑定 owner、连接、凭据版本、规范化目标地址与协议，搬运密文到其他用户/连接/地址会解密失败。
- 失败关闭：主密钥缺失、格式错误、active key 不存在、解密失败都直接报错；不回退到部署共享密钥、其他用户密钥或明文。
- 版本与归属：每次配置变更递增版本；他人连接 ID 与不存在同样返回 not found；配置（含目标地址/协议）变更必须重填密钥并让旧验证结果失效。
- 删除：删密钥保留连接元数据并停用，同时清空默认选择；删连接在同一个事务里删除元数据、密文与默认引用，进行中的旧请求不会把旧密文写回。两种删除都会写入**撤销墓碑**（`userModelRevocations`，只含 owner、连接 id、凭据版本、原因与时间）。
- 恢复语义：恢复备份会把墓碑一起回滚，所以恢复后必须**先重放撤销记录再放流量**。墓碑版本不低于凭据版本时拒绝解密；重放会停用版本不高于墓碑的连接、删除密文、清空默认选择，已轮换（版本更新）的条目会跳过。
- 轮换：`ModelConnectionService.rotateCredentials()` 只重加密旧 keyId 的记录，每条在同一事务内重读，避免与删除并发时复活旧凭据；主密钥丢失无法从密文库恢复，部署前需演练保管与恢复。
- 边界：这是服务端加密存储，不是零知识加密；能同时控制服务器与主密钥的管理者理论上可解密。

同一组能力通过鉴权 API 提供（均已写入 OpenAPI 与生成 SDK）：

| 方法 / 路径 | 语义 |
| --- | --- |
| `GET /api/me/model-connections` | 本人连接投影与默认选择，不含任何密文/密钥 |
| `POST /api/me/model-connections` | 先用固定合成短句测试，通过后才写入连接与加密凭据 |
| `POST /api/me/model-connections/test` | 只测不存，不发送任务材料 |
| `POST /api/me/model-connections/{id}/test?expectedVersion=…` | 使用本人已保存的密钥测试当前模型，更新该连接版本的验证状态 |
| `POST /api/me/model-connections/models` | 显式点击时用候选密钥读取 `${baseUrl}/models`；失败不当作空列表，也不代表生成能力已验证 |
| `PUT /api/me/model-connections/{id}` | `expectedVersion` + 元数据/模型/凭据动作（keep/replace/remove）；换目标地址或协议必须同时 replace |
| `DELETE /api/me/model-connections/{id}` | 同一事务删除连接、密文与默认引用 |
| `DELETE /api/me/model-connections/{id}/credential` | 删密钥、停用连接并清空默认选择 |
| `PUT /api/me/model-preferences` | 本人默认 `(connectionId, modelId)`，只能指向本人可用连接 |
| `POST /api/task-drafts/extract` + `connectionId` | 用本人持久连接抽取；密钥只在服务端短暂解密，不回传 |

模型调用统一走受控出网层：只允许 HTTPS，校验全部 DNS 结果并把连接绑定到已校验地址，禁止重定向并移除 `location`，不读取环境代理，限制 512 KiB 与 15 秒。

额度分两层，都在发起请求前判定；部署提供的共享路由（`extractShared`）也按 owner 计入，不能靠共享 Key 绕过。**按用户 6 次/分钟、并发 1**；**实例总量 8 次/分钟、并发 2**。两者共用同一计数器口径（连接测试、显式模型发现、任务抽取、旧兼容路由都算），因此单用户无法耗尽全站额度，两个用户同时满额仍会被实例上限拦住。这是单进程内存限流，不是跨实例共享配额；多实例部署时总量会随实例数放大，需要网关或数据库层另行控制。不在枚举内的协议在边界返回 400；当前四种枚举协议均已接通，422 分支保留给以后新增但尚未适配的协议，不会降级成 Chat Completions；自定义连接需自行确认供应商支持 SSE 与 JSON 输出。

轮换与恢复演练（先只读，再确认写入）：

```bash
# 1. 追加新 key，新旧并存；此时 active 仍可为旧 key。
MODEL_CREDENTIAL_KEYRING="v1:...,v2:..." bun run models:rotate-keys --check
# 2. 切 active 到新 key 并确认重加密；未加确认参数不会写库。
MODEL_CREDENTIAL_KEYRING="v1:...,v2:..." MODEL_CREDENTIAL_ACTIVE_KEY=v2 \
  MODEL_KEY_ROTATION_CONFIRM=1 bun run models:rotate-keys --rotate
# 3. 确认 readable 等于总数、awaitingRotation 为 0 后，才从 keyring 中移除旧 key。
```

`--check` 只读：逐条解密并报告 `readable / failed / awaitingRotation`（不输出去向、owner 或密钥）；有失败时退出码非 0。正式库上先备份、后在可丢弃实例演练，再执行轮换。

撤销记录导出与恢复重放（导出文件必须存在备份之外）：

```bash
# 删除后导出墓碑清单（不含密钥、密文）。
bun run models:revocations -- --export revocations.json
# 恢复备份后：先只读报告，再确认执行，最后才放流量。
bun run models:revocations -- --replay revocations.json
MODEL_REVOCATION_REPLAY_CONFIRM=1 bun run models:revocations -- --replay revocations.json --apply
```

只读模式在仍有需要停用的连接时退出码为 1，避免“报告完就当恢复完成”。凭据版本高于墓碑时不停用，但仍会补记墓碑，保证更旧的恢复也能被识别；重放只处理墓碑，不重建任何密钥。墓碑覆盖当前凭据时，不允许保留旧密钥做元数据更新或重新验证，只有替换密钥或明确删除才可执行。视图不会把指向已撤销连接的旧默认选择展示成可用。

网关需支持所选原生协议的 SSE 和 JSON 输出：Chat Completions 请求 `${baseUrl}/chat/completions` 并使用 `response_format`；Responses 请求 `${baseUrl}/responses` 并使用 `text.format`、`store: false` 和 1024 输出 token 上限。Responses 不发送可能被推理模型拒绝的 temperature。Anthropic Messages 请求 `${baseUrl}/v1/messages`，使用 `x-api-key` 与 `anthropic-version`，没有 `response_format`，JSON 只靠提示词约束；基础地址**不能**以 `/v1` 结尾，否则 SDK 会拼出 `/v1/v1/messages`，保存前会被拒绝。发现均为显式 `GET ${baseUrl}/models`（Anthropic 为 `GET ${baseUrl}/v1/models` 并使用同名认证头），复用二次验证、受控出网和共享限额；发现成功不代表生成能力验证。Gemini 由本仓库自研受控传输（`packages/runtime/src/model-gemini.ts`）：pi-ai 1.5.0 的 Google 适配器拒绝自定义 fetch，无法纳入受控出网。请求把密钥放在 `x-goog-api-key` 头（不进 URL），固定 `alt=sse` 流式端点，复用同一份超时、512 KiB 线缆上限、16 KiB 文本上限与共享请求预算；`promptFeedback.blockReason`、`MAX_TOKENS`、非法 JSON、超长与上游错误一律失败关闭。四种协议均通过合成适配测试，未做真实供应商验收。界面只显示任务流程。密钥留在服务端。正式使用前，部署者须核对所选服务对提交内容的处理与保留条款。

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
| DECISION_CARDS_ENABLED=0 | 决策卡投递部署闸门，默认关闭；只有精确设为 `1` 才为新候选入队，仍须本人单独确认和发送前复检 |
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
平台触发的 challenge 及单聊/转发点击仍需人工动作，其余状态断言由下述场景编排器执行。

`fail` 需先处理，`skip` 不计入验收，退出码非 0 表示存在 `fail`。
加 `--write` 会在 `docs/acceptance/records/` 生成验收记录骨架（该目录默认不入库）。
操作步骤与判读标准见[飞书真机联调 runbook](acceptance/feishu-e2e.md)。
服务端尚无专用的回调 ACK 时延指标，需按 runbook 第 9 节用代理日志等替代取数。

实现在 `scripts/acceptance/`：`scripts/feishu-acceptance.mjs` 只是入口转发，参数、输出与退出码保持不变；
框架提供脱敏（`redact.mjs`）、HTTP 调用（`http.mjs`）、轮询断言（`poll.mjs`）、场景描述（`scenario.mjs`）
与记录渲染（`record.mjs`）。后续真机链路场景按 `{ setup, prompt, read, until, assertions }` 注册，不各写一套脚本；
除只读自检外，可按下文运行场景驱动器；个人身份禁止群投递。

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
bun run feishu:acceptance -- --scenario reject \
  --open-id ou_授权成员 --other-open-id ou_未授权成员
```

场景需要访问控制台 API，按部署形态提供两种凭据（二选一，**不要写进仓库**）：

- #34 之后：先在浏览器完成飞书登录，把 `adpulse_session` 的值放进 `ADPULSE_SESSION_COOKIE`，
  并把 `PUBLIC_ORIGIN` 设为浏览器实际 origin（副作用请求会带同源 `Origin`）。
- 未升级的部署：仍可用 `CONSOLE_TOKEN`。

场景先跑一遍只读自检作为前置：存在 `fail` 即中止，避免在错配置上让人白点。`--skip-preflight` 只供本地调试，不能用于真机留证。

- `dm`：建会话 → 等第 1 轮卡片送达 → 提示点击「继续观察」→ 提示点击「确认已阅」；断言投递、`rounds`、`inbox`、`version`、`snapshots`、结束确认卡，并记录点击后的观测区间。
- `group`：验证个人身份的群收件人在建会话时被拒绝（HTTP400），不发群卡；证据为 `local-real`。
- `reject`：本人单聊卡片转发给 `--other-open-id` 那位测试成员，点击被拒后，
  本人在原单聊卡片点击正常生效。转发无交互或缺人则保持 `blocked`。
- `failure`：使用本人收件人与 `scripts/acceptance/failure-server.mjs` 的出站故障夹具，
  不发送真实 IM，证据为 `synthetic`。断言业务与投递终态分离；重试活跃第2轮的任务，
  等新的 worker 执行令牌、非零尝试数及再次失败终态，不能只凭 attempts 归零通过。
  夹具只监听回环3301、只连接固定验收库；正常 OAuth 登录，无会话注入。配置与命令见
  [runbook §8](acceptance/feishu-e2e.md#8-投递失败与业务成功分离)。
- `db-down`：停库注入，需同时满足 `--managed-db` 与 `DATABASE_URL` 指向本脚本自建的
  一次性库（`127.0.0.1:5433/adpulse_acceptance`）；否则整步记 `skip`，**不会**停任何其它库。
  API 必须连接上述故障夹具，按本人身份建立会话。断言停库时无成功 ACK；恢复后同一事件只处理一次。
  一次性容器只由本脚本创建（名称前缀 `adpulse-acceptance-`、label `adpulse.acceptance=1`、
  固定端口 5433），默认运行结束即清理，`--keep` 保留；不接受任意容器名或端口，不使用 `sudo`。
- `rounds`：只需点一次卡片建立已答轮次，其余由脚本提交并断言旧卡、同轮重复被拒（`already_handled`），以及过期会话提交被拒（`expired`）；过期分支要求短有效期会话能及时送出第 1 轮卡片，否则记 `skip`。

场景仅新建验收会话，不删除或改写既有数据；各行分别标注真实点击、本地请求或合成故障的证据来源。

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

已有会话列表与详情，可查看轮次、选项、投递和快照摘要，并提交选择。
顶栏右侧的顺序是：搜索、待处理提醒（仅 `awaiting_input` 的会话）、外观、账号菜单。账号菜单只显示平台返回的
用户名和可操作项（Wiki、退出登录）；外部标识、租户、应用与会话到期属于运维/验收信息，不呈现给使用者。
用户名下方另显示一个平台标签，取自 `identities[].platform`（`feishu→飞书`、`dingtalk→钉钉`、
`wecom→企业微信`，未知平台原样显示），不在界面里硬编码平台名。用户名来自登录时 `/authen/v1/user_info` 的 `name` 字段（与 `open_id` 同一次响应，不需要额外权限），
只存在用户记录的 `displayName`，不参与身份唯一性判断；取不到时界面显示「已登录」。内容区不再放账号动作。
左侧导航是完整会话列表，与顶栏「待处理」是两种视角，不要互相复制。

投递闸门（`packages/core/src/worker.ts`）：只有 `initiatedBy: "system"` 的决策卡才要求
`canSendProactive`，不通过则把投递记为 `suppressed` 并写明原因，**不调用渠道**；
用户自己创建/处理的会话不受影响（本人操作回执）。告警会话目前是 web-only，该闸门的
真实触发要等 #37 的订阅推送；平台明确返回"收件人不可达"时投递终态失败并计数，
平台报告不可达即把目的地置为 `invalidated`（这些错误码是确定性事实，不是抖动），
要求本人重新确认。

「通知设置」（`/settings/notifications`）用于确认单聊地址与开启/撤销主动提醒：状态来自
`GET /api/me/notification-status`，动作走 `PUT /api/me/notification-destination` 与
`POST /api/me/notification-consent`（授权/撤销都带 `expectedVersion`，版本不符提示刷新）。
页面明确写出「撤销不影响登录、不删除地址、不发群消息」。当前没有创建会话表单，可先运行 `bun run demo` 生成演示记录；该脚本生成的是已完成会话。创建可操作的会话可参考脚本中的 POST /api/sessions 调用。

「个人关注与订阅配置」（#36，只存配置，不做筛选/调度/发送）：`packages/core/src/subscriptions.ts`，
接口 `GET /api/me/subscription`、`PUT /api/me/subscription/settings`、
`POST /api/me/subscription/targets`、`PATCH /api/me/subscription/targets/{targetId}`。

- 三维简单筛选：关注对象（`task` 为本人任务 id，`brand`/`competitor` 为本人录入名称）× 类别
  （`effect`/`event`/`evidence`）× 关联范围（`task_only`/`include_general`）。品牌与竞品目前没有跨租户实体，
  `refId` 用名称规范化 key（NFKC + 去首尾空白 + 折叠空格 + 小写），同名同 kind 重复录入返回 409；
  #38 出现实体后再关联，不改已存配置。
- **每人一个单调版本**，开关与关注列表的所有写入共用；写请求必须带 `expectedVersion`（未配置为 0），
  不符返回 409，旧请求重放无法覆盖后来的修改。#37 判断「哪批待发已过期」只看这一个数。
- `proactiveEnabled` 默认 `false`：登录、保存配置都不等于启用；启用/关闭分别记录 `enabledAt`/`disabledAt`。
- 时段默认北京时间日汇总 09:30、免打扰 22:00–08:00。`timezone` 必须**显式**为 `Asia/Shanghai`，
  其他或缺省一律 422：首期不做时区换算，静默改写会改变时间语义。汇总时刻落在免打扰区间同样 422，
  避免存下必然失效的配置；免打扰可跨零点。
- 从未保存过配置时，视图不返回 `updatedAt`（契约里可缺省），不用空串假冒 date-time；
  `version` 为 0、`schedule` 返回上述默认值。
- 退订对象 = `status: muted`（保留配置可恢复），类别退订 = 从该对象移除类别；二者与「关闭全部主动推送」可区分。
- 他人任务/他人关注对象一律按 `target_not_found`（404）处理，不确认存在性；视图不返回 `userId`。
- 本接口**不表示可投递**：是否真的能发仍由 `GET /api/me/notification-status` 的 `canSendProactive` 决定。

「订阅与关注」（`/settings/subscriptions`）是它的页面：关注对象增删、类别与范围就地修改、
退订/恢复、时段编辑，以及首次开启前的确认清单（关注对象、类别、09:30 汇总、免打扰、
「确认开启／暂不开启」）。页面把**四个状态分开显示**——订阅配置、单聊地址、授权、推送开关——
任一缺失都显示「不会收到提醒」，不用单个布尔冒充。开启/关闭与保存都只改配置，页面文案明确写
「保存配置不会发送任何消息」；真正投递仍受 #35 闸门与 #37 推送实现约束。

Vite 将同源 `/api`、`/auth`、`/webhooks` 请求代理到 127.0.0.1:3000，控制台与 API 不做跨域部署。`PUBLIC_ORIGIN` 必须与浏览器 origin 完全一致；Feishu 后台须登记 `${PUBLIC_ORIGIN}/auth/feishu/callback`。

登录采用 Feishu OAuth authorization code + S256 PKCE；按[授权码接口当前说明](https://open.feishu.cn/document/common-capabilities/sso/api/obtain-oauth-code)，该授权入口的 PKCE 暂时搭配 `https://open.feishu.cn/open-apis/authen/v2/oauth/token`，不混用 v3、不在失败后自动切换端点重试同一码；服务端检查授权用户的 tenant scope，身份键包含 platform、application、tenant、ID 类型和外部 ID。首次验证自动建立个人用户；不保存 access/refresh token，不提供静态 Bearer 或开发绕过。浏览器 session cookie 为 HttpOnly、SameSite=Lax，生产设置 Secure；会话随控制台上报的活动滑动到期——默认 24 小时无活动或登录起 7 天（先到者为准），登录时勾选「记住我」为 7 天 / 30 天，旧版会话仍按 8 小时绝对过期；令牌轮换带短暂宽限期。敏感写入（当前为模型凭据写入/删除）要求最近 15 分钟内重新验证过飞书身份，退出会撤销 session。所有有副作用的 `/api/*` 请求还必须携带与 `PUBLIC_ORIGIN` 一致的 `Origin`。控制台在受保护 API 返回 401 时携带经校验的站内 `returnTo` 跳转登录，退出会撤销会话并清空本地查询缓存。跨标签页登录或退出会通知其他标签页清除旧页面并重新验证；通知只含非凭据身份标识，不充当登录凭证。

机器人卡片动作按飞书 open_id 的应用/租户作用域映射到内部用户；仅当映射用户是会话 owner 且 open_id 在 `allowedActorIds` 中时才允许。尚未在控制台登录建立绑定的用户会被拒绝，需先登录一次；`GET /api/me` 返回本人的 `identities`，可用于创建会话时填写收件人与允许操作者。worker 执行平台动作时还在同一数据库事务内复核有效用户与完整作用域的绑定，入库后撤销的动作会被拒绝；控制台会话到期（空闲或绝对上限）不撤销机器人绑定。通知授权由 #35 单独处理，本映射不改变发送授权。

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

目前每个 Feishu 企业身份对应一个个人 AdPulse 用户；尚无协作、分享、委派、产品级白名单、RBAC 或完整策略差异界面。策略变更词表当前为渠道预算/出价/开关与人群、卖点、内容方向、合作对象的增删；内容方向与合作对象仅记录名称，不建模投放方式、合作阶段与效果指标。任务重试目前通过 API。sent 只代表渠道发送回执，不代表用户已读。

控制台组件测试（`apps/console/test/`）用 Node + `tsx` + `jsdom` 跑真实渲染：

```bash
bun run --cwd apps/console test:components   # 由根 `bun run test` 一并执行
```

- `test/setup.ts` 装 DOM 全局与相对 URL 的 `Request` 基址解析（openapi-fetch 用 `baseUrl: ""`）；
- `test/harness.ts` 在被测页面模块求值**之前**安装 `fetch` 桩（`createClient` 会捕获 fetch 引用），
  因此测试文件必须把它放在第一个 import；
- 脚本带 `--test-force-exit`：jsdom 会留句柄，不加这个进程不退出。
- 组件测试只覆盖「按钮是否真的禁用」「提示是否真的渲染」这类交互事实；状态推导仍走纯函数测试
  （`tests/console-*.test.ts`），两者不互相替代。

## 5.1 主动通知的批次与去重（#37）

`packages/core/src/notifications-queue.ts`（PR1：只建模队列，不做调度与发送）：

- **批次**：`ownerId + 本地日期(北京时间) + 类型` 唯一，一天一份；`scheduledAt` 是 09:30 北京时间对应的 UTC
  时刻；`settingsVersion` 记录生成时的订阅配置版本，投递前比对。关闭推送时**不生成**批次。
- **条目**：`ownerId + logicalKey` 唯一。同一逻辑事件的重试、换标题、多源转载只更新同一行，
  不新增通知；只有 `revision` 提升（实质新增证据/纠正）才再次排队并保留变化说明。
- **批次归属**：新内容只进入 `queued` 批次。当天批次已是终态（已发送/已取消/已过期…）时，
  新内容排到**下一次计划日**的批次，绝不复用终态批次——否则条目会挂在调度发现不了的批次下，
  也等于变相恢复旧队列。批次解析与条目写入在**同一事务**内完成，取消操作不能插在中间。
- **回执**：`markSent` 必须带发送时冻结的 `revision`；发送期间若条目被实质更新，旧回执被拒绝，
  不会把尚未发出的新版本标成已发送。
- **取消是终态**：`cancelPending(ownerId, reason, filter?)` 只动 `queued`；`sent` 不回滚、不改业务结果。
  已 `cancelled`/`expired` 的条目**不会**因为重新开启或重复提交而复活。
- 时间换算固定 UTC+8（中国无夏令时），不读服务器时区；`localDate` 在 UTC 16:00 翻日。
- 唯一性由数据库索引兜住（`adpulse_notification_batch_key` / `adpulse_notification_item_key`），
  不依赖应用层判断；条目迁移到新批次时只改 `batchId`，不改 `logicalKey`。
- 投递仍走既有 `Delivery`（条目的 `deliveryId` 指向它），不新增第二套投递状态机。

### 5.2 日汇总的调度与投递（#37 PR2）

`packages/core/src/notifications-schedule.ts`（调度）+ `worker.ts` 的 `send_digest`（投递）。

**调度只是建议，许可在执行那一刻重新检查。** 发送前逐项复检：订阅开关、配置版本
（`batch.settingsVersion` 必须等于当前版本）、免打扰、`canSendProactive` 闸门、
条目是否仍 `queued`、渠道账号是否可用。任何一项不成立都不发，并按原因收尾：

| 情况 | 批次状态 | 条目 |
| --- | --- | --- |
| 关闭推送 / 配置版本变化 / 空批次 / 不可达 | `cancelled` 或 `failed` + `statusReason` | 取消（不复活） |
| 未授权、地址失效、绑定失效、渠道缺失 | `suppressed` + 原因 | 取消 |
| 免打扰内 | 保持 `queued` | 不动，窗口结束后再发 |

- **跨日恢复**：往日批次不再补发，条目并入下一次有效汇总（今天批次已终结则顺延明天），
  旧批次置 `cancelled` + `merged_stale` 作为证据；调度侧和 worker 侧各判一次，
  后者防「任务早已入队、跨日才被领取」。合并会新建当天批次，因此调度允许跑第二轮，
  只有真的发生过合并才跑，避免重复计数。
- **租约**：`sendDigest` 接收当前 `Job`，成功与失败分支都在同一事务内先校验
  `status=running` 且 `leaseToken` 一致，再回写投递/条目/批次与地址失效——过期 worker
  不得改写别人的结果。
- 调度入口复用 worker 轮询：没有任务可领且距上次 tick ≥30s 时跑一次
  `DigestScheduler.tick()`（`runExclusive` 跨进程互斥），不引入第二个调度进程或 Redis。
- 同一批次最多一个在途 `send_digest` 任务，重复 tick 不会重复发送；晚于计划时刻超过
  `CATCH_UP_GRACE_MS`（5 分钟，覆盖 30s tick 抖动）才标 `catchUp`，准点发送不标补发（#101）。
- 卡片：`buildDigestCard` 最多 5 条，超出部分在页脚写明「另有 N 条」并**顺延到下一批次**；
  发送期间被实质更新的条目同样顺延，不留在已发送批次里。
- 投递复用 `Delivery`（`purpose: "digest"`，带 `ownerId`/`batchId`，无 session/round）；
  回执按冻结的 `revision` 标记，期间的新版本仍是待发。
- 免打扰判断与「窗口结束时刻」都用北京时间换算，不读服务器时区。

### 5.3 决策卡独立确认（#83）

订阅设置页的「决策卡单独确认」与日汇总/全部主动推送开关、目的地和通知授权分开。
设置接口仅保存本人偏好，不创建 Session、Job、Delivery 或通知批次，不直接发送消息；
不能把已确认文案理解为决策卡已可接收。受控投递见 §5.4；既有 Web 候选不因确认而补发。

- `PUT /api/me/subscription/settings` 新增可选布尔 `decisionCardsEnabled`，使用同一个
  `expectedVersion` 乐观锁；省略时保留原确认，非法类型拒绝且不部分写入。
- `GET /api/me/subscription` 的 `settings.decisionCards` 返回 `enabled`，以及存在时的
  `enabledAt`、`disabledAt`、`confirmedVersion`。历史记录缺少该字段时默认关闭，读取不建记录。
- 首次开启/关闭后重新开启，记录服务端当前时间与本次订阅配置版本；重复开启及修改普通配置
  不刷新该确认水位。单独确认不自动开启全部主动推送，关闭决策卡也不改变日汇总。
- 使用既有 `subscriptionSettings` JSONB 的可选字段，无新表、索引或 schema 版本迁移。
  新版会保留字段；旧版本的设置写入可能丢弃该字段，重新升级后按缺失即关闭处理，必须重新确认，
  不保证降级写入后仍保留原确认记录。不要将新界面与旧 API 混合部署，旧 API 不支持保存独立确认。
- 独立确认不是发送授权的充分条件；还须通过 §5.4 的部署与投递闸门。
  不得把本机测试通过作为服务器试验实例已更新或真实平台已验收的证明。

操作验证路径：订阅与关注 → 了解并单独确认决策卡 → 确认记录/暂不确认；仅确认后才写入。
提交中两个确认操作均禁用，冲突/失败显示错误，不冒充已开启；已确认时可单独关闭。
组件测试覆盖这些路径；专用 PostgreSQL 测试覆盖并发版本冲突、重连与旧字段缺失的保守回退。

### 5.4 新效果排查候选的受控决策卡投递（#83）

`DECISION_CARDS_ENABLED` 默认关闭。API/worker 必须使用同一发布版本及一致的闸门配置；
本功能仅覆盖已有 #10 效果排查，不接市场/竞品新来源，不扫描历史 Web 轮次，不建立占位策略或第二个决策会话。

- **入队原子性**：在 `Orchestrator.prepareRound()` 原有候选冻结事务中，复用真实任务策略、证据、
  固定候选与 actionRef。须已开启全部推送、单独确认，且冻结时刻严格晚于两次启用时间（同毫秒保守不推）；
  本人明确关注该任务且包含 `effect` 类别、目的地/授权/绑定有效并存在唯一匹配的飞书账号才创建投递。
  未满足时仍为 Web 轮次，后续打开开关不转换旧轮次；没有后台“补发历史”扫描。
- **路由**：仅企业飞书 `open_id` 单聊；装配层按 platform/application/tenant 全作用域匹配，
  无可验证入站身份或多个账号都匹配时不推送，核心不识别飞书协议。复用冻结轮次及既有会话，最多一份本轮投递。
- **持久化**：既有 Delivery JSONB 新增 `proactiveDecision`（冻结时间、设置/确认/授权版本与目的地核验快照），
  无新表/索引或 schema 迁移。复用 outbox、租约和 retry；任务类型为 `send_investigation_decision`，不新增队列。
  发送前在同一事务重取候选/任务/证据/来源、本人设置/授权/绑定/目的地与当前账号配置，核对快照并校验租约。
  成功复检的 `proactiveCheckedAt` 在网络前持久化，`sentAt` 是随后实际成功回执；复检不等于发送成功。
- **期限和免打扰**：保留 #55 从冻结起 24h 与更早任务/会话截止的最小值，不因延后或重试续期。
  北京时间 22:00 起暂停、08:00 起恢复（使用本人合法时段设置）；同一 job 延至窗口结束且不消耗失败重试预算，
  若恢复时已过期则不发。期限、设置、授权与版本在每次尝试时重新检查，卡片显示北京时间按钮截止。
- **取消**：任何订阅配置版本变化（含重复保存及关注列表变化）、撤销通知授权、撤销身份绑定、目的地失效，
  都在原写入事务中抑制本人尚未发送/待重试的这类投递，不改决策业务状态或本人操作回执。
  重开不复活旧投递；管理员重试不能把已抑制/取消的投递改回 pending。设置版本变化采取保守整份抑制，
  不尝试把旧卡重新包装。已成功投递与本人的操作回执不受退订误取消。
- **恢复边界**：网络始终在事务外，成功/不可达回写仍受租约令牌保护；旧 worker 不得改写新租约结果或判地址失效。
  配置变更时已有在途请求仍可能送达，成功回执如实记 sent；不能撤回已送达卡，也不承诺物理 exactly-once。
  业务轮次幂等和平台 UUID 去重窗口不同，长投递 ID 使用稳定 SHA-256 截取值满足 50 字符上限，哈希不保证绝对无碰撞。

#### 部署/回滚前置（本轮未操作服务器）

1. 先保持部署闸门关闭；确认原试验实例 `dc2554f` 的存量会话/任务与构建版本、备份可恢复性，并停止旧版所有
   embedded/独立 worker，避免与新版共享消费。不得直接 cherry-pick 原占位会话实现；本实现重新使用有效领域数据。
2. 对目标数据库与程序目录做受保护备份并在专用隔离库演练恢复，再部署同版本 API/worker。不得把生产库用于测试。
   本地专用 PostgreSQL 测试验证并发冻结、重连恢复及真实租约接管，**不替代服务器备份恢复演练**。
3. 明确检查并隔离旧试验待发，缺少可信关联/期限/授权快照的投递不能当成新版合法候选。
   新 worker 会抑制缺快照的关联告警卡；旧试验中没有告警关联的占位会话须另行识别与处置，不能自动猜测。
4. 验证健康、认证、静态页面与无意外待发后，仍须单独获得受控应用/试点账号的真实发送授权才能启用闸门，
   然后验证新候选、单聊点击、结果回执与旧卡拒绝。合成渠道测试不等于飞书真机验收。
5. 回滚先关闭闸门并停止所有新版 worker，备份并核对新增 outbox 状态；旧 worker 不认识新任务类型，可能把它完成而不发送，
   因此**禁止混跑或直接把待发交给旧版消费**。设置降级写入可能丢失独立确认，重升后须重新确认；
   不重置冻结时间、不重放取消状态，也不自动恢复备份中的旧通知。服务不可用与投递失败不作为业务决定失败。

### 5.5 通知记录与解释（#37 PR4）

`GET /api/me/notifications` 与控制台「通知记录」（`/settings/notification-records`）把已发生的汇总批次、
条目与投递回执投影成本人可读的记录。核心是 `NotificationRecordService`
（`packages/core/src/notifications-records.ts`），**只读**：不发消息、不改状态、不重试、不创建 Session。

- 只返回本人批次（按北京时间 `localDate` 倒序）。没有按 id 直取的公开入口，因此不存在「知道 id 就能读别人记录」
  的路径；`delivery` 还会再校验 `ownerId`，防止派生 id 撞车时串号。
- 分页用 `limit`（1–50，默认 20）+ `before`（排他游标，北京时间 `YYYY-MM-DD`）；非法值返回 400，不静默改写。
- 记录只陈述已存事实：批次状态、`statusReason` 代码、计划/发送时间、条目与 `Delivery` 回执。
  原因代码到中文文案的翻译在控制台 `record-view.ts`；未翻译的代码显示原码并注明「不推测」，不补未知原因。
- **历史内容以发送时冻结的卡片为准**：`queue()` 在 `revision` 提升时会复用同一条目行并改 `batchId`
  （见 §5.1），所以按条目「当前所属批次」拼历史会让已发送批次变空、或显示成更新后的版本。
  因此 `status: sent` 的批次从 `Delivery.card`（`purpose: digest`）读取当时实际发出的内容，
  `itemsSource: "delivery"`；卡片没有行级 `id/revision/status`，服务端不补造。
  缺快照（历史/测试数据）时退回条目行并标 `itemsSource: "rows"`，页面写明「可能与当时收到的版本不同」。
- 取消/合并类批次保留为记录但不再尝试重建内容：`merged_stale` 明确写「已并入之后的汇总」；
  `empty` 写「本批没有待发内容……或内容已因实质更新进入后续批次」，不冒充成「没有新内容」。
- `sent` 只表示渠道接收，页面明确写「不代表你已读」；业务结果与投递状态仍然分开。
- 页面顶部复用订阅页的 `describeReadiness` 判断「现在会不会收到」，避免两套说法；空记录时说明
  「没有新内容不发空汇总」，不把空列表解释成已发送。
- **生产者现状**：`NotificationQueue.queue()` 已由 #112 的筛选路径在生产代码中调用，但只接 `effect`；
  #38 的市场/竞品事件与 #39 的来源尚未接入，因此真实环境不会因此类输入自动生成汇总条目。
  本页只能看到已经存在的批次。
- 真机验收用受控工具 `scripts/acceptance/digest.mjs`（`bun run notify:acceptance -- ...`）：
  `enqueue` 写入带 `【验收测试】` 标记的合成条目（`--scene` 决定逻辑键、同场景按 revision 幂等、
  关闭推送时拒绝；取消是终态，换场景才会得到新的逻辑事件），
  `status` 读取本人批次与投递回执；脚本不发消息、不改订阅。步骤与判读见
  [验收 runbook §16](acceptance/feishu-e2e.md)。

### 5.6 市场与竞品事件（#38）

操作路径：左侧「市场与竞品事件」→「录入事件」→ 保存 → 事件详情 →「修订事件 / 补充转载」。
仅本人可读写；同一企业不共享。关联任务从本人任务中选择，记录明确的任务版本和关联理由，
不据此宣称事件造成成本变化。详情保留每次修订、旧原文、逐字引用及稳定的材料引用 ID。

- 支持公告、活动、产品发布，关注对象为品牌或竞品；`occurrenceKey` 是录入者指定的稳定事件标识。
  同一用户、对象种类/名称、事件类别及标识去重；同一对象和类别下，规范 URL（去片段）也作为别名。
  不同用户互不消费状态，同一文章涉及不同对象/类别可分别录入。跨链接转载由本人在原事件中补充来源，
  不进行模型语义聚类。重复创建返回原版本，**不会**把未审阅的新材料偷偷附到原事件；补充内容须显式修订。
- 来源分别记录 `link_only`、`title_only`、`search_snippet`、`excerpt`、`full_text`、来源性质、发布时间、
  获取时间和局限。URL 不自动读取；仅链接没有正文；搜索摘要不能声明为正文。发布时间可为原始日期或带时区时间，
  只有日期时不填造时分秒。事件时间、适用条件及引用缺失均保持未知。
- 主体、事件时间和适用条件的引用必须逐字存在于指定材料。三项均有官方性质的原文引用、来源链接、
  已知事件/发布时间及适用条件时，才标为 `evidence_ready`，其含义只是**引用齐备的信息候选**。
  官方性质与全文范围由录入者声明，未做独立来源核验，既不证明事实为真，也不构成推送准入批准。
  其他情况为 `insufficient` 并附原因，不要求所有保存的材料逐条审批。
- 普通标题或任务关联修改只增加修订版本；来源内容/性质、主体、事件时间、条件或引用变化增加 `evidenceRevision`。
  获取时间单独变化不视为新证据。所有历史版本均保留。合成标记不可通过修订去掉，合成内容不进入真实信息候选。
- API：`GET/POST /api/market-events`、`GET /api/market-events/{eventId}`、
  `POST /api/market-events/{eventId}/revisions`。写入要求 UUID `Idempotency-Key`，修订另带
  `expectedVersion` 与变更说明；同键异内容、过期版本或同用户重叠写入返回 409。重叠写入可稍后用原键重试，
  其他冲突须核对当前版本。客户端不能指定 owner、已存在材料引用或自动获取方式。操作表只保存摘要、版本引用、
  状态和服务器时间，详情从所属用户的不可变版本追溯，不把原材料写入操作日志。
- `MarketEventService.importSourceItem()` 是 #41 列表条目的内部规范化入口，只接受实际存在且 active 的条目，
  保留 `sourceItemId`、仅标题、正文未读取和发布时间未知等限制，不发网络请求。
  尚未连接采集调度或 #37 的个人订阅生产者；保存事件和形成候选都不会创建 Session、Job 或发送消息。
  #39 的来源准入结论和 #37 的筛选/推送验收仍须分别处理。

迁移版本 11 新增四张 JSONB 表：`marketEvents`、`marketEventVersions`、`marketEventAliases`、
`marketEventOperations`。逻辑事件和事件版本有数据库唯一索引；别名/操作使用 owner 范围的确定性主键。
迁移在既有 advisory lock 和单个事务中应用，无历史回填。升级前备份并核对目标库；回退旧应用时保留新增表，
旧应用没有事件入口，重新升级可继续读原版本；不提供删除表的自动降级迁移。本轮只验证专用测试库，未操作部署库。

固定样例为 `tests/fixtures/market-events-guance.json`，取自 guance-ai 的提交
`01ba5c2992f62b6ba9e4cb0eac22b3d1bbd2627f`、`simulations/projects/*.json` 中每行业的一条竞品观察。
每条保留 signal/source ID 与转换记录，只适配标题、原引语和来源元数据；事件类别为本项目映射，
不代表原案例已证明明确发布。缺失链接、事件时间、适用条件不补造，原 `verified` 不覆盖 `simulated`。
这些不足证据样例以及人造的完整公告、转载/修订、权限和并发变体用于自动测试，不能替代真实采集或飞书验收。

测试：`tests/market-events*.test.ts` 覆盖领域/API/专用 PostgreSQL；
`apps/console/test/market-events-page.test.tsx` 验证保存禁用、失败保留与幂等重试、第二来源引用、
模拟修订/冲突及无权详情。它们使用合成输入，不连接真实平台。
### 5.7 订阅筛选与历史原因（#112 第一阶段：效果告警；第二阶段：市场/竞品事件）

- `InvestigationAlertService.evaluateComparison()` 在新告警或实质新证据评估时，通过
  `NotificationSelectionService.selectIn()` 在同一数据库事务内完成筛选、最小记录与入队。
  不是后台扫描历史告警；既有操作重试返回原判断，新比较操作重复同一证据只记重复抑制。
- 仅接入 `effect`。匹配服务端已经证明的本人任务 id 与有效 `task` 关注、`effect` 类别；
  `task_only` 与 `include_general` 对这一任务输入均适用。品牌/竞品名称、产品名、标题、摘要和域名
  不作为显式关联；`event`/`evidence` 配置保留，界面明确尚未接入。
- 启用之前产生的输入不补发；默认关、`muted`、类别排除、身份/目的地/通知授权不满足均留历史原因。
  业务告警仍正常建立，不因未订阅而改变决策状态或本人操作回执。
- 通知键为本人 + 逻辑告警，不包含标题或命中项。实质新证据推进 `notificationRevision`；
  同版本重试不新增条目，取消/过期不复活。新输入遇旧设置批次时取消旧待发并进入下一有效批次，
  避免混入旧批次后被误取消。09:30 之后才产生的新输入进下一次汇总；
  09:30 前已产生但因服务延迟才处理的输入仍可使用当天逻辑批次补发。
- 迁移 **12** 为加法式（接在 #38 的 11 之后）：新增 `notificationSelections`，本人 + 比较结果唯一约束及本人/时间索引。
  不改旧表必填字段。发布须协调升级 API 与全部 worker；旧 worker 不认识领域引用复检，禁止混跑。
  回滚前先关闭推送并停止新版消费者，隔离/取消生产待发后再启动旧版；新记录不自动回放。
- `GET /api/me/notification-selections` 仅查询本人且当前仍有权访问的任务、告警、证据。
  查询参数：`taskId`、`dateFrom`/`dateTo`（含端点的北京时间日期）、`outcome`
  （`queued`/`not_queued`/`duplicate`/`cancelled`）、`limit`（1–50，默认 20）及 `before`
  （响应 `nextBefore` 的不透明排他游标，含时间与 id，保证同毫秒分页）。非法/重复/额外参数返回 400。
- 记录只存引用、评估时间、当时设置版本、命中关注项、通知版本与结果/原因，不复制原文、标题、摘要或凭据；
  之后改设置不改写过去，缺历史就写无法还原。`queued` 不是投递回执，后续取消/失败仍看汇总与投递。
- 生产条目保存领域引用，发送前检查任务/证据版本、来源和告警是否仍有效；失效取消并显示
  `input_unavailable`。检查后仍可能发生在途竞态，平台端不承诺 exactly-once。
- 通知记录在同一卡片展示最近待汇总的提醒和发送历史。选择「没收到通知？」可在卡片内按任务、日期和结果查找原因。
  仅在关联的本人提醒和批次仍匹配同一修订时，查询结果带上可核实的后续状态。旧记录缺少对应条目时保留当时的筛选原因。
- 本阶段只做本地合成输入、专用 PostgreSQL 和组件行为验证；未部署、未做该生产路径的真实 IM 验收。
  这些记录属于业务派生数据；完整保留期、物理清理与备份防复活仍由 #40 联验，本阶段不宣称完成。

#### 5.7.1 事件输入（#112 第二阶段，接 #38）

- `MarketEventService` 在事件写入事务内调用 `NotificationSelectionService.selectEventIn()`：筛选、
  历史记录与该事件入队同事务提交，不另起扫描任务，不在事务内发网络请求。
- **准入**：事件的候选必须为 `evidence_ready`（三项官方原文引用齐备）、至少一条来源带 URL、
  `provenance.simulated=false`，且事件已显式标注本人关注的主体或关联任务。
  `insufficient` 候选与合成样例一律不入队，只留原因；`evidence_ready` 仍只是「引用齐备的候选」，
  不等于事实核实或 #39 的来源准入结论。
- **关联与范围**：`brand`/`competitor` 关注按 `subscriptionNameKey`（NFKC + 去首尾空白 + 折叠空白 + 小写）
  与事件 `subject.name` 比较，且仅 `include_general` 接收这类「对象一般事件」；
  `task` 关注按事件 `taskRefs` 的显式任务 id 比较，`task_only` 与 `include_general` 均接受。
  标题/摘要包含名称、来源域名、品牌官网归属均不作为关联依据。
- **去重与版本**：通知键为 `event:{eventId}`；筛选记录幂等键为「本人 + 事件 + 证据版本」。
  只改标题或任务关联只增加事件版本、不推进 `evidenceRevision`，因此不重复通知；
  来源原文/主体/事件时间/条件变化推进 `evidenceRevision` 并再次通知（同一条目 revision 提升）。
  取消/过期仍是终态，重开不回放。
- **原因代码**：除共用 `matched`/`push_disabled`/`before_enabled`/`target_muted`/`category_excluded`/
  `not_authorized`/`previously_cancelled` 外，事件路径新增 `insufficient_evidence`、`simulated_input`、
  `no_association`、`scope_excluded`，未命中同样写筛选记录（只存引用，不复制标题、摘要或正文）。
- **卡片**：标题取事件标题，摘要写「事件类型 + 主体 + 事件时间/未知 + 适用条件/未提供」，
  并明确「仅为你录入的明确事件与原文引用，未经独立来源核验」；来源只存 label/URL/发布时间/获取时间。
  事件时间或适用条件未知时保持未知，不补造。
- **发送前复检**：`marketEventNotificationCurrentIn()` 要求事件仍是当前版本、`evidenceRevision` 未变、
  候选仍为 `evidence_ready`；否则取消该待发（`input_unavailable`），不把旧版本冒充最新事实。
- **普通修订刷新待发**：改标题/任务关联不推进 `evidenceRevision`，因此不重复通知，但会刷新尚未发送的那条
  待发内容的标题、摘要、关联理由、来源与事件引用（不新增条目、不改写筛选历史判断）；已发送/已取消的条目
  不刷新、不复活。否则版本前进会让旧引用整条失效而无法补发。
- **卡片长度预算**：`item.relevance` 上限 120（与 `domain/infoCard.ts` 校验一致）。主体与任务名称同时命中时
  按总长度裁剪，避免拼接超限让整批汇总抛 `item relevance too long`。
- 筛选记录查询接口无新增参数：事件记录按事件归属校验（本人），有任务关联时仍可按 `taskId` 过滤；
  事件被删除/不再属于本人时不返回其历史引用。
- 未接入：`evidence` 补证类别、#39 的自动来源采集、事件→决策卡；也**未**新增数据库迁移
  （筛选表沿用 v12 的 JSONB 记录，新增字段为可选，事件路径用确定性 id + 存在性判定去重）。

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

来源清单、声明主体、许可状态与停用流程统一登记在
[`docs/sources/registry.md`](sources/registry.md)：它是**登记而非合规结论**，与 `SOURCE_DEFINITIONS`
双向对齐（由 `tests/source-registry.test.ts` 守卫）。新增站点必须先重走 #41 Gate 0 再改登记表与代码。

### 采集调度与状态（#39）

- **谁来跑**：独立 worker（`apps/worker`）一直支持 `runSources`；此外 API 进程在
  `SOURCES_ENABLED=1` 时也会跑采集循环（`EMBED_SOURCES` 语义由该变量承担），试点不必再单独部署 worker。
  `SOURCE_TICK_MS` 只用于测试/演练，默认 60s。开关关闭时不起循环、不发请求。
- **单例与失败**：`SourceService.sync` 用 `runExclusive('source:<key>')`，同来源并发只有一方执行，
  另一方返回 `skipped`；抓取失败**不改动任何条目**，连续 3 次失败进 `stopped`，只能人工 `resume`。
- **状态可见**：`GET /api/me/source-status` 只返回本人已开启来源的 `status`（active/stopped）、
  最近一次 `lastRun`/`lastOutcome`/`lastReason` 与条目计数；未开启来源不返回，也不暴露全局运维信息。
  控制台在「市场与竞品事件」的线索卡里显示这几项。
- **PG 证据**：`tests/sources-postgres.test.ts` 在一次性 schema 上验证并发单例、失败不改条目、
  重试只补新增条目、`purged` 不复活。

### 自动来源线索（#39 方案 A）

采集到的列表条目**不会自动变成事件，也不会自动推送**。它只作为「待确认线索」出现在本人控制台：

- 每人逐来源开启：`PUT /api/me/subscription/settings` 的 `sourceFeeds`（取值限 allowlist 的
  `weichai_news`/`haier_news`，未知 key 直接 422）。默认空 = 不采集、不可见。
- 关联依据是**声明的「站点 → 主体」映射**（`SOURCE_DEFINITIONS[key].subject`，潍柴站→品牌潍柴、海尔站→品牌海尔），
  不是标题或域名推断；卡片/线索上都写明这一点。
- `GET /api/me/source-leads?sourceKey=&limit=`（limit 1–50，默认 20）：只返回本人已开启来源的 active 条目，
  含标题、原文链接、发布时间（未知保留 null）、`firstSeenAt`/`lastSeenAt` 与 `subject`；
  查询未开启的来源返回 400，不泄漏别人的开关。
- 「已录入」判定是**本人当前版本事件里有同 URL 的来源**，返回 `convertedEventId`；历史修订里的旧链接不算。
- 控制台「市场与竞品事件」列出线索，点「转事件」把标题、声明主体与那条**仅标题+链接**预填进录入表单，
  类型、事件时间与逐字引用仍需本人补；补齐后才可能变成 `evidence_ready` 并进入 #112 的事件筛选。
- 产品方决定的「每日 ≤3 条、单站 ≤1 条」是**推送**限额；方案 A 不推送，因此本阶段不实现该限额，
  线索列表只按时间倒序取最近 20 条。
- 站点未取得合规签核（#41 Gate 0），只能取标题与链接、不复制正文；收到投诉或条款变化应立即
  `purge` 并关闭来源。

### 用 Agent-Reach 查找官网线索

运维人员可按品牌和主题手动查询海尔、潍柴的新品发布（`products`）或品牌活动（`campaigns`）。该命令独立于采集 worker 和数据库，固定把公开品牌、官网域名和主题词发给 Exa。

在独立 Python 环境中从 Agent-Reach 的 GitHub 仓库安装已核对的提交。将 `AGENT_REACH_BIN` 配置为该环境中 `agent-reach` 可执行文件的绝对路径（Windows 为 `agent-reach.exe`）。

```bash
uv tool install "agent-reach @ git+https://github.com/Panniantong/Agent-Reach.git@47898829204ad27521d8a1719e3aeca3b8a3e0ca"
bun run build
bun run sources discover haier_news products
bun run sources discover weichai_news campaigns
```

命令在临时配置目录内只执行 `web search`。查询最多返回 5 条结果，AdPulse 只输出两家官网新闻链接、去重标题及可解析的索引日期。潍柴搜索限定在 `www.weichai.com` 的新闻与事件栏目，兼容栏目下有分类和无分类两种文章路径。`verification: unverified` 和 `indexedPublishedAt` 表示这些字段来自搜索索引，须对照原文核对。发现结果只输出到终端，采集入库与用户展示仍按 [#41](https://github.com/JunLang-7/AdPulse/issues/41)、[#38](https://github.com/JunLang-7/AdPulse/issues/38) 和 [#37](https://github.com/JunLang-7/AdPulse/issues/37) 分别验收。限流或访问阻断会结束当前命令。

`discover` 现在可加 `--persist <operator>`：把发现结果写入 `discoveryLeads` 暂存表（含 operator、发现时间、原始查询词，URL 归一化后与现有 source items 及历史线索去重），供控制台「发现线索待审核」接受/拒绝/保留；接受后作为 source item 入库，拒绝后同 URL 不再出现。也可用 `discover xiaohongshu <查询词> --subject brand:名称|competitor:名称` 走 Agent-Reach 的小红书笔记搜索（需登录态，返回 unverified 笔记，仅测试/比赛用途，未做真机签核）。

日期口径：`indexedPublishedAt` 与接受时的 `correctedPublishedAt` 都必须是**真实存在**的 `YYYY-MM-DD`（`2026-02-30` 这类格式合法但不存在的日期会被当成未知或被拒绝），与事件/证据侧校验一致。

用户自加企业站点（`/api/me/user-sources`）：**只填企业名时先登记为 `discovering` 并立即返回 202**，官网查找与首次采集在 worker 里跑（发现可能要几十秒，不再阻塞登记请求）；发现成功转为 `active` 并写回 host/listUrl，失败转 `failed` 并给出原因。填了列表页地址时仍同步采集一次。之后可手动重采。**同一站点 5 分钟内只采集一次**（429 `refresh_too_soon`，失败也计入冷却），避免连点或脚本对第三方站点造成持续压力；一次刷新包含 robots、列表页与若干探测页，最多约 20 个站内请求。**每日每站配额尚未实现**，需在后续增量里补（当前只靠冷却与 robots 约束）。

列表页与条目的取舍（[#180](https://github.com/JunLang-7/AdPulse/issues/180)）：

- **只接受验证过的 HTML 页面**。`.json/.xml/.rss/.atom/.txt/.csv` 或响应不是 HTML 时不算列表页；`discoverCompanySite` 按分数试下一个候选，全部不可用就报错，不把接口地址存成列表页。
- **条目要有文章信号**：标题带日期、URL 带日期或 ≥8 位文章 id、`.shtml/.html`、路径含新闻段；标题本身还得是可读文本（路径片段、纯电话/数字串不算）。一页都不达标时 `parseUserListPage` 返回空，不返回导航/产品菜单充数。
- **选到更好的页面会写回来源**：刷新探测到更高分的列表页时更新 `userSources.listUrl`，避免每次重复探测同一批候选。
- **不冒充成功**：最终没有可用条目时 `lastOutcome=failed` 并给出可见原因，不写条目、不改地址。
- **换站回退**：同一家企业常有多个入口（集团站 / 商城站 / 品牌站）。当前站点三级兜底都为空（含 robots 不可达/被挡）时，按企业名再找 1–2 个已验证站点重试；采到内容就把 `host` 与 `listUrl` 一起写回。已登记的站点不抢，失败原因里会列出试过的备选站。
- **补一轮发现搜索**：第一遍「<企业> 官网」若只搜到商城/集团站且列表页解析不出条目，再用「<企业> 新闻中心」搜一轮（需要聚合器；实测这句能带出 `midea.com.cn`、`haier.com`），只在前一遍无可用条目时消耗。
- **简中偏好**：试点面向简中用户。robots 声明多个分语言 sitemap 时优先 `cn`/`zh` 地图；备选站点按「条目简体中文占比」优先（实测会先搜到美的台湾站、海尔全球英文站）；sitemap 兜底排在渲染回退之前（免费、确定，实测海尔的中文新闻只有 sitemap 能带出来），sitemapindex 最多下钻 5 个子地图。
- **发现阶段看列表页质量**：候选按「列表页能否解析出条目」优先排序（能解析 > 解析数多 > 短域名），避免把只有首页/商城的站排在官网前面。

采集兜底（按顺序，每级都有请求上限；前一级有结果就停）：

| 级别 | 入口 | 额外请求 | 标题来源 |
| --- | --- | --- | --- |
| 一 | 列表页 HTML 锚文本 | 0 | 锚文本 |
| 一' | **同域 JSON 列表**（`{"data":[{path,title,published}]}` 这类数据接口） | 0（复用列表页响应） | JSON 白名单字段 `title/name/headline` |
| 一'' | 页面上指向数据接口的**新闻链接**（如 `/cn/zh/newsroom.json`） | ≤1 | 同上 |
| 二 | **sitemap**（`robots.txt` 的 `Sitemap:` 或 `/sitemap.xml`，支持下钻一层 sitemapindex） | 1 + 索引，标题缺失时最多 6 篇文章页 | `news:title` 优先，否则文章页 `<title>` |
| 三 | **站内搜索**（`<企业名> 新闻` 走搜索源聚合，只取同域命中） | 1 次搜索（受每日额度约束） | 搜索结果标题 |

- 兜底只取「标题 + 链接」，不读正文；JSON 只按白名单字段取值，不猜结构。
- sitemap 只接受**新闻型**条目（新闻路径、带日期的路径或标题含新闻/公告词），产品页/栏目页会被丢弃；搜索结果里的首页、关于页同样不算条目。
- 文章信号不足的 URL（导航/产品/栏目页）在每一级都会被 `articleScore` 过滤；sitemap 标题抓不到就跳过，不编造。
- 任一级命中即写库并把纠正后的 `listUrl` 写回来源；三级都空才失败，原因里写明试过哪些入口。
- **已知限制**：纯 JS 渲染且没有可访问 HTML 列表/JSON 接口/新闻型 sitemap 条目的站点（实测 `www.midea.cn`、`www.joyoung.com`）仍然无法采集，会如实失败并提示直接填写列表页地址；不做无头渲染推断。

## 7.1 搜索源聚合与额度（付费源用完即停）

「只给企业名称」的官网自动发现由多个搜索源聚合完成。每个源按北京时自然日单独记额度，**用满即停**，不静默降级；控制台直接显示每个源今日已用/剩余。

| 源 | 启用条件 | 默认日额度 | 环境变量 |
| --- | --- | --- | --- |
| Bing 网页检索（RSS） | 总是启用 | 200 | `SEARCH_DAILY_LIMITS=bing:N` |
| Exa 语义检索 | `AGENT_REACH_BIN` 已配 | 50 | `SEARCH_DAILY_LIMITS=exa:N` |
| Serper（Google，付费） | `SERPER_API_KEY` 已配 | 100 | `SEARCH_DAILY_LIMITS=serper:N` |
| Brave 搜索（付费） | `BRAVE_API_KEY` 已配 | 100 | `SEARCH_DAILY_LIMITS=brave:N` |

搜索短路与质量升级：

- 默认**凑够 8 条就短路**后续源（省付费额度）；对一般搜索正确。
- 「找官网」是质量敏感场景：免费源可能返回 8 条商城/字典站把付费源短路掉（实测 Bing 对「美的 官网」如此）。因此发现阶段的第二轮「<企业> 新闻中心」搜索按次解除短路（`enoughHits: Infinity`），咨询全部已配置源；**只在第一轮没有能解析出条目的站点时升级**，正常企业不消耗付费额度（实测 Serper/Google 第一位即正确官网 `midea.com.cn`、`haier.com`）。

调用顺序：免费源优先（Bing → Exa），结果不够时才用付费源兑底；已够则不消耗付费额度。

站点发现顺序：聚合搜索 → 排除门户/音乐/视频/股票/企业信息平台等非官网域名 → 按分数验证前 **8** 个候选的首页（标题或头部须写到品牌名，短域名可用品牌前缀）→ 定位列表页（最多试 3 个候选）。黑名单与上限是为了让「第 9 位的真官网」也能被验证到，同时不把一次登记放大成几十个请求。

- **失败退额度**：源抛错、上游失败、限流、密钥失效都不计费；只有真正返回结果的调用才计一次。
- **额度用尽**：`POST /api/me/user-sources` 在 `listUrl` 留空且所有源都无额度时返回 `429 search_quota_exhausted`（与采集冷却的 429 靠错误码区分）。
- **状态可见**：`GET /api/me/search-providers` 返回每源 `used`/`remaining`/`exhausted`/`day`。
- **不影响主链路**：用户仍可直接填写列表页地址，采集、转事件与推送不受额度约束。

额度记在 `searchQuotas`（迁移 22），按 `provider + day` 唯一；内存存储重启清零，PostgreSQL 持久保存。额度是部署级全局计数（单租户试点口径），多租户需按用户拆分。

## 7.2 即时推送（Bark / ntfy / 企微 / 钉钉）

日汇总之外，用户可以随时手动推一次，不用等汇总时间。

- `POST /api/me/notifications/push-now`：取本人**依据齐备**的事件摘要，向已配置渠道立即发送（不包含未核对线索）。
- `GET /api/me/push-channels`：返回每个渠道的 `configured` 与配置指引。
- 控制台「订阅与关注」页的「立即推送一次」按钮就是它；没配渠道时按钮禁用并提示怎么配。

| 渠道 | 环境变量 | 说明 |
| --- | --- | --- |
| 企业微信群机器人 | `WECOM_WEBHOOK` | **国内直连最稳、免注册**；群设置 → 群机器人 → 复制 Webhook |
| 钉钉自定义机器人 | `DINGTALK_WEBHOOK` | 群设置 → 智能群助手；关键词模式填 `AdPulse` |
| ntfy | `NTFY_TOPIC`（可选 `NTFY_URL`） | 跨平台、免注册；主题名即密码 |
| Bark | `BARK_KEY`（可选 `BARK_URL`） | iOS；自建服务再改 Base URL |

实现要点：
- 网络层失败自动重试一次（跨域链路偶发连接超时）；4xx 不重试，那是配置问题。
- 企微/钉钉即使 HTTP 200 也可能带非零 `errcode`，必须读出来判失败，不当成功。
- 渠道全部失败时返回 502 并逐渠道给出原因；没配任何渠道时返回 409。
- 即时推送**不受** `proactiveEnabled` 与免打扰时段约束（由用户当场触发），但仍只发本人数据。

## 7.3 任务生命周期（#40 S1：到期与限访）

只做到期判定与读取限访；物理清理、删除确认、180 天审计与备份策略在后续切片实现。

- **保留期**：任务、必要证据与决定记录 **365 天**；派生引用不延长原文留存。
- **计时锚点**：取「观测期结束（`observation.endsAt`）」与「最后有效业务更新」中**较早**的已知时刻。
  最后有效业务更新 = 任务版本、证据版本、比较结果、告警更新的最大 `createdAt`/`updatedAt`。
  普通查看、消息重试、worker 重启都**不续期**。
- **限访**：到期后 `tasks.get` / `tasks.list` 返回不可访问；`GET /api/tasks/{id}` 返回 404；
  证据导入、比较评估、告警评估均拒绝；提醒在发送前复检时判定失效，不再发出。
- **判定查询**：`GET /api/tasks/{taskId}/lifecycle` 返回 `anchor`、`anchorSource`、`expiresAt`、
  `state`、`expired`、`retentionDays`，用于断言「普通查看不续期」「到期即限访」。
- 全部按 UTC 绝对时刻与 24 小时/天计算；测试通过注入时钟验证边界，不靠真实等待。

### 本人确认删除（#40 S2）

- `DELETE /api/tasks/{taskId}`：本人确认删除任务及其**全部关联**（证据、比较、告警、会话、通知条目）。
  同一事务内：写任务墓碑 `task.deletion`、取消该任务尚未发出的提醒（`cancelPendingIn`，reason
  `task_deleted`）、抑制该任务关联的决策卡待发（`suppressionReason=task_deleted`）、写删除清单。
- **幂等**：重复提交返回同一清单（`created:false`）；并发写入由 `runExclusive` 串行化，
  失败返回 409，不会产生两份清单（数据库上 `(ownerId, taskId)` 唯一索引兜底）。
- **立即限访**：删除后任务读取/列表/证据/比较/告警/发送前复检一律按不可访问处理，
  `lifecycle` 查询返回 `state=deleted` 与 `deletedAt`。
- **重建同名任务**：允许新建，但那是新 `taskId`；旧任务与其历史始终不可访问，删除清单保留。
- 删除清单表 `lifecycleDeletions`（迁移 **15**）：`requestedAt` + `deadlineAt`（请求起 7 天在线清理截止）+
  `status`。物理清理（S3）与备份重放（S4）都以它为准，不依赖业务表是否已被清理。
- **控制台路径**：任务详情页底部「保留期与删除」卡片显示「保留至 …/剩余 N 天」；点「删除任务…」后
  需勾选「我了解删除后不可恢复」才能点「确认删除任务」，成功后回到任务列表并提示已删除，
  失败（409 处理中 / 404 / 网络）显示可见错误，不显示成功提示。

### 在线清理（#40 S3）

- `LifecycleCleanupService.runOnce()` 由 worker 在没有任务可领时按 **1 小时** 间隔触发（与日汇总调度分开计时，
  清理失败只影响清理本身，下一轮重试）；同一份清单用 `runExclusive` 单飞，多进程不会双删。
- **只清到期清单**：`status=pending` 且 `deadlineAt <= now`（删除请求起 7 天）。未到期不动任何数据。
- **清理范围**（按依赖顺序先删引用者）：`jobs`、`inbox`（按 actionRef 归属）、`deliveries`、`actions`、`rounds`、
  `snapshots`、`sessions`、`notificationItems`、`notificationSelections`、`investigationAlerts`、
  `comparisonOperations`/`comparisonFollowUps`/`comparisonResults`、`evidenceOperations`/`evidenceSources`/
  `evidenceVersions`/`evidenceHeads`、`taskOperations`/`taskVersions`/`tasks`；
  完成后清单置 `status=cleaned` + `cleanedAt`。
- **存储端口**新增 `Table.remove(ids)` 批量删除（内存与 PostgreSQL 都实现，PG 用 `id = ANY($1::text[])`），
  清理不靠逐条 `delete` 往返。
- **可重试**：任一步失败时清单保持 `pending`、已删的行不复活；下一轮从头重放（删除幂等），
  不会因为别人失败而跳过其他用户的清单。
- **冻结卡片同步摘除**：已发送批次的卡片内容冻结在 `Delivery.card.items` 里，只删 `notificationItems`
  会让已删任务的标题/摘要继续出现在「通知记录」。清理时按任务精确摘除这些条目（优先 `detailUrl` 中的
  `/tasks/{id}`，退回标题匹配），**同批次其他任务的内容保留**。
- **投递归属按 session/round 定位**：决策卡与结果回执由 `queueDelivery()` 创建，**不写 `ownerId`**；
  清理不能用 `ownerId` 过滤，否则会漏掉含业务正文的投递与 `send_delivery` 任务。
- **逐份隔离**：单份清单失败只保留它自己的 `pending`（结果里的 `failed` 列表），其他清单与审计清理
  继续执行；失败原因只记日志，不写进业务数据。
- **调度不依赖队列空闲**：清理计时在领取任务之前判断，任务持续可领时仍按间隔执行；
  同一间隔内不重复触发。
- **不清理**：来源域（`sourceItems`/`sourceSnapshots` 等按 #41 自己的 30 天策略）、身份/配置、模型凭据。

### 最小审计（#40，180 天）

- 表 `auditEvents`（迁移 **16**）：`{id, at, kind, actorId, objectId?, detail?}`，只存动作与对象引用，
  **不保存业务原文、标题、摘要或凭据**。
- 写入点：本人确认删除（`task_deleted`/`owner_request`）、保留期到期自动排单（`task_deleted`/`retention_expired`）、
  清理完成（`task_purged`）、审计自身清理（`audit_purged`）。
- 保留 **180 天**，按每条记录自身 `at` 计算；**恰好等于边界时保留**，越过才清（与业务删除互不影响）。
- 迁移 16 同时给 `tasks`/`evidenceHeads`/`evidenceVersions`/`evidenceSources`/`comparisonResults`/
  `investigationAlerts`/`sessions`/`deliveries`/`notificationItems`/`notificationSelections`/`marketEvents`
  补 `data->>'ownerId'` 索引，配合存储端口 `Table.listByOwner(ownerId)`，清理不再靠整表扫描。

### 备份淘汰与恢复重放（#40 S4b，演练阶段）

用户 2026-11-17 确认：备份目标用对象存储 + 版本化/生命周期；**演练阶段不加密**（仅一次性演练库）；
暂不设 RPO/RTO，只验证「能恢复、不复活」；37 天为**软目标**（淘汰失败只记日志与审计）。

- `LifecycleBackupService.evictOnce(store)`：`store` 只需实现 `list()`/`remove(name)`。
  - 规则 1：任何超过 **30 天**的备份对象都删；
  - 规则 2：删除请求满 **37 天**后，所有**早于该请求**的备份都必须消失（它们可能含已删数据）；
  - 软目标：失败逐条记录在 `failed`，删不掉的残留在 `violations`，并写 `backup_evicted` 审计；
  - 不负责打备份本身，也不宣称"受控备份"（演练阶段无加密）。
- **删除清单外置**（`lifecycle-manifest.ts`）：`serializeManifest`/`parseManifest` 逐行 JSON，
  坏行直接报错而不是跳过——重放时静默忽略一行等于让已删数据复活。
- **重放**（`LifecycleDeletionService.replay`）：外置清单是删除台账而非清理进度，
  重放一律写回 `pending`（旧备份里数据仍在，需要重新清），并立即给恢复出来的任务打墓碑。
- **演练命令**：`bun run lifecycle:drill`（`scripts/acceptance/lifecycle-restore.mjs`）
  - 只操作自建容器（前缀 `adpulse-lifecycle-drill-`，端口随机绑定 127.0.0.1），不读既有
    `DATABASE_URL`/`TEST_DATABASE_URL`、不 `sudo`、不接受外部容器名；
  - 流程：造数据 → **删除前** `pg_dump` → 删除 + 在线清理 → 导出清单 → 恢复旧备份（任务确实复活）
    → 重放清单 + 清理 → 断言任务/证据/通知条目消失、清单 `cleaned`、审计留痕；
  - 固定时钟注入，不靠真实等待；输出 JSON 摘要，失败非零退出。

### 手工备份与恢复（#40 试点阶段方案 B）

用户 2026-11-17 决定：**试点阶段不做自动备份**，改为手工备份 + 明确的风险接受。
本节描述能做到什么、明确做不到什么。

**为什么只做手工**：备份救不了"误删任务"（删除是物理删除，恢复旧备份后仍要先重放删除清单），
它能救的是磁盘/容器损坏、误清库、错误迁移。试点只有 1 个账号、数据 ~28 KB，
自动化的边际价值低于凭据管理与"证明 37 天淘汰"的维护成本。

**打一份备份**（只读数据库，不写业务表，不打印连接串）：

```bash
# 试点机：node 参数必须在脚本路径之前
node --env-file=<api.env> scripts/backup-manual.mjs \
  --out ~/adpulse-manual-backups --keep 4
# 本机：有 pg_dump 就用本机，没有则用一次性 postgres 容器代打
bun run backup:manual -- --out ./backups
```

输出 JSON：文件路径、大小、sha256、`gzipVerified`、被清理的旧备份、**淘汰结果**（`evicted`）、执行耗时。
文件权限 `600`、目录 `700`；默认保留最近 4 份（`--no-prune` 关闭）。

打完备份后还会跑一次 `LifecycleBackupService.evictOnce`，把 `--out` 目录当作备份存储：
**超过 30 天的备份删除**；**删除请求满 37 天后，早于该请求的备份删除**；失败是软目标（记日志与
`backup_evicted` 审计，不阻断备份本身），可用 `--no-evict` 跳过。这样"备份淘汰"不再是死代码。

**恢复**（手工，两步，顺序不能反）：

```bash
# 0) 先从**在线库**导出删除清单（独立于备份保存；早于删除请求的备份里没有它）
node --env-file=<在线库 env> scripts/lifecycle-export-manifest.mjs --out manifest.jsonl
# 1) 恢复到独立新库（不要覆盖在线库）
gunzip -c adpulse-<stamp>.dump.gz | psql "postgres://.../adpulse_restored"
# 2) 重放清单 + 按到期规则清理（`--now` 固定时钟，便于断言；不传则用当前时刻）
node --env-file=<目标库 env> scripts/lifecycle-replay.mjs manifest.jsonl --now 2026-01-08T00:00:00Z
```

- 重放采用"台账"语义：清单条目一律写回 `pending` 并立即给恢复出的任务打墓碑，再交给清理；
  已存在条目不会被覆盖（更早的请求优先）。
- 若备份**早于**删除请求，重放会新增条目（`inserted>0`）；若备份本身已含清单（删除后才备份），
  则 `kept>0`，清理同样会执行。
- `lifecycle:replay` 还会**撤销恢复库中的全部浏览器会话**（并作废未完成登录事务），
  必须重新走飞书认证；这正是 #40 要求的「先应用删除/到期/撤销规则，再启用入口与 worker」。
- 顺序不能反：先重放清单与撤销，再启用 API/worker。

**清理进度可见**：任务列表页顶部「删除与清理状态」显示本人删除请求的 `等待清理` / `已清理`
与请求、截止、完成时间（`GET /api/me/lifecycle-deletions`，只含状态与时间，不含业务正文）。

**明确不做 / 不能宣称**：

- 不是受控备份：不加密、无独立存储位置、无 37 天淘汰证明、无 RPO/RTO。
- 没有定时任务：漏了就漏了，需要人工记得执行（建议发版前 + 每周一次）。
- 删除清单**不在**这份 dump 里；只恢复 dump 会让已删数据复活——必须重放清单。

### 仍未包含

- **生产备份本身**（对象存储桶、凭据、生命周期规则）与加密、RPO/RTO：演练阶段不覆盖，
  不得据此宣称"备份已达标"或"受控备份已就绪"。
- 已送达飞书副本与在途网络请求不可撤回；平台端不承诺 exactly-once。

## 8. 扩展与现有限制

新接 IM：在 channels 中实现 InboundChannel 和 OutboundChannel，构造 ChannelAccount，在 runtime 注册。增加原始请求/ACK、渲染、账户隔离与重试测试；不要把平台字段或 HTTP 响应移入 core。

更换策略：实现 PolicyEngine 并通过 compose 注入。候选必须带冻结的 changes 和 complete 标志；内核不信任模型的边界判断，会重复校验变更和操作者。

生产前仍需：
真实平台验收、正式认证尚未经真实应用/HTTPS 环境验收、数据保留策略、旧库结构迁移的执行与演练（版本化迁移已就位）、分页、限流/监控、失效原因提示和长任务租约续期。发送前已有过期/失效投递抑制，但不撤回已送达卡片，也不能完全消除检查与发送间的竞态。消息端到端不承诺 exactly-once。

设计过程遵循 XEngineer 规范：工程提案与设计澄清由 Issue 承载，进入开发即定稿只读，变更新开增量说明；本文仅随实现维护使用方式。当前已合并交互内核与最小控制台，下一阶段待评审提案见 [#6](https://github.com/JunLang-7/AdPulse/issues/6)。
