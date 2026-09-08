import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CursorExportReport, CursorLogLine, CursorLogMeta, DatabaseSyncOptionsRO } from "./types.js";

/**
 * Export Cursor IDE chats from `state.vscdb` into per-composer JSONL logs.
 *
 * Layout:
 *  - `composerHeaders(composerId, workspaceId, createdAt, ..., value)` — one row
 *    per chat; `value` is a compact JSON {composerId, name, createdAt, ...}.
 *  - `cursorDiskKV(key, value)` — `composerData:<id>` holds the full session
 *    (message order lives in `fullConversationHeadersOnly`), `bubbleId:<cid>:<bid>`
 *    holds individual messages. `agentKv:*` keys (GBs of noise) are never touched.
 *
 * The database may be open by a running Cursor — it is opened read-only and
 * never written to.
 */

interface ComposerHeaderRow {
	composerId: string;
	value: string | Uint8Array | null;
	isSubagent: number | null;
}

interface ConversationHeader {
	bubbleId?: unknown;
	type?: unknown;
	createdAt?: unknown;
}

interface BubbleRecord {
	bubbleId?: unknown;
	type?: unknown;
	text?: unknown;
	createdAt?: unknown;
	thinking?: { text?: unknown };
	/** Most Cursor versions: tool call + result stored on the assistant bubble itself. */
	toolFormerData?: unknown;
	/** Some versions: tool call records hang here, each with its own toolFormerData. */
	toolResults?: unknown;
}

interface ToolFormerData {
	name?: unknown;
	rawArgs?: unknown;
	result?: unknown;
	status?: unknown;
	isError?: unknown;
}

interface KvRow {
	value?: string | Uint8Array | null;
}

const WS_PATH_RE = /Workspace Path:\s*(.+)/;

export async function exportCursorIdeSessions(
	dbPath: string,
	outDir: string,
	opts?: { limit?: number },
): Promise<CursorExportReport> {
	const report: CursorExportReport = { exported: 0, skipped: 0, noBubbles: 0, errors: [] };
	await mkdir(outDir, { recursive: true });

	// readOnly is not in @types/node 22.10 DatabaseSyncOptions but is supported at runtime
	const roOpts: DatabaseSyncOptionsRO = { readOnly: true };
	const db = new DatabaseSync(dbPath, roOpts);
	try {
		const headers = db
			.prepare("SELECT composerId, value, isSubagent FROM composerHeaders ORDER BY createdAt")
			.all() as unknown as ComposerHeaderRow[];
		const bubbleStmt = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
		const composerStmt = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");

		let processed = 0;
		for (const row of headers) {
			if (row.isSubagent === 1) continue;
			if (opts?.limit !== undefined && processed >= opts.limit) break;
			processed++;
			const cid = row.composerId;
			try {
				const logPath = join(outDir, `${cid}.jsonl`);
				if (await exists(logPath)) {
					report.skipped++;
					continue;
				}

				const composerRow = composerStmt.get(`composerData:${cid}`) as KvRow | undefined;
				const composer = readKvJson(composerRow?.value);
				if (composer === undefined || typeof composer !== "object") {
					report.noBubbles++;
					continue;
				}
				const comp = composer as Record<string, unknown>;
				const headersOnly = comp["fullConversationHeadersOnly"];
				if (!Array.isArray(headersOnly) || headersOnly.length < 1) {
					report.noBubbles++;
					continue;
				}

				const lines: CursorLogLine[] = [];
				const userTexts: string[] = [];
				const headerMeta = asRecord(row.value === null ? undefined : readKvJson(row.value));
				for (const h of headersOnly) {
					if (typeof h !== "object" || h === null) continue;
					const { bubbleId: bid, type } = h as ConversationHeader;
					if (typeof bid !== "string") continue;
					const bubbleRow = bubbleStmt.get(`bubbleId:${cid}:${bid}`) as KvRow | undefined;
					const bubble = readKvJson(bubbleRow?.value);
					if (bubble === undefined || typeof bubble !== "object") continue;
					appendBubbleLines(bubble as BubbleRecord, bid, type, lines, userTexts);
				}

				if (lines.length < 1) {
					report.noBubbles++;
					continue;
				}

				const meta: CursorLogMeta = {
					sessionId: cid,
					source: "cursor-ide",
					msgCount: lines.length,
				};
				const title = strOf(comp["name"]) ?? strOf(headerMeta?.["name"]);
				if (title) meta.title = title;
				const createdAt = isoOf(comp["createdAt"]) ?? isoOf(headerMeta?.["createdAt"]);
				if (createdAt) meta.createdAt = createdAt;
				const lastUpdatedAt = isoOf(comp["lastUpdatedAt"]) ?? isoOf(headerMeta?.["lastUpdatedAt"]);
				if (lastUpdatedAt) meta.lastUpdatedAt = lastUpdatedAt;
				const wsPath = detectWorkspacePath(comp, userTexts);
				if (wsPath) meta.workspacePath = wsPath;

				const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
				await writeFile(logPath, body, "utf8");
				await writeFile(
					join(outDir, `${cid}.meta.json`),
					JSON.stringify(meta, null, "\t") + "\n",
					"utf8",
				);
				report.exported++;
			} catch (e) {
				report.errors.push(`composer ${cid}: ${e instanceof Error ? e.message : String(e)}`);
			}
			if (processed % 100 === 0) {
				console.error(`cursor-ide: ${processed}/${headers.length} exported=${report.exported} skipped=${report.skipped} noBubbles=${report.noBubbles}`);
			}
		}
	} finally {
		db.close();
	}
	return report;
}

