// Compose pi models from OpenCode's catalog and the console overlay.
//
// The catalog supplies the base list, per-model routing and most metadata. The
// console V2 config only overrides what the workspace changed: disabled models,
// a different package or base URL, limits, prices, capabilities. A model the
// overlay does not mention stays in the list. This is the same two-layer model
// the OpenCode client uses.

import type { ClassifierModel, Model, ModelCostTier } from "@earendil-works/pi-ai";
import type { ConsoleConfig, ConsoleModel, ConsoleProvider, CostTierPayload } from "./console.ts";
import {
	capabilityKey,
	type CatalogCost,
	type CatalogModel,
	type PublicCatalog,
} from "./catalog-source.ts";

export const ZEN_PROVIDER_ID = "opencode";
export const GO_PROVIDER_ID = "opencode-go";
export const PROVIDER_IDS = [ZEN_PROVIDER_ID, GO_PROVIDER_ID] as const;

/** Wire protocols pi carries as chat models. */
export type CatalogApi =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai"
	| "mistral-conversations";

/** The one protocol pi carries as a classifier model. */
export const CLASSIFIER_API = "typesafe-system-one";
export type ClassifierApi = typeof CLASSIFIER_API;

/** Every model this extension can publish. */
export type CatalogModelEntry = Model<CatalogApi> | ClassifierModel<ClassifierApi>;

/**
 * Stamped onto every model this extension produces. pi persists model objects
 * verbatim, so the mark survives a restart and lets the failure path tell an
 * extension entry apart from the one pi's built-in provider wrote for the same
 * provider id.
 */
export const CATALOG_MODEL_MARK = "piOpencodeCatalog";

/** AI SDK package -> pi wire protocol. Unknown packages are not routable. */
const PACKAGE_API: Readonly<Record<string, CatalogApi | ClassifierApi>> = {
	"@ai-sdk/openai-compatible": "openai-completions",
	"@ai-sdk/openai": "openai-responses",
	"@ai-sdk/anthropic": "anthropic-messages",
	"@ai-sdk/google": "google-generative-ai",
	"@ai-sdk/mistral": "mistral-conversations",
	"@ai-sdk/typesafe-ai": CLASSIFIER_API,
};

export function apiFromPackage(pkg: string | undefined): CatalogApi | ClassifierApi | undefined {
	if (!pkg) return undefined;
	return PACKAGE_API[pkg.replace(/^aisdk:/, "")];
}

/**
 * The console hands out `…/anthropic/v1`; the messages protocol appends its own
 * version segment, so the trailing one has to go or every call 404s.
 */
export function stripVersionSuffix(baseUrl: string): string {
	return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
}

