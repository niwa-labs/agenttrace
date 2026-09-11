import { open, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { head } from "../jsonl.js";

/**
 * Kimi / Kimi Code session discovery.
 *
 * Two on-disk layouts share the same `wire.jsonl` log name:
 *
 * - kimi-code CLI: `~/.kimi-code/sessions/wd_<escaped-workdir>_<hash>/session_<uuid>/agents/<agent>/wire.jsonl`
 *   (`main` = top-level agent, `agent-N` = subagents). The `wd_*` dir name is an
 *   ambiguous escaping (path compressed to its possibly-truncated basename plus a
 *   hash), but the session `state.json` carries the exact `workDir` — read it when
 *   present and fall back to the decoded basename hint otherwise.
 * - kimi CLI: `~/.kimi/sessions/<workdir-hash>/<uuid>/wire.jsonl` (+ `subagents/<id>/wire.jsonl`).
 *   The `<hash>` dir is not reversible and neither `state.json` nor the metadata
 *   line records the workdir, so `workDir` stays unknown here (the parser sniffs
 *   `Working directory:` lines from turn payloads at parse time).
 */

export const DEFAULT_KIMI_CODE_SESSIONS_DIR = join(homedir(), ".kimi-code", "sessions");
export const DEFAULT_KIMI_SESSIONS_DIR = join(homedir(), ".kimi", "sessions");

export type KimiLayout = "kimi-code" | "kimi";

export interface KimiSessionRef {
	/** Absolute path to the wire.jsonl log. */
	logFile: string;
	/** Session uuid (`session_<uuid>` / `<uuid>` dir); subagents get `<uuid>/<agent>`. */
	sessionId: string;
	/** Which on-disk layout the file was found in. */
	layout: KimiLayout;
	role: "main" | "subagent";
	/** kimi-code agent directory name: `main`, `agent-2`, …. */
	agentName?: string;
	/** Wire protocol version from the metadata line, when sniffed (e.g. `"1.4"`). */
	protocolVersion?: string;
	/** Exact working directory when the layout records it (kimi-code `state.json`). */
	workDir?: string;
	/** Decoded basename hint from the `wd_<name>_<hash>` dir name (may be truncated). */
	workDirHint?: string;
	/** Best-effort ISO start sniffed from the first bytes (parse computes the exact value). */
	startedAt?: string;
	/** Best-effort ISO end sniffed from the last bytes (parse computes the exact value). */
	endedAt?: string;
}

/**
 * Discover kimi / kimi-code wire logs under both default roots (or explicit ones).
 *
 * When `rootDir` is given, refs are filtered to sessions whose workdir matches the
 * root (exact `workDir`, or the decoded basename hint for kimi-code layouts).
 * Sessions whose workdir is completely unknown (kimi layout) are always kept —
 * their logs carry no recoverable cwd, and silently dropping them would lose data;
 * they surface with `workDir: undefined` and land in the "unknown" project downstream.
 */
export async function discoverKimiSessions(
	rootDir?: string,
	kimiCodeDir: string = DEFAULT_KIMI_CODE_SESSIONS_DIR,
	kimiDir: string = DEFAULT_KIMI_SESSIONS_DIR,
): Promise<KimiSessionRef[]> {
	const refs: KimiSessionRef[] = [];
	await collectKimiCodeRefs(kimiCodeDir, refs);
	await collectKimiRefs(kimiDir, refs);
	const out: KimiSessionRef[] = [];
	const root = rootDir?.replace(/\/+$/, "");
	for (const ref of refs) {
		if (root !== undefined && root !== "" && !matchesRoot(ref, root)) continue;
		out.push(ref);
	}
	return out.sort((a, b) => a.logFile.localeCompare(b.logFile));
}

function matchesRoot(ref: KimiSessionRef, root: string): boolean {
	if (ref.workDir !== undefined) {
		return ref.workDir === root || ref.workDir.startsWith(`${root}/`);
	}
	// No exact workdir: fall back to the decoded basename hint; unknown → keep.
	return ref.workDirHint === undefined || ref.workDirHint === basename(root);
}

async function collectKimiCodeRefs(root: string, out: KimiSessionRef[]): Promise<void> {
	for (const wd of await safeReaddir(root)) {
		if (!wd.startsWith("wd_")) continue;
		const wdDir = join(root, wd);
		for (const session of await safeReaddir(wdDir)) {
			if (!session.startsWith("session_")) continue;
			const sessionDir = join(wdDir, session);
			const sessionId = session.slice("session_".length);
			const workDir = await sniffStateWorkDir(sessionDir);
			const hint = decodeWdDirName(wd);
			for (const agent of await safeReaddir(join(sessionDir, "agents"))) {
				const file = join(sessionDir, "agents", agent, "wire.jsonl");
				if (!(await isNonEmptyFile(file))) continue;
				out.push(await sniffRef({
					logFile: file,
					sessionId,
					layout: "kimi-code",
					role: agent === "main" ? "main" : "subagent",
					...(agent !== "main" ? { agentName: agent } : {}),
					...(workDir !== undefined ? { workDir } : {}),
					...(hint !== undefined ? { workDirHint: hint } : {}),
				}));
			}
		}
	}
}

async function collectKimiRefs(root: string, out: KimiSessionRef[]): Promise<void> {
	for (const hash of await safeReaddir(root)) {
		const hashDir = join(root, hash);
		for (const uuid of await safeReaddir(hashDir)) {
			const uuidDir = join(hashDir, uuid);
			if (await isNonEmptyFile(join(uuidDir, "wire.jsonl"))) {
				out.push(await sniffRef({
					logFile: join(uuidDir, "wire.jsonl"),
					sessionId: uuid,
					layout: "kimi",
					role: "main",
				}));
			}
			const subsDir = join(uuidDir, "subagents");
			for (const sub of await safeReaddir(subsDir)) {
				const file = join(subsDir, sub, "wire.jsonl");
				if (!(await isNonEmptyFile(file))) continue;
				out.push(await sniffRef({
					logFile: file,
					sessionId: `${uuid}/${sub}`,
					layout: "kimi",
					role: "subagent",
				}));
			}
		}
	}
}

/** Fill protocolVersion + best-effort started/ended stamps from the file edges. */
async function sniffRef(ref: KimiSessionRef): Promise<KimiSessionRef> {
	const [headText, tailText] = await Promise.all([head(ref.logFile, 4 * 1024), tail(ref.logFile, 4 * 1024)]);
	const version = /"protocol_version"\s*:\s*"([^"]+)"/.exec(headText)?.[1];
	const started = sniffFirstTimestamp(headText);
	const ended = sniffLastTimestamp(tailText);
	return {
		...ref,
		...(version !== undefined ? { protocolVersion: version } : {}),
		...(started !== undefined ? { startedAt: started } : {}),
		...(ended !== undefined ? { endedAt: ended } : {}),
	};
}