// ---------------------------------------------------------------------------

/** Convert one bubble into CursorLogLines, collecting user texts for heuristics. */
function appendBubbleLines(
	bubble: BubbleRecord,
	bid: string,
	headerType: unknown,
	out: CursorLogLine[],
	userTexts: string[],
): void {
	const type = typeof bubble.type === "number" ? bubble.type : headerType;
	const ts = isoOf(bubble.createdAt) ?? "";
	const text = typeof bubble.text === "string" ? bubble.text : "";

	if (type === 1) {
		if (text.trim().length === 0) return;
		userTexts.push(text);
		out.push({ kind: "user_text", text, ts, bid });
		return;
	}
	if (type !== 2) return;

	const thinkingText = strOf(bubble.thinking?.text);
	if (thinkingText && thinkingText.trim().length > 0) {
		out.push({ kind: "assistant_thinking", text: thinkingText, ts, bid });
	}
	if (text.trim().length > 0) {
		out.push({ kind: "assistant_text", text, ts, bid });
	}

	// Tool calls: bubble-level toolFormerData (current schema) plus any
	// toolResults[] entries that carry their own toolFormerData (older schema).
	const tools: ToolFormerData[] = [];
	const own = asRecord(bubble.toolFormerData);
	if (own) tools.push(own);
	if (Array.isArray(bubble.toolResults)) {
		for (const tr of bubble.toolResults) {
			const rec = asRecord(tr);
			const tfd = rec ? asRecord(rec["toolFormerData"]) : undefined;
			if (tfd) tools.push(tfd);
		}
	}
	tools.forEach((tfd, idx) => {
		const toolCallId = `${bid}:${idx}`;
		const isError = tfd.isError === true || tfd.status === "error";
		out.push({ kind: "tool_call", name: strOf(tfd["name"]) ?? "unknown_tool", input: parseArgs(tfd["rawArgs"]), toolCallId, ts, bid });
		out.push({ kind: "tool_result", toolCallId, content: resultText(tfd["result"]), isError, ts, bid });
	});
}

/** tool_call input: parsed rawArgs when it is a JSON string, the raw string otherwise. */
function parseArgs(rawArgs: unknown): unknown {
	if (typeof rawArgs !== "string") return rawArgs;
	try {
		return JSON.parse(rawArgs) as unknown;
	} catch {
		return rawArgs;
	}
}

/** tool_result content: kept as string when the source has one, JSON-serialized otherwise. */
function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (result === undefined || result === null) return "";
	return JSON.stringify(result);
}

/** workspace detection: explicit field, then "Workspace Path:" lines, then /Users/<home>/projects frequency. */
function detectWorkspacePath(comp: Record<string, unknown>, userTexts: string[]): string | undefined {
	const wsId = asRecord(comp["workspaceIdentifier"]);
	const uri = wsId ? asRecord(wsId["uri"]) : undefined;
	const fsPath = uri ? strOf(uri["fsPath"]) : undefined;
	if (fsPath) return fsPath;

	for (const t of userTexts) {
		const m = WS_PATH_RE.exec(t);
		if (m?.[1]) return m[1].trim();
	}

	const home = homedir();
	const projectsRe = new RegExp(
		`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/projects/([A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+){0,3})`,
		"g",
	);
	const counter = new Map<string, number>();
	for (const t of userTexts) {
		for (const m of t.matchAll(projectsRe)) {
			const segs = (m[1] ?? "").split("/");
			const key = `${home}/projects/${segs.slice(0, 3).join("/")}`;
			counter.set(key, (counter.get(key) ?? 0) + 1);
		}
	}
	let best: { key: string; count: number } | undefined;
	for (const [key, count] of counter) {
		if (best === undefined || count > best.count || (count === best.count && key.length > best.key.length)) {
			best = { key, count };
		}
	}
	return best?.key;
}

// ---------------------------------------------------------------------------

/** Decode a cursorDiskKV value (TEXT or BLOB) and parse its JSON. */
function readKvJson(v: string | Uint8Array | null | undefined): unknown {
	if (v === null || v === undefined) return undefined;
	const s = typeof v === "string" ? v : Buffer.from(v).toString("utf8");
	const trimmed = s.trim();
	if (trimmed.length === 0) return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

function isoOf(v: unknown): string | undefined {
	if (typeof v === "string" && v.length > 0) return v;
	if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
	return undefined;
}

function strOf(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
