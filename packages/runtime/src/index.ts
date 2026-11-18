import {
	type ChannelAccount,
	ChannelRegistry,
	createFeishuAccount,
	WebhookError,
} from "@adpluse/channels";
import {
	ComparisonService,
	EvidenceService,
	HypothesisService,
	MarketEventService,
	DigestScheduler,
	InvestigationAlertService,
	LifecycleCleanupService,
	NotificationQueue,
	NotificationService,
	ModelConnectionService,
	Orchestrator,
	SubscriptionService,
	ValidationCheckService,
	resolveActiveIdentity,
	SOURCE_DEFINITIONS,
	SourceService,
	TaskService,
	type DecisionAccountResolver,
	type PolicyEngine,
	type Storage,
	Worker,
} from "@adpluse/core";
import { MemoryStorage, PostgresStorage } from "@adpluse/storage";
import { createModelCredentialCipher } from "./model-credential-cipher.js";
import { discoverModels } from "./model-discovery.js";
import { createModelEgressFetch } from "./model-egress.js";
import { HttpSourceFetcher } from "./source-fetch.js";
import type { TaskDraftExtractor } from "./task-draft-extractor.js";
import {
	createPersistedTaskDraftExtractor,
	createTaskDraftRequestLimit,
	createUserRequestBudgets,
	isTaskDraftProtocolWired,
	type ModelRouteInput,
} from "./task-draft-extractor.js";
import { createTaskDraftModels } from "./task-draft-models.js";
import {
	createHypothesisVerdictJobHandler,
	type HypothesisVerdictSource,
} from "./hypothesis-jobs.js";
import { createHypothesisReasoning } from "./hypothesis-reasoning.js";

export { createHypothesisReasoning };
export type {
	HypothesisDraftRequest,
	HypothesisDraftSuggestion,
	HypothesisJudgeRequest,
	HypothesisJudgmentSuggestion,
	HypothesisReasoning,
} from "./hypothesis-reasoning.js";
export type { HypothesisVerdictSource } from "./hypothesis-jobs.js";

export const reviewPolicy: PolicyEngine = {
	async propose({ signal, roundNo }) {
		return {
			card: {
				title: `第 ${roundNo} 轮：${signal.title}`,
				summary: signal.summary,
				evidence: signal.evidence,
			},
			candidates: [
				{ id: "acknowledge", label: "确认已阅", changes: [], complete: true },
				{ id: "observe", label: "继续观察", changes: [], complete: false },
				{ id: "ignore", label: "忽略此条", changes: [], complete: true },
			],
		};
	},
};

/** The composition root is the only place selecting infrastructure and providers. */
export function compose(
	storage: Storage,
	accounts: ChannelAccount[],
	policy: PolicyEngine = reviewPolicy,
	options: {
		detailUrlBase?: string;
		decisionCardsEnabled?: boolean;
		/** 假设偏差初判处理器；未注入时初判 job 失败（独立 worker 场景需自行装配）。 */
		hypothesisVerdicts?: {
			prepare: (source: HypothesisVerdictSource) => Promise<void>;
		};
	} = {},
) {
	const channels = new ChannelRegistry(accounts);
	// 站内详情链接只在 HTTPS 控制台 origin 下生成：卡片渲染强制 https，
	// 本地 http 开发环境保持无链接，避免渲染期抛错导致投递失败。
	const detailBase =
		options.detailUrlBase && options.detailUrlBase.startsWith("https://")
			? options.detailUrlBase.replace(/\/+$/, "")
			: undefined;
	// Only the first-party Feishu single-chat route is enabled in this milestone.
	// Match the entire attested scope, never just platform or externalId.
	const decisionAccountFor: DecisionAccountResolver | undefined =
		options.decisionCardsEnabled
			? (destination) => {
					if (
						destination.platform !== "feishu" ||
						destination.idType !== "open_id"
					)
						return undefined;
					const matches = accounts.filter(
						(account) =>
							account.inbound.identifyActor &&
							account.identityScope?.platform === destination.platform &&
							account.identityScope.applicationId ===
								destination.applicationId &&
							account.identityScope.tenantId === destination.tenantId,
					);
					return matches.length === 1 ? matches[0]?.id : undefined;
				}
			: undefined;

	const decisions = new Orchestrator(
		storage,
		policy,
		undefined,
		undefined,
		async (tx, actor) => {
			const account = accounts.find((candidate) => candidate.id === actor.accountId);
			const identity = account?.inbound.identifyActor?.(actor);
			return Boolean(identity && actor.userId &&
				(await resolveActiveIdentity(tx, identity)) === actor.userId);
		},
		detailBase ? (sessionId) => `${detailBase}/sessions/${sessionId}` : undefined,
		decisionAccountFor,
	);
	const tasks = new TaskService(storage);
	const evidence = new EvidenceService(storage);
	const comparisons = new ComparisonService(storage);
	const investigationAlerts = new InvestigationAlertService(storage);
	const notifications = new NotificationService(storage);
	const subscriptions = new SubscriptionService(storage);
	const notificationQueue = new NotificationQueue(storage);
	const digestScheduler = new DigestScheduler(storage, subscriptions, notificationQueue);
	const lifecycleCleanup = new LifecycleCleanupService(storage);
	const validationChecks = new ValidationCheckService(storage);
	// 目的地平台 → 渠道账号：只匹配声明了同一身份作用域的连接，避免把飞书消息发到别的账号。
	const platformAccounts = new Map<string, string>();
	for (const account of accounts)
		if (account.identityScope)
			platformAccounts.set(account.identityScope.platform, account.id);
	return {
		storage,
		channels,
		decisions,
		tasks,
		evidence,
		marketEvents: new MarketEventService(storage),
		hypotheses: new HypothesisService(storage),
		comparisons,
		investigationAlerts,
		notifications,
		worker: new Worker(
			storage,
			decisions,
			channels.outbound(),
			undefined,
			5,
			investigationAlerts,
			notifications,
			{
				scheduler: digestScheduler,
				subscriptions,
				queue: notificationQueue,
				accountIdForPlatform: (platform) => platformAccounts.get(platform),
				...(detailBase ? { detailBase } : {}),
			},
			30_000,
			decisionAccountFor,
			lifecycleCleanup,
			3_600_000,
			options.hypothesisVerdicts,
			validationChecks,
		),
	};
}
export type Runtime = ReturnType<typeof compose> & {
	extractTaskDraft?: TaskDraftExtractor;
	taskDraftModels?: ReturnType<typeof createTaskDraftModels>;
	modelConnections?: ReturnType<typeof createModelConnections>;
};

