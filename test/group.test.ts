import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { parseClaudeSession } from "../src/sources/claude/parse.js";
import { groupSession } from "../src/base/group.js";
import { renderCall } from "../src/base/render-tools.js";
import { detectChecks } from "../src/base/checks.js";
import type { SessionEntry } from "../src/model/session.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "claude-session.jsonl");

describe("grouping", () => {
	it("folds consecutive tool runs into blocks and records stats", async () => {
		const s = await parseClaudeSession(FIXTURE);
		const g = groupSession(s.entries, s.cwd);
		// main flow: bash(ls) | read | edit | bash(err)+bash(retry) — turns with
		// changing families split; narration-only block closes the session
		expect(g.blocks.length).toBeGreaterThanOrEqual(4);
		expect(g.blocks[0]?.label).toBe("run");
		expect(g.blocks[g.blocks.length - 1]?.label).toBe("outcome");
		expect(g.taskPrompts).toHaveLength(1);
		expect(g.taskPrompts[0]?.text).toBe("почини тесты в apps/dist");
		expect(g.counts.toolCalls).toBe(5);
		expect(g.counts.toolErrors).toBe(1);
		expect(g.counts.repairCycles).toBe(1);
		expect(g.counts.thinkingBlocks).toBe(1);
		expect(g.sidechainRuns).toHaveLength(1);
		expect(g.sidechainRuns[0]?.calls).toBe(1);
	});

	it("detects the last check run and failure names", async () => {
		const s = await parseClaudeSession(FIXTURE);
		const g = groupSession(s.entries, s.cwd);
		expect(g.lastChecks).toBeDefined();
		expect(g.lastChecks?.run).toBe(10);
		expect(g.lastChecks?.failed).toBe(0); // last run passed
		expect(g.checksEverFailed).toBe(true);
	});

	it("collapses identical repeated calls with ×N", () => {
		const entries: SessionEntry[] = [
			{ kind: "tool_call", name: "Read", input: { file_path: "/a.ts" }, toolCallId: "1", timestamp: "t", logLine: 10, sidechain: false },
			{ kind: "tool_result", toolCallId: "1", content: "same", isError: false, interrupted: false, timestamp: "t", logLine: 11, sidechain: false },
			{ kind: "tool_call", name: "Read", input: { file_path: "/a.ts" }, toolCallId: "2", timestamp: "t", logLine: 20, sidechain: false },
			{ kind: "tool_result", toolCallId: "2", content: "same", isError: false, interrupted: false, timestamp: "t", logLine: 21, sidechain: false },
		];
		const g = groupSession(entries);
		expect(g.blocks).toHaveLength(1);
		expect(g.blocks[0]?.tools).toHaveLength(1);
		expect(g.blocks[0]?.tools[0]?.text).toContain("×2");
		expect(g.blocks[0]?.tools[0]?.logLine).toBe(20); // points at latest occurrence
	});
});

describe("tool rendering", () => {
	it("renders shell calls with @L refs and tombstones for big outputs", () => {
		const call = { kind: "tool_call" as const, name: "Bash", input: { command: "pnpm vitest run" }, toolCallId: "1", timestamp: "t", logLine: 41, sidechain: false };
		const result = { kind: "tool_result" as const, toolCallId: "1", content: "x".repeat(5120), isError: false, interrupted: false, timestamp: "t", logLine: 44, sidechain: false };
		const r = renderCall(call, result);
		expect(r.text).toContain("`Bash`");
		expect(r.text).toContain("@L41");
		expect(r.text).toContain("@L44");
		expect(r.text).toMatch(/…⟨5\.0kB, 1 ln, #[0-9a-f]+, @L44⟩/);
	});

	it("renders errors with the message head", () => {
		const call = { kind: "tool_call" as const, name: "Bash", input: { command: "exit 3" }, toolCallId: "1", timestamp: "t", logLine: 10, sidechain: false };
		const result = { kind: "tool_result" as const, toolCallId: "1", content: "command failed: permission denied", isError: true, interrupted: false, timestamp: "t", logLine: 11, sidechain: false };
		const r = renderCall(call, result);
		expect(r.isError).toBe(true);
		expect(r.resultPart).toContain("ERR");
		expect(r.resultPart).toContain("permission denied");
	});

	it("strips the cd-prefix when cwd matches", () => {
		const call = { kind: "tool_call" as const, name: "Bash", input: { command: "cd /proj/demo && git status" }, toolCallId: "1", timestamp: "t", logLine: 10, sidechain: false };
		const withCwd = renderCall(call, undefined, "/proj/demo");
		const withoutCwd = renderCall(call, undefined);
		expect(withCwd.text).toContain("git status");
		expect(withCwd.text).not.toContain("cd /proj/demo");
		expect(withoutCwd.text).toContain("cd /proj/demo");
	});
});

describe("check detection", () => {
	it("parses vitest summaries", () => {
		const obs = detectChecks("Tests: 2 failed | 8 passed (10)");
		expect(obs).toEqual({ run: 10, failed: 2, failedNames: [] });
	});

	it("parses pytest summaries", () => {
		const obs = detectChecks("5 passed, 1 failed in 0.3s");
		expect(obs?.run).toBe(6);
		expect(obs?.failed).toBe(1);
	});

	it("parses cargo summaries", () => {
		const obs = detectChecks("test result: ok. 12 passed; 0 failed; 3 ignored");
		expect(obs?.run).toBe(12);
		expect(obs?.failed).toBe(0);
	});

	it("collects failing test names", () => {
		const obs = detectChecks("FAIL src/auth.test.ts > refresh\ntests: 1 failed | 3 passed (4)");
		expect(obs?.failed).toBeGreaterThanOrEqual(1);
		expect(obs?.failedNames).toContain("src/auth.test.ts > refresh");
	});

	it("returns undefined for non-check outputs", () => {
		expect(detectChecks("hello world")).toBeUndefined();
	});
});
