// User-visible strings. English is the default; Chinese is opt-in through the
// top-level `language` key in pi settings. pi itself has no locale layer, so the
// extension resolves the language on its own and renders the copy through i18next.

import i18next from "i18next";

export type Language = "en" | "zh";

export interface Messages {
	noData: string;
	limitTitle: string;
	window: { rolling: string; weekly: string; monthly: string };
	/** One limit row: indent, label, money, percent and the reset time. */
	limitRow(label: string, money: string, percent: string, reset: string): string;
	limitEmpty(label: string): string;
	usageTitle(range: string): string;
	usageEmpty: string;
	usageRow(model: string, requests: string, input: string, output: string, cache: string, cost: string): string;
	summary(label: string, requests: string, input: string, output: string, cache: string, cost: string): string;
	summaryLabel: string;
	requestUnit(count: number): string;
	daily(days: number, cost: string): string;
	diffTitle: string;
	diffEmpty: string;
	diffAdded(items: string): string;
	diffRemoved(items: string): string;
	diffDeprecated(items: string): string;
	diffUpdated(time: string): string;
	notLoggedIn: string;
	notes(text: string): string;
	invalidRange(range: string): string;
	refreshed: string;
	refreshFailed(error: string): string;
	completion: {
		status: string;
		usage: string;
		switchOrg: string;
		refresh: string;
		range(range: string): string;
	};
}

const resources = {
	en: {
		translation: {
			noData: "no data",
			limits: {
				title: "Limits",
				window: { rolling: "Rolling", weekly: "Weekly", monthly: "Monthly" },
				row: "   {{label}}: {{money}}, {{percent}}, resets {{reset}}",
				empty: "   {{label}}: no data",
			},
			usage: {
				title: "Usage ({{range}})",
				empty: "  no data",
				request_one: "request",
				request_other: "requests",
				row: "  {{model}}: {{requests}}, {{input}} tokens in, {{output}} tokens out, {{cache}} tokens cached, {{cost}}",
				row_unknown: "  {{model}}: {{requests}}, {{input}} tokens in, {{output}} tokens out, {{cache}} tokens cached, {{cost}}",
				summaryLabel: "Summary",
				summary: "  {{label}}: {{requests}}, {{input}} tokens in, {{output}} tokens out, {{cache}} tokens cached, {{cost}}",
				daily_one: "  Daily spend: {{count}} day, {{cost}} total",
				daily_other: "  Daily spend: {{count}} days, {{cost}} total",
			},
			diff: {
				title: "Catalog changes",
				empty: "  No changes",
				added: "  Added: {{items}}",
				removed: "  Removed: {{items}}",
				deprecated: "  Deprecated: {{items}}",
				updated: "  Last refresh: {{time}}",
			},
			auth: { notLoggedIn: "Not signed in. Run /login opencode to pick a workspace." },
			notes: "Notes: {{text}}",
			invalidRange: "Invalid range; showing {{range}}.",
			refresh: { ok: "Model catalog refreshed.", failed: "Refresh failed: {{error}}" },
			completion: {
				status: "providers, workspace and the model count from the last refresh",
				usage: "limits, per-model usage, account summary, daily spend and catalog diff",
				switchOrg: "switch workspace for this session only",
				refresh: "re-fetch the console catalog now",
				range: "{{range}} range",
			},
		},
	},
	zh: {
		translation: {
			noData: "无数据",
			limits: {
				title: "限额",
				window: { rolling: "滚动窗口", weekly: "每周", monthly: "每月" },
				row: "   {{label}}: {{money}}，{{percent}}，重置 {{reset}}",
				empty: "   {{label}}: 无数据",
			},
			usage: {
				title: "使用量（{{range}}）",
				empty: "  无数据",
				request_one: "次请求",
				request_other: "次请求",
				row: "  {{model}}: {{requests}}，输入 {{input}} tokens，输出 {{output}} tokens，缓存（读） {{cache}} tokens，{{cost}}",
				row_unknown: "  {{model}}: {{requests}}，输入 {{input}} tokens，输出 {{output}} tokens，缓存（读） {{cache}} tokens，{{cost}}",
				summaryLabel: "汇总",
				summary: "  {{label}}: {{requests}}，输入 {{input}} tokens，输出 {{output}} tokens，缓存（读） {{cache}} tokens，{{cost}}",
				daily_other: "  每日花费: {{count}} 天，合计 {{cost}}",
			},
			diff: {
				title: "模型目录变动",
				empty: "  无变化",
				added: "  新增: {{items}}",
				removed: "  移除: {{items}}",
				deprecated: "  转为下线: {{items}}",
				updated: "  上次刷新: {{time}}",
			},
			auth: { notLoggedIn: "未登录。运行 /login opencode 选择工作区。" },
			notes: "失败说明: {{text}}",
			invalidRange: "区间无效，按 {{range}} 显示。",
			refresh: { ok: "模型目录已刷新。", failed: "刷新失败: {{error}}" },
			completion: {
				status: "provider、工作区与最近一次刷新的模型条数",
				usage: "限额、按模型用量、账户汇总、每日花费与目录差异",
				switchOrg: "切换工作区，仅本会话有效",
				refresh: "强制重新拉取模型目录",
				range: "{{range}} 区间",
			},
		},
	},
} as const;

