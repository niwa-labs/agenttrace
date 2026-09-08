/**
 * Job issuance for external agents: claim / release / status / layer paging.
 *
 * Protocol (one agent = one job of one layer, then it exits — or loops
 * claim→submit within its own token budget):
 *  1. `work claim --layer <L> --worker <name>` → full JSON job payload on stdout
 *  2. agent does the model work, writes one JSON object
 *  3. `work submit <jobId> < result.json` → validator accepts (persists to
 *     sidecar/results + ledger) or rejects with machine-fixable errors
 *
 * Ordering: layers are strict (pass2 unlocks only when every pass1 job is
 * done); within pass1 a window is claimable only when the previous window of
 * the same session is done (digest chaining). A claim holds a lease; an
 * expired lease is silently reclaimable, so interrupted agents lose nothing.
 *
 * Job enumeration comes from the precomputed jobs index (init); det files are
 * read only when building a claimed job's payload.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { anchorTurn } from "../pipeline/anchors.js";
import { renderTurn, renderOptionsForTurn } from "../pipeline/render-turn.js";
import { segmentTurns } from "../pipeline/turns.js";
import { readSidecarDigests } from "../pipeline/sidecar.js";
import type { SourceKind } from "../model/session.js";
import type { CursorLogMeta } from "../sources/cursor/types.js";
import type { SessionRecord } from "./registry.js";
import { appendLedger, deriveJobStates, leaseActive, readLedger, type JobState } from "./ledger.js";
import { readJobsIndex, type JobIndexEntry } from "./jobs-index.js";
import { loadDet, type DetSession, type DetWindow } from "./det.js";
import { readRegistry } from "./registry.js";
import { loadState, workPaths, type WorkPaths, type WorkState } from "./state.js";
import { withLock } from "./lock.js";
import { buildSessionView, parseBySource } from "./view.js";

export type Layer = "pass1" | "pass2";

export const READ_LOG_BUDGET = 12;

export function pass1JobId(sessionId: string, windowIndex: number): string {
	return `p1-${sessionId}-w${windowIndex}`;
}

export function pass2JobId(sessionId: string): string {
	return `p2-${sessionId}`;
}

export function parseJobId(jobId: string): { layer: Layer; sessionId: string; windowIndex?: number } {
	const p1 = /^p1-([0-9a-f]{16})-w(\d+)$/.exec(jobId);
	if (p1) return { layer: "pass1", sessionId: p1[1] as string, windowIndex: Number(p1[2]) };
	const p2 = /^p2-([0-9a-f]{16})$/.exec(jobId);
	if (p2) return { layer: "pass2", sessionId: p2[1] as string };
	throw new Error(`bad jobId: ${jobId}`);
}

export interface Pass1JobTurn {
	turnIndex: number;
	fromLine: number;
	toLine: number;
	/** rendered turn text — the model-facing input */
	text: string;
	quoteIds: string[];
	thoughtQs: string[];
	sliceHash: string;
	toolNames: string[];
	tokens: number;
}

export interface JobEnvelope {
	jobId: string;
	layer: Layer;
	sessionId: string;
	source: SourceKind;
	project?: string;
	projectDir?: string;
	logFile: string;
	logLines: number;
	worker: string;
	claimedAt: string;
	leaseUntil: string;
}

export interface Pass1Job extends JobEnvelope {
	layer: "pass1";
	windowIndex: number;
	windowCount: number;
	windowFromLine: number;
	windowToLine: number;
	isLastWindow: boolean;
	previousDigest: unknown;
	turns: Pass1JobTurn[];
	promptHash: string;
}

export interface Pass2Job extends JobEnvelope {
	layer: "pass2";
	groupedForm: string;
	factsFooter: string;
	groupedTokens: number;
	readLogBudget: number;
}

export type ClaimResult =
	| { ok: true; job: Pass1Job | Pass2Job }
	| { ok: false; code: "layer-locked"; pendingInPreviousLayer: number; message: string }
	| { ok: false; code: "empty"; message: string }
	| { ok: false; code: "all-claimed"; message: string };

