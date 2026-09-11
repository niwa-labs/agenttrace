import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKimiSession } from "../src/sources/kimi/parse.js";
import { discoverKimiSessions } from "../src/sources/kimi/discover.js";
import type { SessionEntry, TextEntry, ToolCallEntry, ToolResultEntry } from "../src/model/session.js";

const WIRE_V19 = join(import.meta.dirname, "fixtures", "kimi-wire-v19.jsonl");
const WIRE_V14 = join(import.meta.dirname, "fixtures", "kimi-code-wire-v14.jsonl");

const userTexts = (entries: SessionEntry[]): string[] =>
	(entries.filter((e): e is TextEntry => e.kind === "user_text")).map((e) => e.text);

describe("kimi parser (kimi CLI wire protocol 1.9)", () => {
	it("parses turns, thinking, and text entries with line refs", async () => {
		const s = await parseKimiSession(WIRE_V19);
		expect(s.source).toBe("kimi");
		expect(s.logLines).toBe(24);
		// main-turn prompts only; the subagent's task prompt is a sidechain user_text
		expect(userTexts(s.entries.filter((e) => !e.sidechain))).toEqual(["fix the flaky test", "continue"]);
		expect(s.firstPrompt).toBe("fix the flaky test");

		const thinking = s.entries.filter((e): e is TextEntry => e.kind === "assistant_thinking");
		expect(thinking).toHaveLength(1);
		expect(thinking[0]?.text).toContain("timezone bug");
		expect(thinking[0]?.logLine).toBe(4);

		const texts = s.entries.filter((e): e is TextEntry => e.kind === "assistant_text").map((e) => e.text);
		expect(texts).toEqual(["Test is flaky due to TZ. Fixing.", "Done."]);
	});

	it("pairs tool calls and results by id, parsing streamed JSON arguments", async () => {
		const s = await parseKimiSession(WIRE_V19);
		const calls = s.entries.filter((e): e is ToolCallEntry => e.kind === "tool_call");
		const results = s.entries.filter((e): e is ToolResultEntry => e.kind === "tool_result");
		expect(calls.map((c) => c.toolCallId)).toEqual(["tool_a1", "tool_s1", "tool_b2"]);
		expect(results.map((r) => r.toolCallId)).toEqual(["tool_a1", "tool_s1", "tool_b2"]);
		// ToolCallPart streaming deltas must not produce extra calls.
		expect(calls[0]?.name).toBe("Shell");
		expect(calls[0]?.input).toEqual({ command: "npm test" });
		expect(results[2]?.isError).toBe(true);
		expect(results[2]?.content).toBe("file not found"); // message fallback when output is empty
	});

	it("marks subagent events as sidechain and sniffs the working directory", async () => {
		const s = await parseKimiSession(WIRE_V19);
		const sidechain = s.entries.filter((e) => e.sidechain);
		// subagent TurnBegin (task prompt) + ToolCall + ToolResult
		expect(sidechain.map((e) => e.kind)).toEqual(["user_text", "tool_call", "tool_result"]);
		expect(s.cwd).toBe("/work/demo");
	});

	it("maps service messages to system notes and compaction", async () => {
		const s = await parseKimiSession(WIRE_V19);
		const notes = s.entries.filter((e): e is TextEntry & { subtype: string } => e.kind === "system_note");
		expect(notes.map((n) => n.subtype)).toEqual(["notification:task", "plan", "question"]);
		expect(notes[1]?.text.startsWith("/tmp/plans/fix-flaky.md\n# Plan")).toBe(true);
		expect(notes[2]?.text).toBe("Pin TZ or skip on CI?");
		expect(s.entries.some((e) => e.kind === "compaction")).toBe(true);
	});

	it("aggregates StatusUpdate token usage and keeps exact timestamps", async () => {
		const s = await parseKimiSession(WIRE_V19);
		expect(s.tokenUsage).toEqual({
			requests: 1,
			inputTokens: 800,
			outputTokens: 50,
			cacheReadTokens: 200,
			cacheWriteTokens: 10,
			reasoningTokens: 0,
		});
		expect(s.startedAt).toBe("2023-11-14T22:13:20.100Z");
		expect(s.endedAt).toBe("2023-11-14T22:13:32.000Z");
		expect(s.activeMs).toBeGreaterThan(0);
	});

	it("honours discovery hints for sessionId and falls back to the parent dir", async () => {
		const hinted = await parseKimiSession(WIRE_V19, { sessionId: "sess-1", role: "subagent" });
		expect(hinted.sessionId).toBe("sess-1");
		expect(hinted.role).toBe("subagent");
		const plain = await parseKimiSession(WIRE_V19);
		expect(plain.sessionId).toBe("fixtures"); // no uuid in the fixture path → parent dir
		expect(plain.role).toBe("main");
	});
});

