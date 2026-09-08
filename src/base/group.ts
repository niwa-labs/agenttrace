/**
 * Timeline grouping: walk one session's entries and fold runs of consecutive
 * tool calls into blocks. Tool payloads are replaced by one-liners with @L
 * pointers; text between tool runs is kept verbatim (capped).
 *
 * Pairing rule shared by every harness we studied: a tool_call and its
 * tool_result are never split across blocks.
 */

import { capBlock, capLine } from "../core/text.js";
import type { TimelineBlock, ToolCallLine } from "../model/trace.js";
import type {
	DiffStats,
	SessionEntry,
	ToolCallEntry,
	ToolFamily,
	ToolResultEntry,
} from "../model/session.js";
import { classifyTool, diffFromEditInput, toolSignature } from "../model/session.js";
import { detectChecks, type CheckObservation } from "./checks.js";
import { renderCall } from "./render-tools.js";
import { diffFromApplyPatch } from "../sources/codex/parse.js";

export type BlockLabel =
	| "research"
	| "edit"
	| "run"
	| "checks"
	| "web"
	| "delegation"
	| "mcp"
	| "tools"
	| "outcome";

export interface FileOp {
	path: string;
	op: "read" | "modify";
	line: number;
	diff?: DiffStats;
}

export interface SessionGrouping {
	blocks: Omit<TimelineBlock, "index" | "sessionIndex">[];
	taskPrompts: { text: string; logLine: number; timestamp: string }[];
	notes: { timestamp: string; text: string; logLine: number }[];
	fileOps: FileOp[];
	counts: {
		userPrompts: number;
		assistantMessages: number;
		thinkingBlocks: number;
		toolCalls: number;
		toolErrors: number;
		repairCycles: number;
		compactions: number;
		sidechainEntries: number;
	};
	/** Working-set file paths (for cross-session overlap detection). */
	paths: Set<string>;
	/** Last detected test/check summary — the final state of the session. */
	lastChecks: CheckObservation | undefined;
	checksEverFailed: boolean;
	interrupted: boolean;
	/** Contiguous sidechain (subagent) runs inside the parent log. */
	sidechainRuns: {
		lineFrom: number;
		lineTo: number;
		calls: number;
		errors: number;
		firstText?: string;
	}[];
}

const USER_PROMPT_CAP = 700;
const ASSISTANT_TEXT_CAP = 500;
const NOTE_CAP = 240;

/** Candidate note subtypes worth surfacing in the trace. */
const NOTEWORTHY = new Set([
	"away_summary",
	"compaction_summary",
	"compact_boundary",
	"pr-link",
]);

