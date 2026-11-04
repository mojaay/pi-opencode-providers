import { beforeEach, describe, expect, test } from "bun:test";
import {
	CATALOG_URL,
	catalogFromPayload,
	catalogOrigin,
	capabilityKey,
	isV1,
	loadCatalog,
	resetCatalogCacheForTests,
	thinkingLevelMapFrom,
} from "../src/catalog-source.ts";

const payload = {
	opencode: {
		models: {
			reasoner: {
				type: "chat",
				name: "Reasoner",
				capabilities: { tools: { supported: true }, reasoning: { supported: true, effort: ["low", "high", "max"] } },
				modalities: { input: ["text", "image/png"], output: ["text"] },
				limit: { context: 200000, output: 32000 },
				cost: { text: { input: { price: 0 }, output: { price: 0 } } },
				api: {
					"chat-completions": {
						base_url: "https://opencode.ai/inference/openai/v1",
						sdk: { aisdk: "@ai-sdk/openai-compatible" },
					},
				},
			},
			plain: {
				type: "chat",
				name: "Plain",
				capabilities: { tools: { supported: true }, reasoning: { supported: false } },
			},
			"jev-1.13-free": {
				type: "decision",
				name: "Jev 1.13 Free",
				capabilities: { tools: { supported: false }, reasoning: { supported: false } },
				limit: { context: 64000 },
				api: {
					systemone: {
						base_url: "https://opencode.ai/inference/systemone/v1",
						sdk: { aisdk: "@ai-sdk/typesafe-ai" },
					},
				},
			},
			old: { type: "chat", name: "Old", status: "deprecated" },
		},
	},
	"opencode-go": {
		models: {
			onlyHere: { type: "chat", reasoning: true, capabilities: { reasoning: { supported: true, toggle: true } } },
		},
	},
	unrelated: { models: { ignored: { type: "chat", capabilities: { reasoning: { supported: true } } } } },
};

