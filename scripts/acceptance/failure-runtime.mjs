// 仅验收工具使用：替换出站端口，入站身份作用域及所有 API/领域权限仍用真实实现。
import { createFeishuAccount } from "../../packages/channels/dist/index.js";
import { compose } from "../../packages/runtime/dist/index.js";
import { OUTBOUND_FAILURE_MESSAGE } from "./fault-injection.mjs";

/**
 * @param {import("../../packages/core/dist/index.js").Storage} storage
 * @param {import("../../packages/channels/dist/feishu/inbound.js").FeishuInboundConfig & { appSecret: string }} config
 */
export function createFailureRuntime(storage, config) {
	const account = createFeishuAccount(config);
	return compose(storage, [{
		...account,
		outbound: { async send() { throw new Error(OUTBOUND_FAILURE_MESSAGE); } },
	}]);
}
