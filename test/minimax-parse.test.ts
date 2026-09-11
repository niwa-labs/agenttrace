import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMinimaxSession } from "../src/sources/minimax/parse.js";
import { discoverMinimaxSessions } from "../src/sources/minimax/discover.js";
import type { TextEntry, ToolCallEntry, ToolResultEntry } from "../src/model/session.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "minimax-session.jsonl");

describe("minimax parser", () => {
	it("parses header fields with dir-name session id fallback", async () => {
		const s = await parseMinimaxSession(FIXTURE);
		expect(s.source).toBe("minimax");
		expect(s.sessionId).toBe("minimax-session");
		expect(s.cwd).toBe("/proj/demo");
		expect(s.role).toBe("main");
		expect(s.model).toBe("MiniMax-M3");
		expect(s.firstPrompt).toBe("почини импорт в src/main.ts");
		expect(s.logLines).toBe(11); // counts the trailing garbage line too
	});

	it("converts epoch-ms timestamps to ISO bounds", async () => {
		const s = await parseMinimaxSession(FIXTURE);
		expect(s.startedAt).toBe("2026-09-01T10:00:00.000Z");
		expect(s.endedAt).toBe("2026-09-01T10:01:20.000Z");
		const first = s.entries[0];
		expect(first?.timestamp).toBe("2026-09-01T10:00:00.000Z");
	});

	it("segmentates turns by turn_id: turnStart only on the first entry of each turn", async () => {
		const s = await parseMinimaxSession(FIXTURE);
		const candidates = s.entries.filter(
			(e): e is ToolCallEntry | TextEntry =>
				e.kind === "tool_call" ||
				e.kind === "user_text" ||
				e.kind === "assistant_text" ||
				e.kind === "assistant_thinking",
		);
		const turned = candidates.filter((e) => e.turnStart === true);
		// turn-aaaa opens at L1; turn-bbbb's user line was filtered, so L7 opens it; turn-cccc opens at L10
		expect(turned.map((e) => e.logLine)).toEqual([1, 7, 10]);
		// mid-turn assistant text (L4) is not a turn start
		expect(candidates.some((e) => e.logLine === 4 && e.turnStart === true)).toBe(false);
	});

	it("keeps thinking lossless and separate from visible text", async () => {
		const s = await parseMinimaxSession(FIXTURE);
		const thoughts = s.entries.filter(
			(e): e is TextEntry & { kind: "assistant_thinking" } => e.kind === "assistant_thinking",
		);
		expect(thoughts.map((t) => t.logLine)).toEqual([2, 7]);
		expect(thoughts[0]?.text).toContain("Гипотеза: путь ломается из-за tsconfig paths");
		expect(thoughts[0]?.text).toContain("алиас main указывает на dist.");
		const texts = s.entries.filter((e): e is TextEntry & { kind: "assistant_text" } => e.kind === "assistant_text");
		expect(texts.map((t) => t.text)).toEqual(["Сейчас посмотрю.", "Готово: импорт исправлен."]);
	});

	it("pairs tool calls with results by id, maps isError and read filePath", async () => {
		const s = await parseMinimaxSession(FIXTURE);
		const calls = s.entries.filter((e): e is ToolCallEntry => e.kind === "tool_call");
		const results = s.entries.filter((e): e is ToolResultEntry => e.kind === "tool_result");
		expect(calls.map((c) => [c.toolCallId, c.name])).toEqual([
			["call-1", "read"],
			["call-2", "write"],
		]);
		const call1 = calls[0];
		expect(call1 !== undefined && (call1.input as Record<string, unknown>)["file_path"]).toBe(
			"/proj/demo/src/main.ts",
		);
		expect(results.map((r) => r.toolCallId)).toEqual(["call-1", "call-2"]);
		const ok = results[0];
		expect(ok?.isError).toBe(false);
		expect(ok?.content).toContain("import { x }");
		expect(ok?.filePath).toBe("/proj/demo/src/main.ts");
		const err = results[1];
		expect(err?.isError).toBe(true);
		expect(err?.content).toBe("permission denied");
	});

	it("strips machine envelopes and drops pure machine notices from user turns", async () => {
		const s = await parseMinimaxSession(FIXTURE);
		const prompts = s.entries.filter((e): e is TextEntry & { kind: "user_text" } => e.kind === "user_text");
		// L5 (background-task-finished notice) produced no user_text
		expect(prompts.map((p) => p.text)).toEqual([
			"почини импорт в src/main.ts",
			"продолжай",
		]);
		// custom role (L6, todo_cadence_reminder) is skipped entirely
		expect(s.entries.some((e) => e.logLine === 6)).toBe(false);
		expect(JSON.stringify(s.entries)).not.toContain("todo_cadence_reminder");
	});

	it("records compaction summaries without mistaking them for prompts", async () => {
		const s = await parseMinimaxSession(FIXTURE);
		const compaction = s.entries.find((e) => e.kind === "compaction");
		expect(compaction?.logLine).toBe(9);
		const note = s.entries.find(
			(e) => e.kind === "system_note" && e.subtype === "compaction",
		);
		expect(note?.kind === "system_note" && note.text).toContain("42000 tokens before");
		expect(s.firstPrompt).not.toContain("Goal");
	});

	it("aggregates Minimax usage (input/output/cache/cacheWrite/cost.total)", async () => {
		const s = await parseMinimaxSession(FIXTURE);
		expect(s.tokenUsage).toEqual({
			requests: 3,
			inputTokens: 170,
			outputTokens: 35,
			cacheReadTokens: 10,
			cacheWriteTokens: 5,
			reasoningTokens: 0,
			costUsd: 0.75,
		});
	});
});

