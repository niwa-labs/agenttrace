/**
 * Grouped compressed form: the "настоящая" reduced-scale replica of the
 * session that pass-2 (SMART) reads and the final trace shows.
 *
 * Rendering rules (fable idea 8): identical consecutive calls collapse to ×N
 * only when tool+args+result-class all match; a result-class transition
 * (ERR→ok) renders as a transition line with both anchors; thoughts never
 * collapse across different kinds.
 */

import type { SessionEntry } from "../model/session.js";
import { renderCall } from "../base/render-tools.js";
import type { Dispute } from "./gate.js";
import type { Pass1Block } from "./contracts.js";
import type { TurnAnchors } from "./anchors.js";
import type { Turn } from "./turns.js";

export interface TurnFormInput {
	turn: Turn;
	anchors: TurnAnchors;
	entries: SessionEntry[];
	block: Pass1Block;
	disputes: Dispute[];
	/** extra context: quote anchor lookup for thought source lines. */
	quoteLine?: number;
}

export interface TurnForm {
	turnIndex: number;
	text: string;
	compressedTokens: number;
}

export type DegradeLevel = 0 | 1 | 2;

/** Level 1: strip result previews, keep anchors. Level 2: counts only (thoughts always kept). */
export function renderGroupedTurns(inputs: TurnFormInput[], level: DegradeLevel = 0): string {
	const out: string[] = [];
	for (const input of inputs) {
		out.push(renderGroupedTurn(input, level));
	}
	return out.join("\n");
}

export function renderGroupedTurn(input: TurnFormInput, level: DegradeLevel = 0): string {
	const { turn, anchors, entries, block, disputes } = input;
	const lines: string[] = [];
	lines.push(`#### b${turn.index} · @L${turn.fromLine}–L${turn.toLine}${turn.toolNames.length > 0 ? ` · ${turn.toolNames.join(",")}` : ""}`);
	if (turn.interrupted) lines.push(`(ход оборван: результат последнего вызова не зафиксирован в логе)`);

	// honesty: thinking exists in the log but was not distilled
	const thinkingCount = turn.entries.filter((e) => e.kind === "assistant_thinking" && e.text.trim().length > 0).length;
	if (block.thoughts.length === 0 && thinkingCount > 0) {
		lines.push(`💭 — (thinking не дистиллирован: ${thinkingCount} блоков, см. @L${turn.fromLine}–L${turn.toLine})`);
	}

	// thought lines first (the motive precedes the action)
	for (const t of block.thoughts) {
		const qLine = t.q !== undefined ? anchors.byQ.get(t.q)?.line : undefined;
		const src = t.source === "inferred" ? " (inferred)" : "";
		lines.push(`💭 ${t.kind}${src}: ${t.text} @L${qLine ?? turn.fromLine}`);
	}

	// disputes: claimed vs sealed, kept visible for pass-2
	for (const d of disputes) {
		lines.push(`⚠ ${d.kind}: claimed ${d.claimed} / sealed ${d.sealed} @L${d.line}`);
	}

	// tool one-liners (deterministic), with ×N collapse on identical triple
	const resultByCall = new Map<string, Extract<SessionEntry, { kind: "tool_result" }>>();
	for (const e of entries) if (e.kind === "tool_result") resultByCall.set(e.toolCallId, e);
	const rendered: string[] = [];
	for (const e of entries) {
		if (e.kind !== "tool_call") continue;
		if (level >= 2) {
			// counts-only: the tools line in the header already carries the names
			continue;
		}
		const result = resultByCall.get(e.toolCallId);
		const call = { ...e, sidechain: false };
		const r = renderCall(call, result);
		let text = r.text.replace(/\s+$/, "");
		// every tool line carries its result anchor, even when the payload is small
		if (result !== undefined && !/⟨[^⟩]*@L\d+/.test(text)) {
			text = `${text} @L${result.logLine}`;
		}
		if (level >= 1) {
			const anchor = /@L\d+(→L\d+)?$/.exec(text)?.[0] ?? `@L${e.logLine}`;
			const name = /`([^`]+)`/.exec(text)?.[1] ?? e.name;
			text = `${name} ${anchor}`;
		} else if (text.length > 170) {
			const anchor = /@L\d+(→L\d+)?$/.exec(text)?.[0] ?? "";
			text = `${text.slice(0, 170 - anchor.length - 1)}… ${anchor}`;
		}
		rendered.push(text);
	}
	lines.push(...collapseIdentical(rendered));

	// inter-agent mail and notes (NEW_TASK etc.) are trace-worthy events
	for (const e of entries) {
		if (e.kind === "system_note" && (e.subtype === "agent_message" || e.subtype === "pr-link")) {
			lines.push(`[NOTE ${e.subtype}] ${e.text.slice(0, 200)} @L${e.logLine}`);
		}
	}

	// pass-1 narrative as the turn's micro-summary line
	const fb = block.fallback === true ? " [fallback]" : "";
	lines.push(`→ ${block.action}${fb}`, "");
	return lines.join("\n");
}

/** Collapse consecutive identical calls to ×N; differing lines break runs.
 *  Comparison ignores @L refs (they differ per occurrence); the emitted line
 *  is the LAST occurrence's (latest pointers) plus the run count. */
function collapseIdentical(lines: string[]): string[] {
	const out: string[] = [];
	let runNorm: string | undefined;
	let lastLine: string | undefined;
	let count = 0;
	const flush = () => {
		if (lastLine === undefined || runNorm === undefined) return;
		out.push(count === 1 ? lastLine : `${stripRefs(lastLine)} ×${count}`);
		runNorm = undefined;
		lastLine = undefined;
		count = 0;
	};
	for (const line of lines) {
		const norm = stripRefs(line);
		if (runNorm === norm) {
			count++;
			lastLine = line;
		} else {
			flush();
			runNorm = norm;
			lastLine = line;
			count = 1;
		}
	}
	flush();
	return out;
}

function stripRefs(text: string): string {
	const stripped = text.replace(/@L\d+(–L\d+)?/g, "@L");
	const m = /(.+?) ×\d+$/.exec(stripped);
	return m && m[1] !== undefined ? m[1] : stripped;
}