describe("catalog extraction", () => {
	test("keeps base models with their type and route", () => {
		const catalog = catalogFromPayload(payload);
		const reasoner = catalog.providers.get("opencode")?.models.reasoner;
		expect(reasoner?.name).toBe("Reasoner");
		expect(reasoner?.type).toBe("chat");
		expect(reasoner?.api?.["chat-completions"]?.sdk?.aisdk).toBe("@ai-sdk/openai-compatible");
		expect(catalog.providers.get("opencode")?.models.old?.status).toBe("deprecated");
		expect(catalog.providers.get("opencode")?.models["jev-1.13-free"]?.type).toBe("decision");
		expect(catalog.providers.get("opencode-go")?.models.onlyHere?.name).toBeUndefined();
	});

	test("reads the flags for every provider", () => {
		const { flags } = catalogFromPayload(payload);
		expect(flags.get(capabilityKey("opencode", "reasoner"))?.reasoning).toBe(true);
		expect(flags.get(capabilityKey("opencode", "plain"))?.reasoning).toBe(false);
		expect(flags.get(capabilityKey("opencode-go", "onlyHere"))?.reasoning).toBe(true);
		expect(flags.has(capabilityKey("unrelated", "ignored"))).toBe(true);
	});

	test("maps only the accepted effort values onto pi levels", () => {
		expect(thinkingLevelMapFrom(["low", "high", "max"])).toEqual({
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
	});

	test("leaves the map unset when the model exposes no effort values", () => {
		expect(thinkingLevelMapFrom([])).toBeUndefined();
		expect(thinkingLevelMapFrom(undefined)).toBeUndefined();
		expect(thinkingLevelMapFrom("low")).toBeUndefined();
	});
});

describe("catalog fetch", () => {
	beforeEach(() => {
		resetCatalogCacheForTests();
	});

	test("reads OpenCode's own catalog endpoint", async () => {
		const urls: string[] = [];
		const fetchImpl = (async (url: string | URL | Request) => {
			urls.push(String(url));
			return new Response(JSON.stringify(payload), { status: 200 });
		}) as unknown as typeof fetch;
		await loadCatalog(fetchImpl);
		expect(urls).toEqual([CATALOG_URL]);
		expect(CATALOG_URL.startsWith("https://models.opencode.ai/")).toBe(true);
	});

	test("sends the stored validator and reuses the cached catalog on 304", async () => {
		const calls: RequestInit[] = [];
		const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
			calls.push(init ?? {});
			if (calls.length === 1) {
				return new Response(JSON.stringify(payload), { status: 200, headers: { etag: 'W/"v1"' } });
			}
			return new Response(null, { status: 304 });
		}) as unknown as typeof fetch;

		const first = await loadCatalog(fetchImpl);
		expect(first.providers.get("opencode")?.models.reasoner?.name).toBe("Reasoner");
		const second = await loadCatalog(fetchImpl);
		expect(second).toBe(first);
		expect((calls[1]!.headers as Record<string, string>)["If-None-Match"]).toBe('W/"v1"');
	});

	test("falls back to the cache when the catalog is unreachable", async () => {
		const failing = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		await expect(loadCatalog(failing)).rejects.toThrow("offline");

		const ok = (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
		await loadCatalog(ok);
		const offline = await loadCatalog(failing);
		expect(offline.providers.get("opencode")?.models.reasoner?.name).toBe("Reasoner");
	});
});

const v1Payload = {
	opencode: {
		npm: "@ai-sdk/openai-compatible",
		api: "https://opencode.ai/inference/openai/v1",
		models: {
			reasoner: {
				name: "Reasoner",
				reasoning: true,
				reasoning_options: [{ type: "effort", values: ["low", "null", "max"] }],
				tool_call: true,
				modalities: { input: ["text", "image"], output: ["text"] },
				limit: { context: 1000, output: 100 },
				cost: { input: 1, output: 2, cache_read: 0.1, tiers: [{ tier: { size: 200000 }, input: 4, output: 8 }] },
			},
			responses: {
				name: "Responses",
				provider: { npm: "@ai-sdk/openai", api: "https://opencode.ai/inference/openai-responses/v1" },
			},
			notools: { name: "No tools" },
		},
	},
};

describe("v1 catalogs from a mirror", () => {
	test("are recognised and converted to the v2 shape", () => {
		const catalog = catalogFromPayload(v1Payload);
		expect(isV1(payload)).toBe(false);
		const models = catalog.providers.get("opencode")?.models ?? {};
		expect(models.reasoner?.type).toBe("chat");
		expect(models.reasoner?.capabilities?.reasoning?.effort).toEqual(["low", "max"]);
		expect(models.reasoner?.capabilities?.tools?.supported).toBe(true);
		// v1 providers name the package at provider level; the model inherits it.
		expect(models.reasoner?.api?.["chat-completions"]).toEqual({
			base_url: "https://opencode.ai/inference/openai/v1",
			sdk: { aisdk: "@ai-sdk/openai-compatible" },
		});
		// The model-level package wins and decides the protocol.
		expect(models.responses?.api?.responses?.sdk?.aisdk).toBe("@ai-sdk/openai");
		expect(models.responses?.api?.responses?.base_url).toBe("https://opencode.ai/inference/openai-responses/v1");
		// v1 without tool_call means no tools, as the client reads it.
		expect(models.notools?.capabilities?.tools?.supported).toBe(false);
		expect(models.reasoner?.cost?.text?.input?.overrides).toEqual([
			{ when: { context: { gt: 200000 } }, price: 4, cache: { read: undefined, write: undefined } },
		]);
	});

	test("keep their thinking levels through the conversion", () => {
		const { flags } = catalogFromPayload(v1Payload);
		expect(flags.get(capabilityKey("opencode", "reasoner"))?.thinkingLevelMap).toEqual({
			minimal: null,
			low: "low",
			medium: null,
			high: null,
			xhigh: null,
			max: "max",
		});
	});
});

describe("mirror fallback", () => {
	beforeEach(() => {
		resetCatalogCacheForTests();
		delete process.env.OPENCODE_MODELS_URL;
	});

	test("reads the configured origin and strips trailing slashes", () => {
		expect(catalogOrigin({ OPENCODE_MODELS_URL: "https://mirror.example/" })).toBe("https://mirror.example");
		expect(catalogOrigin({})).toBe("https://models.opencode.ai");
	});

	test("falls back to /api.json when a mirror has no v2 path", async () => {
		process.env.OPENCODE_MODELS_URL = "https://mirror.example";
		const urls: string[] = [];
		const fetchImpl = (async (url: string | URL | Request) => {
			urls.push(String(url));
			if (String(url).includes("/experimental/")) return new Response("", { status: 404 });
			return new Response(JSON.stringify(v1Payload), { status: 200 });
		}) as unknown as typeof fetch;
		const catalog = await loadCatalog(fetchImpl);
		delete process.env.OPENCODE_MODELS_URL;
		expect(urls).toEqual([
			"https://mirror.example/experimental/v2.0/api.json?type=chat,decision,image",
			"https://mirror.example/api.json",
		]);
		expect(catalog.providers.get("opencode")?.models.responses?.type).toBe("chat");
	});

	test("does not fall back on the default origin", async () => {
		const fetchImpl = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
		await expect(loadCatalog(fetchImpl)).rejects.toThrow("HTTP 404");
	});
});
