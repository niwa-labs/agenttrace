/**
 * Pass-1 input rendering: one turn → prompt text.
 *
 * Policy (owner decisions): thinking goes INTACT (never cut); only tool
 * results lose their middle (head+tail) — with an explicit truncation mark so
 * pass-2 never mistakes a partial view for the whole; user text keeps its
 * multiline shape (intent lives there); missing results are stated as such;
 * every thought-bearing entry shows its quote-id; sealed facts are NOT shown.
 */

import { headTail, capBlock } from "../core/text.js";
import type { SessionEntry } from "../model/session.js";
import type { TurnAnchors } from "./anchors.js";
import type { Turn } from "./turns.js";

export interface TurnRenderOptions {
	/** Tool result head/tail sizes; progressive squeeze for oversized turns. */
	resultHead: number;
	resultTail: number;
}

export const DEFAULT_TURN_RENDER: TurnRenderOptions = { resultHead: 2000, resultTail: 500 };

/** Progressive squeeze for oversized turns (fable idea 6). */
export function renderOptionsForTurn(turn: Turn): TurnRenderOptions {
	const tokens = turn.tokens;
	if (tokens <= 8_000) return DEFAULT_TURN_RENDER;
	if (tokens <= 20_000) return { resultHead: 800, resultTail: 200 };
	return { resultHead: 300, resultTail: 100 };
}

export function renderTurn(turn: Turn, anchors: TurnAnchors, opts: TurnRenderOptions = renderOptionsForTurn(turn)): string {
	const lines: string[] = [];
	lines.push(`TURN b${turn.index} [lines ${turn.fromLine}–${turn.toLine}]`);
	if (turn.toolNames.length > 0) lines.push(`tools: ${turn.toolNames.join(", ")}`);
	if (turn.interrupted) lines.push(`ВНИМАНИЕ: лог обрывается на этом ходе — результат последнего вызова НЕ зафиксирован.`);

	// empty thinking blocks (signature-only) mean the model thought off-record
	const emptyThinking = turn.entries.filter(
		(e) => e.kind === "assistant_thinking" && e.text.trim().length === 0,
	).length;
	if (emptyThinking > 0) {
		lines.push(`(thinking скрыт настройками: ${emptyThinking} пустых блоков — рассуждение не зафиксировано)`);
	}

	const thinkingQs: string[] = [];
	for (const e of turn.entries) {
		switch (e.kind) {
			case "user_text":
				// intent is primary data: keep the multiline shape, cap gently
				lines.push(`[USER]`);
				lines.push(capBlock(e.text, 1200));
				break;
			case "assistant_thinking": {
				// empty thinking (signature-only, some Claude models) is not reasoning
				if (e.text.trim().length === 0) break;
				const q = findQ(anchors, e);
				const tag = q !== undefined ? ` [${q.q}]` : "";
				thinkingQs.push(...(q !== undefined ? [q.q] : []));
				lines.push(`[THINKING]${tag}`);
				// intact — never cut
				lines.push(e.text);
				break;
			}
			case "assistant_text": {
				const q = findQ(anchors, e);
				const tag = q !== undefined ? ` [${q.q}]` : "";
				lines.push(`[ASSISTANT]${tag} ${e.text}`);
				break;
			}
			case "tool_call": {
				const args = JSON.stringify(e.input ?? "");
				const argsShort = args.length > 220 ? `${args.slice(0, 220)}…` : args;
				lines.push(`[CALL] ${e.name} ${argsShort}`);
				break;
			}
			case "tool_result": {
				const body = headTail(e.content, { head: opts.resultHead, tail: opts.resultTail });
				const status = e.isError ? "ERR" : "ok";
				const cut = e.content.length > opts.resultHead + opts.resultTail
					? ` …⟨урезано, полный текст @L${e.logLine}⟩`
					: "";
				lines.push(`[RESULT ${status}]${cut} ${collapse(body)}`);
				break;
			}
			case "system_note":
				lines.push(`[NOTE ${e.subtype}] ${e.text.slice(0, 160)}`);
				break;
			case "compaction":
				lines.push(`[NOTE compaction] history was summarized here`);
				break;
		}
	}

	if (thinkingQs.length > 0) {
		lines.push(
			`ОБЯЗАТЕЛЬНО: в этом ходе есть thinking (${thinkingQs.join(", ")}) — поле thought обязательно, source="thinking", q — id записи с САМОЙ СУЩЕСТВЕННОЙ мыслью (разворот/открытие/гипотеза).`,
		);
	}
	return lines.join("\n");
}

/** The model never sees sealed facts; they live in the gate. */
export const SEALED_FACTS_NOTE = "(sealed facts withheld from the model)";

function findQ(anchors: TurnAnchors, e: SessionEntry): { q: string } | undefined {
	for (const a of anchors.quotes) {
		if (a.line === e.logLine && a.source === (e.kind === "assistant_thinking" ? "thinking" : "narration")) {
			return { q: a.q };
		}
	}
	return undefined;
}

function collapse(text: string): string {
	return text.replace(/\s+\n/g, "\n").trim();
}
