import { describe, expect, it } from "vitest";
import { toRepoBound } from "../src/work/repobound.js";

describe("toRepoBound", () => {
	it("strips anchors, project paths and any other home-relative absolute path", () => {
		const md = [
			"logFile: /home/op/.claude/projects/x/abc.jsonl",
			"- `Read` /home/op/projects/app/src/a.ts @L12 → ok",
			"- `Write` /home/op/reports/daily/2026-09-07.md @L40–L44",
			"> `@L<n>` — how to dereference",
			"- `Bash` raiseki distill /home/op… → ok; pasted: /Users/someone.else/x.txt",
		].join("\n");
		const out = toRepoBound(md, "/home/op/projects/app", "/home/op");
		expect(out).not.toMatch(/@L\d+/);
		expect(out).not.toContain("/home/op");
		expect(out).toContain("src/a.ts");
		expect(out).toContain("~/reports/daily/2026-09-07.md");
		expect(out).not.toMatch(/^\s*logFile:/m);
		expect(out).not.toMatch(/\/(Users|home)\//);
		expect(out).toContain("distill ~… → ok");
		expect(out).toContain("~/x.txt");
	});

	it("removes bare @L glyphs left after anchored ranges collapse", () => {
		// arc lines like "H [refuted] … @L101→L175" and thoughts "@L" with no digits
		const md = [
			"- **H** [refuted] bad guess @L101→L175",
			"💭 ?: keep the anchor? @L",
			"- сессия @L → pointer line handled separately",
		].join("\n");
		const out = toRepoBound(md);
		expect(out).not.toContain("@L");
		expect(out).toContain("bad guess");
		expect(out).toContain("keep the anchor?");
	});
});
