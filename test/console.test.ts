import { describe, expect, test } from "bun:test";
import {
	ConsoleError,
	credentialFrom,
	fetchConsoleConfig,
	fetchWorkspaces,
	loginConsole,
	refreshConsoleCredential,
	requestDeviceCode,
} from "../src/console.ts";

interface Call {
	url: string;
	init: RequestInit;
}

/** Queue-driven fetch stub: each entry answers one request. */
function stubFetch(handlers: Array<(call: Call) => Response>): { fetchImpl: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		const call = { url: String(url), init: init ?? {} };
		calls.push(call);
		const handler = handlers.shift();
		if (!handler) throw new Error(`unexpected request: ${call.url}`);
		return handler(call);
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function interaction(select?: string) {
	const notified: string[] = [];
	return {
		notified,
		value: {
			signal: new AbortController().signal,
			notify: (event: { type: string }) => notified.push(event.type),
			prompt: async () => select ?? "",
		},
	};
}

describe("device flow", () => {
	test("exchanges the device code for a credential bound to the chosen workspace", async () => {
		const { fetchImpl, calls } = stubFetch([
			() => json({ device_code: "dev", user_code: "ABCD", verification_uri: "https://opencode.ai/auth", interval: 0, expires_in: 30 }),
			() => json({ error: "authorization_pending" }),
			() => json({ access_token: "st_1", refresh_token: "rt_1", expires_in: 3600 }),
			() => json([{ id: "wrk_1", name: "Default" }]),
		]);
		const session = interaction();
		const credential = await loginConsole(session.value as never, fetchImpl);

		expect(credential.access).toBe("st_1");
		expect(credential.refresh).toBe("rt_1");
		expect(credential.orgID).toBe("wrk_1");
		expect(credential.orgName).toBe("Default");
		expect(session.notified).toContain("device_code");
		expect(calls[0]!.url).toContain("/auth/device/code");
		expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ client_id: "opencode-cli", supports_org_scope: true });
	});

	test("uses the workspace reported by the approval and skips the picker", async () => {
		const { fetchImpl, calls } = stubFetch([
			() => json({ device_code: "dev", user_code: "ABCD", verification_uri: "https://opencode.ai/auth", interval: 0, expires_in: 30 }),
			() => json({ access_token: "st_1", refresh_token: "rt_1", expires_in: 3600, org_id: "wrk_from_approval" }),
		]);
		const credential = await loginConsole(interaction().value as never, fetchImpl);
		expect(credential.orgID).toBe("wrk_from_approval");
		expect(calls.map((call) => call.url).some((url) => url.includes("/api/orgs"))).toBe(false);
	});

	test("retries the device code when the console answers DeviceAuthFailed", async () => {
		const { fetchImpl, calls } = stubFetch([
			() => json({ _tag: "DeviceAuthFailed", message: "Device authorization failed" }, 400),
			() => json({ device_code: "dev", user_code: "ABCD", verification_uri: "https://opencode.ai/auth", interval: 0, expires_in: 30 }),
			() => json({ access_token: "st_1", refresh_token: "rt_1", expires_in: 3600, org_id: "wrk_1" }),
		]);
		const credential = await loginConsole(interaction().value as never, fetchImpl);
		expect(credential.access).toBe("st_1");
		expect(calls.filter((call) => call.url.includes("/auth/device/code"))).toHaveLength(2);
	});

	test("gives up with an actionable message when the console keeps refusing", async () => {
		const refusing = (async () => json({ _tag: "DeviceAuthFailed" }, 400)) as unknown as typeof fetch;
		await expect(loginConsole(interaction().value as never, refusing)).rejects.toThrow(/run \/login again/);
	});

	test("does not retry a failure that is not DeviceAuthFailed", async () => {
		const { fetchImpl, calls } = stubFetch([() => json({ _tag: "SomethingElse" }, 400)]);
		await expect(loginConsole(interaction().value as never, fetchImpl)).rejects.toThrow(/HTTP 400/);
		expect(calls).toHaveLength(1);
	});

	test("asks which workspace to use when the account has several", async () => {
		const { fetchImpl } = stubFetch([
			() => json({ device_code: "dev", user_code: "ABCD", verification_uri: "https://opencode.ai/auth", interval: 0, expires_in: 30 }),
			() => json({ access_token: "st_1", refresh_token: "rt_1", expires_in: 3600 }),
			() =>
				json([
					{ id: "wrk_1", name: "One" },
					{ id: "wrk_2", name: "Two" },
				]),
		]);
		const session = interaction("wrk_2");
		const credential = await loginConsole(session.value as never, fetchImpl);
		expect(credential.orgID).toBe("wrk_2");
	});

	test("writes no credential when the flow is cancelled", async () => {
		const { fetchImpl } = stubFetch([
			() => json({ device_code: "dev", user_code: "ABCD", verification_uri: "https://opencode.ai/auth", interval: 0, expires_in: 30 }),
			() => json({ access_token: "st_1", refresh_token: "rt_1", expires_in: 3600 }),
			() =>
				json([
					{ id: "wrk_1", name: "One" },
					{ id: "wrk_2", name: "Two" },
				]),
		]);
		const session = interaction("");
		await expect(loginConsole(session.value as never, fetchImpl)).rejects.toThrow(ConsoleError);
	});

	test("surfaces a terminal error instead of polling forever", async () => {
		const { fetchImpl } = stubFetch([
			() => json({ device_code: "dev", user_code: "ABCD", verification_uri: "https://opencode.ai/auth", interval: 0, expires_in: 30 }),
			() => json({ error: "access_denied" }),
		]);
		await expect(loginConsole(interaction().value as never, fetchImpl)).rejects.toThrow(/access_denied/);
	});

	test("treats a token as expiring early so a refresh lands first", () => {
		const credential = credentialFrom({ access_token: "a", refresh_token: "b", expires_in: 3600 });
		expect(credential.expires).toBeLessThanOrEqual(Date.now() + 3600_000 - 5 * 60_000 + 10);
	});
});

