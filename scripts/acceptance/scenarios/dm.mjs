// dm 场景：单聊卡片 → 点击 → 持久化 → 处理 → 确认（runbook 第 4 节）。
// 流程与判据见 round-trip.mjs，这里只绑定单聊收件人。

import { createRoundTripScenario } from "./round-trip.mjs";

export const dmScenario = createRoundTripScenario({ id: "dm", channel: "user" });
