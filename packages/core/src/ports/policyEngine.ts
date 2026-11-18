import type { DecisionCard } from "../domain/decisionCard.js";
import type {
	Limits,
	Signal,
	Strategy,
	StrategyChange,
} from "../domain/strategy.js";

export interface Candidate {
	id: string;
	label: string;
	changes: StrategyChange[];
	complete: boolean;
	/** 这条建议依赖的判断；不知道就省略，不编造。 */
	hypothesis?: string;
	/** 如何验证，以及什么情况下继续、调整或停止。 */
	validationPlan?: string;
}
export interface Proposal {
	card: Omit<DecisionCard, "options">;
	candidates: Candidate[];
}
/** May perform slow I/O. Always invoked outside a database transaction. */
export interface PolicyEngine {
	propose(context: {
		strategy: Strategy;
		limits: Limits;
		signal: Signal;
		roundNo: number;
	}): Promise<Proposal>;
}
