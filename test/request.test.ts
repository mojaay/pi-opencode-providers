import { describe, expect, test } from "bun:test";
import type { ProviderStreams } from "@earendil-works/pi-ai";
import { GATE_USER_AGENT, goSessionHeaders, identityHeaders, MAX_SESSION_COUNTER, resetSessionCounterForTests, sessionCounterOf, sessionId, sessionTimeOf, withGoSession, withZeroCostIdentity } from "../src/request.ts";

interface Recorded {
	model: unknown;
	options: Record<string, unknown> | undefined;
}

function recordingStreams(): { streams: ProviderStreams; recorded: Recorded[] } {
	const recorded: Recorded[] = [];
	const streams = {
		stream: (model: never, _context: never, options?: never) => {
			recorded.push({ model, options: options as Record<string, unknown> | undefined });
			return "stream";
		},
		streamSimple: (model: never, _context: never, options?: never) => {
			recorded.push({ model, options: options as Record<string, unknown> | undefined });
			return "simple";
		},
	} as unknown as ProviderStreams;
	return { streams, recorded };
}

describe("session identity", () => {
	test("mints a client-shaped session id", () => {
		expect(sessionId()).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
	});

	test("walks the accepted counter range in order and wraps", () => {
		resetSessionCounterForTests();
		const counters = Array.from({ length: MAX_SESSION_COUNTER + 2 }, () => sessionCounterOf(sessionId()));
		expect(counters.slice(0, MAX_SESSION_COUNTER)).toEqual(Array.from({ length: MAX_SESSION_COUNTER }, (_, index) => index + 1));
		expect(counters.slice(MAX_SESSION_COUNTER)).toEqual([1, 2]);
	});

	test("keeps the creation time in the time half", () => {
		const now = Date.now();
		const decoded = sessionTimeOf(sessionId(now));
		expect(decoded).toBe(now % 2 ** 36);
	});

	test("go needs one routing header and zen needs the full identity set", () => {
		expect(goSessionHeaders("ses_x")).toEqual({ "x-opencode-session": "ses_x" });
		expect(identityHeaders("ses_x")).toEqual({
			"User-Agent": GATE_USER_AGENT,
			"x-opencode-client": "cli",
			"x-opencode-session": "ses_x",
			"x-opencode-session-id": "ses_x",
		});
	});
});

describe("go wrapping", () => {
	test("adds the routing header to both entry points and keeps the caller's headers", () => {
		const { streams, recorded } = recordingStreams();
		const wrapped = withGoSession(streams);
		wrapped.stream({ id: "m" } as never, {} as never, { headers: { "x-custom": "1" }, sessionId: "ses_given" } as never);
		wrapped.streamSimple({ id: "m" } as never, {} as never, undefined as never);

		expect(recorded[0]!.options?.headers).toEqual({ "x-custom": "1", "x-opencode-session": "ses_given" });
		const generated = (recorded[1]!.options?.headers as Record<string, string>)["x-opencode-session"];
		expect(generated).toMatch(/^ses_/);
	});
});

describe("zen wrapping", () => {
	test("attaches the identity headers to zero-cost models only", () => {
		const { streams, recorded } = recordingStreams();
		const wrapped = withZeroCostIdentity(streams);
		wrapped.stream({ id: "free", cost: { input: 0, output: 0 } } as never, {} as never, undefined as never);
		wrapped.stream({ id: "paid", cost: { input: 1, output: 2 } } as never, {} as never, undefined as never);

		const free = recorded[0]!.options?.headers as Record<string, string>;
		expect(free["x-opencode-client"]).toBe("cli");
		expect(free["User-Agent"]).toBe(GATE_USER_AGENT);
		expect(recorded[1]!.options).toBeUndefined();
	});

	test("judges cost, not the id suffix", () => {
		const { streams, recorded } = recordingStreams();
		const wrapped = withZeroCostIdentity(streams);
		wrapped.stream({ id: "named-free-but-paid", cost: { input: 0, output: 0.5 } } as never, {} as never, undefined as never);
		expect(recorded[0]!.options).toBeUndefined();
	});
});
