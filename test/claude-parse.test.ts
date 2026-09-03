import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { parseClaudeSession } from "../src/sources/claude/parse.js";
import type { TextEntry } from "../src/model/session.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "claude-session.jsonl");

describe("claude parser", () => {
	it("parses entries with log line numbers", async () => {
		const s = await parseClaudeSession(FIXTURE);
		expect(s.source).toBe("claude");
		expect(s.sessionId).toBe("fix-0001");
		expect(s.cwd).toBe("/proj/demo");
		expect(s.title).toBe("Починить тесты");
		expect(s.model).toBe("claude-test-1");
		expect(s.gitBranch).toBe("main");
		expect(s.firstPrompt).toBe("почини тесты в apps/dist");
		expect(s.logLines).toBe(18);
		expect(s.entries.length).toBeGreaterThan(0);
	});

	it("keeps tool calls and results paired by id with line refs", async () => {
		const s = await parseClaudeSession(FIXTURE);
		const calls = s.entries.filter((e) => e.kind === "tool_call");
		const results = s.entries.filter((e) => e.kind === "tool_result");
		expect(calls).toHaveLength(6); // tu-1..tu-5 in main flow + tu-sub in the sidechain
		expect(results).toHaveLength(6);
		const mainCalls = calls.filter((c) => !c.sidechain);
		expect(mainCalls).toHaveLength(5);
		for (const c of calls) {
			expect(c.logLine).toBeGreaterThan(0);
		}
	});

	it("extracts diff stats from structuredPatch", async () => {
		const s = await parseClaudeSession(FIXTURE);
		const editResult = s.entries.find(
			(e) => e.kind === "tool_result" && e.toolCallId === "tu-3",
		);
		expect(editResult).toBeDefined();
		if (editResult?.kind !== "tool_result") return;
		expect(editResult.diff).toEqual({
			added: 2,
			removed: 1,
			filePath: "/proj/demo/apps/dist/src/index.ts",
		});
	});

	it("marks sidechain entries", async () => {
		const s = await parseClaudeSession(FIXTURE);
		const sidechain = s.entries.filter((e) => e.sidechain);
		expect(sidechain.length).toBe(3);
	});

	it("records compaction without mistaking it for a user prompt", async () => {
		const s = await parseClaudeSession(FIXTURE);
		expect(s.entries.some((e) => e.kind === "compaction")).toBe(true);
		const prompts = s.entries.filter(
			(e): e is TextEntry & { kind: "user_text" } => e.kind === "user_text",
		);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.text).toBe("почини тесты в apps/dist");
		const note = s.entries.find(
			(e) => e.kind === "system_note" && e.subtype === "compact_boundary",
		);
		expect(note?.kind === "system_note" && note.text).toContain("trigger=auto");
	});

	it("does not treat system-reminder noise as user text", async () => {
		const s = await parseClaudeSession(FIXTURE);
		for (const e of s.entries) {
			if (e.kind === "user_text") {
				expect(e.text.startsWith("<system-reminder>")).toBe(false);
			}
		}
	});
});
