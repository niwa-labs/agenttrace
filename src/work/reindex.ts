/**
 * `work reindex`: change segmentation (smaller claim batches) without losing
 * done work.
 *
 * Rebuilds det skeletons for every session under the new segment options,
 * regenerates the jobs index, then reconciles the ledger: any new pass1
 * window whose turns are ALL covered by the sidecar (compressed under the
 * same prompt hash) is marked submit-ok automatically — no model rework.
 * Pass2 done markers carry over by sessionId and stay valid.
 */

import { appendFile } from "node:fs/promises";
import { blockKey, readSidecar } from "../pipeline/sidecar.js";
import { ensureDet, loadDet } from "./det.js";
import { writeJobsIndex } from "./jobs-index.js";
import { inventorySessions, writeRegistry } from "./registry.js";
import { loadState, saveState, workPaths } from "./state.js";
import { withLock } from "./lock.js";

export interface ReindexReport {
	windowTokens: number;
	turnTokens: number;
	sessions: number;
	detRebuilt: number;
	jobs: number;
	autoDone: number;
}

export async function runReindex(stateDir: string, opts: { windowTokens?: number; turnTokens?: number }): Promise<ReindexReport> {
	const paths = workPaths(stateDir);
	return withLock(stateDir, async () => {
		const state = await loadState(paths);
		if (opts.windowTokens !== undefined) state.segOptions.windowBudgetTokens = opts.windowTokens;
		if (opts.turnTokens !== undefined) state.segOptions.turnBudgetTokens = opts.turnTokens;
		await saveState(paths, state);

		const records = await inventorySessions(paths, state);
		// keep the registry in sync: inventory may discover new sessions that
		// the index will reference, and claim rejects jobs without a registry entry
		await writeRegistry(paths, records);
		const report: ReindexReport = {
			windowTokens: state.segOptions.windowBudgetTokens,
			turnTokens: state.segOptions.turnBudgetTokens,
			sessions: records.length,
			detRebuilt: 0,
			jobs: 0,
			autoDone: 0,
		};

		// 1. rebuild det skeletons that don't match the new segmentation
		let done = 0;
		for (const record of records) {
			try {
				const { built } = await ensureDet(paths, record, state.segOptions);
				if (built) report.detRebuilt++;
			} catch {
				// unparseable log — leave as-is (jobs index skips it)
			}
			done++;
			if (done % 500 === 0) emitProgress(`det ${done}/${records.length}`);
		}

		// 2. regenerate the jobs index under the new windows
		report.jobs = await writeJobsIndex(paths, records);

		// 3. reconcile: mark new windows whose turns are all sidecar-covered as done
		const doneEvents: string[] = [];
		for (const record of records) {
			const det = await loadDet(paths, record.sessionId);
			if (det === undefined || det.turns.length === 0) continue;
			const coverage = await readSidecar(record.logFile, state.pass1PromptHash);
			if (coverage.size === 0) continue;
			const byIndex = new Map(det.turns.map((t) => [t.index, t]));
			for (const w of det.windows) {
				const covered = w.turnIndexes.every((ti) => {
					const t = byIndex.get(ti);
					return t !== undefined && coverage.has(blockKey(t.fromLine, t.toLine, t.sliceHash));
				});
				if (covered) doneEvents.push(JSON.stringify({ ts: new Date().toISOString(), ev: "submit-ok", jobId: `p1-${record.sessionId}-w${w.index}`, worker: "reindex" }));
			}
		}
		if (doneEvents.length > 0) {
			await appendFile(paths.ledgerFile, doneEvents.join("\n") + "\n", "utf8");
		}
		report.autoDone = doneEvents.length;
		emitProgress(`done: det rebuilt ${report.detRebuilt}, jobs ${report.jobs}, auto-done ${report.autoDone}`);
		return report;
	});
}

function emitProgress(message: string): void {
	console.error(`[work-reindex] ${message}`);
}
