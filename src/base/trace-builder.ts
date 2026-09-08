/**
 * Top-level distillation: normalized sessions → CompressedTrace documents.
 */

import { capLine } from "../core/text.js";
import type {
	CompressedTrace,
	FileLedgerEntry,
	SubagentSection,
	TaskPrompt,
	TimelineBlock,
	TraceMeta,
	TraceSessionRef,
	Verdict,
} from "../model/trace.js";
import type { NormalizedSession, ChainReason } from "../model/session.js";
import { groupSession, type SessionGrouping } from "./group.js";
import { buildChains, DEFAULT_CHAIN_OPTIONS, type ChainOptions } from "./chain.js";
import type { CheckObservation } from "./checks.js";

export interface DistillOptions {
	projectDir: string;
	chain: ChainOptions;
}

export const DEFAULT_DISTILL_OPTIONS: DistillOptions = {
	projectDir: "",
	chain: DEFAULT_CHAIN_OPTIONS,
};

export function distill(
	sessions: NormalizedSession[],
	options: DistillOptions,
): CompressedTrace[] {
	const mains = sessions.filter((s) => s.role === "main");
	const subagents = sessions.filter((s) => s.role === "subagent");

	const groupings = new Map<string, SessionGrouping>();
	for (const s of sessions) groupings.set(s.sessionId, groupSession(s.entries, s.cwd));

	const chains = buildChains(mains, groupings, options.chain);
	const traces: CompressedTrace[] = [];

	for (const chain of chains) {
		traces.push(assembleTrace(chain.sessions, chain.groupings, chain.reasons, subagents, groupings, options));
	}
	return traces;
}

// ---------------------------------------------------------------------------

