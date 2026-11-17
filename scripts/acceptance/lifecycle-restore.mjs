#!/usr/bin/env node
// 备份恢复演练（#40 S4b）：证明「恢复一份早于删除请求的备份」不会让已删数据复活。
//
// 只操作自建的一次性容器：名字带固定前缀、端口随机绑定 127.0.0.1；
// 不读取既有 DATABASE_URL / TEST_DATABASE_URL，不接受外部容器名，不执行 sudo。
//
//   node scripts/acceptance/lifecycle-restore.mjs
//
// 输出 JSON 摘要；任一步失败以非零退出。演练记录需另存 docs/acceptance/records/（该目录不入库）。
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const PREFIX = "adpulse-lifecycle-drill-";
const IMAGE = "postgres:16-alpine";
const name = `${PREFIX}${randomUUID().slice(0, 8)}`;
const port = 20000 + Math.floor(Math.random() * 20000);
const workdir = mkdtempSync(join(tmpdir(), "adpulse-drill-"));

const run = (cmd, args, options = {}) =>
	execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...options });
const docker = (...args) => run("docker", args);

const log = (step, detail = "") => console.error(`[drill] ${step}${detail ? ` · ${detail}` : ""}`);

function startContainer() {
	// 启停前核对：只允许操作本脚本创建的前缀容器。
	docker("run", "-d", "--rm", "--name", name,
		"-e", "POSTGRES_PASSWORD=drill",
		"-e", "POSTGRES_DB=drill_source",
		"-p", `127.0.0.1:${port}:5432`, IMAGE);
	const started = Date.now();
	for (;;) {
		try {
			docker("exec", name, "pg_isready", "-U", "postgres", "-d", "drill_source");
			return;
		} catch {
			if (Date.now() - started > 60_000) throw new Error("container did not become ready");
			execFileSync("sleep", ["1"]);
		}
	}
}

function stopContainer() {
	const listed = docker("ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}").trim();
	// 防御：名字不匹配就什么都不做，避免误删别人的容器。
	if (listed !== name) return;
	docker("stop", name);
}