export function groupSession(entries: SessionEntry[], cwd?: string): SessionGrouping {
	const resultByCallId = new Map<string, ToolResultEntry>();
	const callById = new Map<string, ToolCallEntry>();
	for (const e of entries) {
		if (e.kind === "tool_result" && e.toolCallId !== "") resultByCallId.set(e.toolCallId, e);
		if (e.kind === "tool_call" && e.toolCallId !== "") callById.set(e.toolCallId, e);
	}

	const g: SessionGrouping = {
		blocks: [],
		taskPrompts: [],
		notes: [],
		fileOps: [],
		counts: {
			userPrompts: 0,
			assistantMessages: 0,
			thinkingBlocks: 0,
			toolCalls: 0,
			toolErrors: 0,
			repairCycles: 0,
			compactions: 0,
			sidechainEntries: 0,
		},
		paths: new Set(),
		lastChecks: undefined,
		checksEverFailed: false,
		interrupted: false,
		sidechainRuns: [],
	};

	interface Draft {
		userTexts: { text: string; logLine: number; timestamp: string }[];
		assistantText?: string;
		calls: ToolCallEntry[];
		startedAt?: string;
		endedAt?: string;
	}
	let draft: Draft | undefined;
	let lastErrorKey: string | undefined;
	interface SidechainRun {
		lineFrom: number;
		lineTo: number;
		calls: number;
		errors: number;
		firstText?: string;
	}
	let sidechainRun: SidechainRun | undefined;
	const closeSidechainRun = () => {
		if (sidechainRun !== undefined) {
			g.sidechainRuns.push(sidechainRun);
			sidechainRun = undefined;
		}
	};

	const openDraft = (): Draft => {
		if (draft === undefined) draft = { userTexts: [], calls: [] };
		return draft;
	};
	const flush = () => {
		if (draft === undefined) return;
		const block = materialize(draft, resultByCallId, cwd);
		draft = undefined;
		if (block !== undefined) g.blocks.push(block);
	};

	for (const e of entries) {
		if (e.sidechain) {
			g.counts.sidechainEntries++;
			if (sidechainRun === undefined) {
				sidechainRun = { lineFrom: e.logLine, lineTo: e.logLine, calls: 0, errors: 0 };
			} else {
				sidechainRun.lineTo = e.logLine;
			}
			if (e.kind === "tool_call") sidechainRun.calls++;
			if (e.kind === "tool_result" && e.isError) sidechainRun.errors++;
			if (sidechainRun.firstText === undefined && e.kind === "assistant_text") {
				sidechainRun.firstText = capLine(e.text, 160);
			}
			continue;
		}
		closeSidechainRun();
		switch (e.kind) {
			case "user_text": {
				flush();
				const d = openDraft();
				g.counts.userPrompts++;
				d.userTexts.push({
					text: capBlock(e.text, USER_PROMPT_CAP),
					logLine: e.logLine,
					timestamp: e.timestamp,
				});
				g.taskPrompts.push({
					text: capBlock(e.text, USER_PROMPT_CAP),
					logLine: e.logLine,
					timestamp: e.timestamp,
				});
				d.startedAt ??= e.timestamp;
				d.endedAt = e.timestamp;
				break;
			}
			case "assistant_text": {
				const text = capBlock(e.text, ASSISTANT_TEXT_CAP);
				if (draft !== undefined && draft.calls.length > 0 && e.turnStart !== true) {
					// narration after tool work concludes the block
					draft.assistantText = text;
					flush();
				} else {
					if (draft !== undefined && draft.calls.length > 0) flush(); // opening narration of a new turn
					const d = openDraft();
					d.assistantText = text;
					d.startedAt ??= e.timestamp;
					d.endedAt = e.timestamp;
				}
				g.counts.assistantMessages++;
				break;
			}
			case "assistant_thinking":
				g.counts.thinkingBlocks++;
				break;
			case "tool_call": {
				if (
					e.turnStart === true &&
					draft !== undefined &&
					draft.calls.length > 0 &&
					(draft.calls.length >= 8 || dominantFamily(draft.calls) !== classifyTool(e.name))
				) {
					// a new assistant turn doing a different kind of work starts a new block
					flush();
				}
				const d = openDraft();
				const key = callKey(e);
				if (lastErrorKey !== undefined && key === lastErrorKey) {
					g.counts.repairCycles++;
					lastErrorKey = undefined;
				}
				d.calls.push(e);
				g.counts.toolCalls++;
				d.startedAt ??= e.timestamp;
				d.endedAt = e.timestamp;
				collectFileOp(e, undefined, g);
				break;
			}
			case "tool_result": {
				const owner = callById.get(e.toolCallId);
				if (e.isError) {
					g.counts.toolErrors++;
					lastErrorKey = owner !== undefined ? callKey(owner) : undefined;
				}
				if (e.interrupted) g.interrupted = true;
				if (owner !== undefined) {
					collectFileOp(owner, e, g);
					if (classifyTool(owner.name) === "execute") {
						const obs = detectChecks(e.content);
						if (obs !== undefined) {
							g.lastChecks = obs;
							if (obs.failed > 0) g.checksEverFailed = true;
						}
					}
				}
				break;
			}
			case "system_note": {
				if (e.subtype === "compaction_summary" || e.subtype === "compact_boundary") {
					g.counts.compactions++;
				}
				if (NOTEWORTHY.has(e.subtype)) {
					g.notes.push({
						timestamp: e.timestamp,
						text: capLine(e.text, NOTE_CAP),
						logLine: e.logLine,
					});
				}
				break;
			}
			case "compaction":
				break;
		}
	}
	closeSidechainRun();
	flush();
	return g;
}

function callKey(call: ToolCallEntry): string {
	return `${call.name}::${toolSignature(call.name, call.input)}`;
}

/** Most common tool family among the draft's calls. */
function dominantFamily(calls: ToolCallEntry[]): ToolFamily {
	const counts = new Map<ToolFamily, number>();
	for (const c of calls) {
		const f = classifyTool(c.name);
		counts.set(f, (counts.get(f) ?? 0) + 1);
	}
	let best: ToolFamily = "other";
	let bestN = -1;
	for (const [f, n] of counts) {
		if (n > bestN) {
			best = f;
			bestN = n;
		}
	}
	return best;
}

