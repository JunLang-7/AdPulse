/** 信息卡：短摘要 + 每条来源引用，不创建 Session，也不冒充已核实正文。 */
export interface InfoCard {
	title: string;
	intro?: string;
	items: Array<{
		title: string;
		summary: string;
		/** 为什么与关注对象/任务相关；未知时如实写「未确定」。 */
		relevance: string;
		sources: Array<{
			label: string;
			url?: string;
			publishedAt?: string | null;
			observedAt?: string;
		}>;
		detailUrl?: string;
	}>;
	footer?: string;
	detailUrl?: string;
}

/** 首期一张卡最多展示 5 条；超出的不塞进卡片，只说明「另有 N 条」。 */
export const MAX_INFO_ITEMS = 5;

const tooLong = (value: string, max: number): boolean =>
	value.length > max || /[\u0000-\u001f]/.test(value);

export class InfoCardError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InfoCardError";
	}
}

/** 渲染前校验：长度与条目数都要有上限，避免卡片被截断或超限发送失败。 */
export function validateInfoCard(card: InfoCard): void {
	if (!card.title.trim()) throw new InfoCardError("title required");
	if (tooLong(card.title, 60)) throw new InfoCardError("title too long");
	if (card.items.length === 0) throw new InfoCardError("at least one item");
	if (card.items.length > MAX_INFO_ITEMS)
		throw new InfoCardError("too many items");
	for (const item of card.items) {
		if (!item.title.trim() || !item.summary.trim())
			throw new InfoCardError("item title and summary required");
		if (tooLong(item.title, 80)) throw new InfoCardError("item title too long");
		if (tooLong(item.summary, 300))
			throw new InfoCardError("item summary too long");
		if (tooLong(item.relevance, 120))
			throw new InfoCardError("item relevance too long");
		if (item.sources.length === 0)
			throw new InfoCardError("item source required");
		for (const source of item.sources) {
			if (!source.label.trim())
				throw new InfoCardError("source label required");
			if (source.url) {
				let url: URL;
				try {
					url = new URL(source.url);
				} catch {
					throw new InfoCardError("invalid source url");
				}
				if (url.protocol !== "https:" && url.protocol !== "http:")
					throw new InfoCardError("source url must be http(s)");
			}
		}
	}
}

/** 日汇总卡片：只展示前 N 条，其余如实说明「另有 N 条」而不是丢弃。 */
export function buildDigestCard(
	items: Array<{
		title: string;
		summary: string;
		relevance: string;
		sources: InfoCard["items"][number]["sources"];
		detailUrl?: string;
	}>,
	input: { date: string; remaining?: number; detailUrl?: string; simulated?: boolean },
): InfoCard {
	const shown = items.slice(0, MAX_INFO_ITEMS);
	const remaining = input.remaining ?? Math.max(0, items.length - shown.length);
	const card: InfoCard = {
		title: `信息汇总 · ${input.date}`,
		intro: input.simulated
			? "以下内容为测试/模拟数据，不代表真实经营结果。"
			: "以下为与你关注对象相关的新信息，按时间汇总发送。",
		items: shown,
		footer: [
			remaining > 0 ? `另有 ${remaining} 条未在本卡展示。` : undefined,
			"退订某个对象或关闭主动推送，请到控制台「订阅与关注」。",
		]
			.filter(Boolean)
			.join(" "),
		...(input.detailUrl ? { detailUrl: input.detailUrl } : {}),
	};
	validateInfoCard(card);
	return card;
}
