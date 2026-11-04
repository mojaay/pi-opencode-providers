import { beforeEach, describe, expect, test } from "bun:test";
import { healAllModels, healChatModels, providers, resetExtensionStateForTests, selectPersistedModels } from "../src/extension.ts";
import { currentCredential, forgetToken, rememberCredential, rememberToken } from "../src/token.ts";

function provider(id: string) {
	const found = providers.find((entry) => entry.id === id);
	if (!found) throw new Error(`provider ${id} not registered`);
	return found;
}

describe("provider registration", () => {
	beforeEach(() => {
		forgetToken();
		resetExtensionStateForTests();
	});

	test("registers exactly pi's own ids so the built-in definitions are replaced", () => {
		expect(providers.map((entry) => entry.id)).toEqual(["opencode", "opencode-go"]);
		expect(providers.map((entry) => entry.name)).toEqual(["OpenCode", "OpenCode Go"]);
	});

	test("ships no built-in model list", () => {
		for (const entry of providers) expect(entry.getModels()).toEqual([]);
	});

	test("offers the device login on both providers and no key entry at all", () => {
		for (const entry of providers) {
			expect(entry.auth.oauth?.name).toBe("OpenCode (workspace)");
			expect(typeof entry.auth.oauth?.login).toBe("function");
			expect(typeof entry.auth.oauth?.refresh).toBe("function");
			// No apiKey method exists, so pi renders no "Sign in with an API key" entry.
			expect(entry.auth.apiKey).toBeUndefined();
		}
	});
});

describe("shared console token", () => {
	beforeEach(() => {
		forgetToken();
		resetExtensionStateForTests();
	});

	test("lets a provider resolve the token another provider logged in with", async () => {
		rememberCredential({ access: "st_shared", refresh: "rt_shared", expires: Date.now() + 1000, orgID: "wrk_1" });
		const auth = await provider("opencode-go").auth.oauth!.toAuth({
			type: "oauth",
			access: "st_shared",
			refresh: "rt_shared",
			expires: Date.now() + 1000,
			orgID: "wrk_1",
		} as never);
		expect(auth.apiKey).toBe("st_shared");
		expect(auth.headers).toEqual({ "x-opencode-org-id": "wrk_1" });
	});

	test("reuses the stored credential without a second approval", async () => {
		rememberCredential({ access: "st_shared", refresh: "rt_shared", expires: Date.now() + 1000, orgID: "wrk_1" });
		const interaction = { signal: new AbortController().signal, notify: () => {}, prompt: async () => "" };
		const credential = await provider("opencode-go").auth.oauth!.login(interaction as never);
		expect(credential.access).toBe("st_shared");
		expect(credential.refresh).toBe("rt_shared");
		expect(credential.orgID).toBe("wrk_1");
	});

	test("keeps the refresh token when a bare token for the same value is seen again", async () => {
		rememberCredential({ access: "st_shared", refresh: "rt_shared", expires: 1234, orgID: "wrk_1" });
		rememberToken("st_shared");
		const shared = currentCredential();
		expect(shared?.refresh).toBe("rt_shared");
		expect(shared?.expires).toBe(1234);
		expect(shared?.orgID).toBe("wrk_1");
	});

	test("derives request auth from an oauth credential and remembers it", async () => {
		const auth = await provider("opencode-go").auth.oauth!.toAuth({
			type: "oauth",
			access: "st_oauth",
			refresh: "rt_1",
			expires: Date.now() + 1000,
			orgID: "wrk_9",
		} as never);
		expect(auth.apiKey).toBe("st_oauth");
		expect(auth.headers).toEqual({ "x-opencode-org-id": "wrk_9" });
		expect(currentCredential()?.access).toBe("st_oauth");
	});
});

describe("persisted catalog selection", () => {
	beforeEach(() => {
		forgetToken();
		resetExtensionStateForTests();
	});

	const chat = (extra: Record<string, unknown>) =>
		({ id: "m", name: "m", api: "openai-completions", provider: "opencode", baseUrl: "https://x/v1", reasoning: true, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1, ...extra }) as never;

	test("keeps models this extension wrote and rejects the built-in list", () => {
		const marked = chat({ piOpencodeCatalog: true });
		const unmarkedButOurs = chat({});
		const builtIn = chat({ compat: { supportsStore: false }, inputLimits: { images: {} } });
		const otherProvider = chat({ provider: "someone-else" });
		const kept = selectPersistedModels([marked, unmarkedButOurs, builtIn, otherProvider], "opencode");
		expect(kept.map((model) => model.id)).toEqual(["m", "m"]);
	});

	test("returns nothing when the entry belongs to another provider", () => {
		expect(selectPersistedModels([chat({})], "opencode-go")).toEqual([]);
	});

	test("keeps a classifier entry out of the chat catalog and in the full one", () => {
		const classifier = {
			id: "jev-1.13-free",
			name: "Jev 1.13 Free",
			type: "classifier",
			api: "typesafe-system-one",
			provider: "opencode",
			baseUrl: "https://opencode.ai/inference/systemone/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 64000,
		} as never;
		const chatModel = chat({ piOpencodeCatalog: true });
		expect(healChatModels("opencode", [chatModel, classifier]).map((model) => model.id)).toEqual(["m"]);
		expect(healAllModels("opencode", [chatModel, classifier]).map((model) => model.id)).toEqual(["m", "jev-1.13-free"]);
	});
});
