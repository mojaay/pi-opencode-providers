// Read-only monitors for OpenCode Go.
//
// Three sources, all probed on 2026-10-21:
//   GET /zen/go/v1/usage            quota percentages per window
//   GET /console/api/go/status      the same windows in micro-cents
//   GET /console/api/usage/*        per-model usage and summary
//
// The catalog snapshot is not an endpoint: it is the model list the providers
// already publish, compared against the previous successful result.

import { CONSOLE_BASE, USER_AGENT } from "./console.ts";
import { messages, type Language } from "./i18n.ts";

export const RANGES = ["24h", "7d", "30d"] as const;
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = "24h";

export type WindowKey = "rolling" | "weekly" | "monthly";

export interface LimitWindow {
	percent?: number;
	usedUSD?: number;
	limitUSD?: number;
	resetsAt?: string;
}

export interface GoLimits {
	rolling?: LimitWindow;
	weekly?: LimitWindow;
	monthly?: LimitWindow;
}

export interface UsageRow {
	model: string;
	requests?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	costUSD?: number;
}

export interface UsageSummary {
	requests?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	costUSD?: number;
}

export interface DailyCost {
	date: string;
	requests?: number;
	tokens?: number;
	costUSD?: number;
}

export interface UsageReport {
	rows: UsageRow[];
	summary?: UsageSummary;
}

export interface CatalogDiff {
	added: string[];
	removed: string[];
	deprecated: string[];
}

export interface MonitorSnapshot {
	models: string[];
	deprecated: string[];
	diff: CatalogDiff;
	notified: string;
	updatedAt: string;
}

export class MonitorError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "MonitorError";
	}
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

/** micro-cents are 1/100,000,000 USD. */
export function microCentsToUSD(value: unknown): number | undefined {
	const amount = num(value);
	return amount === undefined ? undefined : amount / 100_000_000;
}

export function formatUSD(value: number | undefined, noData = "no data"): string {
	return value === undefined ? noData : `$${value.toFixed(2)}`;
}

/** Token counts shrink to K, M or B so a million-digit row still fits one line. */
export function compactTokens(value: number): string {
	for (const [limit, suffix] of [
		[1e9, "B"],
		[1e6, "M"],
		[1e3, "K"],
	] as const) {
		if (Math.abs(value) >= limit) return `${(value / limit).toFixed(1)}${suffix}`;
	}
	return String(value);
}

async function getJson(
	fetchImpl: typeof fetch,
	url: string,
	token: string,
	orgID: string | undefined,
	signal?: AbortSignal,
): Promise<unknown> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		"User-Agent": USER_AGENT,
	};
	if (orgID) headers["x-org-id"] = orgID;
	const response = await fetchImpl(url, { headers, signal });
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new MonitorError(`${url}: HTTP ${response.status}${detail ? ` ${detail.slice(0, 120)}` : ""}`, response.status);
	}
	return response.json();
}

/** Percentages from /zen/go/v1/usage. Values are 0..100, not fractions. */
export function parseUsagePercentages(payload: unknown): GoLimits {
	const usage = record(record(payload).usage);
	const limits: GoLimits = {};
	for (const [wire, key] of [
		["rolling", "rolling"],
		["weekly", "weekly"],
		["monthly", "monthly"],
	] as const) {
		const window = record(usage[wire]);
		const percent = num(window.percent);
		const resetsAt = typeof window.resetsAt === "string" ? window.resetsAt : undefined;
		if (percent === undefined && resetsAt === undefined) continue;
		limits[key] = { ...(percent === undefined ? {} : { percent }), ...(resetsAt ? { resetsAt } : {}) };
	}
	return limits;
}

/** Money and reset times from /console/api/go/status. */
export function parseStatusMeters(payload: unknown): GoLimits {
	const meters = record(record(record(record(payload).access).meters));
	const limits: GoLimits = {};
	for (const [wire, key] of [
		["fiveHour", "rolling"],
		["week", "weekly"],
		["month", "monthly"],
	] as const) {
		const meter = record(meters[wire]);
		if (Object.keys(meter).length === 0) continue;
		const usedUSD = microCentsToUSD(meter.usedMicroCents);
		const limitUSD = microCentsToUSD(meter.limitMicroCents);
		const resetsAt = typeof meter.resetsAt === "string" ? meter.resetsAt : undefined;
		limits[key] = {
			...(usedUSD === undefined ? {} : { usedUSD }),
			...(limitUSD === undefined ? {} : { limitUSD }),
			...(resetsAt ? { resetsAt } : {}),
		};
	}
	return limits;
}

