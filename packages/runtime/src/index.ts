import {
	type ChannelAccount,
	ChannelRegistry,
	createFeishuAccount,
	WebhookError,
} from "@adpluse/channels";
import {
	ComparisonService,
	EvidenceService,
	DigestScheduler,
	InvestigationAlertService,
	NotificationQueue,
	NotificationService,
	Orchestrator,
	DecisionDeliveryService,
	SubscriptionService,
	resolveActiveIdentity,
	SOURCE_DEFINITIONS,
	SourceService,
	TaskService,
	type PolicyEngine,
	type Storage,
	Worker,
} from "@adpluse/core";
import { MemoryStorage, PostgresStorage } from "@adpluse/storage";
import { HttpSourceFetcher } from "./source-fetch.js";

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
	options: { detailUrlBase?: string } = {},
) {
	const channels = new ChannelRegistry(accounts);
	// 站内详情链接只在 HTTPS 控制台 origin 下生成：卡片渲染强制 https，
	// 本地 http 开发环境保持无链接，避免渲染期抛错导致投递失败。
	const detailBase =
		options.detailUrlBase && options.detailUrlBase.startsWith("https://")
			? options.detailUrlBase.replace(/\/+$/, "")
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
	);
	const tasks = new TaskService(storage);
	const evidence = new EvidenceService(storage);
	const comparisons = new ComparisonService(storage);
	const investigationAlerts = new InvestigationAlertService(storage);
	const notifications = new NotificationService(storage);
	const subscriptions = new SubscriptionService(storage);
	const notificationQueue = new NotificationQueue(storage);
	const digestScheduler = new DigestScheduler(storage, subscriptions, notificationQueue);
	// 目的地平台 → 渠道账号：只匹配声明了同一身份作用域的连接，避免把飞书消息发到别的账号。
	const platformAccounts = new Map<string, string>();
	for (const account of accounts)
		if (account.identityScope)
			platformAccounts.set(account.identityScope.platform, account.id);
	const decisionDelivery = new DecisionDeliveryService(
		storage,
		decisions,
		notifications,
		(platform: string) => platformAccounts.get(platform),
	);
	return {
		storage,
		channels,
		decisions,
		tasks,
		evidence,
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
				accountIdForPlatform: (platform: string) => platformAccounts.get(platform),
				...(detailBase ? { detailBase } : {}),
			},
			decisionDelivery,
		),
	};
}
export type Runtime = ReturnType<typeof compose>;

export {
	HttpSourceFetcher,
	isAllowedContentType,
	isPublicAddress,
} from "./source-fetch.js";
export { runSources } from "./source-runner.js";

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
	return {
		...compose(postgres ?? new MemoryStorage(), accounts, reviewPolicy, {
			...(env.PUBLIC_ORIGIN ? { detailUrlBase: env.PUBLIC_ORIGIN } : {}),
		}),
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
