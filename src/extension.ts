// pi extension: OpenCode Zen and OpenCode Go through one console login.
//
// Both providers register under pi's own provider ids, so the built-in
// definitions of those ids are replaced rather than duplicated. The catalog
// comes from the console V2 config; capability flags come from the public model
// catalog. Only the device-code login is offered: no API key path exists.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createProvider,
	isModelType,
	type AnyModel,
	type ClassifierModel,
	type Credential,
	type Model,
	type Provider,
	type ProviderAuth,
	type ProviderStreams,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import {
	anthropicMessagesApi,
	googleGenerativeAIApi,
	mistralConversationsApi,
	openAICompletionsApi,
	openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import {
	buildProviderModels,
	CATALOG_MODEL_MARK,
	type CatalogModelEntry,
	type ClassifierApi,
	GO_PROVIDER_ID,
	PROVIDER_IDS,
	ZEN_PROVIDER_ID,
	type CatalogApi,
} from "./catalog.ts";
import { loadCatalog } from "./catalog-source.ts";
import {
	ConsoleError,
	fetchConsoleConfig,
	fetchWorkspaces,
	loginConsole,
	refreshConsoleCredential,
	type ConsoleConfig,
	type ConsoleCredential,
} from "./console.ts";
import { withGoSession, withZeroCostIdentity } from "./request.ts";
import { currentCredential, currentToken, rememberCredential, rememberToken } from "./token.ts";
import { messages, resolveLanguage, type Language, type Messages } from "./i18n.ts";
import {
	formatDiff,
	formatLimits,
	formatStatusLine,
	formatUsage,
	fetchGoStatus,
	fetchGoUsage,
	fetchUsageModels,
	fetchUsageSummary,
	mergeLimits,
	parseRange,
	parseStatusMeters,
	parseUsageModels,
	parseUsageSummary,
	parseUsagePercentages,
	ResponseCache,
	type GoLimits,
	type Range,
} from "./monitor.ts";
import { readSnapshot, updateSnapshot, writeSnapshot } from "./snapshot.ts";

interface Route {
	api: CatalogApi;
	baseUrl: string;
}

/** Latest parsed routes per provider, used to re-derive a cached model's route on read. */
const routes = new Map<string, Map<string, Route>>();
const modelCounts = new Map<string, number>();

let workspaceOverride: { id: string; name: string } | undefined;
let notify: ((message: string, type?: "info" | "warning" | "error") => void) | undefined;let lastAuthNoticeFor: string | undefined;

/** Status-bar key: carries the quota keyword and the provider id. */
export const STATUS_KEY = "quota:opencode-go";
const monitorCache = new ResponseCache();
/** Last model catalog seen per provider, used to build the monitor snapshot. */
const catalogSources = new Map<string, { models: string[]; deprecated: string[] }>();
let lastLimits: GoLimits | undefined;let lastStatusText: string | undefined;
let snapshotInFlight: Promise<void> | undefined;

/** Resolved once per extension load; pi exposes the merged settings. */
let language: () => Language = () => "en";

function text(): Messages {
	return messages[language()];
}

const PROVIDER_NAMES: Record<string, string> = {
	[ZEN_PROVIDER_ID]: "OpenCode",
	[GO_PROVIDER_ID]: "OpenCode Go",
};

function announceAuthFailure(token: string, detail: string): void {
	if (lastAuthNoticeFor === token) return;
	lastAuthNoticeFor = token;
	notify?.(`OpenCode credential rejected (${detail}). Run /login to sign in again.`, "error");
}

function orgHeader(orgID: string | undefined): Record<string, string> {
	return orgID ? { "x-opencode-org-id": orgID } : {};
}

function tokenFrom(credential: Credential | undefined): { token: string; orgID?: string } | undefined {
	if (!credential) return undefined;
	if (credential.type === "oauth") {
		const oauth = credential as ConsoleCredential;
		return { token: oauth.access, orgID: workspaceOverride?.id ?? oauth.orgID };
	}
	const key = credential.key ?? currentToken()?.value;
	return key ? { token: key, orgID: workspaceOverride?.id ?? currentToken()?.orgID } : undefined;
}

function providerAuth(providerId: string): ProviderAuth {
	return {
		// The only credential path: no API key method exists, so the login list
		// shows one account entry per provider and no key entry at all.
		oauth: {
			name: "OpenCode (workspace)",
			login: async (interaction) => {
				// Whichever provider logged in first left its console token behind;
				// the other one reuses it, so the second click needs no approval.
				const shared = currentCredential();
				if (shared?.access) {
					return {
						type: "oauth",
						access: shared.access,
						refresh: shared.refresh ?? "",
						expires: shared.expires ?? Date.now() + 30 * 24 * 3600 * 1000,
						...(shared.orgID ? { orgID: shared.orgID } : {}),
					} as ConsoleCredential;
				}
				const credential = await loginConsole(interaction);
				rememberCredential(credential);
				return credential;
			},
			refresh: async (credential, signal) => {
				try {
					const next = await refreshConsoleCredential(credential as ConsoleCredential, signal);
					rememberCredential(next);
					return next;
				} catch (error) {
					announceAuthFailure((credential as ConsoleCredential).access, error instanceof Error ? error.message : String(error));
					throw error;
				}
			},
			toAuth: async (credential) => {
				const oauth = credential as ConsoleCredential;
				// Keep the whole credential, refresh token included, so the other
				// provider's login can reuse it without asking for approval again.
				rememberCredential(oauth);
				const orgID = workspaceOverride?.id ?? oauth.orgID;
				return { apiKey: oauth.access, headers: orgHeader(orgID) };
			},
		},
	};
}

/** Re-derive the route from the latest parsed catalog so a stale entry cannot pin a protocol. */
function healRoute(providerId: string, model: Model<CatalogApi>): Model<CatalogApi> {
	const route = routes.get(providerId)?.get(model.id);
	if (!route) return model;
	// anthropic/google routes only ever come from the console; trust the snapshot verbatim.
	if (route.api === model.api && route.baseUrl === model.baseUrl) return model;
	return { ...model, api: route.api, baseUrl: route.baseUrl };
}

/** `getModels` is the chat catalog; classifier entries belong to `getAllModels` only. */
export function healChatModels(providerId: string, models: readonly AnyModel[]): Model<CatalogApi>[] {
	return models
		.filter((model) => isModelType(model, "chat"))
		// Our catalog only ever emits CatalogApi models; the narrowing above widens to Api.
		.map((model) => healRoute(providerId, model as Model<CatalogApi>));
}

/** `getAllModels` carries every type, so only chat entries get their route re-derived. */
export function healAllModels(providerId: string, models: readonly AnyModel[]): CatalogModelEntry[] {
	return models
		.filter((model) => !isModelType(model, "image"))
		.map((model) =>
			isModelType(model, "chat")
				? healRoute(providerId, model as Model<CatalogApi>)
				: (model as ClassifierModel<ClassifierApi>),
		);
}

function streamsFor(providerId: string): Partial<Record<CatalogApi, ProviderStreams>> {
	const gate = providerId === GO_PROVIDER_ID ? withGoSession : withZeroCostIdentity;
	return {
		"openai-completions": gate(openAICompletionsApi()),
		"openai-responses": gate(openAIResponsesApi()),
		"anthropic-messages": gate(anthropicMessagesApi()),
		"google-generative-ai": gate(googleGenerativeAIApi()),
		"mistral-conversations": gate(mistralConversationsApi()),
	};
}

/** Models this extension wrote into a persisted entry, as opposed to pi's built-in list. */
export function selectPersistedModels(stored: readonly AnyModel[], providerId: string): CatalogModelEntry[] {
	return stored.filter((model): model is CatalogModelEntry => {
		if (model.provider !== providerId) return false;
		const record = model as unknown as Record<string, unknown>;
		if (record[CATALOG_MODEL_MARK] === true) return true;
		// pi's built-in entries for these ids always carry these two; ours never do.
		return record.compat === undefined && record.inputLimits === undefined;
	});
}

function storedModels(context: RefreshModelsContext, providerId: string): CatalogModelEntry[] {
	return selectPersistedModels(context.stored?.models ?? [], providerId);
}

async function fetchModels(providerId: string, context: RefreshModelsContext): Promise<CatalogModelEntry[]> {
	if (!context.allowNetwork) return storedModels(context, providerId);
	const resolved = tokenFrom(context.credential);
	if (!resolved) return storedModels(context, providerId);

	try {
		const [config, catalog] = await Promise.all([
			fetchConsoleConfig(fetch, resolved.token, resolved.orgID, context.signal),
			loadCatalog(fetch, context.signal),
		]);
		rememberToken(resolved.token, resolved.orgID);
		const built = collect(config, catalog);
		void refreshCatalogSnapshot();
		return built[providerId] ?? [];
	} catch (error) {
		if (error instanceof ConsoleError && (error.status === 401 || error.status === 403)) {
			announceAuthFailure(resolved.token, String(error.status));
		}
		// Keep the last console catalog instead of emptying the picker: pi
		// republishes the returned list, so returning [] would also wipe the store.
		return storedModels(context, providerId);
	}
}

/** Build both providers from one catalog pair so they cannot drift apart. */
function collect(
	config: ConsoleConfig,
	catalog: Awaited<ReturnType<typeof loadCatalog>>,
): Record<string, CatalogModelEntry[]> {
	const result: Record<string, CatalogModelEntry[]> = {};
	for (const providerId of PROVIDER_IDS) {
		const built = buildProviderModels(config, providerId, catalog);
		routes.set(providerId, built.routes);
		modelCounts.set(providerId, built.models.length);
		result[providerId] = built.models;
		const base = catalog.providers.get(config.providers?.[providerId]?.canonical ?? providerId);
		const deprecated = Object.entries(base?.models ?? {})
			.filter(([, entry]) => entry.status === "deprecated")
			.map(([id]) => id);
		catalogSources.set(providerId, { models: built.models.map((model) => model.id), deprecated });
	}
	return result;
}

function createOpenCodeProvider(providerId: string): Provider<CatalogApi> {
	const provider = createProvider<CatalogApi>({
		id: providerId,
		name: PROVIDER_NAMES[providerId] ?? providerId,
		auth: providerAuth(providerId),
		// No built-in catalog: the model list is the console's.
		models: [],
		fetchModels: (context) => fetchModels(providerId, context),
		api: streamsFor(providerId),
	});
	return {
		...provider,
		getModels: () => healChatModels(providerId, provider.getModels()),
		getAllModels: () => healAllModels(providerId, provider.getAllModels?.() ?? provider.getModels()),
	};
}

export const providers: Provider<CatalogApi>[] = PROVIDER_IDS.map((providerId) => createOpenCodeProvider(providerId));

export function resetExtensionStateForTests(): void {
	routes.clear();
	modelCounts.clear();
	workspaceOverride = undefined;
	lastAuthNoticeFor = undefined;
	notify = undefined;
}

// Both provider ids share one credential. Reading it here, on session_start, makes the second
// provider available without a second approval.
async function primeSharedToken(ctx: ExtensionContext): Promise<void> {
	notify = (message, type) => ctx.ui.notify(message, type);
	for (const providerId of PROVIDER_IDS) {
		try {
			const token = await ctx.modelRegistry.getApiKeyForProvider(providerId);
			if (token) rememberToken(token, workspaceOverride?.id);
		} catch {
			// Availability probing is best effort; the catalog fetch reports real failures.
		}
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Load through the cache; on failure fall back to the last good payload. */
async function loadMonitored<T>(
	key: string,
	loader: () => Promise<unknown>,
	parse: (payload: unknown) => T,
): Promise<{ value?: T; error?: string }> {
	try {
		return { value: parse(await monitorCache.run(key, loader)) };
	} catch (error) {
		const stale = monitorCache.peek(key);
		if (stale !== undefined) return { value: parse(stale), error: errorText(error) };
		return { error: errorText(error) };
	}
}

/** Show the line only while a Go model is active; clear it on any other provider. */
function syncStatus(ctx: ExtensionContext, limits: GoLimits | undefined): void {
	if (!ctx.hasUI) return;
	const active = ctx.model?.provider === GO_PROVIDER_ID;
	if (!active || !limits || Object.keys(limits).length === 0) {
		if (lastStatusText !== undefined) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			lastStatusText = undefined;
		}
		return;
	}
	const text = formatStatusLine(limits);
	if (text === lastStatusText) return;
	ctx.ui.setStatus(STATUS_KEY, text);
	lastStatusText = text;
}

async function refreshLimits(ctx: ExtensionContext): Promise<{ limits?: GoLimits; error?: string }> {
	const token = currentToken();
	if (!token?.value) return {};
	const value = token.value;
	const errors: string[] = [];
	const usage = await loadMonitored("go:usage", () => fetchGoUsage(fetch, value, token.orgID), parseUsagePercentages);
	const status = await loadMonitored("go:status", () => fetchGoStatus(fetch, value, token.orgID), parseStatusMeters);
	if (usage.error) errors.push(usage.error);
	if (status.error) errors.push(status.error);
	const limits = mergeLimits(usage.value ?? {}, status.value ?? {});
	lastLimits = limits;
	syncStatus(ctx, limits);
	return { limits, error: errors.length > 0 ? errors.join("; ") : undefined };
}

/** Compare the catalog the providers just published with the persisted snapshot. */
function refreshCatalogSnapshot(): Promise<void> {
	if (snapshotInFlight) return snapshotInFlight;
	snapshotInFlight = (async () => {
		const source = catalogSources.get(GO_PROVIDER_ID);
		if (!source || source.models.length === 0) return;
		const previous = await readSnapshot();
		const models = [...source.models].sort();
		const deprecated = [...source.deprecated].sort();
		if (previous && previous.models.join("\n") === models.join("\n") && previous.deprecated.join("\n") === deprecated.join("\n")) return;
		const update = updateSnapshot(previous, models, deprecated);
		await writeSnapshot(update.snapshot);
		if (update.notify) notify?.(formatDiff(update.diff, undefined, language()), "info");
	})().finally(() => {
		snapshotInFlight = undefined;
	});
	return snapshotInFlight;
}

async function usageReport(ctx: ExtensionContext, range: Range): Promise<string> {
	const t = text();
	const token = currentToken();
	if (!token?.value) return t.notLoggedIn;
	const value = token.value;
	const limits = await refreshLimits(ctx);
	const rows = await loadMonitored(`usage:models:${range}`, () => fetchUsageModels(fetch, value, token.orgID, range), parseUsageModels);
	const summary = await loadMonitored(`usage:summary:${range}`, () => fetchUsageSummary(fetch, value, token.orgID, range), parseUsageSummary);
	const notes = [limits.error, rows.error, summary.error].filter((entry): entry is string => Boolean(entry));
	const snapshot = await readSnapshot();
	const parts = [
		formatLimits(limits.limits ?? lastLimits ?? {}, limits.error, language()),
		formatUsage({ rows: rows.value ?? [], summary: summary.value }, range, language()),
		formatDiff(snapshot?.diff ?? { added: [], removed: [], deprecated: [] }, snapshot, language()),
	];
	if (notes.length > 0) parts.push(t.notes(notes.join("; ")));
	return parts.join("\n");
}

async function statusLine(ctx: ExtensionContext): Promise<string> {
	const shared = currentToken();
	const workspace = workspaceOverride?.id ?? shared?.orgID ?? "(from login)";
	// Count the models the providers currently hold: after an offline restore the
	// network counters are empty while the catalog is not.
	const counts = providers
		.map((provider) => `${provider.name ?? provider.id}: ${provider.getModels().length} models`)
		.join("\n  ");
	return `OpenCode providers\n  Auth: console device login\n  Workspace: ${workspace}\n  ${counts}`;
}

async function switchWorkspace(ctx: ExtensionContext): Promise<void> {
	const shared = currentToken();
	if (!shared?.value) {
		ctx.ui.notify("Not signed in. Run /login opencode and pick a workspace.", "warning");
		return;
	}
	let workspaces;
	try {
		workspaces = await fetchWorkspaces(shared.value, fetch);
	} catch (error) {
		ctx.ui.notify(`Workspace list failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	if (workspaces.length === 0) {
		ctx.ui.notify("This account has no workspaces.", "warning");
		return;
	}
	let picked = workspaces[0]!;
	if (workspaces.length > 1) {
		const labels = workspaces.map((workspace) => `${workspace.name} (${workspace.id})`);
		const selected = await ctx.ui.select("Select workspace", labels);
		if (!selected) return;
		const match = workspaces[labels.indexOf(selected)];
		if (!match) return;
		picked = match;
	}
	workspaceOverride = { id: picked.id, name: picked.name };
	ctx.ui.notify(`Switched to ${picked.name}. Session only: re-login to keep it after a restart. Refreshing models…`, "info");
	try {
		await ctx.modelRegistry.refresh({ providers: [...PROVIDER_IDS], allowNetwork: true, force: true });
	} catch {
		ctx.ui.notify("Run /reload to refresh the model picker.", "warning");
	}
}

export default function (pi: ExtensionAPI): void {
	// Settings are merged by pi, so the language follows the global file and any project override.
	language = () => resolveLanguage(pi.getSettings());
	for (const provider of providers) pi.registerProvider(provider);
	pi.on("session_start", async (_event, ctx) => {
		await primeSharedToken(ctx);
		await refreshLimits(ctx);
	});
	pi.on("turn_end", async (_event, ctx) => {
		await refreshLimits(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		syncStatus(ctx, lastLimits);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		monitorCache.clear();
		lastLimits = undefined;
		lastStatusText = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
	pi.registerCommand("opencode", {
		description: "OpenCode providers: status, switch-org, refresh, usage [24h|7d|30d]",
		getArgumentCompletions: (prefix) => {
			const t = text();
			const input = prefix.trimStart();
			if (input.startsWith("usage ")) {
				const rangePrefix = input.slice("usage ".length).trimStart();
				return ["24h", "7d", "30d"]
					.filter((range) => range.startsWith(rangePrefix))
					.map((range) => ({ value: `usage ${range}`, label: `usage ${range}`, description: t.completion.range(range) }));
			}
			return [
				{ value: "status", description: t.completion.status },
				{ value: "usage", description: t.completion.usage },
				{ value: "switch-org", description: t.completion.switchOrg },
				{ value: "refresh", description: t.completion.refresh },
			]
				.filter((item) => item.value.startsWith(input))
				.map((item) => ({ value: item.value, label: item.value, description: item.description }));
		},
		handler: async (args, ctx) => {
			notify = (message, type) => ctx.ui.notify(message, type);
			const sub = args.trim().split(/\s+/)[0] ?? "";
			if (sub === "status" || sub === "") {
				ctx.ui.notify(await statusLine(ctx), "info");
				return;
			}
			if (sub === "switch-org" || sub === "switch") {
				await switchWorkspace(ctx);
				return;
			}
			if (sub === "usage") {
				const { range, fellBack } = parseRange(args.trim().split(/\s+/)[1]);
				const report = await usageReport(ctx, range);
				ctx.ui.notify(fellBack ? `${text().invalidRange(range)}\n${report}` : report, "info");
				return;
			}
			if (sub === "refresh") {
				try {
					await ctx.modelRegistry.refresh({ providers: [...PROVIDER_IDS], allowNetwork: true, force: true });
					ctx.ui.notify(text().refreshed, "info");
				} catch (error) {
					ctx.ui.notify(text().refreshFailed(error instanceof Error ? error.message : String(error)), "error");
				}
				return;
			}
			ctx.ui.notify(await statusLine(ctx), "info");
		},
	});
}

// Re-exported so tests can assert the protocol mapping without reaching into modules.
export { apiFromPackage } from "./catalog.ts";
