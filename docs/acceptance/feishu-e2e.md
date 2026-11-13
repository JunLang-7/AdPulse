# 飞书真实应用端到端联调（Runbook 与留证模板）

对应 Issue [#12](https://github.com/JunLang-7/AdPulse/issues/12)。本文件是可执行的操作与判读标准；
验收记录写到 `docs/acceptance/records/`（默认不纳入版本控制，见第 8 节）。

**边界**：验证目标是当前已实现的飞书**原生 HTTP 出入站**在真实应用下的行为。合成签名、密文与模拟 HTTP 的
单测在 [tests/channels.test.ts](../../tests/channels.test.ts)，**不能充抵真机证据**；本文件的自检脚本
（[scripts/feishu-acceptance.mjs](../../scripts/feishu-acceptance.mjs)）只覆盖可脚本化的部分。

## 1. 前置清单

| 项 | 要求 | 是否就绪 |
| --- | --- | --- |
| 自建应用 | 固定租户的企业内部自建应用（非群 webhook 机器人、非商店应用） | ☐ |
| 应用能力 | 已启用机器人、消息发送权限（`im:message`）与应用可用范围，且**已发布版本** | ☐ |
| 回调配置 | 新版 `card.action.trigger` 事件回调，订阅方式为「长连接或推送到服务器」中的**推送到服务器** | ☐ |
| 公网地址 | HTTPS 域名经可信反向代理转发到 `127.0.0.1:<PORT>/webhooks/<FEISHU_ACCOUNT_ID>` | ☐ |
| 代理约束 | 不改写请求体、不重序列化 JSON，保留 `x-lark-request-timestamp/nonce/signature` 头与原始字节 | ☐ |
| 校时 | 服务器已接 NTP；回调签名允许 ±300s | ☐ |
| 数据库 | 专用 PostgreSQL（非内存存储），`DEMO_MODE=0` | ☐ |
| 收件人 | 受控单聊用户 `open_id` 与受控群 `chat_id`，且机器人已在群内 | ☐ |
| 配合人 | `reject` 场景需要一位未授权成员在群里点一次（否则该场景无法取证） | ☐ |
| 隔离实例 | `db-down` 场景需要一条指向自建一次性库的隔离 API（禁止对生产库停库） | ☐ |
| 凭据 | `FEISHU_APP_ID/APP_SECRET/TENANT_KEY/VERIFICATION_TOKEN/ENCRYPT_KEY` 只存本地 `.env` | ☐ |

缺失项直接标为阻塞，不臆测结果。

## 2. 启动与自检

```bash
bun install --frozen-lockfile
bun run build
bun run start                 # 另一个终端；DEMO_MODE=0 + DATABASE_URL

bun run feishu:acceptance -- \
  --public-url https://你的域名/webhooks/feishu-internal \
  --chat-id oc_xxx --open-id ou_xxx
```

判读：

- `fail` 必须先解决；`skip` 不计入验收。退出码非 0 表示存在 `fail`。
- `protocol.*`：用**真实 encrypt key** 构造本地回调，验证验签、AES-256-CBC 解密、卡片动作归一化，
  并确认篡改签名/过期时间戳 → 401、错误 verification token/tenant_key → 403。这些是「错配置有可定位结果」的本地证据。
- `platform.token` / `platform.tenant`：应用凭据有效，且凭据所属租户与 `FEISHU_TENANT_KEY` 一致。
- `platform.bot`：机器人已启用；**发送权限仍需真机发送验证**，本脚本读不到 scope 列表。
- `clock.skew`：与飞书服务器的时钟偏差，> 240s 会让所有回调 401。
- `webhook.reachability` / `webhook.challenge`：公网地址对未鉴权请求返回 401 或 403（被拒绝且不回 challenge），
  自签 challenge 返回 200。两者合起来证明反代送达原始字节。**自签不等于平台推送**，平台触发的 challenge 仍须第 3 步人工确认。

`--scenario <id>` 会先跑这套自检作为前置：存在 `fail` 即中止，避免在错配置上让人白点。
`--skip-preflight` 只供本地调试，不能用于真机留证。可用场景用 `--list-scenarios` 查看。

## 3. 平台触发的 challenge、签名与解密

操作

1. 在开发者后台「事件与回调 → 加密策略」确认 Encrypt Key 与本地一致，并开启加密推送。
2. 打开事件订阅配置，点击后台的「验证」/保存回调地址，触发平台 challenge。
3. 故意把 `FEISHU_VERIFICATION_TOKEN` 改错一位并重启，再触发一次 challenge；随后改回。

预期与判读

- 正确配置：后台校验通过，服务端返回 `{"challenge": "..."}`。
- 错配置：后台显示校验失败，服务端返回 401/403 且日志可定位（`invalid signature timestamp` /
  `invalid signature` / `invalid verification token` / `callback identity mismatch`）。
  错误必须能对应到具体配置项，不能只有 500。
- 记录：challenge 触发时间、返回码、错误文案、对应配置项。

## 4. 单聊全链路（卡片 → 点击 → 持久化 → 处理 → 确认）

```bash
bun run feishu:acceptance -- \
  --scenario dm --open-id ou_真实用户 \
  --public-url https://你的域名/webhooks/feishu-internal --write
```

场景自动完成：建会话 → 等第 1 轮卡片送达 → 提示点击 → 断言 → 等第 2 轮卡片 →
提示点击 → 断言 → 写记录。**人工只做两次点击**（单步窗口默认 300s，
真机时用 `--step-timeout 1800` 放宽，避免人不在客户端前时白等）。

判读：

| 断言 | 通过条件 | 失败时先看 |
| --- | --- | --- |
| 第 1 轮决策卡已投递 | `delivery=sent` 且有消息 ID | `FEISHU_APP_SECRET`、机器人权限、worker 是否运行 |
| 第 1 轮处于待选择状态 | `round1=open`、`status=awaiting_input`、`roundNo=1` | `prepare_round` 任务 |
| 候选与动作一一对应 | 候选数 = 动作数，均带不透明 `actionRef` | 卡片构建 |
| 第 1 轮记录所选选项与平台操作者 | `option=observe`、`actor=platform/ou_***` | 是否点了别的按钮 |
| 版本递增且快照增加 | `version` +1、快照 +1 | 事务提交、版本校验 |
| inbox 已 processed | 存在 `processed` 的 inbox | worker 处理 `process_inbox` |
| 继续观察后进入第 2 轮并送达新卡 | `roundNo=2`、`round2=open`、投递 sent | 下一轮准备与投递 |
| 会话 completed 且收到结束确认卡 | `status=completed`、`confirmation=sent` | confirmation 投递 |
| 两轮共两次快照与两条 processed inbox | 快照 +2、`processed=2` | 终态一致性 |

- 点击后的观测区间记为 `skip`：它包含人工耗时与 1s 轮询粒度，**不是**服务端 ACK 时延，不计入验收。
- 无人点击 → 该步 `blocked`、退出码非 0；本次不计入验收，重跑即可（不产生 `fail`）。
- 这些断言标为 `platform-real`：由平台真实推送与真实点击驱动。

## 5. 个人会话禁止发群

```bash
bun run feishu:acceptance -- \
  --scenario group --chat-id oc_测试群 --open-id ou_本人 --write
```

#34 的个人身份规则禁止群收件人。`group` 命令现在断言建会话返回
`400 personal sessions require a user recipient`，不创建或发送群卡片；证据为 `local-real`。
旧版本群聊往返记录只证明当时的实现，不适用于当前个人权限模型。

## 6. 落库前失败与重复点击

```bash
# 落库前失败 + 恢复后单次处理（隔离实例，禁止对生产库停库）
bun run feishu:acceptance -- \
  --scenario db-down --open-id ou_授权成员 --managed-db \
  --api http://127.0.0.1:3301 --step-timeout 300 --write

# 旧卡 / 同轮重复 / 过期提交
bun run feishu:acceptance -- --scenario rounds --open-id ou_授权成员 --write
```

`db-down` 的前置：`DATABASE_URL` 必须指向本脚本自建的一次性库
（`127.0.0.1:5433/adpulse_acceptance`），且 API 必须是下述出站故障夹具、用当前用户的真实登录会话。不满足停库条件时整步记 `skip`，
**不会**停止任何其他数据库。一次性容器只由脚本创建（名称前缀 `adpulse-acceptance-`、
label `adpulse.acceptance=1`、固定端口 5433），默认退出即清理，`--keep` 保留。

判读：

| 断言 | 通过条件 | 说明 |
| --- | --- | --- |
| 落库失败时不返回成功 ACK | HTTP 5xx（实测 503） | 若为 2xx，说明 ACK 早于持久化 |
| 恢复后同一事件被接受 | HTTP 200 | 连接池需能重连（#28） |
| 恢复后只处理一次 | `inbox=1 processed`、`answered=1`、`version` 只 +1 | 失败请求不应留下 pending inbox |
| 旧卡 / 重复提交被拒 | `rejected/already_handled`，`version` 不变 | `rounds` 场景 |
| 过期会话提交被拒 | `rejected/expired` | `rounds` 场景；短有效期会话未及时出卡时记 `skip` |
| 同键重放返回原 inbox | 同 `sourceId+eventId` 返回同一条 | 见第 11 节的既有记录（2026-11-06 replay） |

补充说明：`db-down` 与 `rounds` 的回调由脚本按真实密钥签名（`local-real`），
不是平台推送；平台推送下的同类行为以第 4 节的真实点击证据为准。

## 7. 拒绝类场景

```bash
bun run feishu:acceptance -- \
  --scenario reject \
  --open-id ou_授权成员 --other-open-id ou_未授权成员 --write
```

使用本人单聊收件人。将该验收卡片转发给 `--other-open-id` 指定的第二位真实测试成员，
由他点击一次，再由本人在原单聊卡片点击「继续观察」。转发不授予访问/决策权限。
若客户端转发不保留交互，或无人配合，该项保持 `blocked`，不能以自签回调追认为平台验收。

判读：

| 断言 | 通过条件 | 失败时先看 |
| --- | --- | --- |
| 未授权成员点击被拒 | `rejected` + `reason=forbidden` | 若为 processed，说明转发接收人被错误授权 |
| 策略与轮次未被修改 | `version`、快照、`round1=open` 不变 | 领域校验是否先于状态变更 |
| 被拒的确实是未授权账户 | `actor != --open-id`，且等于 `--other-open-id` | 点名的是否同一人 |
| 授权成员点击正常生效 | `processed` 且 `version` +1 | `allowedActorIds` 与投递账户是否一致 |
| 被拒记录不被改写 | `rejected` 记录仍存在且原因不变 | inbox 终态不可变 |

同轮重复、旧卡与过期的其余组合由第 6 节的 `rounds` 覆盖。

## 8. 投递失败与业务成功分离

```bash
bun run feishu:acceptance -- --scenario failure --open-id ou_本人 \
  --api http://127.0.0.1:3301 --skip-preflight --write
```

当前场景使用本人收件人，连接 **仅本地验收工具** `failure-server.mjs`，由出站端口注入失败，
不调用飞书发送 API、不发送真实 IM。证据为 `synthetic`，不能证明飞书错误码或平台去重窗口。
正式 API 没有故障开关、测试会话注入或旁路认证；场景先在已认证的 `/api/me` 响应核对夹具标记，
未核对通过则在建会话前 `blocked`。

准备一次性环境（先 `bun run build`；凭据仍只放本地 `.env`）：

```bash
# 固定验收库，禁止指向旧库；脚本只监听 127.0.0.1:3301。
# 使用受管容器约定的本地密码，详见 scripts/acceptance/docker.mjs。
# 仅允许 postgres/postgresql URL，不接受查询参数或片段（包括 host/port/database 覆盖）。
DATABASE_URL=postgres://postgres:acceptance-local-password@127.0.0.1:5433/adpulse_acceptance \
  node --env-file=.env scripts/acceptance/failure-server.mjs
```

`PUBLIC_ORIGIN` 必须与访问该隔离实例的浏览器同源。通过正常飞书 OAuth 登录此实例，
把本次 `adpulse_session` 仅注入执行终端的 `ADPULSE_SESSION_COOKIE`（不能复用其它库的会话）。
在同一 `DATABASE_URL` / `PUBLIC_ORIGIN` 下执行：

```bash
# 本地故障注入不做平台留证，可跳过平台自检。
bun run feishu:acceptance -- --scenario failure --open-id ou_本人 \
  --api http://127.0.0.1:3301 --skip-preflight --write
# db-down 使用同一个夹具及会话，回调仍走真实验签/身份映射。
bun run feishu:acceptance -- --scenario db-down --open-id ou_本人 \
  --api http://127.0.0.1:3301 --managed-db --skip-preflight --write
```

停止夹具时会关闭 API/worker/连接池，并只清理它本次创建的容器；已存在且符合归属约束的容器不会删除。
不启动其它 worker 连接该库，避免另一进程使用真实出站适配器发送卡片。

| 断言 | 通过条件 | 说明 |
| --- | --- | --- |
| 投递失败 | `delivery=failed`、固定故障标记、无消息 ID | 出站端口本地失败 |
| 业务侧不受影响 | 轮次 `answered`、`version` +1、快照 +1、inbox `processed` | 投递失败不改写业务结论 |
| 任务可重试 | 活跃第 2 轮的发送任务 `failed`、`attempts>1` | 不重试已答轮次的旧卡 |
| 重试复用同一 `delivery.id` | 任务仍引用原投递、条数不增加 | 不将本地测试当作平台去重证据 |
| worker 确实重新执行 | 同任务有新的 `leaseToken`、`attempts>0`，且再次到达投递失败终态 | 仅 pending/attempts=0 不通过；worker 停止则 blocked |

系统**不承诺 exactly-once**：外部已发送但本地未回写时重复发送是已知风险；
窗口内外差异见 `2026-11-06-dedup-within/outside.json` 的单样本观察。

## 9. 时延取数（3 秒预算）

服务端仍没有专用的 ACK 时延指标（第 10 节缺口）。可用取数：

1. 自检的 `webhook.challenge` 往返（含代理与验签解密；实测 272–317ms）。
2. 反向代理日志的 upstream 响应时间（nginx `$upstream_response_time`、Caddy `duration`）。
3. 历史隔离代理样本：`2026-11-06-proxy.jsonl`（真实点击回调 27–39ms）。

不要用场景里的「点击到观测到迁移」区间当作时延：它包含人工点击耗时
（实测 13–167s）和 1s 轮询粒度，证据里已标 `skip`。

超时测试：在代理层注入延迟使 upstream 超过 3s，确认平台侧显示失败、
本地不产生成功 ACK、重试后不重复生效。

## 10. 已知缺口与阻塞登记

- 缺少服务端 `webhook 接收 → ACK` 的显式时延指标，需另开 Issue 补日志/指标；在此之前用第 9 节替代取数。
  场景里的「点击到观测」区间含人工耗时，已在记录中标 `skip`，不得充当时延证据。
- `db-down`、`rounds` 的回调由脚本按真实密钥签名（`local-real`），不是平台推送；
  平台推送下的同类行为以第 4 节的真实点击证据为准。
- `reject` 需要第二位真实成员配合；缺人时该项保持未覆盖，不追认。
- 控制台尚未跟踪异步终态（[#11](https://github.com/JunLang-7/AdPulse/issues/11)），核对终态需刷新或查 API。
- 撤回/更新已送达卡片、worker 租约续期、版本化数据库迁移未实现；不要把这些列入本次验收。
- 任何凭据缺失、公网不可达、数据库不可用 → 标记阻塞，未覆盖项保持未验收。

## 11. 记录与脱敏

```bash
# 自检记录
bun run feishu:acceptance -- --public-url https://... --chat-id oc_xxx --open-id ou_xxx --write
# → docs/acceptance/records/<UTC 时间>-feishu-e2e.md（元信息 + 自检 + 验收项表）

# 场景记录（每个场景一份）
bun run feishu:acceptance -- --scenario dm --open-id ou_xxx --write
# → docs/acceptance/records/<UTC 时间>-scenario-dm.md
```

记录里「验收项与执行方式」一栏标明该项由脚本断言还是需真人操作；场景开跑后
同一份记录即可作为该场景的证据，不必再手抄一遍。

- 记录里只写脱敏标识：`cli_***f9`、`t***3a`、`oc_***9f2a`；真实姓名、手机号、完整 `open_id`、群名一律不写。
- 自动检查与场景断言每行都带证据来源：`platform-real`（平台真实推送或真实用户交互）、
  `local-real`（真实凭据或平台 API 由本地发起）、`synthetic`（假凭据或 mock）。只有 `platform-real` 可勾选真机项；
  脚本输出 `blocked`（未等到人工动作）与 `skip` 一样不计入验收。
- `docs/acceptance/records/` 默认被 `.gitignore` 忽略。确需入库时先逐行复核脱敏，再用 `git add -f` 显式提交。
- 约定：**逐次运行的明细记录不入库**（避免把仓库当日志盘）；每个已收口 Issue 只在本文件对应章节保留一段
  ≤10 行的脱敏结论摘要（见 §14 末尾），明细留在本地 `docs/acceptance/records/`，Issue 正文持有结论与未覆盖项。
- 不粘贴平台响应中的 token、secret、`tenant_access_token` 或带签名头的完整请求。

## 12. 结论填写规则

- 只勾选**真机执行且留有证据**的项；自检脚本通过、HTTP 200、构建成功都不算验收。
- 只有 `platform-real` 行可支撑真机项；`local-real`（含自签名回调驱动）只能证明实现与配置，
  `synthetic` 只能证明代码路径。`blocked`/`skip` 一律不计入验收。
- 未覆盖项保留空白并写明原因（缺环境/缺权限/未实现），不追认提案状态，不宣称市场信号主链路或 Web 主线已完成。
- 需要修复的问题走独立 PR，不在验收记录里夹带功能改动。

## 13. 登录类验收取证（#34）

本节说明**每条登录验收项靠什么取证**，不重复 #34 的设计正文，也不代替其结论。
执行方式分三类：`脚本断言`（可重复的自动化证据）、`人工操作`（只能在真实客户端/浏览器完成）、
`未覆盖`（明确不做或由其它 Issue 承担）。

| #34 验收项 | 执行方式 | 证据位置 / 命令 |
| --- | --- | --- |
| 飞书内授权与浏览器授权登录同一内部账号，机器人与控制台映射一致 | 脚本断言 + 待真实客户端 | `tests/feishu-auth.test.ts`（PKCE/换票/租户作用域）、`tests/authentication.test.ts`（绑定复用）、`tests/api.test.ts`（会话与 actor 映射） |
| 两名用户自动开通、并发回调不重复建号、再次登录复用 | 脚本断言 | `tests/postgres.test.ts`：`auth migration is idempotent and concurrent first logins reuse one user` |
| 范围外/伪造/错应用/回调重放/未认证被拒 | 脚本断言 | `tests/feishu-auth.test.ts`（租户不符、提供商拒绝、传输失败）、`tests/api-auth-audit.test.ts`（重放 → `login_transaction_invalid`） |
| 仅本人访问；伪造他人 task/evidence/session/inbox/job ID 被拒 | 脚本断言 | `tests/api.test.ts`：`task API … scopes access`、`saved comparison … owner-scoped`、`webhook choices are processed only when the actor maps to the session owner` |
| 换身份认领/人工换绑/姓名邮箱迁移/管理员代登录不支持 | 脚本断言 | `tests/authentication.test.ts`：`personal users are stable only within the full scoped external identity`、`verified identities … expose only own bindings` |
| 会话最长 8 小时、到期前/中/后、普通访问不续期、无开发 token 回退 | 脚本断言（注入时钟） | `node --test --test-name-pattern="eight-hour absolute session expiry" tests/api.test.ts`（约 20ms，不依赖等待） |
| 退出/撤销后立即失效 | 脚本断言 + 人工 | `tests/authentication.test.ts`：`revoking an identity invalidates every associated web session`；浏览器退出可直接观察 |
| 到期不删除账号/订阅；机器人侧仍验证身份 | 部分脚本断言 | 会话与用户/绑定分离由 `createWebSession`/`authenticateSession` 语义覆盖；**订阅侧属 #35，未覆盖** |
| 企业身份失效/解绑/恢复规则可测 | 脚本断言 + 待注入 | `revoking an identity …`、`PostgreSQL: queued platform action is refused after its binding is revoked`；真实离职/停用事件尚未实测 |
| 卡片直达回跳覆盖各登录态，外站/伪造返回目标被拒 | 脚本断言 + 人工 | `tests/console-auth.test.ts`：`return targets keep in-console paths and reject external or ambiguous values`、`expired sessions return to the sanitized current page`；真实卡片点击后的回跳需人工走一次 |
| 独立新库 schema 基线/迁移/回滚、同域 HTTPS 与安全 Cookie | 脚本断言 | `PostgreSQL: auth migration …`、`production OAuth cookies are Secure and callback URI uses the shared HTTPS origin` |
| 受控真实企业飞书验证授权登录与身份映射，证据脱敏 | 人工操作 | 受控账号完成一次真实登录；记录写 `docs/acceptance/records/`，**不得写入 Cookie 值或完整 open_id** |

### 登录拒绝的可观测输出

API 对登录/会话拒绝输出一行 JSON（默认 stdout；测试可注入 `auth.audit` 收集）：

```json
{"event":"auth.reject","reason":"session_invalid","method":"GET","path":"/api/me"}
```

| reason | 含义 | 排查方向 |
| --- | --- | --- |
| `login_request_invalid` | 登录入口返回目标非法，或回调缺少 state/code/绑定 cookie | 站内 returnTo 白名单、浏览器 Cookie |
| `login_transaction_invalid` | 一次性事务不存在（重放、过期或绑定不符） | 是否重复使用同一回调链接 |
| `identity_rejected` | 换票或身份校验失败（租户/应用不符、传输失败） | 应用凭证、租户、网络 |
| `session_missing` | 未携带或格式非法的 `adpulse_session` | 是否已登录、Cookie 域 |
| `session_invalid` | 会话不存在/已过期/已撤销 | 8 小时上限、退出与撤销 |
| `origin_mismatch` | 副作用请求的 `Origin` 与 `PUBLIC_ORIGIN` 不一致 | 控制台与 API 是否同源 |

边界：`login_transaction_invalid` 不区分「过期」与「重放」，`identity_rejected` 不区分具体平台错误；
日志只含原因/方法/**不含查询串的路径**，不写 cookie、`code`、`state`、`open_id` 或租户值。

### 卡片直达（#59）

卡片在 `PUBLIC_ORIGIN` 为 HTTPS 时带「查看详情」，指向 `${PUBLIC_ORIGIN}/sessions/<id>`。

| 场景 | 预期 |
| --- | --- |
| 未登录点开卡片链接 | 先到登录页，完成飞书授权后**回到该会话详情**，不落首页 |
| 已登录点开 | 直接进入该会话详情 |
| 站外/伪造 `returnTo` | 被 `safeReturnTo` 与服务端校验拒绝，回落到首页 |
| 转发给他人 / 篡改对象 ID | 不因链接本身获得访问权；无权的对象给不泄露他人数据的提示 |

记录打开形态（飞书内嵌浏览器 / 外部浏览器）与回跳目标；链接不含 token 或私有内容。

### 场景驱动器的凭据

#34 之后控制台只有会话 Cookie：先人工登录一次，把 `adpulse_session` 放进 `ADPULSE_SESSION_COOKIE`，
并把 `PUBLIC_ORIGIN` 设为浏览器实际 origin。Cookie 只注入当前终端，不写入仓库、记录或 CI。
**不引入测试会话注入入口**；如将来需要，须单独评审并限制在测试环境。

## 14. 通知目的地与授权（#35）

**边界**：本节只覆盖「机器人的单聊地址」与「是否允许主动发送」；真正的主动推送属 #37。
未授权时系统**不会**发送，因此本节的通过不代表推送能力已完成。

### 14.1 前置

- 控制台可登录（`ADPULSE_SESSION_COOKIE` + `PUBLIC_ORIGIN`，见 §13）。
- 服务端迁移已到 v8（`adpulse_notificationDestinations` / `adpulse_notificationConsents`）。

### 14.2 操作与命令

设置页：`/settings/notifications`，按状态给出动作（确认地址 → 开启 → 撤销 → 重新开启）。

等价接口：

```bash
COOKIE="adpulse_session=<值>"; ORIGIN=https://你的控制台 origin
curl -sS -H "Cookie: $COOKIE" $ORIGIN/api/me/notification-status
curl -sS -X PUT -H "Cookie: $COOKIE" -H "Origin: $ORIGIN" $ORIGIN/api/me/notification-destination
curl -sS -X POST -H "Cookie: $COOKIE" -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  -d '{"action":"grant","expectedVersion":0}' $ORIGIN/api/me/notification-consent
```

**身份不接受客户端传入**：`PUT` 用会话绑定的作用域确定目的地；请求体里的 `externalId` 被忽略。
授权/撤销必须带 `expectedVersion`（从未授权为 0），旧请求重放会返回 409，不能覆盖后来的撤销。

### 14.3 判读

| 状态 | `canSendProactive` | 说明 |
| --- | --- | --- |
| 无目的地 | false | 未确认地址 |
| `verified` + 无授权 | false | 地址可用，但未同意接收 |
| `verified` + `active` | true | 允许主动发送 |
| `verified` + `revoked` | false | 撤销不等于注销，地址仍在 |
| `invalidated`（任意授权） | false | 地址失效，需本人重新确认 |

### 14.4 投递闸门与地址失效

| 场景 | 预期 | 判读依据 |
| --- | --- | --- |
| 系统发起（`initiatedBy=system`）且未授权 | 投递 `suppressed`，渠道未被调用 | `suppressionReason` = `consent_missing` / `consent_revoked` / `destination_missing` / `destination_invalidated` / `identity_inactive` |
| 用户自己创建/处理的会话 | 照常投递 | `initiatedBy` 缺省为 `self`，不受授权闸门限制 |
| 平台报告收件人不可达（Feishu `230002`/`230013`/`99992351`） | 投递 `failed` 且**不重试**；地址置 `invalidated` | 这些码是确定性事实，一次即判，需本人重新确认 |
| 发往**他人**地址失败 | 只记该投递失败，本人地址不受影响 | 不可达记账要求收件人与本人已确认地址一致 |
| 身份绑定撤销 / 用户停用 | 抑制投递，但地址状态不变 | 绑定恢复后地址仍可用 |

### 14.5 真机边界

- 地址来源必须是**真实飞书登录身份**（`identity_bindings` 的 `open_id`），不能手填。
- 系统发起会话目前只有告警路径（web-only）；构造 `system` 会话验证抑制属 `local-real`，
  不当作平台推送证据。
- **实际收到主动消息要等 #37**，本节不宣称送达能力。

### 14.6 验收结论摘要（2026-11-09）

| 项 | 结论 | 来源 |
| --- | --- | --- |
| 目的地由真实飞书身份确认 | `verified`（`ou_83d5b***…`），非手填 | 受控试点库直查 |
| 授权状态机 | 真机走到 `active` v1；撤销/恢复由领域与页面测试覆盖 | 真机 + 测试 |
| 投递闸门 | `system` 未授权 → `suppressed` 且不调渠道 | `local-real`（夹具构造会话） |
| 地址失效判定 | 平台不可达一次即 `invalidated`；他人地址失败不牵连 | 测试（含变异验证） |
| 主动推送真实送达 | **未覆盖**，属 #37 | — |

明细（含时间戳与逐项证据）留在本地记录，不随仓库分发；未覆盖项与边界见 #35 收口说明。

## 15. 订阅与关注（#36）

**边界**：本节只覆盖「关注什么、收哪几类、什么时候发」的**配置**；真正的分拣与投递属 #37。
页面：`/settings/subscriptions`（设置页）；接口见 §14 之后的订阅章节。

### 15.1 判读

| 状态 | 含义 | 是否收到提醒 |
| --- | --- | --- |
| 未确认单聊地址 | 目的地缺失 | 否 |
| 地址已失效 | 平台报告过不可达 | 否 |
| 未授权 / 已撤销 | #35 的授权状态 | 否 |
| 登录绑定失效（`canSendProactive=false`） | 配置齐全但会被抑制 | 否 |
| 订阅推送未开启 | 默认状态，或用户选了「暂不开启」 | 否 |
| 没有生效的关注对象 | 全部退订或未添加 | 否 |
| 已开启订阅推送 | 四项条件齐备且有生效对象 | **是** |

四种状态（配置 / 地址 / 授权 / 开关）必须分开显示，任何一项缺失都不得显示为「会收到提醒」。

### 15.2 规则

- `expectedVersion` 必填，不符 409（其他标签页改过）；旧请求重放不能覆盖后来的修改。
- 对象退订 = `muted`（保留配置可恢复）；类别退订 = 从对象移除类别；「关闭全部主动推送」是第三个动作，三者可区分。
- 时段：`timezone` 必须显式为 `Asia/Shanghai`；汇总时刻落入免打扰区间返回 422。
- 他人任务与他人关注对象一律 404，不确认存在性。
- 保存配置**不等于**可投递：文案与状态必须体现这一点。

### 15.3 验收结论摘要（2026-11-11）

| 项 | 结论 | 来源 |
| --- | --- | --- |
| 页面走查（品牌对象、类别、范围、退订、时段编辑、开启/暂不开启） | 通过，配置版本 0→5，`proactiveEnabled=true` 且免打扰改为 22:00–09:00 | 真机（控制台 + 数据库直查） |
| 首次默认关闭、「暂不开启」无投递 | 首次进入为未开启；执行「暂不开启」后无推送 | 真机 |
| 任务类关注对象、他人任务被拒、双用户隔离 | 通过 | HTTP 与领域测试（真机账号无任务数据，未覆盖） |
| 版本冲突 409、时段 422 | 通过 | 测试；真机走过 422 |
| 关闭全部推送 / 重新开启不补旧队列 | **未覆盖**，队列行为属 #37 | — |

> 队列行为已在第 16 节（#37）单独验收；本节历史结论不改写。

## 16. 日汇总推送（#37）

**边界**：本节验证「批次 → 调度 → 单聊投递 → 记录」这条管线在真实企业飞书单聊上的行为，
以及关闭/退订取消、重开不补旧队列、免打扰顺延、收件人不可达的响应。内容用**带
`【验收测试】` 标记的合成条目**，不代表真实经营内容或企业效果。

本节**不验证订阅筛选**：`NotificationQueue.queue()` 目前没有生产调用方（#38/#39 的事件来源未接入），
所以真实环境不会自己产生汇总条目。合成条目经受控脚本写入，证明的是投递与记录管线，
不是「筛选规则已生效」。

`sent` 只代表渠道接收，不代表用户已读；不承诺平台端 exactly-once。

### 16.1 前置

| 项 | 要求 | 是否就绪 |
| --- | --- | --- |
| 验证实例 | 专用/试点实例，release 与待验收 commit 一致；**禁止**在生产库写合成条目 | ☐ |
| worker | `EMBED_WORKER=1` 或独立 worker 在跑（调度 tick 约 30s） | ☐ |
| 地址 | `GET /api/me/notification-status` 的 `destination.status=verified` | ☐ |
| 授权 | 同一接口 `consent.status=active`、`canSendProactive=true` | ☐ |
| 订阅 | `GET /api/me/subscription` 的 `settings.proactiveEnabled=true`，且有 ≥1 个生效关注对象 | ☐ |
| 记录入口 | 控制台 `/settings/notification-records` 可访问 | ☐ |
| 工具 | `scripts/acceptance/digest.mjs`（`notify:acceptance`），只读 + 合成写入，不发消息 | ☐ |

`DECISION_CARDS_ENABLED` 与本节无关，可保持关闭。

### 16.2 写入受控合成条目

```bash
# 先看现状（不发消息）
bun run notify:acceptance -- status --open-id ou_xxx
# 写入一条带标记的合成条目（需显式确认）
bun run notify:acceptance -- enqueue --open-id ou_xxx --confirm-synthetic
```

脚本行为：`logicalKey` 固定为 `acceptance:digest|synthetic-a`，标题/摘要/相关性/来源都带
`【验收测试】`；同一 `revision` 重复执行返回 `duplicate`（不重复通知），`--revision 2` 视为实质更新。

判读：

- `outcome=queued` 且条目标题带标记；批次 `localDate` 是**北京**当天。
- 今天 09:30 已过 → worker 会在下一个 tick 按「当日补发」发送（记录里 `catchUp=true`）。
  **这只证明管线和补发，不等于 09:30 准点。**
- 当前处于 22:00–08:00 → 批次保持 `queued`、无投递回执，等 08:00 后的 tick。此时记「免打扰顺延」。

### 16.3 真机收到（人工）

1. 在飞书单聊检查是否收到「信息汇总 · <日期>」卡片：标题、intro、条目、页脚文案齐全。
2. 记下收到时间、消息 ID 前缀（脱敏，如 `om_x10***`）、以及 `scheduledAt → 收到` 的间隔。
3. 确认条目内容与标记只来自合成数据，不存在真实业务内容混入。

未收到时不要推测原因：先跑 `status` 看 `status` / `statusReason`，再对照 16.9 判读。

### 16.4 控制台记录核对

打开 `/settings/notification-records`，逐项核对：

| 核对点 | 期望 |
| --- | --- |
| 批次状态 | `已发送`；`catchUp` 时标题带「（当日补发）」 |
| 条目来源 | 显示「以下为发送时实际发出的卡片内容」 |
| 卡片与记录条目 | 标题/摘要/相关性/来源一致；条目数 ≤5（`MAX_INFO_ITEMS`） |
| 页脚「另有 N 条」 | 与记录里顺延到后续批次的条目数一致 |
| 投递回执 | 「平台已接收这条消息，但「已接收」不代表你已读」 |
| 计划时刻 | 北京时间 09:30；与真机收到时间做差 |

### 16.5 关闭推送取消待发

前置：条目已入队但**尚未到计划时刻**，或当前在免打扰时段。

1. 控制台 `/settings/subscriptions` 关闭全部主动推送。
2. 等一个调度 tick（≤30s）后跑 `status`。
3. 判读：批次 `cancelled` + `statusReason=push_disabled`，条目 `cancelled`，`delivery=null`（从未投递）。
4. 真机**不得**收到这条消息。

**在途竞态如实记录**：若 worker 已领取该批次并在发网络请求，消息仍可能送达。
这不是「点关闭瞬间全部拦截」，记录里必须写明实际时序，不承诺撤回。

### 16.6 重开不补旧队列

1. 重新开启主动推送（`/settings/subscriptions`）。
2. `status` 确认被取消的批次仍是 `cancelled/push_disabled`，没有复活、没有补发。
3. 真机确认没有收到旧内容。
4. 再 `enqueue --revision 2`：只有新内容按新批次发送。

### 16.7 免打扰顺延（时间窗受限）

- 真实的 22:00–08:00 只能在窗口内观察：窗口内入队 → 批次保持 `queued`、无投递回执；
  08:00 后 tick 才发送，发送前重新检查开关/授权/地址，若期间失效则不发送。
- 窗口外无法真机复现，用固定时钟的自动化用例（`tests/digest-dispatch.test.ts`、
  `tests/notifications.test.ts`）作为 `local`（非真机）证据，不得勾选真机项。

### 16.8 收件人不可达

1. 让机器人从该用户单聊中离开（或使用一个平台明确判定不可达的地址）。
2. `enqueue --revision 3 --confirm-synthetic`，等 tick。
3. 判读：投递 `failed`，`lastError=recipient unreachable`；批次 `failed` + 原因
   `recipient_unreachable`；条目 `cancelled`；地址一次判定 `invalidated`。
4. 控制台「通知设置」必须出现「重新确认地址」入口，不能静默失败；重新确认**不自动**恢复已撤销授权。
5. 恢复后重新开启推送再验一次送达（回到 16.2）。

### 16.9 判读表

| 记录状态 | 原因代码 | 含义 | 用户是否收到 |
| --- | --- | --- | --- |
| `queued` | — | 未到时刻或在免打扰内 | 否（暂不发送） |
| `sent` | — | 渠道接收 | 是（不代表已读） |
| `cancelled` | `push_disabled` | 关闭全部推送 | 否 |
| `cancelled` | `settings_changed` | 生成后配置改过 | 否（新内容进下一批） |
| `cancelled` | `empty` | 无待发条目（可能已因实质更新进后续批次） | 否 |
| `cancelled` | `merged_stale` | 跨日未发，并入之后汇总 | 否（旧日报不补） |
| `suppressed` | `destination_missing` / `destination_invalidated` / `consent_missing` / `consent_revoked` / `identity_inactive` / `channel_unavailable` | 发送前重检不通过 | 否 |
| `failed` | `recipient_unreachable` | 平台判定不可达 | 否；地址失效 |

### 16.10 留证与结论模板

```bash
bun run notify:acceptance -- status --open-id ou_xxx --json   # 脱敏前不要直接粘贴原文
```

记录写入 `docs/acceptance/records/<UTC>-notification-digest.md`，只保留：release commit、
状态与原因代码、时间戳与计划到发送间隔、脱敏消息 ID 前缀、条目数与来源类型。
**不要**写入 open_id 全值、会话 cookie、卡片全文或真实业务数据。

结论表（逐项填写，未执行就写「未覆盖」，不勾选）：

| 验收项 | 结论 | 来源 |
| --- | --- | --- |
| 受控合成条目入队（幂等） |  | 脚本输出 |
| 真机单聊收到日汇总（含测试标记） |  | 真机 |
| 控制台记录与卡片内容一致 |  | 真机 |
| 关闭推送后待发取消、真机未收到 |  | 真机 + 脚本 |
| 重开不补旧队列 |  | 真机 + 脚本 |
| 免打扰顺延 |  | 时间窗内真机 / 否则 local |
| 收件人不可达 → 地址失效 → 重新确认 |  | 真机 |
| 平台端重复窗口外风险 | **不承诺** exactly-once | — |

### 16.11 未覆盖与边界

- 订阅筛选与来源接入（#38/#39）未实现：本节只证明投递管线，合成条目不能当真实筛选结果。
- 09:30 准点、22:00/08:00 边界：除非执行时恰好在窗口内，否则只有固定时钟用例（`local`）。
- 多用户隔离的真机验证：需第二个真机账号，本节不做；隔离由测试覆盖。
- 平台端物理重复、已送达撤回、exactly-once：不承诺。