/** Merge the two limit payloads; percentages win for `percent`, meters for money. */
export function mergeLimits(percentages: GoLimits, meters: GoLimits): GoLimits {
	const merged: GoLimits = {};
	for (const key of ["rolling", "weekly", "monthly"] as const) {
		const a = percentages[key];
		const b = meters[key];
		if (!a && !b) continue;
		merged[key] = { ...b, ...a };
	}
	return merged;
}

export function parseUsageModels(payload: unknown): UsageRow[] {
	const items = record(payload).items;
	if (!Array.isArray(items)) return [];
	const rows: UsageRow[] = [];
	for (const raw of items) {
		const item = record(raw);
		if (item.provider !== "opencode-go") continue;
		const model = typeof item.model === "string" ? item.model : undefined;
		if (!model) continue;
		rows.push({
			model,
			requests: num(item.totalRequests),
			inputTokens: num(item.totalInputTokens),
			outputTokens: num(item.totalOutputTokens),
			cacheReadTokens: num(item.totalCacheReadTokens),
			costUSD: microCentsToUSD(item.totalCostMicroCents),
		});
	}
	return rows.sort((a, b) => (b.costUSD ?? 0) - (a.costUSD ?? 0));
}

export function parseUsageSummary(payload: unknown): UsageSummary {
	const body = record(payload);
	return {
		requests: num(body.totalRequests),
		inputTokens: num(body.totalInputTokens),
		outputTokens: num(body.totalOutputTokens),
		cacheReadTokens: num(body.totalCacheReadTokens),
		costUSD: microCentsToUSD(body.totalCostMicroCents),
	};
}

export function parseDailyCost(payload: unknown): DailyCost[] {
	if (!Array.isArray(payload)) return [];
	const days: DailyCost[] = [];
	for (const raw of payload) {
		const item = record(raw);
		const date = typeof item.date === "string" ? item.date : undefined;
		if (!date) continue;
		days.push({
			date,
			requests: num(item.totalRequests),
			tokens: num(item.totalTokens),
			costUSD: microCentsToUSD(item.totalCostMicroCents),
		});
	}
	return days;
}

export function parseRange(value: string | undefined): { range: Range; fellBack: boolean } {
	if (!value) return { range: DEFAULT_RANGE, fellBack: false };
	const candidate = value.trim().toLowerCase();
	if ((RANGES as readonly string[]).includes(candidate)) return { range: candidate as Range, fellBack: false };
	return { range: DEFAULT_RANGE, fellBack: true };
}

export function fetchGoUsage(
	fetchImpl: typeof fetch,
	token: string,
	orgID: string | undefined,
	signal?: AbortSignal,
): Promise<unknown> {
	return getJson(fetchImpl, `${CONSOLE_BASE.replace("/console", "")}/zen/go/v1/usage`, token, orgID, signal);
}

export function fetchGoStatus(
	fetchImpl: typeof fetch,
	token: string,
	orgID: string | undefined,
	signal?: AbortSignal,
): Promise<unknown> {
	return getJson(fetchImpl, `${CONSOLE_BASE}/api/go/status`, token, orgID, signal);
}

export function fetchUsageModels(
	fetchImpl: typeof fetch,
	token: string,
	orgID: string | undefined,
	range: Range,
	signal?: AbortSignal,
): Promise<unknown> {
	return getJson(fetchImpl, `${CONSOLE_BASE}/api/usage/models?range=${range}`, token, orgID, signal);
}

export function fetchUsageSummary(
	fetchImpl: typeof fetch,
	token: string,
	orgID: string | undefined,
	range: Range,
	signal?: AbortSignal,
): Promise<unknown> {
	return getJson(fetchImpl, `${CONSOLE_BASE}/api/usage/summary?range=${range}`, token, orgID, signal);
}

/**
 * Not used right now. The endpoint answers with a fixed 34-day window and takes no
 * range parameter, so it cannot answer "spend in the selected range" and folding
 * it into one total stops being daily data. Kept for a future per-day display.
 */
