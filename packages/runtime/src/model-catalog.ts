import { modelCatalogDocument } from "./model-catalog.generated.js";

/**
 * The provider/model directory is generated from the locked
 * `@earendil-works/pi-ai` package by `scripts/generate-model-catalog.mjs`.
 * Nothing here is hand-written per vendor: `supported` only means "AdPulse can
 * call this model through its personal API Key with the Chat Completions
 * adapter we have wired"; it is not a claim of live acceptance testing.
 */
export interface ModelCatalogModel {
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	provider: string;
	reasoning?: boolean;
	input?: readonly string[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
	compat?: Readonly<Record<string, unknown>>;
}

export interface ModelCatalogProvider {
	id: string;
	name: string;
	baseUrl: string | null;
	supported: boolean;
	/** Present only when `supported` is false. */
	reason?: string;
	protocols: readonly string[];
	models: readonly ModelCatalogModel[];
}

const providers = modelCatalogDocument.providers as unknown as readonly ModelCatalogProvider[];

export const modelCatalogProviders: readonly ModelCatalogProvider[] = providers;

/** Projection safe to send to the console: no cost tables, no protocols noise. */
export function catalogForClient() {
	return providers.map((provider) => ({
		id: provider.id,
		name: provider.name,
		baseUrl: provider.baseUrl,
		supported: provider.supported,
		...(provider.reason === undefined ? {} : { reason: provider.reason }),
		models: provider.models.map((model) => ({ id: model.id, name: model.name })),
	}));
}

export function findCatalogProvider(providerId: string): ModelCatalogProvider | undefined {
	return providers.find((provider) => provider.id === providerId);
}

/** Only models of a supported provider are callable. */
export function findCatalogModel(providerId: string, modelId: string): ModelCatalogModel | undefined {
	const provider = findCatalogProvider(providerId);
	return provider?.supported
		? provider.models.find((model) => model.id === modelId)
		: undefined;
}

export function catalogModelLabel(providerId: string, modelId: string): string | undefined {
	const provider = findCatalogProvider(providerId);
	const model = provider?.models.find((candidate) => candidate.id === modelId);
	return model?.name ?? model?.id;
}
