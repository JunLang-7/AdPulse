import {
	type ChannelAccount,
	ChannelRegistry,
	createFeishuAccount,
	WebhookError,
} from "@adpluse/channels";
import {
	Orchestrator,
	type PolicyEngine,
	type Storage,
	Worker,
} from "@adpluse/core";
import { MemoryStorage, PostgresStorage } from "@adpluse/storage";

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
) {
	const channels = new ChannelRegistry(accounts);
	const decisions = new Orchestrator(storage, policy);
	return {
		storage,
		channels,
		decisions,
		worker: new Worker(storage, decisions, channels.outbound()),
	};
}
export type Runtime = ReturnType<typeof compose>;

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
	if (!accounts.length) {
		await postgres?.close();
		throw new Error("no channel account configured");
	}
	return {
		...compose(postgres ?? new MemoryStorage(), accounts),
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