describe("minimax discover", () => {
	it("walks YYYY/MM/DD session dirs, reads manifests, decodes dir-name ids", async () => {
		const root = await mkdtemp(join(tmpdir(), "minimax-discover-"));
		const b64 = (id: string) => Buffer.from(id, "utf8").toString("base64");
		const dirA = join(
			root, "v2", "sessions", "2026", "09", "01", `10-00-00-000-session_${b64("mvs_aaa")}`,
		);
		const dirB = join(
			root, "v2", "sessions", "2026", "09", "02", `11-00-00-000-session_${b64("mvs_bbb")}`,
		);
		const dirC = join(
			root, "v2", "sessions", "2026", "09", "02", `12-00-00-000-session_${b64("mvs_ccc")}`,
		);
		await mkdir(dirA, { recursive: true });
		await mkdir(dirB, { recursive: true });
		await mkdir(dirC, { recursive: true });
		await mkdir(join(root, "v2", "sessions", "2026", "09", "02", "snapshots"), { recursive: true });
		await copyFile(FIXTURE, join(dirA, "messages.jsonl"));
		await copyFile(FIXTURE, join(dirB, "messages.jsonl")); // no manifest
		await copyFile(FIXTURE, join(dirC, "messages.jsonl")); // no manifest either
		await writeFile(
			join(dirA, "manifest.json"),
			JSON.stringify({
				schemaVersion: 1,
				sessionId: "mvs_aaa",
				createdAtMs: 1788256800000,
				updatedAtMs: 1788256880000,
			}),
		);
		await writeFile(join(root, "v2", "sessions", "2026", "09", "02", "snapshots", "x.jsonl"), "{}\n");

		const refs = await discoverMinimaxSessions(join(root, "v2", "sessions"));
		expect(refs).toHaveLength(3);
		const a = refs.find((r) => r.file.includes("mvs_aaa") || r.file.includes("bXZzX2FhYQ"));
		expect(a?.sessionId).toBe("mvs_aaa"); // from manifest
		expect(a?.startedAt).toBe("2026-09-01T10:00:00.000Z");
		expect(a?.endedAt).toBe("2026-09-01T10:01:20.000Z");
		expect(a?.projectDir).toBe("/proj/demo"); // sniffed from <agent-context>
		const b = refs.find((r) => r.sessionId === "mvs_bbb");
		expect(b !== undefined && b.file.endsWith("11-00-00-000-session_bXZzX2JiYg==/messages.jsonl")).toBe(
			true,
		); // decoded from the dir name
		const c = refs.find((r) => r.sessionId === "mvs_ccc");
		// every fixture user message carries a workspace line, so projectDir is found
		expect(c?.projectDir).toBe("/proj/demo");
	});

	it("returns undefined projectDir when the first user message has no workspace line", async () => {
		const root = await mkdtemp(join(tmpdir(), "minimax-nows-"));
		const dir = join(root, "2026", "09", "03", `09-00-00-000-session_${Buffer.from("mvs_ddd").toString("base64")}`);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "messages.jsonl"),
			`${JSON.stringify({
				message_id: "m1",
				turn_id: "t1",
				message: { role: "user", content: [{ type: "text", text: "plain prompt" }], timestamp: 1788256800000 },
			})}\n`,
		);
		const refs = await discoverMinimaxSessions(root);
		expect(refs).toHaveLength(1);
		expect(refs[0]?.sessionId).toBe("mvs_ddd");
		expect(refs[0]?.projectDir).toBeUndefined();
	});

	it("returns nothing for a missing sessions dir", async () => {
		const refs = await discoverMinimaxSessions("/definitely/not/there");
		expect(refs).toEqual([]);
	});
});
