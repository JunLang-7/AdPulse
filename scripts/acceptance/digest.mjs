// 日汇总推送的受控验收工具（#37 PR5）：只往「验收实例」写带标记的合成条目，并读取本人记录。
// 不发送卡片、不改订阅、不重试、不创建 Session；真正的发送由实例自己的 worker 在调度时刻完成。
// 用法见 docs/acceptance/feishu-e2e.md 第 16 节。

import { NotificationQueue, NotificationRecordService } from "../../packages/core/dist/index.js";
import { PostgresStorage } from "../../packages/storage/dist/index.js";
import { mask } from "./redact.mjs";

/** 每条合成条目都必须带这个标记：记录、卡片与日志里都能一眼看出不是真实业务内容。 */
export const TEST_MARKER = "【验收测试】";

export const USAGE = `用法：node --env-file=.env scripts/acceptance/digest.mjs <命令> [选项]

命令：
  enqueue   写入一条带「${TEST_MARKER}」标记的合成汇总条目（需要 --confirm-synthetic）
  status    读取该用户最近的批次、条目与投递回执

公共选项：
  --database-url <url>  验收实例的 PostgreSQL；缺省读 DATABASE_URL（禁止指向生产库）
  --owner-id <id>       目标内部用户 id
  --open-id <ou_...>    用已验证的飞书 open_id 反查内部用户（与 --owner-id 二选一）
  --json                输出机器可读 JSON（默认人类可读摘要）

enqueue 选项：
  --revision <n>        实质更新序号，默认 1；同一 revision 重复执行返回 duplicate
  --title <text>        标题，默认「${TEST_MARKER}成本波动示例」
  --confirm-synthetic   必填：确认写入的是验收用合成数据

本工具不发送消息、不改订阅或授权。需要真机收到消息时，先按 runbook 第 16 节确认
实例处于允许发送状态，再由实例自身的 worker 在调度时刻投递。`;

export class UsageError extends Error {}

const DEFAULT_TITLE = `${TEST_MARKER}成本波动示例`;

/** 合成条目的固定逻辑键：与真实事件不可能撞车，重复执行只更新同一行。 */
export const SYNTHETIC_LOGICAL_KEY = "effect|account|acceptance:digest|synthetic-a";

export function parseArgs(argv) {
	const options = {
		command: undefined,
		databaseUrl: undefined,
		ownerId: undefined,
		openId: undefined,
		json: false,
		revision: 1,
		title: DEFAULT_TITLE,
		confirmSynthetic: false,
		help: false,
	};
	const positionals = [];
	for (let index = 0; index < argv.length; index += 1) {
		const [flag, inline] = argv[index].split(/=(.*)/s);
		const value = () => {
			if (inline !== undefined) return inline;
			const next = argv[index + 1];
			if (next === undefined) throw new UsageError(`缺少 ${flag} 的值`);
			index += 1;
			return next;
		};
		if (flag === "--database-url") options.databaseUrl = value();
		else if (flag === "--owner-id") options.ownerId = value();
		else if (flag === "--open-id") options.openId = value();
		else if (flag === "--json") options.json = true;
		else if (flag === "--confirm-synthetic") options.confirmSynthetic = true;
		else if (flag === "--revision") {
			const revision = Number(value());
			if (!Number.isInteger(revision) || revision < 1)
				throw new UsageError("--revision 必须是 >= 1 的整数");
			options.revision = revision;
		} else if (flag === "--title") options.title = value();
		else if (flag === "--help") options.help = true;
		else if (flag.startsWith("--")) throw new UsageError(`未知选项：${flag}`);
		else positionals.push(flag);
	}
	if (positionals.length > 1) throw new UsageError("只接受一个命令");
	options.command = positionals[0];
	if (!options.help && options.command === undefined)
		throw new UsageError("缺少命令（enqueue 或 status）");
	if (options.ownerId && options.openId)
		throw new UsageError("--owner-id 与 --open-id 只能给一个");
	if (options.command === "enqueue" && !options.confirmSynthetic && !options.help)
		throw new UsageError("写入合成数据需要 --confirm-synthetic");
	return options;
}

/** 合成条目的输入：标记、固定逻辑键，按 revision 幂等。 */
export function syntheticItemInput(options = {}) {
	const title = (options.title ?? DEFAULT_TITLE).trim();
	if (!title) throw new UsageError("--title 不能为空");
	return {
		logicalKey: SYNTHETIC_LOGICAL_KEY,
		kind: "effect_alert",
		title: title.startsWith(TEST_MARKER) ? title : `${TEST_MARKER}${title}`,
		summary: `${TEST_MARKER}这是一条用于验证日汇总投递的合成内容，不代表真实经营数据。`,
		relevance: `${TEST_MARKER}与你关注的对象「验收测试」相关（合成关注对象）。`,
		sources: [
			{
				label: `${TEST_MARKER}合成来源`,
				observedAt: new Date().toISOString(),
				publishedAt: null,
			},
		],
		revision: options.revision ?? 1,
	};
}

