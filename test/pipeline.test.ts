import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/model/session.js";
import type { Turn } from "../src/pipeline/turns.js";

function call(id: string, name: string, logLine: number): SessionEntry {
	return { kind: "tool_call", name, input: { command: "x" }, toolCallId: id, timestamp: "t", logLine, sidechain: false };
}
function result(id: string, content: string, logLine: number, isError = false): SessionEntry {
	return { kind: "tool_result", toolCallId: id, content, isError, interrupted: false, timestamp: "t", logLine, sidechain: false };
}
function think(text: string, logLine: number): SessionEntry {
	return { kind: "assistant_thinking", text, timestamp: "t", logLine, sidechain: false };
}
function user(text: string, logLine: number): SessionEntry {
	return { kind: "user_text", text, timestamp: "t", logLine, sidechain: false };
}

describe("v2 turns", () => {
	it("packs whole turns into windows; never splits a turn", async () => {
		const { segmentTurns, packWindows } = await import("../src/pipeline/turns.js");
		const entries: SessionEntry[] = [
			user("почини тесты", 1),
			think("смотрю тесты", 2),
			call("c1", "Read", 3),
			result("c1", "file body", 4),
			think("нашёл", 5),
			call("c2", "Edit", 6),
			result("c2", "ok", 7),
			user("ещё", 8),
			call("c3", "Bash", 9),
			result("c3", "passed", 10),
		];
		const turns = segmentTurns(entries, { turnBudgetTokens: 8_000, windowBudgetTokens: 10_000 });
		// user, assistant-move 1, user, assistant-move 2
		expect(turns.map((t) => t.kind)).toEqual(["user", "assistant", "user", "assistant"]);
		const windows = packWindows(turns, { turnBudgetTokens: 8_000, windowBudgetTokens: 1_000 });
		// every turn must be intact inside exactly one window
		const allTurnEntries = turns.flatMap((t) => t.entries);
		const windowTurnIds = windows.flatMap((w) => w.turns.map((t) => t.index)).sort((a, b) => a - b);
		expect(windowTurnIds).toEqual(turns.map((t) => t.index));
		expect(allTurnEntries.length).toBe(entries.length);
	});

	it("marks a turn interrupted when its call has no result", async () => {
		const { segmentTurns } = await import("../src/pipeline/turns.js");
		const turns = segmentTurns([user("x", 1), call("c1", "Bash", 2)]);
		const last = turns[turns.length - 1] as Turn;
		expect(last.interrupted).toBe(true);
	});
});

describe("v2 anchors", () => {
	it("assigns stable quote ids to thinking and narration; gate checks membership", async () => {
		const { segmentTurns } = await import("../src/pipeline/turns.js");
		const { anchorTurn, quoteBelongsTo } = await import("../src/pipeline/anchors.js");
		const entries = [user("t", 1), think("гипотеза: дело в моке", 2), { kind: "assistant_text", text: "смотрю", timestamp: "t", logLine: 3, sidechain: false } as SessionEntry];
		const turns = segmentTurns(entries);
		const anchors = anchorTurn(turns[1] as NonNullable<typeof turns[1]>);
		expect(anchors.quotes).toHaveLength(2);
		const q = anchors.quotes[0];
		expect(q?.q).toMatch(/^q[0-9a-f]{6}$/);
		expect(quoteBelongsTo(anchors, q?.q ?? "q000000")).toBe(true);
		expect(quoteBelongsTo(anchors, "q000000")).toBe(false);
		// same text → same id (stable)
		const anchors2 = anchorTurn(turns[1] as NonNullable<typeof turns[1]>);
		expect(anchors2.quotes[0]?.q).toBe(q?.q);
	});
});

describe("v2 gate", () => {
	it("downgrades thought with foreign q and raises facts disputes", async () => {
		const { segmentTurns } = await import("../src/pipeline/turns.js");
		const { anchorTurn } = await import("../src/pipeline/anchors.js");
		const { gateBlock } = await import("../src/pipeline/gate.js");
		const { sealFacts } = await import("../src/pipeline/facts.js");
		const entries: SessionEntry[] = [
			user("run tests", 1),
			think("думаю", 2),
			call("c1", "Bash", 3),
			result("c1", "Tests: 2 failed | 8 passed (10)", 4, true),
		];
		const turn = segmentTurns(entries).at(-1) as Turn;
		const anchors = anchorTurn(turn);
		const sealed = sealFacts(turn);
		expect(sealed.checks).toEqual({ run: 10, failed: 2 });

		const block = {
			anchor: { fromLine: 99, toLine: 200 }, // outside the turn → corrected
			action: "прогнал тесты",
			thoughts: [{ kind: "H" as const, source: "thinking" as const, text: "думаю о моке", q: "qffffff" }],
			factsClaimed: { checks: { run: 10, failed: 3 } },
		};
		const gate = gateBlock(block, anchors, sealed);
		expect(gate.anchorCorrected).toBe(true);
		expect(gate.quoteValid).toBe(false);
		const thought = block.thoughts[0];
		expect(thought !== undefined).toBe(true);
		expect(thought?.source).toBe("inferred");
		expect(gate.disputes).toHaveLength(1);
		expect(gate.disputes[0]?.claimed).toContain("3 failed");
		expect(gate.disputes[0]?.sealed).toContain("2 failed");
	});
});

