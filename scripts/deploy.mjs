#!/usr/bin/env node
// 部署脚本：一条命令完成「备份 → 打包 → 服务器构建 → 切符号链接 → 重启 → 健康检查 → 失败自动回滚」。
//
//   node scripts/deploy.mjs                      # 部署 origin/main
//   node scripts/deploy.mjs --ref <分支或提交>     # 部署指定 ref
//   node scripts/deploy.mjs --config <file>      # 指定本地配置（默认 .deploy.local.env）
//   node scripts/deploy.mjs --no-backup          # 跳过数据库备份
//   node scripts/deploy.mjs --dry-run            # 只做预检并打印计划
//   node scripts/deploy.mjs --reuse              # 该 sha 的发布目录已构建过：跳过解包与构建
//   node scripts/deploy.mjs --yes                # 不再询问
//
// **本脚本不含任何部署目标的默认值**（主机、路径、端口等）。部署目标属于环境信息：
// 写在本地 `.deploy.local.env`（已 gitignore）或用环境变量传入，格式见 `.deploy.example.env`。
//
// 设计约束（对应本项目踩过的坑）：
// - 所有远端命令通过 ssh 的 stdin 传入，本地不拼 shell 字符串：避免变量被本地 shell 提前展开、引号错位。
// - 发布目录名一律由 `git rev-parse` 得到，不接受手写 sha。
// - 切换前记录旧 release；任一步失败自动切回并重启，不留半死状态。
// - 旧 release 目录不删，回滚就是切符号链接。
//
// 退出码：0 成功；1 失败（已尝试回滚，输出说明回滚结果）；2 参数/配置/预检错误。

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag, fallback) => {
	const index = args.indexOf(flag);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

/** 必需配置项：缺任何一个都直接失败，绝不猜。 */
const REQUIRED_KEYS = [
	"DEPLOY_HOST",
	"DEPLOY_RELEASE_ROOT",
	"DEPLOY_LINK",
	"DEPLOY_ENV_FILE",
	"DEPLOY_LOG_DIR",
	"DEPLOY_PORT",
	"DEPLOY_NODE",
	"DEPLOY_BUN",
];
/** 可选配置项（有通用默认值，或可省略）。 */
const OPTIONAL_KEYS = ["DEPLOY_BACKUP_DIR", "DEPLOY_HEALTH_PATH"];

const KEY_HINTS = {
	DEPLOY_HOST: "ssh 主机别名或 user@host（需已配置免密登录）",
	DEPLOY_RELEASE_ROOT: "服务器上存放各版本目录的父目录，如 <home>/releases",
	DEPLOY_LINK: "指向当前版本的符号链接，如 <home>/current",
	DEPLOY_ENV_FILE: "服务进程读取的环境变量文件（含 DATABASE_URL / PUBLIC_ORIGIN 等）",
	DEPLOY_LOG_DIR: "API 日志目录，如 <home>/.local/state",
	DEPLOY_PORT: "API 监听端口（只监听本机回环）",
	DEPLOY_NODE: "服务器上 node 可执行文件路径（Node 24+）",
	DEPLOY_BUN: "服务器上 bun 可执行文件路径（用于安装依赖与构建）",
	DEPLOY_BACKUP_DIR: "（可选）数据库备份目录，默认与 DEPLOY_LOG_DIR 相同",
	DEPLOY_HEALTH_PATH: "（可选）健康检查路径，默认 /api/me（期望 401 表示鉴权链正常）",
};

/** 解析 KEY=VALUE 配置行；忽略空行与 # 注释。不展开变量、不执行任何东西。 */
function parseConfig(text) {
	const values = {};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim();
		let val = line.slice(eq + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
		if (/^[A-Z][A-Z0-9_]*$/.test(key)) values[key] = val;
	}
	return values;
}

function loadConfig() {
	const configPath = resolve(repoRoot, value("--config", ".deploy.local.env"));
	const fromFile = existsSync(configPath) ? parseConfig(readFileSync(configPath, "utf8")) : {};
	const merged = {};
	for (const key of [...REQUIRED_KEYS, ...OPTIONAL_KEYS]) {
		const val = process.env[key] ?? fromFile[key];
		if (typeof val === "string" && val.trim()) merged[key] = val.trim();
	}
	const missing = REQUIRED_KEYS.filter((key) => !merged[key]);
	if (missing.length > 0) {
		const lines = [
			"缺少部署配置（本脚本不提供任何实例默认值）：",
			...missing.map((key) => `  ${key.padEnd(22)} ${KEY_HINTS[key] ?? ""}`),
			"",
			`请复制 ${resolve(repoRoot, ".deploy.example.env")} 为 .deploy.local.env（已 gitignore）并填写，`,
			"或用同名环境变量传入，或用 --config <file> 指定配置文件。",
		];
		process.stderr.write(`${lines.join("\n")}\n`);
		process.exit(2);
	}
	return {
		...merged,
		DEPLOY_BACKUP_DIR: merged.DEPLOY_BACKUP_DIR ?? merged.DEPLOY_LOG_DIR,
		DEPLOY_HEALTH_PATH: merged.DEPLOY_HEALTH_PATH ?? "/api/me",
		configPath: existsSync(configPath) ? configPath : null,
	};
}

const config = loadConfig();
const ref = value("--ref", "origin/main");
const options = {
	dryRun: has("--dry-run"),
	reuse: has("--reuse"),
	backup: !has("--no-backup"),
	yes: has("--yes"),
};
const healthPath = config.DEPLOY_HEALTH_PATH.startsWith("/") ? config.DEPLOY_HEALTH_PATH : `/${config.DEPLOY_HEALTH_PATH}`;

const step = (message) => process.stdout.write(`\n▸ ${message}\n`);
const ok = (message) => process.stdout.write(`  ✓ ${message}\n`);
const info = (message) => process.stdout.write(`    ${message}\n`);

/** 跑本地命令；参数走数组，不经过本地 shell。 */
function run(command, commandArgs, { input } = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, commandArgs, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolvePromise(stdout);
			else reject(Object.assign(new Error(`${command} 退出码 ${code}`), { stdout, stderr, code }));
		});
		if (input !== undefined) child.stdin.end(input);
		else child.stdin.end();
	});
}

