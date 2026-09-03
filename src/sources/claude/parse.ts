import { basename } from "node:path";
import type {
	DiffStats,
	NormalizedSession,
	SessionEntry,
	ToolCallEntry,
	ToolResultEntry,
} from "../../model/session.js";
import { diffFromEditInput, emptyUsage } from "../../model/session.js";
import { fileSize, readJsonl } from "../jsonl.js";

/**
 * Adapter: Claude Code session JSONL → NormalizedSession.
 *
 * Metadata-only line types (permission-mode, mode, last-prompt, queue-operation,
 * file-history-snapshot, attachment, …) are skipped except where they carry
 * trace-worthy facts (ai-title, custom-title, pr-link, compact boundaries).
 */

const NOISY_SYSTEM_SUBTYPES = new Set(["turn_duration", "status", "status_change"]);

export async function parseClaudeSession(file: string): Promise<NormalizedSession> {
	const entries: SessionEntry[] = [];
	let sessionId = basename(file, ".jsonl");
	let cwd = "";
	let gitBranch: string | undefined;
	let title: string | undefined;
	let model: string | undefined;
	let leafUuid: string | undefined;
	let logicalParentUuid: string | undefined;
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
		const sidechain = e["isSidechain"] === true;

		switch (type) {
			case "user":
				if (e["isCompactSummary"] === true) {
					logicalParentUuid =
						typeof e["logicalParentUuid"] === "string" ? e["logicalParentUuid"] : undefined;
					entries.push({ kind: "compaction", timestamp: ts, logLine: line, sidechain });
					const summaryText = compactSummaryText(e);
					if (summaryText) {
						entries.push({
							kind: "system_note",
							subtype: "compaction_summary",
							text: summaryText,
							timestamp: ts,
							logLine: line,
							sidechain,
						});
					}
				} else {
					parseUser(e, ts, line, sidechain, entries);
					if (firstUserText === undefined) {
						const t = firstRealUserText(e);
						if (t) firstUserText = t;
					}
				}
				break;
			case "assistant": {
				const msg = asRecord(e["message"]);
				if (msg && typeof msg["model"] === "string") model = msg["model"];
				if (msg) addClaudeUsage(usage, asRecord(msg["usage"]));
				parseAssistant(e, ts, line, sidechain, entries);
				break;
			}
			case "system": {
				const subtype = typeof e["subtype"] === "string" ? e["subtype"] : "system";
				if (subtype === "compact_boundary") {
					entries.push({ kind: "compaction", timestamp: ts, logLine: line, sidechain });
					entries.push({
						kind: "system_note",
						subtype: "compact_boundary",
						text: compactBoundaryText(e),
						timestamp: ts,
						logLine: line,
						sidechain,
					});
					break;
				}
				if (NOISY_SYSTEM_SUBTYPES.has(subtype)) break;
				const text = typeof e["content"] === "string" ? e["content"] : "";
				if (text.length === 0 || text === "null") break;
				entries.push({ kind: "system_note", subtype, text, timestamp: ts, logLine: line, sidechain });
				break;
			}
			case "ai-title":
				if (typeof e["aiTitle"] === "string") title = e["aiTitle"];
				break;
			case "custom-title":
				if (typeof e["customTitle"] === "string" && !title) title = e["customTitle"];
				break;
			case "pr-link": {
				const pr = e["prNumber"];
				const url = e["prUrl"];
				if (typeof pr === "number" && typeof url === "string") {
					entries.push({
						kind: "system_note",
						subtype: "pr-link",
						text: `PR !${pr}: ${url}`,
						timestamp: ts,
						logLine: line,
						sidechain,
					});
				}
				break;
			}
			case "summary":
				if (typeof e["leafUuid"] === "string") leafUuid = e["leafUuid"];
				break;
			default:
				// permission-mode, mode, last-prompt, queue-operation, attachment,
				// file-history-*, atis-latch, agent-name, … — metadata only.
				break;
		}
	}

	return {
		source: "claude",
		sessionId,
		logFile: file,
		logLines: lastLine,
		logBytes: await fileSize(file),
		cwd,
		startedAt: startedAt || endedAt,
		endedAt,
		...(title ? { title } : {}),
		...(model ? { model } : {}),
		...(gitBranch ? { gitBranch } : {}),
		...(firstUserText ? { firstPrompt: firstUserText.slice(0, 200) } : {}),
		role: "main",
		...(leafUuid ? { leafUuid } : {}),
		...(logicalParentUuid ? { logicalParentUuid } : {}),
		...(firstUuid ? { firstUuid } : {}),
		...(lastUuid ? { lastUuid } : {}),
		...(usage.requests > 0 ? { tokenUsage: usage } : {}),
		...(entries.length > 0 ? { activeMs: computeActiveMs(entries) } : {}),
		entries,
	};
}

