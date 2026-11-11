// 仓库定位与版本信息：验收记录要把证据对到具体 commit。

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function gitCommit(root = ROOT) {
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd: root,
			encoding: "utf8",
		}).trim();
	} catch {
		return "(unknown)";
	}
}