/** 在远端 bash 里执行脚本（走 stdin，本地不做任何变量展开）。 */
async function remote(script) {
	return await run(
		"ssh",
		["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", config.DEPLOY_HOST, "bash", "-s"],
		{ input: `set -euo pipefail\n${script}\n` },
	);
}

/** 远端命令失败时把远端输出带出来，不抛错。 */
async function remoteSoft(script) {
	try {
		return { ok: true, out: await remote(script) };
	} catch (error) {
		return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
	}
}

const safePath = (val, label) => {
	if (!/^(~\/|\/)[A-Za-z0-9._~/-]*$/.test(val)) throw new Error(`${label} 只能是绝对路径或 ~/ 开头：${val}`);
	return val;
};
const safeSha = (val) => {
	if (!/^[0-9a-f]{7,40}$/.test(val)) throw new Error(`不是合法提交 SHA：${val}`);
	return val;
};
const nodeDir = `${config.DEPLOY_NODE.replace(/\/[^/]+$/, "")}`;
const bunDir = `${config.DEPLOY_BUN.replace(/\/[^/]+$/, "")}`;

async function main() {
	step(`解析 ${ref}`);
	const sha = safeSha((await run("git", ["rev-parse", "--verify", `${ref}^{commit}`])).trim());
	const subject = (await run("git", ["log", "-1", "--format=%s", sha])).trim();
	ok(`${sha.slice(0, 12)} ${subject}`);
	if (config.configPath) info(`配置 ${config.configPath}`);

	for (const key of ["DEPLOY_RELEASE_ROOT", "DEPLOY_LINK", "DEPLOY_ENV_FILE", "DEPLOY_LOG_DIR", "DEPLOY_BACKUP_DIR"]) {
		safePath(config[key], key);
	}

	step("本地工作区检查");
	const dirty = (await run("git", ["status", "--porcelain", "--untracked-files=no"])).trim();
	if (dirty) {
		info("有未提交的已跟踪改动（不影响：按提交 SHA 打包，不会带上工作区）");
	} else {
		ok("工作区干净");
	}

	step("远端预检");
	const releaseDir = `${config.DEPLOY_RELEASE_ROOT}/${sha}`;
	const preflight = await remoteSoft(`
test -d ${config.DEPLOY_RELEASE_ROOT} || { echo "缺少发布目录 ${config.DEPLOY_RELEASE_ROOT}"; exit 1; }
test -f ${config.DEPLOY_ENV_FILE} || { echo "缺少环境变量文件 ${config.DEPLOY_ENV_FILE}"; exit 1; }
test -d ${config.DEPLOY_LOG_DIR} || { echo "缺少日志目录 ${config.DEPLOY_LOG_DIR}"; exit 1; }
test -x ${config.DEPLOY_NODE} || { echo "node 不可执行：${config.DEPLOY_NODE}"; exit 1; }
test -x ${config.DEPLOY_BUN} || { echo "bun 不可执行：${config.DEPLOY_BUN}"; exit 1; }
echo "host=$(hostname)"
echo "current=$(readlink ${config.DEPLOY_LINK} || echo none)"
echo "disk=$(df -h ${config.DEPLOY_RELEASE_ROOT} | tail -1 | awk '{print $4" free"}')"
test -d ${releaseDir} && echo "release=exists" || echo "release=absent"
echo "port_pid=$(ss -ltnp 2>/dev/null | grep ':${config.DEPLOY_PORT}' | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1)"
true
`);
	if (!preflight.ok) {
		process.stderr.write(`预检失败：\n${preflight.out}\n`);
		process.exit(2);
	}
	for (const line of preflight.out.trim().split("\n")) info(line);
	const previousRelease = /current=(\S+)/.exec(preflight.out)?.[1];
	const releaseExists = preflight.out.includes("release=exists");
	if (releaseExists && !options.reuse) {
		process.stderr.write(`\n该提交的发布目录已存在：${releaseDir}\n如确认复用（跳过解包与构建），加 --reuse；想重新构建请先手工删除该目录。\n`);
		process.exit(2);
	}
	if (previousRelease === releaseDir) {
		process.stderr.write("\n当前已部署该提交，无需重复部署。\n");
		process.exit(2);
	}

	step("部署计划");
	info(`目标主机   ${config.DEPLOY_HOST}`);
	info(`提交       ${sha.slice(0, 12)}`);
	info(`发布目录   ${releaseDir}`);
	info(`当前版本   ${previousRelease ?? "（无符号链接）"}`);
	info(`数据库备份 ${options.backup ? `是（${config.DEPLOY_BACKUP_DIR}）` : "跳过"}`);
	info(`构建/重启  ${options.reuse ? "跳过构建（--reuse），仍会重启" : "在服务器上构建后重启"}`);
	if (options.dryRun) {
		process.stdout.write("\n--dry-run：到此为止，未做任何改动。\n");
		return;
	}
	if (!options.yes) {
		process.stdout.write("\n继续部署？[y/N] ");
		const answer = await new Promise((resolvePromise) => {
			process.stdin.setEncoding("utf8");
			process.stdin.once("data", (data) => resolvePromise(String(data).trim().toLowerCase()));
		});
		if (answer !== "y" && answer !== "yes") {
			process.stdout.write("已取消。\n");
			return;
		}
	}

	let backupPath = null;
	if (options.backup) {
		step("数据库与环境变量备份");
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
		backupPath = `${config.DEPLOY_BACKUP_DIR}/adpulse-backup-${stamp}`;
		const result = await remoteSoft(`
mkdir -m 700 -p ${backupPath}
cp -p ${config.DEPLOY_ENV_FILE} ${backupPath}/api.env
chmod 600 ${backupPath}/api.env
cd ${config.DEPLOY_LINK}
PATH=${nodeDir}:${bunDir}:$PATH
${config.DEPLOY_NODE} --env-file=${config.DEPLOY_ENV_FILE} scripts/backup-manual.mjs --out ${backupPath} --no-evict | grep -E '"file"|"sizeBytes"|"gzipVerified"|"via"' || true
ls -1 ${backupPath}
`);
		if (!result.ok) {
			process.stderr.write(`备份失败，已中止（未做任何切换）：\n${result.out}\n`);
			process.exit(1);
		}
		for (const line of result.out.trim().split("\n")) info(line);
		ok(`备份目录 ${backupPath}`);
	}

	if (!options.reuse) {
		step(`打包并上传 ${sha.slice(0, 12)}`);
		await remote(`mkdir -p ${releaseDir}`);
		await new Promise((resolvePromise, reject) => {
			const archive = spawn("git", ["archive", "--format=tar", sha], { stdio: ["ignore", "pipe", "pipe"] });
			const untar = spawn(
				"ssh",
				["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", config.DEPLOY_HOST, `tar -x -C ${releaseDir}`],
				{ stdio: ["pipe", "inherit", "inherit"] },
			);
			archive.stdout.pipe(untar.stdin);
			archive.on("error", reject);
			untar.on("error", reject);
			untar.on("close", (code) => {
				if (code !== 0) reject(new Error(`远端解包失败（退出码 ${code}）`));
				else resolvePromise();
			});
		});
		ok("已上传（不含 .git / node_modules / dist / 未入库文件）");

		step("在服务器上构建");
		const build = await remoteSoft(`
cd ${releaseDir}
export PATH=${nodeDir}:${bunDir}:$PATH
echo "node $(node -v) / bun $(bun -v)"
bun install --frozen-lockfile
bun run build
bun run --cwd apps/console build
bun run sdk:check
test -f apps/api/dist/index.js
test -f apps/console/dist/index.html
grep -o 'assets/index-[A-Za-z0-9_-]*\\.js' apps/console/dist/index.html | head -1
`);
		if (!build.ok) {
			process.stderr.write(`\n构建失败，未切换版本（线上仍是 ${previousRelease ?? "原版本"}）：\n${build.out}\n`);
			process.exit(1);
		}
		for (const line of build.out.trim().split("\n").slice(-6)) info(line);
		ok("构建完成");
	}

	step("切换发布并重启 API");
	const logPath = `${config.DEPLOY_LOG_DIR}/adpulse-api-${sha.slice(0, 7)}.log`;
	const switched = await remoteSoft(`
OLD_PID=$(ss -ltnp 2>/dev/null | grep ':${config.DEPLOY_PORT}' | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1)
if [ -n "\${OLD_PID}" ]; then kill "\${OLD_PID}" 2>/dev/null || true; fi
for i in $(seq 1 60); do ss -ltn | grep -q ':${config.DEPLOY_PORT}' || break; sleep 0.5; done
ss -ltn | grep -q ':${config.DEPLOY_PORT}' && { echo "端口 ${config.DEPLOY_PORT} 仍被占用"; exit 1; } || true
ln -sfn ${releaseDir} ${config.DEPLOY_LINK}
cd ${config.DEPLOY_LINK}
nohup ${config.DEPLOY_NODE} --env-file=${config.DEPLOY_ENV_FILE} apps/api/dist/index.js >> ${logPath} 2>&1 &
for i in $(seq 1 60); do ss -ltn | grep -q ':${config.DEPLOY_PORT}' && break; sleep 0.5; done
sleep 2
ss -ltn | grep -q ':${config.DEPLOY_PORT}' || { echo "API 未监听 ${config.DEPLOY_PORT}"; tail -20 ${logPath}; exit 1; }
echo "pid=$(ss -ltnp | grep ':${config.DEPLOY_PORT}' | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1)"
tail -1 ${logPath}
`);
	if (!switched.ok) {
		process.stderr.write(`\n切换/重启失败：\n${switched.out}\n`);
		await rollback(previousRelease, backupPath);
		process.exit(1);
	}
	const newPid = /pid=(\d+)/.exec(switched.out)?.[1] ?? "?";
	ok(`pid ${newPid}，日志 ${logPath}`);

	step("健康检查");
	const health = await remoteSoft(`
ORIGIN=$(grep -E '^PUBLIC_ORIGIN=' ${config.DEPLOY_ENV_FILE} | cut -d= -f2-)
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$ORIGIN/")
echo "root=$code"
test "$code" = "200"
bundle=$(curl -s --max-time 10 "$ORIGIN/" | grep -o 'assets/index-[A-Za-z0-9_-]*\\.js' | head -1)
echo "bundle=$bundle"
api=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$ORIGIN${healthPath}")
echo "health=${healthPath} -> $api"
test "$api" = "401" || test "$api" = "200"
errors=$(grep -icE 'error|unhandled' ${logPath} || true)
echo "errors=$errors"
test "$errors" = "0"
df -h ${config.DEPLOY_RELEASE_ROOT} | tail -1 | awk '{print "disk="$4" free"}'
`);
	if (!health.ok) {
		process.stderr.write(`\n健康检查失败：\n${health.out}\n`);
		await rollback(previousRelease, backupPath);
		process.exit(1);
	}
	for (const line of health.out.trim().split("\n")) info(line);

	process.stdout.write(`
部署完成
  提交     ${sha}
  发布目录 ${releaseDir}
  进程     ${newPid}
  日志     ${logPath}
${backupPath ? `  备份     ${backupPath}\n` : ""}
回滚（切回上一版并重启）：
  node scripts/deploy.mjs --ref ${previousRelease?.split("/").pop() ?? "<上一版sha>"} --reuse --no-backup
`);
}

