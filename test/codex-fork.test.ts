/**
 * Regression tests for forked Codex rollouts:
 * - sessionId comes from the FIRST session_meta (replayed ancestor metas don't win)
 * - token usage is summed from per-turn `last_token_usage`; an inherited
 *   cumulative baseline (no `last`) is never counted; rate-limit refreshes
 *   (unchanged cumulative) are not model responses.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseCodexSession } from "../src/sources/codex/parse.js";

const T0 = "2026-06-01T10:00:00.000Z";
const T1 = "2026-06-01T10:00:10.000Z";
const T2 = "2026-06-01T10:00:20.000Z";
const T3 = "2026-06-01T10:00:30.000Z";
const T4 = "2026-06-01T10:00:40.000Z";

function meta(id: string, cwd: string): string {
	return JSON.stringify({ type: "session_meta", timestamp: T0, payload: { id, cwd, model_provider: "test" } });
}

function tokenCount(total: { i: number; o: number; c: number }, last?: { i: number; o: number; c: number }): string {
	const info: Record<string, unknown> = {
		total_token_usage: { input_tokens: total.i, output_tokens: total.o, cached_input_tokens: total.c },
	};
	if (last !== undefined) {
		info.last_token_usage = { input_tokens: last.i, output_tokens: last.o, cached_input_tokens: last.c };
	}
	return JSON.stringify({ type: "event_msg", timestamp: T1, payload: { type: "token_count", info } });
}

function userMsg(text: string): string {
	return JSON.stringify({
		type: "response_item",
		timestamp: T2,
		payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
	});
}

describe("codex forked rollouts", () => {
	it("keeps the first session_meta id and counts only last_token_usage", async () => {
		const dir = await mkdtemp(join(tmpdir(), "codex-fork-"));
		const file = join(dir, "rollout-2026-06-01T10-00-00-aaaa1111-2222-3333-4444-555555555555.jsonl");
		const lines = [
			// our own meta comes first
			meta("aaaa1111-2222-3333-4444-555555555555", "/proj/own"),
			userMsg("start the fork work"),
			// ancestor history replayed mid-file: different meta, different cwd
			meta("bbbb2222-3333-4444-5555-666666666666", "/proj/ancestor"),
			userMsg("ancestor work that must not be re-attributed"),
			// ancestor cumulative baseline WITHOUT last → inherited, never counted
			tokenCount({ i: 5_000_000, o: 900_000, c: 4_000_000 }),
			// our first real response: per-turn usage present
			tokenCount({ i: 5_010_000, o: 901_000, c: 4_005_000 }, { i: 10_000, o: 1_000, c: 5_000 }),
			// rate-limit refresh: cumulative unchanged → not a response
			tokenCount({ i: 5_010_000, o: 901_000, c: 4_005_000 }),
			// our second real response
			tokenCount({ i: 5_020_000, o: 902_000, c: 4_010_000 }, { i: 10_000, o: 1_000, c: 5_000 }),
		];
		await writeFile(file, lines.join("\n") + "\n", "utf8");

		const s = await parseCodexSession(file);
		// first session_meta wins; the replayed ancestor meta must not overwrite it
		expect(s.sessionId).toBe("aaaa1111-2222-3333-4444-555555555555");
		expect(s.cwd).toBe("/proj/own");
		// only the two per-turn `last_token_usage` records are counted
		const u = s.tokenUsage;
		expect(u).toBeDefined();
		expect(u?.requests).toBe(2);
		expect(u?.inputTokens).toBe(20_000);
		expect(u?.outputTokens).toBe(2_000);
		expect(u?.cacheReadTokens).toBe(10_000);
		// the ancestor user message stays in the log but is attributed as a user turn;
		// identity/tokens are what this regression covers.
	});

	it("still parses a plain (non-forked) rollout with per-turn usage", async () => {
		const dir = await mkdtemp(join(tmpdir(), "codex-plain-"));
		const file = join(dir, "rollout-2026-06-01T10-00-00-cccc3333-4444-5555-6666-777777777777.jsonl");
		const lines = [
			meta("cccc3333-4444-5555-6666-777777777777", "/proj/plain"),
			userMsg("hello"),
			tokenCount({ i: 100, o: 50, c: 10 }, { i: 100, o: 50, c: 10 }),
			tokenCount({ i: 300, o: 120, c: 30 }, { i: 200, o: 70, c: 20 }),
		];
		await writeFile(file, lines.join("\n") + "\n", "utf8");

		const s = await parseCodexSession(file);
		expect(s.sessionId).toBe("cccc3333-4444-5555-6666-777777777777");
		expect(s.tokenUsage?.requests).toBe(2);
		expect(s.tokenUsage?.inputTokens).toBe(300); // 100 + 200
		expect(s.tokenUsage?.outputTokens).toBe(120); // 50 + 70
	});
});