describe("v2 groupform", () => {
	it("collapses identical calls to ×N but keeps result-class transitions", async () => {
		const { segmentTurns } = await import("../src/pipeline/turns.js");
		const { anchorTurn } = await import("../src/pipeline/anchors.js");
		const { renderGroupedTurns } = await import("../src/pipeline/groupform.js");
		const entries: SessionEntry[] = [
			user("t", 1),
			think("мысль: проверяем два раза", 2),
			call("c1", "Bash", 3),
			result("c1", "ok: build done", 4),
			call("c2", "Bash", 5),
			result("c2", "ok: build done", 6),
			call("c3", "Bash", 7),
			result("c3", "ERR: boom", 8, true),
		];
		const turn = segmentTurns(entries).at(-1) as Turn;
		const anchors = anchorTurn(turn);
		const block = {
			anchor: { fromLine: turn.fromLine, toLine: turn.toLine },
			action: "дважды билдил, потом упал",
			thoughts: [{ kind: "INSIGHT" as const, source: "thinking" as const, text: "проверяем два раза", q: anchors.quotes[0]?.q ?? "q000000" }],
		};
		const text = renderGroupedTurns([{ turn, anchors, entries, block, disputes: [] }]);
		expect(text).toContain("💭 INSIGHT");
		expect(text).toContain("×2");
		// ERR→ok transition is not collapsed into the ×2 run
		expect(text).toContain("ERR: boom");
		expect(text).toContain("→ дважды билдил, потом упал");
	});
});

describe("v2 contracts", () => {
	it("validates pass-1 blocks with actionable errors", async () => {
		const { validatePass1Block, extractJsonObject } = await import("../src/pipeline/contracts.js");
		const ctx = { fromLine: 10, toLine: 20, quoteIds: new Set(["qabc123"]) };
		const good = {
			anchor: { fromLine: 10, toLine: 20 },
			action: "делал",
			thought: { kind: "H", source: "thinking", text: "гипотеза", q: "qabc123" },
		};
		const errs = validatePass1Block(good, ctx);
		expect(errs).toEqual([]);

		const bad = extractJsonObject('вот: ```json\n{"anchor":{"fromLine":5,"toLine":99},"action":"x","thought":{"kind":"NOPE","source":"thinking","text":"y","q":"qzzzzzz"}}\n```');
		const errors = validatePass1Block(bad, ctx);
		expect(errors.some((e) => e.startsWith("anchor_out_of_block"))).toBe(true);
		expect(errors.some((e) => e.includes("thought.kind"))).toBe(true);
		expect(errors.some((e) => e.includes("thought.q"))).toBe(true);
	});

	it("validates pass-2 output", async () => {
		const { validatePass2 } = await import("../src/pipeline/contracts.js");
		const good = {
			arcs: [{ kind: "H", text: "x", status: "refuted", fromLine: 10 }],
			reasoningIndex: [{ kind: "H", line: 10, subject: "auth", status: "refuted" }],
			verdict: { status: "success", why: "ok" },
			items: [{ title: "t", description: "d", content: "c", polarity: "strategy", subject: ["s"], evidence: [{ line: 10 }] }],
		};
		expect(validatePass2(good)).toEqual([]);
		expect(validatePass2({ arcs: "nope" }).length).toBeGreaterThan(0);
	});
});

describe("v2 sidecar", () => {
	it("round-trips records and skips on schema mismatch", async () => {
		const { SIDECAR_SCHEMA_VERSION, blockKey, sliceHashOf } = await import("../src/pipeline/sidecar.js");
		expect(SIDECAR_SCHEMA_VERSION).toBe(3);
		expect(sliceHashOf("abc")).toBe(sliceHashOf("abc"));
		expect(sliceHashOf("abc")).not.toBe(sliceHashOf("abd"));
		expect(blockKey(1, 2, "h")).toBe("1:2:h");
	});
});

describe("v2 pi adapter", () => {
	it("parses pi session entries with tool calls and narration", async () => {
		const { parsePiSession } = await import("../src/sources/pi/parse.js");
				const fixture = "./test/fixtures/pi-session.jsonl";
		const s = await parsePiSession(fixture);
		expect(s.source).toBe("pi");
		expect(s.cwd).toBe("/proj/demo");
		const kinds = s.entries.map((e) => e.kind);
		expect(kinds).toContain("user_text");
		expect(kinds).toContain("assistant_thinking");
		expect(kinds).toContain("tool_call");
		expect(kinds).toContain("tool_result");
		expect(kinds).toContain("assistant_text");
	});
});