function assembleTrace(
	chainSessions: NormalizedSession[],
	groupings: SessionGrouping[],
	reasons: ChainReason[],
	subagents: NormalizedSession[],
	allGroupings: Map<string, SessionGrouping>,
	options: DistillOptions,
): CompressedTrace {
	const sessionRefs = chainSessions.map(toTraceSessionRef);
	const blocks: TimelineBlock[] = [];
	const taskPrompts: TaskPrompt[] = [];
	const notes: CompressedTrace["notes"] = [];
	const ledger = new Map<string, FileLedgerEntry>();
	const subagentSections: SubagentSection[] = [];

	let totalChecks = { run: 0, failed: 0, failedNames: [] as string[] };
	let interrupted = false;
	let lastToolResultError = false;
	let diffAdded = 0;
	let diffRemoved = 0;
	let lastChecks: CheckObservation | undefined;
	let checksEverFailed = false;

	chainSessions.forEach((session, si) => {
		const sessionIndex = si + 1;
		const g = groupings[si];
		if (g === undefined) return;

		for (const b of g.blocks) {
			blocks.push({ ...b, index: blocks.length + 1, sessionIndex });
		}
		for (const p of g.taskPrompts) {
			taskPrompts.push({ ...p, sessionIndex });
		}
		for (const n of g.notes) {
			notes.push({ ...n, sessionIndex });
		}
		for (const run of g.sidechainRuns) {
			subagentSections.push(claudeSidechainSection(session, run, sessionIndex));
		}

		mergeLedger(ledger, g.fileOps);
		interrupted ||= g.interrupted;
		checksEverFailed ||= g.checksEverFailed;
		if (g.lastChecks !== undefined) lastChecks = g.lastChecks;
		for (const op of g.fileOps) {
			if (op.op !== "modify" || op.diff === undefined) continue;
			diffAdded += op.diff.added;
			diffRemoved += op.diff.removed;
		}

		// last tool result of this session
		for (let i = session.entries.length - 1; i >= 0; i--) {
			const e = session.entries[i];
			if (e !== undefined && !e.sidechain && e.kind === "tool_result") {
				lastToolResultError = e.isError;
				break;
			}
		}
	});

	// Codex subagent rollouts spawned by any session of this chain
	const chainIds = new Set(chainSessions.map((s) => s.sessionId));
	for (const sub of subagents) {
		if (sub.parentThreadId !== undefined && chainIds.has(sub.parentThreadId)) {
			const parentIdx = chainSessions.findIndex((s) => s.sessionId === sub.parentThreadId);
			subagentSections.push(
				codexSubagentSection(sub, allGroupings.get(sub.sessionId), parentIdx + 1),
			);
		}
	}

	if (lastChecks !== undefined) {
		totalChecks = {
			run: lastChecks.run,
			failed: lastChecks.failed,
			failedNames: lastChecks.failedNames.slice(0, 5),
		};
	}

	const logLines = chainSessions.reduce((acc, s) => acc + s.logLines, 0);
	const logBytes = chainSessions.reduce((acc, s) => acc + s.logBytes, 0) +
		subagents.filter((s) => s.parentThreadId !== undefined && chainIds.has(s.parentThreadId)).reduce((acc, s) => acc + s.logBytes, 0);
	const approxTokensOriginal = Math.ceil(logBytes / 4);

	const counts = groupings.reduce(
		(acc, g) => ({
			userPrompts: acc.userPrompts + g.counts.userPrompts,
			assistantMessages: acc.assistantMessages + g.counts.assistantMessages,
			toolCalls: acc.toolCalls + g.counts.toolCalls,
			toolErrors: acc.toolErrors + g.counts.toolErrors,
			repairCycles: acc.repairCycles + g.counts.repairCycles,
			compactions: acc.compactions + g.counts.compactions,
		}),
		{ userPrompts: 0, assistantMessages: 0, toolCalls: 0, toolErrors: 0, repairCycles: 0, compactions: 0 },
	);
	const toolsByTool: Record<string, number> = {};
	for (const s of chainSessions) {
		for (const e of s.entries) {
			if (e.kind === "tool_call" && !e.sidechain) {
				toolsByTool[e.name] = (toolsByTool[e.name] ?? 0) + 1;
			}
		}
	}

	const startedAt = chainSessions[0]?.startedAt ?? "";
	const endedAt = chainSessions[chainSessions.length - 1]?.endedAt ?? "";
	const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));

	const workingSet = [...ledger.values()].sort((a, b) => b.reads - a.reads);

	const stats = {
		userPrompts: counts.userPrompts,
		assistantMessages: counts.assistantMessages,
		toolCalls: counts.toolCalls,
		toolsByTool,
		toolErrors: counts.toolErrors,
		repairCycles: counts.repairCycles,
		compactions: counts.compactions,
		subagentRuns: subagentSections.length,
		checks: totalChecks,
		diffLines: { added: diffAdded, removed: diffRemoved },
		filesRead: workingSet.filter((w) => w.reads > 0).length,
		filesModified: workingSet.filter((w) => w.modified).length,
		logLines,
		approxTokensOriginal,
		approxTokensTrace: 0,
		compressionRatio: 0,
	};

	const verdict = deterministicVerdict({
		interrupted,
		checks: totalChecks,
		toolErrors: counts.toolErrors,
		toolCalls: counts.toolCalls,
		checksEverFailed,
		lastToolResultError,
	});

	const base = {
		schema: "session-trace/v1" as const,
		projectDir: options.projectDir,
		generatedAt: new Date().toISOString(),
		durationMs,
		verdict,
		stats,
		outcome: {
			interrupted,
			lastToolCallWasError: lastToolResultError,
			compactions: counts.compactions,
		},
		passes: ["deterministic"],
	};

	let meta: TraceMeta;
	if (sessionRefs.length === 1 && sessionRefs[0] !== undefined) {
		meta = { ...base, kind: "single", session: sessionRefs[0] };
	} else {
		const first = sessionRefs[0];
		if (first === undefined) throw new Error("cannot build a trace without sessions");
		meta = {
			...base,
			kind: "chain",
			chainReasons: reasons,
			sessions: [first, ...sessionRefs.slice(1)],
		};
	}

	return {
		meta,
		sessions: sessionRefs,
		taskPrompts,
		workingSet,
		blocks,
		subagents: subagentSections,
		notes,
	};
}

export function toTraceSessionRef(s: NormalizedSession): TraceSessionRef {
	return {
		source: s.source,
		sessionId: s.sessionId,
		logFile: s.logFile,
		logLines: s.logLines,
		logBytes: s.logBytes,
		startedAt: s.startedAt,
		endedAt: s.endedAt,
		...(s.title !== undefined ? { title: s.title } : {}),
		...(s.model !== undefined ? { model: s.model } : {}),
		...(s.gitBranch !== undefined ? { gitBranch: s.gitBranch } : {}),
		...(s.firstPrompt !== undefined ? { firstPrompt: s.firstPrompt } : {}),
		role: s.role,
	};
}

