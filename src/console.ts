// Console client for the OpenCode workspace API.
//
// Everything here talks to https://opencode.ai/console: the device-code login,
// the refresh grant, the workspace list and the V2 config that carries the
// model catalog for both providers. The v1 config endpoint is deliberately not
// used; the V2 response is the only catalog source.

import type { OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";

export const CONSOLE_BASE = "https://opencode.ai/console";
export const CLIENT_ID = "opencode-cli";
// An honest client identity. The console front door rejects requests that carry
// no User-Agent at all (Cloudflare error 1010); any real identity passes.
export const USER_AGENT = "pi-opencode-providers";

/** Adds a fixed delay, aborting with the signal. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason ?? new Error("aborted"));
			},
			{ once: true },
		);
	});
}

export class ConsoleError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "ConsoleError";
	}
}

export interface Workspace {
	id: string;
	name: string;
}

export interface DeviceCodeStart {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	interval?: number;
	expires_in?: number;
}

export interface TokenPayload {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	/** Workspace the device approval was granted for, when the console reports it. */
	org_id?: string;
	error?: string;
	error_description?: string;
}

export interface ConsoleCredential extends OAuthCredential {
	orgID?: string;
	orgName?: string;
}

export interface CostTierPayload {
	input?: number;
	output?: number;
	cache?: { read?: number; write?: number };
	tier?: { type?: string; size?: number };
}

export interface ConsoleModel {
	name?: string;
	family?: string;
	package?: string;
	settings?: { baseURL?: string; apiKey?: string };
	capabilities?: { tools?: boolean; input?: string[]; output?: string[] };
	limit?: { context?: number; input?: number; output?: number };
	cost?: CostTierPayload[];
	disabled?: boolean;
}

export interface ConsoleProvider {
	name?: string;
	/** Catalog provider this console provider is based on, when the ids differ. */
	canonical?: string;
	package?: string;
	settings?: { baseURL?: string; apiKey?: string };
	headers?: Record<string, string>;
	env?: string[];
	models?: Record<string, ConsoleModel>;
}

export interface ConsoleConfig {
	providers?: Record<string, ConsoleProvider>;
}

type FetchImpl = typeof fetch;

async function requestJson<T>(
	fetchImpl: FetchImpl,
	url: string,
	init: RequestInit,
	options: { allowErrorPayload?: boolean } = {},
): Promise<T> {
	const response = await fetchImpl(url, {
		...init,
		headers: { "User-Agent": USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
	});
	if (!response.ok && !options.allowErrorPayload) {
		const detail = await response.text().catch(() => "");
		throw new ConsoleError(`${url}: HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`, response.status);
	}
	return (await response.json()) as T;
}

function postJson<T>(fetchImpl: FetchImpl, url: string, body: unknown, signal?: AbortSignal, allowErrorPayload = false): Promise<T> {
	return requestJson<T>(
		fetchImpl,
		url,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		},
		{ allowErrorPayload },
	);
}

export function credentialFrom(payload: TokenPayload, orgID?: string, orgName?: string): ConsoleCredential {
	if (!payload.access_token) throw new ConsoleError("Token response is missing access_token");
	return {
		type: "oauth",
		access: payload.access_token,
		refresh: payload.refresh_token ?? "",
		// Treat the token as expiring five minutes early so a refresh lands first.
		expires: Date.now() + (payload.expires_in ?? 3600) * 1000 - 5 * 60 * 1000,
		...(orgID ? { orgID } : {}),
		...(orgName ? { orgName } : {}),
	};
}

export function requestDeviceCode(fetchImpl: FetchImpl, signal?: AbortSignal): Promise<DeviceCodeStart> {
	// The console rejects the request without this flag (`DeviceAuthFailed:
	// Device authorization failed`); the client sends it as a boolean.
	return postJson<DeviceCodeStart>(
		fetchImpl,
		`${CONSOLE_BASE}/auth/device/code`,
		{ client_id: CLIENT_ID, supports_org_scope: true },
		signal,
	);
}

const DEVICE_CODE_ATTEMPTS = 3;
const DEVICE_CODE_RETRY_MS = 2000;

/** `DeviceAuthFailed` comes and goes on a healthy endpoint: retry rather than fail the login. */
function isTransientDeviceCodeFailure(error: unknown): boolean {
	return error instanceof ConsoleError && error.status === 400 && error.message.includes("DeviceAuthFailed");
}

async function requestDeviceCodeWithRetry(fetchImpl: FetchImpl, signal?: AbortSignal): Promise<DeviceCodeStart> {
	for (let attempt = 1; attempt <= DEVICE_CODE_ATTEMPTS; attempt += 1) {
		try {
			return await requestDeviceCode(fetchImpl, signal);
		} catch (error) {
			if (!isTransientDeviceCodeFailure(error)) throw error;
			if (attempt < DEVICE_CODE_ATTEMPTS) await sleep(DEVICE_CODE_RETRY_MS, signal);
		}
	}
	throw new ConsoleError(
		`Console refused the device code after ${DEVICE_CODE_ATTEMPTS} attempts (DeviceAuthFailed). The endpoint answers that intermittently; wait a moment and run /login again.`,
		400,
	);
}

