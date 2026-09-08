/**
 * Turn/window segmentation for the pipeline.
 *
 * A turn is one assistant move: [thinking] [narration] [tool calls + results],
 * closed when results for its calls arrive. User messages are their own turns.
 * Turns are atomic: windows are composed of whole turns, never split — a
 * command is never cut in half. Volume drives only packing, not semantics.
 */

import { estimateTokens } from "../core/tokens.js";
import type { SessionEntry } from "../model/session.js";

export interface Turn {
	index: number;
	kind: "user" | "assistant";
	entries: SessionEntry[];
	/** 1-based log line range (inclusive). */
	fromLine: number;
	toLine: number;
	tokens: number;
	toolNames: string[];
	/** True when the last tool call of the turn has no result in the log. */
	interrupted: boolean;
}

export interface Window {
	index: number;
	turns: Turn[];
	tokens: number;
	fromLine: number;
	toLine: number;
}

export interface SegmentOptions {
	/** Soft per-turn budget; an oversized turn becomes its own unit. */
	turnBudgetTokens: number;
	/** Window token budget; packed from whole turns. */
	windowBudgetTokens: number;
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
	turnBudgetTokens: 8_000,
	windowBudgetTokens: 40_000,
};

export function segmentTurns(entries: SessionEntry[], options: SegmentOptions = DEFAULT_SEGMENT_OPTIONS): Turn[] {
	const turns: Turn[] = [];
	let current: SessionEntry[] = [];
	let pendingCalls = new Set<string>();
	let toolNames = new Set<string>();

	const flush = () => {
		if (current.length === 0) return;
		const fromLine = Math.min(...current.map((e) => e.logLine));
		const toLine = Math.max(...current.map((e) => e.logLine));
		turns.push({
			index: turns.length + 1,
			kind: current.some((e) => e.kind === "user_text") ? "user" : "assistant",
			entries: current,
			fromLine,
			toLine,
			tokens: current.reduce((acc, e) => acc + entryTokens(e), 0),
			toolNames: [...toolNames],
			interrupted: pendingCalls.size > 0,
		});
		current = [];
		pendingCalls = new Set();
		toolNames = new Set();
	};

	for (const e of entries) {
		if (e.kind === "user_text") {
			flush();
			current = [e];
			flush();
			continue;
		}
		current.push(e);
		if (e.kind === "tool_call") {
			pendingCalls.add(e.toolCallId);
			toolNames.add(e.name);
			// an assistant turn with a huge thinking already exceeds the budget —
			// close it once its calls are answered, not mid-thinking
			if (current.reduce((acc, x) => acc + entryTokens(x), 0) > options.turnBudgetTokens * 2) {
				// oversized even before results: keep accumulating until results arrive
			}
		}
		if (e.kind === "tool_result" && pendingCalls.has(e.toolCallId)) {
			pendingCalls.delete(e.toolCallId);
			// turn budget reached and no pending calls → close the move
			if (pendingCalls.size === 0 && current.reduce((acc, x) => acc + entryTokens(x), 0) >= options.turnBudgetTokens) {
				flush();
			}
		}
	}
	flush();
	return turns;
}

export function packWindows(turns: Turn[], options: SegmentOptions = DEFAULT_SEGMENT_OPTIONS): Window[] {
	const windows: Window[] = [];
	let buf: Turn[] = [];
	let tokens = 0;
	const flushWindow = () => {
		if (buf.length === 0) return;
		windows.push({
			index: windows.length + 1,
			turns: buf,
			tokens,
			fromLine: buf[0]?.fromLine ?? 0,
			toLine: buf[buf.length - 1]?.toLine ?? 0,
		});
		buf = [];
		tokens = 0;
	};
	for (const t of turns) {
		if (tokens > 0 && tokens + t.tokens > options.windowBudgetTokens) flushWindow();
		buf.push(t);
		tokens += t.tokens;
	}
	flushWindow();
	return windows;
}

/** Cheap volume estimate: thinking/text dominate; results are pre-truncated. */
function entryTokens(e: SessionEntry): number {
	switch (e.kind) {
		case "user_text":
		case "assistant_text":
		case "assistant_thinking":
			return estimateTokens(e.text);
		case "tool_call":
			return estimateTokens(JSON.stringify(e.input ?? "")) + 16;
		case "tool_result":
			return estimateTokens(e.content) + 8;
		case "system_note":
			return estimateTokens(e.text);
		case "compaction":
			return 8;
	}
}
