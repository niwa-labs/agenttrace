import { basename, dirname } from "node:path";
import type {
	NormalizedSession,
	SessionEntry,
	SourceKind,
	UsageAgg,
} from "../../model/session.js";
import { emptyUsage } from "../../model/session.js";
import { fileSize, readJsonl } from "../jsonl.js";
import { sessionIdFromDirName } from "./discover.js";

/**
 * Adapter: Minimax Code session JSONL (`messages.jsonl`) → NormalizedSession.
 *
 * Layout: `~/.minimax/v2/sessions/<Y>/<M>/<D>/<ts>-session_<b64>/messages.jsonl`,
 * one envelope per line `{message_id, turn_id, message}`. Roles:
 * - `user` — `content:[{type:"text"}]`; real prompts are prefixed with machine
 *   envelopes (`<system-reminder><agent-context>…` — which also carries the
 *   workspace line, `<background-task-finished>…`); the envelope is stripped,
 *   pure machine notices are dropped.
 * - `assistant` — blocks `thinking`/`text`/`toolCall{id,name,arguments}` plus
 *   `model`/`provider`/`stopReason` and `usage{input,output,cacheRead,
 *   cacheWrite,totalTokens,cost{…,total}}`; `timestamp` is epoch ms.
 * - `toolResult` — `content:[{type:"text"}]`, `toolCallId`, `toolName`,
 *   `isError`, `details` (may carry `textFile.path` for read-like tools).
 * - `compactionSummary` — history was summarized (`tokensBefore`).
 * - `custom` — machine noise (`todo_cadence_reminder`, …, `display:false`).
 *
 * Entries of one exchange share a `turn_id` — the first actually-pushed entry
 * of each new turn gets the `turnStart` block-split hint (compaction notes
 * never claim it: the next real user prompt opens the continued exchange).
 */

// TODO(integration): add "minimax" to SourceKind in src/model/session.ts — cast until then.
const MINIMAX_SOURCE = "minimax" as unknown as SourceKind;

/** Machine envelope tags that prefix user texts; matched closers are derived. */
const NOISE_ENVELOPES = ["<system-reminder>", "<background-task-finished>"];

const WORKSPACE_RE = /YOUR WORKSPACE DIRECTORY:[ \t]*(.+)/;

export async function parseMinimaxSession(file: string): Promise<NormalizedSession> {
	const entries: SessionEntry[] = [];
	const sessionId = sessionIdFor(file);
	let cwd = "";
	let model: string | undefined;
	let firstUserText: string | undefined;
	let startedAt = "";
	let endedAt = "";
	let lastLine = 0;
	let currentTurn: string | undefined;
	const usage = emptyUsage();

	for await (const { line, value } of await readJsonl(file)) {
		lastLine = line;
		if (value === undefined || typeof value !== "object") continue;
		const e = value as Record<string, unknown>;
		const msg = asRecord(e["message"]);
		if (msg === undefined) continue;
		const role = msg["role"];
		if (typeof role !== "string") continue;
		if (role === "custom") continue; // machine noise, never trace-worthy

		const ts = msToIso(msg["timestamp"]);
		if (ts !== "") {
			if (startedAt === "" || ts < startedAt) startedAt = ts;
			if (ts > endedAt) endedAt = ts;
		}

		const turnId = typeof e["turn_id"] === "string" ? e["turn_id"] : undefined;
		const ctx: LineCtx = {
			ts,
			line,
			out: entries,
			takeTurnStart: (): { turnStart?: true } => {
				if (turnId === undefined || turnId === currentTurn) return {};
				currentTurn = turnId;
				return { turnStart: true };
			},
		};

		if (role === "user") {
			const r = parseUser(msg, ctx);
			if (r.workspace !== undefined && cwd === "") cwd = r.workspace;
			if (r.firstText !== undefined && firstUserText === undefined) firstUserText = r.firstText;
			continue;
		}
		if (role === "assistant") {
			if (model === undefined && typeof msg["model"] === "string") model = msg["model"];
			const u = asRecord(msg["usage"]);
			if (u !== undefined) addUsage(usage, u);
			parseAssistant(msg, ctx);
			continue;
		}
		if (role === "toolResult") {
			parseToolResult(msg, ctx);
			continue;
		}
		if (role === "compactionSummary") {
			parseCompaction(msg, ctx);
			continue;
		}
		// unknown roles — metadata, skip
	}

	return {
		source: MINIMAX_SOURCE,
		sessionId,
		logFile: file,
		logLines: lastLine,
		logBytes: await fileSize(file),
		cwd,
		startedAt: startedAt || endedAt,
		endedAt,
		...(model !== undefined ? { model } : {}),
		...(firstUserText !== undefined ? { firstPrompt: firstUserText.slice(0, 200) } : {}),
		role: "main",
		...(usage.requests > 0 ? { tokenUsage: usage } : {}),
		...(entries.length > 0 ? { activeMs: computeActiveMs(entries) } : {}),
		entries,
	};
}

// ---------------------------------------------------------------------------

interface LineCtx {
	ts: string;
	line: number;
	out: SessionEntry[];
	/** Commit the envelope's turn and get its block-split hint (call at push). */
	takeTurnStart(): { turnStart?: true };
}

interface UserParseResult {
	/** Workspace line from the `<agent-context>` preamble, when present. */
	workspace?: string;
	/** First real prompt text after envelope stripping. */
	firstText?: string;
}

