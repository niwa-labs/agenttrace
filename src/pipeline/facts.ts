/**
 * Sealed facts: machine-truth extracted deterministically per turn.
 * Models must not contradict these; the gate compares claims against them.
 */

import { detectChecks } from "../base/checks.js";
import type { SessionEntry } from "../model/session.js";
import type { Turn } from "./turns.js";

export interface SealedFacts {
	toolCalls: number;
	errors: number;
	interrupted: boolean;
	lastExitCode?: number;
	checks?: { run: number; failed: number };
	diffAdded: number;
	diffRemoved: number;
}

export function sealFacts(turn: Turn): SealedFacts {
	const facts: SealedFacts = { toolCalls: 0, errors: 0, interrupted: false, diffAdded: 0, diffRemoved: 0 };
	for (const e of turn.entries) {
		if (e.sidechain) continue;
		if (e.kind === "tool_call") facts.toolCalls++;
		if (e.kind === "tool_result") {
			if (e.isError) facts.errors++;
			if (e.exitCode !== undefined) facts.lastExitCode = e.exitCode;
			if (e.diff !== undefined) {
				facts.diffAdded += e.diff.added;
				facts.diffRemoved += e.diff.removed;
			}
			if (e.interrupted) facts.interrupted = true;
			const obs = detectChecks(e.content);
			if (obs !== undefined) {
				facts.checks = { run: obs.run, failed: obs.failed };
			}
		}
	}
	facts.interrupted ||= turn.interrupted;
	return facts;
}

/** Human/JSON order-stable rendering for prompts and the gate. */
export function renderFacts(f: SealedFacts): string {
	const parts: string[] = [`calls=${f.toolCalls}`, `errors=${f.errors}`];
	if (f.lastExitCode !== undefined) parts.push(`lastExit=${f.lastExitCode}`);
	if (f.checks !== undefined) parts.push(`checks: ${f.checks.run} run / ${f.checks.failed} failed`);
	if (f.diffAdded > 0 || f.diffRemoved > 0) parts.push(`diff +${f.diffAdded}/−${f.diffRemoved}`);
	if (f.interrupted) parts.push("INTERRUPTED");
	return parts.join("; ");
}

/** Session-level accounting (the fields we can compute ourselves). */
export interface SessionAccounting {
	toolCalls: number;
	toolErrors: number;
	interrupted: number;
	diffAdded: number;
	diffRemoved: number;
	filesModified: number;
	compactions: number;
	checks?: { run: number; failed: number };
}

export function accountSession(entries: SessionEntry[]): SessionAccounting {
	const acc: SessionAccounting = {
		toolCalls: 0,
		toolErrors: 0,
		interrupted: 0,
		diffAdded: 0,
		diffRemoved: 0,
		filesModified: 0,
		compactions: 0,
	};
	const modified = new Set<string>();
	for (const e of entries) {
		if (e.sidechain) continue;
		switch (e.kind) {
			case "tool_call":
				acc.toolCalls++;
				break;
			case "tool_result": {
				if (e.isError) acc.toolErrors++;
				if (e.interrupted) acc.interrupted++;
				if (e.diff !== undefined) {
					acc.diffAdded += e.diff.added;
					acc.diffRemoved += e.diff.removed;
					if (e.diff.filePath !== undefined) modified.add(e.diff.filePath);
				}
				if (e.exitCode !== undefined && e.exitCode !== 0) {
					// non-zero exits already counted as errors when isError; keep interrupt only
				}
				const obs = detectChecks(e.content);
				if (obs !== undefined) acc.checks = { run: obs.run, failed: obs.failed };
				break;
			}
			case "compaction":
				acc.compactions++;
				break;
			default:
				break;
		}
	}
	acc.filesModified = modified.size;
	return acc;
}