export function fetchDailyCost(
	fetchImpl: typeof fetch,
	token: string,
	orgID: string | undefined,
	signal?: AbortSignal,
): Promise<unknown> {
	return getJson(fetchImpl, `${CONSOLE_BASE}/api/usage/cost-by-day`, token, orgID, signal);
}

/**
 * A 60 second cache with in-flight de-duplication. A failed load keeps the last
 * good value available through `peek` so callers can show stale numbers plus
 * the reason the refresh failed.
 */
export class ResponseCache {
	private readonly entries = new Map<string, { at: number; value: unknown }>();
	private readonly inflight = new Map<string, Promise<unknown>>();

	constructor(
		private readonly ttlMs = 60_000,
		private readonly now: () => number = Date.now,
	) {}

	peek(key: string): unknown {
		return this.entries.get(key)?.value;
	}

	clear(): void {
		this.entries.clear();
		this.inflight.clear();
	}

	async run<T>(key: string, loader: () => Promise<T>): Promise<T> {
		const hit = this.entries.get(key);
		if (hit && this.now() - hit.at < this.ttlMs) return hit.value as T;
		const running = this.inflight.get(key);
		if (running) return running as Promise<T>;
		const pending = loader()
			.then((value) => {
				this.entries.set(key, { at: this.now(), value });
				return value;
			})
			.finally(() => {
				this.inflight.delete(key);
			});
		this.inflight.set(key, pending);
		return pending;
	}
}

export function diffCatalogs(previous: { models: string[]; deprecated: string[] }, next: { models: string[]; deprecated: string[] }): CatalogDiff {
	const before = new Set(previous.models);
	const after = new Set(next.models);
	const beforeDeprecated = new Set(previous.deprecated);
	return {
		added: next.models.filter((id) => !before.has(id)).sort(),
		removed: previous.models.filter((id) => !after.has(id)).sort(),
		deprecated: next.deprecated.filter((id) => !beforeDeprecated.has(id)).sort(),
	};
}

export function diffFingerprint(diff: CatalogDiff): string {
	if (diff.added.length === 0 && diff.removed.length === 0 && diff.deprecated.length === 0) return "";
	return [diff.added.join(","), diff.removed.join(","), diff.deprecated.join(",")].join("|");
}

function percentText(window: LimitWindow | undefined, label: string): string {
	return window?.percent === undefined ? `${label} -` : `${label} ${window.percent}%`;
}

/** The single status-bar line: `GO [5h 3% · 7d 17% · 30d 21%]`. */
export function formatStatusLine(limits: GoLimits): string {
	const body = [percentText(limits.rolling, "5h"), percentText(limits.weekly, "7d"), percentText(limits.monthly, "30d")].join(" · ");
	return `GO [${body}]`;
}

/** Terminal cells occupied by a string: CJK and fullwidth characters take two. */
export function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		width += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ? 2 : 1;
	}
	return width;
}

/** Local time, 24-hour clock, regardless of the locale default. */
function formatTimestamp(value: string | number): string {
	return new Date(value).toLocaleString(undefined, { hourCycle: "h23" });
}

function padStartWidth(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - displayWidth(text))) + text;
}

function padEndWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

export function formatLimits(limits: GoLimits, error?: string, language: Language = "en"): string {
	const t = messages[language];
	const rows = [
		{ label: t.window.rolling, window: limits.rolling },
		{ label: t.window.weekly, window: limits.weekly },
		{ label: t.window.monthly, window: limits.monthly },
	];
	const labelWidth = Math.max(...rows.map(({ label }) => displayWidth(label)));
	const money = rows.map(({ window }) =>
		window?.usedUSD === undefined || window.limitUSD === undefined
			? undefined
			: { used: formatUSD(window.usedUSD, t.noData), limit: formatUSD(window.limitUSD, t.noData) },
	);
	const usedWidth = Math.max(0, ...money.map((entry) => (entry ? displayWidth(entry.used) : 0)));
	const percentWidth = Math.max(
		0,
		...rows.map(({ window }) =>
			window ? displayWidth(window.percent === undefined ? t.noData : `${window.percent}%`) : 0,
		),
	);
	const lines: string[] = [t.limitTitle];
	rows.forEach(({ label, window }, index) => {
		const padded = padEndWidth(label, labelWidth);
		if (!window) {
			lines.push(t.limitEmpty(padded));
			return;
		}
		const percent = window.percent === undefined ? t.noData : `${window.percent}%`;
		const entry = money[index];
		const moneyText = entry ? `${padStartWidth(entry.used, usedWidth)} / ${entry.limit}` : t.noData;
		const percentText = padStartWidth(percent, percentWidth);
		const reset = window.resetsAt ? formatTimestamp(window.resetsAt) : t.noData;
		lines.push(t.limitRow(padded, moneyText, percentText, reset));
	});
	if (error) lines.push(`  ! ${error}`);
	return lines.join("\n");
}