function parseUser(msg: Record<string, unknown>, ctx: LineCtx): UserParseResult {
	const result: UserParseResult = {};
	const content = msg["content"];
	if (!Array.isArray(content)) return result;
	for (const block of content) {
		const b = asRecord(block);
		if (b === undefined || b["type"] !== "text") continue;
		const raw = typeof b["text"] === "string" ? b["text"] : "";
		if (raw.length === 0) continue;
		const ws = WORKSPACE_RE.exec(raw)?.[1]?.trim();
		if (ws !== undefined && ws.length > 0 && result.workspace === undefined) result.workspace = ws;
		const text = stripMachineEnvelopes(raw);
		if (text === undefined) continue; // pure machine notice, not a prompt
		ctx.out.push({
			kind: "user_text",
			text,
			timestamp: ctx.ts,
			logLine: ctx.line,
			sidechain: false,
			...ctx.takeTurnStart(),
		});
		if (result.firstText === undefined) result.firstText = text;
	}
	return result;
}

function parseAssistant(msg: Record<string, unknown>, ctx: LineCtx): void {
	const content = msg["content"];
	if (!Array.isArray(content)) return;
	for (const block of content) {
		const b = asRecord(block);
		if (b === undefined) continue;
		switch (b["type"]) {
			case "thinking": {
				const text = typeof b["thinking"] === "string" ? b["thinking"] : "";
				if (text.trim().length === 0) break;
				ctx.out.push({
					kind: "assistant_thinking",
					text,
					timestamp: ctx.ts,
					logLine: ctx.line,
					sidechain: false,
					...ctx.takeTurnStart(),
				});
				break;
			}
			case "text": {
				const text = typeof b["text"] === "string" ? b["text"] : "";
				if (text.trim().length === 0) break;
				ctx.out.push({
					kind: "assistant_text",
					text,
					timestamp: ctx.ts,
					logLine: ctx.line,
					sidechain: false,
					...ctx.takeTurnStart(),
				});
				break;
			}
			case "toolCall": {
				ctx.out.push({
					kind: "tool_call",
					name: typeof b["name"] === "string" ? b["name"] : "unknown",
					input: b["arguments"],
					toolCallId: typeof b["id"] === "string" ? b["id"] : "",
					timestamp: ctx.ts,
					logLine: ctx.line,
					sidechain: false,
					...ctx.takeTurnStart(),
				});
				break;
			}
			default:
				break;
		}
	}
}

function parseToolResult(msg: Record<string, unknown>, ctx: LineCtx): void {
	const details = asRecord(msg["details"]);
	const textFile = details !== undefined ? asRecord(details["textFile"]) : undefined;
	ctx.out.push({
		kind: "tool_result",
		toolCallId: typeof msg["toolCallId"] === "string" ? msg["toolCallId"] : "",
		content: collectText(msg["content"]),
		isError: msg["isError"] === true,
		interrupted: false,
		...(textFile !== undefined && typeof textFile["path"] === "string"
			? { filePath: textFile["path"] }
			: {}),
		timestamp: ctx.ts,
		logLine: ctx.line,
		sidechain: false,
		...ctx.takeTurnStart(),
	});
}

function parseCompaction(msg: Record<string, unknown>, ctx: LineCtx): void {
	ctx.out.push({ kind: "compaction", timestamp: ctx.ts, logLine: ctx.line, sidechain: false });
	const parts = ["history compacted"];
	if (typeof msg["tokensBefore"] === "number") parts.push(`${msg["tokensBefore"]} tokens before`);
	ctx.out.push({
		kind: "system_note",
		subtype: "compaction",
		text: parts.join(", "),
		timestamp: ctx.ts,
		logLine: ctx.line,
		sidechain: false,
	});
}

/**
 * Session id: `<…>-session_<base64>` directory names decode to the `mvs_…` id;
 * logs outside that layout fall back to the file basename.
 */
function sessionIdFor(file: string): string {
	const dir = dirname(file);
	return basename(dir).includes("-session_")
		? sessionIdFromDirName(dir)
		: basename(file, ".jsonl");
}

/**
 * Strip leading machine envelopes (`<system-reminder>…`, `<background-task-
 * finished>…`) from a user text. Returns the remaining real prompt, or
 * undefined when the whole text was a machine notice.
 */
function stripMachineEnvelopes(text: string): string | undefined {
	let t = text.trim();
	for (;;) {
		const open = NOISE_ENVELOPES.find((tag) => t.startsWith(tag));
		if (open === undefined) break;
		const close = `</${open.slice(1)}`; // "<system-reminder>" → "</system-reminder>"
		const end = t.indexOf(close);
		if (end < 0) break;
		t = t.slice(end + close.length).trim(); // envelopes may be stacked back-to-back
	}
	return t.length > 0 ? t : undefined;
}

function collectText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((c) => {
			const r = asRecord(c);
			return r !== undefined && typeof r["text"] === "string" ? r["text"] : "";
		})
		.filter((s) => s.length > 0)
		.join("\n");
}

/** Minimax usage block: `{input, output, cacheRead, cacheWrite, cost{total}}`. */
function addUsage(usage: UsageAgg, u: Record<string, unknown>): void {
	usage.requests++;
	usage.inputTokens += num0(u["input"]);
	usage.outputTokens += num0(u["output"]);
	usage.cacheReadTokens += num0(u["cacheRead"]);
	usage.cacheWriteTokens += num0(u["cacheWrite"]);
	const cost = asRecord(u["cost"]);
	if (cost !== undefined && typeof cost["total"] === "number") {
		usage.costUsd = (usage.costUsd ?? 0) + cost["total"];
	}
}

/** Epoch milliseconds → ISO string; "" for anything that is not a finite number. */
function msToIso(v: unknown): string {
	return typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : "";
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: undefined;
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
