// OpenCode's own catalog is the base model list.
//
// The endpoint is the one the OpenCode client reads. The console V2 config is
// only an overlay on top of it: an entry there can disable a model or override
// its metadata, but a model the overlay does not mention still exists.
//
// Mirrors are handled the way the client handles them: the v2 path is tried
// first, `/api.json` is used only when the origin is not the default one and
// answers 404, and a v1 payload is converted to the v2 shape before decoding.

import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { USER_AGENT } from "./console.ts";

export const DEFAULT_CATALOG_ORIGIN = "https://models.opencode.ai";
/** The v2 path, restricted to the model types pi can carry. */
export const CATALOG_PATH = "/experimental/v2.0/api.json?type=chat,decision,image";
/** The v1 path, still served by custom mirrors. */
export const LEGACY_CATALOG_PATH = "/api.json";
export const CATALOG_URL = `${DEFAULT_CATALOG_ORIGIN}${CATALOG_PATH}`;

/** pi thinking levels a catalog effort value can be mapped from. */
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** The AI SDK packages that call the Responses API unless told otherwise. */
const RESPONSES_BY_DEFAULT = new Set(["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/xai"]);

export interface CapabilityFlags {
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

export interface CatalogCostOverride {
	when?: { context?: { gt?: number; gte?: number } };
	price?: number;
	cache?: { read?: number; write?: number };
}

export interface CatalogPrice {
	price?: number;
	cache?: { read?: number; write?: number };
	overrides?: CatalogCostOverride[];
}

export interface CatalogCost {
	text?: {
		input?: CatalogPrice;
		output?: { price?: number; overrides?: CatalogCostOverride[] };
	};
}

/** One wire route. `sdk.aisdk` names the package, `base_url` the endpoint. */
export interface CatalogApiRoute {
	base_url?: string;
	sdk?: { aisdk?: string };
	compatibility?: { reasoning_field?: string };
}

export interface CatalogModel {
	id?: string;
	name?: string;
	family?: string;
	/** `chat`, `decision` or `image`. Anything else is not routable to pi. */
	type?: string;
	status?: string;
	modalities?: { input?: string[]; output?: string[] };
	capabilities?: {
		tools?: { supported?: boolean };
		reasoning?: { supported?: boolean; effort?: string[]; toggle?: boolean };
	};
	limit?: { context?: number; output?: number };
	cost?: CatalogCost;
	api?: Record<string, CatalogApiRoute>;
}

export interface CatalogProvider {
	models: Record<string, CatalogModel>;
}

export interface PublicCatalog {
	providers: Map<string, CatalogProvider>;
	flags: Map<string, CapabilityFlags>;
}

export function capabilityKey(providerId: string, modelId: string): string {
	return `${providerId}/${modelId}`;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** The origin the catalog is read from. A mirror can be pointed at with `OPENCODE_MODELS_URL`. */
export function catalogOrigin(env: Record<string, string | undefined> = process.env): string {
	const configured = env.OPENCODE_MODELS_URL;
	return (configured && configured.trim() ? configured.trim() : DEFAULT_CATALOG_ORIGIN).replace(/\/+$/, "");
}

/**
 * Map a model's effort values onto pi's thinking levels. Levels the model does
 * not accept become null so pi clamps to a supported neighbour; an empty list
 * leaves the map unset so pi falls back to its provider defaults.
 */
export function thinkingLevelMapFrom(effort: unknown): ThinkingLevelMap | undefined {
	const values = Array.isArray(effort) ? effort.filter((entry): entry is string => typeof entry === "string") : [];
	if (values.length === 0) return undefined;
	const map: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) map[level] = values.includes(level) ? level : null;
	return map;
}

// ---------------------------------------------------------------------------
// v1 catalogs. Their last remaining source is a custom mirror, as in the client.

interface V1ReasoningOption {
	type?: string;
	values?: (string | null)[];
	min?: number;
	max?: number;
}

interface V1Cost {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_write?: number;
	tiers?: { tier?: { size?: number }; input?: number; output?: number; cache_read?: number; cache_write?: number }[];
}

interface V1Model {
	id?: string;
	name?: string;
	type?: string;
	family?: string;
	release_date?: string;
	status?: string;
	reasoning?: boolean;
	reasoning_options?: V1ReasoningOption[];
	temperature?: boolean;
	tool_call?: boolean;
	interleaved?: boolean | string | { field?: string };
	cost?: V1Cost;
	limit?: Record<string, number>;
	modalities?: { input?: string[]; output?: string[] };
	provider?: { npm?: string; api?: string; shape?: string };
}

/** v1 providers always name an AI SDK package; v2 providers never do. */
export function isV1(payload: unknown): boolean {
	return Object.values(record(payload)).some((provider) => typeof record(provider).npm === "string");
}

interface V2Reasoning {
	supported: boolean;
	toggle?: boolean;
	effort?: string[];
}

function v1Reasoning(model: V1Model): V2Reasoning {
	if (model.reasoning !== true) return { supported: false };
	const options = list(model.reasoning_options) as V1ReasoningOption[];
	const effort = options.find((option) => option?.type === "effort");
	const values = list(effort?.values).filter((value): value is string => typeof value === "string" && value !== "null");
	return {
		supported: true,
		...(options.some((option) => option?.type === "toggle") ? { toggle: true } : {}),
		...(values.length > 0 ? { effort: values } : {}),
	};
}

function numberAt(source: Record<string, unknown>, key: string): number | undefined {
	const value = source[key];
	return typeof value === "number" ? value : undefined;
}

function v1Cost(cost: V1Cost | undefined): CatalogCost | undefined {
	if (!cost) return undefined;
	const tiers = list(cost.tiers).map(record);
	const overrides = tiers.flatMap((tier) => {
		const size = record(tier.tier).size;
		if (typeof size !== "number") return [];
		return [
			{
				when: { context: { gt: size } },
				price: numberAt(tier, "input"),
				cache: { read: numberAt(tier, "cache_read"), write: numberAt(tier, "cache_write") },
			},
		];
	});
	const outputOverrides = tiers.flatMap((tier) => {
		const size = record(tier.tier).size;
		if (typeof size !== "number") return [];
		return [{ when: { context: { gt: size } }, price: numberAt(tier, "output") }];
	});
	return {
		text: {
			input: {
				price: cost.input ?? 0,
				cache: { read: cost.cache_read, write: cost.cache_write },
				...(overrides.length > 0 ? { overrides } : {}),
			},
			output: { price: cost.output ?? 0, ...(outputOverrides.length > 0 ? { overrides: outputOverrides } : {}) },
		},
	};
}

function fromV1(payload: unknown): Record<string, unknown> {
	const converted: Record<string, unknown> = {};
	for (const [key, rawProvider] of Object.entries(record(payload))) {
		const provider = record(rawProvider) as { npm?: string; api?: string; models?: Record<string, V1Model> };
		const providerNpm = typeof provider.npm === "string" ? provider.npm : undefined;
		const providerApi = typeof provider.api === "string" ? provider.api : undefined;
		const models: Record<string, CatalogModel> = {};
		for (const [id, rawModel] of Object.entries(record(provider.models))) {
			const model = record(rawModel) as V1Model;
			const npm = model.provider?.npm ?? providerNpm;
			const shape = model.provider?.shape;
			const protocol = shape === "responses" || (shape === undefined && npm !== undefined && RESPONSES_BY_DEFAULT.has(npm))
				? "responses"
				: "chat-completions";
			const field =
				typeof model.interleaved === "string"
					? model.interleaved
					: typeof model.interleaved === "object" && model.interleaved !== null
						? model.interleaved.field
						: undefined;
			models[id] = {
				id: model.id ?? id,
				type: model.type ?? "chat",
				name: model.name ?? id,
				...(model.family ? { family: model.family } : {}),
				...(model.status ? { status: model.status } : {}),
				modalities: {
					input: list(model.modalities?.input) as string[],
					output: list(model.modalities?.output) as string[],
				},
				capabilities: {
					tools: { supported: model.tool_call ?? false },
					reasoning: v1Reasoning(model),
				},
				...(model.limit ? { limit: model.limit } : {}),
				...((() => {
					const converted = v1Cost(model.cost);
					return converted ? { cost: converted } : {};
				})()),
				api: {
					[protocol]: {
						base_url: model.provider?.api ?? providerApi ?? "",
						...(npm ? { sdk: { aisdk: npm } } : {}),
						...(field ? { compatibility: { reasoning_field: field } } : {}),
					},
				},
			};
		}
		converted[key] = { models };
	}
	return converted;
}

// ---------------------------------------------------------------------------

/** Parse the whole catalog, keeping both the base models and their flags. */
export function catalogFromPayload(payload: unknown): PublicCatalog {
	const source = isV1(payload) ? fromV1(payload) : record(payload);
	const providers = new Map<string, CatalogProvider>();
	const flags = new Map<string, CapabilityFlags>();
	for (const [providerId, rawProvider] of Object.entries(source)) {
		const provider = record(rawProvider);
		const models: Record<string, CatalogModel> = {};
		for (const [modelId, rawModel] of Object.entries(record(provider.models))) {
			const model = rawModel as CatalogModel;
			models[modelId] = model;
			const capability: CapabilityFlags = { reasoning: model.capabilities?.reasoning?.supported === true };
			const thinking = thinkingLevelMapFrom(model.capabilities?.reasoning?.effort);
			if (thinking) capability.thinkingLevelMap = thinking;
			flags.set(capabilityKey(providerId, modelId), capability);
		}
		providers.set(providerId, { models });
	}
	return { providers, flags };
}

interface CatalogCache {
	etag?: string;
	catalog: PublicCatalog;
}

let cache: CatalogCache | undefined;

export function resetCatalogCacheForTests(): void {
	cache = undefined;
}

export function cachedCatalog(): PublicCatalog | undefined {
	return cache?.catalog;
}

/**
 * Fetch the catalog. A conditional request keeps the payload off the wire when
 * nothing changed; a failure falls back to the in-memory copy when one exists,
 * and otherwise fails so the caller keeps its persisted models instead of
 * writing an empty list.
 *
 * A mirror that predates the v2 path answers 404 there; only then is `/api.json`
 * tried, which is what the client does for any origin but its own.
 */
export async function loadCatalog(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<PublicCatalog> {
	try {
		const origin = catalogOrigin();
		const headers: Record<string, string> = { "User-Agent": USER_AGENT };
		if (cache?.etag) headers["If-None-Match"] = cache.etag;
		const response = await fetchImpl(`${origin}${CATALOG_PATH}`, { headers, signal });
		if (response.status === 304 && cache) return cache.catalog;
		let body: Response = response;
		if (!response.ok) {
			const isMirror = origin !== DEFAULT_CATALOG_ORIGIN;
			if (!(isMirror && response.status === 404)) throw new Error(`catalog answered HTTP ${response.status}`);
			body = await fetchImpl(`${origin}${LEGACY_CATALOG_PATH}`, { headers: { "User-Agent": USER_AGENT }, signal });
			if (!body.ok) throw new Error(`catalog answered HTTP ${body.status}`);
		}
		const catalog = catalogFromPayload(await body.json());
		cache = { etag: response.headers.get("etag") ?? undefined, catalog };
		return catalog;
	} catch (error) {
		if (cache) return cache.catalog;
		throw error;
	}
}
