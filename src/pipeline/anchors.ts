/**
 * Anchors: lossless addressing for the pipeline.
 *
 * Every turn carries its `@L` range. Every thinking/narration entry inside a
 * turn gets a short quote-id (`q` + 6 hex chars, derived from the entry text).
 * Pass-1 references thoughts by quote-id; the gate verifies the id belongs to
 * the anchor range — no verbatim text is ever shipped to or from the model.
 */

import type { Turn } from "./turns.js";

export interface QuoteAnchor {
	q: string;
	/** kind of the source entry the id points at. */
	source: "thinking" | "narration";
	line: number;
}

export interface TurnAnchors {
	turn: Turn;
	fromLine: number;
	toLine: number;
	/** quote-ids of thinking/narration entries in this turn. */
	quotes: QuoteAnchor[];
	/** q → entry text, for the gate. */
	byQ: Map<string, QuoteAnchor & { text: string }>;
}

export function anchorTurn(turn: Turn): TurnAnchors {
	const quotes: QuoteAnchor[] = [];
	const byQ = new Map<string, QuoteAnchor & { text: string }>();
	for (const e of turn.entries) {
		if (e.kind !== "assistant_thinking" && e.kind !== "assistant_text") continue;
		const text = e.text;
		if (text.trim().length === 0) continue; // empty thinking is not reasoning
		const q = `q${fnv6(text)}`;
		if (byQ.has(q)) continue; // identical entry — same id
		const anchor: QuoteAnchor & { text: string } = {
			q,
			source: e.kind === "assistant_thinking" ? "thinking" : "narration",
			line: e.logLine,
			text,
		};
		quotes.push(anchor);
		byQ.set(q, anchor);
	}
	return { turn, fromLine: turn.fromLine, toLine: turn.toLine, quotes, byQ };
}

/** Short stable id of an entry text: `q` + 6 hex chars of FNV-1a. */
function fnv6(text: string): string {
	const normalized = text.trim().replace(/\s+/g, " ");
	let h = 0x811c9dc5;
	for (let i = 0; i < normalized.length; i++) {
		h = Math.imul(h ^ normalized.charCodeAt(i), 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0").slice(0, 6);
}

/** Gate helper: does the quoted id exist inside this turn's anchors? */
export function quoteBelongsTo(anchors: TurnAnchors, q: string): boolean {
	return anchors.byQ.has(q);
}
