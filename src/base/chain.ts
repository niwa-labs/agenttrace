/**
 * Session linking: decide which sessions belong to the same trace.
 *
 * Signals, strongest first:
 *  - `leaf-uuid`     — a Claude resume summary points at the previous session's last message
 *  - `logical-parent`— a compaction summary continues a specific pre-compaction message
 *  - `time-gap`      — next session started within `tightGapMinutes` of the previous ending
 *  - `time-gap-overlap` — moderate gap plus shared files in the working sets
 */

import type { ChainReason, NormalizedSession } from "../model/session.js";
import type { SessionGrouping } from "./group.js";

export interface ChainOptions {
	enabled: boolean;
	tightGapMinutes: number;
	looseGapMinutes: number;
}

export const DEFAULT_CHAIN_OPTIONS: ChainOptions = {
	enabled: true,
	tightGapMinutes: 5,
	looseGapMinutes: 45,
};

export interface ChainGroup {
	sessions: NormalizedSession[];
	/** Grouping results parallel to `sessions`. */
	groupings: SessionGrouping[];
	reasons: ChainReason[];
}

export function buildChains(
	sessions: NormalizedSession[],
	groupings: Map<string, SessionGrouping>,
	options: ChainOptions,
): ChainGroup[] {
	const mains = sessions
		.filter((s) => s.role === "main")
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

	if (!options.enabled || mains.length === 0) {
		return mains.map((s) => ({
			sessions: [s],
			groupings: [requireGrouping(s, groupings)],
			reasons: [],
		}));
	}

	const groups: ChainGroup[] = [];
	let current: ChainGroup = {
		sessions: [mains[0] as NormalizedSession],
		groupings: [requireGrouping(mains[0] as NormalizedSession, groupings)],
		reasons: [],
	};

	for (let i = 1; i < mains.length; i++) {
		const next = mains[i] as NormalizedSession;
		const prev = current.sessions[current.sessions.length - 1];
		if (prev === undefined) break;
		const reason = linkReason(prev, next, groupings, options);
		if (reason !== undefined) {
			current.sessions.push(next);
			current.groupings.push(requireGrouping(next, groupings));
			if (!current.reasons.includes(reason)) current.reasons.push(reason);
		} else {
			groups.push(current);
			current = {
				sessions: [next],
				groupings: [requireGrouping(next, groupings)],
				reasons: [],
			};
		}
	}
	groups.push(current);
	return groups;
}

function linkReason(
	prev: NormalizedSession,
	next: NormalizedSession,
	groupings: Map<string, SessionGrouping>,
	options: ChainOptions,
): ChainReason | undefined {
	// Explicit resume pointers.
	if (next.leafUuid !== undefined && next.leafUuid === prev.lastUuid) return "leaf-uuid";
	if (next.logicalParentUuid !== undefined && next.logicalParentUuid === prev.lastUuid) {
		return "leaf-uuid";
	}

	if (prev.source !== next.source) return undefined;

	const gapMs = Date.parse(next.startedAt) - Date.parse(prev.endedAt);
	if (!Number.isFinite(gapMs) || gapMs < 0) return undefined;
	if (gapMs <= options.tightGapMinutes * 60_000) return "time-gap";
	if (gapMs <= options.looseGapMinutes * 60_000) {
		const prevPaths = requireGrouping(prev, groupings).paths;
		const nextPaths = requireGrouping(next, groupings).paths;
		for (const p of nextPaths) {
			if (prevPaths.has(p)) return "time-gap-overlap";
		}
	}
	return undefined;
}

function requireGrouping(s: NormalizedSession, groupings: Map<string, SessionGrouping>): SessionGrouping {
	const g = groupings.get(s.sessionId);
	if (g === undefined) throw new Error(`missing grouping for session ${s.sessionId}`);
	return g;
}
