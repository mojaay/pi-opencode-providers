import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compactTokens,
	displayWidth,
	diffCatalogs,
	diffFingerprint,
	fetchGoStatus,
	fetchGoUsage,
	fetchUsageModels,
	formatLimits,
	formatStatusLine,
	formatUsage,
	mergeLimits,
	microCentsToUSD,
	parseDailyCost,
	parseRange,
	parseStatusMeters,
	parseUsageModels,
	parseUsageSummary,
	parseUsagePercentages,
	ResponseCache,
} from "../src/monitor.ts";
import { readSnapshot, snapshotFrom, updateSnapshot, writeSnapshot } from "../src/snapshot.ts";

interface Call {
	url: string;
	init: RequestInit;
}

function stubFetch(body: unknown, status = 200): { fetchImpl: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		return new Response(JSON.stringify(body), { status });
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

const usagePayload = {
	usage: {
		rolling: { status: "ok", percent: 3, resetsAt: "2026-10-21T13:19:18.000Z" },
		weekly: { status: "ok", percent: 17, resetsAt: "2026-10-26T00:00:00.000Z" },
		monthly: { status: "ok", percent: 21, resetsAt: "2026-11-17T19:04:51.000Z" },
	},
};

const statusPayload = {
	access: {
		meters: {
			fiveHour: { usedMicroCents: "40795590", limitMicroCents: "1200000000", resetsAt: "2026-10-21T13:19:18.000Z" },
			week: { usedMicroCents: "521812446", limitMicroCents: "3000000000", resetsAt: "2026-10-26T00:00:00.000Z" },
			month: { usedMicroCents: "1291545139", limitMicroCents: "6000000000", resetsAt: "2026-11-17T19:04:51.000Z" },
		},
	},
};

describe("limits", () => {
	test("reads percentages verbatim", () => {
		const limits = parseUsagePercentages(usagePayload);
		expect(limits.rolling?.percent).toBe(3);
		expect(limits.weekly?.percent).toBe(17);
		expect(limits.monthly?.percent).toBe(21);
	});

	test("converts micro-cents to USD", () => {
		const limits = parseStatusMeters(statusPayload);
		expect(limits.rolling?.usedUSD).toBeCloseTo(0.4079559);
		expect(limits.rolling?.limitUSD).toBe(12);
		expect(microCentsToUSD("6000000000")).toBe(60);
	});

	test("merges percent and money per window", () => {
		const limits = mergeLimits(parseUsagePercentages(usagePayload), parseStatusMeters(statusPayload));
		expect(limits.rolling?.percent).toBe(3);
		expect(limits.rolling?.limitUSD).toBe(12);
	});

	test("keeps a missing month missing", () => {
		const limits = parseStatusMeters({ access: { meters: { fiveHour: { limitMicroCents: "1" }, week: { limitMicroCents: "2" } } } });
		expect(limits.monthly).toBeUndefined();
		expect(limits.rolling?.limitUSD).toBeCloseTo(0.00000001);
	});

	test("formats the status line and marks missing windows", () => {
		const limits = mergeLimits(parseUsagePercentages(usagePayload), {});
		expect(formatStatusLine(limits)).toBe("GO [5h 3% · 7d 17% · 30d 21%]");
		expect(formatStatusLine({ rolling: { percent: 3 } })).toBe("GO [5h 3% · 7d - · 30d -]");
	});

	test("formats no data without printing 0%", () => {
		const text = formatLimits({}, "HTTP 401");
		expect(text).toContain("no data");
		expect(text).not.toContain("0%");
		expect(text).toContain("HTTP 401");
		expect(formatLimits({}, undefined, "zh")).toContain("无数据");
	});

	test("aligns the money and percent columns", () => {
		const limits = {
			rolling: { usedUSD: 0.68, limitUSD: 12, percent: 5 },
			weekly: { usedUSD: 6.53, limitUSD: 30, percent: 21 },
			monthly: { usedUSD: 14.23, limitUSD: 60, percent: 23 },
		};
		const rows = formatLimits(limits).split("\n").slice(1);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toContain(" $0.68 / $12.00,  5%");
		expect(rows[1]).toContain(" $6.53 / $30.00, 21%");
		expect(rows[2]).toContain("$14.23 / $60.00, 23%");
	});

	test("keeps the Chinese layout when asked for it", () => {
		const rows = formatLimits(
			{
				rolling: { usedUSD: 0.68, limitUSD: 12, percent: 5 },
				weekly: { usedUSD: 6.53, limitUSD: 30, percent: 21 },
				monthly: { usedUSD: 14.23, limitUSD: 60, percent: 23 },
			},
			undefined,
			"zh",
		)
			.split("\n")
			.slice(1);
		expect(rows[0]).toContain(" $0.68 / $12.00， 5%");
		expect(rows[1]).toContain(" $6.53 / $30.00，21%");
		expect(rows[2]).toContain("$14.23 / $60.00，23%");
	});
});

describe("usage", () => {
	const payload = {
		items: [
			{ model: "zen-model", provider: "opencode", totalRequests: "1", totalCostMicroCents: "100" },
			{ model: "deepseek-v4.1-flash", provider: "opencode-go", totalRequests: "515", totalInputTokens: "10", totalOutputTokens: "20", totalCacheReadTokens: "9000", totalCostMicroCents: "124767674" },
			{ model: "kimi-k3", provider: "opencode-go", totalRequests: "3", totalCostMicroCents: "900000000" },
		],
	};

	test("keeps only Go rows and sorts by cost", () => {
		const rows = parseUsageModels(payload);
		expect(rows.map((row) => row.model)).toEqual(["kimi-k3", "deepseek-v4.1-flash"]);
		expect(rows[1]?.requests).toBe(515);
		expect(rows[1]?.cacheReadTokens).toBe(9000);
		expect(rows[1]?.costUSD).toBeCloseTo(1.24767674);
	});

	test("returns empty for a missing list", () => {
		expect(parseUsageModels({})).toEqual([]);
	});

	test("reads summary and daily cost", () => {
		expect(parseUsageSummary({ totalRequests: "40340", totalCostMicroCents: "1781642124" }).costUSD).toBeCloseTo(17.81642124);
		const days = parseDailyCost([
			{ date: "2026-10-20", totalCostMicroCents: "100000000", totalRequests: "2", totalTokens: "3" },
		]);
		expect(days).toHaveLength(1);
		expect(days[0]?.costUSD).toBe(1);
	});

	test("falls back to 24h for an invalid range", () => {
		expect(parseRange("7d")).toEqual({ range: "7d", fellBack: false });
		expect(parseRange("12h")).toEqual({ range: "24h", fellBack: true });
		expect(parseRange(undefined)).toEqual({ range: "24h", fellBack: false });
	});

	test("prints no data for an empty report", () => {
		expect(formatUsage({ rows: [] }, "24h")).toContain("no data");
	});

	test("aligns model names in both languages", () => {
		const report = {
			rows: [
				{ model: "kimi-k3", requests: 1 },
				{ model: "deepseek-v4.1-flash", requests: 2 },
			],
		};
		for (const language of ["en", "zh"] as const) {
			const rows = formatUsage(report, "24h", language).split("\n").slice(1);
			expect(new Set(rows.map((line) => line.indexOf(":"))).size).toBe(1);
		}
	});

	test("prints the cache read count in both languages", () => {
		const report = { rows: [{ model: "m", requests: 1, cacheReadTokens: 9000 }] };
		expect(formatUsage(report, "24h")).toContain("9.0K tokens cached");
		expect(formatUsage(report, "24h", "zh")).toContain("缓存（读） 9.0K tokens");
	});

	test("compacts token counts", () => {
		expect(compactTokens(999)).toBe("999");
		expect(compactTokens(1234)).toBe("1.2K");
		expect(compactTokens(707789)).toBe("707.8K");
		expect(compactTokens(11764662)).toBe("11.8M");
		expect(compactTokens(144827264)).toBe("144.8M");
	});

	test("aligns every numeric column, summary included", () => {
		const report = {
			rows: [
				{ model: "deepseek-v4.1-flash", requests: 9225, inputTokens: 54_100_000, outputTokens: 10_500_000, cacheReadTokens: 1_300_000_000, costUSD: 19.81 },
				{ model: "grok-4.7", requests: 1, inputTokens: 91, outputTokens: 42, cacheReadTokens: 1200, costUSD: 0 },
			],
			summary: { requests: 9226, inputTokens: 54_100_091, outputTokens: 10_500_042, cacheReadTokens: 1_300_001_200, costUSD: 19.82 },
		};
		for (const [language, comma] of [
			["en", ","],
			["zh", "，"],
		] as const) {
			const lines = formatUsage(report, "30d", language).split("\n").slice(1);
			expect(lines).toHaveLength(3);
			const marks = lines.map((line) => {
				const positions: number[] = [];
				let width = 0;
				for (const char of line) {
					if (char === comma) positions.push(width);
					width += displayWidth(char);
				}
				return positions;
			});
			expect(marks[0]).toHaveLength(4);
			const first = marks[0] ?? [];
			for (const row of marks) expect(row).toEqual(first);
		}
	});

	test("uses singular copy for a count of one", () => {
		const report = {
			rows: [{ model: "kimi-k3", requests: 1 }],
			summary: { requests: 1 },
		};
		const text = formatUsage(report, "24h");
		expect(text).toContain("1 request,");
		expect(text).not.toContain("1 requests");
	});
});

describe("cache", () => {
	test("reuses a value for 60 seconds", async () => {
		let now = 0;
		let loads = 0;
		const cache = new ResponseCache(60_000, () => now);
		const load = () => cache.run("k", async () => {
			loads += 1;
			return loads;
		});
		expect(await load()).toBe(1);
		now = 59_000;
		expect(await load()).toBe(1);
		now = 61_000;
		expect(await load()).toBe(2);
		expect(loads).toBe(2);
	});

	test("shares one in-flight request", async () => {
		let loads = 0;
		let release: (value: number) => void = () => undefined;
		const cache = new ResponseCache();
		const loader = () =>
			cache.run("k", () => {
				loads += 1;
				return new Promise<number>((resolve) => {
					release = resolve;
				});
			});
		const first = loader();
		const second = loader();
		release(7);
		expect(await first).toBe(7);
		expect(await second).toBe(7);
		expect(loads).toBe(1);
	});

	test("keeps the last good value after a failure", async () => {
		const cache = new ResponseCache(0);
		await cache.run("k", async () => "ok");
		await expect(cache.run("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
		expect(cache.peek("k")).toBe("ok");
	});
});

describe("catalog diff", () => {
	const previous = { models: ["a", "b", "c"], deprecated: ["c"] };

	test("classifies added, removed and newly deprecated", () => {
		const diff = diffCatalogs(previous, { models: ["a", "b", "d"], deprecated: ["c", "b"] });
		expect(diff.added).toEqual(["d"]);
		expect(diff.removed).toEqual(["c"]);
		expect(diff.deprecated).toEqual(["b"]);
	});

	test("reports no changes for identical catalogs", () => {
		const diff = diffCatalogs(previous, previous);
		expect(diffFingerprint(diff)).toBe("");
	});

	test("first run records a baseline without notifying", () => {
		const update = updateSnapshot(undefined, ["b", "a"], []);
		expect(update.snapshot.models).toEqual(["a", "b"]);
		expect(update.diff).toEqual({ added: [], removed: [], deprecated: [] });
		expect(update.notify).toBe(false);
	});

	test("notifies once per diff fingerprint", () => {
		const first = updateSnapshot(undefined, ["a"], []);
		const changed = updateSnapshot(first.snapshot, ["a", "b"], []);
		expect(changed.notify).toBe(true);
		const repeat = updateSnapshot(changed.snapshot, ["a", "b"], []);
		expect(repeat.notify).toBe(false);
	});

	test("treats a corrupt file as a first run", async () => {
		const dir = await mkdtemp(join(tmpdir(), "monitor-"));
		const path = join(dir, "snapshot.json");
		try {
			await writeFile(path, "{not json", "utf8");
			expect(await readSnapshot(path)).toBeUndefined();
			expect(snapshotFrom({ models: [] })).toBeUndefined();
			const update = updateSnapshot(undefined, ["a"], []);
			await writeSnapshot(update.snapshot, path);
			expect((await readSnapshot(path))?.models).toEqual(["a"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("requests", () => {
	test("sends bearer, user agent and org header", async () => {
		const { fetchImpl, calls } = stubFetch(usagePayload);
		await fetchGoUsage(fetchImpl, "tok", "org_1");
		const call = calls[0]!;
		expect(call.url).toBe("https://opencode.ai/zen/go/v1/usage");
		expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
		expect((call.init.headers as Record<string, string>)["x-org-id"]).toBe("org_1");
	});

	test("builds the console status and usage URLs", async () => {
		const status = stubFetch(statusPayload);
		await fetchGoStatus(status.fetchImpl, "tok", undefined);
		expect(status.calls[0]?.url).toBe("https://opencode.ai/console/api/go/status");

		const usage = stubFetch({ items: [] });
		await fetchUsageModels(usage.fetchImpl, "tok", "org_1", "7d");
		expect(usage.calls[0]?.url).toBe("https://opencode.ai/console/api/usage/models?range=7d");
	});

	test("throws with the status on a failed response", async () => {
		const { fetchImpl } = stubFetch({}, 401);
		await expect(fetchGoUsage(fetchImpl, "tok", "org_1")).rejects.toThrow("HTTP 401");
	});
});
