import { describe, expect, test } from "bun:test";
import type { ClassifierModel, Model } from "@earendil-works/pi-ai";
import {
	apiFromPackage,
	buildProviderModels,
	costFromCatalog,
	costFromPayload,
	inputModalities,
	isZeroCost,
	stripVersionSuffix,
	type CatalogApi,
	type CatalogResult,
} from "../src/catalog.ts";
import type { ConsoleConfig, ConsoleModel, ConsoleProvider } from "../src/console.ts";
import {
	capabilityKey,
	type CatalogModel,
	type CatalogProvider,
	type PublicCatalog,
} from "../src/catalog-source.ts";

const OPENAI_COMPAT = "aisdk:@ai-sdk/openai-compatible";
const ANTHROPIC = "aisdk:@ai-sdk/anthropic";
const ZEN_BASE = "https://opencode.ai/inference/openai/v1";
const ANTHROPIC_BASE = "https://opencode.ai/inference/anthropic/v1";
const SYSTEMONE_BASE = "https://opencode.ai/inference/systemone/v1";

/** A chat entry shaped like OpenCode's catalog, with the Zen route unless overridden. */
function chat(entry: Partial<CatalogModel> = {}): CatalogModel {
	return {
		type: "chat",
		capabilities: { tools: { supported: true }, reasoning: { supported: false } },
		api: { "chat-completions": { base_url: ZEN_BASE, sdk: { aisdk: "@ai-sdk/openai-compatible" } } },
		...entry,
	};
}

function baseCatalog(
	models: Record<string, CatalogModel>,
	_provider: Partial<CatalogProvider> = {},
	providerId = "opencode",
): PublicCatalog {
	return {
		providers: new Map([[providerId, { models }]]),
		flags: new Map(),
	};
}

function overlayConfig(
	models: Record<string, ConsoleModel>,
	provider: Partial<ConsoleProvider> = {},
	providerId = "opencode",
): ConsoleConfig {
	return {
		providers: {
			[providerId]: { name: "Zen", package: OPENAI_COMPAT, settings: { baseURL: ZEN_BASE }, ...provider, models },
		},
	};
}

function chatAt(built: CatalogResult, index = 0): Model<CatalogApi> {
	return built.models[index] as Model<CatalogApi>;
}

function classifierAt(built: CatalogResult, index = 0): ClassifierModel<"typesafe-system-one"> {
	return built.models[index] as ClassifierModel<"typesafe-system-one">;
}

describe("package mapping", () => {
	test("maps both package spellings and rejects unknown ones", () => {
		expect(apiFromPackage("aisdk:@ai-sdk/openai-compatible")).toBe("openai-completions");
		expect(apiFromPackage("@ai-sdk/openai-compatible")).toBe("openai-completions");
		expect(apiFromPackage("@ai-sdk/openai")).toBe("openai-responses");
		expect(apiFromPackage("@ai-sdk/anthropic")).toBe("anthropic-messages");
		expect(apiFromPackage("@ai-sdk/google")).toBe("google-generative-ai");
		expect(apiFromPackage("@ai-sdk/mistral")).toBe("mistral-conversations");
		expect(apiFromPackage("@ai-sdk/typesafe-ai")).toBe("typesafe-system-one");
		expect(apiFromPackage("aisdk:@ai-sdk/vertex")).toBeUndefined();
		expect(apiFromPackage(undefined)).toBeUndefined();
	});

	test("drops the version segment the messages protocol adds itself", () => {
		expect(stripVersionSuffix("https://opencode.ai/inference/anthropic/v1")).toBe("https://opencode.ai/inference/anthropic");
		expect(stripVersionSuffix("https://opencode.ai/inference/anthropic")).toBe("https://opencode.ai/inference/anthropic");
	});
});