/** kimi-code: the session `state.json` records the exact `workDir`. */
async function sniffStateWorkDir(sessionDir: string): Promise<string | undefined> {
	let raw: string;
	try {
		raw = await readFile(join(sessionDir, "state.json"), "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const wd = parsed["workDir"];
		return typeof wd === "string" && wd.length > 0 ? wd : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Decode `wd_<escaped-workdir>_<hash>` into a basename hint. The escaping is lossy
 * (full path compressed to its possibly-truncated last segment plus a disambiguating
 * hash), e.g. `wd_niwa_6d9fbb7a2466` → workdir `…/niwa` — so this is a hint, not a path.
 */
export function decodeWdDirName(dirName: string): string | undefined {
	if (!dirName.startsWith("wd_")) return undefined;
	const body = dirName.slice("wd_".length).replace(/_[0-9a-f]{8,16}$/, "");
	return body.length > 0 ? body : undefined;
}

function sniffFirstTimestamp(text: string): string | undefined {
	const createdAt = /"created_at"\s*:\s*(\d{12,})/.exec(text);
	if (createdAt?.[1] !== undefined) return isoFromMs(Number(createdAt[1]));
	const ts = /"timestamp"\s*:\s*(\d+(?:\.\d+)?)/.exec(text)?.[1];
	return ts !== undefined ? isoFromSec(Number(ts)) : undefined;
}

function sniffLastTimestamp(text: string): string | undefined {
	let last: string | undefined;
	for (const m of text.matchAll(/"timestamp"\s*:\s*(\d+(?:\.\d+)?)|"time"\s*:\s*(\d{12,})/g)) {
		const sec = m[1];
		const ms = m[2];
		last = sec !== undefined ? isoFromSec(Number(sec)) : ms !== undefined ? isoFromMs(Number(ms)) : last;
	}
	return last;
}

function isoFromSec(sec: number): string | undefined {
	return Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : undefined;
}

function isoFromMs(ms: number): string | undefined {
	return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

async function isNonEmptyFile(file: string): Promise<boolean> {
	try {
		return (await stat(file)).size > 0;
	} catch {
		return false;
	}
}

async function safeReaddir(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

/** Read the last N bytes of a file as text (for cheap end-timestamp sniffing). */
async function tail(file: string, bytes: number): Promise<string> {
	const fh = await open(file, "r");
	try {
		const { size } = await fh.stat();
		const start = Math.max(0, size - bytes);
		const buf = Buffer.alloc(size - start);
		await fh.read(buf, 0, buf.length, start);
		return buf.toString("utf8");
	} finally {
		await fh.close();
	}
}
