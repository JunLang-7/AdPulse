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

export interface User {
	id: string;
	status: "active" | "disabled";
	createdAt: string;
}
export interface IdentityBinding {
	id: string;
	platform: string;
	applicationId: string;
	tenantId: string;
	idType: string;
	externalId: string;
	userId: string;
	status: "active" | "revoked";
	verifiedAt: string;
}
export interface WebSession {
	/** SHA-256 digest of the opaque cookie value; never store the cookie itself. */
	id: string;
	userId: string;
	identityBindingId: string;
	createdAt: string;
	expiresAt: string;
	revokedAt?: string;
}
export interface LoginTransaction {
	/** SHA-256 digest of the one-time OAuth state. */
	id: string;
	browserBindingHash: string;
	codeVerifier: string;
	returnTo: string;
	status: "pending" | "consumed" | "expired";
	createdAt: string;
	expiresAt: string;
	consumedAt?: string;
}
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
		metricKey?: "cost_per_consultation";
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
export type ComparisonStatus =
	| "comparable"
	| "incomparable"
	| "awaiting_supplementation"
	| "missing_baseline"
	| "temporarily_uncomputable";
export type ComparisonReasonCode =
	| "NO_BASELINE"
	| "TASK_MISMATCH"
	| "ACCOUNT_MISMATCH"
	| "SOURCE_MISSING"
	| "SCOPE_MISMATCH"
	| "METRICS_CONTRACT_MISMATCH"
	| "CURRENCY_MISMATCH"
	| "ATTRIBUTION_MISMATCH"
	| "TIME_ZONE_MISMATCH"
	| "PERIOD_INVALID"
	| "PERIOD_OVERLAP"
	| "PERIOD_NOT_ADJACENT"
	| "DURATION_MISMATCH"
	| "PERIOD_INCOMPLETE"
	| "CALLBACK_PENDING"
	| "CALLBACK_UNKNOWN"
	| "VALUE_MISSING"
	| "VALUE_NULL"
	| "VALUE_INVALID"
	| "RULE_METRIC_MISSING"
	| "RULE_METRIC_UNSUPPORTED"
	| "RULE_THRESHOLD_MISSING"
	| "RULE_CURRENCY_MISSING"
	| "RULE_UNIT_MISSING"
	| "RULE_WINDOW_MISSING"
	| "RULE_MINIMUMS_MISSING"
	| "RULE_CURRENCY_MISMATCH"
	| "RULE_UNIT_MISMATCH"
	| "WINDOW_MISMATCH"
	| "SAMPLE_BELOW_MINIMUM"
	| "ZERO_DENOMINATOR";
export type ComparisonAxis = "period_comparison" | "current_threshold" | "both";
export type ComparisonMetric =
	| "spendMinor"
	| "consultations"
	| "cost_per_consultation";
export type RemediationAction =
	| "provide_evidence"
	| "revise_task_rules"
	| "verify_source"
	| "none";
export type CompletionCriteria =
	| "matching_complete_evidence_version"
	| "complete_task_rule_version"
	| "source_confirms_zero"
	| "manual_review";
export interface ComparisonReason {
	code: ComparisonReasonCode;
	axis: ComparisonAxis;
	metric?: ComparisonMetric;
	evidenceRef?: EvidenceRef;
	details?: Record<string, string | number | boolean>;
	remediation: {
		action: RemediationAction;
		completionCriteria: CompletionCriteria;
	};
}
export interface ComparisonEvidenceRef extends EvidenceRef {
	taskId: string;
	taskVersion: number;
}
export interface ComparisonResult {
	id: string;
	ownerId: string;
	taskId: string;
	current: ComparisonEvidenceRef;
	baseline?: ComparisonEvidenceRef;
	rulesRef: { taskId: string; version: number };
	evaluatorVersion: 1;
	status: ComparisonStatus;
	canComparePeriods: boolean;
	canEvaluateCurrentThreshold: boolean;
	comparisons: {
		spendMinor?: { baseline: number; current: number; delta: number };
		consultations?: { baseline: number; current: number; delta: number };
		costPerConsultation?: {
			baseline: { numeratorMinor: number; denominatorConsultations: number };
			current: { numeratorMinor: number; denominatorConsultations: number };
			direction: "increased" | "decreased" | "unchanged";
		};
	};
	thresholdEvaluation: {
		status: "exceeded" | "not_exceeded" | "not_evaluated";
		metricKey?: "cost_per_consultation";
		value?: { numeratorMinor: number; denominatorConsultations: number };
		thresholdMinor?: number;
		currency?: string;
	};
	reasons: ComparisonReason[];
	followUpIds: string[];
	createdAt: string;
}
export interface ComparisonOperation {
	id: string;
	ownerId: string;
	operation: "evaluate" | "resolve_follow_up";
	key: string;
	digest: string;
	resultId?: string;
	followUpId?: string;
}
export interface ComparisonFollowUp {
	id: string;
	ownerId: string;
	taskId: string;
	taskVersion: number;
	dedupKey: string;
	reasonCode: ComparisonReasonCode;
	axis: ComparisonAxis;
	remediation: ComparisonReason["remediation"];
	metric?: ComparisonMetric;
	evidenceRef?: EvidenceRef;
	anchorEvidenceRef?: EvidenceRef;
	resolutionKind: "evidence" | "task_version";
	source?: { platform: string; accountRef: string };
	expectedRelation?: "same_period" | "previous_adjacent" | "adjacent_pair";
	minimumSpendMinor?: number;
	minimumConsultations?: number;
	scope?: { planRef: string; campaignRefs: string[] };
	period?: {
		startsAt: string;
		endsAt: string;
		timeZone: string;
	};
	status: "open" | "completed";
	comparisonResultIds: string[];
	events: Array<{
		type: "opened" | "observed" | "completed" | "reopened";
		at: string;
		resultId?: string;
		material?:
			| { kind: "evidence"; evidenceId: string; version: number }
			| { kind: "task_version"; taskId: string; version: number };
	}>;
	createdAt: string;
	updatedAt: string;
}
export interface InvestigationAlertEvidence {
	comparisonResultId: string;
	evidence: ComparisonEvidenceRef;
	source: { platform: string; accountRef: string };
	scope: EvidenceVersion["scope"];
	period: EvidenceVersion["period"];
	metric: "cost_per_consultation";
	metricDefinition: string;
	metricFormula: string;
	spendMinor?: number | null;
	consultations?: number | null;
	currency: EvidenceVersion["currency"];
	thresholdMinor?: number;
	comparisonStatus: ComparisonStatus;
	canComparePeriods: boolean;
	limitations: ComparisonReasonCode[];
	handlingDeadlineHours?: number;
}
export type InvestigationAlertStatus =
	| "open"
	| "awaiting_evidence"
	| "handled"
	| "cleared"
	| "stale"
	| "capped";