describe("catalog composition", () => {
	test("declares the reasoning_content requirement for DeepSeek models only", () => {
		const built = buildProviderModels(
			overlayConfig({}, {}, "opencode-go"),
			"opencode-go",
			baseCatalog(
				{
					"deepseek-v4-pro": chat({ name: "DeepSeek", family: "deepseek" }),
					"v4.1-flash": chat({ name: "DeepSeek by family", family: "deepseek-flash" }),
					"glm-5": chat({ name: "GLM", family: "glm" }),
				},
				{},
				"opencode-go",
			),
		);
		const byId = new Map(built.models.map((model) => [model.id, model]));
		expect((byId.get("deepseek-v4-pro") as Model<CatalogApi>).compat).toEqual({
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		});
		expect((byId.get("v4.1-flash") as Model<CatalogApi>).compat).toEqual({
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		});
		expect((byId.get("glm-5") as Model<CatalogApi>).compat).toBeUndefined();
	});

	test("keeps every base model when the overlay says nothing", () => {
		const built = buildProviderModels(
			overlayConfig({}),
			"opencode",
			baseCatalog({ alpha: chat({ name: "Alpha" }), beta: chat({ name: "Beta" }) }),
		);
		expect(built.models.map((model) => model.id)).toEqual(["alpha", "beta"]);
	});

	test("removes only the models the overlay disables", () => {
		const built = buildProviderModels(
			overlayConfig({ alpha: { disabled: true } }),
			"opencode",
			baseCatalog({ alpha: chat({ name: "Alpha" }), beta: chat({ name: "Beta" }) }),
		);
		expect(built.models.map((model) => model.id)).toEqual(["beta"]);
	});

	test("drops deprecated and tool-less base models", () => {
		const built = buildProviderModels(
			overlayConfig({}),
			"opencode",
			baseCatalog({
				live: chat({ name: "Live" }),
				old: chat({ name: "Old", status: "deprecated" }),
				noTools: chat({ name: "No tools", capabilities: { tools: { supported: false } } }),
			}),
		);
		expect(built.models.map((model) => model.id)).toEqual(["live"]);
	});

	test("publishes a decision model as a classifier, tool filter aside", () => {
		const built = buildProviderModels(
			overlayConfig({}),
			"opencode",
			baseCatalog({
				"jev-1.13-free": {
					type: "decision",
					name: "Jev 1.13 Free",
					status: undefined,
					modalities: { input: ["text", "image/png"], output: ["decision"] },
					capabilities: { tools: { supported: false }, reasoning: { supported: false } },
					limit: { context: 64000 },
					cost: { text: { input: { price: 0 }, output: { price: 0 } } },
					api: { systemone: { base_url: SYSTEMONE_BASE, sdk: { aisdk: "@ai-sdk/typesafe-ai" } } },
				},
			}),
		);
		const model = classifierAt(built);
		expect(model.type).toBe("classifier");
		expect(model.api).toBe("typesafe-system-one");
		expect(model.baseUrl).toBe(SYSTEMONE_BASE);
		expect(model.contextWindow).toBe(64000);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.cost.input).toBe(0);
		expect(built.routes.has("jev-1.13-free")).toBe(false);
	});

	test("does not publish an image model", () => {
		const built = buildProviderModels(
			overlayConfig({}),
			"opencode",
			baseCatalog({ painter: { type: "image", name: "Painter" } }),
		);
		expect(built.models).toEqual([]);
	});

	test("merges overlay metadata over the base entry", () => {
		const built = buildProviderModels(
			overlayConfig({
				model: {
					name: "Override",
					capabilities: { tools: true, input: ["text", "image"] },
					limit: { context: 2000 },
					cost: [
						{ input: 2, output: 3, cache: { read: 0.5, write: 0.25 } },
						{ tier: { type: "context", size: 500 }, input: 4, output: 5, cache: { read: 1 } },
					],
				},
			}),
			"opencode",
			baseCatalog({
				model: chat({
					name: "Base",
					modalities: { input: ["text"] },
					limit: { context: 1000, output: 100 },
					cost: { text: { input: { price: 1, cache: { read: 0.1 } }, output: { price: 1 } } },
				}),
			}),
		);
		const model = chatAt(built);
		expect(model.name).toBe("Override");
		expect(model.contextWindow).toBe(2000);
		expect(model.maxTokens).toBe(100);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.cost.input).toBe(2);
		expect(model.cost.cacheRead).toBe(0.5);
		expect(model.cost.cacheWrite).toBe(0.25);
		expect(model.cost.tiers).toEqual([
			{ inputTokensAbove: 500, input: 4, output: 5, cacheRead: 1, cacheWrite: 0 },
		]);
	});

	test("keeps base metadata when the overlay omits it", () => {
		const built = buildProviderModels(
			overlayConfig({ model: {} }),
			"opencode",
			baseCatalog({
				model: chat({
					name: "Base",
					modalities: { input: ["text", "image/png", "image/jpeg"] },
					limit: { context: 1000, output: 100 },
					cost: { text: { input: { price: 0 }, output: { price: 0 } } },
				}),
			}),
		);
		const model = chatAt(built);
		expect(model.name).toBe("Base");
		expect(model.contextWindow).toBe(1000);
		expect(model.maxTokens).toBe(100);
		expect(model.input).toEqual(["text", "image"]);
	});

	test("routes a model from its own catalog entry", () => {
		const built = buildProviderModels(
			{ providers: { opencode: { models: {} } } },
			"opencode",
			baseCatalog({
				claude: chat({
					name: "Claude",
					api: { messages: { base_url: ANTHROPIC_BASE, sdk: { aisdk: "@ai-sdk/anthropic" } } },
				}),
			}),
		);
		expect(chatAt(built).api).toBe("anthropic-messages");
		expect(chatAt(built).baseUrl).toBe("https://opencode.ai/inference/anthropic");
		expect(built.routes.get("claude")).toEqual({
			api: "anthropic-messages",
			baseUrl: "https://opencode.ai/inference/anthropic",
		});
	});

	test("lets the overlay override the package and address", () => {
		const built = buildProviderModels(
			overlayConfig({
				claude: { package: ANTHROPIC, settings: { baseURL: ANTHROPIC_BASE } },
			}),
			"opencode",
			baseCatalog({ claude: chat({ name: "Claude" }) }),
		);
		expect(chatAt(built).api).toBe("anthropic-messages");
		expect(chatAt(built).baseUrl).toBe("https://opencode.ai/inference/anthropic");
	});

	test("resolves a canonical provider from the base catalog", () => {
		const built = buildProviderModels(
			overlayConfig({}, { canonical: "opencode" }, "opencode-go"),
			"opencode-go",
			baseCatalog({ alpha: chat({ name: "Alpha" }), beta: chat({ name: "Beta" }) }),
		);
		expect(built.models.map((model) => model.id)).toEqual(["alpha", "beta"]);
		expect(built.models.every((model) => model.provider === "opencode-go")).toBe(true);
	});

	test("accepts an overlay-only model when the provider route applies", () => {
		const built = buildProviderModels(
			overlayConfig({ extra: { name: "Extra" } }),
			"opencode",
			baseCatalog({}),
		);
		expect(built.models.map((model) => model.id)).toEqual(["extra"]);
	});

	test("skips an overlay-only model with no route anywhere", () => {
		const built = buildProviderModels(
			{ providers: { opencode: { models: { extra: { name: "Extra" } } } } },
			"opencode",
			baseCatalog({}),
		);
		expect(built.models).toEqual([]);
	});

	test("drops a model whose base package pi cannot speak", () => {
		const built = buildProviderModels(
			{ providers: { opencode: { models: {} } } },
			"opencode",
			baseCatalog({
				exotic: chat({
					name: "Exotic",
					api: { "chat-completions": { base_url: ZEN_BASE, sdk: { aisdk: "@ai-sdk/vertex" } } },
				}),
				plain: chat({ name: "Plain" }),
			}),
		);
		expect(built.models.map((model) => model.id)).toEqual(["plain"]);
	});

	test("fills reasoning and the thinking level map from the catalog flags", () => {
		const catalog = baseCatalog({ reasoner: chat({ name: "Reasoner" }) });
		catalog.flags.set(capabilityKey("opencode", "reasoner"), {
			reasoning: true,
			thinkingLevelMap: { low: "low", high: "high", medium: null },
		});
		const built = buildProviderModels(overlayConfig({}), "opencode", catalog);
		expect(chatAt(built).reasoning).toBe(true);
		expect(chatAt(built).thinkingLevelMap).toEqual({ low: "low", high: "high", medium: null });
	});
});

