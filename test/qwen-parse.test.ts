import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQwenSession } from "../src/sources/qwen/parse.js";
import { discoverQwenSessions } from "../src/sources/qwen/discover.js";
import type { TextEntry, ToolCallEntry, ToolResultEntry } from "../src/model/session.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "qwen-session.jsonl");

describe("qwen parser", () => {
	it("parses header fields with line refs", async () => {
		const s = await parseQwenSession(FIXTURE);
		expect(s.source).toBe("qwen");
		expect(s.sessionId).toBe("fix-qwen-0001");
		expect(s.cwd).toBe("/proj/demo");
		expect(s.gitBranch).toBe("main");
		expect(s.role).toBe("main");
		expect(s.firstPrompt).toBe("почини импорт в src/main.ts");
		expect(s.logLines).toBe(10);
		expect(s.startedAt).toBe("2026-09-01T10:00:00.000Z");
		expect(s.endedAt).toBe("2026-09-01T10:01:20.000Z");
	});

	it("prefers assistant-line model over the session_model fallback", async () => {
		const s = await parseQwenSession(FIXTURE);
		// line 2 carries fallback-model, lines 3/5 carry real-model-v1
		expect(s.model).toBe("real-model-v1");
	});

	it("segmentates turns: turnStart only on the first entry of each assistant line", async () => {
		const s = await parseQwenSession(FIXTURE);
		const assistantEntries = s.entries.filter(
			(e): e is ToolCallEntry | TextEntry =>
				e.kind === "tool_call" || e.kind === "assistant_text" || e.kind === "assistant_thinking",
		);
		// line 3: thinking+text+call, line 5: thinking+call, line 10: text → 6 entries
		expect(assistantEntries).toHaveLength(6);
		const turned = assistantEntries.filter((e) => e.turnStart === true);
		expect(turned).toHaveLength(3);
		expect(turned.map((e) => e.logLine)).toEqual([3, 5, 10]);
	});

	it("keeps thinking lossless and separates it from visible text", async () => {
		const s = await parseQwenSession(FIXTURE);
		const thoughts = s.entries.filter(
			(e): e is TextEntry & { kind: "assistant_thinking" } => e.kind === "assistant_thinking",
		);
		expect(thoughts).toHaveLength(2);
		expect(thoughts[0]?.text).toContain("гипотеза — tsconfig paths");
		expect(thoughts[0]?.logLine).toBe(3);
		const texts = s.entries.filter(
			(e): e is TextEntry & { kind: "assistant_text" } => e.kind === "assistant_text",
		);
		expect(texts.map((t) => t.text)).toEqual(["Сейчас посмотрю файл.", "Готово: импорт исправлен."]);
	});

	it("pairs tool calls with results by functionCall id", async () => {
		const s = await parseQwenSession(FIXTURE);
		const calls = s.entries.filter((e): e is ToolCallEntry => e.kind === "tool_call");
		const results = s.entries.filter((e): e is ToolResultEntry => e.kind === "tool_result");
		expect(calls).toHaveLength(2);
		expect(results).toHaveLength(2);
		expect(calls.map((c) => c.toolCallId)).toEqual(["call-1", "call-2"]);
		expect(calls[0]?.name).toBe("read_file");
		const read = results.find((r) => r.toolCallId === "call-1");
		expect(read?.isError).toBe(false);
		expect(read?.content).toContain("import { x }");
		// tool input is the raw parsed args object
		const call1 = calls[0];
		expect(call1 !== undefined && (call1.input as Record<string, unknown>)["file_path"]).toBe(
			"/proj/demo/src/main.ts",
		);
	});

	it("marks error results via response.error", async () => {
		const s = await parseQwenSession(FIXTURE);
		const err = s.entries.find((e): e is ToolResultEntry => e.kind === "tool_result" && e.toolCallId === "call-2");
		expect(err?.isError).toBe(true);
		expect(err?.content).toContain("has not been read");
	});

	it("records compaction without mistaking it for a user prompt", async () => {
		const s = await parseQwenSession(FIXTURE);
		expect(s.entries.some((e) => e.kind === "compaction")).toBe(true);
		const note = s.entries.find(
			(e) => e.kind === "system_note" && e.subtype === "chat_compression",
		);
		expect(note?.kind === "system_note" && note.text).toContain("trigger=manual");
		expect(note?.kind === "system_note" && note.text).toContain("1000→200 tokens");
	});

	it("keeps machine-injected user lines out of user_text", async () => {
		const s = await parseQwenSession(FIXTURE);
		const prompts = s.entries.filter(
			(e): e is TextEntry & { kind: "user_text" } => e.kind === "user_text",
		);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.text).toBe("почини импорт в src/main.ts");
		const injected = s.entries.find((e) => e.kind === "system_note" && e.subtype === "system");
		expect(injected?.kind === "system_note" && injected.text).toContain("<task-notification>");
	});

	it("skips telemetry system lines", async () => {
		const s = await parseQwenSession(FIXTURE);
		expect(s.entries.some((e) => e.kind === "system_note" && e.subtype === "ui_telemetry")).toBe(false);
	});

	it("aggregates Gemini-style usageMetadata", async () => {
		const s = await parseQwenSession(FIXTURE);
		expect(s.tokenUsage).toEqual({
			requests: 1,
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 10,
			cacheWriteTokens: 0,
			reasoningTokens: 30,
		});
	});
});

describe("qwen discover", () => {
	it("walks <project>/chats/*.jsonl, skips ledgers, filters by cwd", async () => {
		const root = await mkdtemp(join(tmpdir(), "qwen-discover-"));
		const chats = join(root, "-proj-demo", "chats");
		await mkdir(chats, { recursive: true });
		await copyFile(FIXTURE, join(chats, "aaaa-111.jsonl"));
		await copyFile(FIXTURE, join(chats, "aaaa-111.ledger.jsonl"));
		// other project with no chats dir — must be ignored
		await mkdir(join(root, "-proj-other"), { recursive: true });
		const files = await discoverQwenSessions("/proj/demo", root);
		expect(files).toHaveLength(1);
		expect(files[0]?.endsWith("aaaa-111.jsonl")).toBe(true);
	});

	it("returns nothing for a missing projects dir", async () => {
		const files = await discoverQwenSessions("/proj/demo", "/definitely/not/there");
		expect(files).toEqual([]);
	});
});
