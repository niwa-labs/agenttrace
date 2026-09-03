import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { head } from "../jsonl.js";

/**
 * Claude Code stores sessions as `~/.claude/projects/<escaped-cwd>/<uuid>.jsonl`.
 * The directory name is the cwd with every non-alphanumeric char escaped to `-`,
 * which is ambiguous (dashes in real paths) — so discovery trusts the `cwd`
 * field inside the log, not the directory name.
 */
export const DEFAULT_CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/;

/** Find Claude session logs whose cwd equals `rootDir` or lies beneath it. */
export async function discoverClaudeSessions(
	rootDir: string,
	projectsDir: string = DEFAULT_CLAUDE_PROJECTS_DIR,
): Promise<string[]> {
	const normalizedRoot = normalizeDir(rootDir);
	const files: string[] = [];
	let projectDirs: string[];
	try {
		projectDirs = await readdir(projectsDir);
	} catch {
		return files;
	}
	for (const dir of projectDirs) {
		let names: string[];
		try {
			names = await readdir(join(projectsDir, dir));
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const file = join(projectsDir, dir, name);
			const cwd = await sniffCwd(file);
			if (cwd !== undefined && isUnder(cwd, normalizedRoot)) files.push(file);
		}
	}
	return files.sort();
}

function normalizeDir(p: string): string {
	return p.replace(/\/+$/, "");
}

function isUnder(cwd: string, root: string): boolean {
	return cwd === root || cwd.startsWith(`${root}/`);
}

/** Extract the cwd from the first lines of a session log without full parse. */
export async function sniffCwd(file: string): Promise<string | undefined> {
	const text = await head(file, 8 * 1024);
	const m = CWD_RE.exec(text);
	if (!m) return undefined;
	try {
		return JSON.parse(`"${m[1]}"`) as string;
	} catch {
		return undefined;
	}
}