const PENDING_SENTINEL: JobState = { jobId: "", status: "pending", fails: 0, claims: 0 };

export async function claimJob(stateDir: string, layer: Layer, worker: string, leaseMinutes: number): Promise<ClaimResult> {
	const paths = workPaths(stateDir);
	const state = await loadState(paths);
	return withLock(stateDir, async () => {
		const index = await readJobsIndex(paths);
		if (index.length === 0) return { ok: false as const, code: "empty" as const, message: "jobs index is empty — run work init first" };
		const states = deriveJobStates(await readLedger(paths.ledgerFile));

		// pass2 unlocks PER SESSION: every pass1 window of that session must be done.
		// (Strict global layering would stall final traces for weeks on a corpus
		// this size; one agent still never mixes layers within a claim.)
		const sessionWindows = new Map<string, { done: number; total: number }>();
		for (const e of index) {
			if (e.layer !== "pass1") continue;
			const agg = sessionWindows.get(e.sessionId) ?? { done: 0, total: 0 };
			agg.total++;
			if (states.get(e.jobId)?.status === "done") agg.done++;
			sessionWindows.set(e.sessionId, agg);
		}

		const now = new Date();
		const leaseUntil = new Date(now.getTime() + leaseMinutes * 60_000).toISOString();

		for (const entry of index) {
			if (entry.layer !== layer) continue;
			const st = states.get(entry.jobId);
			if (st?.status === "done") continue;
			if (leaseActive(st ?? { ...PENDING_SENTINEL, jobId: entry.jobId }, now.getTime())) continue;
			if (layer === "pass1" && (entry.windowIndex ?? 1) > 1) {
				const prev = states.get(pass1JobId(entry.sessionId, (entry.windowIndex ?? 1) - 1));
				if (prev?.status !== "done") continue; // digest chaining: previous window first
			}
			if (layer === "pass2") {
				const agg = sessionWindows.get(entry.sessionId);
				if (agg === undefined || agg.done < agg.total) continue; // session's pass1 incomplete
			}
			const job = await buildPayload(paths, state, entry, worker, now.toISOString(), leaseUntil);
			await writeFile(join(paths.jobsDir, `${entry.jobId}.json`), JSON.stringify(job), "utf8");
			await appendLedger(paths.ledgerFile, [{ ts: now.toISOString(), ev: "claim", jobId: entry.jobId, worker, leaseUntil }]);
			return { ok: true as const, job };
		}

		const openJobs = index.filter((e) => e.layer === layer && states.get(e.jobId)?.status !== "done");
		if (openJobs.length === 0) return { ok: false as const, code: "empty" as const, message: `no ${layer} jobs exist` };
		return { ok: false as const, code: "all-claimed" as const, message: `${openJobs.length} ${layer} job(s) claimed by other workers (expired leases are reclaimable)` };
	});
}

export async function releaseJob(stateDir: string, jobId: string, worker?: string): Promise<{ ok: boolean; message: string }> {
	const paths = workPaths(stateDir);
	return withLock(stateDir, async () => {
		const states = deriveJobStates(await readLedger(paths.ledgerFile));
		const st = states.get(jobId);
		if (st === undefined) return { ok: false, message: `unknown job ${jobId}` };
		if (st.status === "done") return { ok: false, message: "job already done" };
		await appendLedger(paths.ledgerFile, [{ ts: new Date().toISOString(), ev: "release", jobId, ...(worker !== undefined ? { worker } : {}) }]);
		return { ok: true, message: `released ${jobId}` };
	});
}

export interface LayerStatus {
	layer: Layer;
	total: number;
	done: number;
	claimedActive: number;
	claimedExpired: number;
	pending: number;
	tokensPending: number;
}

export interface WorkStatus {
	projects: { project: string; sessions: number }[];
	layers: LayerStatus[];
	sessions: { total: number; withJobs: number; pass2Done: number };
	leaseMinutes: number;
}

