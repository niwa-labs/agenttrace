/**
 * Work-server core: init → claim → submit → layer unlock → finalize.
 * Drives the real functions against a tiny synthetic claude root.
 */

import { mkdtemp, mkdir, copyFile, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runInit } from "../src/work/init.js";
import { runReindex } from "../src/work/reindex.js";
import { claimJob, listLayerPage, releaseJob, statusSummary } from "../src/work/jobs.js";
import { submitJob } from "../src/work/submit.js";
import { finalize } from "../src/work/finalize.js";
import { readSidecar } from "../src/pipeline/sidecar.js";
import type { Pass1Job } from "../src/work/jobs.js";
import type { WorkState } from "../src/work/state.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/claude-session.jsonl", import.meta.url));

let root: string;

// tiny budgets so the 18-line fixture splits into several windows:
// window chaining (w<n> claimable only after w<n-1> done) then gets exercised
function testState(claudeRoot: string): WorkState {
	return {
		schemaVersion: 1,
		createdAt: new Date().toISOString(),
		roots: { claude: [claudeRoot], codex: [], pi: [] },
		cursorIde: null,
		cursorAgent: null,
		segOptions: { turnBudgetTokens: 60, windowBudgetTokens: 300 },
		pass2InputTokenBudget: 25_000,
		pass1PromptHash: "p1v3:agent",
		leaseMinutes: 45,
	};
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "sd-work-"));
	const claudeRoot = join(root, "claude-projects", "proj-demo");
	await mkdir(claudeRoot, { recursive: true });
	await copyFile(FIXTURE, join(claudeRoot, "session-a.jsonl"));
	await copyFile(FIXTURE, join(claudeRoot, "session-b.jsonl"));
	void afterAll;
});

