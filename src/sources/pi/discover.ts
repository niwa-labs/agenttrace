import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { head } from "../jsonl.js";

/**
 * pi sessions live at `~/.pi/agent/sessions/--<escaped-cwd>--/<ts>_<id>.jsonl`.
 * The dir name is an ambiguous escaping; the truth is the `cwd` field of the
 * leading `session` entry — sniff it from the first bytes.
 */
export const DEFAULT_PI_SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/;

export async function discoverPiSessions(
	rootDir: string,
	sessionsDir: string = DEFAULT_PI_SESSIONS_DIR,
): Promise<string[]> {
	const normalizedRoot = rootDir.replace(/\/+$/, "");
	const files: string[] = [];
	let dirs: string[];
	try {
		dirs = await readdir(sessionsDir);
	} catch {
		return files;
	}
	for (const dir of dirs) {
		if (!dir.startsWith("--") || !dir.endsWith("--")) continue;
		let names: string[];
		try {
			names = await readdir(join(sessionsDir, dir));
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const file = join(sessionsDir, dir, name);
			const cwd = await sniffPiCwd(file);
			if (cwd !== undefined && (cwd === normalizedRoot || cwd.startsWith(`${normalizedRoot}/`))) {
				files.push(file);
			}
		}
	}
	return files.sort();
}

export async function sniffPiCwd(file: string): Promise<string | undefined> {
	const text = await head(file, 4 * 1024);
	if (!text.includes('"type":"session"')) return undefined;
	const m = CWD_RE.exec(text);
	if (!m) return undefined;
	try {
		return JSON.parse(`"${m[1]}"`) as string;
	} catch {
		return undefined;
	}
}