export async function statusSummary(stateDir: string): Promise<WorkStatus> {
	const paths = workPaths(stateDir);
	const index = await readJobsIndex(paths);
	const states = deriveJobStates(await readLedger(paths.ledgerFile));
	const now = Date.now();
	const state = await loadState(paths);

	const byProject = new Map<string, number>();
	for (const e of index) {
		if (e.layer !== "pass1" || e.windowIndex !== 1) continue; // one row per session
		const p = e.project ?? "unknown";
		byProject.set(p, (byProject.get(p) ?? 0) + 1);
	}

	const layers: LayerStatus[] = (["pass1", "pass2"] as Layer[]).map((layer) => {
		const mine = index.filter((e) => e.layer === layer);
		let done = 0;
		let claimedActive = 0;
		let claimedExpired = 0;
		let tokensPending = 0;
		for (const entry of mine) {
			const st = states.get(entry.jobId);
			if (st?.status === "done") {
				done++;
				continue;
			}
			if (st?.status === "claimed" && leaseActive(st, now)) claimedActive++;
			else if (st?.status === "claimed") claimedExpired++;
			tokensPending += entry.tokens;
		}
		return {
			layer,
			total: mine.length,
			done,
			claimedActive,
			claimedExpired,
			pending: mine.length - done - claimedActive,
			tokensPending,
		};
	});

	const pass2Done = index.filter((e) => e.layer === "pass2" && states.get(e.jobId)?.status === "done").length;
	return {
		projects: [...byProject.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([project, sessions]) => ({ project, sessions })),
		layers,
		sessions: { total: (await readRegistry(paths)).length, withJobs: index.filter((e) => e.layer === "pass2").length, pass2Done },
		leaseMinutes: state.leaseMinutes,
	};
}

export interface LayerPage {
	layer: Layer;
	jobs: { jobId: string; sessionId: string; project?: string; windowIndex?: number; status: "pending" | "claimed" | "expired" | "done"; tokens: number }[];
	nextCursor?: string;
}

/** Cursor-paginated view of a layer's jobs (opaque cursor = base64 offset). */
export async function listLayerPage(stateDir: string, layer: Layer, cursor: string | undefined, limit: number): Promise<LayerPage> {
	const paths = workPaths(stateDir);
	const index = (await readJobsIndex(paths)).filter((e) => e.layer === layer);
	const states = deriveJobStates(await readLedger(paths.ledgerFile));
	const now = Date.now();
	const offset = cursor !== undefined ? decodeCursor(cursor) : 0;
	const slice = index.slice(offset, offset + limit);
	return {
		layer,
		jobs: slice.map((e) => {
			const st = states.get(e.jobId);
			const status = st?.status === "done" ? "done" : st?.status === "claimed" ? (leaseActive(st, now) ? "claimed" : "expired") : "pending";
			return {
				jobId: e.jobId,
				sessionId: e.sessionId,
				...(e.project !== undefined ? { project: e.project } : {}),
				...(e.windowIndex !== undefined ? { windowIndex: e.windowIndex } : {}),
				status,
				tokens: e.tokens,
			};
		}),
		...(offset + limit < index.length ? { nextCursor: encodeCursor(offset + limit) } : {}),
	};
}

// --- payload builders (parse the log once per claim) ---

async function buildPayload(paths: WorkPaths, state: WorkState, entry: JobIndexEntry, worker: string, claimedAt: string, leaseUntil: string): Promise<Pass1Job | Pass2Job> {
	const records = await readRegistry(paths);
	const record = records.find((r) => r.sessionId === entry.sessionId);
	if (record === undefined) throw new Error(`session ${entry.sessionId} not in registry`);
	const det = await loadDet(paths, entry.sessionId);
	if (det === undefined) throw new Error(`no det skeleton for ${entry.sessionId} — rerun work init`);
	const envelope = {
		jobId: entry.jobId,
		layer: entry.layer,
		sessionId: entry.sessionId,
		source: record.source,
		...(entry.project !== undefined ? { project: entry.project } : {}),
		...(det.projectDir !== undefined ? { projectDir: det.projectDir } : {}),
		logFile: record.logFile,
		logLines: det.logLines,
		worker,
		claimedAt,
		leaseUntil,
	};
	return entry.layer === "pass1"
		? await buildPass1Payload(state, envelope, det, findWindow(det, entry), record.cursorMeta)
		: await buildPass2Payload(paths, state, envelope, record, det);
}

