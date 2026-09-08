/**
 * Regression: discovery must find sessions whose first `cwd` sits far beyond
 * any fixed byte window (long service preamble), and distill must honor
 * `--only` and the pi source.
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { discoverClaudeSessions, sniffCwd } from "../src/sources/claude/discover.js";
import { runDistill } from "../src/cli/pipeline.js";

const ROOT = "/tmp/raiseki-fix";

function claudeLine(uuid: string, cwd: string, text: string): string {
	return JSON.stringify({
		type: "user",
		sessionId: uuid,
		uuid: `u-${uuid}`,
		parentUuid: null,
		timestamp: "2026-06-01T10:00:00.000Z",
		cwd,
		isSidechain: false,
		message: { role: "user", content: text },
	});
}

describe("claude discovery with long service preamble", () => {
	it("sniffCwd finds cwd beyond 8KB and discover filters by root", async () => {
		const base = await mkdtemp(join(tmpdir(), "raiseki-disc-"));
		const projects = join(base, "projects", "-tmp-raiseki-fix");
		await mkdir(projects, { recursive: true });

		// filler line > 8KB pushes the cwd record past any fixed byte window
		const filler = "x".repeat(20_000);
		const late = join(projects, "late.jsonl");
		await writeFile(
			late,
			[JSON.stringify({ type: "queued-tools", payload: { filler } }), claudeLine("late-1", `${ROOT}/demo`, "fix it")].join("\n") + "\n",
			"utf8",
		);

		// a session with no cwd at all — must be skipped, not crash
		const noCwd = join(projects, "nocwd.jsonl");
		await writeFile(noCwd, JSON.stringify({ type: "summary", summary: "nothing here" }) + "\n", "utf8");

		const cwd = await sniffCwd(late);
		expect(cwd).toBe(`${ROOT}/demo`);

		const found = await discoverClaudeSessions(ROOT, join(base, "projects"));
		expect(found).toEqual([late]);
	});
});

describe("distill --only and pi source", () => {
	it("honors --only and parses pi sessions", async () => {
		const base = await mkdtemp(join(tmpdir(), "raiseki-distill-"));
		const projects = join(base, "projects", "-tmp-raiseki-fix");
		const piRoot = join(base, "pi");
		const piDir = join(piRoot, "--tmp-raiseki-fix--");
		await mkdir(projects, { recursive: true });
		await mkdir(piDir, { recursive: true });

		await writeFile(join(projects, "alpha.jsonl"), claudeLine("alpha-1", `${ROOT}/demo`, "задача альфа") + "\n", "utf8");
		await writeFile(join(projects, "beta.jsonl"), claudeLine("beta-1", `${ROOT}/demo`, "задача бета") + "\n", "utf8");
		// pi session format (minimal, with cwd + one user turn)
		await writeFile(
			join(piDir, "2026-06-01T10-00-00_pi-demo-0001.jsonl"),
			[
				JSON.stringify({ type: "session", version: 3, id: "pi-demo-0001", timestamp: "2026-06-01T10:00:00.000Z", cwd: `${ROOT}/demo` }),
				JSON.stringify({
					type: "message",
					id: "m1",
					timestamp: "2026-06-01T10:00:05.000Z",
					message: { role: "user", stopReason: "end_turn", content: [{ type: "text", text: "задача паяльник pi" }] },
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const common = {
			rootDir: ROOT,
			sources: ["claude", "pi"] as ("claude" | "pi")[],
			chain: { enabled: false, tightGapMinutes: 5, looseGapMinutes: 45 },
			claudeProjectsDir: join(base, "projects"),
			piSessionsDir: piRoot,
		};

		// --only narrows discovery to the alpha log; the pi log (different name) is filtered out
		const onlyAlpha = await runDistill({ ...common, outDir: join(base, "out-only"), only: "alpha" });
		expect(onlyAlpha.logsScanned).toBe(1);
		expect(onlyAlpha.logsParsed).toBe(1);
		expect(onlyAlpha.traces.length).toBe(1);

		// without --only both claude logs and the pi log are parsed
		const all = await runDistill({ ...common, outDir: join(base, "out-all") });
		expect(all.logsScanned).toBe(3);
		expect(all.logsParsed).toBe(3);
		expect(all.traces.length).toBeGreaterThanOrEqual(2);

		// --repo-bound strips private coordinates: no @L anchors, no absolute project path
		const bound = await runDistill({ ...common, outDir: join(base, "out-bound"), only: "alpha", repoBound: true });
		const boundFile = bound.traces[0]?.file;
		const rawFile = onlyAlpha.traces[0]?.file;
		expect(boundFile).toBeDefined();
		expect(rawFile).toBeDefined();
		if (boundFile === undefined || rawFile === undefined) return;
		const boundMd = await readFile(boundFile, "utf8");
		expect(boundMd).not.toMatch(/@L\d+/);
		expect(boundMd).not.toContain(ROOT);
		expect(boundMd).not.toMatch(/^\s*logFile:/m);
		const rawMd = await readFile(rawFile, "utf8");
		expect(rawMd).toMatch(/@L\d+/);
	}, 30_000);
});