export function deviceToken(
	fetchImpl: FetchImpl,
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<TokenPayload> {
	// Pending/failed polls answer with an error payload and a 4xx status.
	return postJson<TokenPayload>(fetchImpl, `${CONSOLE_BASE}/auth/device/token`, { client_id: CLIENT_ID, ...body }, signal, true);
}

export async function fetchWorkspaces(token: string, fetchImpl: FetchImpl, signal?: AbortSignal): Promise<Workspace[]> {
	const data = await requestJson<Workspace[] | { orgs?: Workspace[] }>(
		fetchImpl,
		`${CONSOLE_BASE}/api/orgs`,
		{ headers: { Authorization: `Bearer ${token}` }, signal },
	);
	const list = Array.isArray(data) ? data : (data.orgs ?? []);
	return list.map((entry) => ({ id: entry.id, name: entry.name ?? entry.id }));
}

export function exchangeRefreshToken(
	fetchImpl: FetchImpl,
	refreshToken: string,
	signal?: AbortSignal,
): Promise<TokenPayload> {
	return deviceToken(fetchImpl, { grant_type: "refresh_token", refresh_token: refreshToken }, signal);
}

export function fetchConsoleConfig(
	fetchImpl: FetchImpl,
	token: string,
	orgID: string | undefined,
	signal?: AbortSignal,
): Promise<ConsoleConfig> {
	return requestJson<ConsoleConfig>(
		fetchImpl,
		`${CONSOLE_BASE}/api/v2/config`,
		{
			headers: {
				Authorization: `Bearer ${token}`,
				// The endpoint validates the workspace and answers 403 for an unknown id.
				...(orgID ? { "x-org-id": orgID } : {}),
			},
			signal,
		},
	);
}

/** Device-code login: show the code, poll for the token, then pick a workspace. */
export async function loginConsole(
	interaction: ProviderAuthInteraction,
	fetchImpl: FetchImpl = fetch,
): Promise<ConsoleCredential> {
	const start = await requestDeviceCodeWithRetry(fetchImpl, interaction.signal);
	interaction.notify({
		type: "device_code",
		userCode: start.user_code,
		verificationUri: new URL(start.verification_uri_complete ?? start.verification_uri, `${CONSOLE_BASE}/`).href,
		intervalSeconds: start.interval,
		expiresInSeconds: start.expires_in,
	});
	interaction.notify({
		type: "progress",
		message: "Approve in the browser, then return here to pick the workspace.",
	});

	let intervalMs = (start.interval ?? 5) * 1000;
	const deadline = Date.now() + (start.expires_in ?? 600) * 1000;
	while (Date.now() < deadline) {
		await sleep(intervalMs, interaction.signal);
		const payload = await deviceToken(
			fetchImpl,
			{ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: start.device_code },
			interaction.signal,
		);
		if (payload.access_token) {
			const credential = credentialFrom(payload);
			// The approval step already picked the workspace when the console
			// reports one; only ask when it did not.
			if (payload.org_id) {
				credential.orgID = payload.org_id;
			} else {
				interaction.notify({ type: "progress", message: "Approved. Loading workspaces…" });
				const workspaces = await fetchWorkspaces(credential.access, fetchImpl, interaction.signal);
				const picked = await pickWorkspace(interaction, workspaces);
				credential.orgID = picked.id;
				credential.orgName = picked.name;
			}
			interaction.notify({
				type: "progress",
				message: `Workspace ready: ${credential.orgName ?? credential.orgID ?? "default"}`,
			});
			return credential;
		}
		if (payload.error === "authorization_pending") continue;
		if (payload.error === "slow_down") {
			intervalMs += 5000;
			continue;
		}
		throw new ConsoleError(`Login failed: ${payload.error ?? "unknown"} ${payload.error_description ?? ""}`);
	}
	throw new ConsoleError("The device code expired before approval");
}

async function pickWorkspace(interaction: ProviderAuthInteraction, workspaces: Workspace[]): Promise<Workspace> {
	if (workspaces.length === 0) return { id: "", name: "Default" };
	const only = workspaces[0];
	if (workspaces.length === 1) return only!;
	const selected = await interaction.prompt({
		type: "select",
		message: "Select workspace",
		options: workspaces.map((workspace) => ({ id: workspace.id, label: workspace.name })),
	});
	const match = workspaces.find((workspace) => workspace.id === selected);
	if (!match) throw new ConsoleError("Login cancelled before a workspace was chosen");
	return match;
}

/** Refresh grant. Throws on failure so pi can mark the credential for re-login. */
export async function refreshConsoleCredential(
	credential: ConsoleCredential,
	signal: AbortSignal,
	fetchImpl: FetchImpl = fetch,
): Promise<ConsoleCredential> {
	if (!credential.refresh) throw new ConsoleError("Credential has no refresh token; re-login required");
	const payload = await exchangeRefreshToken(fetchImpl, credential.refresh, signal);
	if (!payload.access_token) {
		throw new ConsoleError(`Refresh failed: ${payload.error ?? "unknown"} ${payload.error_description ?? ""}`);
	}
	const next = credentialFrom(payload, credential.orgID, credential.orgName);
	return next;
}
