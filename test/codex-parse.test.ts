import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { parseCodexSession, diffFromApplyPatch, stripExecHeader } from "../src/sources/codex/parse.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "codex-session.jsonl");
const SUBFIXTURE = join(import.meta.dirname, "fixtures", "codex-subagent.jsonl");

describe("codex parser", () => {
	it("parses session meta, model and messages", async () => {
		const s = await parseCodexSession(FIXTURE);
		expect(s.source).toBe("codex");
		expect(s.sessionId).toBe("codex-0001");
		expect(s.cwd).toBe("/proj/demo");
		expect(s.model).toBe("gpt-5-codex");
		expect(s.firstPrompt).toBe("собери проект и поправь версию");
		expect(s.role).toBe("main");
	});

	it("skips instruction noise but keeps real user text", async () => {
		const s = await parseCodexSession(FIXTURE);
		const prompts = s.entries.filter((e) => e.kind === "user_text");
		expect(prompts).toHaveLength(1);
	});

	it("extracts exit codes from exec outputs", async () => {
		const s = await parseCodexSession(FIXTURE);
		const results = s.entries.filter((e) => e.kind === "tool_result");
		expect(results).toHaveLength(3);
		const failed = results.find((r) => r.toolCallId === "c3");
		expect(failed?.isError).toBe(true);
		expect(failed?.exitCode).toBe(101);
		const ok = results.find((r) => r.toolCallId === "c1");
		expect(ok?.isError).toBe(false);
	});

	it("marks subagent rollouts with parent thread", async () => {
		const s = await parseCodexSession(SUBFIXTURE);
		expect(s.role).toBe("subagent");
		expect(s.parentThreadId).toBe("codex-0001");
	});

	it("parses apply_patch diffs from tool input", () => {
		const diff = diffFromApplyPatch({
			input: '*** Begin Patch\n*** Update File: Cargo.toml\n@@\n-version = "0.1.0"\n+version = "0.2.0"\n*** End Patch',
		});
		expect(diff).toEqual({ added: 1, removed: 1, filePath: "Cargo.toml" });
	});

	it("strips the exec machine header", () => {
		const { body, originalTokens } = stripExecHeader(
			"Chunk ID: abc\nWall time: 1s\nProcess exited with code 0\nOriginal token count: 900\nOutput\nhello",
		);
		expect(body).toBe("hello");
		expect(originalTokens).toBe(900);
	});
});
