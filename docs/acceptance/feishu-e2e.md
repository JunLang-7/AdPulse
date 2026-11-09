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

### 场景驱动器的凭据

#34 之后控制台只有会话 Cookie：先人工登录一次，把 `adpulse_session` 放进 `ADPULSE_SESSION_COOKIE`，
并把 `PUBLIC_ORIGIN` 设为浏览器实际 origin。Cookie 只注入当前终端，不写入仓库、记录或 CI。
**不引入测试会话注入入口**；如将来需要，须单独评审并限制在测试环境。
