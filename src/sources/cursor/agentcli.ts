import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CursorExportReport, CursorLogLine, CursorLogMeta, DatabaseSyncOptionsRO } from "./types.js";

/**
 * Export cursor-agent CLI chats from `~/.cursor/chats/<wsHash>/<chatId>/store.db`.
 *
 * Layout:
 *  - `meta(key, value)` — `value` for key '0' is HEX-encoded JSON with createdAt (epoch ms).
 *  - `blobs(id, data)` — `data` is utf8 JSON: either {role, content} or {messages: [...]}.
 *    Non-JSON blobs (protobuf remnants) are skipped.
 *
 * The store may be open by a running cursor-agent — it is opened read-only and
 * never written to.
 */

const DEFAULT_WORKSPACE_STORAGE_DIR = join(
	homedir(),
	"Library",
	"Application Support",
	"Cursor",
	"User",
	"workspaceStorage",
);

const WS_PATH_RE = /Workspace Path:\s*(.+)/;

interface AgentMessage {
	role?: unknown;
	content?: unknown;
	thinking?: unknown;
	messages?: unknown;
}

interface KvRow {
	value?: string | Uint8Array | null;
}

interface BlobRow {
	rowid: number | bigint;
	data: string | Uint8Array | null;
}

export async function exportCursorAgentSessions(
	chatsRoot: string,
	outDir: string,
	opts?: { workspaceStorageDir?: string },
): Promise<CursorExportReport> {
	const report: CursorExportReport = { exported: 0, skipped: 0, noBubbles: 0, errors: [] };
	const workspaceStorageDir = opts?.workspaceStorageDir ?? DEFAULT_WORKSPACE_STORAGE_DIR;
	await mkdir(outDir, { recursive: true });

	let wsHashes: string[];
	try {
		wsHashes = await readdir(chatsRoot);
	} catch (e) {
		report.errors.push(`readdir ${chatsRoot}: ${e instanceof Error ? e.message : String(e)}`);
		return report;
	}

	let processed = 0;
	for (const wsHash of wsHashes) {
		let chatIds: string[];
		try {
			chatIds = await readdir(join(chatsRoot, wsHash));
		} catch {
			continue;
		}
		for (const chatId of chatIds) {
			const dbPath = join(chatsRoot, wsHash, chatId, "store.db");
			try {
				if (!(await isFile(dbPath))) continue;
				processed++;
				const logPath = join(outDir, `${wsHash}-${chatId}.jsonl`);
				if (await isFile(logPath)) {
					report.skipped++;
					continue;
				}
				const mtimeMs = (await stat(dbPath)).mtimeMs;

				// readOnly is not in @types/node 22.10 DatabaseSyncOptions but is supported at runtime
				const roOpts: DatabaseSyncOptionsRO = { readOnly: true };
				const db = new DatabaseSync(dbPath, roOpts);
				let lines: CursorLogLine[];
				let createdAtMs: number | undefined;
				let title: string | undefined;
				try {
					const chatMeta = readMetaRecord(db);
					createdAtMs = numOf(chatMeta?.["createdAt"]);
					const name = chatMeta?.["name"];
					if (typeof name === "string" && name.length > 0) title = name;
					lines = [];
					const blobRows = db.prepare("SELECT rowid, data FROM blobs ORDER BY rowid").all() as BlobRow[];
					for (const row of blobRows) {
						const bid = String(row.rowid);
						appendBlobLines(row.data, bid, lines);
					}
					if (lines.length < 1) {
						report.noBubbles++;
						continue;
					}
				} finally {
					db.close();
				}

				const createdAt = isoOf(createdAtMs) ?? new Date(mtimeMs).toISOString();
				const meta: CursorLogMeta = {
					sessionId: `${wsHash}-${chatId}`,
					source: "cursor-agent",
					msgCount: lines.length,
					createdAt,
					lastUpdatedAt: new Date(mtimeMs).toISOString(),
				};
				if (title) meta.title = title;
				const wsPath = await detectWorkspacePath(workspaceStorageDir, wsHash, lines);
				if (wsPath) meta.workspacePath = wsPath;

				const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
				await writeFile(logPath, body, "utf8");
				await writeFile(
					join(outDir, `${wsHash}-${chatId}.meta.json`),
					JSON.stringify(meta, null, "\t") + "\n",
					"utf8",
				);
				report.exported++;
			} catch (e) {
				report.errors.push(`chat ${wsHash}-${chatId}: ${e instanceof Error ? e.message : String(e)}`);
			}
			if (processed % 100 === 0) {
				console.error(`cursor-agent: ${processed} exported=${report.exported} skipped=${report.skipped} noBubbles=${report.noBubbles}`);
			}
		}
	}
	return report;
}

