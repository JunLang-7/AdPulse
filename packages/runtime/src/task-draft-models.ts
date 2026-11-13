import { createModelEgressFetch } from "./model-egress.js";
import { catalogForClient, catalogModelLabel, findCatalogModel, findCatalogProvider } from "./model-catalog.js";
import {
	createCatalogTaskDraftExtractor,
	createTaskDraftExtractor,
	createTaskDraftRequestLimit,
	getTaskDraftGateway,
	type TaskDraftExtractor,
	type TaskDraftStage,
} from "./task-draft-extractor.js";

export interface TaskDraftSelection {
	provider: string;
	model: string;
}

type StoredConnection = {
	ownerId: string;
	selection: TaskDraftSelection;
	label: string;
	extract: TaskDraftExtractor;
	until: number;
	timer: NodeJS.Timeout;
	connectedAt: number;
};

type SharedRoute = {
	selection: TaskDraftSelection;
	label: string;
	extract: TaskDraftExtractor;
};

const connectionLifetimeMs = 8 * 60 * 60 * 1000;
const maxConnections = 64;
const testBrief = "产品：连接测试";

/** Deployment-managed routes. Kept for the existing explicit selection only. */
function sharedRoutes(env: Record<string, string | undefined>, fetchImpl: typeof fetch, limit: ReturnType<typeof createTaskDraftRequestLimit>): SharedRoute[] {
	const routes: SharedRoute[] = [];
	const deepseek = createTaskDraftExtractor({ ...env, TASK_DRAFT_PROVIDER: "deepseek" }, fetchImpl, limit);
	if (deepseek) routes.push({ selection: { provider: "deepseek", model: "deepseek-flash" }, label: "DeepSeek（部署提供）", extract: deepseek });
	const gateway = getTaskDraftGateway(env);
	if (gateway) {
		const extract = createTaskDraftExtractor({ ...env, TASK_DRAFT_PROVIDER: "openai-compatible" }, fetchImpl, limit);
		if (extract) routes.push({ selection: { provider: "openai-compatible", model: gateway.modelId }, label: "兼容网关（部署提供）", extract });
	}
	return routes;
}

export function createTaskDraftModels(
	env: Record<string, string | undefined>,
	fetchImpl: typeof fetch = createModelEgressFetch(),
	now: () => number = Date.now,
) {
	const canConnect = env.TASK_DRAFT_USER_KEYS_ENABLED === "1";
	const limit = createTaskDraftRequestLimit();
	const shared = sharedRoutes(env, fetchImpl, limit);
	const sharedSelection = shared[0]?.selection ?? null;
	const connections = new Map<string, StoredConnection>();
	const pending = new Set<string>();
	const connectionKey = (ownerId: string, { provider, model }: TaskDraftSelection) =>
		JSON.stringify([ownerId, provider, model]);

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

	function labelFor(selection: TaskDraftSelection): string {
		const sharedRoute = shared.find((route) => route.selection.provider === selection.provider && route.selection.model === selection.model);
		if (sharedRoute) return sharedRoute.label;
		const provider = findCatalogProvider(selection.provider)?.name ?? selection.provider;
		const model = catalogModelLabel(selection.provider, selection.model) ?? selection.model;
		return `${provider} · ${model}`;
	}

	function ownConnections(ownerId: string) {
		prune();
		return [...connections.values()]
			.filter((connection) => connection.ownerId === ownerId)
			.map((connection) => ({
				provider: connection.selection.provider,
				model: connection.selection.model,
				label: connection.label,
				connectedAt: new Date(connection.connectedAt).toISOString(),
			}))
			.sort((left, right) => right.connectedAt.localeCompare(left.connectedAt));
	}

	/** Most recent personal connection wins; otherwise the deployment default. */
	function defaultSelection(ownerId: string): TaskDraftSelection | null {
		const [latest] = ownConnections(ownerId);
		if (latest) return { provider: latest.provider, model: latest.model };
		return sharedSelection;
	}

	function createExtractor(selection: TaskDraftSelection, apiKey: string) {
		return createCatalogTaskDraftExtractor(selection.provider, selection.model, apiKey, fetchImpl, limit);
	}

	return {
		list(ownerId: string) {
			return {
				canConnect,
				defaultSelection: defaultSelection(ownerId),
				providers: catalogForClient(),
				shared: shared.map(({ selection, label }) => ({ ...selection, label })),
				connections: ownConnections(ownerId),
			};
		},
		/** Tests a candidate key without storing or selecting anything. */
		async test(selection: TaskDraftSelection, secret: string) {
			if (!canConnect || !findCatalogModel(selection.provider, selection.model)) return false;
			const extract = createExtractor(selection, secret);
			if (!extract) return false;
			return await extract(testBrief, "overview") !== null;
		},
		async connect(ownerId: string, selection: TaskDraftSelection, secret: string) {
			if (!canConnect || !findCatalogModel(selection.provider, selection.model)) return false;
			prune();
			const key = connectionKey(ownerId, selection);
			if (pending.has(key) || (!connections.has(key) && connections.size >= maxConnections)) return false;
			pending.add(key);
			try {
				const extract = createExtractor(selection, secret);
				if (!extract || await extract(testBrief, "overview") === null) return false;
				prune();
				if (!connections.has(key) && connections.size >= maxConnections) return false;
				remove(key);
				const timer = setTimeout(() => remove(key), connectionLifetimeMs).unref();
				connections.set(key, {
					ownerId, selection, label: labelFor(selection), extract,
					until: now() + connectionLifetimeMs, timer, connectedAt: now(),
				});
				return true;
			} finally {
				pending.delete(key);
			}
		},
		disconnect(ownerId: string, selection: TaskDraftSelection) {
			const key = connectionKey(ownerId, selection);
			if (!canConnect || pending.has(key)) return false;
			remove(key);
			return true;
		},
		async extractLegacy(ownerId: string, provider: string, brief: string, stage?: TaskDraftStage) {
			const matching = ownConnections(ownerId).filter((item) => item.provider === provider);
			const [route] = matching;
			if (matching.length !== 1 || !route) return null;
			return connections.get(connectionKey(ownerId, route))?.extract(brief, stage) ?? null;
		},
		extractShared(selection: TaskDraftSelection, brief: string, stage?: TaskDraftStage) {
			const route = shared.find(({ selection: item }) =>
				item.provider === selection.provider && item.model === selection.model);
			return route?.extract(brief, stage);
		},
		async extract(ownerId: string, selection: TaskDraftSelection | undefined, brief: string, stage?: TaskDraftStage) {
			prune();
			const chosen = selection ?? defaultSelection(ownerId);
			if (!chosen) return null;
			const connection = connections.get(connectionKey(ownerId, chosen));
			if (connection) return connection.extract(brief, stage);
			const sharedRoute = shared.find((route) =>
				route.selection.provider === chosen.provider && route.selection.model === chosen.model);
			return sharedRoute ? sharedRoute.extract(brief, stage) : null;
		},
	};
}