function materialize(
	draft: {
		userTexts: { text: string; logLine: number; timestamp: string }[];
		assistantText?: string;
		calls: ToolCallEntry[];
		startedAt?: string;
		endedAt?: string;
	},
	resultByCallId: Map<string, ToolResultEntry>,
	cwd?: string,
): Omit<TimelineBlock, "index" | "sessionIndex"> | undefined {
	if (draft.userTexts.length === 0 && draft.assistantText === undefined && draft.calls.length === 0) {
		return undefined;
	}

	const byFamily = new Map<ToolFamily, number>();
	const lines: ToolCallLine[] = [];
	/** occurrence counts parallel to `lines` for ×N collapsing */
	const occurrences: number[] = [];
	/** dedup key → index in lines */
	const seen = new Map<string, number>();
	let errors = 0;
	let lineFrom = Number.POSITIVE_INFINITY;
	let lineTo = 0;

	for (const call of draft.calls) {
		const r = renderCall(call, resultByCallId.get(call.toolCallId), cwd);
		const logLine = r.resultLine ?? r.callLine;
		lineFrom = Math.min(lineFrom, r.callLine, logLine);
		lineTo = Math.max(lineTo, r.callLine, logLine);
		if (r.isError) errors++;
		byFamily.set(r.family, (byFamily.get(r.family) ?? 0) + 1);
		// dedup key ignores @L pointers so identical repeats collapse
		const dedupKey = `${r.name}|${r.signature}|${r.isError}|${r.resultPart.replace(/@L\d+(–L\d+)?/g, "")}`;
		const existing = seen.get(dedupKey);
		if (existing !== undefined) {
			occurrences[existing] = (occurrences[existing] ?? 1) + 1;
			const prev = lines[existing];
			if (prev !== undefined) {
				// keep the latest occurrence's pointers
				prev.text = `${stripMultiplier(r.text)} ×${occurrences[existing]}`;
				prev.logLine = r.callLine;
			}
			continue;
		}
		seen.set(dedupKey, lines.length);
		occurrences.push(1);
		lines.push({ text: r.text, logLine: r.callLine, isError: r.isError, family: r.family });
	}

	if (lines.length === 0 && draft.userTexts.length === 0 && draft.assistantText === undefined) {
		return undefined;
	}

	const startedAt = draft.startedAt ?? draft.userTexts[0]?.timestamp ?? "";
	const endedAt = draft.endedAt ?? startedAt;

	return {
		startedAt,
		endedAt,
		label: lines.length === 0 ? "outcome" : pickLabel(byFamily),
		summary: deterministicSummary(draft.calls.length, byFamily, errors),
		...(draft.assistantText !== undefined ? { assistantText: draft.assistantText } : {}),
		tools: lines,
		stats: {
			calls: draft.calls.length,
			errors,
			byFamily: Object.fromEntries(byFamily),
			lineFrom: Number.isFinite(lineFrom) ? lineFrom : 0,
			lineTo,
		},
	};
}

function stripMultiplier(text: string): string {
	const m = /(.+?) ×\d+$/.exec(text);
	return m && m[1] !== undefined ? m[1] : text;
}

function pickLabel(byFamily: Map<ToolFamily, number>): BlockLabel {
	const get = (f: ToolFamily): number => byFamily.get(f) ?? 0;
	if (get("agent") > 0) return "delegation";
	if (get("edit") > 0) return "edit";
	const read = get("read") + get("search");
	const exec = get("execute");
	const web = get("web");
	const mcp = get("mcp");
	if (web > 0 && web >= read && web >= exec) return "web";
	if (mcp > 0 && mcp >= read && mcp >= exec) return "mcp";
	if (read > 0 && read >= exec) return "research";
	if (exec > 0) return "run";
	if (read > 0) return "research";
	return "tools";
}

function deterministicSummary(
	calls: number,
	byFamily: Map<ToolFamily, number>,
	errs: number,
): string {
	const get = (f: ToolFamily): number => byFamily.get(f) ?? 0;
	const parts: string[] = [];
	const read = get("read") + get("search");
	const edits = get("edit");
	const execs = get("execute");
	const other = calls - read - edits - execs - get("web") - get("agent") - get("mcp");
	if (read > 0) parts.push(`чтение/поиск ×${read}`);
	if (edits > 0) parts.push(`правки ×${edits}`);
	if (execs > 0) parts.push(`запуски ×${execs}`);
	if (get("web") > 0) parts.push(`веб ×${get("web")}`);
	if (get("agent") > 0) parts.push(`сабагенты ×${get("agent")}`);
	if (get("mcp") > 0) parts.push(`mcp ×${get("mcp")}`);
	if (other > 0) parts.push(`прочее ×${other}`);
	let summary = parts.length > 0 ? parts.join(", ") : "без вызовов инструментов";
	if (errs > 0) summary += `; ошибок: ${errs}`;
	return summary;
}

function collectFileOp(
	call: ToolCallEntry,
	result: ToolResultEntry | undefined,
	g: SessionGrouping,
): void {
	const family = classifyTool(call.name);
	if (family !== "read" && family !== "edit") return;
	const path = extractPath(call);
	if (path === undefined || path.length === 0) return;
	g.paths.add(path);
	if (family === "edit") {
		const diff =
			call.name === "apply_patch"
				? diffFromApplyPatch(call.input)
				: (result?.diff ?? diffFromEditInput(call.name, call.input));
		g.fileOps.push({
			path,
			op: "modify",
			line: result?.logLine ?? call.logLine,
			...(diff !== undefined ? { diff } : {}),
		});
	} else {
		g.fileOps.push({ path, op: "read", line: call.logLine });
	}
}

function extractPath(call: ToolCallEntry): string | undefined {
	if (call.name === "apply_patch") {
		return diffFromApplyPatch(call.input)?.filePath;
	}
	const sig = toolSignature(call.name, call.input);
	if (sig.length === 0) return undefined;
	// Read signature may carry a range suffix "path:10-50".
	const m = /^(\[[^\]]+\]|[A-Za-z]:)?(.+?)(?::\d+(?:-\d+)?)?$/.exec(sig);
	if (m === null) return sig;
	const drive = m[1] ?? "";
	const rest = m[2] ?? sig;
	return `${drive}${rest}`;
}
