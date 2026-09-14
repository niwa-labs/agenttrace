/**
 * Deterministic text shaping helpers: head+tail truncation, one-lining,
 * indentation squashing. No content is invented — only dropped, with the drop
 * always recorded (byte counts live with the caller via tombstones).
 */

export interface HeadTailOptions {
	head: number;
	tail?: number;
	/** Separator inserted when the middle is dropped. */
	marker?: string;
}

/** Keep the first `head` and last `tail` chars; record dropped length in the marker. */
export function headTail(text: string, opts: HeadTailOptions): string {
	const clean = text;
	if (clean.length <= opts.head + (opts.tail ?? 0)) return clean;
	const tail = opts.tail ?? 0;
	const dropped = clean.length - opts.head - tail;
	const marker = opts.marker ?? `…[${dropped} chars dropped]…`;
	return `${clean.slice(0, opts.head)}${marker}${tail > 0 ? clean.slice(clean.length - tail) : ""}`;
}

/** First line of a string, squashed to one line and capped. */
export function firstLine(text: string, cap = 160): string {
	const line = text.split("\n", 1)[0] ?? "";
	return capLine(line, cap);
}

/** Collapse all whitespace (incl. newlines) to single spaces and cap. */
export function capLine(text: string, cap: number): string {
	const squashed = text.replace(/\s+/g, " ").trim();
	return squashed.length <= cap ? squashed : `${squashed.slice(0, Math.max(0, cap - 1))}…`;
}

/** Cap multi-line text keeping its shape (for verbatim user prompts). */
export function capBlock(text: string, maxChars: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	const cut = trimmed.slice(0, maxChars);
	// Avoid splitting inside a line when possible.
	const nl = cut.lastIndexOf("\n");
	const safeCut = nl > maxChars * 0.5 ? cut.slice(0, nl) : cut;
	const dropped = trimmed.length - safeCut.length;
	return `${safeCut}\n…[+${dropped} chars]`;
}

export function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** Escape pipes/backticks/newlines so text survives inside a markdown table cell / inline code. */
export function inlineCode(text: string, cap = 100): string {
	const one = capLine(text, cap);
	return `\`${one.replace(/`/g, "'")}\``;
}

const TRUNCATED_MARKER_PREFIX = "…⟨truncated:";
const ERROR_TAIL_RE = /\b(error|exception|failed|fatal|traceback|panic|exit code|errno|denied)\b/i;
const MAX_LINE_CHARS = 2000;

export interface TruncateCenteredOptions {
	/** Chars kept from the head/tail (before the marker is accounted). */
	head: number;
	tail?: number;
	/** Original-log line anchor, embedded into the marker (lossless recovery). */
	anchor?: number;
	/** Short content hash (first 8 hex of sha256), embedded into the marker. */
	sha?: string;
}

export interface TruncateCenteredResult {
	text: string;
	truncated: boolean;
	originalChars: number;
	keptChars: number;
	droppedChars: number;
}

function capLongLines(slice: string): string {
	if (!slice.includes("\n")) return slice;
	return slice
		.split("\n")
		.map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…[+${l.length - MAX_LINE_CHARS} chars]` : l))
		.join("\n");
}

/**
 * Center truncation synthesized from production harness practices:
 * - outcome-aware asymmetry: errors in the tail region shift the kept budget
 *   70/30 → 30/70 (errors live at the end of output);
 * - the marker counts against the budget (head+marker+tail ≤ head+tail budget);
 * - cuts snap to line boundaries; long kept lines are capped in place;
 * - marker carries full recovery arithmetic: original→kept chars, the @L
 *   anchor into the original log, and a content hash for verification;
 * - idempotent: already-truncated text passes through untouched;
 * - no-shrink guard: if the wrapped text is not smaller than the original,
 *   the original is returned (truncation must shrink).
 */
export function truncateCentered(text: string, opts: TruncateCenteredOptions): TruncateCenteredResult {
	const originalChars = text.length;
	if (text.startsWith(TRUNCATED_MARKER_PREFIX)) {
		return { text, truncated: true, originalChars, keptChars: originalChars, droppedChars: 0 };
	}
	const tailBudget = opts.tail ?? 0;
	const total = opts.head + tailBudget;
	if (originalChars <= total) {
		return { text, truncated: false, originalChars, keptChars: originalChars, droppedChars: 0 };
	}
	const anchorRef = opts.anchor !== undefined ? ` @L${opts.anchor}` : "";
	const shaRef = opts.sha !== undefined ? `, sha:#${opts.sha}` : "";
	const sepAt = (kept: number): string =>
		`${TRUNCATED_MARKER_PREFIX} ${originalChars}→${kept} chars${anchorRef}${shaRef}⟩`;
	// outcome-aware split of the KEPT budget between head and tail
	const tailScan = text.slice(Math.max(0, originalChars - 2048));
	const headShare = ERROR_TAIL_RE.test(tailScan) ? 0.3 : 0.7;

	let sep = sepAt(total);
	let kept = total - sep.length;
	if (kept < Math.min(opts.head, tailBudget > 0 ? 1 : total)) {
		// marker alone eats the budget — emit just the marker
		return {
			text: `${text.slice(0, Math.max(8, total - sep.length))}${sep}`,
			truncated: true,
			originalChars,
			keptChars: Math.max(8, total - sep.length),
			droppedChars: originalChars - Math.max(8, total - sep.length),
		};
	}
	let head = Math.floor(kept * headShare);
	const tail = kept - head;
	let headPart = capLongLines(text.slice(0, head));
	let tailPart = tailBudget > 0 ? capLongLines(text.slice(originalChars - tail)) : "";
	// line-boundary snap: move the cut to the nearest newline when close
	const headNl = headPart.lastIndexOf("\n");
	if (headNl > head * 0.5) {
		head = headNl + 1;
		headPart = text.slice(0, head);
	}
	if (tailBudget > 0) {
		const tailNl = tailPart.indexOf("\n");
		if (tailNl !== -1 && tailNl < tail * 0.5) {
			tailPart = tailPart.slice(tailNl + 1);
		}
	}
	kept = headPart.length + tailPart.length;
	sep = sepAt(kept);
	const out = `${headPart}${sep}${tailPart}`;
	if (out.length >= originalChars) {
		// truncation must shrink — otherwise keep the original verbatim
		return { text, truncated: false, originalChars, keptChars: originalChars, droppedChars: 0 };
	}
	return { text: out, truncated: true, originalChars, keptChars: out.length, droppedChars: originalChars - out.length };
}
