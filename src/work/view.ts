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
import { readSidecar, blockKey, sliceHashOf, type SidecarRecord } from "../pipeline/sidecar.js";
import { renderGroupedTurns, type TurnFormInput, type DegradeLevel } from "../pipeline/groupform.js";
import { segmentTurns, type Turn } from "../pipeline/turns.js";
import type { Pass1Block } from "../pipeline/contracts.js";
import type { SessionEntry, SourceKind } from "../model/session.js";
import type { CursorLogMeta } from "../sources/cursor/types.js";
import { parseClaudeSession } from "../sources/claude/parse.js";
import { parseCodexSession } from "../sources/codex/parse.js";
import { parsePiSession } from "../sources/pi/parse.js";
import { parseQwenSession } from "../sources/qwen/parse.js";
import { parseKimiSession } from "../sources/kimi/parse.js";
import { parseMinimaxSession } from "../sources/minimax/parse.js";
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
					: source === "qwen"
						? await parseQwenSession(file)
						: source === "kimi"
							? await parseKimiSession(file)
							: source === "minimax"
								? await parseMinimaxSession(file)
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

	// group turns into render units: a merged pass-1 block (anchor spanning
	// several consecutive turns) is ONE unit — the agent decided the merge
	const units: { turns: Turn[]; rec: SidecarRecord | undefined }[] = [];
	{
		let i = 0;
		while (i < turns.length) {
			const turn = turns[i];
			if (turn === undefined) break;
			const key = blockKey(turn.fromLine, turn.toLine, turnSliceHash(turn.entries));
			const rec = coverage.get(key);
			if (rec !== undefined && rec.type === "block") {
				const a = (rec.result as Pass1Block).anchor;
				if (a.fromLine < turn.fromLine || a.toLine > turn.toLine) {
					const spanTurns: Turn[] = [turn];
					let j = i + 1;
					while (j < turns.length) {
						const nxt = turns[j];
						if (nxt === undefined || nxt.toLine > a.toLine) break;
						spanTurns.push(nxt);
						j++;
					}
					units.push({ turns: spanTurns, rec });
					i = j;
					continue;
				}
			}
			units.push({ turns: [turn], rec });
			i++;
		}
	}

	for (const unit of units) {
		const turn = unit.turns[0];
		if (turn === undefined) continue;
		const anchors = anchorTurn(turn);
		const sealed = sealFacts(turn);
		const rec = unit.rec;

		// facts stay per real turn — machine truth is never merged
		for (const ft of unit.turns) {
			factsFooter += `b${ft.index} @L${ft.fromLine}–L${ft.toLine}: ${renderFacts(sealFacts(ft))}\n`;
		}
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
		let renderTurn = turn;
		let renderEntries = turn.entries;
		let renderAnchors = anchors;
		if (unit.turns.length > 1) {
			const last = unit.turns[unit.turns.length - 1];
			if (last === undefined) throw new Error("empty span turns");
			renderEntries = unit.turns.flatMap((t) => t.entries);
			renderTurn = {
				index: turn.index,
				kind: "assistant",
				entries: renderEntries,
				fromLine: turn.fromLine,
				toLine: last.toLine,
				tokens: unit.turns.reduce((acc, t) => acc + t.tokens, 0),
				toolNames: [...new Set(unit.turns.flatMap((t) => t.toolNames))],
				interrupted: last.interrupted,
			};
			renderAnchors = anchorTurn(renderTurn);
		}
		turnInputs.push({ turn: renderTurn, anchors: renderAnchors, entries: renderEntries, block, disputes: gate.disputes });
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
