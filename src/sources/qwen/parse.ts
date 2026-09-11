import { basename } from "node:path";
import type {
	NormalizedSession,
	SessionEntry,
	SourceKind,
	UsageAgg,
} from "../../model/session.js";
import { emptyUsage } from "../../model/session.js";
import { fileSize, readJsonl } from "../jsonl.js";

/**
 * Adapter: Qwen Code session JSONL → NormalizedSession.
 *
 * Layout: `~/.qwen/projects/<escaped-cwd>/chats/<uuid>.jsonl`, one record per
 * line with envelope fields `uuid/parentUuid/sessionId/timestamp/type/provenance/
 * cwd/version/gitBranch`. Line types:
 * - `user` — `message.parts:[{text}]`; `provenance:"real_user"` is a human prompt
 *   (older logs have no provenance), `system`/`goal_runtime` are machine-injected.
 * - `assistant` — role `model`; parts are `{text}`, `{text, thought:true}` (thinking),
 *   `{functionCall:{id,name,args}}`. Line-level `model` + Gemini-style
 *   `usageMetadata:{promptTokenCount,candidatesTokenCount,thoughtsTokenCount,
 *   cachedContentTokenCount}`.
 * - `tool_result` — parts `[{functionResponse:{id,name,response:{output}|{error}}}]`.
 * - `system` — `subtype` + `systemPayload`; metadata-only except
 *   `chat_compression` (compaction: originalTokenCount → newTokenCount) and
 *   `session_model` (modelId when assistant lines carry no model).
 */

// TODO(integration): add "qwen" to SourceKind in src/model/session.ts — cast until then.
const QWEN_SOURCE = "qwen" as unknown as SourceKind;

/** system subtypes that are pure telemetry — never trace-worthy. */
const NOISY_SYSTEM_SUBTYPES = new Set([
	"ui_telemetry",
	"attribution_snapshot",
	"file_history_snapshot",
	"turn_result",
	"branch_checkpoint",
	"slash_command",
	"goal_state",
]);

export async function parseQwenSession(file: string): Promise<NormalizedSession> {
	const entries: SessionEntry[] = [];
	let sessionId = basename(file, ".jsonl");
	let cwd = "";
	let gitBranch: string | undefined;
	let model: string | undefined;
	let firstUserText: string | undefined;
	let startedAt = "";
	let endedAt = "";
	let lastLine = 0;
	let firstUuid: string | undefined;
	let lastUuid: string | undefined;
	const usage = emptyUsage();

	for await (const { line, value } of await readJsonl(file)) {
		lastLine = line;
		if (value === undefined || typeof value !== "object") continue;
		const e = value as Record<string, unknown>;
		const type = e["type"];
		if (typeof type !== "string") continue;
		if (typeof e["uuid"] === "string") {
			lastUuid = e["uuid"];
			firstUuid ??= e["uuid"];
		}

		const ts = typeof e["timestamp"] === "string" ? e["timestamp"] : endedAt;
		if (ts && (!startedAt || ts < startedAt)) startedAt = ts;
		if (ts) endedAt = ts;
		if (typeof e["sessionId"] === "string") sessionId = e["sessionId"];
		if (cwd === "" && typeof e["cwd"] === "string") cwd = e["cwd"];
		if (typeof e["gitBranch"] === "string") gitBranch = e["gitBranch"];

		switch (type) {
			case "user": {
				const t = parseUser(e, ts, line, entries);
				if (firstUserText === undefined) firstUserText = t;
				break;
			}
			case "assistant":
				if (typeof e["model"] === "string") model = e["model"];
				addUsage(usage, asRecord(e["usageMetadata"]));
				parseAssistant(e, ts, line, entries);
				break;
			case "tool_result":
				parseToolResult(e, ts, line, entries);
				break;
			case "system": {
				const m = parseSystem(e, ts, line, entries);
				if (m !== undefined) model = m;
				break;
			}
			default:
				break;
		}
	}

	return {
		source: QWEN_SOURCE,
		sessionId,
		logFile: file,
		logLines: lastLine,
		logBytes: await fileSize(file),
		cwd,
		startedAt: startedAt || endedAt,
		endedAt,
		...(model !== undefined ? { model } : {}),
		...(gitBranch !== undefined ? { gitBranch } : {}),
		...(firstUserText !== undefined ? { firstPrompt: firstUserText.slice(0, 200) } : {}),
		role: "main",
		...(firstUuid !== undefined ? { firstUuid } : {}),
		...(lastUuid !== undefined ? { lastUuid } : {}),
		...(usage.requests > 0 ? { tokenUsage: usage } : {}),
		...(entries.length > 0 ? { activeMs: computeActiveMs(entries) } : {}),
		entries,
	};
}

// ---------------------------------------------------------------------------

/** Returns the first real (non-injected) user text found on the line. */
function parseUser(
	e: Record<string, unknown>,
	ts: string,
	line: number,
	out: SessionEntry[],
): string | undefined {
	const msg = asRecord(e["message"]);
	if (!msg) return undefined;
	// Machine-injected prompts (background-task notices, goal runner) are facts
	// about the run, not user intent — keep them as system notes.
	const provenance = typeof e["provenance"] === "string" ? e["provenance"] : "real_user";
	const injected = provenance === "system" || provenance === "goal_runtime";
	const parts = msg["parts"];
	if (!Array.isArray(parts)) return undefined;
	let firstText: string | undefined;
	for (const block of parts) {
		const b = asRecord(block);
		if (!b) continue;
		const text = typeof b["text"] === "string" ? b["text"].trim() : "";
		if (text.length === 0) continue;
		if (firstText === undefined && !injected) firstText = text;
		if (injected) {
			out.push({ kind: "system_note", subtype: provenance, text, timestamp: ts, logLine: line, sidechain: false });
		} else {
			out.push({ kind: "user_text", text, timestamp: ts, logLine: line, sidechain: false });
		}
	}
	return firstText;
}

