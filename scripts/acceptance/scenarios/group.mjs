// group 场景：群聊卡片 → 点击 → 持久化 → 处理 → 确认（runbook 第 5 节）。
// 群成员不自动获得决策权：allowedActorIds 仍只含 --open-id 指定的成员。

import { createRoundTripScenario } from "./round-trip.mjs";

export const groupScenario = createRoundTripScenario({
	id: "group",
	channel: "group",
});
