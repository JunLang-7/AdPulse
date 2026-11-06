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
TOKEN=$CONSOLE_TOKEN
curl -sS -X POST http://127.0.0.1:3000/api/sessions \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "idempotency-key: $(uuidgen | tr 'A-Z' 'a-z')" \
  -d '{
    "recipient": {"accountId": "feishu-internal", "kind": "user", "externalId": "ou_真实用户"},
    "allowedActorIds": ["ou_真实用户"],
    "strategy": {"objective": "联调用方案", "audience": [], "channels": {}, "sellingPoints": []},
    "limits": {"maxBudgetChangeRatio": 0.2, "maxBidChangeRatio": 0.2},
    "signal": {"id": "<uuid>", "title": "联调信号", "summary": "合成内容", "evidence": [{"label": "来源", "value": "本地联调"}]},
    "expiresAt": "<1 小时后>"
  }'
```

预期与判读

1. 机器人在单聊中收到决策卡，按钮只带不透明 `actionRef`。
2. 点击「继续观察」：客户端出现 toast「已接收，正在处理」，服务端在该请求内完成 inbox 与任务落库后才 ACK。
3. `GET /api/sessions/<id>` 显示 `round1=answered`、`version` 递增、`snapshots` 增加、`inbox=processed`。
4. 首轮选择「继续观察」后进入第 2 轮；确认后会话 `completed` 并收到结束确认卡。
5. 记录：每次点击的**服务端接收 → 响应完成时延**（见第 9 节的取数方式），是否 < 3s。

## 5. 群聊全链路

同第 4 节，`recipient` 改为 `{"kind": "group", "externalId": "oc_真实群"}`，`allowedActorIds` 只填明确允许点击的用户
`open_id`（群成员不自动获得决策权）。

预期：群内收到卡片；允许成员点击生效；未授权群成员点击被拒绝（第 7 节）。记录群聊的接收→响应时延。

## 6. 失败与重复点击

| 场景 | 操作 | 预期 |
| --- | --- | --- |
| 落库前失败 | 停止 PostgreSQL（保持 API 运行）后点击卡片 | 平台侧失败可见，服务端返回 503，**不产生成功 ACK**；无 inbox 记录；页面给出可重新操作的路径，不依赖平台补推 |
| 恢复后重试 | 重启 PostgreSQL 后再次点击同一张卡 | 正常入库并处理一次 |
| 落库成功、响应丢失 | 断网/超时模拟客户端收不到响应后再点一次 | 第二次点击是新的 `event_id`，但同轮已 `answered` → `rejected`，策略**不重复生效** |
| 同键重放 | 用同一 `sourceId + eventId` 重放同一请求 | 返回原 inbox（幂等），不新增记录；同键不同内容 → 409 |

记录：错误码/错误文案、DB 侧是否出现记录、第二次点击的终态（`rejected` 而非 `processed`）。

## 7. 拒绝类场景

| 场景 | 操作 | 预期 |
| --- | --- | --- |
| 非允许成员 | 让不在 `allowedActorIds` 的群成员点击 | inbox `rejected`；策略不变；客户端提示明确 |
| 同轮重复 | 同一张卡连点两次 | 第二次 `rejected`，`version` 只递增一次 |
| 旧卡 | 进入下一轮后点击上一轮卡片 | `rejected`（轮次已 `answered`） |
| 过期操作 | 把 `expiresAt` 设为已过去时间后点击 | `rejected` |
| 待发送旧卡被抑制 | 在首轮未发送前构造失效（取消会话/改期） | delivery 标记 `cancelled`，**不调用渠道**，平台上不出现该卡 |

核对方式：`GET /api/sessions/<id>` 的 `rounds` / `inbox` / `deliveries` 与控制台详情页（[#11](https://github.com/JunLang-7/AdPulse/issues/11) 完善前的替代路径）。

## 8. 投递失败与业务成功分离

- 让一次发送失败（例如把 `FEISHU_APP_SECRET` 改成错误值，或临时断网），观察：
  - 业务侧选择已持久化、`version` 已递增；
  - delivery 为 `failed`，job 失败可经 `POST /api/jobs/{jobId}/retry` 重试；
  - 重试**复用同一 `delivery.id`**（即飞书 `uuid`），平台去重窗口约 1 小时；窗口外重试仍可能重复。
- 系统**不承诺 exactly-once**：外部已发送但本地未回写时重复发送是已知风险。记录窗口内与窗口外的实际观察结果，
  不写成「平台保证去重」。

## 9. 时延取数（3 秒预算）

服务端没有专用的 ACK 时延指标（已知缺口，见第 10 节）。可用以下替代取数，并在记录中注明来源：

1. `bun run feishu:acceptance -- --public-url ...` 的自签 challenge 往返耗时（含代理与数据库提交前的验签解密）。
2. 反向代理日志的 upstream 响应时间（如 nginx `$upstream_response_time`、Caddy 的 `duration`）对应
   `POST /webhooks/<account>` 请求。
3. 飞书客户端 toast 出现的时间只作主观参考，不作为时延证据。

超时测试：在代理层或临时注入延迟使 upstream 超过 3s，确认平台侧显示失败、本地仍不产生成功 ACK，并且重试后不重复生效。

## 10. 已知缺口与阻塞登记

- 缺少服务端 `webhook 接收 → ACK` 的显式时延指标，需另开 Issue 补日志/指标；在此之前用第 9 节替代取数。
- 控制台尚未跟踪异步终态（[#11](https://github.com/JunLang-7/AdPulse/issues/11)），核对终态需刷新或查 API。
- 撤回/更新已送达卡片、worker 租约续期、版本化数据库迁移未实现；不要把这些列入本次验收。
- 任何凭据缺失、公网不可达、数据库不可用 → 标记阻塞，未覆盖项保持未验收。

## 11. 记录与脱敏

```bash
bun run feishu:acceptance -- --public-url https://... --chat-id oc_xxx --open-id ou_xxx --write
# → docs/acceptance/records/<UTC 时间>-feishu-e2e.md（自动填元信息与自检结果，手工项留空）
```

- 记录里只写脱敏标识：`cli_***f9`、`t***3a`、`oc_***9f2a`；真实姓名、手机号、完整 `open_id`、群名一律不写。
- `docs/acceptance/records/` 默认被 `.gitignore` 忽略。确需入库时先逐行复核脱敏，再用 `git add -f` 显式提交。
- 不粘贴平台响应中的 token、secret、`tenant_access_token` 或带签名头的完整请求。

## 12. 结论填写规则

- 只勾选**真机执行且留有证据**的项；自检脚本通过、HTTP 200、构建成功都不算验收。
- 未覆盖项保留空白并写明原因（缺环境/缺权限/未实现），不追认提案状态，不宣称市场信号主链路或 Web 主线已完成。
- 需要修复的问题走独立 PR，不在验收记录里夹带功能改动。
