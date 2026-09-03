import { describe, expect, it } from "vitest";
import { slugify, traceFileName } from "../src/base/naming.js";

function sess(id: string, startedAt: string): { sessionId: string; startedAt: string } {
	return { sessionId: id, startedAt };
}

describe("naming slugify", () => {
	it("lowercases latin text and dashes separators", () => {
		expect(slugify("Fix Auth Bug!")).toBe("fix-auth-bug");
		expect(slugify("Fix  Auth -- Bug!!!")).toBe("fix-auth-bug"); // runs collapse to one dash
	});

	it("keeps cyrillic letters", () => {
		expect(slugify("Починить тесты в apps/dist")).toBe("починить-тесты-в-apps-dist");
		expect(slugify("Рефакторинг v2 API")).toBe("рефакторинг-v2-api");
	});

	it("strips leading and trailing separators", () => {
		expect(slugify("--hello world--")).toBe("hello-world");
		expect(slugify("...")).toBe("session"); // nothing left → fallback
	});

	it("caps length at 40 chars and never ends with a dash", () => {
		expect(slugify("abc ".repeat(10))).toBe("abc-".repeat(9) + "abc"); // dash at the cap is trimmed
		const long = slugify("an extremely long session title that goes on and on and on");
		expect(long.length).toBeLessThanOrEqual(40);
		expect(long.endsWith("-")).toBe(false);
	});

	it("falls back to 'session' for empty or punctuation-only titles", () => {
		expect(slugify("")).toBe("session");
		expect(slugify("!!! ???")).toBe("session");
		expect(slugify("— – -")).toBe("session");
	});
});

describe("naming traceFileName", () => {
	it("formats as <date>-<id8>-<slug>.md", () => {
		expect(traceFileName([sess("abcdef1234567890", "2026-05-12T10:00:00Z")], "Fix auth")).toBe(
			"2026-05-12-abcdef12-fix-auth.md",
		);
	});

	it("chains up to three id8s, then marks the rest with +etc", () => {
		const four = [
			sess("1111111111111111", "2026-01-01T00:00:00Z"),
			sess("2222222222222222", "2026-01-01T01:00:00Z"),
			sess("3333333333333333", "2026-01-01T02:00:00Z"),
			sess("4444444444444444", "2026-01-01T03:00:00Z"),
		];
		expect(traceFileName(four.slice(0, 3), "x")).toBe("2026-01-01-11111111+22222222+33333333-x.md");
		expect(traceFileName(four, "x")).toBe("2026-01-01-11111111+22222222+33333333+etc-x.md");
	});

	it("takes the date from the first session", () => {
		expect(
			traceFileName([sess("11111111", "2026-01-01T00:00:00Z"), sess("22222222", "2026-02-02T00:00:00Z")], "t"),
		).toBe("2026-01-01-11111111+22222222-t.md");
	});

	it("falls back to the 'session' slug when the title is missing", () => {
		expect(traceFileName([sess("1111111111111111", "2026-01-01T00:00:00Z")], undefined)).toBe(
			"2026-01-01-11111111-session.md",
		);
		expect(traceFileName([sess("1111111111111111", "2026-01-01T00:00:00Z")], "")).toBe(
			"2026-01-01-11111111-session.md",
		);
	});

	it("handles an empty session list with epoch defaults", () => {
		expect(traceFileName([], undefined)).toBe("1970-01-01--session.md");
	});
});
