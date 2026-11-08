// 一次性容器生命周期：只操作本脚本创建、带固定前缀与自有 label 的容器。
// 约束（对应 #49）：不接受任意容器名/端口、不 stop/rm 他人容器、不 sudo、
// 默认退出即清理；任何核对失败都中止而不是猜测。

import { spawnSync } from "node:child_process";

export const MANAGED_PREFIX = "adpulse-acceptance-";
export const MANAGED_DB_NAME = `${MANAGED_PREFIX}db`;
/** 固定端口，避免参数误配到真实库（生产用 5432）。 */
export const MANAGED_DB_PORT = 5433;
export const MANAGED_DB_IMAGE = "postgres:16-alpine";
export const MANAGED_DB_USER = "postgres";
export const MANAGED_DB_PASSWORD = "acceptance-local-password";
export const MANAGED_DB_NAME_FOR_PG = "adpulse_acceptance";
const OWNER_LABEL = "adpulse.acceptance";
const OWNER_VALUE = "1";

export class DockerError extends Error {}

function defaultRun(args) {
	const result = spawnSync("docker", args, { encoding: "utf8" });
	if (result.error) throw new DockerError(`无法执行 docker：${result.error.message}`);
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

/**
 * @param {{ run?: (args: string[]) => { status: number, stdout: string, stderr: string },
 *   log?: (line: string) => void, sleep?: (ms: number) => Promise<void> }} [options]
 */
export function createManagedDocker(options = {}) {
	const run = options.run ?? defaultRun;
	const log = options.log ?? console.log;
	const sleep =
		options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const created = [];

	function docker(args, { allowFailure = false } = {}) {
		const result = run(args);
		if (result.status !== 0 && !allowFailure)
			throw new DockerError(
				`docker ${args.slice(0, 2).join(" ")} 失败：${result.stderr.trim().slice(0, 200)}`,
			);
		return result;
	}

	function exists(name) {
		return docker(["inspect", name], { allowFailure: true }).status === 0;
	}

	function labelsOf(name) {
		const result = docker([
			"inspect",
			"--format",
			'{{index .Config.Labels "adpulse.acceptance"}}',
			name,
		]);
		return result.stdout.trim();
	}

	/** 只信任同时满足前缀与 label 的容器，其余一律拒绝操作。 */
	function assertOwned(name) {
		if (!name.startsWith(MANAGED_PREFIX))
			throw new DockerError(`拒绝操作非 ${MANAGED_PREFIX} 前缀的容器：${name}`);
		if (!exists(name)) throw new DockerError(`容器不存在：${name}`);
		if (labelsOf(name) !== OWNER_VALUE)
			throw new DockerError(`容器缺少本脚本 label，拒绝操作：${name}`);
	}

	function running(name) {
		const result = docker([
			"inspect",
			"--format",
			"{{.State.Running}}",
			name,
		]);
		return result.stdout.trim() === "true";
	}

	return {
		/** 建库容器（幂等）：已存在则复用，并先核对归属。 */
		ensureDb() {
			if (exists(MANAGED_DB_NAME)) {
				assertOwned(MANAGED_DB_NAME);
				if (!running(MANAGED_DB_NAME)) this.startDb();
				return MANAGED_DB_NAME;
			}
			docker([
				"run",
				"--rm",
				"-d",
				"--name",
				MANAGED_DB_NAME,
				"--label",
				`${OWNER_LABEL}=${OWNER_VALUE}`,
				"-e",
				`POSTGRES_PASSWORD=${MANAGED_DB_PASSWORD}`,
				"-e",
				`POSTGRES_DB=${MANAGED_DB_NAME_FOR_PG}`,
				"-p",
				`127.0.0.1:${MANAGED_DB_PORT}:5432`,
				MANAGED_DB_IMAGE,
			]);
			created.push(MANAGED_DB_NAME);
			log(`已创建一次性数据库容器 ${MANAGED_DB_NAME}（127.0.0.1:${MANAGED_DB_PORT}）`);
			return MANAGED_DB_NAME;
		},
		startDb() {
			assertOwned(MANAGED_DB_NAME);
			docker(["start", MANAGED_DB_NAME]);
		},
		stopDb() {
			assertOwned(MANAGED_DB_NAME);
			docker(["stop", MANAGED_DB_NAME]);
		},
		removeDb() {
			if (!exists(MANAGED_DB_NAME)) return;
			assertOwned(MANAGED_DB_NAME);
			docker(["rm", "-f", MANAGED_DB_NAME]);
		},
		/** 等数据库能接受连接；超时抛错，不静默继续。 */
		async waitReady(timeoutMs = 30_000) {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const ready = docker(
					[
						"exec",
						MANAGED_DB_NAME,
						"pg_isready",
						"-U",
						MANAGED_DB_USER,
						"-d",
						MANAGED_DB_NAME_FOR_PG,
					],
					{ allowFailure: true },
				);
				if (ready.status === 0) return;
				if (Date.now() > deadline)
					throw new DockerError(`等待 ${MANAGED_DB_NAME} 就绪超时`);
				await sleep(500);
			}
		},
		/** 默认清理：只删本次运行创建的容器；--keep 由调用方决定不调用。 */
		cleanup() {
			for (const name of created.reverse()) {
				if (!exists(name)) continue;
				docker(["rm", "-f", name], { allowFailure: true });
				log(`已清理一次性容器 ${name}`);
			}
			created.length = 0;
		},
		createdNames() {
			return [...created];
		},
	};
}

/** 判断 DATABASE_URL 是否指向受管容器的固定端口；不是则不允许停库。 */
export function pointsAtManagedDb(databaseUrl) {
	try {
		const url = new URL(databaseUrl);
		return (
			url.hostname === "127.0.0.1" &&
			url.port === String(MANAGED_DB_PORT) &&
			url.pathname.replace(/^\//, "") === MANAGED_DB_NAME_FOR_PG
		);
	} catch {
		return false;
	}
}
