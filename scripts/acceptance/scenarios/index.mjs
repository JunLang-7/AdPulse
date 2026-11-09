// 场景注册表：新增场景在这里登记，入口按 --scenario <id> 查找。
// requires 描述场景对参数的硬依赖，缺参数时入口直接拒绝而不是跑空。

import { dbDownScenario } from "./db-down.mjs";
import { dmScenario } from "./dm.mjs";
import { failureScenario } from "./failure.mjs";
import { groupScenario } from "./group.mjs";
import { rejectScenario } from "./reject.mjs";
import { roundsScenario } from "./rounds.mjs";

export const SCENARIOS = new Map(
	[
		dmScenario,
		groupScenario,
		roundsScenario,
		rejectScenario,
		failureScenario,
		dbDownScenario,
	].map((scenario) => [scenario.id, scenario]),
);

const REQUIREMENTS = {
	dm: ["openId"],
	group: ["chatId", "openId"],
	rounds: ["openId"],
	// 需要第二个真实用户：由未授权成员点击，才能验证拒绝。
	reject: ["openId", "otherOpenId"],
	// 使用本人身份及本地出站故障夹具，无需人工点击。
	failure: ["openId"],
	// 停库注入需要显式授权，且只对自建一次性数据库生效。
	"db-down": ["openId"],
};

export function scenarioRequires(id) {
	return REQUIREMENTS[id] ?? [];
}

export function listScenarios() {
	return [...SCENARIOS.values()].map((scenario) => ({
		id: scenario.id,
		title: scenario.title,
		evidence: scenario.evidence,
		steps: scenario.steps.length,
		requires: scenarioRequires(scenario.id),
	}));
}

export function findScenario(id) {
	return SCENARIOS.get(id);
}