describe("cost and modalities", () => {
	test("maps the console base rate and context tiers", () => {
		const cost = costFromPayload([
			{ input: 1, output: 2, cache: { read: 0.1, write: 1.25 } },
			{ tier: { type: "context", size: 200000 }, input: 2, output: 4, cache: { read: 0.2 } },
			{ tier: { type: "context", size: 100000 }, input: 1.5, output: 3 },
		]);
		expect(cost.input).toBe(1);
		expect(cost.output).toBe(2);
		expect(cost.cacheRead).toBe(0.1);
		expect(cost.cacheWrite).toBe(1.25);
		expect(cost.tiers).toEqual([
			{ inputTokensAbove: 100000, input: 1.5, output: 3, cacheRead: 0, cacheWrite: 0 },
			{ inputTokensAbove: 200000, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0 },
		]);
	});

	test("maps the catalog text rates", () => {
		expect(
			costFromCatalog({
				text: {
					input: { price: 2, cache: { read: 0.5, write: 0.25 } },
					output: { price: 6 },
				},
			}),
		).toEqual({ input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0.25 });
	});

	test("turns context overrides into cost tiers and keeps the base price", () => {
		const cost = costFromCatalog({
			text: {
				input: {
					price: 2,
					cache: { read: 0.5 },
					overrides: [{ when: { context: { gt: 200000 } }, price: 4, cache: { read: 1 } }],
				},
				output: { price: 6, overrides: [{ when: { context: { gt: 200000 } }, price: 12 }] },
			},
		});
		expect(cost).toEqual({
			input: 2,
			output: 6,
			cacheRead: 0.5,
			cacheWrite: 0,
			tiers: [{ inputTokensAbove: 200000, input: 4, output: 12, cacheRead: 1, cacheWrite: 0 }],
		});
	});

	test("treats missing prices as zero and zero prices as free", () => {
		expect(costFromPayload(undefined).input).toBe(0);
		expect(costFromCatalog(undefined).input).toBe(0);
		expect(costFromCatalog({ text: { input: { price: 0 }, output: { price: 0 } } }).output).toBe(0);
		expect(isZeroCost({ cost: { input: 0, output: 0 } })).toBe(true);
		expect(isZeroCost({ cost: { input: 0, output: 0.6 } })).toBe(false);
		expect(isZeroCost({})).toBe(true);
	});

	test("keeps only text and image inputs", () => {
		expect(inputModalities({ capabilities: { input: ["text", "video", "pdf"] } })).toEqual(["text"]);
		expect(inputModalities({ capabilities: { input: ["text", "image", "audio"] } })).toEqual(["text", "image"]);
	});
});
