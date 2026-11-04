import { describe, expect, test } from "bun:test";
import { messages, resolveLanguage } from "../src/i18n.ts";

describe("language", () => {
	test("defaults to English", () => {
		expect(resolveLanguage(undefined)).toBe("en");
		expect(resolveLanguage({})).toBe("en");
		expect(resolveLanguage({ language: "fr" })).toBe("en");
		expect(resolveLanguage({ opencode: { language: "zh" } })).toBe("en");
	});

	test("reads the top-level Chinese opt-in", () => {
		expect(resolveLanguage({ language: "zh" })).toBe("zh");
		expect(resolveLanguage({ language: " ZH " })).toBe("zh");
		expect(resolveLanguage({ language: "zh-Hans" })).toBe("zh");
		expect(resolveLanguage({ language: "zh-CN" })).toBe("zh");
		expect(resolveLanguage({ language: "en" })).toBe("en");
	});

	test("falls back to English for Traditional variants", () => {
		for (const language of ["zh-Hant", "zh-TW", "zh-HK", "zh-MO", "zh-Hant-TW", "fr"]) {
			expect(resolveLanguage({ language })).toBe("en");
		}
	});

	test("keeps both message tables complete", () => {
		expect(messages.en.limitTitle).toBe("Limits");
		expect(messages.zh.limitTitle).toBe("限额");
		expect(Object.keys(messages.en).sort()).toEqual(Object.keys(messages.zh).sort());
	});
});
