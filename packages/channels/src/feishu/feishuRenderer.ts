import type { CardDelivery, InfoCard } from "@adpluse/core";

/** JSON 2.0: buttons are components, not the legacy action/note containers. */
export function toFeishuCard(delivery: CardDelivery): Record<string, unknown> {
	const card = delivery.card;
	// 信息卡（日汇总）：短摘要 + 每条来源引用 + 详情入口，不含候选按钮。
	if ("items" in card) return toInfoCard(card);
	if (card.evidence.length > 6 || card.options.length > 3)
		throw new Error("card exceeds decision profile");
	const buttons = card.options.map((option) => {
		const action = delivery.actions.find((item) => item.optionId === option.id);
		if (!action) throw new Error("missing action reference");
		return {
			tag: "button",
			text: { tag: "plain_text", content: option.label },
			type: "default",
			behaviors: [{ type: "callback", value: { actionRef: action.actionRef } }],
		};
	});
	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: card.title },
			template: "blue",
		},
		body: {
			elements: [
				{ tag: "div", text: { tag: "plain_text", content: card.summary } },
				...card.evidence.map((e) => ({
					tag: "div",
					text: { tag: "plain_text", content: `${e.label}：${e.value}` },
				})),
				...buttons,
				...(card.detailUrl
					? [
							{
								tag: "button",
								text: { tag: "plain_text", content: "查看详情" },
								behaviors: [
									{ type: "open_url", default_url: safeUrl(card.detailUrl) },
								],
							},
						]
					: []),
			],
		},
	};
}
function safeUrl(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "https:") throw new Error("detail URL must use HTTPS");
	return url.toString();
}

function toInfoCard(card: InfoCard): Record<string, unknown> {
	if (card.items.length === 0) throw new Error("info card requires items");
	const elements: Array<Record<string, unknown>> = [];
	if (card.intro)
		elements.push({ tag: "div", text: { tag: "plain_text", content: card.intro } });
	for (const item of card.items) {
		elements.push({
			tag: "div",
			text: { tag: "plain_text", content: `${item.title}\n${item.summary}` },
		});
		elements.push({
			tag: "div",
			text: {
				tag: "plain_text",
				content: `为什么相关：${item.relevance}`,
			},
		});
		// 来源逐条给出，未知时间保持未知，不补成「刚刚」。
		for (const source of item.sources) {
			const when = source.publishedAt
				? `发布于 ${source.publishedAt}`
				: source.observedAt
					? `获取于 ${source.observedAt}`
					: "时间未知";
			elements.push({
				tag: "div",
				text: {
					tag: "plain_text",
					content: `来源：${source.label}（${when}）`,
				},
			});
		}
		if (item.detailUrl)
			elements.push({
				tag: "button",
				text: { tag: "plain_text", content: "查看详情" },
				behaviors: [{ type: "open_url", default_url: safeUrl(item.detailUrl) }],
			});
	}
	if (card.footer)
		elements.push({
			tag: "div",
			text: { tag: "plain_text", content: card.footer },
		});
	if (card.detailUrl)
		elements.push({
			tag: "button",
			text: { tag: "plain_text", content: "管理订阅" },
			behaviors: [{ type: "open_url", default_url: safeUrl(card.detailUrl) }],
		});
	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: card.title },
			template: "turquoise",
		},
		body: { elements },
	};
}
