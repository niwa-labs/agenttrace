/**
 * Trace document model — the typed shape of the YAML frontmatter and the
 * compressed body.
 *
 * Frontmatter is a discriminated union: `kind: "single"` for one session,
 * `kind: "chain"` when related sessions were merged into one trace.
 */

import type { ChainReason, SessionRefInfo, SourceKind, ToolFamily, UsageAgg } from "./session.js";

export const TRACE_SCHEMA = "session-trace/v1" as const;
export type TraceSchema = typeof TRACE_SCHEMA;

export type VerdictStatus = "success" | "partial" | "failure" | "unknown";
export type VerdictOrigin = "deterministic" | "agent";

export interface Verdict {
	status: VerdictStatus;
	why: string;
	origin: VerdictOrigin;
}

export interface CheckStats {
	/** Test/check summary lines detected in tool outputs. */
	run: number;
	failed: number;
	/** Failing test names (max 5), as printed by the runner. */
	failedNames: string[];
}

export interface TraceStats {
	userPrompts: number;
	assistantMessages: number;
	toolCalls: number;
	toolsByTool: Record<string, number>;
	toolErrors: number;
	/** Same tool+target retried right after an error. */
	repairCycles: number;
	compactions: number;
	subagentRuns: number;
	checks: CheckStats;
	diffLines: { added: number; removed: number };
	filesRead: number;
	filesModified: number;
	/** Total lines of the original logs merged into this trace. */
	logLines: number;
	approxTokensOriginal: number;
	approxTokensTrace: number;
	compressionRatio: number;
}

export interface TraceSessionRef {
	source: SourceKind;
	sessionId: string;
	/** Absolute path of the original JSONL; @L refs in the body point here. */
	logFile: string;
	logLines: number;
	logBytes: number;
	startedAt: string;
	endedAt: string;
	title?: string;
	model?: string;
	gitBranch?: string;
	firstPrompt?: string;
	role: SessionRefInfo["role"];
	/** Aggregated token usage when the source log records it. */
	tokenUsage?: UsageAgg;
	/** wall-time minus idle gaps — "agent was working" proxy. */
	activeMs?: number;
}

interface TraceMetaBase {
	schema: TraceSchema;
	projectDir: string;
	generatedAt: string;
	durationMs: number;
	verdict: Verdict;
	stats: TraceStats;
	outcome: {
		interrupted: boolean;
		lastToolCallWasError: boolean;
		/** History compaction checkpoints inside the logs. */
		compactions: number;
	};
	/** Which passes contributed: `deterministic`, `refine:pi`, … */
	passes: string[];
}

export interface SingleTraceMeta extends TraceMetaBase {
	kind: "single";
	session: TraceSessionRef;
}

export interface ChainedTraceMeta extends TraceMetaBase {
	kind: "chain";
	chainReasons: ChainReason[];
	sessions: [TraceSessionRef, ...TraceSessionRef[]];
}

/** Discriminated union emitted as typed YAML frontmatter. */
export type TraceMeta = SingleTraceMeta | ChainedTraceMeta;

// ---------------------------------------------------------------------------
// Body model
// ---------------------------------------------------------------------------

export interface TaskPrompt {
	/** Verbatim (capped) user prompt. */
	text: string;
	logLine: number;
	sessionIndex: number;
	timestamp: string;
}

export interface FileLedgerEntry {
	path: string;
	reads: number;
	readRefs: number[];
	modified: boolean;
	diff?: { added: number; removed: number };
	modifyRefs: number[];
}

export interface ToolCallLine {
	/** Rendered one-liner: tool signature + result tombstone + refs. */
	text: string;
	logLine: number;
	isError: boolean;
	family: ToolFamily;
	/** Dedup: identical to an earlier line in the same block. */
	duplicateOf?: number;
}

export interface BlockStats {
	calls: number;
	errors: number;
	byFamily: Partial<Record<ToolFamily, number>>;
	lineFrom: number;
	lineTo: number;
}

export interface TimelineBlock {
	index: number;
	/** 1-based index of the session inside the trace (chains merge sessions). */
	sessionIndex: number;
	startedAt: string;
	endedAt: string;
	/** Deterministic activity label, e.g. `research`, `execute`, `edit`. */
	label: string;
	/** Deterministic micro-summary derived from block stats. */
	summary: string;
	/** Filled by the agent refinement pass; kept apart from deterministic text. */
	refinedSummary?: string;
	/** Verbatim (capped) assistant text that closed this block, if any. */
	assistantText?: string;
	tools: ToolCallLine[];
	stats: BlockStats;
}

export interface SubagentSection {
	/** Claude sidechains live inside the parent log; Codex subagents are own files. */
	origin: "claude-sidechain" | "codex-subagent";
	/** Short human handle: task head or nickname. */
	title: string;
	sessionId?: string;
	/** For codex-subagent: the subagent's own log file. */
	logFile?: string;
	/** For claude-sidechain: line range inside the parent log. */
	lineFrom?: number;
	lineTo?: number;
	/** 1-based index of the parent session inside the trace. */
	parentSessionIndex?: number;
	summary: string;
	firstText?: string;
}

export interface SessionNote {
	sessionIndex: number;
	timestamp: string;
	text: string;
	logLine: number;
}

export interface CompressedTrace {
	meta: TraceMeta;
	sessions: TraceSessionRef[];
	taskPrompts: TaskPrompt[];
	workingSet: FileLedgerEntry[];
	blocks: TimelineBlock[];
	subagents: SubagentSection[];
	notes: SessionNote[];
}