// ---------------------------------------------------------------------------

function readMetaRecord(db: InstanceType<typeof DatabaseSync>): Record<string, unknown> | undefined {
	const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as KvRow | undefined;
	return parseMetaValue(row?.value);
}

/** meta value: HEX-encoded JSON for key '0' (plain JSON tolerated too). */
function parseMetaValue(v: string | Uint8Array | null | undefined): Record<string, unknown> | undefined {
	if (v === null || v === undefined) return undefined;
	let s = typeof v === "string" ? v : Buffer.from(v).toString("utf8");
	s = s.trim();
	if (s.length === 0) return undefined;
	if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
		try {
			return JSON.parse(Buffer.from(s, "hex").toString("utf8")) as Record<string, unknown>;
		} catch {
			// fall through to plain JSON
		}
	}
	try {
		return JSON.parse(s) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** Flatten one blobs row into log lines (handles {role,content} and {messages:[...]}). */
function appendBlobLines(data: unknown, bid: string, out: CursorLogLine[]): void {
	if (data === null || data === undefined) return;
	const s = (typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8")).trim();
	if (!s.startsWith("{")) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(s) as unknown;
	} catch {
		return;
	}
	appendMessages(parsed, bid, out, 0);
}

function appendMessages(value: unknown, bid: string, out: CursorLogLine[], depth: number): void {
	if (depth > 8 || typeof value !== "object" || value === null) return;
	const msg = value as AgentMessage;
	if (Array.isArray(msg.messages)) {
		for (const m of msg.messages) appendMessages(m, bid, out, depth + 1);
		return;
	}
	if (msg.role !== "user" && msg.role !== "assistant") return;
	const ts = ""; // per-message timestamps do not exist in this format
	const text = flattenContent(msg.content);
	if (msg.role === "user") {
		if (text.trim().length === 0) return;
		out.push({ kind: "user_text", text, ts, bid });
		return;
	}
	const thinking = flattenContent(msg.thinking);
	if (thinking.trim().length > 0) out.push({ kind: "assistant_thinking", text: thinking, ts, bid });
	if (text.trim().length > 0) out.push({ kind: "assistant_text", text, ts, bid });
}

/** content: string, or an array of blocks whose `text` fields are joined with "\n". */
function flattenContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block === "string") return block;
			if (typeof block === "object" && block !== null && "text" in block) {
				const t = (block as Record<string, unknown>)["text"];
				return typeof t === "string" ? t : "";
			}
			return "";
		})
		.filter((s) => s.length > 0)
		.join("\n");
}

async function detectWorkspacePath(
	workspaceStorageDir: string,
	wsHash: string,
	lines: CursorLogLine[],
): Promise<string | undefined> {
	try {
		const raw = await readFile(join(workspaceStorageDir, wsHash, "workspace.json"), "utf8");
		const j = JSON.parse(raw) as Record<string, unknown>;
		const folder = j["folder"];
		if (typeof folder === "string" && folder.startsWith("file://")) return folder.slice("file://".length);
		if (typeof folder === "string" && folder.length > 0) return folder;
	} catch {
		// fall back to the in-text heuristic
	}
	for (const line of lines) {
		if (line.kind !== "user_text") continue;
		const m = WS_PATH_RE.exec(line.text);
		if (m?.[1]) return m[1].trim();
	}
	return undefined;
}

function isoOf(v: number | undefined): string | undefined {
	return v !== undefined && Number.isFinite(v) ? new Date(v).toISOString() : undefined;
}

function numOf(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}
