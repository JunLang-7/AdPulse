import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "adpulse-sdk-"));
try {
	const output = join(dir, "api.d.ts");
	execFileSync(
		process.execPath,
		[
			resolve("node_modules/openapi-typescript/bin/cli.js"),
			"contracts/openapi.json",
			"-o",
			output,
		],
		{ stdio: "inherit" },
	);
	if (
		readFileSync(output, "utf8") !==
		readFileSync("apps/console/src/generated/api.d.ts", "utf8")
	) {
		throw new Error("SDK drift: run bun run sdk:generate");
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}
