import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 防止又一次「加了数据库迁移却忘了改测试断言」。
 *
 * 直接读 postgres.ts 里登记的迁移版本，与集成测试里的期望集合比对。
 * 新增迁移但没同步 postgres.test.ts / postgres-model-connections.test.ts 时，
 * 这个测试会先失败，并指出要改哪两处。
 */

const storageSource = readFileSync(
	new URL("../packages/storage/src/postgres.ts", import.meta.url),
	"utf8",
);
const postgresTest = readFileSync(
	new URL("./postgres.test.ts", import.meta.url),
	"utf8",
);
const modelConnectionsTest = readFileSync(
	new URL("./postgres-model-connections.test.ts", import.meta.url),
	"utf8",
);

function registeredMigrations(): number[] {
	const versions = new Set<number>();
	for (const match of storageSource.matchAll(
		/INSERT INTO adpulse_schema_migrations\(version\) VALUES \((\d+)\)/g,
	)) {
		versions.add(Number(match[1]));
	}
	return [...versions].sort((a, b) => a - b);
}

function expectedFromArray(source: string): number[] {
	const match = source.match(
		/\[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,\s*[\d, ]+\]/,
	);
	assert.ok(match, "找不到 postgres.test.ts 里的迁移版本数组");
	return [...match[0].matchAll(/\d+/g)].map((item) => Number(item[0]));
}

test("集成测试的迁移版本断言覆盖 postgres.ts 里登记的所有迁移", () => {
	const registered = registeredMigrations();
	assert.ok(registered.length > 0, "没有解析到任何迁移版本");
	// 版本号必须从 1 连续登记，不能跳号。
	assert.deepEqual(
		registered,
		Array.from({ length: registered.at(-1)! }, (_, index) => index + 1),
		"迁移版本必须连续",
	);

	assert.deepEqual(
		expectedFromArray(postgresTest),
		registered,
		"postgres.test.ts 的版本数组落后了，请补齐到最新迁移",
	);

	// model-connections 的 v12 重建测试：DELETE 范围与断言都要覆盖到最新版本。
	const deleteMatch = modelConnectionsTest.match(
		/DELETE FROM adpulse_schema_migrations WHERE version IN \(([^)]+)\)/,
	);
	assert.ok(deleteMatch, "找不到 v12 重建的 DELETE 语句");
	const deleted = [...deleteMatch[1].matchAll(/\d+/g)].map((item) => Number(item[0]));
	for (const version of registered.filter((item) => item >= 13)) {
		assert.ok(
			deleted.includes(version),
			`v12 重建没有清掉迁移 ${version}，重放迁移链时状态会失真`,
		);
	}

	const afterMatch = modelConnectionsTest.match(
		/version >= 11 ORDER BY version[\s\S]{0,200}?\[11,[\d, ]+\]/,
	);
	assert.ok(afterMatch, "找不到重建后的迁移版本断言");
	const after = [...afterMatch[0].matchAll(/\d+/g)].map((item) => Number(item[0]));
	for (const version of registered.filter((item) => item >= 11)) {
		assert.ok(after.includes(version), `重建后的断言漏掉了迁移 ${version}`);
	}
});