const i18n = i18next.createInstance();
void i18n.init({
	initAsync: false,
	lng: "en",
	fallbackLng: "en",
	resources,
	interpolation: { escapeValue: false },
	returnNull: false,
});

function translator(language: Language): Messages {
	const t = (key: string, options?: Record<string, unknown>): string =>
		i18n.t(key, { lng: language, ...options }) as string;
	return {
		noData: t("noData"),
		limitTitle: t("limits.title"),
		window: {
			rolling: t("limits.window.rolling"),
			weekly: t("limits.window.weekly"),
			monthly: t("limits.window.monthly"),
		},
		limitRow: (label, money, percent, reset) => t("limits.row", { label, money, percent, reset }),
		limitEmpty: (label) => t("limits.empty", { label }),
		usageTitle: (range) => t("usage.title", { range }),
		usageEmpty: t("usage.empty"),
		usageRow: (model, requests, input, output, cache, cost) => {
			const count = Number(requests);
			return Number.isFinite(count)
				? t("usage.row", { model, requests, input, output, cache, cost })
				: t("usage.row_unknown", { model, requests, input, output, cache, cost });
		},
		summary: (label, requests, input, output, cache, cost) =>
			t("usage.summary", { label, requests, input, output, cache, cost }),
		summaryLabel: t("usage.summaryLabel"),
		requestUnit: (count) => t("usage.request", { count }),
		daily: (days, cost) => t("usage.daily", { count: days, cost }),
		diffTitle: t("diff.title"),
		diffEmpty: t("diff.empty"),
		diffAdded: (items) => t("diff.added", { items }),
		diffRemoved: (items) => t("diff.removed", { items }),
		diffDeprecated: (items) => t("diff.deprecated", { items }),
		diffUpdated: (time) => t("diff.updated", { time }),
		notLoggedIn: t("auth.notLoggedIn"),
		notes: (text) => t("notes", { text }),
		invalidRange: (range) => t("invalidRange", { range }),
		refreshed: t("refresh.ok"),
		refreshFailed: (error) => t("refresh.failed", { error }),
		completion: {
			status: t("completion.status"),
			usage: t("completion.usage"),
			switchOrg: t("completion.switchOrg"),
			refresh: t("completion.refresh"),
			range: (range) => t("completion.range", { range }),
		},
	};
}

export const messages: Record<Language, Messages> = {
	en: translator("en"),
	zh: translator("zh"),
};

/** Traditional variants: no Traditional strings ship, so they fall back to English. */
const TRADITIONAL = /^zh-(hant|tw|hk|mo)(-|$)/;

/**
 * English unless the settings file selects Chinese.
 *
 * `zh` and its Simplified variants (`zh-Hans`, `zh-CN`, `zh-SG`) select Chinese;
 * Traditional variants (`zh-Hant`, `zh-TW`, `zh-HK`, `zh-MO`) fall back to English
 * because the extension has no Traditional copy.
 */
export function resolveLanguage(settings: unknown): Language {
	const value = (settings as { language?: unknown } | undefined)?.language;
	if (typeof value !== "string") return "en";
	const normalized = value.trim().toLowerCase().replace(/_/g, "-");
	if (TRADITIONAL.test(normalized)) return "en";
	return normalized === "zh" || normalized.startsWith("zh-") ? "zh" : "en";
}