describe("kimi parser (kimi-code event-sourced protocol 1.4)", () => {
	it("parses turn prompts and drops the mirrored context.append_message copy", async () => {
		const s = await parseKimiSession(WIRE_V14);
		expect(userTexts(s.entries)).toEqual(["list the docs", "also check docs/old", "now summarize"]);
		expect(s.firstPrompt).toBe("list the docs");
	});

	it("keeps injected system-reminder context as system notes", async () => {
		const s = await parseKimiSession(WIRE_V14);
		const note = s.entries.find((e): e is TextEntry & { subtype: string } => e.kind === "system_note" && e.subtype === "context_message");
		expect(note?.text.startsWith("<system-reminder>")).toBe(true);
	});

	it("pairs loop-event tool calls with results, including error results", async () => {
		const s = await parseKimiSession(WIRE_V14);
		const calls = s.entries.filter((e): e is ToolCallEntry => e.kind === "tool_call");
		const results = s.entries.filter((e): e is ToolResultEntry => e.kind === "tool_result");
		expect(calls.map((c) => [c.name, c.toolCallId])).toEqual([["Read", "call_1"], ["Bash", "call_2"]]);
		expect(calls[0]?.input).toEqual({ path: "/work/demo/README.md" });
		expect(results[0]?.content).toBe("# Demo\ndocs live in docs/");
		expect(results[1]?.isError).toBe(true);
		expect(results[1]?.content).toBe("command failed: no such directory"); // note fallback
	});

	it("keeps thinking blocks and sets turnStart on new assistant blocks", async () => {
		const s = await parseKimiSession(WIRE_V14);
		const assistant = s.entries.filter((e): e is TextEntry | ToolCallEntry => !e.sidechain && (e.kind === "assistant_text" || e.kind === "assistant_thinking" || e.kind === "tool_call"));
		const withFlag = assistant.filter((e) => e.turnStart === true);
		// p1 think (step 1), call_2 (step 2), p3 text (step 3), p4 text (turn 1)
		expect(withFlag.map((e) => e.logLine)).toEqual([10, 14, 21, 24]);
		const thinking = s.entries.filter((e): e is TextEntry => e.kind === "assistant_thinking");
		expect(thinking).toHaveLength(1);
		expect(thinking[0]?.text).toContain("read the README");
	});

	it("aggregates usage.record, captures the model, and marks compaction", async () => {
		const s = await parseKimiSession(WIRE_V14);
		expect(s.model).toBe("kimi-code/k3");
		expect(s.tokenUsage).toEqual({
			requests: 1,
			inputTokens: 16748,
			outputTokens: 26,
			cacheReadTokens: 11264,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
		});
		expect(s.entries.some((e) => e.kind === "compaction")).toBe(true);
		expect(s.startedAt).toBe(new Date(1784794429579).toISOString());
		expect(s.endedAt).toBe(new Date(1784794454000).toISOString());
	});
});

