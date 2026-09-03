import { describe, expect, it } from "vitest";
import { accountSession, renderFacts, sealFacts } from "../src/pipeline/facts.js";
import type { DiffStats, SessionEntry } from "../src/model/session.js";
import type { Turn } from "../src/pipeline/turns.js";

function call(id: string, name: string, logLine: number, sidechain = false): SessionEntry {
	return { kind: "tool_call", name, input: { command: "x" }, toolCallId: id, timestamp: "t", logLine, sidechain };
}

interface ResultOpts {
	isError?: boolean;
	interrupted?: boolean;
	content?: string;
	exitCode?: number;
	diff?: DiffStats;
	sidechain?: boolean;
}

function result(id: string, logLine: number, opts: ResultOpts = {}): SessionEntry {
	return {
		kind: "tool_result",
		toolCallId: id,
		content: opts.content ?? "ok",
		isError: opts.isError ?? false,
		interrupted: opts.interrupted ?? false,
		timestamp: "t",
		logLine,
		sidechain: opts.sidechain ?? false,
		...(opts.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
		...(opts.diff !== undefined ? { diff: opts.diff } : {}),
	};
}

function compaction(logLine: number, sidechain = false): SessionEntry {
	return { kind: "compaction", timestamp: "t", logLine, sidechain };
}

describe("facts accountSession", () => {
	it("counts tool calls, errors, interrupts and compactions", () => {
		const acc = accountSession([
			call("c1", "Bash", 1),
			result("c1", 2),
			call("c2", "Edit", 3),
			result("c2", 4, { isError: true, interrupted: true }),
			compaction(5),
			result("c1", 6, { interrupted: true }), // a retry result also interrupted
			compaction(7),
		]);
		expect(acc.toolCalls).toBe(2);
		expect(acc.toolErrors).toBe(1);
		expect(acc.interrupted).toBe(2);
		expect(acc.compactions).toBe(2);
	});

	it("detects check summaries; the last observation wins", () => {
		const acc = accountSession([
			call("c1", "Bash", 1),
			result("c1", 2, { content: "Tests: 2 failed | 8 passed (10)" }),
			call("c2", "Bash", 3),
			result("c2", 4, { content: "test result: ok. 5 passed; 0 failed; 1 ignored" }),
		]);
		expect(acc.checks).toEqual({ run: 5, failed: 0 });
	});

	it("leaves checks undefined without a runner summary", () => {
		const acc = accountSession([call("c1", "Bash", 1), result("c1", 2, { content: "hello world" })]);
		expect(acc.checks).toBeUndefined();
	});

	it("sums diffs across results and counts distinct modified files", () => {
		const acc = accountSession([
			call("e1", "Edit", 1),
			result("e1", 2, { diff: { added: 10, removed: 2, filePath: "src/a.ts" } }),
			call("e2", "Edit", 3),
			result("e2", 4, { diff: { added: 1, removed: 0, filePath: "src/a.ts" } }),
			call("e3", "Write", 5),
			result("e3", 6, { diff: { added: 4, removed: 0, filePath: "src/b.ts" } }),
		]);
		expect(acc.diffAdded).toBe(15);
		expect(acc.diffRemoved).toBe(2);
		expect(acc.filesModified).toBe(2); // a.ts counted once
	});

	it("ignores sidechain entries entirely", () => {
		const acc = accountSession([
			call("c1", "Bash", 1, true),
			result("c1", 2, { sidechain: true, isError: true, interrupted: true, diff: { added: 5, removed: 1, filePath: "x.ts" } }),
			compaction(3, true),
		]);
		expect(acc).toEqual({
			toolCalls: 0,
			toolErrors: 0,
			interrupted: 0,
			diffAdded: 0,
			diffRemoved: 0,
			filesModified: 0,
			compactions: 0,
		});
		expect(acc.checks).toBeUndefined();
	});

	it("returns zeros for an empty session", () => {
		expect(accountSession([])).toEqual({
			toolCalls: 0,
			toolErrors: 0,
			interrupted: 0,
			diffAdded: 0,
			diffRemoved: 0,
			filesModified: 0,
			compactions: 0,
		});
	});
});

function turnOf(entries: SessionEntry[], interrupted = false): Turn {
	return {
		index: 1,
		kind: "assistant",
		entries,
		fromLine: 1,
		toLine: entries.length,
		tokens: 10,
		toolNames: ["Bash"],
		interrupted,
	};
}

describe("facts sealFacts + renderFacts", () => {
	it("seals exit code, errors and checks from turn entries", () => {
		const f = sealFacts(
			turnOf([
				call("c1", "Bash", 1),
				result("c1", 2, { exitCode: 3, isError: true, content: "Tests: 1 failed | 4 passed (5)" }),
			]),
		);
		expect(f.toolCalls).toBe(1);
		expect(f.errors).toBe(1);
		expect(f.lastExitCode).toBe(3);
		expect(f.checks).toEqual({ run: 5, failed: 1 });
		expect(f.interrupted).toBe(false);
	});

	it("propagates turn-level interruption", () => {
		const f = sealFacts(turnOf([call("c1", "Bash", 1)], true));
		expect(f.interrupted).toBe(true);
	});

	it("renders the stable key=value line, including the INTERRUPTED marker", () => {
		expect(
			renderFacts({
				toolCalls: 2,
				errors: 1,
				lastExitCode: 0,
				checks: { run: 5, failed: 1 },
				diffAdded: 3,
				diffRemoved: 1,
				interrupted: false,
			}),
		).toBe("calls=2; errors=1; lastExit=0; checks: 5 run / 1 failed; diff +3/−1");
		expect(
			renderFacts({ toolCalls: 0, errors: 0, interrupted: true, diffAdded: 0, diffRemoved: 0 }),
		).toBe("calls=0; errors=0; INTERRUPTED");
	});
});
