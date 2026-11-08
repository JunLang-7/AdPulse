// 验收脚本入口：解析参数、执行检查、输出结果与记录。
// 当前只有飞书只读自检；场景驱动器在后续 PR 注册到 SCENARIOS。

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createChecks, printChecks } from "./checks.mjs";
import { recordFileName, renderRecord, writeRecord } from "./record.mjs";
import { runFeishuSelfCheck } from "./selfcheck-feishu.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RECORDS = resolve(ROOT, "docs/acceptance/records");

export const USAGE = `用法：bun run feishu:acceptance [-- 选项]

  --api <url>         本机 API 地址，默认 http://127.0.0.1:3000
  --public-url <url>  公网回调地址，如 https://example.com/webhooks/feishu-internal
  --chat-id <oc_...>  可选：校验群聊收件人
  --open-id <ou_...>  可选：校验用户收件人
  --write             生成验收记录 docs/acceptance/records/<日期>.md
  --force             覆盖同名验收记录
  --help              显示本帮助

只读探测：不会发送业务消息，不写业务数据。`;

export function parseArgs(argv) {
	const options = {
		api: "http://127.0.0.1:3000",
		publicUrl: undefined,
		chatId: undefined,
		openId: undefined,
		write: false,
		force: false,
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const [flag, inline] = argv[index].split(/=(.*)/s);
		const value = () => {
			if (inline !== undefined) return inline;
			const next = argv[index + 1];
			if (next === undefined) throw new UsageError(`缺少 ${flag} 的值`);
			index += 1;
			return next;
		};
		if (flag === "--api") options.api = value().replace(/\/+$/, "");
		else if (flag === "--public-url")
			options.publicUrl = value().replace(/\/+$/, "");
		else if (flag === "--chat-id") options.chatId = value();
		else if (flag === "--open-id") options.openId = value();
		else if (flag === "--write") options.write = true;
		else if (flag === "--force") {
			options.write = true;
			options.force = true;
		} else if (flag === "--help" || flag === "-h") options.help = true;
		else throw new UsageError(`未知参数：${flag}`);
	}
	return options;
}

export class UsageError extends Error {}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @param {{ log?: (line: string) => void, error?: (line: string) => void, now?: () => Date }} [io]
 * @returns {Promise<number>} 进程退出码
 */
export async function main(argv, env, io = {}) {
	const log = io.log ?? console.log;
	const error = io.error ?? console.error;
	const now = io.now ?? (() => new Date());

	let options;
	try {
		options = parseArgs(argv);
	} catch (cause) {
		if (cause instanceof UsageError) {
			error(cause.message);
			return 2;
		}
		throw cause;
	}
	if (options.help) {
		log(USAGE);
		return 0;
	}

	const checks = createChecks();
	const selfCheck = await runFeishuSelfCheck({ env, options, checks });
	printChecks(checks.results, log);

	if (options.write) {
		const content = renderRecord({
			title: "飞书真机联调记录（自动生成骨架）",
			generator: "`scripts/feishu-acceptance.mjs`",
			meta: selfCheck.meta,
			results: checks.results,
			manualItems: selfCheck.manualItems,
			footerLines: [
				"仅在真机执行且留证的项可勾选；自动自检通过不等于完成 #12 验收。",
			],
		});
		writeRecord(RECORDS, recordFileName(now()), content, {
			force: options.force,
			log,
		});
	}

	return checks.exitCode();
}