/**
 * 个人模型连接的持久化基础。主密钥未配置/不合法时返回 undefined，
 * 调用方据此返回不可用，而不是退回内存临时连接或明文。
 * 探针与抽取器都走受控出网层（DNS 绑定、禁重定向、限大小/超时）。
 */
export function createModelConnections(
	storage: Storage,
	env: Record<string, string | undefined> = process.env,
	fetchImpl: typeof fetch = createModelEgressFetch(),
) {
	const cipher = createModelCredentialCipher(env);
	if (!cipher) return;
	const service = new ModelConnectionService(storage, cipher);
	// 探针、发现与抽取共用同一份实例预算；再叠一层按 owner 的预算，
	// 避免单个用户耗尽全站额度。两者都在发起请求前判定。
	const instanceLimit = createTaskDraftRequestLimit();
	const userLimitFor = createUserRequestBudgets();
	function budgeted<T>(ownerId: string, request: () => Promise<T | null>): Promise<T | null> {
		return userLimitFor(ownerId)(() => instanceLimit(request));
	}
	return {
		service,
		/** 用固定合成短句验证候选连接；不写入、不发送任务材料。 */
		async probe(ownerId: string, input: ModelRouteInput): Promise<boolean> {
			const extract = createPersistedTaskDraftExtractor(input, fetchImpl, (request) => budgeted(ownerId, request));
			const suggestions = extract ? await extract(modelConnectionTestBrief, "overview") : null;
			return Boolean(
				suggestions?.product || suggestions?.objective ||
				suggestions?.recommendations?.product || suggestions?.recommendations?.objectives?.length,
			);
		},
		draftExtractor(ownerId: string, input: ModelRouteInput): TaskDraftExtractor | undefined {
			return createPersistedTaskDraftExtractor(input, fetchImpl, (request) => budgeted(ownerId, request));
		},
		/** 只在显式点击时调用；失败返回 null，不代替用户猜模型。 */
		discover(ownerId: string, input: { baseUrl: string; protocol: ModelRouteInput["protocol"]; apiKey: string }) {
			// 发现与测试/调用共用同一份限额，避免它成为绕过预算的通道。
			return budgeted(ownerId, () => discoverModels(input, fetchImpl));
		},
		protocolWired: isTaskDraftProtocolWired,
	};
}

export const modelConnectionTestBrief = "产品：连接测试";

export { taskDraftBriefMaxLength, taskDraftStages } from "./task-draft-extractor.js";
export type { TaskDraftSelection } from "./task-draft-models.js";
export { catalogForClient, findCatalogModel, findCatalogProvider, modelCatalogProviders } from "./model-catalog.js";
export type { ModelCatalogModel, ModelCatalogProvider } from "./model-catalog.js";