describe("refresh grant", () => {
	test("replaces both tokens and keeps the workspace", async () => {
		const { fetchImpl, calls } = stubFetch([() => json({ access_token: "st_2", refresh_token: "rt_2", expires_in: 3600 })]);
		const next = await refreshConsoleCredential(
			{ type: "oauth", access: "st_1", refresh: "rt_1", expires: 0, orgID: "wrk_1" },
			new AbortController().signal,
			fetchImpl,
		);
		expect(next.access).toBe("st_2");
		expect(next.refresh).toBe("rt_2");
		expect(next.orgID).toBe("wrk_1");
		expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt_1" });
	});

	test("flags a credential that cannot be refreshed", async () => {
		const fetchImpl = (async () => json({})) as unknown as typeof fetch;
		await expect(
			refreshConsoleCredential({ type: "oauth", access: "st_1", refresh: "", expires: 0 }, new AbortController().signal, fetchImpl),
		).rejects.toThrow(/refresh token/);
	});
});

describe("console requests", () => {
	test("lists workspaces with a bearer token", async () => {
		const { fetchImpl, calls } = stubFetch([() => json({ orgs: [{ id: "wrk_1", name: "Default" }] })]);
		const workspaces = await fetchWorkspaces("st_1", fetchImpl);
		expect(workspaces).toEqual([{ id: "wrk_1", name: "Default" }]);
		expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer st_1");
	});

	test("asks the V2 config for the selected workspace and reports rejections", async () => {
		const { fetchImpl, calls } = stubFetch([
			() => json({ providers: { opencode: { models: {} } } }),
			() => json({ error: "nope" }, 403),
		]);
		const config = await fetchConsoleConfig(fetchImpl, "st_1", "wrk_1");
		expect(config.providers?.opencode).toBeDefined();
		expect((calls[0]!.init.headers as Record<string, string>)["x-org-id"]).toBe("wrk_1");

		const failure = fetchConsoleConfig(fetchImpl, "st_1", "wrk_bad");
		await expect(failure).rejects.toThrow(ConsoleError);
		await expect(failure.catch((error) => (error as ConsoleError).status)).resolves.toBe(403);
	});

	test("keeps a real client identity on every request", async () => {
		const { fetchImpl, calls } = stubFetch([() => json({ device_code: "d", user_code: "u", verification_uri: "https://opencode.ai/auth" })]);
		await requestDeviceCode(fetchImpl);
		expect((calls[0]!.init.headers as Record<string, string>)["User-Agent"]).toBeTruthy();
	});
});
