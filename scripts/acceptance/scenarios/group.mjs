// #34 个人身份模型禁止群收件人；保留 group 命令用于验证这条拒绝边界。
import { EVIDENCE } from "../checks.mjs";
import { ConsoleApiError } from "../console-api.mjs";
import { defineScenario, verdict } from "../scenario.mjs";
import { acceptanceSessionInput } from "./fixture.mjs";

export const groupScenario = defineScenario({
	id: "group",
	title: "个人会话拒绝群收件人",
	evidence: EVIDENCE.localReal,
	steps: [{
		id: "group.reject",
		read: async (ctx) => {
			try {
				await ctx.client.createSession(acceptanceSessionInput(ctx, { kind: "group" }));
				return { status: 201, error: "" };
			} catch (error) {
				if (!(error instanceof ConsoleApiError)) throw error;
				return { status: error.status, error: error.body?.error };
			}
		},
		until: () => true,
		assertions: [{
			id: "group.recipient-rejected",
			title: "群收件人在建会话前被拒绝",
			check: (state) => verdict(
				state.status === 400 && state.error === "personal sessions require a user recipient",
				`HTTP ${state.status}，个人会话拒绝群收件人=${state.error === "personal sessions require a user recipient"}`,
				"个人卡片不得发往群；不要通过放宽 API 权限使旧群聊场景通过",
			),
		}],
	}],
});
