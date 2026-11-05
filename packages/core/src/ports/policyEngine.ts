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
