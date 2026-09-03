/**
 * Lossless references into the original session log.
 *
 * Every compressed payload in a trace carries a `@L<n>` pointer to the exact
 * line of the original JSONL file, so nothing is truly lost — large content is
 * replaced by a tombstone plus a dereferenceable pointer.
 */

import { createHash } from "node:crypto";

export interface LogRef {
	/** Absolute path of the original JSONL log file. */
	file: string;
	/** 1-based line number in that file. */
	line: number;
}

/** Render a log reference the way traces cite them: `@L42`. */
export function refTag(ref: LogRef): string {
	return `@L${ref.line}`;
}

/** Render an inclusive line-range citation: `@L41–L89`. */
export function refRange(from: LogRef, toLine: number): string {
	return from.line === toLine ? `@L${from.line}` : `@L${from.line}–L${toLine}`;
}

/** Short content hash (first 8 hex of sha256) — reproducible by any tool. */
export function shortHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/**
 * Format a tombstone: what was dropped, its original size, and where to find it.
 * Example: `…⟨12.4kB, 310 lines, #a1b2c3d4, @L52⟩`
 */
export function tombstone(bytes: number, lines: number, hash: string, logLine: number): string {
	return `…⟨${formatBytes(bytes)}, ${lines} ln, #${hash}, @L${logLine}⟩`;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
