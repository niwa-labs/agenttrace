import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readJsonl } from "../jsonl.js";

/**
 * Minimax Code (CLI `@minimax-ai/code`) stores sessions under
 * `~/.minimax/v2/sessions/<YYYY>/<MM>/<DD>/<HH-MM-SS-mmm>-session_<base64(mvs_id)>/`.
 * The canonical history is `messages.jsonl`; sibling files (`manifest.json`,
 * `history-catalog.json`, `user-message-locators.jsonl`, `snapshots/*.jsonl`)
 * are metadata, not session logs. The manifest carries the authoritative
 * sessionId (`mvs_…`) plus `createdAtMs`/`updatedAtMs`. The workspace the
 * session ran in is NOT in the manifest — it is announced inside the
 * `<agent-context>` preamble of the first user message
 * (`YOUR WORKSPACE DIRECTORY: …`).
 */
export const DEFAULT_MINIMAX_SESSIONS_DIR = join(homedir(), ".minimax", "v2", "sessions");

/** One discovered Minimax session log. */
export interface MinimaxSessionRef {
	/** Absolute path to the `messages.jsonl` canonical history. */
	file: string;
	/** From manifest.json; falls back to the decoded dir-name suffix. */
	sessionId: string;
	/** manifest `createdAtMs` → ISO, "" when the manifest is missing. */
	startedAt: string;
	/** manifest `updatedAtMs` → ISO, "" when the manifest is missing. */
	endedAt: string;
	/** Workspace from the first user message's `<agent-context>`, when present. */
	projectDir?: string;
}

/** Recursively find Minimax session logs (`messages.jsonl`) under `sessionsDir`. */
export async function discoverMinimaxSessions(
	sessionsDir: string = DEFAULT_MINIMAX_SESSIONS_DIR,
): Promise<MinimaxSessionRef[]> {
	const refs: MinimaxSessionRef[] = [];
	await walk(sessionsDir, refs);
	return refs.sort((a, b) => a.file.localeCompare(b.file));
}

async function walk(dir: string, out: MinimaxSessionRef[]): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const ent of entries) {
		const path = join(dir, ent.name);
		if (ent.isDirectory()) {
			await walk(path, out);
		} else if (ent.isFile() && ent.name === "messages.jsonl") {
			out.push(await inspectSessionDir(dir, path));
		}
	}
}

/** Manifest fields with dir-name fallbacks for a single session directory. */
async function inspectSessionDir(dir: string, file: string): Promise<MinimaxSessionRef> {
	let sessionId = sessionIdFromDirName(dir);
	let startedAt = "";
	let endedAt = "";
	try {
		const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Record<
			string,
			unknown
		>;
		const id = manifest["sessionId"];
		if (typeof id === "string" && id.length > 0) sessionId = id;
		startedAt = msToIso(manifest["createdAtMs"]);
		endedAt = msToIso(manifest["updatedAtMs"]);
	} catch {
		// no/unreadable manifest — keep dir-name id, empty timestamps
	}
	const projectDir = await sniffWorkspace(file);
	return {
		file,
		sessionId,
		startedAt,
		endedAt,
		...(projectDir !== undefined ? { projectDir } : {}),
	};
}

/**
 * Session id from the directory name `<HH-MM-SS-mmm>-session_<base64(mvs_id)>`.
 * Decodes the base64 suffix (validated printable); falls back to the raw
 * suffix, then to the bare directory name.
 */
export function sessionIdFromDirName(dir: string): string {
	const base = basename(dir);
	const marker = "-session_";
	const idx = base.lastIndexOf(marker);
	const encoded = idx >= 0 ? base.slice(idx + marker.length) : "";
	if (encoded.length === 0) return base;
	const decoded = Buffer.from(encoded, "base64").toString("utf8");
	return /^[\x20-\x7e]+$/.test(decoded) ? decoded : encoded;
}

const WORKSPACE_RE = /YOUR WORKSPACE DIRECTORY:[ \t]*(.+)/;

/**
 * Extract the workspace directory from the FIRST user message of the log
 * (streamed — the `<agent-context>` preamble can be long). Returns undefined
 * when the first user message carries no `YOUR WORKSPACE DIRECTORY` line.
 */
export async function sniffWorkspace(file: string): Promise<string | undefined> {
	for await (const { value } of await readJsonl(file)) {
		if (value === undefined || typeof value !== "object") continue;
		const msg = asRecord((value as Record<string, unknown>)["message"]);
		if (msg === undefined || msg["role"] !== "user") continue;
		const m = WORKSPACE_RE.exec(userTextOf(msg["content"]));
		if (m === null) return undefined;
		const ws = m[1]?.trim();
		return ws !== undefined && ws.length > 0 ? ws : undefined;
	}
	return undefined;
}

/** Epoch milliseconds → ISO string; "" for anything that is not a finite number. */
export function msToIso(v: unknown): string {
	return typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : "";
}

function userTextOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((b) => {
			const r = asRecord(b);
			return r !== undefined && typeof r["text"] === "string" ? r["text"] : "";
		})
		.join("\n");
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: undefined;
}
