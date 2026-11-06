import type { DecisionCard } from "../domain/decisionCard.js";
import type {
	Limits,
	Signal,
	Strategy,
	StrategyChange,
} from "../domain/strategy.js";
import type {
	CardDelivery,
	ChoiceCommand,
	Recipient,
} from "../ports/channel.js";
import type { Candidate } from "../ports/policyEngine.js";

export interface Task {
	id: string;
	ownerId: string;
	currentVersion: number;
	createdAt: string;
}
export interface TaskVersion {
	id: string;
	taskId: string;
	version: number;
	product: string;
	strategy: Strategy;
	observation: {
		scope?: string;
		startsAt?: string;
		endsAt?: string;
	};
	rules: {
		metricDefinition?: string;
		currency?: string;
		unit?: string;
		statWindowDays?: number;
		alertThresholdMinor?: number;
		minimumSpendMinor?: number;
		minimumConsultations?: number;
		handlingDeadlineHours?: number;
		maxPushRounds?: number;
	};
	createdAt: string;
}
export interface TaskOperation {
	id: string;
	ownerId: string;
	operation: "create" | "revise";
	key: string;
	digest: string;
	taskId: string;
	taskVersion: number;
}
export interface EvidenceRef {
	evidenceId: string;
	version: number;
}
export interface EvidenceImportRecord {
	source: {
		platform: string;
		accountRef: string;
		reportRef: string;
		sourceUri?: string;
	};
	scope: { planRef: string; campaignRefs: string[] };
	period: {
		startsAt: string;
		endsAt: string;
		timeZone: string;
		completeness: "complete" | "partial";
	};
	metricsContract: {
		spendMinor: { definition: string; formula: string; sourceField: string };
		consultations: { definition: string; formula: string; sourceField: string };
	};
	currency: { code: string; minorUnit: string; minorUnitsPerMajor: number };
	attribution: { model: string; windowDays?: number };
	callbackStatus: "complete" | "pending" | "not_applicable" | "unknown";
	rawValues: {
		spend?: string | number | null;
		consultations?: string | number | null;
	};
	values: EvidenceValues;
}
export interface EvidenceSourceInput {
	source: EvidenceImportRecord["source"];
	rawValues: EvidenceImportRecord["rawValues"];
}
export interface EvidenceValues {
	spendMinor?: number | null;
	consultations?: number | null;
}
export interface EvidenceHead {
	id: string;
	ownerId: string;
	taskId: string;
	taskVersion: number;
	currentVersion: number;
	createdAt: string;
}
export interface EvidenceVersion {
	id: string;
	evidenceId: string;
	ownerId: string;
	taskId: string;
	taskVersion: number;
	version: number;
	businessKey: string;
	contentDigest: string;
	scope: { planRef: string; campaignRefs: string[] };
	period: {
		startsAt: string;
		endsAt: string;
		timeZone: string;
		completeness: "complete" | "partial";
	};
	metricsContract: {
		spendMinor: { definition: string; formula: string; sourceField: string };
		consultations: { definition: string; formula: string; sourceField: string };
	};
	currency: { code: string; minorUnit: string; minorUnitsPerMajor: number };
	attribution: { model: string; windowDays?: number };
	callbackStatus: "complete" | "pending" | "not_applicable" | "unknown";
	values: EvidenceValues;
	createdAt: string;
	reason?: string;
}
export interface EvidenceSource {
	id: string;
	ownerId: string;
	evidenceId: string;
	evidenceVersion: number;
	source: {
		platform: string;
		accountRef: string;
		reportRef: string;
		sourceUri?: string;
	};
	rawValues: {
		spend?: string | number | null;
		consultations?: string | number | null;
	};
	digest: string;
	createdAt: string;
}
export interface EvidenceOperation {
	id: string;
	ownerId: string;
	operation: "import" | "revise";
	key: string;
	digest: string;
	results: Array<{ evidenceId: string; version: number; status: "created" | "reused" | "revised" }>;
}
export interface Session {
	id: string;
	ownerId: string;
	taskRef?: { taskId: string; taskVersion: number };
	monetarySuggestionsAllowed?: boolean;
	recipient: Recipient;
	allowedActorIds: string[];
	strategy: Strategy;
	limits: Limits;
	signal: Signal;
	version: number;
	roundNo: number;
	status: "planning" | "awaiting_input" | "completed" | "cancelled";
	expiresAt: string;
	createdAt: string;
}
export interface Round {
	id: string;
	sessionId: string;
	roundNo: number;
	strategyVersion: number;
	status: "open" | "answered";
	expiresAt: string;
	card: DecisionCard;
	candidates: Candidate[];
	selectedOptionId?: string;
	selectedBy?: ChoiceCommand["actor"];
	respondedAt?: string;
}
export interface ActionRef {
	id: string;
	roundId: string;
	optionId: string;
}
export interface StrategySnapshot {
	id: string;
	sessionId: string;
	version: number;
	strategy: Strategy;
	changes: StrategyChange[];
	createdAt: string;
}
export interface Inbox {
	id: string;
	command: ChoiceCommand;
	status: "pending" | "processed" | "rejected" | "failed";
	reason?: string;
	receivedAt: string;
}
export interface Delivery extends CardDelivery {
	sessionId: string;
	roundId: string;
	purpose: "decision" | "confirmation";
	expiresAt: string;
	status: "pending" | "sent" | "failed" | "cancelled";
	externalMessageId?: string;
	sentAt?: string;
	lastError?: string;
}
export type JobTask =
	| { kind: "process_inbox"; inboxId: string }
	| { kind: "prepare_round"; sessionId: string; version: number }
	| { kind: "send_delivery"; deliveryId: string };
export interface Job {
	id: string;
	task: JobTask;
	status: "pending" | "running" | "done" | "failed";
	runAt: string;
	attempts: number;
	leaseToken?: string;
	lockedUntil?: string;
	lastError?: string;
}
export interface Entities {
	tasks: Task;
	taskVersions: TaskVersion;
	taskOperations: TaskOperation;
	evidenceHeads: EvidenceHead;
	evidenceVersions: EvidenceVersion;
	evidenceSources: EvidenceSource;
	evidenceOperations: EvidenceOperation;
	sessions: Session;
	rounds: Round;
	actions: ActionRef;
	snapshots: StrategySnapshot;
	inbox: Inbox;
	deliveries: Delivery;
	jobs: Job;
}
