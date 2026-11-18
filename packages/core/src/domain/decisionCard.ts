/** 单条候选的假设/验证说明上限：保证卡片不被长文本撞断，也不强迫模型写满。 */
export const MAX_CANDIDATE_RATIONALE_LENGTH = 300;

/** Product presentation, not a platform card schema. */
export interface DecisionCard {
	title: string;
	summary: string;
	evidence: Array<{ label: string; value: string; sourceUrl?: string }>;
	options: Array<{
		id: string;
		label: string;
		/** 选项补充说明（假设/验证），不参与按钮回调；缺省时不展示。 */
		detail?: string;
	}>;
	detailUrl?: string;
}
