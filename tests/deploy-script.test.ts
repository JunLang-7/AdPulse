import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

/**
 * 部署脚本的硬约束：**仓库不提供任何部署目标默认值**。
 * 未配置时必须立刻失败并说明缺什么，绝不猜主机/路径（曾因手写路径把符号链接指错导致服务中断）。
 */
test("部署脚本：没有配置时不带任何默认值，直接退出并列出缺项", () => {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("DEPLOY_")) delete env[key];
	let failure: { status?: number; stdout?: string; stderr?: string } | null = null;
	try {
		execFileSync(process.execPath, [resolve("scripts/deploy.mjs"), "--dry-run", "--config", "/nonexistent.env"], {
			env,
			stdio: "pipe",
			encoding: "utf8",
		});
	} catch (error) {
		failure = error as { status?: number; stdout?: string; stderr?: string };
	}
	assert.ok(failure, "未配置时必须失败，而不是用某个默认主机继续");
	assert.equal(failure.status, 2, "配置缺失应返回退出码 2（参数/预检错误）");
	const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
	assert.match(output, /缺少部署配置/);
	for (const key of ["DEPLOY_HOST", "DEPLOY_ENV_FILE", "DEPLOY_PORT", "DEPLOY_NODE", "DEPLOY_BUN"]) {
		assert.ok(output.includes(key), `缺口清单应包含 ${key}`);
	}
	assert.match(output, /\.deploy\.example\.env/, "应指路到示例配置");
});
