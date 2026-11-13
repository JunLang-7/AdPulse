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
	/** 独立确认决策卡；历史记录缺省为关闭，不继承日汇总授权。 */
	decisionCards?: {
		enabled: boolean;
		enabledAt?: string;
		disabledAt?: string;
		confirmedVersion?: number;
	};
	updatedAt: string;
}

/** 主动通知批次：一人一天一类一份，用于幂等与「当日补一次」。 */
export type NotificationBatchKind = "digest";
export type NotificationBatchStatus =
	| "queued"
	| "sent"
	| "cancelled"
	| "expired"
	| "suppressed"
	| "failed";

export interface NotificationBatch {
	/** 幂等标识：ownerId + localDate + kind。 */
	id: string;
	ownerId: string;
	kind: NotificationBatchKind;
	/** 北京时间的本地日期（YYYY-MM-DD），不跟随服务器时区。 */
	localDate: string;
	/** 生成时的订阅配置版本；投递前比对，不等即视为过期。 */
	settingsVersion: number;
	status: NotificationBatchStatus;
	/** 计划发送时刻（UTC 表示，对应北京时间 09:30）。 */
	scheduledAt: string;
	/** 是否为「错过 09:30 后当日补发」。 */
	catchUp?: boolean;
	sentAt?: string;
	statusReason?: string;
	createdAt: string;
	updatedAt: string;
}

/** 单条待发信息；logicalKey 保证同一逻辑事件不因重试/换标题/转载重复通知。 */
export type NotificationItemKind = "effect_alert";
export type NotificationItemStatus = "queued" | "sent" | "cancelled" | "expired";

export interface NotificationItem {
	/** ownerId + logicalKey：同一逻辑事件只有一行，重发靠 revision 推进。 */
	id: string;
	ownerId: string;
	batchId: string;
	logicalKey: string;
	kind: NotificationItemKind;
	taskId?: string;
	title: string;
	summary: string;
	/** 为什么与关注对象/任务相关；未知保留未知，不补成结论。 */
	relevance: string;
	/** 来源引用：只存引用与时间，不存原文。 */
	sources: Array<{
		label: string;
		url?: string;
		publishedAt?: string | null;
		observedAt?: string;
	}>;
	/** 实质更新序号：新增证据或纠正才 +1，并据此再次通知。 */
	revision: number;
	status: NotificationItemStatus;
	/** 复用 Delivery：不另建投递状态机。 */
	deliveryId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface WebSession {
	/** SHA-256 digest of the opaque cookie value; never store the cookie itself. */
	id: string;
	/** Stable identifier shared by all token generations of one login. */
	familyId?: string;
	userId: string;
	identityBindingId: string;
	createdAt: string;
	/** current or short-lived grace token after rotation. */
	tokenStatus?: "current" | "grace";
	graceExpiresAt?: string;
	rotatedAt?: string;
	/** Minimum expiry for legacy sessions created before sliding activity (#87). */
	expiresAt: string;
	revokedAt?: string;
	/** Present on sessions created by #87; absent records retain legacy absolute expiry. */
	sessionMode?: "default" | "remembered";
	authenticatedAt?: string;
	lastActivityAt?: string;
	recentlyVerifiedAt?: string;
	idleExpiresAt?: string;
	absoluteExpiresAt?: string;
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
	/** Retained for the follow-up activity/reauth API; not trusted from clients. */
	rememberMe?: boolean;
	purpose?: "login" | "reauth";
	reauthSessionId?: string;
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
	/** 决策/回执投递属于某个会话；日汇总投递没有会话，因此可缺省。 */
	sessionId?: string;
	roundId?: string;
	purpose: "decision" | "confirmation" | "digest";
	/** New alert decision only: frozen permission snapshot, rechecked before every attempt. */
	proactiveDecision?: {
		frozenAt: string;
		settingsVersion: number;
		confirmedVersion: number;
		enabledAt: string;
		destinationId: string;
		destinationVerifiedAt: string;
		consentVersion: number;
	};
	/** Last successful preflight, committed before network I/O; not a send receipt. */
	proactiveCheckedAt?: string;
	/** 主动通知投递的归属人；日汇总用它做发送前重检与取消。 */
	ownerId?: string;
	/** 日汇总投递对应的批次（回写批次状态用）。 */
	batchId?: string;
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
	| { kind: "send_delivery"; deliveryId: string }
	| { kind: "send_investigation_decision"; deliveryId: string }
	| { kind: "send_digest"; batchId: string };
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
/**
 * 个人模型连接（#86）：只存非敏感投影。密钥单独放在 UserModelCredential 的密文记录里，
 * 不进入连接、任务、队列或证据载荷。
 */
export type ModelConnectionProtocol =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai";

export interface ModelConnectionModel {
	id: string;
	label?: string;
}

export interface UserModelConnection {
	id: string;
	ownerId: string;
	/** 用户域内稳定的 Provider ID，创建后不可改；同一 ID 可在不同用户下存在。 */
	providerId: string;
	kind: "catalog" | "custom";
	/** 预置供应商目录里的 id；自定义连接不带这个字段。 */
	catalogId?: string;
	displayName: string;
	/** 规范化后的 HTTPS 基础地址，不含 userinfo/query/hash 与结尾斜杠。 */
	baseUrl: string;
	protocol: ModelConnectionProtocol;
	models: ModelConnectionModel[];
	/** 删除密钥后置 disabled：元数据保留，但立即不可调用。 */
	status: "active" | "disabled";
	version: number;
	createdAt: string;
	updatedAt: string;
	/** 验证结果绑定到版本：配置变更后旧绿灯失效。 */
	verifiedAt?: string;
	verifiedVersion?: number;
}

/** 每条连接一份凭据；id 与 connectionId 相同，避免出现第二份可用密钥。 */
export interface UserModelCredential {
	id: string;
	ownerId: string;
	connectionId: string;
	credentialVersion: number;
	keyId: string;
	algorithm: "aes-256-gcm";
	/** base64：随机 nonce、密文与认证 tag 分开存放，便于审计与轮换。 */
	nonce: string;
	ciphertext: string;
	authTag: string;
	createdAt: string;
	updatedAt: string;
}

/** 每人一份默认选择；即使清空也保留版本计数，便于检测并发。 */
export interface UserModelPreference {
	id: string;
	ownerId: string;
	connectionId: string | null;
	modelId: string | null;
	version: number;
	updatedAt: string;
}

export interface Entities {
	users: User;
	identityBindings: IdentityBinding;
	notificationDestinations: NotificationDestination;
	notificationConsents: NotificationConsent;
	userModelConnections: UserModelConnection;
	userModelCredentials: UserModelCredential;
	userModelPreferences: UserModelPreference;
	subscriptionSettings: SubscriptionSettings;
	notificationBatches: NotificationBatch;
	notificationItems: NotificationItem;
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
