/**
 * Pass-1 sidecar: `<logFile>.pass1.jsonl` next to the original log.
 *
 * One record per processed turn + one per window digest. Incremental by key:
 * a turn is reprocessed only when its `(fromLine, toLine, sliceHash)` changed
 * or the schema/prompt version moved. Every record carries sessionId and the
 * tool names involved (owner requirement).
 */

import { readFile, writeFile } from "node:fs/promises";

export const SIDECAR_SCHEMA_VERSION = 3;

export interface Pass1Record {
	type: "block";
	schemaVersion: number;
	promptHash: string;
	sessionId: string;
	logFile: string;
	fromLine: number;
	toLine: number;
	sliceHash: string;
	windowIndex: number;
	toolNames: string[];
	tokens: number;
	/** Validated pass-1 JSON, or the deterministic fallback. */
	result: unknown;
	retries: number;
	fallback: boolean;
	ts: string;
}

export interface DigestRecord {
	type: "digest";
	schemaVersion: number;
	promptHash: string;
	sessionId: string;
	logFile: string;
	windowIndex: number;
	sliceHash: string;
	digest: unknown;
	ts: string;
}

export type SidecarRecord = Pass1Record | DigestRecord;

export function sliceHashOf(text: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
		h2 = Math.imul(h2 + c * (i + 1), 0x85ebca6b) >>> 0;
	}
	return `${h1.toString(16)}${h2.toString(16)}`;
}

export async function readSidecarDigests(
	logFile: string,
	currentPromptHash?: string,
): Promise<Map<number, unknown>> {
	const digests = new Map<number, unknown>();
	try {
		const raw = await readFile(sidecarPath(logFile), "utf8");
		for (const line of raw.split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				const rec = JSON.parse(line) as SidecarRecord;
				if (rec.schemaVersion !== SIDECAR_SCHEMA_VERSION) continue;
				if (currentPromptHash !== undefined && rec.promptHash !== currentPromptHash) continue;
				if (rec.type === "digest") digests.set(rec.windowIndex, rec.digest);
			} catch {
				// tolerate partial writes
			}
		}
	} catch {
		// no sidecar yet
	}
	return digests;
}

export async function readSidecar(
	logFile: string,
	/** records made with a different prompt/schema revision are not reusable */
	currentPromptHash?: string,
): Promise<Map<string, SidecarRecord>> {
	const map = new Map<string, SidecarRecord>();
	let raw: string;
	try {
		raw = await readFile(sidecarPath(logFile), "utf8");
	} catch {
		return map;
	}
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const rec = JSON.parse(line) as SidecarRecord;
			if (rec.schemaVersion !== SIDECAR_SCHEMA_VERSION) continue;
			if (currentPromptHash !== undefined && rec.promptHash !== currentPromptHash) continue;
			if (rec.type === "block") {
				map.set(blockKey(rec.fromLine, rec.toLine, rec.sliceHash), rec);
			}
		} catch {
			// skip corrupt lines — the sidecar is append-only, tolerate partial writes
		}
	}
	return map;
}

export function blockKey(fromLine: number, toLine: number, sliceHash: string): string {
	return `${fromLine}:${toLine}:${sliceHash}`;
}

export async function appendSidecar(logFile: string, records: SidecarRecord[]): Promise<void> {
	if (records.length === 0) return;
	const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
	await writeFile(sidecarPath(logFile), body, { flag: "a", encoding: "utf8" });
}

export function sidecarPath(logFile: string): string {
	return `${logFile}.pass1.jsonl`;
}
