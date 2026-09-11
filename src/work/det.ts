/**
 * Deterministic skeleton: `<stateDir>/det/<sessionId>.json`.
 *
 * Layer 0 of the agent-facing pipeline — computed entirely in code, no model:
 * parse the log once, segment into turns/windows, anchor quote-ids, seal
 * facts. This file is the single input for both the pass-1 job payload and
 * the submit-time validator, so an agent never needs the raw log to answer.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceKind } from "../model/session.js";
import type { CursorLogMeta } from "../sources/cursor/types.js";
import { parseClaudeSession } from "../sources/claude/parse.js";
import { parseCodexSession } from "../sources/codex/parse.js";
import { parsePiSession } from "../sources/pi/parse.js";
import { parseQwenSession } from "../sources/qwen/parse.js";
import { parseKimiSession } from "../sources/kimi/parse.js";
import { parseMinimaxSession } from "../sources/minimax/parse.js";
import { parseCursorLog } from "../sources/cursor/parse.js";
import { anchorTurn } from "../pipeline/anchors.js";
import { accountSession, renderFacts, sealFacts } from "../pipeline/facts.js";
import { DEFAULT_SEGMENT_OPTIONS, packWindows, segmentTurns, type SegmentOptions } from "../pipeline/turns.js";
import { sliceHashOf } from "../pipeline/sidecar.js";
import { projectSlugOf, type SessionRecord } from "./registry.js";
import type { WorkPaths } from "./state.js";

export interface DetTurn {
	index: number;
	kind: "user" | "assistant";
	fromLine: number;
	toLine: number;
	tokens: number;
	toolNames: string[];
	interrupted: boolean;
	/** content hash feeding the sidecar block key */
	sliceHash: string;
	/** all quote-ids of the turn (validator: q must be one of these) */
	quoteIds: string[];
	/** quote-ids of thinking entries (validator: thoughts mandatory if non-empty) */
	thoughtQs: string[];
	quotes: { q: string; source: "thinking" | "narration"; line: number }[];
	/** rendered sealed facts (withheld from the model, used by the gate/footer) */
	facts: string;
}

export interface DetWindow {
	index: number;
	fromLine: number;
	toLine: number;
	tokens: number;
	turnIndexes: number[];
}

export interface DetSession {
	sessionId: string;
	source: SourceKind;
	logFile: string;
	logBytes: number;
	logMtimeMs: number;
	logLines: number;
	projectDir?: string;
	project?: string;
	startedAt?: string;
	endedAt?: string;
	title?: string;
	role: "main" | "subagent";
	model?: string;
	activeMs?: number;
	segOptions: SegmentOptions;
	turns: DetTurn[];
	windows: DetWindow[];
	stats: ReturnType<typeof accountSession>;
}

function sliceTextOf(entries: { kind: string; logLine: number; text?: string }[]): string {
	return entries
		.map((e) => e.kind + ":" + e.logLine + ":" + (e.kind === "assistant_thinking" || e.kind === "assistant_text" || e.kind === "user_text" ? (e.text ?? "").length : 0))
		.join("|");
}

export function detPath(paths: WorkPaths, sessionId: string): string {
	return join(paths.detDir, `${sessionId}.json`);
}

export async function loadDet(paths: WorkPaths, sessionId: string): Promise<DetSession | undefined> {
	try {
		return JSON.parse(await readFile(detPath(paths, sessionId), "utf8")) as DetSession;
	} catch {
		return undefined;
	}
}

export async function saveDet(paths: WorkPaths, det: DetSession): Promise<void> {
	await writeFile(detPath(paths, det.sessionId), JSON.stringify(det), "utf8");
}

