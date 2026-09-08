/**
 * `work init`: build the state dir — cursor export, session inventory,
 * deterministic skeletons. Every stage is resumable: existing artifacts are
 * reused, so interrupting and re-running is always safe.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { exportCursorIdeSessions } from "../sources/cursor/ide.js";
import { exportCursorAgentSessions } from "../sources/cursor/agentcli.js";
import { ensureDet } from "./det.js";
import { inventorySessions, writeRegistry } from "./registry.js";
import { saveState, workPaths, type WorkState } from "./state.js";
import { writeJobsIndex } from "./jobs-index.js";
import { withLock } from "./lock.js";

export interface InitReport {
	stateDir: string;
	cursor: { ide: { exported: number; skipped: number; errors: number } | null; agent: { exported: number; skipped: number; errors: number } | null };
	sessions: number;
	detBuilt: number;
	detReused: number;
	detFailed: { sessionId: string; error: string }[];
}

export async function runInit(stateDir: string, state: WorkState): Promise<InitReport> {
	const paths = workPaths(stateDir);
	await mkdir(paths.detDir, { recursive: true });
	await mkdir(paths.jobsDir, { recursive: true });
	await mkdir(paths.resultsDir, { recursive: true });
	await saveState(paths, state);

	const report: InitReport = {
		stateDir,
		cursor: { ide: null, agent: null },
		sessions: 0,
		detBuilt: 0,
		detReused: 0,
		detFailed: [],
	};

	await withLock(stateDir, async () => {
		// 1. cursor exports (resumable: existing .jsonl are skipped)
		if (state.cursorIde !== null) {
			const out = join(stateDir, state.cursorIde.out);
			await mkdir(out, { recursive: true });
			const r = await exportCursorIdeSessions(state.cursorIde.db, out);
			report.cursor.ide = { exported: r.exported, skipped: r.skipped, errors: r.errors.length };
		}
		if (state.cursorAgent !== null) {
			const out = join(stateDir, state.cursorAgent.out);
			await mkdir(out, { recursive: true });
			const r = await exportCursorAgentSessions(state.cursorAgent.chatsRoot, out, {
				workspaceStorageDir: state.cursorAgent.workspaceStorageDir,
			});
			report.cursor.agent = { exported: r.exported, skipped: r.skipped, errors: r.errors.length };
		}

		// 2. inventory (fresh scan each init: cheap, picks up new logs)
		const records = await inventorySessions(paths, state);
		await writeRegistry(paths, records);
		report.sessions = records.length;

		// 3. deterministic skeletons (skip fresh ones)
		let done = 0;
		for (const record of records) {
			done++;
			try {
				const { built } = await ensureDet(paths, record, state.segOptions);
				if (built) report.detBuilt++;
				else report.detReused++;
			} catch (err) {
				report.detFailed.push({ sessionId: record.sessionId, error: err instanceof Error ? err.message : String(err) });
			}
			if (done % 100 === 0) progress(`det ${done}/${records.length}`);
		}

		// 4. job index (claim/status read this instead of every det file)
		await writeJobsIndex(paths, records);
	});

	return report;
}

function progress(message: string): void {
	console.error(`[work-init] ${message}`);
}
