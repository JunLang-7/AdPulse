/** Product presentation, not a platform card schema. */
export interface DecisionCard {
	title: string;
	summary: string;
	evidence: Array<{ label: string; value: string; sourceUrl?: string }>;
	options: Array<{ id: string; label: string }>;
	detailUrl?: string;
}
