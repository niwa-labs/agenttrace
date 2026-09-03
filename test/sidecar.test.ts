import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendSidecar,
	blockKey,
	readSidecar,
	readSidecarDigests,
	SIDECAR_SCHEMA_VERSION,
	sidecarPath,
	sliceHashOf,
	type DigestRecord,
	type Pass1Record,
} from "../src/pipeline/sidecar.js";

function blockRec(overrides: Partial<Pass1Record> = {}): Pass1Record {
	return {
		type: "block",
		schemaVersion: SIDECAR_SCHEMA_VERSION,
		promptHash: "p1",
		sessionId: "sess-1",
		logFile: "session.jsonl",
		fromLine: 1,
		toLine: 10,
		sliceHash: "aaa",
		windowIndex: 0,
		toolNames: ["Bash"],
		tokens: 120,
		result: { anchor: { fromLine: 1, toLine: 10 }, action: "ran tests" },
		retries: 0,
		fallback: false,
		ts: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function digestRec(overrides: Partial<DigestRecord> = {}): DigestRecord {
	return {
		type: "digest",
		schemaVersion: SIDECAR_SCHEMA_VERSION,
		promptHash: "p1",
		sessionId: "sess-1",
		logFile: "session.jsonl",
		windowIndex: 1,
		sliceHash: "bbb",
		digest: { goal: "починить тесты" },
		ts: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("v2 sidecar", () => {
	let dir: string;
	let logFile: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "sidecar-"));
		logFile = join(dir, "session.jsonl"); // the log itself need not exist
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("round-trips block and digest records through the sidecar file", async () => {
		await appendSidecar(logFile, [
			blockRec({ fromLine: 1, toLine: 10, sliceHash: "h1" }),
			blockRec({ fromLine: 11, toLine: 20, sliceHash: "h2", fallback: true, retries: 2 }),
			digestRec({ windowIndex: 1 }),
		]);

		const map = await readSidecar(logFile);
		expect(map.size).toBe(2);
		const rec = map.get(blockKey(1, 10, "h1"));
		expect(rec?.type).toBe("block");
		if (rec?.type !== "block") throw new Error("expected a block record");
		expect(rec.sessionId).toBe("sess-1");
		expect(rec.toolNames).toEqual(["Bash"]);
		expect(rec.tokens).toBe(120);
		expect(rec.result).toEqual({ anchor: { fromLine: 1, toLine: 10 }, action: "ran tests" });
		const rec2 = map.get(blockKey(11, 20, "h2"));
		if (rec2?.type !== "block") throw new Error("expected a block record");
		expect(rec2.fallback).toBe(true);
		expect(rec2.retries).toBe(2);

		const digests = await readSidecarDigests(logFile);
		expect([...digests.entries()]).toEqual([[1, { goal: "починить тесты" }]]);
	});

	it("appends across calls without losing earlier records", async () => {
		await appendSidecar(logFile, [blockRec({ fromLine: 1, toLine: 5, sliceHash: "h1" })]);
		await appendSidecar(logFile, [blockRec({ fromLine: 6, toLine: 9, sliceHash: "h2" })]);
		expect((await readSidecar(logFile)).size).toBe(2);
	});

	it("filters records by the current promptHash", async () => {
		await appendSidecar(logFile, [
			blockRec({ sliceHash: "h1", promptHash: "p1" }),
			blockRec({ fromLine: 11, toLine: 20, sliceHash: "h2", promptHash: "p2" }),
			digestRec({ windowIndex: 1, promptHash: "p1" }),
			digestRec({ windowIndex: 2, promptHash: "p2" }),
		]);

		const p1 = await readSidecar(logFile, "p1");
		expect(p1.size).toBe(1);
		expect(p1.get(blockKey(1, 10, "h1"))?.promptHash).toBe("p1");
		expect((await readSidecar(logFile, "p2")).size).toBe(1);
		expect((await readSidecar(logFile)).size).toBe(2); // no filter → everything

		expect([...(await readSidecarDigests(logFile, "p1")).keys()]).toEqual([1]);
		expect([...(await readSidecarDigests(logFile, "p2")).keys()]).toEqual([2]);
		expect([...(await readSidecarDigests(logFile)).keys()].sort()).toEqual([1, 2]);
	});

	it("skips records with a different schemaVersion", async () => {
		await appendSidecar(logFile, [
			blockRec({ schemaVersion: SIDECAR_SCHEMA_VERSION - 1 }),
			blockRec({ fromLine: 11, toLine: 20, sliceHash: "h2" }),
			digestRec({ schemaVersion: SIDECAR_SCHEMA_VERSION + 1 }),
		]);
		expect((await readSidecar(logFile)).size).toBe(1);
		expect((await readSidecarDigests(logFile)).size).toBe(0);
	});

	it("tolerates corrupt lines from partial writes", async () => {
		await appendSidecar(logFile, [blockRec()]);
		await appendFile(sidecarPath(logFile), '{"type": "block", "schemaVers\n', "utf8");
		await appendSidecar(logFile, [blockRec({ fromLine: 11, toLine: 20, sliceHash: "h2" })]);
		expect((await readSidecar(logFile)).size).toBe(2);
		expect((await readSidecarDigests(logFile)).size).toBe(0);
	});

	it("readSidecar on a missing sidecar and empty appends are safe", async () => {
		expect((await readSidecar(logFile)).size).toBe(0);
		expect((await readSidecarDigests(logFile)).size).toBe(0);
		await appendSidecar(logFile, []); // no-op
		await expect(access(sidecarPath(logFile))).rejects.toThrow(); // no file created
	});

	it("names the sidecar next to the log", () => {
		expect(sidecarPath("logs/s.jsonl")).toBe("logs/s.jsonl.pass1.jsonl");
		expect(blockKey(3, 7, "deadbeef")).toBe("3:7:deadbeef");
	});

	it("sliceHashOf is stable and input-sensitive", () => {
		expect(sliceHashOf("the same slice")).toBe(sliceHashOf("the same slice"));
		expect(sliceHashOf("привет мир срез")).toBe(sliceHashOf("привет мир срез"));
		expect(sliceHashOf("a")).not.toBe(sliceHashOf("b"));
		expect(sliceHashOf("abc")).not.toBe(sliceHashOf("abd"));
		expect(sliceHashOf("abc")).not.toBe(sliceHashOf("abcd"));
		// FNV-1a offset basis — pinned so accidental hash changes get noticed
		expect(sliceHashOf("")).toBe("811c9dc51000193");
	});
});