/** Claude usage block: snake_case API fields. */
function addClaudeUsage(usage: ReturnType<typeof emptyUsage>, u: Record<string, unknown> | undefined): void {
	if (u === undefined) return;
	usage.requests++;
	usage.inputTokens += num0(u["input_tokens"]);
	usage.outputTokens += num0(u["output_tokens"]);
	usage.cacheReadTokens += num0(u["cache_read_input_tokens"]);
	usage.cacheWriteTokens += num0(u["cache_creation_input_tokens"]);
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

// ---------------------------------------------------------------------------

function parseUser(
	e: Record<string, unknown>,
	ts: string,
	line: number,
	sidechain: boolean,
	out: SessionEntry[],
): void {
	if (e["isMeta"] === true) return;
	const msg = asRecord(e["message"]);
	if (!msg) return;
	const content = msg["content"];
	const toolUseResult = asRecord(e["toolUseResult"]);

	if (typeof content === "string") {
		const text = cleanUserText(content);
		if (text) out.push({ kind: "user_text", text, timestamp: ts, logLine: line, sidechain });
		return;
	}
	if (!Array.isArray(content)) return;

	for (const block of content) {
		const b = asRecord(block);
		if (!b) continue;
		switch (b["type"]) {
			case "text": {
				const text = cleanUserText(typeof b["text"] === "string" ? b["text"] : "");
				if (text) out.push({ kind: "user_text", text, timestamp: ts, logLine: line, sidechain });
				break;
			}
			case "tool_result": {
				const id = typeof b["tool_use_id"] === "string" ? b["tool_use_id"] : "";
				out.push(
					buildToolResult(b, toolUseResult, id, ts, line, sidechain),
				);
				break;
			}
			default:
				// image blocks etc. — counted via their tool_result sibling.
				break;
		}
	}
}

function buildToolResult(
	block: Record<string, unknown>,
	toolUseResult: Record<string, unknown> | undefined,
	toolCallId: string,
	ts: string,
	line: number,
	sidechain: boolean,
): ToolResultEntry {
	const rawContent = block["content"];
	let text: string;
	if (typeof rawContent === "string") {
		text = rawContent;
	} else if (Array.isArray(rawContent)) {
		text = rawContent
			.map((c) => {
				const r = asRecord(c);
				if (!r) return "";
				if (r["type"] === "text" && typeof r["text"] === "string") return r["text"];
				if (r["type"] === "image") return "[image]";
				return "";
			})
			.filter((s) => s.length > 0)
			.join("\n");
	} else {
		text = "";
	}

	const interrupted =
		toolUseResult?.["interrupted"] === true || text.includes("[Request interrupted by user");

	let diff: DiffStats | undefined;
	let filePath: string | undefined;
	if (toolUseResult && toolUseResult["type"] === "file") {
		const f = asRecord(toolUseResult["file"]);
		if (f && typeof f["filePath"] === "string") {
			filePath = f["filePath"];
			diff = diffFromStructuredPatch(f);
		}
	}

	return {
		kind: "tool_result",
		toolCallId,
		content: text,
		isError: block["is_error"] === true,
		interrupted,
		...(diff ? { diff } : {}),
		...(filePath ? { filePath } : {}),
		timestamp: ts,
		logLine: line,
		sidechain,
	};
}

/** Claude Edit results carry a structuredPatch with exact +/- lines. */
function diffFromStructuredPatch(file: Record<string, unknown>): DiffStats | undefined {
	const patch = file["structuredPatch"];
	if (!Array.isArray(patch)) return undefined;
	let added = 0;
	let removed = 0;
	for (const hunk of patch) {
		const h = asRecord(hunk);
		if (!h || !Array.isArray(h["lines"])) continue;
		for (const l of h["lines"]) {
			if (typeof l !== "string") continue;
			if (l.startsWith("+")) added++;
			else if (l.startsWith("-")) removed++;
		}
	}
	const filePath = typeof file["filePath"] === "string" ? file["filePath"] : undefined;
	if (added === 0 && removed === 0) return undefined;
	return { added, removed, ...(filePath ? { filePath } : {}) };
}

function parseAssistant(
	e: Record<string, unknown>,
	ts: string,
	line: number,
	sidechain: boolean,
	out: SessionEntry[],
): void {
	const msg = asRecord(e["message"]);
	if (!msg) return;
	const content = msg["content"];
	if (!Array.isArray(content)) return;
	let firstOfTurn = true;
	for (const block of content) {
		const b = asRecord(block);
		if (!b) continue;
		const turn = firstOfTurn ? { turnStart: true } : {};
		firstOfTurn = false;
		switch (b["type"]) {
			case "text":
				if (typeof b["text"] === "string" && b["text"].trim().length > 0) {
					out.push({
						kind: "assistant_text",
						text: b["text"],
						timestamp: ts,
						logLine: line,
						sidechain,
						...turn,
					});
				}
				break;
			case "thinking":
				if (typeof b["thinking"] === "string" && b["thinking"].trim().length > 0) {
					out.push({
						kind: "assistant_thinking",
						text: b["thinking"],
						timestamp: ts,
						logLine: line,
						sidechain,
						...turn,
					});
				}
				break;
			case "tool_use": {
				out.push({
					kind: "tool_call",
					name: typeof b["name"] === "string" ? b["name"] : "unknown",
					input: b["input"],
					toolCallId: typeof b["id"] === "string" ? b["id"] : "",
					timestamp: ts,
					logLine: line,
					sidechain,
					...turn,
				});
				break;
			}
			default:
				break;
		}
	}
}

// ---------------------------------------------------------------------------

/** Line prefixes that are terminal-UI decoration, not user content. */
const UI_NOISE_LINE_RE = /^\s*[✻※❯⏺⎿●✳✶✽]\s/;

/**
 * Strip context noise from user messages: <system-reminder> blocks, Claude Code
 * caveat boilerplate, terminal decoration lines. Returns undefined when nothing
 * real remains.
 */
function cleanUserText(text: string): string | undefined {
	if (text.startsWith("Caveat: The messages below")) return undefined;
	const stripped = text
		.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
		.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
		.split("\n")
		.filter((l) => !UI_NOISE_LINE_RE.test(l))
		.join("\n")
		.trim();
	if (stripped.length === 0) return undefined;
	// Local command stdout is machine output, not user intent — keep only a marker.
	if (stripped.startsWith("<local-command-stdout>")) return undefined;
	return stripped;
}

function firstRealUserText(e: Record<string, unknown>): string | undefined {
	const msg = asRecord(e["message"]);
	if (!msg) return undefined;
	const c = msg["content"];
	const texts: string[] = [];
	if (typeof c === "string") texts.push(c);
	else if (Array.isArray(c)) {
		for (const b of c) {
			const r = asRecord(b);
			if (r && r["type"] === "text" && typeof r["text"] === "string") texts.push(r["text"]);
		}
	}
	for (const t of texts) {
		const clean = cleanUserText(t);
		if (clean) return clean;
	}
	return undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: undefined;
}

/** Head of the model-written history summary stored in an isCompactSummary user entry. */
function compactSummaryText(e: Record<string, unknown>): string | undefined {
	const msg = asRecord(e["message"]);
	if (!msg) return undefined;
	const c = msg["content"];
	if (typeof c === "string") return c.slice(0, 400);
	if (Array.isArray(c)) {
		const text = c
			.map((b) => {
				const r = asRecord(b);
				return r && typeof r["text"] === "string" ? r["text"] : "";
			})
			.join("\n");
		return text.length > 0 ? text.slice(0, 400) : undefined;
	}
	return undefined;
}

/** compact_boundary system entries carry pre/post token counts as JSON content. */
function compactBoundaryText(e: Record<string, unknown>): string {
	const raw = typeof e["content"] === "string" ? e["content"] : "";
	let trigger = "";
	let pre = "";
	let post = "";
	try {
		const j = JSON.parse(raw) as Record<string, unknown>;
		if (typeof j["trigger"] === "string") trigger = j["trigger"];
		if (typeof j["preTokens"] === "number") pre = String(j["preTokens"]);
		if (typeof j["postTokens"] === "number") post = String(j["postTokens"]);
	} catch {
		// older logs: content is a plain string
	}
	const parts = ["история сжата компакцией"];
	if (trigger) parts.push(`trigger=${trigger}`);
	if (pre && post) parts.push(`${pre}→${post} tokens`);
	return parts.join(", ");
}

/** Edit tools whose diff the log didn't precompute — derive from raw input. */
export function fallbackDiffFor(
	call: ToolCallEntry,
	result: ToolResultEntry,
): DiffStats | undefined {
	if (result.diff) return result.diff;
	return diffFromEditInput(call.name, call.input);
}
