import { basename, dirname } from "node:path";
import type { NormalizedSession, SessionEntry } from "../../model/session.js";
import { computeActiveMs, emptyUsage } from "../../model/session.js";
import { fileSize, readJsonl } from "../jsonl.js";

/**
 * Adapter: Kimi / Kimi Code wire logs → NormalizedSession.
 *
 * Two on-disk layouts share the same `wire.jsonl` name and a leading
 * `{"type":"metadata","protocol_version":…}` header, detected per line:
 *
 * - **kimi-code CLI** (`~/.kimi-code/sessions/wd_…/session_<uuid>/agents/<agent>/wire.jsonl`,
 *   protocol 1.3–1.5): an event-sourced stream with `time` (ms epoch) fields.
 *   User input arrives as `turn.prompt` (mirrored into `context.append_message`);
 *   assistant content streams as `context.append_loop_event` loop events
 *   (`content.part` with `think`/`text` parts, `tool.call`, `tool.result`);
 *   usage accounting in `usage.record`; compaction via `context.apply_compaction`
 *   / `full_compaction.begin`. The remaining outer events (`config.update`,
 *   `llm.request`, `tools.*`, `permission.*`, `token_counting.*`, `file_history.*`,
 *   `task.*`, `prompt.*`, `turn.ended`, …) are config/telemetry noise — only the
 *   model identity is mined from them.
 * - **kimi CLI** (`~/.kimi/sessions/<hash>/<uuid>/wire.jsonl`, protocol 1.9): a
 *   pi-family wire protocol — `{timestamp:<sec>, message:{type, payload}}` events:
 *   `TurnBegin`/`StepBegin`/`TurnEnd`, `ContentPart` (`think`/`text`), `ToolCall`,
 *   `ToolCallPart` (streaming argument deltas — skipped), `ToolResult`,
 *   `StatusUpdate` (token usage), `QuestionRequest`, `Notification`, `PlanDisplay`,
 *   `CompactionBegin`/`CompactionEnd`, `StepInterrupted`, and `SubagentEvent`
 *   (nested subagent wire messages — mapped with `sidechain: true`).
 *
 * Thinking blocks are first-class: every `think` content part becomes an
 * `assistant_thinking` entry.
 */

export interface KimiParseHints {
	/** Session id from discovery (uuid of the session dir). */
	sessionId?: string;
	/** Exact working directory from discovery (kimi-code `state.json`). */
	cwd?: string;
	/** `main` (default) or `subagent`. */
	role?: "main" | "subagent";
}