function claudeSidechainSection(
	parent: NormalizedSession,
	run: { lineFrom: number; lineTo: number; calls: number; errors: number; firstText?: string },
	parentSessionIndex: number,
): SubagentSection {
	return {
		origin: "claude-sidechain",
		title: run.firstText !== undefined ? capLine(run.firstText, 80) : `sidechain @L${run.lineFrom}`,
		logFile: parent.logFile,
		lineFrom: run.lineFrom,
		lineTo: run.lineTo,
		parentSessionIndex,
		summary: `сабагент: вызовов ${run.calls}${run.errors > 0 ? `, ошибок ${run.errors}` : ""}, строки @L${run.lineFrom}–L${run.lineTo} лога родителя`,
		...(run.firstText !== undefined ? { firstText: run.firstText } : {}),
	};
}

function codexSubagentSection(
	sub: NormalizedSession,
	grouping: SessionGrouping | undefined,
	parentSessionIndex: number,
): SubagentSection {
	const calls = grouping?.counts.toolCalls ?? 0;
	const errors = grouping?.counts.toolErrors ?? 0;
	return {
		origin: "codex-subagent",
		title: capLine(sub.firstPrompt ?? sub.title ?? sub.sessionId, 80),
		sessionId: sub.sessionId,
		logFile: sub.logFile,
		parentSessionIndex,
		summary: `codex-сабагент: вызовов ${calls}${errors > 0 ? `, ошибок ${errors}` : ""}; лог ${sub.logFile}`,
		...(sub.firstPrompt !== undefined ? { firstText: sub.firstPrompt } : {}),
	};
}

function mergeLedger(ledger: Map<string, FileLedgerEntry>, fileOps: { path: string; op: "read" | "modify"; line: number; diff?: { added: number; removed: number } }[]): void {
	for (const op of fileOps) {
		let entry = ledger.get(op.path);
		if (entry === undefined) {
			entry = { path: op.path, reads: 0, readRefs: [], modified: false, modifyRefs: [] };
			ledger.set(op.path, entry);
		}
		if (op.op === "read") {
			entry.reads++;
			if (entry.readRefs.length < 4) entry.readRefs.push(op.line);
		} else {
			entry.modified = true;
			if (entry.modifyRefs.length < 4) entry.modifyRefs.push(op.line);
			if (op.diff !== undefined) {
				const prev = entry.diff ?? { added: 0, removed: 0 };
				entry.diff = { added: prev.added + op.diff.added, removed: prev.removed + op.diff.removed };
			}
		}
	}
}

function deterministicVerdict(input: {
	interrupted: boolean;
	checks: { run: number; failed: number };
	toolErrors: number;
	toolCalls: number;
	checksEverFailed: boolean;
	lastToolResultError: boolean;
}): Verdict {
	if (input.interrupted) {
		return {
			status: "partial",
			why: "есть прерванные вызовы инструментов — сессия могла не дойти до конца задачи",
			origin: "deterministic",
		};
	}
	if (input.checks.run > 0 && input.checks.failed > 0) {
		return {
			status: "failure",
			why: `последний прогон проверок: ${input.checks.failed} failed из ${input.checks.run}`,
			origin: "deterministic",
		};
	}
	if (input.lastToolResultError) {
		return {
			status: "failure",
			why: "последний вызов инструмента завершился ошибкой",
			origin: "deterministic",
		};
	}
	if (input.checksEverFailed) {
		return {
			status: "partial",
			why: "в ходе сессии были падения проверок, последний прогон зелёный",
			origin: "deterministic",
		};
	}
	if (input.toolErrors > 0) {
		return {
			status: "partial",
			why: `ошибки инструментов: ${input.toolErrors} (без падений проверок)`,
			origin: "deterministic",
		};
	}
	if (input.toolCalls === 0) {
		return {
			status: "unknown",
			why: "вызовов инструментов не было — диалог без действий",
			origin: "deterministic",
		};
	}
	return {
		status: input.checks.run > 0 ? "success" : "unknown",
		why:
			input.checks.run > 0
				? `ошибок инструментов нет; проверки выполнены (${input.checks.run}) и зелёные`
				: "ошибок инструментов нет; автоматических проверок не обнаружено",
		origin: "deterministic",
	};
}
