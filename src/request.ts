// Per-provider request wrapping.
//
// Go needs a routing header on every request; Zen needs its identity headers on
// zero-cost models only. Both take pi's session id when it is available, which
// keeps the extension isomorphic with the real client without inventing values.

import type { ProviderStreams } from "@earendil-works/pi-ai";
import { isZeroCost } from "./catalog.ts";

/** The identity gate accepts a versioned opencode user agent; a bare one is rejected. */
export const GATE_USER_AGENT = "opencode/latest/2.0.32/cli";

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * The gateway decodes the low 12 bits of the time half as a counter and only
 * accepts values up to 63 (anything above answers 403 for zero-cost models).
 * The counter walks that range in order and wraps around, so consecutive ids
 * differ. The client itself always sends 1; the gate accepts the whole range.
 */
export const MAX_SESSION_COUNTER = 63;
const TIME_MASK = (1n << 36n) - 1n;

let counter = 0;

/** Next counter in the accepted range, wrapping after the last one. */
export function sessionCounter(): number {
	counter = (counter % MAX_SESSION_COUNTER) + 1;
	return counter;
}

/** @internal Test hook: restarts the counter sequence. */
export function resetSessionCounterForTests(): void {
	counter = 0;
}

/** Session id shaped like the client's: a time half the gateway can decode plus a random tail. */
export function sessionId(now = Date.now()): string {
	const current = BigInt(now) * 0x1000n + BigInt(sessionCounter());
	const value = ~current & ((1n << 48n) - 1n);
	const time = value.toString(16).padStart(12, "0").slice(-12);
	const bytes = new Uint8Array(14);
	crypto.getRandomValues(bytes);
	return `ses_${time}${Array.from(bytes, (byte) => B62[byte % 62]).join("")}`;
}

/** Counter recovered from a minted id, for tests and for re-deriving the wire shape. */
export function sessionCounterOf(id: string): number {
	const value = BigInt(`0x${id.slice(4, 16)}`);
	const current = ~value & ((1n << 48n) - 1n);
	return Number(current & 0xfffn);
}

/** Time encoded in a minted id, in milliseconds (wraps every 2^36 ms). */
export function sessionTimeOf(id: string): number {
	const value = ~BigInt(`0x${id.slice(4, 16)}`) & ((1n << 48n) - 1n);
	return Number((value >> 12n) & TIME_MASK);
}

/** Go routes every request by session; a missing header answers 400 MissingSessionID. */
export function goSessionHeaders(session: string): Record<string, string> {
	return { "x-opencode-session": session };
}

/**
 * Zero-cost Zen models are only reachable from a request that identifies as the
 * opencode client. This is the only place the extension presents itself as
 * another client, and it is scoped to zero-cost models.
 */
export function identityHeaders(session: string): Record<string, string> {
	return {
		"User-Agent": GATE_USER_AGENT,
		"x-opencode-client": "cli",
		"x-opencode-session": session,
		"x-opencode-session-id": session,
	};
}

type StreamFn = (...args: never[]) => unknown;

function withHeaders(streams: ProviderStreams, headersFor: (model: unknown, options: unknown) => Record<string, string> | undefined): ProviderStreams {
	const source = streams as unknown as Record<string, StreamFn>;
	const wrap = (fn: StreamFn) => (model: never, context: never, options?: never) => {
		const opts = (options ?? {}) as Record<string, unknown>;
		const extra = headersFor(model, opts);
		if (!extra) return fn(model, context, options as never);
		const headers = { ...((opts.headers as Record<string, string>) ?? {}), ...extra };
		return fn(model, context, { ...opts, headers } as never);
	};
	return { ...streams, stream: wrap(source.stream!), streamSimple: wrap(source.streamSimple!) } as ProviderStreams;
}

function sessionFor(options: Record<string, unknown>): string {
	const provided = options.sessionId;
	return typeof provided === "string" && provided ? provided : sessionId();
}

/** Go: attach the routing header to every request. */
export function withGoSession(streams: ProviderStreams): ProviderStreams {
	return withHeaders(streams, (_model, options) => goSessionHeaders(sessionFor(options as Record<string, unknown>)));
}

/** Zen: attach the identity header set to zero-cost models only. */
export function withZeroCostIdentity(streams: ProviderStreams): ProviderStreams {
	return withHeaders(streams, (model, options) =>
		isZeroCost(model as { cost?: { input?: number; output?: number } }) ? identityHeaders(sessionFor(options as Record<string, unknown>)) : undefined,
	);
}
