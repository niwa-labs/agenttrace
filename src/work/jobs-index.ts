/**
 * Precomputed job index: `<stateDir>/jobs-index.jsonl`.
 *
 * Built once at `work init` from the det skeletons; claim/status/layer read
 * this small flat file instead of parsing thousands of det JSONs per call.
 * Entries are stored in canonical claim order.
 */

import { readFile, writeFile } from "node:fs/promises";
import { pass1JobId, pass2JobId } from "./jobs.js";
import { loadDet } from "./det.js";
import type { SessionRecord } from "./registry.js";
import type { WorkPaths } from "./state.js";

export interface JobIndexEntry {
	jobId: string;
	layer: "pass1" | "pass2";
	sessionId: string;
	project?: string;
	startedAt?: string;
	windowIndex?: number;
	windowCount?: number;
	tokens: number;
}

export async function writeJobsIndex(paths: WorkPaths, records: SessionRecord[]): Promise<number> {
	const entries: JobIndexEntry[] = [];
	for (const record of records) {
		const det = await loadDet(paths, record.sessionId);
		if (det === undefined) continue;
		const project = det.project ?? record.project;
		const startedAt = det.startedAt ?? record.startedAt;
		for (const w of det.windows) {
			entries.push({
				jobId: pass1JobId(record.sessionId, w.index),
				layer: "pass1",
				sessionId: record.sessionId,
				...(project !== undefined ? { project } : {}),
				...(startedAt !== undefined ? { startedAt } : {}),
				windowIndex: w.index,
				windowCount: det.windows.length,
				tokens: w.tokens,
			});
		}
		entries.push({
			jobId: pass2JobId(record.sessionId),
			layer: "pass2",
			sessionId: record.sessionId,
			...(project !== undefined ? { project } : {}),
			...(startedAt !== undefined ? { startedAt } : {}),
			tokens: 0,
		});
	}
	entries.sort(compareEntries);
	await writeFile(paths.jobsIndexFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
	return entries.length;
}

/**
 * Canonical claim order: newest sessions first — the queue drains from the
 * present into the past, so freshly accumulated logs are distilled while
 * context around them is still fresh. Sessions without a timestamp go last.
 * Ties (same session) keep project/session order with pass1 windows ascending
 * and pass2 after them.
 */
function compareEntries(a: JobIndexEntry, b: JobIndexEntry): number {
	const ta = a.startedAt ?? "0000";
	const tb = b.startedAt ?? "0000";
	if (ta !== tb) return tb.localeCompare(ta);
	return sortKey(a).localeCompare(sortKey(b));
}

function sortKey(e: JobIndexEntry): string {
	return `${e.project ?? "unknown"}\t${e.sessionId}\t${e.layer}\t${String(e.windowIndex ?? 0).padStart(6, "0")}`;
}

export async function readJobsIndex(paths: WorkPaths): Promise<JobIndexEntry[]> {
	const out: JobIndexEntry[] = [];
	let raw: string;
	try {
		raw = await readFile(paths.jobsIndexFile, "utf8");
	} catch {
		return out;
	}
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			out.push(JSON.parse(line) as JobIndexEntry);
		} catch {
			// torn tail — skip
		}
	}
	return out;
}