describe("kimi discovery", () => {
	it("walks both roots, decoding wd_ hints and reading state.json workdirs", async () => {
		const t = await buildTmpTree();
		const refs = await discoverKimiSessions(undefined, t.codeDir, t.kimiDir);
		expect(refs).toHaveLength(4);

		const main = refs.find((r) => r.layout === "kimi-code" && r.role === "main");
		expect(main?.sessionId).toBe("11111111-2222-3333-4444-555555555555");
		expect(main?.workDir).toBe("/work/demo");
		expect(main?.workDirHint).toBe("demo");
		expect(main?.protocolVersion).toBe("1.4");
		expect(main?.startedAt).toBe(new Date(1784794429579).toISOString());
		expect(main?.endedAt).toBe(new Date(1784794430000).toISOString());

		const sub = refs.find((r) => r.layout === "kimi-code" && r.role === "subagent");
		expect(sub?.agentName).toBe("agent-2");
		expect(sub?.sessionId).toBe("11111111-2222-3333-4444-555555555555");

		const kimiMain = refs.find((r) => r.layout === "kimi" && r.role === "main");
		expect(kimiMain?.sessionId).toBe("22222222-3333-4444-5555-666666666666");
		expect(kimiMain?.workDir).toBeUndefined();
		expect(kimiMain?.protocolVersion).toBe("1.9");
		expect(kimiMain?.startedAt).toBe("2023-11-14T22:13:20.500Z");

		const kimiSub = refs.find((r) => r.layout === "kimi" && r.role === "subagent");
		expect(kimiSub?.sessionId).toBe("22222222-3333-4444-5555-666666666666/sub1");
	});

	it("filters by rootDir using exact workdir, keeping unknown-workdir sessions", async () => {
		const t = await buildTmpTree();
		const demo = await discoverKimiSessions("/work/demo", t.codeDir, t.kimiDir);
		// kimi-code matches exactly; kimi-layout sessions have no recoverable workdir → kept
		expect(demo).toHaveLength(4);
		expect(demo.every((r) => r.layout === "kimi" || r.workDir === "/work/demo")).toBe(true);

		const other = await discoverKimiSessions("/other/place", t.codeDir, t.kimiDir);
		expect(other.map((r) => r.layout)).toEqual(["kimi", "kimi"]);
	});
});

async function buildTmpTree(): Promise<{ codeDir: string; kimiDir: string }> {
	const tmp = await mkdtemp(join(tmpdir(), "kimi-disc-"));
	const codeDir = join(tmp, "kimi-code-sessions");
	const sessionDir = join(codeDir, "wd_demo_abc123456789", "session_11111111-2222-3333-4444-555555555555");
	await mkdir(join(sessionDir, "agents", "main"), { recursive: true });
	await mkdir(join(sessionDir, "agents", "agent-2"), { recursive: true });
	await writeFile(join(sessionDir, "state.json"), JSON.stringify({ workDir: "/work/demo", title: "demo" }), "utf8");
	const codeWire = [
		JSON.stringify({ type: "metadata", protocol_version: "1.4", created_at: 1784794429579 }),
		JSON.stringify({ type: "turn.prompt", input: [{ type: "text", text: "hi" }], time: 1784794430000 }),
		"",
	].join("\n");
	await writeFile(join(sessionDir, "agents", "main", "wire.jsonl"), codeWire, "utf8");
	await writeFile(join(sessionDir, "agents", "agent-2", "wire.jsonl"), codeWire, "utf8");

	const kimiDir = join(tmp, "kimi-sessions");
	const uuidDir = join(kimiDir, "hash01", "22222222-3333-4444-5555-666666666666");
	await mkdir(join(uuidDir, "subagents", "sub1"), { recursive: true });
	const kimiWire = [
		JSON.stringify({ type: "metadata", protocol_version: "1.9" }),
		JSON.stringify({ timestamp: 1700000000.5, message: { type: "TurnBegin", payload: { user_input: "hi" } } }),
		"",
	].join("\n");
	await writeFile(join(uuidDir, "wire.jsonl"), kimiWire, "utf8");
	await writeFile(join(uuidDir, "subagents", "sub1", "wire.jsonl"), kimiWire, "utf8");
	return { codeDir, kimiDir };
}