async function main() {
	const { AuthenticationService, ComparisonService, EvidenceService, InvestigationAlertService,
		LifecycleCleanupService, LifecycleDeletionService, NotificationQueue, TaskService,
		serializeManifest, parseManifest } = await import("../../packages/core/dist/index.js");
	const { PostgresStorage } = await import("../../packages/storage/dist/index.js");

	const base = `postgres://postgres:drill@127.0.0.1:${port}`;
	/** 一次性建库，避免把演练数据写进同一个库。 */
	const createDb = (database) => docker("exec", name, "psql", "-U", "postgres", "-d", "drill_source", "-c", `CREATE DATABASE ${database}`);

	log("start container", `${name} :${port}`);
	startContainer();

	// 固定时钟：一年/7 天边界靠注入，不靠真实等待。
	let now = "2026-01-01T00:00:00.000Z";
	const clock = () => now;
	const seed = async () => {
		const storage = PostgresStorage.connect(`${base}/drill_source`);
		await storage.initialize();
		const identity = { platform: "feishu", applicationId: "drill", tenantId: "drill", idType: "open_id", externalId: randomUUID() };
		const session = await new AuthenticationService(storage).createWebSession(identity, "0".repeat(64), now);
		const tasks = new TaskService(storage, clock);
		const task = await tasks.create(session.userId, randomUUID(), {
			product: "演练任务（非真实业务）",
			strategy: { objective: "咨询", audience: [], channels: {}, sellingPoints: [] },
			observation: {},
			rules: { metricKey: "cost_per_consultation", metricDefinition: "单次咨询成本", currency: "CNY", unit: "分", statWindowDays: 1, alertThresholdMinor: 100, minimumSpendMinor: 0, minimumConsultations: 0, maxPushRounds: 3 },
		});
		const evidence = new EvidenceService(storage, clock);
		const imported = await evidence.import(session.userId, randomUUID(), {
			schemaVersion: 1, taskRef: { taskId: task.taskId, taskVersion: 1 },
			records: [{
				source: { platform: "synthetic-report", accountRef: "drill-account", reportRef: "drill-report-1" },
				scope: { planRef: "plan-1", campaignRefs: ["campaign-1"] },
				period: { startsAt: "2025-12-30T00:00:00+08:00", endsAt: "2025-12-31T00:00:00+08:00", timeZone: "Asia/Shanghai", completeness: "complete" },
				metricsContract: {
					spendMinor: { definition: "消耗", formula: "金额换算为分", sourceField: "spend" },
					consultations: { definition: "咨询数", formula: "咨询数", sourceField: "consultations" },
				},
				currency: { code: "CNY", minorUnit: "分", minorUnitsPerMajor: 100 },
				attribution: { model: "click", windowDays: 7 }, callbackStatus: "complete",
				rawValues: { spend: "2000", consultations: "10" }, values: { spendMinor: 2000, consultations: 10 },
			}],
		});
		const comparison = await new ComparisonService(storage, clock).evaluate(session.userId, randomUUID(), {
			current: { evidenceId: imported[0].evidenceId, version: 1 },
		});
		await new InvestigationAlertService(storage, clock).evaluateComparison(session.userId, comparison.id);
		await new NotificationQueue(storage, () => new Date(now)).queue(session.userId, {
			logicalKey: "effect:drill", kind: "effect_alert", taskId: task.taskId,
			title: "演练提醒标题（不应复活）", summary: "演练提醒摘要", relevance: "与演练任务相关",
			sources: [{ label: "演练来源", publishedAt: null }], revision: 1,
		}, { settingsVersion: 1, enabled: true });
		await storage.close();
		return { ownerId: session.userId, taskId: task.taskId, evidenceId: imported[0].evidenceId };
	};

	const seeded = await seed();
	log("seeded", `task=${seeded.taskId.slice(0, 8)}…`);

	// 1) 先打一份「删除之前」的备份 —— 这正是会复活已删数据的那种备份。
	log("dump before deletion");
	const dump = join(workdir, "before-delete.sql");
	run("bash", ["-c", `docker exec ${name} pg_dump -U postgres -d drill_source > ${JSON.stringify(dump)}`]);

	// 2) 删除 → 在线清理 → 导出外置清单。
	const deleted = await (async () => {
		const storage = PostgresStorage.connect(`${base}/drill_source`);
		const tasks = new TaskService(storage, clock);
		const result = await new LifecycleDeletionService(storage, clock).requestDelete(seeded.ownerId, seeded.taskId);
		now = result.manifest.deadlineAt;
		await new LifecycleCleanupService(storage, clock).runOnce();
		const manifest = serializeManifest(await new LifecycleDeletionService(storage, clock).list(seeded.ownerId));
		await storage.close();
		return { manifest, deadlineAt: result.manifest.deadlineAt };
	})();
	log("deleted + cleaned", `manifest lines=${deleted.manifest.trim().split("\n").length}`);

	// 3) 把「删除之前」的备份恢复到独立库：已删任务应当带着它的证据一起回来。
	await createDb("drill_restored");
	run("bash", ["-c", `docker exec -i ${name} psql -U postgres -d drill_restored -q < ${JSON.stringify(dump)}`]);
	const restored = PostgresStorage.connect(`${base}/drill_restored`);
	await restored.initialize();
	const resurrected = await restored.transaction(async (tx) => ({
		task: await tx.tasks.get(seeded.taskId),
		evidence: (await tx.evidenceHeads.all()).filter((row) => row.taskId === seeded.taskId),
		items: (await tx.notificationItems.all()).filter((row) => row.taskId === seeded.taskId),
	}));
	if (!resurrected.task) throw new Error("drill invalid: pre-deletion backup should contain the task");
	log("restored old backup", `task back, evidence=${resurrected.evidence.length}, items=${resurrected.items.length}`);

	// 4) 重放外置清单 + 到期规则，然后才允许服务启动。
	const replayed = await new LifecycleDeletionService(restored, () => deleted.deadlineAt).replay(parseManifest(deleted.manifest));
	const cleanup = await new LifecycleCleanupService(restored, () => deleted.deadlineAt).runOnce();
	log("replayed manifest + cleanup", `inserted=${replayed.inserted} manifests=${cleanup.manifests}`);

	// 5) 断言：任务与证据不可读，通知条目消失，审计留痕。
	const after = await restored.transaction(async (tx) => ({
		task: await tx.tasks.get(seeded.taskId),
		evidence: (await tx.evidenceHeads.all()).filter((row) => row.taskId === seeded.taskId),
		items: (await tx.notificationItems.all()).filter((row) => row.taskId === seeded.taskId),
		audits: await tx.auditEvents.all(),
		manifests: await tx.lifecycleDeletions.all(),
	}));
	const lifecycle = await new TaskService(restored, () => deleted.deadlineAt).lifecycle(seeded.ownerId, seeded.taskId);
	const assertions = {
		taskRootGone: after.task === null,
		evidenceGone: after.evidence.length === 0,
		notificationItemsGone: after.items.length === 0,
		manifestCleaned: after.manifests.every((row) => row.status === "cleaned"),
		auditRecorded: after.audits.some((row) => row.kind === "task_purged"),
		lifecycleLimited: lifecycle === null,
	};
	await restored.close();

	const failed = Object.entries(assertions).filter(([, ok]) => !ok).map(([key]) => key);
	const summary = {
		drill: "lifecycle-restore",
		container: name,
		port,
		encrypted: false,
		note: "演练库不加密、留存随容器销毁；不构成受控备份，不得据此宣称备份达标",
		restoredFromPreDeletionBackup: true,
		replayedManifests: replayed.inserted,
		cleanupManifests: cleanup.manifests,
		assertions,
	};
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
	if (failed.length > 0) throw new Error(`drill assertions failed: ${failed.join(", ")}`);
}

try {
	await main();
} catch (error) {
	process.stderr.write(`[drill] failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
} finally {
	try { stopContainer(); } catch { /* 容器可能未创建成功 */ }
	rmSync(workdir, { recursive: true, force: true });
}