export {
	HttpSourceFetcher,
	isAllowedContentType,
	isPublicAddress,
} from "./source-fetch.js";
export { runSources } from "./source-runner.js";
export { discoverSource } from "./source-discovery.js";
export { discoverModels, isDiscoveryProtocolWired, modelDiscoveryMaxModels } from "./model-discovery.js";
export { geminiEndpoint, isGeminiModelId, requestGeminiText } from "./model-gemini.js";
export type { ModelDiscoveryInput } from "./model-discovery.js";
export { createModelCredentialCipher, parseModelCredentialKeyring } from "./model-credential-cipher.js";
export type { CredentialKeyring } from "./model-credential-cipher.js";

/** Derived from the allowlisted definitions so the two cannot drift. */
const SOURCE_HOSTS = [
	...new Set(
		Object.values(SOURCE_DEFINITIONS).flatMap((source) => source.allowedHosts),
	),
];

/** Collection stays disabled unless SOURCES_ENABLED=1 (Gate 0 in issue #41). */
export function createSourceService(
	storage: Storage,
	env: Record<string, string | undefined> = process.env,
): SourceService {
	return new SourceService(
		storage,
		new HttpSourceFetcher(SOURCE_HOSTS),
		{ enabled: env.SOURCES_ENABLED === "1" },
	);
}



export async function fromEnvironment(
	env: Record<string, string | undefined> = process.env,
) {
	const demo = env.DEMO_MODE === "1";
	if (!demo && !env.DATABASE_URL)
		throw new Error("DATABASE_URL required; memory storage is demo-only");
	const postgres = env.DATABASE_URL
		? PostgresStorage.connect(env.DATABASE_URL)
		: undefined;
	if (postgres) await postgres.initialize();
	const accounts: ChannelAccount[] = [];
	if (env.FEISHU_APP_ID) {
		const required = (key: string): string => {
			const value = env[key];
			if (!value) throw new Error(`missing ${key}`);
			return value;
		};
		accounts.push(
			createFeishuAccount({
				accountId: env.FEISHU_ACCOUNT_ID ?? "feishu-internal",
				appId: required("FEISHU_APP_ID"),
				appSecret: required("FEISHU_APP_SECRET"),
				tenantKey: required("FEISHU_TENANT_KEY"),
				verificationToken: required("FEISHU_VERIFICATION_TOKEN"),
				encryptKey: required("FEISHU_ENCRYPT_KEY"),
			}),
		);
	}
	if (demo)
		accounts.push({
			id: "demo",
			inbound: {
				async parse() {
					throw new WebhookError(
						405,
						"demo uses the authenticated console API",
					);
				},
			},
			outbound: {
				async send(delivery) {
					return { externalMessageId: `demo:${delivery.id}` };
				},
			},
		});
	const taskDraftModels = createTaskDraftModels(env);
	const storage = postgres ?? new MemoryStorage();
	const modelConnections = createModelConnections(storage, env);
	// 假设偏差初判：与任务草案共用同一套模型连接与限流；未配置模型时初判跳过。
	const hypothesisVerdicts = createHypothesisVerdictJobHandler(
		storage,
		(ownerId, systemPrompt, brief, maxTokens) =>
			taskDraftModels.completeJson(ownerId, systemPrompt, brief, undefined, maxTokens),
		(ownerId) => {
			const selection = taskDraftModels.list(ownerId).defaultSelection;
			return selection ? `${selection.provider}/${selection.model}` : null;
		},
	);
	return {
		...compose(storage, accounts, reviewPolicy, {
			decisionCardsEnabled: env.DECISION_CARDS_ENABLED === "1",
			...(env.PUBLIC_ORIGIN ? { detailUrlBase: env.PUBLIC_ORIGIN } : {}),
			hypothesisVerdicts,
		}),
		taskDraftModels,
		modelConnections,
		close: async () => {
			await postgres?.close();
		},
	};
}

/** Graceful polling loop shared by embedded and standalone workers. */
export async function runWorker(
	worker: Worker,
	signal: AbortSignal,
): Promise<void> {
	while (!signal.aborted) {
		try {
			if (await worker.runOnce()) continue;
		} catch {
			console.error("worker iteration failed; retrying");
		}
		await new Promise<void>((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", finish);
				resolve();
			};
			const timer = setTimeout(finish, 500);
			signal.addEventListener("abort", finish, { once: true });
			if (signal.aborted) finish();
		});
	}
}
