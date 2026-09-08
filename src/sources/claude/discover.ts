import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

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
	let noCwd = 0;
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
			else if (cwd === undefined) noCwd++;
		}
	}
	if (noCwd > 0) {
		console.warn(`warn: ${noCwd} claude session logs had no cwd field and were skipped`);
	}
	return files.sort();
}

function normalizeDir(p: string): string {
	return p.replace(/\/+$/, "");
}

function isUnder(cwd: string, root: string): boolean {
	return cwd === root || cwd.startsWith(`${root}/`);
}

/**
 * Extract the cwd from the first record that carries one, streaming the file
 * line by line: some sessions open with a long service preamble (hooks,
 * queued tool uses) that pushes `cwd` far beyond any fixed byte window.
 */
export async function sniffCwd(file: string): Promise<string | undefined> {
	const rl = createInterface({
		input: createReadStream(file, { encoding: "utf8" }),
		crlfDelay: Infinity,
	});
	try {
		for await (const line of rl) {
			if (!line.includes('"cwd"')) continue;
			const m = CWD_RE.exec(line);
			if (!m) continue;
			try {
				return JSON.parse(`"${m[1]}"`) as string;
			} catch {
				return undefined;
			}
		}
	} finally {
		rl.close();
	}
	return undefined;
}
