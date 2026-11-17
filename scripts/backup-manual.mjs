#!/usr/bin/env node
// 手工备份（#40 试点阶段方案 B）：一条命令打一份可拷走的数据库备份。
//
// 定位：**手工、非受控、不宣称达标**。没有桶、没有凭据、没有定时任务；
// 目的是让"机器坏了/误清库 = 数据全丢"变成"有一份昨天的 dump 可以手工恢复"。
//
//   node --env-file=<api.env> scripts/backup-manual.mjs --out ~/adpulse-manual-backups
//
// 注意：`--env-file` 是 **node 的参数**，必须写在脚本路径之前。
//
// 只读数据库，不写任何业务表；不打印连接串或密码。

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const outDir = resolve(flag("out", join(homedir(), "adpulse-manual-backups")));
const keep = Number(flag("keep", "4"));
if (!Number.isInteger(keep) || keep < 1) {
	console.error("--keep must be a positive integer");
	process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error("DATABASE_URL required; pass --env-file=<path> pointing at the service env");
	process.exit(2);
}

/** 拆出连接参数，避免把整串 URL（含密码）放进命令行参数或日志。 */
function parse(dsn) {
	const url = new URL(dsn);
	return {
		host: url.hostname,
		port: url.port || "5432",
		user: decodeURIComponent(url.username),
		database: decodeURIComponent(url.pathname.replace(/^\//, "")),
		password: decodeURIComponent(url.password),
		sslmode: url.searchParams.get("sslmode") ?? "",
	};
}

const conn = parse(databaseUrl);
if (!conn.database) {
	console.error("DATABASE_URL must include a database name");
	process.exit(2);
}

/** 优先本机 pg_dump；没有就用一次性 postgres 容器代打（试点机就没有 pg_dump）。 */
function dumpCommand() {
	const configured = process.env.BACKUP_PG_DUMP;
	if (configured) return { kind: "host", bin: configured };
	if (spawnSync("pg_dump", ["--version"], { stdio: "ignore" }).status === 0)
		return { kind: "host", bin: "pg_dump" };
	if (spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" }).status === 0)
		return { kind: "docker", bin: "docker" };
	return null;
}

const tool = dumpCommand();
if (!tool) {
	console.error("no pg_dump found: install postgresql-client, set BACKUP_PG_DUMP, or provide docker");
	process.exit(2);
}

const pgArgs = [
	"-h", conn.host,
	"-p", conn.port,
	"-U", conn.user,
	"-d", conn.database,
	"--no-owner",
	"--no-acl",
];
const env = { ...process.env, PGPASSWORD: conn.password, PGSSLMODE: conn.sslmode || process.env.PGSSLMODE || "prefer" };

const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/-(\d{3})Z$/, "Z");
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const target = join(outDir, `adpulse-${stamp}.dump.gz`);

function dump() {
	const child = tool.kind === "docker"
		? execFileSync("docker", [
			"run", "--rm", "--network", "host", "-e", "PGPASSWORD", "-e", "PGSSLMODE",
			"postgres:16-alpine", "pg_dump", ...pgArgs,
		], { env, maxBuffer: 1024 * 1024 * 512 })
		: execFileSync(tool.bin, pgArgs, { env, maxBuffer: 1024 * 1024 * 512 });
	return child;
}

const started = Date.now();
const raw = dump();
if (!raw || raw.length === 0) {
	console.error("pg_dump produced no output; refusing to write an empty backup");
	process.exit(1);
}
await pipeline(Readable.from(raw), createGzip(), createWriteStream(target, { mode: 0o600 }));
chmodSync(target, 0o600);

const size = statSync(target).size;
const digest = createHash("sha256").update(execFileSync("bash", ["-c", `gunzip -c ${JSON.stringify(target)}`])).digest("hex");
const verified = spawnSync("bash", ["-c", `gunzip -t ${JSON.stringify(target)}`]).status === 0;

const pruned = [];
if (!has("no-prune")) {
	const files = readdirSync(outDir)
		.filter((name) => /^adpulse-\d{4}-\d{2}-\d{2}T.*\.dump\.gz$/.test(name))
		.sort()
		.reverse();
	for (const name of files.slice(keep)) {
		rmSync(join(outDir, name));
		pruned.push(name);
	}
}

process.stdout.write(`${JSON.stringify({
	file: target,
	sizeBytes: size,
	sha256: digest,
	gzipVerified: verified,
	kept: Math.min(keep, readdirSync(outDir).filter((name) => name.endsWith(".dump.gz")).length),
	pruned,
	via: tool.kind,
	durationMs: Date.now() - started,
	note: "手工备份：不含删除清单、未加密、不构成受控备份；恢复需另行重放清单",
}, null, 2)}\n`);

if (!verified) {
	console.error("gzip verification failed; treat this backup as invalid");
	process.exitCode = 1;
}
