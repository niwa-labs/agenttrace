import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { head } from "../jsonl.js";

/**
 * Codex CLI stores rollouts as
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`; the cwd lives in
 * the `session_meta` first line, so discovery sniffs it there.
 */
export const DEFAULT_CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");

const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/;

export async function discoverCodexSessions(
	rootDir: string,
	sessionsDir: string = DEFAULT_CODEX_SESSIONS_DIR,
): Promise<string[]> {
	const normalizedRoot = rootDir.replace(/\/+$/, "");
	const files: string[] = [];
	let yearDirs: string[];
	try {
		yearDirs = await readdir(sessionsDir);
	} catch {
		return files;
	}
	for (const year of yearDirs) {
		for (const month of await safeReaddir(join(sessionsDir, year))) {
			for (const day of await safeReaddir(join(sessionsDir, year, month))) {
				for (const name of await safeReaddir(join(sessionsDir, year, month, day))) {
					if (!name.endsWith(".jsonl")) continue;
					const file = join(sessionsDir, year, month, day, name);
					const cwd = await sniffCodexCwd(file);
					if (cwd !== undefined && (cwd === normalizedRoot || cwd.startsWith(`${normalizedRoot}/`))) {
						files.push(file);
					}
				}
			}
		}
	}
	return files.sort();
}

async function safeReaddir(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

export async function sniffCodexCwd(file: string): Promise<string | undefined> {
	const text = await head(file, 8 * 1024);
	const m = CWD_RE.exec(text);
	if (!m) return undefined;
	try {
		return JSON.parse(`"${m[1]}"`) as string;
	} catch {
		return undefined;
	}
}
