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
	/** 平台返回的显示名；仅用于界面展示，不参与身份唯一性判断。 */
	displayName?: string;
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
/**
 * 机器人单聊目的地：只记录「本人的已验证身份对应哪个单聊」，不含授权状态。
 * 作用域与身份绑定一致，避免用裸 open_id 串号。
 */
export interface NotificationDestination {
	id: string;
	userId: string;
	platform: string;
	applicationId: string;
	tenantId: string;
	idType: string;
	externalId: string;
	status: "verified" | "invalidated";
	verifiedAt: string;
	/** 平台报告「收件人不可达」的连续次数；达阈值即置 invalidated。 */
	unreachableCount?: number;
	invalidatedAt?: string;
}

/**
 * 通知授权：与目的地、登录绑定分开建模。撤销不等于注销账号，
 * 目的地仍保留，只是不再允许主动发送。
 */
export interface NotificationConsent {
	id: string;
	userId: string;
	destinationId: string;
	status: "active" | "revoked";
	grantedAt: string;
	revokedAt?: string;
	/** 乐观并发：每次授权/撤销自增；旧请求重放会因版本不符被拒。 */
	version: number;
}

/** 关注对象：本人任务，或本人录入的品牌/竞品名称（#38 出现实体后再关联）。 */
export type SubscriptionTargetKind = "task" | "brand" | "competitor";
/** 首期三维筛选里的「类别」：效果排查、明确事件、补证/待处理。 */
export type SubscriptionCategory = "effect" | "event" | "evidence";
/** 「关联范围」：只关联该对象所在任务，或也接收该对象的一般动态。 */
export type SubscriptionScope = "task_only" | "include_general";

export interface SubscriptionTarget {
	id: string;
	userId: string;
	kind: SubscriptionTargetKind;
	/** task：任务 id；brand/competitor：名称规范化后的 key。 */
	refId: string;
	/** 展示名。task 取任务当前版本的 product 快照。 */
	label: string;
	sourceUrl?: string;
	/** 该对象订阅的类别；空数组表示暂不可用于投递。 */
	categories: SubscriptionCategory[];
	scope: SubscriptionScope;
	/** muted 即「退订该对象」，保留以便恢复，不删除历史。 */
	status: "active" | "muted";
	createdAt: string;
	updatedAt: string;
}

export interface SubscriptionSettings {
	/** 与 userId 相同：每人一份。 */
	id: string;
	userId: string;
	/** 单调版本：开关、关注列表、类别、范围的所有写入共用同一个计数。 */
	version: number;
	/** 默认关闭：登录或保存配置都不等于启用。 */
	proactiveEnabled: boolean;
	/** 启用时把本人确认过的时段一并持久化，便于将来变更可检测。 */
	schedule: {
		timezone: "Asia/Shanghai";
		digestAt: string;
		quietStart: string;
		quietEnd: string;
	};
	enabledAt?: string;
	disabledAt?: string;
	updatedAt: string;
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
	/**
	 * 谁发起这次会话：`self` 是用户本人的操作，`system` 是系统主动提醒。
	 * 只有 `system` 的投递受通知授权闸门约束（见 #35）；缺省视为 self。
	 */
	initiatedBy?: "self" | "system";
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
	status: "pending" | "sent" | "failed" | "cancelled" | "suppressed";
	externalMessageId?: string;
	sentAt?: string;
	lastError?: string;
	/** suppressed 的原因：未授权 / 目的地失效 / 身份绑定失效。 */
	suppressionReason?: string;
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
	notificationDestinations: NotificationDestination;
	notificationConsents: NotificationConsent;
	subscriptionSettings: SubscriptionSettings;
	subscriptionTargets: SubscriptionTarget;
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
