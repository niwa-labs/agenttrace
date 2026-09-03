import { basename } from "node:path";
import type {
	DiffStats,
	NormalizedSession,
	SessionEntry,
	ToolCallEntry,
} from "../../model/session.js";
import { emptyUsage } from "../../model/session.js";
import { fileSize, readJsonl } from "../jsonl.js";

/**
 * Adapter: Codex CLI rollout JSONL → NormalizedSession.
 *
 * Layout: line 1 `session_meta`, then `response_item` entries (message /
 * reasoning / function_call / function_call_output), `event_msg` (token counts,
 * user/agent message events), `turn_context` per turn.
 */

const EXIT_CODE_RE = /Process exited with code (-?\d+)/;
const ORIGINAL_TOKENS_RE = /Original token count: (\d+)/;

export async function parseCodexSession(file: string): Promise<NormalizedSession> {
	const entries: SessionEntry[] = [];
	let sessionId = basename(file, ".jsonl").replace(/^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-/, "");
	let cwd = "";
	let title: string | undefined;
	let model: string | undefined;
	let parentThreadId: string | undefined;
	let role: "main" | "subagent" = "main";
	let firstUserText: string | undefined;
	let startedAt = "";
	let endedAt = "";
	let lastLine = 0;
	const usage = emptyUsage();
	/** cumulative totals from the latest token_count event */
	let totals: { input: number; output: number; cached: number } | undefined;
	/** call_id → spawning call entry, so results can inherit the tool name. */
	let turnContextCwd: string | undefined;

	for await (const { line, value } of await readJsonl(file)) {
		lastLine = line;
		if (value === undefined || typeof value !== "object") continue;
		const e = value as Record<string, unknown>;
		const type = e["type"];
		if (typeof type !== "string") continue;

		const ts = typeof e["timestamp"] === "string" ? e["timestamp"] : endedAt;
		if (ts && (!startedAt || ts < startedAt)) startedAt = ts;
		if (ts) endedAt = ts;

		switch (type) {
			case "session_meta": {
				const p = rec(e["payload"]);
				if (!p) break;
				if (typeof p["id"] === "string") sessionId = p["id"];
				if (typeof p["cwd"] === "string") {
					cwd = p["cwd"];
					turnContextCwd ??= p["cwd"];
				}
				if (typeof p["model_provider"] === "string") model ??= p["model_provider"];
				const originator = typeof p["originator"] === "string" ? p["originator"] : "";
				const source = rec(p["source"]);
				const spawn = source ? rec(source["subagent"])?.["thread_spawn"] : undefined;
				const spawnRec = spawn ? rec(spawn) : undefined;
				if (spawnRec) {
					role = "subagent";
					if (typeof spawnRec["parent_thread_id"] === "string") {
						parentThreadId = spawnRec["parent_thread_id"];
					}
				} else if (originator === "codex_exec" || p["thread_source"] === "exec") {
					// headless exec runs keep role "main" but are marked via originator in notes
				}
				break;
			}
			case "turn_context": {
				const p = rec(e["payload"]);
				if (!p) break;
				if (typeof p["cwd"] === "string") turnContextCwd = p["cwd"];
				if (typeof p["model"] === "string") model = p["model"];
				break;
			}
			case "response_item": {
				parseResponseItem(e, ts, line, entries);
				break;
			}
			case "event_msg": {
				const p = rec(e["payload"]);
				if (!p) break;
				if (p["type"] === "user_message" && firstUserText === undefined) {
					const m = p["message"];
					if (typeof m === "string" && !m.startsWith("<user_instructions>") && !m.startsWith("<ENVIRONMENT")) {
						firstUserText = m;
					}
				}
				if (p["type"] === "token_count") {
					usage.requests++;
					const info = rec(p["info"]);
					const total = info ? rec(info["total_token_usage"]) : undefined;
					if (total) {
						totals = {
							input: typeof total["input_tokens"] === "number" ? total["input_tokens"] : 0,
							output: typeof total["output_tokens"] === "number" ? total["output_tokens"] : 0,
							cached: typeof total["cached_input_tokens"] === "number" ? total["cached_input_tokens"] : 0,
						};
					}
				}
				break;
			}
			default:
				break;
		}
	}

	if (cwd === "") cwd = turnContextCwd ?? "";
	if (totals !== undefined) {
		usage.inputTokens = totals.input;
		usage.outputTokens = totals.output;
		usage.cacheReadTokens = totals.cached;
	}

	return {
		source: "codex",
		sessionId,
		logFile: file,
		logLines: lastLine,
		logBytes: await fileSize(file),
		cwd,
		startedAt: startedAt || endedAt,
		endedAt,
		...(title ? { title } : {}),
		...(model ? { model } : {}),
		...(firstUserText ? { firstPrompt: firstUserText.slice(0, 200) } : {}),
		role,
		...(parentThreadId ? { parentThreadId } : {}),
		...(usage.requests > 0 ? { tokenUsage: usage } : {}),
		...(entries.length > 0 ? { activeMs: computeActiveMs(entries) } : {}),
		entries,
	};
}