export async function parseKimiSession(file: string, hints: KimiParseHints = {}): Promise<NormalizedSession> {
	const entries: SessionEntry[] = [];
	const usage = emptyUsage();
	let model: string | undefined;
	let cwd = hints.cwd ?? "";
	let firstUserText: string | undefined;
	let startedAt = "";
	let endedAt = "";
	let lastLine = 0;
	/** Text of the last `turn.prompt` — `context.append_message` mirrors it (dedupe). */
	let lastPromptText: string | undefined;
	/** Set after a user prompt / step begin: next main assistant entry gets `turnStart`. */
	let assistantTurnPending = false;

	for await (const { line, value } of await readJsonl(file)) {
		lastLine = line;
		if (value === undefined || typeof value !== "object") continue;
		const e = value as Record<string, unknown>;

		// Shared header for both layouts.
		if (e["type"] === "metadata") {
			const createdAt = e["created_at"];
			if (typeof createdAt === "number") {
				noteTimestamp(isoFromMsOr(createdAt, ""));
			}
			continue;
		}

		if (typeof e["type"] === "string") {
			// kimi-code event-sourced layout: `time` is ms epoch.
			const ts = isoFromMsOr(e["time"], endedAt);
			noteTimestamp(ts);
			handleEventsEvent(e, ts, line);
			continue;
		}

		const msg = asRecord(e["message"]);
		if (msg === undefined || typeof msg["type"] !== "string") continue;
		// kimi wire layout: `timestamp` is float seconds.
		const ts = isoFromSecOr(e["timestamp"], endedAt);
		noteTimestamp(ts);
		handleWireEvent(msg, ts, line, false);
	}

	function noteTimestamp(ts: string): void {
		if (ts === "") return;
		if (startedAt === "" || ts < startedAt) startedAt = ts;
		if (endedAt === "" || ts > endedAt) endedAt = ts;
	}

	/** The kimi CLI records the workdir only inside `Working directory:` lines. */
	function sniffCwd(text: string): void {
		if (cwd !== "") return;
		const m = /Working directory: ([^\n"'`]+)/.exec(text);
		if (m?.[1] !== undefined) cwd = m[1].trim();
	}

	/** turnStart hint for the first assistant-side entry after a prompt/step begin. */
	function turnFlag(sidechain: boolean): { turnStart: true } | Record<string, never> {
		if (sidechain || !assistantTurnPending) return {};
		assistantTurnPending = false;
		return { turnStart: true };
	}

	function handleWireEvent(msg: Record<string, unknown>, ts: string, line: number, sidechain: boolean): void {
		const type = msg["type"];
		if (typeof type !== "string") return;
		const payload = asRecord(msg["payload"]);

		if (type === "SubagentEvent") {
			// Nested subagent wire message — recurse, marked as sidechain.
			const inner = asRecord(payload?.["event"]);
			if (inner !== undefined) handleWireEvent(inner, ts, line, true);
			return;
		}

		switch (type) {
			case "TurnBegin": {
				const text = partsText(payload?.["user_input"]);
				if (text.trim().length === 0) return;
				entries.push({ kind: "user_text", text, timestamp: ts, logLine: line, sidechain });
				sniffCwd(text);
				if (!sidechain) {
					lastPromptText = text;
					if (firstUserText === undefined) firstUserText = text;
					assistantTurnPending = true;
				}
				return;
			}
			case "ContentPart": {
				const partType = payload?.["type"];
				if (partType === "think") {
					const text = str(payload?.["think"]);
					if (text.trim().length === 0) return;
					entries.push({ kind: "assistant_thinking", text, timestamp: ts, logLine: line, sidechain, ...turnFlag(sidechain) });
				} else if (partType === "text") {
					const text = str(payload?.["text"]);
					if (text.trim().length === 0) return;
					entries.push({ kind: "assistant_text", text, timestamp: ts, logLine: line, sidechain, ...turnFlag(sidechain) });
				}
				return;
			}
			case "ToolCall": {
				const fn = asRecord(payload?.["function"]);
				const id = str(payload?.["id"]);
				const name = str(fn?.["name"]) || "unknown";
				const rawArgs = fn?.["arguments"];
				let input: unknown = rawArgs;
				if (typeof rawArgs === "string") {
					try {
						input = JSON.parse(rawArgs) as unknown;
					} catch {
						input = rawArgs;
					}
				}
				entries.push({
					kind: "tool_call",
					name,
					input,
					toolCallId: id,
					timestamp: ts,
					logLine: line,
					sidechain,
					...turnFlag(sidechain),
				});
				return;
			}
			case "ToolResult": {
				const id = str(payload?.["tool_call_id"]);
				const rv = asRecord(payload?.["return_value"]);
				const out = str(rv?.["output"]);
				const content = out !== "" ? out : str(rv?.["message"]);
				entries.push({
					kind: "tool_result",
					toolCallId: id,
					content,
					isError: rv?.["is_error"] === true,
					interrupted: false,
					timestamp: ts,
					logLine: line,
					sidechain,
				});
				return;
			}
			case "StatusUpdate": {
				if (sidechain) return;
				const u = asRecord(payload?.["token_usage"]);
				if (u === undefined) return;
				usage.requests += 1;
				usage.inputTokens += num0(u["input_other"]);
				usage.outputTokens += num0(u["output"]);
				usage.cacheReadTokens += num0(u["input_cache_read"]);
				usage.cacheWriteTokens += num0(u["input_cache_creation"]);
				return;
			}
			case "StepBegin": {
				if (!sidechain) assistantTurnPending = true;
				return;
			}
			case "StepInterrupted": {
				entries.push({ kind: "system_note", subtype: "step_interrupted", text: "step interrupted", timestamp: ts, logLine: line, sidechain });
				return;
			}
			case "QuestionRequest": {
				const raw = payload?.["questions"];
				const questions = Array.isArray(raw) ? raw : [];
				const text = questions
					.map((q) => str(asRecord(q)?.["question"]))
					.filter((s) => s.length > 0)
					.join("; ");
				entries.push({ kind: "system_note", subtype: "question", text, timestamp: ts, logLine: line, sidechain });
				return;
			}
			case "Notification": {
				const title = str(payload?.["title"]);
				const body = str(payload?.["body"]);
				const category = str(payload?.["category"]) || "general";
				entries.push({
					kind: "system_note",
					subtype: `notification:${category}`,
					text: [title, body].filter((s) => s.length > 0).join("\n"),
					timestamp: ts,
					logLine: line,
					sidechain,
				});
				return;
			}
			case "PlanDisplay": {
				const filePath = str(payload?.["file_path"]);
				const content = str(payload?.["content"]);
				entries.push({
					kind: "system_note",
					subtype: "plan",
					text: `${filePath !== "" ? `${filePath}\n` : ""}${content}`,
					timestamp: ts,
					logLine: line,
					sidechain,
				});
				return;
			}
			case "CompactionBegin": {
				entries.push({ kind: "compaction", timestamp: ts, logLine: line, sidechain });
				return;
			}
			default:
				// TurnEnd, ToolCallPart (streaming argument delta), CompactionEnd — no entries.
				return;
		}
	}

	function handleEventsEvent(e: Record<string, unknown>, ts: string, line: number): void {
		const type = e["type"];
		switch (type) {
			case "turn.prompt": {
				const text = partsText(e["input"]);
				if (text.trim().length === 0) return;
				entries.push({ kind: "user_text", text, timestamp: ts, logLine: line, sidechain: false });
				sniffCwd(text);
				lastPromptText = text;
				if (firstUserText === undefined) firstUserText = text;
				assistantTurnPending = true;
				return;
			}
			case "turn.steer": {
				// Mid-turn user addition — keep as user input; it starts a new assistant block.
				const text = partsText(e["input"]);
				if (text.trim().length === 0) return;
				entries.push({ kind: "user_text", text, timestamp: ts, logLine: line, sidechain: false });
				sniffCwd(text);
				assistantTurnPending = true;
				return;
			}
			case "turn.cancel": {
				entries.push({ kind: "system_note", subtype: "turn_cancel", text: "turn cancelled", timestamp: ts, logLine: line, sidechain: false });
				return;
			}
			case "context.append_message": {
				const msg = asRecord(e["message"]);
				if (msg === undefined) return;
				const role = msg["role"];
				if (role !== "user") return; // assistant content streams via loop events
				const text = partsText(msg["content"]);
				if (text.trim().length === 0) return;
				if (lastPromptText !== undefined && text === lastPromptText) return; // mirror of turn.prompt
				if (isWrappedNote(text)) {
					entries.push({ kind: "system_note", subtype: "context_message", text, timestamp: ts, logLine: line, sidechain: false });
					sniffCwd(text);
					return;
				}
				entries.push({ kind: "user_text", text, timestamp: ts, logLine: line, sidechain: false });
				sniffCwd(text);
				return;
			}
			case "context.append_loop_event": {
				const ev = asRecord(e["event"]);
				if (ev === undefined) return;
				handleLoopEvent(ev, ts, line);
				return;
			}
			case "context.apply_compaction":
			case "full_compaction.begin": {
				entries.push({ kind: "compaction", timestamp: ts, logLine: line, sidechain: false });
				return;
			}
			case "usage.record": {
				usage.requests += 1;
				const u = asRecord(e["usage"]);
				usage.inputTokens += num0(u?.["inputOther"]);
				usage.outputTokens += num0(u?.["output"]);
				usage.cacheReadTokens += num0(u?.["inputCacheRead"]);
				usage.cacheWriteTokens += num0(u?.["inputCacheCreation"]);
				if (model === undefined) {
					const m = e["model"];
					if (typeof m === "string" && m.length > 0) model = m;
				}
				return;
			}
			case "llm.request": {
				const m = firstStr(e["model"], e["modelAlias"]);
				if (m !== undefined && model === undefined) model = m;
				return;
			}
			case "config.update": {
				const m = e["modelAlias"];
				if (typeof m === "string" && m.length > 0 && model === undefined) model = m;
				return;
			}
			case "interaction.request": {
				entries.push({ kind: "system_note", subtype: "question", text: str(e["kind"]) || "interaction", timestamp: ts, logLine: line, sidechain: false });
				return;
			}
			default:
				// config/telemetry noise: config.update, tools.*, permission.*, mcp.*,
				// llm.tools_snapshot, token_counting.*, file_history.*, task.*,
				// prompt.*, turn.ended, runtime.*, profile.*, plugin.* — no entries.
				return;
		}
	}

	function handleLoopEvent(ev: Record<string, unknown>, ts: string, line: number): void {
		const type = ev["type"];
		if (type === "content.part") {
			const part = asRecord(ev["part"]);
			const partType = part?.["type"];
			if (partType === "think") {
				const text = str(part?.["think"]);
				if (text.trim().length === 0) return;
				entries.push({ kind: "assistant_thinking", text, timestamp: ts, logLine: line, sidechain: false, ...turnFlag(false) });
			} else if (partType === "text") {
				const text = str(part?.["text"]);
				if (text.trim().length === 0) return;
				entries.push({ kind: "assistant_text", text, timestamp: ts, logLine: line, sidechain: false, ...turnFlag(false) });
			}
			return;
		}
		if (type === "tool.call") {
			const id = str(ev["toolCallId"]) || str(ev["uuid"]);
			entries.push({
				kind: "tool_call",
				name: str(ev["name"]) || "unknown",
				input: ev["args"],
				toolCallId: id,
				timestamp: ts,
				logLine: line,
				sidechain: false,
				...turnFlag(false),
			});
			return;
		}
		if (type === "tool.result") {
			const result = asRecord(ev["result"]);
			const out = str(result?.["output"]);
			entries.push({
				kind: "tool_result",
				toolCallId: str(ev["toolCallId"]),
				content: out !== "" ? out : str(result?.["note"]),
				isError: result?.["isError"] === true || result?.["is_error"] === true,
				interrupted: false,
				timestamp: ts,
				logLine: line,
				sidechain: false,
			});
			return;
		}
		// step.begin → new assistant block; step.end → usage only (usage.record covers it).
		if (type === "step.begin") assistantTurnPending = true;
	}

	return {
		// "kimi" is part of the SourceKind union in src/model/session.ts (working tree).
		source: "kimi",
		sessionId: hints.sessionId ?? sniffSessionId(file),
		logFile: file,
		logLines: lastLine,
		logBytes: await fileSize(file),
		cwd,
		startedAt: startedAt || endedAt,
		endedAt,
		...(model !== undefined ? { model } : {}),
		...(firstUserText !== undefined ? { firstPrompt: firstUserText.slice(0, 200) } : {}),
		role: hints.role ?? "main",
		...(usage.requests > 0 ? { tokenUsage: usage } : {}),
		...(entries.length > 0 ? { activeMs: computeActiveMs(entries) } : {}),
		entries,
	};
}

/** Session id from the path: `session_<uuid>` dir, `<uuid>` dir, or parent dir name. */
function sniffSessionId(file: string): string {
	const uuid = /(?:(^|\/)session_)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\/)/i.exec(file)?.[2];
	return uuid ?? basename(dirname(file));
}

/** `turn.prompt` / `TurnBegin` input: a text-parts array or a plain string. */
function partsText(input: unknown): string {
	if (typeof input === "string") return input;
	if (!Array.isArray(input)) return "";
	return input
		.map((part) => str(asRecord(part)?.["text"]))
		.filter((s) => s.length > 0)
		.join("\n");
}

/** Injected context rows wrapped in an XML-ish envelope (`<system-reminder>…`). */
function isWrappedNote(text: string): boolean {
	return text.startsWith("<") && /<\/[a-zA-Z-]+>\s*$/.test(text);
}

function firstStr(...values: unknown[]): string | undefined {
	for (const v of values) {
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

function isoFromSecOr(v: unknown, fallback: string): string {
	return typeof v === "number" && Number.isFinite(v) ? new Date(v * 1000).toISOString() : fallback;
}

function isoFromMsOr(v: unknown, fallback: string): string {
	return typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : fallback;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function num0(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
