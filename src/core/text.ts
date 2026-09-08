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
