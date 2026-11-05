import type { CardDelivery } from "@adpluse/core";

/** JSON 2.0: buttons are components, not the legacy action/note containers. */
export function toFeishuCard(delivery: CardDelivery): Record<string, unknown> {
	const card = delivery.card;
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