/** 按 --open-id 反查内部用户；找不到或多于一个都明确失败，不猜。 */
export async function resolveOwnerId(storage, options) {
	if (options.ownerId) {
		const user = await storage.transaction((tx) => tx.users.get(options.ownerId));
		if (!user || user.status !== "active")
			throw new UsageError("--owner-id 对应的用户不存在或已停用");
		return user.id;
	}
	if (!options.openId) throw new UsageError("需要 --owner-id 或 --open-id");
	const bindings = await storage.transaction(async (tx) =>
		(await tx.identityBindings.all()).filter(
			(binding) =>
				binding.externalId === options.openId && binding.status === "active",
		),
	);
	const userIds = [...new Set(bindings.map((binding) => binding.userId))];
	if (userIds.length === 0)
		throw new UsageError("该 open_id 没有有效的身份绑定，无法定位用户");
	if (userIds.length > 1)
		throw new UsageError("该 open_id 对应多个用户，请改用 --owner-id");
	return userIds[0];
}

/** 写入合成条目：关闭推送时直接拒绝，不为已关闭用户排队。 */
export async function enqueueSynthetic(storage, ownerId, options = {}) {
	const settings = await storage.transaction(
		async (tx) => (await tx.subscriptionSettings.all()).find((row) => row.id === ownerId),
	);
	if (!settings?.proactiveEnabled)
		throw new UsageError("该用户未开启主动提醒，先按 runbook 开启后再写入合成条目");
	const queue = new NotificationQueue(storage);
	const input = syntheticItemInput(options);
	const result = await queue.queue(ownerId, input, {
		settingsVersion: settings.version,
		enabled: true,
	});
	return { result, input, settingsVersion: settings.version };
}

/** 读取本人最近记录；不按 id 直取，跨用户不可见。 */
export async function readRecords(storage, ownerId, options = {}) {
	return new NotificationRecordService(storage).list(ownerId, {
		...(options.limit === undefined ? {} : { limit: options.limit }),
	});
}

const statusIcon = (status) => {
	if (status === "sent") return "✅";
	if (status === "failed" || status === "suppressed") return "⛔";
	return "⏳";
};

/** 批次/条目 id 形如 `digest:<ownerId>:<date>`：输出前把 owner 段脱敏。 */
export function redactId(value, ownerId) {
	if (!value || !ownerId || !value.includes(ownerId)) return value;
	return value.replace(ownerId, mask(ownerId, 6, 2));
}

/** 人类可读摘要：只输出脱敏后的外键与标记，不打印 open_id、cookie 或原文。 */
export function formatRecords(page, now = new Date()) {
	if (page.records.length === 0) return "（没有通知记录）";
	const lines = [];
	for (const record of page.records) {
		const lagMs = record.sentAt
			? Date.parse(record.sentAt) - Date.parse(record.scheduledAt)
			: undefined;
		lines.push(
			`${statusIcon(record.status)} ${record.localDate} ${record.status}` +
				(record.catchUp ? "（当日补发）" : "") +
				(record.statusReason ? ` · ${record.statusReason}` : ""),
		);
		lines.push(
			`   计划 ${record.scheduledAt}${record.sentAt ? ` · 发送 ${record.sentAt}` : ""}` +
				(typeof lagMs === "number" ? ` · 计划到发送 ${Math.round(lagMs / 1000)}s` : ""),
		);
		lines.push(
			`   条目 ${record.items.length} 条（来源 ${record.itemsSource}）` +
				(record.delivery
					? ` · 投递 ${record.delivery.status}`
					: " · 未投递"),
		);
		for (const item of record.items)
			lines.push(`   - ${item.title}${item.status ? ` [${item.status}]` : ""}`);
	}
	lines.push(
		`（生成于 ${now.toISOString()}；sent 只代表平台接收，不代表用户已读）`,
	);
	return lines.join("\n");
}

async function main(argv) {
	const options = parseArgs(argv);
	if (options.help) {
		console.log(USAGE);
		return 0;
	}
	const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
	if (!databaseUrl) throw new UsageError("缺少 --database-url 或 DATABASE_URL");
	const storage = PostgresStorage.connect(databaseUrl);
	try {
		await storage.initialize();
		const ownerId = await resolveOwnerId(storage, options);
		if (options.command === "enqueue") {
			const { result, input, settingsVersion } = await enqueueSynthetic(
				storage,
				ownerId,
				options,
			);
			const payload = {
				outcome: result.outcome,
				owner: mask(ownerId),
				settingsVersion,
				revision: input.revision,
				title: input.title,
				batchId: redactId(result.item?.batchId, ownerId),
				itemId: redactId(result.item?.id, ownerId),
				itemStatus: result.item?.status,
			};
			if (options.json) console.log(JSON.stringify(payload, null, 2));
			else {
				console.log(`写入结果：${result.outcome}`);
				console.log(`  用户 ${payload.owner} · 配置版本 v${settingsVersion}`);
				console.log(`  条目 ${payload.title}（revision ${payload.revision}）`);
				console.log(`  批次 ${payload.batchId} · 状态 ${payload.itemStatus}`);
				if (result.outcome === "duplicate")
					console.log("  同一 revision 已排队，未新增通知（幂等）。");
				if (result.outcome === "cancelled")
					console.log("  该条目此前已取消；重新开启不会复活旧队列。");
			}
			return 0;
		}
		if (options.command === "status") {
			const page = await readRecords(storage, ownerId, options);
			if (options.json) console.log(JSON.stringify(page, null, 2));
			else {
				console.log(`用户 ${mask(ownerId)} 的通知记录：`);
				console.log(formatRecords(page));
			}
			return 0;
		}
		throw new UsageError(`未知命令：${options.command}`);
	} finally {
		await storage.close();
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(
				error instanceof UsageError ? `${error.message}\n\n${USAGE}` : error,
			);
			process.exit(error instanceof UsageError ? 2 : 1);
		});
}