/** 失败时切回旧 release 并重启；本身失败也不掩盖原始错误。 */
async function rollback(previousRelease, backupPath) {
	if (!previousRelease || previousRelease === "none") {
		process.stderr.write("\n没有可回滚的上一版本（未记录旧符号链接）。\n");
		return;
	}
	step(`回滚到 ${previousRelease}`);
	const result = await remoteSoft(`
OLD_PID=$(ss -ltnp 2>/dev/null | grep ':${config.DEPLOY_PORT}' | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1)
if [ -n "\${OLD_PID}" ]; then kill "\${OLD_PID}" 2>/dev/null || true; fi
for i in $(seq 1 60); do ss -ltn | grep -q ':${config.DEPLOY_PORT}' || break; sleep 0.5; done
ln -sfn ${previousRelease} ${config.DEPLOY_LINK}
cd ${config.DEPLOY_LINK}
nohup ${config.DEPLOY_NODE} --env-file=${config.DEPLOY_ENV_FILE} apps/api/dist/index.js >> ${config.DEPLOY_LOG_DIR}/adpulse-api-rollback.log 2>&1 &
for i in $(seq 1 60); do ss -ltn | grep -q ':${config.DEPLOY_PORT}' && break; sleep 0.5; done
sleep 2
ss -ltn | grep -q ':${config.DEPLOY_PORT}' && echo "rollback_ok pid=$(ss -ltnp | grep ':${config.DEPLOY_PORT}' | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1)" || { echo "rollback_failed"; exit 1; }
`);
	if (result.ok) {
		ok("已切回上一版本并重启");
		if (backupPath) info(`如需恢复数据：见 ${backupPath}（手工决定，不自动回灌）`);
	} else {
		process.stderr.write(`回滚失败，需人工处理：\n${result.out}\n`);
		process.stderr.write(
			`手工命令：ln -sfn ${previousRelease} ${config.DEPLOY_LINK} && cd ${config.DEPLOY_LINK} && nohup ${config.DEPLOY_NODE} --env-file=${config.DEPLOY_ENV_FILE} apps/api/dist/index.js &\n`,
		);
	}
}

main().catch((error) => {
	process.stderr.write(`\n部署中断：${error.message}\n`);
	process.exit(1);
});