export interface InvestigationAlert {
	id: string;
	ownerId: string;
	taskId: string;
	logicalKey: string;
	sessionId: string;
	status: InvestigationAlertStatus;
	statusReason?: string;
	current: InvestigationAlertEvidence;
	comparisonResultIds: string[];
	maxPushRounds: number;
	logicalRounds: number;
	events: Array<{
		type: "opened" | "observed" | "candidate_created" | "deferred" | "handled" | "cleared" | "invalidated" | "capped";
		at: string;
		comparisonResultId: string;
		evidence: ComparisonEvidenceRef;
		reason?: string;
	}>;
	createdAt: string;
	updatedAt: string;
}
export interface Session {
	id: string;
	ownerId: string;
	taskRef?: { taskId: string; taskVersion: number };
	monetarySuggestionsAllowed?: boolean;
	deliveryMode?: "channel" | "web";
	investigationAlertId?: string;
	alertEvidenceRef?: EvidenceRef;
	recipient?: Recipient;
	allowedActorIds: string[];
	strategy: Strategy;
	limits: Limits;
	signal: Signal;
	version: number;
	roundNo: number;
	status: "planning" | "awaiting_input" | "completed" | "cancelled" | "stale";
	expiresAt?: string;
	createdAt: string;
}
export interface Round {
	id: string;
	sessionId: string;
	roundNo: number;
	strategyVersion: number;
	status: "open" | "answered" | "invalidated";
	invalidationReason?: string;
	expiresAt?: string;
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
	| { kind: "prepare_investigation_alert_session"; alertId: string }
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
export interface SourceRun {
	id: string;
	sourceKey: string;
	startedAt: string;
	finishedAt: string | null;
	httpStatus: number | null;
	robotsState: "allow" | "absent" | "disallow" | "blocked";
	bytes: number;
	itemCount: number;
	outcome: "ok" | "parse_failed" | "http_error" | "blocked" | "stopped";
	snapshotComplete: boolean;
	configVersion: string;
	errorReason: string | null;
}
export interface SourceSnapshot {
	id: string;
	runId: string;
	sourceKey: string;
	itemKey: string;
	contentHash: string;
	createdAt: string;
}
export interface SourceItem {
	id: string;
	sourceKey: string;
	itemKey: string;
	title: string;
	itemUrl: string;
	publishedAt: string | null;
	firstSeenAt: string;
	lastSeenAt: string;
	titleUpdatedAt: string | null;
	contentScope: "title_link_only";
	status: "active" | "purged";
}
export interface SourceState {
	id: string;
	sourceKey: string;
	status: "active" | "stopped";
	stoppedAt: string | null;
	stoppedReason: string | null;
	resumedAt: string | null;
	resumedBy: string | null;
	lastPrunedAt: string | null;
}
export interface Entities {
	users: User;
	identityBindings: IdentityBinding;
	webSessions: WebSession;
	loginTransactions: LoginTransaction;
	tasks: Task;
	taskVersions: TaskVersion;
	taskOperations: TaskOperation;
	evidenceHeads: EvidenceHead;
	evidenceVersions: EvidenceVersion;
	evidenceSources: EvidenceSource;
	evidenceOperations: EvidenceOperation;
	comparisonResults: ComparisonResult;
	comparisonOperations: ComparisonOperation;
	comparisonFollowUps: ComparisonFollowUp;
	investigationAlerts: InvestigationAlert;
	sourceStates: SourceState;
	sourceRuns: SourceRun;
	sourceSnapshots: SourceSnapshot;
	sourceItems: SourceItem;
	sessions: Session;
	rounds: Round;
	actions: ActionRef;
	snapshots: StrategySnapshot;
	inbox: Inbox;
	deliveries: Delivery;
	jobs: Job;
}
