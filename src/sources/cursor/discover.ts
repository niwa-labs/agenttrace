import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CursorLogMeta } from "./types.js";

/**
 * Discovery over the export directory: pairs each `*.meta.json` with its
 * `<id>.jsonl` log. Meta files without a log (interrupted export) are skipped.
 */
export async function listCursorLogs(outDir: string): Promise<{ file: string; meta: CursorLogMeta }[]> {
	const out: { file: string; meta: CursorLogMeta }[] = [];
	let names: string[];
	try {
		names = await readdir(outDir);
	} catch {
		return out;
	}
	for (const name of names) {
		if (!name.endsWith(".meta.json")) continue;
		const metaPath = join(outDir, name);
		const logPath = join(outDir, name.slice(0, -".meta.json".length) + ".jsonl");
		try {
			await stat(logPath);
		} catch {
			continue;
		}
		try {
			const meta = JSON.parse(await readFile(metaPath, "utf8")) as CursorLogMeta;
			// widened to unknown so a hand-edited meta with a bogus source is rejected, not narrowed away
			const source: unknown = meta.source;
			if (typeof meta.sessionId !== "string" || (source !== "cursor-ide" && source !== "cursor-agent")) {
				console.warn(`cursor: skipping malformed meta ${metaPath}`);
				continue;
			}
			out.push({ file: logPath, meta });
		} catch (e) {
			console.warn(`cursor: failed to read meta ${metaPath}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return out.sort((a, b) => a.file.localeCompare(b.file));
}