describe("work server", () => {
	it("init: registry + det skeletons for both sessions", async () => {
		const stateDir = join(root, "state");
		const report = await runInit(stateDir, testState(join(root, "claude-projects")));
		expect(report.sessions).toBe(2);
		expect(report.detBuilt).toBe(2);
		expect(report.detFailed).toHaveLength(0);
		const detFiles = await readdir(join(stateDir, "det"));
		expect(detFiles).toHaveLength(2);
	});

	it("reindex: registry syncs sessions discovered after init", async () => {
		const stateDir = join(root, "state-reindex");
		await runInit(stateDir, testState(join(root, "claude-projects")));
		await copyFile(FIXTURE, join(root, "claude-projects", "proj-demo", "session-c.jsonl"));
		const report = await runReindex(stateDir, { windowTokens: 300 });
		expect(report.sessions).toBe(3);
		const registry = (await readFile(join(stateDir, "sessions.jsonl"), "utf8"))
			.split("\n")
			.filter((l) => l.trim().length > 0);
		expect(registry).toHaveLength(3);
	});

	it("status: sessions registered, projects derived from cwd", async () => {
		const st = await statusSummary(join(root, "state"));
		expect(st.sessions.total).toBe(2);
		expect(st.sessions.withJobs).toBe(2);
		expect(st.projects).toContainEqual({ project: "demo", sessions: 2 });
		const pass1 = st.layers.find((l) => l.layer === "pass1");
		const pass2 = st.layers.find((l) => l.layer === "pass2");
		expect(pass1?.total).toBeGreaterThan(2); // multiple windows per session
		expect(pass2?.total).toBe(2);
	});

	it("pass2 locked until a session's own pass1 is done", async () => {
		const r = await claimJob(join(root, "state"), "pass2", "w", 45);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("all-claimed"); // pass2 jobs exist but no session has all windows done yet
	});

	it("claim → reject bad submit → accept good submit, window by window", async () => {
		const stateDir = join(root, "state");
		let claimed = 0;
		for (;;) {
			const r = await claimJob(stateDir, "pass1", "agent-1", 45);
			if (!r.ok) {
				expect(["empty", "all-claimed"]).toContain(r.code);
				break;
			}
			expect(r.job.layer).toBe("pass1");
			const job = r.job as Pass1Job;
			claimed++;

			// bad answer rejected with machine-fixable errors
			const bad = await submitJob(stateDir, job.jobId, JSON.stringify({ blocks: [] }));
			expect(bad.ok).toBe(false);
			if (!bad.ok) expect(bad.errors.join(" ")).toMatch(/missing block|non-empty/);

			// good answer: one block per turn, digest for non-final windows
			const body = {
				blocks: job.turns.map((t) => ({
					turnIndex: t.turnIndex,
					anchor: { fromLine: t.fromLine, toLine: t.toLine },
					action: `сжатый ход ${t.turnIndex} для теста`,
					thoughts:
						t.thoughtQs.length > 0
							? [{ kind: "INSIGHT", source: "thinking", text: "суть мысли из фикстуры", q: t.thoughtQs[0] }]
							: [],
				})),
				...(job.isLastWindow ? {} : { digest: { goal: "тестовая цель", openHypotheses: [], currentBelief: "тестовое состояние" } }),
			};
			const ok = await submitJob(stateDir, job.jobId, JSON.stringify(body));
			expect(ok.ok).toBe(true);
		}
		expect(claimed).toBeGreaterThan(2);

		// sidecar records landed next to the original log under the agent prompt hash
		const detFiles = await readdir(join(stateDir, "det"));
		const firstDet = detFiles[0];
		if (firstDet === undefined) throw new Error("no det files");
		const det = JSON.parse(await readFile(join(stateDir, "det", firstDet), "utf8")) as { logFile: string };
		const coverage = await readSidecar(det.logFile, "p1v3:agent");
		expect(coverage.size).toBeGreaterThan(0);
	});

	it("pass1 exhausted → pass2 unlocks, claim/submit works", async () => {
		const stateDir = join(root, "state");
		const st = await statusSummary(stateDir);
		const pass1 = st.layers.find((l) => l.layer === "pass1");
		expect(pass1?.done).toBe(pass1?.total);

		const r = await claimJob(stateDir, "pass2", "agent-2", 45);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const job = r.job;
		expect(job.layer).toBe("pass2");
		if (job.layer !== "pass2") return;
		expect(job.groupedForm).toContain("#### b");
		expect(job.factsFooter).toContain("@L");
		const ok = await submitJob(stateDir, job.jobId, pass2Body());
		expect(ok.ok).toBe(true);
	});

	function pass2Body(): string {
		return JSON.stringify({
			arcs: [{ kind: "H", status: "confirmed", text: "гипотеза из фикстуры подтвердилась", fromLine: 1, toLine: 5, subject: "demo" }],
			verdict: { status: "success", why: "тесты починены" },
			items: [
				{
					title: "Сначала читать структуру",
					description: "Прежде чем чинить, осмотреть файлы",
					content: "Агент начал с чтения структуры проекта и не гадал.",
					polarity: "strategy",
					subject: ["demo"],
					evidence: [{ line: 3 }],
				},
			],
		});
	}

	it("lease: second claim of the same layer is refused until release", async () => {
		const stateDir = join(root, "state");
		const first = await claimJob(stateDir, "pass2", "agent-3", 45);
		expect(first.ok).toBe(true);
		const second = await claimJob(stateDir, "pass2", "agent-4", 45);
		expect(second.ok).toBe(false);
		// release → claimable again; submit it so finalize sees both sessions
		if (first.ok) {
			const rel = await releaseJob(stateDir, first.job.jobId);
			expect(rel.ok).toBe(true);
			const third = await claimJob(stateDir, "pass2", "agent-4", 45);
			expect(third.ok).toBe(true);
			if (third.ok) {
				const ok = await submitJob(stateDir, third.job.jobId, pass2Body());
				expect(ok.ok).toBe(true);
			}
		}
	});

	it("layer paging with cursor", async () => {
		const stateDir = join(root, "state");
		const page1 = await listLayerPage(stateDir, "pass1", undefined, 2);
		expect(page1.jobs).toHaveLength(2);
		expect(page1.nextCursor).toBeDefined();
		const page2 = await listLayerPage(stateDir, "pass1", page1.nextCursor, 2);
		expect(page2.jobs).toHaveLength(2);
		expect(page2.jobs[0]?.jobId).not.toBe(page1.jobs[0]?.jobId);
	});

	it("finalize: trace per project + bank + metrics", async () => {
		const stateDir = join(root, "state");
		const report = await finalize(stateDir);
		expect(report.traces).toHaveLength(2);
		expect(report.projects).toEqual(["demo"]);
		expect(report.skippedNoPass2).toHaveLength(0);
		for (const t of report.traces) {
			const s = await stat(join(stateDir, "traces", t.file));
			expect(s.size).toBeGreaterThan(200);
		}
		const bankRaw = await readFile(join(stateDir, "bank", "INDEX.md"), "utf8").catch(() => "");
		// two pass-2 submits with identical items dedup to one bank entry
		expect(bankRaw).toContain("Сначала читать структуру");
		const metrics = await readFile(join(stateDir, "metrics.jsonl"), "utf8");
		expect(metrics.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(2);
	});
});
