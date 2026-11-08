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

## 5. 群聊全链路

```bash
bun run feishu:acceptance -- \
  --scenario group --chat-id oc_真实群 --open-id ou_授权成员 \
  --public-url https://你的域名/webhooks/feishu-internal --write
```

判据与第 4 节完全相同（同一套 `dm`/`group` 断言），差别只有收件人是群 `chat_id`：

- 群成员不会自动获得决策权：`allowedActorIds` 只含 `--open-id` 那一位。
- 群内其他成员误点会被记 `rejected/forbidden`，不影响本次判定（断言取「存在 processed」）；
  这类记录本身是第 7 节的证据。
- 群聊证据不代表允许把个人订阅或决策记录默认发到群里。

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
（`127.0.0.1:5433/adpulse_acceptance`），且 API 也连这条库。不满足时整步记 `skip`，
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
不是平台推送；平台推送下的同类行为以第 4/5 节的真实点击证据为准。

## 7. 拒绝类场景

```bash
bun run feishu:acceptance -- \
  --scenario reject --chat-id oc_真实群 \
  --open-id ou_授权成员 --other-open-id ou_未授权成员 --write
```

需要真实第二位成员配合：由 `--other-open-id` 那位点一次，再由授权成员点一次。

判读：

| 断言 | 通过条件 | 失败时先看 |
| --- | --- | --- |
| 未授权成员点击被拒 | `rejected` + `reason=forbidden` | 若为 processed，说明群成员被默认授权 |
| 策略与轮次未被修改 | `version`、快照、`round1=open` 不变 | 领域校验是否先于状态变更 |
| 被拒的确实是未授权账户 | `actor != --open-id`，且等于 `--other-open-id` | 点名的是否同一人 |
| 授权成员点击正常生效 | `processed` 且 `version` +1 | `allowedActorIds` 与投递账户是否一致 |
| 被拒记录不被改写 | `rejected` 记录仍存在且原因不变 | inbox 终态不可变 |

群聊误点、同轮重复、旧卡与过期的其余组合由第 6 节的 `rounds` 覆盖。

## 8. 投递失败与业务成功分离

```bash
bun run feishu:acceptance -- --scenario failure --open-id ou_授权成员 --write
```

场景用一个不存在的 `open_id` 让平台真实返回发送失败；**不需要人工点击、不会发出真实消息**。

判读：

| 断言 | 通过条件 | 说明 |
| --- | --- | --- |
| 投递失败且错误可定位 | `delivery=failed` + `lastError` 含平台错误码，无消息 ID | 实测 `code 99992351` |
| 业务侧不受影响 | 轮次 `answered`、`version` +1、快照 +1、inbox `processed` | 投递失败不改写业务结论 |
| 任务可重试 | 发送任务 `failed`、`attempts>1` | worker 重试上限 |
| 重试复用同一 `delivery.id` | 投递条数不增加、原 `id` 仍在 | 平台 `uuid` 去重语义 |
| 重试确实重新执行 | `attempts` 回退（5 → 0） | `/api/jobs/{id}/retry` 只接受 failed |

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
  平台推送下的同类行为以第 4/5 节的真实点击证据为准。
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
