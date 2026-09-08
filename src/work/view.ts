/**
 * Session view: the pass-2 input (grouped compressed form + facts footer).
 *
 * Mirrors the internal pipeline's gate → grouped-form stage: sidecar blocks
 * are gated against anchors/sealed facts, uncovered turns get a deterministic
 * floor so isomorphy always holds, and the form degrades until it fits the
 * pass-2 token budget.
 */

import { anchorTurn } from "../pipeline/anchors.js";
import { gateBlock } from "../pipeline/gate.js";
import { sealFacts, renderFacts } from "../pipeline/facts.js";
import { readSidecar, blockKey, sliceHashOf } from "../pipeline/sidecar.js";
import { renderGroupedTurns, type TurnFormInput, type DegradeLevel } from "../pipeline/groupform.js";
import { segmentTurns, type Turn } from "../pipeline/turns.js";
import type { Pass1Block } from "../pipeline/contracts.js";
import type { SessionEntry, SourceKind } from "../model/session.js";
import type { CursorLogMeta } from "../sources/cursor/types.js";
import { parseClaudeSession } from "../sources/claude/parse.js";
import { parseCodexSession } from "../sources/codex/parse.js";
import { parsePiSession } from "../sources/pi/parse.js";
import { parseCursorLog } from "../sources/cursor/parse.js";
import type { DetSession } from "./det.js";
import type { SessionRecord } from "./registry.js";

export interface SessionView {
	turns: Turn[];
	turnInputs: TurnFormInput[];
	groupedForm: string;
	factsFooter: string;
	groupedTokens: number;
	counts: {
		turns: number;
		covered: number;
		detOnly: number;
		fallbacks: number;
		retries: number;
		disputes: number;
		quoteValid: number;
		thoughtsBySource: Map<string, number>;
		thoughtsByKind: Map<string, number>;
	};
}

export async function parseBySource(
	source: SourceKind,
	file: string,
	cursorMeta?: CursorLogMeta,
): Promise<{ entries: SessionEntry[]; logLines: number; logBytes: number; startedAt: string; endedAt: string; title?: string; cwd: string }> {
	const session =
		source === "claude"
			? await parseClaudeSession(file)
			: source === "codex"
				? await parseCodexSession(file)
				: source === "pi"
					? await parsePiSession(file)
					: await parseCursorLog(file, cursorMeta ?? { sessionId: "unknown", source, msgCount: 0 });
	return {
		entries: session.entries,
		logLines: session.logLines,
		logBytes: session.logBytes,
		startedAt: session.startedAt,
		endedAt: session.endedAt,
		...(session.title !== undefined ? { title: session.title } : {}),
		cwd: session.cwd,
	};
}

function turnSliceHash(entries: SessionEntry[]): string {
	return sliceHashOf(
		entries
			.map((e) => e.kind + ":" + e.logLine + ":" + (e.kind === "assistant_thinking" || e.kind === "assistant_text" || e.kind === "user_text" ? e.text.length : 0))
			.join("|"),
	);
}

export async function buildSessionView(
	record: SessionRecord,
	det: DetSession,
	promptHash: string,
	pass2InputTokenBudget: number,
): Promise<SessionView> {
	const parsed = await parseBySource(record.source, record.logFile, record.cursorMeta);
	const mainEntries = parsed.entries.filter((e) => !e.sidechain);
	const turns = segmentTurns(mainEntries, det.segOptions);
	const coverage = await readSidecar(record.logFile, promptHash);

	const turnInputs: TurnFormInput[] = [];
	const counts = {
		turns: turns.length,
		covered: 0,
		detOnly: 0,
		fallbacks: 0,
		retries: 0,
		disputes: 0,
		quoteValid: 0,
		thoughtsBySource: new Map<string, number>(),
		thoughtsByKind: new Map<string, number>(),
	};
	let factsFooter = "";

	for (const turn of turns) {
		const anchors = anchorTurn(turn);
		const key = blockKey(turn.fromLine, turn.toLine, turnSliceHash(turn.entries));
		const rec = coverage.get(key);
		const sealed = sealFacts(turn);

		if (rec === undefined || rec.type !== "block") {
			turnInputs.push({
				turn,
				anchors,
				entries: turn.entries,
				block: {
					anchor: { fromLine: turn.fromLine, toLine: turn.toLine },
					action:
						turn.kind === "user"
							? `Пользователь: ${turn.entries[0]?.kind === "user_text" ? turn.entries[0].text.slice(0, 1200) : "..."}`
							: `Ход (${turn.toolNames.join(",") || "без вызовов"}) — не сжат моделью [det]`,
					thoughts: [],
				},
				disputes: [],
			});
			counts.detOnly++;
			factsFooter += `b${turn.index} @L${turn.fromLine}–L${turn.toLine}: ${renderFacts(sealed)}\n`;
			continue;
		}

		const block = rec.result as Pass1Block;
		const gate = gateBlock(block, anchors, sealed);
		counts.covered++;
		counts.disputes += gate.disputes.length;
		if (gate.quoteValid && block.thoughts.some((t) => t.source !== "inferred")) counts.quoteValid++;
		if (block.fallback === true) counts.fallbacks++;
		counts.retries += rec.retries;
		for (const t of block.thoughts) {
			counts.thoughtsBySource.set(t.source, (counts.thoughtsBySource.get(t.source) ?? 0) + 1);
			counts.thoughtsByKind.set(t.kind, (counts.thoughtsByKind.get(t.kind) ?? 0) + 1);
		}
		turnInputs.push({ turn, anchors, entries: turn.entries, block, disputes: gate.disputes });
		factsFooter += `b${turn.index} @L${turn.fromLine}–L${turn.toLine}: ${renderFacts(sealed)}${gate.disputes.length > 0 ? " [DISPUTED]" : ""}\n`;
	}

	let groupedForm = renderGroupedTurns(turnInputs);
	let degradeLevel: DegradeLevel = 0;
	while (Math.ceil(groupedForm.length / 4) > pass2InputTokenBudget && degradeLevel < 2) {
		degradeLevel = (degradeLevel + 1) as DegradeLevel;
		groupedForm = renderGroupedTurns(turnInputs, degradeLevel);
	}

	return {
		turns,
		turnInputs,
		groupedForm,
		factsFooter,
		groupedTokens: Math.ceil(groupedForm.length / 4),
		counts,
	};
}
