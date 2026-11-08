// 场景注册表：新增场景在这里登记，入口按 --scenario <id> 查找。
// requires 描述场景对参数的硬依赖，缺参数时入口直接拒绝而不是跑空。

import { dmScenario } from "./dm.mjs";
import { roundsScenario } from "./rounds.mjs";

export const SCENARIOS = new Map(
	[dmScenario, roundsScenario].map((scenario) => [scenario.id, scenario]),
);

const REQUIREMENTS = {
	dm: ["openId"],
	rounds: ["openId"],
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
