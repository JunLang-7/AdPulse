import {
	createTaskDraftExtractor,
	createTaskDraftRequestLimit,
	getTaskDraftGateway,
	type TaskDraftExtractor,
	type TaskDraftStage,
} from "./task-draft-extractor.js";

export const taskDraftProviderIds = ["deepseek", "openai-compatible"] as const;
export type TaskDraftProviderId = (typeof taskDraftProviderIds)[number];

type ModelRoute = { id: TaskDraftProviderId; label: string; model: string };
const connectionLifetimeMs = 8 * 60 * 60 * 1000;
const maxConnections = 64;
const testBrief = "产品：连接测试";

export function createTaskDraftModels(
	env: Record<string, string | undefined>,
	fetchImpl: typeof fetch = fetch,
	now: () => number = Date.now,
) {
	const gateway = getTaskDraftGateway(env);
	const routes: ModelRoute[] = [{ id: "deepseek", label: "DeepSeek", model: "deepseek-flash" }];
	if (gateway) routes.push({ id: "openai-compatible", label: "兼容网关", model: gateway.modelId });
	const defaultId = env.TASK_DRAFT_PROVIDER?.trim() || "deepseek";
	const defaultProvider = routes.find(({ id }) => id === defaultId)?.id ?? null;
	const canConnect = env.TASK_DRAFT_USER_KEYS_ENABLED === "1";
	const limit = createTaskDraftRequestLimit();
	const shared = new Map<TaskDraftProviderId, TaskDraftExtractor>();
	for (const { id } of routes) {
		const extract = createTaskDraftExtractor({ ...env, TASK_DRAFT_PROVIDER: id }, fetchImpl, limit);
		if (extract) shared.set(id, extract);
	}
	const connections = new Map<string, { extract: TaskDraftExtractor; until: number; timer: NodeJS.Timeout }>();
	const pending = new Set<string>();
	const connectionKey = (ownerId: string, provider: TaskDraftProviderId) => JSON.stringify([ownerId, provider]);

	function remove(key: string) {
		const connection = connections.get(key);
		if (connection) clearTimeout(connection.timer);
		connections.delete(key);
	}

	function prune() {
		const time = now();
		for (const [key, connection] of connections) {
			if (connection.until <= time) remove(key);
		}
	}

	function list(ownerId: string) {
		prune();
		return {
			defaultProvider,
			canConnect,
			models: routes.map((route) => {
				const connection = connections.get(connectionKey(ownerId, route.id));
				return {
					...route,
					status: connection ? "connected" as const
						: shared.has(route.id) ? "configured" as const : "unconfigured" as const,
				};
			}),
		};
	}

	return {
		list,
		async connect(ownerId: string, provider: TaskDraftProviderId, secret: string) {
			if (!canConnect || !routes.some(({ id }) => id === provider)) return false;
			prune();
			const key = connectionKey(ownerId, provider);
			if (pending.has(key) || (!connections.has(key) && connections.size >= maxConnections)) return false;
			pending.add(key);
			try {
				const credential = provider === "deepseek" ? "DEEPSEEK_API_KEY" : "TASK_DRAFT_GATEWAY_API_KEY";
				const extract = createTaskDraftExtractor({ ...env, TASK_DRAFT_PROVIDER: provider, [credential]: secret }, fetchImpl, limit);
				if (!extract || await extract(testBrief, "overview") === null) return false;
				prune();
				if (!connections.has(key) && connections.size >= maxConnections) return false;
				remove(key);
				const timer = setTimeout(() => remove(key), connectionLifetimeMs).unref();
				connections.set(key, { extract, until: now() + connectionLifetimeMs, timer });
				return true;
			} finally {
				pending.delete(key);
			}
		},
		disconnect(ownerId: string, provider: TaskDraftProviderId) {
			const key = connectionKey(ownerId, provider);
			if (!canConnect || pending.has(key)) return false;
			remove(key);
			return true;
		},
		async extract(ownerId: string, provider: TaskDraftProviderId | undefined, brief: string, stage?: TaskDraftStage) {
			prune();
			const id = provider ?? defaultProvider;
			if (!id) return null;
			const extract = connections.get(connectionKey(ownerId, id))?.extract ?? shared.get(id);
			return extract ? extract(brief, stage) : null;
		},
	};
}