function computeActiveMs(entries: SessionEntry[]): number {
	const ts = entries
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

function parseResponseItem(
	e: Record<string, unknown>,
	ts: string,
	line: number,
	out: SessionEntry[],
): void {
	const p = rec(e["payload"]);
	if (!p) return;
	switch (p["type"]) {
		case "agent_message": {
			// inter-agent mail (NEW_TASK, …): visible head + note that payload may be encrypted
			const text = flattenContent(p["content"]);
			if (text.length === 0) break;
			out.push({
				kind: "system_note",
				subtype: "agent_message",
				text: text.slice(0, 300),
				timestamp: ts,
				logLine: line,
				sidechain: false,
			});
			break;
		}
		case "message": {
			const role = typeof p["role"] === "string" ? p["role"] : "";
			const text = flattenContent(p["content"]);
			if (text.length === 0) break;
			if (role === "user" && !isInstructionNoise(text)) {
				out.push({ kind: "user_text", text: unwrapDelegation(text), timestamp: ts, logLine: line, sidechain: false });
			} else if (role === "assistant") {
				out.push({ kind: "assistant_text", text, timestamp: ts, logLine: line, sidechain: false });
			} else if (role === "system" || role === "developer") {
				out.push({
					kind: "system_note",
					subtype: role,
					text: text.slice(0, 200),
					timestamp: ts,
					logLine: line,
					sidechain: false,
				});
			}
			break;
		}
		case "reasoning": {
			const summary = flattenContent(p["summary"]);
			if (summary.length > 0) {
				out.push({
					kind: "assistant_thinking",
					text: summary,
					timestamp: ts,
					logLine: line,
					sidechain: false,
				});
			}
			break;
		}
		case "function_call": {
			const call: ToolCallEntry = {
				kind: "tool_call",
				name: typeof p["name"] === "string" ? p["name"] : "unknown",
				input: parseArguments(p["arguments"]),
				toolCallId: typeof p["call_id"] === "string" ? p["call_id"] : "",
				timestamp: ts,
				logLine: line,
				sidechain: false,
			};
			out.push(call);
			break;
		}
		case "function_call_output": {
			const callId = typeof p["call_id"] === "string" ? p["call_id"] : "";
			const output = typeof p["output"] === "string" ? p["output"] : flattenContent(p["output"]);
			const exitMatch = EXIT_CODE_RE.exec(output);
			out.push({
				kind: "tool_result",
				toolCallId: callId,
				content: output,
				isError: exitMatch !== null && exitMatch[1] !== "0",
				interrupted: false,
				...(exitMatch ? { exitCode: Number(exitMatch[1]) } : {}),
				timestamp: ts,
				logLine: line,
				sidechain: false,
			});
			break;
		}
		default:
			// custom_tool_call, local_shell_call, web_search_call, … — rare; skipped.
			break;
	}
}

/** Parse apply_patch payloads that arrive as the tool *input*. */
export function diffFromApplyPatch(input: unknown): DiffStats | undefined {
	const patch = typeof input === "string" ? input : patchFromRec(input);
	if (patch === undefined) return undefined;
	let added = 0;
	let removed = 0;
	let filePath: string | undefined;
	for (const raw of patch.split("\n")) {
		const l = raw.replace(/\r$/, "");
		if (l.startsWith("*** Update File: ") || l.startsWith("*** Add File: ")) {
			filePath = l.slice("*** Update File: ".length).trim();
			continue;
		}
		if (
			l.startsWith("***") ||
			l.startsWith("+++") ||
			l.startsWith("---") ||
			l.startsWith("@@") ||
			l.startsWith("[")
		) {
			continue;
		}
		if (l.startsWith("+")) added++;
		else if (l.startsWith("-")) removed++;
	}
	if (added === 0 && removed === 0) return undefined;
	return { added, removed, ...(filePath !== undefined ? { filePath } : {}) };
}

function patchFromRec(input: unknown): string | undefined {
	const r = rec(input);
	if (!r) return undefined;
	for (const key of ["input", "patch", "patch_text"]) {
		if (typeof r[key] === "string") return r[key];
	}
	return undefined;
}

/** Codex exec outputs begin with a machine header; the payload follows "Output" line. */
export function stripExecHeader(output: string): { body: string; originalTokens?: number } {
	const sep = output.indexOf("\nOutput");
	const m = ORIGINAL_TOKENS_RE.exec(output);
	const originalTokens = m ? Number(m[1]) : undefined;
	if (sep === -1) return { body: output, ...(originalTokens !== undefined ? { originalTokens } : {}) };
	return {
		body: output.slice(sep + "\nOutput\n".length),
		...(originalTokens !== undefined ? { originalTokens } : {}),
	};
}

function flattenContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c) => {
			const r = rec(c);
			if (!r) return "";
			if (typeof r["text"] === "string") return r["text"];
			if (r["type"] === "summary_text" && typeof r["text"] === "string") return r["text"];
			return "";
		})
		.filter((s) => s.length > 0)
		.join("\n");
}

function parseArguments(args: unknown): unknown {
	if (typeof args !== "string") return args;
	try {
		return JSON.parse(args) as unknown;
	} catch {
		return args;
	}
}

/**
 * Delegation envelopes (<realtime_delegation>, <codex_delegation>) wrap the
 * real user request in <input>; the rest is transport markup. Unwrap so the
 * request itself reaches the trace.
 */
export function unwrapDelegation(text: string): string {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("<realtime_delegation>") && !trimmed.startsWith("<codex_delegation>")) {
		return text;
	}
	const inputs = [...text.matchAll(/<input>([\s\S]*?)<\/input>/g)].map((m) => (m[1] ?? "").trim());
	if (inputs.length === 0) return text;
	const kind = trimmed.startsWith("<codex_delegation>") ? "codex" : "realtime";
	return `[delegation:${kind}]\n${inputs.join("\n---\n")}`;
}

function isInstructionNoise(text: string): boolean {
	return (
		text.startsWith("<user_instructions>") ||
		text.startsWith("<ENVIRONMENT_CONTEXT>") ||
		text.startsWith("<permissions") ||
		text.startsWith("# AGENTS.md")
	);
}

function rec(v: unknown): Record<string, unknown> | undefined {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: undefined;
}