/** True when an existing skeleton matches the current log file stamp AND segmentation options. */
export async function detFresh(paths: WorkPaths, record: SessionRecord, segOptions?: SegmentOptions): Promise<boolean> {
	const det = await loadDet(paths, record.sessionId);
	if (det === undefined) return false;
	if (det.logMtimeMs !== record.logMtimeMs || det.logBytes !== record.logBytes || det.logLines <= 0) return false;
	if (segOptions !== undefined) {
		if (det.segOptions.turnBudgetTokens !== segOptions.turnBudgetTokens) return false;
		if (det.segOptions.windowBudgetTokens !== segOptions.windowBudgetTokens) return false;
	}
	return true;
}

export async function buildDet(record: SessionRecord, segOptions: SegmentOptions): Promise<DetSession> {
	const session = await parseBySource(record.source, record.logFile, record.cursorMeta);
	const mainEntries = session.entries.filter((e) => !e.sidechain);
	const turns = segmentTurns(mainEntries, segOptions);

	const detTurns: DetTurn[] = turns.map((turn) => {
		const anchors = anchorTurn(turn);
		const sealed = sealFacts(turn);
		return {
			index: turn.index,
			kind: turn.kind,
			fromLine: turn.fromLine,
			toLine: turn.toLine,
			tokens: turn.tokens,
			toolNames: turn.toolNames,
			interrupted: turn.interrupted,
			sliceHash: sliceHashOf(sliceTextOf(turn.entries)),
			quoteIds: anchors.quotes.map((q) => q.q),
			thoughtQs: anchors.quotes.filter((q) => q.source === "thinking").map((q) => q.q),
			quotes: anchors.quotes.map((q) => ({ q: q.q, source: q.source, line: q.line })),
			facts: renderFacts(sealed),
		};
	});

	const windows = packWindows(turns, segOptions).map((w) => ({
		index: w.index,
		fromLine: w.fromLine,
		toLine: w.toLine,
		tokens: w.tokens,
		turnIndexes: w.turns.map((t) => t.index),
	}));

	const projectDir = session.cwd !== "" ? session.cwd : record.cursorMeta?.workspacePath;

	return {
		sessionId: record.sessionId,
		source: record.source,
		logFile: record.logFile,
		logBytes: record.logBytes,
		logMtimeMs: record.logMtimeMs,
		logLines: session.logLines,
		...(projectDir !== undefined && projectDir !== "" ? { projectDir, project: projectSlugOf(projectDir) } : {}),
		...(session.startedAt !== "" ? { startedAt: session.startedAt } : {}),
		...(session.endedAt !== "" ? { endedAt: session.endedAt } : {}),
		...(session.title !== undefined ? { title: session.title } : {}),
		role: session.role,
		...(session.model !== undefined ? { model: session.model } : {}),
		...(session.activeMs !== undefined ? { activeMs: session.activeMs } : {}),
		segOptions,
		turns: detTurns,
		windows,
		stats: accountSession(session.entries),
	};
}

/** Compute-or-reuse: cheap interruption-safe pass over the registry. */
export async function ensureDet(
	paths: WorkPaths,
	record: SessionRecord,
	segOptions: SegmentOptions,
): Promise<{ det: DetSession; built: boolean }> {
	if (await detFresh(paths, record, segOptions)) {
		const det = await loadDet(paths, record.sessionId);
		if (det !== undefined) return { det, built: false };
	}
	const det = await buildDet(record, segOptions);
	await saveDet(paths, det);
	return { det, built: true };
}

async function parseBySource(
	source: SourceKind,
	file: string,
	cursorMeta?: CursorLogMeta,
) {
	switch (source) {
		case "claude":
			return parseClaudeSession(file);
		case "codex":
			return parseCodexSession(file);
		case "pi":
			return parsePiSession(file);
		case "qwen":
			return parseQwenSession(file);
		case "kimi":
			return parseKimiSession(file);
		case "minimax":
			return parseMinimaxSession(file);
		case "cursor-ide":
		case "cursor-agent": {
			if (cursorMeta === undefined) throw new Error(`cursor log without meta: ${file}`);
			return parseCursorLog(file, cursorMeta);
		}
	}
}

export const DEFAULT_DET_SEGMENT_OPTIONS = DEFAULT_SEGMENT_OPTIONS;