function findWindow(det: DetSession, entry: JobIndexEntry): DetWindow {
	const w = det.windows.find((x) => x.index === entry.windowIndex);
	if (w === undefined) throw new Error(`det window ${entry.windowIndex} missing for ${entry.sessionId}`);
	return w;
}

async function buildPass1Payload(
	state: WorkState,
	envelope: { jobId: string; sessionId: string; source: SourceKind; project?: string; projectDir?: string; logFile: string; logLines: number; worker: string; claimedAt: string; leaseUntil: string },
	det: DetSession,
	window: DetWindow,
	cursorMeta: CursorLogMeta | undefined,
): Promise<Pass1Job> {
	const parsed = await parseBySource(envelope.source, envelope.logFile, cursorMeta);
	const turns = segmentTurns(parsed.entries.filter((e) => !e.sidechain), det.segOptions);
	const byIndex = new Map(turns.map((t) => [t.index, t]));
	const digests = await readSidecarDigests(envelope.logFile, state.pass1PromptHash);
	const jobTurns: Pass1JobTurn[] = [];
	for (const turnIndex of window.turnIndexes) {
		const turn = byIndex.get(turnIndex);
		if (turn === undefined) throw new Error(`det window ${window.index} references missing turn ${turnIndex}`);
		const anchors = anchorTurn(turn);
		const detTurn = det.turns.find((t) => t.index === turnIndex);
		jobTurns.push({
			turnIndex: turn.index,
			fromLine: turn.fromLine,
			toLine: turn.toLine,
			text: renderTurn(turn, anchors, renderOptionsForTurn(turn)),
			quoteIds: detTurn?.quoteIds ?? anchors.quotes.map((q) => q.q),
			thoughtQs: detTurn?.thoughtQs ?? anchors.quotes.filter((q) => q.source === "thinking").map((q) => q.q),
			sliceHash: detTurn?.sliceHash ?? "",
			toolNames: turn.toolNames,
			tokens: turn.tokens,
		});
	}
	return {
		...envelope,
		layer: "pass1",
		windowIndex: window.index,
		windowCount: det.windows.length,
		windowFromLine: window.fromLine,
		windowToLine: window.toLine,
		isLastWindow: window.index === det.windows.length,
		previousDigest: digests.get(window.index - 1) ?? null,
		turns: jobTurns,
		promptHash: state.pass1PromptHash,
	};
}

async function buildPass2Payload(
	paths: WorkPaths,
	state: WorkState,
	envelope: { jobId: string; sessionId: string; source: SourceKind; project?: string; projectDir?: string; logFile: string; logLines: number; worker: string; claimedAt: string; leaseUntil: string },
	record: SessionRecord,
	det: DetSession,
): Promise<Pass2Job> {
	const view = await buildSessionView(record, det, state.pass1PromptHash, state.pass2InputTokenBudget);
	return {
		...envelope,
		layer: "pass2",
		groupedForm: view.groupedForm,
		factsFooter: view.factsFooter,
		groupedTokens: view.groupedTokens,
		readLogBudget: READ_LOG_BUDGET,
	};
}

function encodeCursor(offset: number): string {
	return Buffer.from(`off:${offset}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): number {
	try {
		const raw = Buffer.from(cursor, "base64url").toString("utf8");
		const m = /^off:(\d+)$/.exec(raw);
		if (m) return Number(m[1]);
	} catch {
		// fallthrough
	}
	throw new Error(`bad cursor: ${cursor}`);
}