function rate(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function costOf(input: number, output: number, cacheRead: number, cacheWrite: number): Model<CatalogApi>["cost"] {
	return {
		input: rate(input),
		output: rate(output),
		cacheRead: rate(cacheRead),
		cacheWrite: rate(cacheWrite),
	};
}

/** Console overlay prices: a list with one base entry and optional context tiers. */
export function costFromPayload(payload: CostTierPayload[] | undefined): Model<CatalogApi>["cost"] {
	const tiers = Array.isArray(payload) ? payload : [];
	const base = tiers.find((tier) => tier && (tier.tier?.size === undefined || tier.tier?.type !== "context"));
	const rest = tiers.filter((tier) => tier !== base && tier?.tier?.size !== undefined);
	const cost = costOf(rate(base?.input), rate(base?.output), rate(base?.cache?.read), rate(base?.cache?.write));
	const mapped: ModelCostTier[] = [];
	for (const tier of rest) {
		const size = tier.tier?.size;
		if (typeof size !== "number") continue;
		mapped.push({
			inputTokensAbove: size,
			...costOf(rate(tier.input), rate(tier.output), rate(tier.cache?.read), rate(tier.cache?.write)),
		});
	}
	if (mapped.length > 0) cost.tiers = mapped.sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
	return cost;
}

/**
 * Catalog prices: per-million text rates, cache rates nested under the input
 * price, and context overrides that become pi cost tiers. An override merges
 * field by field, so a tier keeps every base price it does not set.
 */
export function costFromCatalog(payload: CatalogCost | undefined): Model<CatalogApi>["cost"] {
	const input = payload?.text?.input;
	const output = payload?.text?.output;
	const cost = costOf(rate(input?.price), rate(output?.price), rate(input?.cache?.read), rate(input?.cache?.write));
	const tiers = new Map<number, ModelCostTier>();
	const entry = (size: number): ModelCostTier => {
		const existing = tiers.get(size);
		if (existing) return existing;
		const created: ModelCostTier = {
			inputTokensAbove: size,
			input: rate(input?.price),
			output: rate(output?.price),
			cacheRead: rate(input?.cache?.read),
			cacheWrite: rate(input?.cache?.write),
		};
		tiers.set(size, created);
		return created;
	};
	for (const override of input?.overrides ?? []) {
		const size = override?.when?.context?.gt ?? override?.when?.context?.gte;
		if (typeof size !== "number") continue;
		const tier = entry(size);
		if (typeof override.price === "number") tier.input = override.price;
		if (typeof override.cache?.read === "number") tier.cacheRead = override.cache.read;
		if (typeof override.cache?.write === "number") tier.cacheWrite = override.cache.write;
	}
	for (const override of output?.overrides ?? []) {
		const size = override?.when?.context?.gt ?? override?.when?.context?.gte;
		if (typeof size !== "number") continue;
		const tier = entry(size);
		if (typeof override.price === "number") tier.output = override.price;
	}
	if (tiers.size > 0) cost.tiers = [...tiers.values()].sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
	return cost;
}

/** pi only accepts text and image inputs; both catalogs list more modalities. */
export function inputModalities(model: ConsoleModel): ("text" | "image")[] {
	return model.capabilities?.input?.includes("image") ? ["text", "image"] : ["text"];
}

function baseInputModalities(model: CatalogModel | undefined): ("text" | "image")[] {
	const listed = model?.modalities?.input ?? [];
	return listed.some((entry) => entry.startsWith("image/")) ? ["text", "image"] : ["text"];
}

export function isZeroCost(model: { cost?: { input?: number; output?: number } }): boolean {
	const input = model.cost?.input ?? 0;
	const output = model.cost?.output ?? 0;
	return input <= 0 && output <= 0;
}

interface Route {
	api: CatalogApi;
	baseUrl: string;
}

/** The catalog lists one route per model. */
function routeOf(model: CatalogModel | undefined): { package?: string; baseUrl?: string } {
	const entry = Object.values(model?.api ?? {})[0];
	return { package: entry?.sdk?.aisdk, baseUrl: entry?.base_url };
}

/**
 * DeepSeek's thinking mode rejects a replayed turn whose assistant message carries
 * no reasoning_content. pi fills that field only when the base URL names DeepSeek,
 * and the OpenCode gateway does not, so the model entry declares the requirement.
 */
function reasoningContentCompat(modelId: string, family: string | undefined): Model<CatalogApi>["compat"] {
	const isDeepSeek = family?.toLowerCase().startsWith("deepseek") === true || modelId.toLowerCase().includes("deepseek");
	return isDeepSeek
		? { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" }
		: undefined;
}

export interface CatalogResult {
	models: CatalogModelEntry[];
	/** model id -> route, so a cached model's route can be re-derived on read. */
	routes: Map<string, Route>;
}

/**
 * Build the models a provider offers. The catalog decides which models exist;
 * the console overlay can disable one or override its route and metadata.
 *
 * `chat` entries become pi chat models and carry the tool requirement. `decision`
 * entries become pi classifier models, callable through `classify()` only. Other
 * types, currently `image`, are not published because pi would need an image
 * endpoint this extension does not route.
 */
export function buildProviderModels(
	config: ConsoleConfig,
	providerId: string,
	catalog: PublicCatalog,
): CatalogResult {
	const models: CatalogModelEntry[] = [];
	const routes = new Map<string, Route>();
	const overlay = config.providers?.[providerId];
	const base = catalog.providers.get(overlay?.canonical ?? providerId);
	if (!overlay && !base) return { models, routes };

	const ids = new Set([...Object.keys(base?.models ?? {}), ...Object.keys(overlay?.models ?? {})]);
	for (const modelId of [...ids].sort()) {
		const baseModel = base?.models[modelId];
		const override = overlay?.models?.[modelId];
		if (baseModel?.status === "deprecated") continue;
		if (override?.disabled === true) continue;
		const kind = baseModel?.type ?? "chat";
		if (kind !== "chat" && kind !== "decision") continue;

		// Field-level precedence: overlay beats catalog, model beats provider. The
		// catalog route is per model, so it outranks the provider-level overlay.
		const fromCatalog = routeOf(baseModel);
		const pkg = override?.package ?? fromCatalog.package ?? overlay?.package;
		const baseUrl = override?.settings?.baseURL ?? fromCatalog.baseUrl ?? overlay?.settings?.baseURL;
		const api = apiFromPackage(pkg);
		if (!api || !baseUrl) continue;

		const flags = catalog.flags.get(capabilityKey(providerId, modelId));
		const mark = { [CATALOG_MODEL_MARK]: true } as Record<string, unknown>;
		const name = override?.name ?? baseModel?.name ?? modelId;
		const cost = override?.cost ? costFromPayload(override.cost) : costFromCatalog(baseModel?.cost);
		const contextWindow = override?.limit?.context ?? baseModel?.limit?.context ?? 128000;

		if (kind === "decision") {
			if (api !== CLASSIFIER_API) continue;
			models.push({
				id: modelId,
				name,
				type: "classifier",
				api: CLASSIFIER_API,
				provider: providerId,
				baseUrl,
				input: baseInputModalities(baseModel),
				cost,
				contextWindow,
				...mark,
			} as ClassifierModel<ClassifierApi>);
			continue;
		}

		const tools = override?.capabilities?.tools ?? baseModel?.capabilities?.tools?.supported ?? true;
		if (tools === false) continue;
		if (api === CLASSIFIER_API) continue;
		const compat = reasoningContentCompat(modelId, baseModel?.family);
		const chatBaseUrl = api === "anthropic-messages" ? stripVersionSuffix(baseUrl) : baseUrl;
		routes.set(modelId, { api, baseUrl: chatBaseUrl });
		models.push({
			id: modelId,
			name,
			api,
			provider: providerId,
			baseUrl: chatBaseUrl,
			reasoning: flags?.reasoning ?? baseModel?.capabilities?.reasoning?.supported === true,
			...(flags?.thinkingLevelMap ? { thinkingLevelMap: flags.thinkingLevelMap } : {}),
			input: override?.capabilities?.input ? inputModalities(override) : baseInputModalities(baseModel),
			cost,
			contextWindow,
			maxTokens: override?.limit?.output ?? baseModel?.limit?.output ?? 32000,
			...(compat ? { compat } : {}),
			...mark,
		} as Model<CatalogApi>);
	}
	return { models, routes };
}
