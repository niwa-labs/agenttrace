/**
 * Source-agnostic normalized session model.
 *
 * Both adapters (Claude Code, Codex CLI) reduce their native JSONL formats to
 * this shape. Every entry keeps a pointer to its original log line so the
 * compressor can emit lossless `@L<n>` references.
 */

import type { LogRef } from "../core/refs.js";

export type SourceKind = "claude" | "codex" | "pi" | "cursor-ide" | "cursor-agent";

/** Aggregated token usage as recorded by the source log (when it records it). */
export interface UsageAgg {
	requests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	costUsd?: number;
}

/** wall-time minus idle gaps (> 2 min) — a fair "agent was working" proxy. */
export function computeActiveMs(entries: { timestamp: string }[]): number {
	const ts = entries
		.filter((e) => e.timestamp !== "")
		.map((e) => Date.parse(e.timestamp))
		.filter((t) => Number.isFinite(t))
		.sort((a, b) => a - b);
	let active = 0;
	for (let i = 1; i < ts.length; i++) {
		const gap = (ts[i] as number) - (ts[i - 1] as number);
		if (gap <= 120_000) active += gap;
	}
	return active;
}

export function emptyUsage(): UsageAgg {
	return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

/** Why two sessions were merged into one trace. */
export type ChainReason =
	| "leaf-uuid" // Claude resume summary explicitly points at the previous session's last message
	| "parent-thread" // Codex subagent rollout spawned from a parent thread
	| "time-gap" // same project, next session started within minutes of the previous ending
	| "time-gap-overlap" // short gap plus shared files in the working sets
	| "manual"; // forced via CLI flags

export interface ToolCallEntry {
	kind: "tool_call";
	name: string;
	/** Raw tool input as provided by the source log (already parsed JSON). */
	input: unknown;
	toolCallId: string;
	timestamp: string;
	logLine: number;
	sidechain: boolean;
	/** True for the first entry of a new assistant turn (block-split hint). */
	turnStart?: boolean;
}

export interface ToolResultEntry {
	kind: "tool_result";
	toolCallId: string;
	/** Result content, already flattened to text when the source had block arrays. */
	content: string;
	isError: boolean;
	/** True when the call was interrupted before completing. */
	interrupted: boolean;
	/** Structured diff info for file-edit tools, when the source exposes it. */
	diff?: DiffStats;
	/** For Read-like tools: the file that was read. */
	filePath?: string;
	/** For Bash-like tools: process exit code when the source records it. */
	exitCode?: number;
	timestamp: string;
	logLine: number;
	sidechain: boolean;
}

export interface DiffStats {
	added: number;
	removed: number;
	filePath?: string;
}

export interface TextEntry {
	kind: "user_text" | "assistant_text" | "assistant_thinking";
	text: string;
	timestamp: string;
	logLine: number;
	sidechain: boolean;
	/** True for the first entry of a new assistant turn (block-split hint). */
	turnStart?: boolean;
}

export interface SystemNoteEntry {
	kind: "system_note";
	subtype: string;
	text: string;
	timestamp: string;
	logLine: number;
	sidechain: boolean;
}

/** Compaction checkpoint inside the log (history was summarized at this point). */
export interface CompactionEntry {
	kind: "compaction";
	timestamp: string;
	logLine: number;
	sidechain: boolean;
}

export type SessionEntry =
	| ToolCallEntry
	| ToolResultEntry
	| TextEntry
	| SystemNoteEntry
	| CompactionEntry;

export interface SessionRefInfo {
	source: SourceKind;
	sessionId: string;
	/** Absolute path to the original JSONL log (the dereference target for @L refs). */
	logFile: string;
	logLines: number;
	logBytes: number;
	cwd: string;
	startedAt: string;
	endedAt: string;
	title?: string;
	model?: string;
	gitBranch?: string;
	/** First real user prompt (head), for quick orientation in listings. */
	firstPrompt?: string;
	/** Claude `isSidechain` runs / Codex subagent rollouts. */
	role: "main" | "subagent";
	/** Codex subagent: id of the parent thread. */
	parentThreadId?: string;
	/** Claude resume-listing summary: points at the last message of a related session. */
	leafUuid?: string;
	/** Claude compaction: uuid of the pre-compaction message this session continues. */
	logicalParentUuid?: string;
	/**Uuid of the first/last log entry — anchors for leaf-uuid chain detection. */
	firstUuid?: string;
	lastUuid?: string;
	/** Aggregated token usage when the source log records it. */
	tokenUsage?: UsageAgg;
	/** wall-time minus idle gaps — "agent was working" proxy. */
	activeMs?: number;
}

export interface NormalizedSession extends SessionRefInfo {
	entries: SessionEntry[];
}

/** Classify a tool name into a coarse activity family (drives block labels). */
export type ToolFamily = "read" | "search" | "edit" | "execute" | "web" | "agent" | "mcp" | "other";

export function classifyTool(name: string): ToolFamily {
	const n = name.toLowerCase();
	if (/(^|__)(read|view|cat|list|ls)$/.test(n) || n === "read" || n.endsWith("__read")) return "read";
	if (/(grep|glob|search|find|ls|dirlist|toolsearch)/.test(n)) return "search";
	if (/(edit|write|patch|apply_patch|multiedit|notebookedit|create_file|str_replace)/.test(n)) return "edit";
	if (/(bash|shell|exec|terminal|command|run)/.test(n)) return "execute";
	if (/(webfetch|websearch|fetch|browser)/.test(n)) return "web";
	if (/(task|agent|spawn|subagent)/.test(n)) return "agent";
	if (n.startsWith("mcp__")) return "mcp";
	return "other";
}

export function isToolEntry(e: SessionEntry): e is ToolCallEntry | ToolResultEntry {
	return e.kind === "tool_call" || e.kind === "tool_result";
}

/** Extract a short "signature" of a tool call: the parameters that matter. */
export function toolSignature(name: string, input: unknown): string {
	if (input === null || input === undefined) return "";
	if (typeof input === "string") return input.slice(0, 100);
	if (typeof input !== "object") return "";
	const rec = input as Record<string, unknown>;
	switch (name) {
		case "Read":
		case "Write":
		case "Edit":
		case "MultiEdit":
		case "NotebookEdit":
			return sigFilePath(rec);
		case "Bash":
			return sigCommand(rec["command"]);
		case "Grep":
			return `${optStr(rec["pattern"])}${rec["path"] ? ` in ${optStr(rec["path"])}` : ""}`;
		case "Glob":
			return optStr(rec["pattern"]);
		case "WebFetch":
		case "WebSearch":
			return optStr(rec["url"] ?? rec["query"]);
		case "Task":
		case "Agent":
			return optStr(rec["description"] ?? rec["prompt"]);
		case "ToolSearch":
			return optStr(rec["query"]);
		default: {
			// Codex shell / local_shell
			if ("command" in rec) return sigCommand(rec["command"]);
			// MCP tools: show first meaningful string arg.
			const first = Object.values(rec).find((v): v is string => typeof v === "string" && v.length > 0);
			return first === undefined ? "" : first.slice(0, 80);
		}
	}
}

function sigFilePath(rec: Record<string, unknown>): string {
	const p = optStr(rec["file_path"] ?? rec["path"] ?? rec["notebook_path"]);
	const off = rec["offset"];
	const lim = rec["limit"];
	if (typeof off === "number" && typeof lim === "number") return `${p}:${off}-${off + lim}`;
	return p;
}

function sigCommand(cmd: unknown): string {
	if (typeof cmd === "string") return cmd;
	if (Array.isArray(cmd)) return cmd.map(String).join(" ");
	return "";
}

function optStr(v: unknown): string {
	return typeof v === "string" ? v : "";
}

/** Compute line diff stats for edit tools when the source didn't provide them. */
export function diffFromEditInput(name: string, input: unknown): DiffStats | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const rec = input as Record<string, unknown>;
	const file = optStr(rec["file_path"] ?? rec["path"] ?? rec["notebook_path"]) || undefined;
	if (name === "Edit" || name === "MultiEdit") {
		const olds = allStrings(rec["old_string"]).concat(allStrings(rec["edits"], "old_string"));
		const news = allStrings(rec["new_string"]).concat(allStrings(rec["edits"], "new_string"));
		return {
			added: news.join("\n").split("\n").length - olds.join("\n").split("\n").length,
			removed: 0,
			...(file !== undefined ? { filePath: file } : {}),
		};
	}
	if (name === "Write" || name === "create_file" || name === "str_replace_based_edit_tool") {
		const content = optStr(rec["content"] ?? rec["new_str"]);
		if (content) {
			return { added: content.split("\n").length, removed: 0, ...(file !== undefined ? { filePath: file } : {}) };
		}
	}
	return undefined;
}

function allStrings(v: unknown, key?: string): string[] {
	if (typeof v === "string") return [v];
	if (Array.isArray(v) && key) {
		return v.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
			.map((e) => e[key])
			.filter((s): s is string => typeof s === "string");
	}
	return [];
}

export function refOf(e: SessionEntry, logFile: string): LogRef {
	return { file: logFile, line: e.logLine };
}