function parseAssistant(
	e: Record<string, unknown>,
	ts: string,
	line: number,
	out: SessionEntry[],
): void {
	const msg = asRecord(e["message"]);
	if (!msg) return;
	const parts = msg["parts"];
	if (!Array.isArray(parts)) return;
	let firstOfTurn = true;
	for (const block of parts) {
		const b = asRecord(block);
		if (!b) continue;
		if (b["functionCall"] !== undefined) {
			const call = asRecord(b["functionCall"]);
			if (!call) continue;
			out.push({
				kind: "tool_call",
				name: typeof call["name"] === "string" ? call["name"] : "unknown",
				input: call["args"],
				toolCallId: typeof call["id"] === "string" ? call["id"] : "",
				timestamp: ts,
				logLine: line,
				sidechain: false,
				...(firstOfTurn ? { turnStart: true } : {}),
			});
			firstOfTurn = false;
			continue;
		}
		const text = typeof b["text"] === "string" ? b["text"] : "";
		if (text.trim().length === 0) continue;
		if (b["thought"] === true) {
			out.push({
				kind: "assistant_thinking",
				text,
				timestamp: ts,
				logLine: line,
				sidechain: false,
				...(firstOfTurn ? { turnStart: true } : {}),
			});
		} else {
			out.push({
				kind: "assistant_text",
				text,
				timestamp: ts,
				logLine: line,
				sidechain: false,
				...(firstOfTurn ? { turnStart: true } : {}),
			});
		}
		firstOfTurn = false;
	}
}

function parseToolResult(
	e: Record<string, unknown>,
	ts: string,
	line: number,
	out: SessionEntry[],
): void {
	const msg = asRecord(e["message"]);
	if (!msg) return;
	const parts = msg["parts"];
	if (!Array.isArray(parts)) return;
	for (const block of parts) {
		const b = asRecord(block);
		if (!b) continue;
		const fr = asRecord(b["functionResponse"]);
		if (!fr) continue;
		const resp = asRecord(fr["response"]);
		const errMsg =
			resp !== undefined && typeof resp["error"] === "string" ? resp["error"] : undefined;
		const output =
			resp !== undefined && typeof resp["output"] === "string" ? resp["output"] : "";
		out.push({
			kind: "tool_result",
			toolCallId: typeof fr["id"] === "string" ? fr["id"] : "",
			content: errMsg ?? output,
			isError: errMsg !== undefined,
			interrupted: false,
			timestamp: ts,
			logLine: line,
			sidechain: false,
		});
	}
}

/** Returns a model id when the line carries one (session_model fallback). */
function parseSystem(
	e: Record<string, unknown>,
	ts: string,
	line: number,
	out: SessionEntry[],
): string | undefined {
	const subtype = typeof e["subtype"] === "string" ? e["subtype"] : "system";
	if (subtype === "chat_compression") {
		const payload = asRecord(e["systemPayload"]);
		const info = payload !== undefined ? asRecord(payload["info"]) : undefined;
		out.push({ kind: "compaction", timestamp: ts, logLine: line, sidechain: false });
		const parts = ["история сжата компакцией"];
		if (info !== undefined && typeof info["triggerReason"] === "string") {
			parts.push(`trigger=${info["triggerReason"]}`);
		}
		if (
			info !== undefined &&
			typeof info["originalTokenCount"] === "number" &&
			typeof info["newTokenCount"] === "number"
		) {
			parts.push(`${info["originalTokenCount"]}→${info["newTokenCount"]} tokens`);
		}
		out.push({
			kind: "system_note",
			subtype: "chat_compression",
			text: parts.join(", "),
			timestamp: ts,
			logLine: line,
			sidechain: false,
		});
		return undefined;
	}
	if (subtype === "session_model") {
		const payload = asRecord(e["systemPayload"]);
		const modelId = payload !== undefined ? payload["modelId"] : undefined;
		return typeof modelId === "string" ? modelId : undefined;
	}
	if (NOISY_SYSTEM_SUBTYPES.has(subtype)) return undefined;
	// Unknown subtypes: keep a breadcrumb only when they carry a payload.
	const payload = asRecord(e["systemPayload"]);
	if (payload === undefined) return undefined;
	const text = JSON.stringify(payload);
	if (text.length === 0 || text === "{}") return undefined;
	out.push({ kind: "system_note", subtype, text, timestamp: ts, logLine: line, sidechain: false });
	return undefined;
}

/** Gemini-style usage block: camelCase token counts. */
function addUsage(usage: UsageAgg, u: Record<string, unknown> | undefined): void {
	if (u === undefined) return;
	usage.requests++;
	usage.inputTokens += num0(u["promptTokenCount"]);
	usage.outputTokens += num0(u["candidatesTokenCount"]);
	usage.cacheReadTokens += num0(u["cachedContentTokenCount"]);
	usage.reasoningTokens += num0(u["thoughtsTokenCount"]);
}

function num0(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** wall-time minus idle gaps (>2 min). */
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

function asRecord(v: unknown): Record<string, unknown> | undefined {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: undefined;
}