export function formatUsage(report: UsageReport, range: Range, language: Language = "en"): string {
	const t = messages[language];
	const lines: string[] = [t.usageTitle(range)];
	const rows = report.rows.map((row) => ({
		label: row.model,
		requests: row.requests === undefined ? t.noData : String(row.requests),
		input: row.inputTokens === undefined ? t.noData : compactTokens(row.inputTokens),
		output: row.outputTokens === undefined ? t.noData : compactTokens(row.outputTokens),
		cache: row.cacheReadTokens === undefined ? t.noData : compactTokens(row.cacheReadTokens),
		cost: formatUSD(row.costUSD, t.noData),
	}));
	const summary = report.summary;
	const summaryRow = summary
		? {
				label: t.summaryLabel,
				requests: summary.requests === undefined ? t.noData : String(summary.requests),
				input: summary.inputTokens === undefined ? t.noData : compactTokens(summary.inputTokens),
				output: summary.outputTokens === undefined ? t.noData : compactTokens(summary.outputTokens),
				cache: summary.cacheReadTokens === undefined ? t.noData : compactTokens(summary.cacheReadTokens),
				cost: formatUSD(summary.costUSD, t.noData),
			}
		: undefined;
	const unit = (requests: string) => {
		const count = Number(requests);
		return t.requestUnit(Number.isFinite(count) ? count : 2);
	};
	// A singular unit is one character shorter, so keep the whole cell together.
	const cell = (requests: string) => (Number.isFinite(Number(requests)) ? `${requests} ${unit(requests)}` : requests);
	const widest = (pick: (row: (typeof rows)[number]) => string) =>
		Math.max(0, ...rows.map((row) => displayWidth(pick(row))), ...(summaryRow ? [displayWidth(pick(summaryRow))] : []));
	const widths = {
		label: widest((row) => row.label),
		requests: widest((row) => cell(row.requests)),
		input: widest((row) => row.input),
		output: widest((row) => row.output),
		cache: widest((row) => row.cache),
		cost: widest((row) => row.cost),
	};
	const line = (row: (typeof rows)[number]) =>
		t.usageRow(
			padEndWidth(row.label, widths.label),
			padStartWidth(cell(row.requests), widths.requests),
			padStartWidth(row.input, widths.input),
			padStartWidth(row.output, widths.output),
			padStartWidth(row.cache, widths.cache),
			padStartWidth(row.cost, widths.cost),
		);
	if (rows.length === 0) {
		lines.push(t.usageEmpty);
	} else {
		for (const row of rows) lines.push(line(row));
	}
	if (summaryRow) {
		lines.push(
			t.summary(
				padEndWidth(summaryRow.label, widths.label),
				padStartWidth(cell(summaryRow.requests), widths.requests),
				padStartWidth(summaryRow.input, widths.input),
				padStartWidth(summaryRow.output, widths.output),
				padStartWidth(summaryRow.cache, widths.cache),
				padStartWidth(summaryRow.cost, widths.cost),
			),
		);
	}
	return lines.join("\n");
}

export function formatDiff(
	diff: CatalogDiff,
	snapshot?: Pick<MonitorSnapshot, "updatedAt">,
	language: Language = "en",
): string {
	const t = messages[language];
	const lines: string[] = [t.diffTitle];
	const empty = diff.added.length === 0 && diff.removed.length === 0 && diff.deprecated.length === 0;
	if (empty) lines.push(t.diffEmpty);
	if (diff.added.length > 0) lines.push(t.diffAdded(diff.added.join(", ")));
	if (diff.removed.length > 0) lines.push(t.diffRemoved(diff.removed.join(", ")));
	if (diff.deprecated.length > 0) lines.push(t.diffDeprecated(diff.deprecated.join(", ")));
	if (snapshot?.updatedAt) lines.push(t.diffUpdated(formatTimestamp(snapshot.updatedAt)));
	return lines.join("\n");
}
