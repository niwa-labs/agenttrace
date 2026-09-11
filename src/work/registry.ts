/**
 * Session registry: `<stateDir>/sessions.jsonl`.
 *
 * An inventory of every log we plan to distill, one line per log file, each
 * already assigned to a project (derived from the session cwd / Cursor
 * workspace). The inventory is cheap (stat + cursor meta files only); the
 * expensive per-session metadata (cwd sniffing, line counts) is filled in by
 * the deterministic skeleton step (`det.ts`), which parses each log once.
 */

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { basename } from "node:path";
import { slugify } from "../base/naming.js";
import type { SourceKind } from "../model/session.js";
import type { CursorLogMeta } from "../sources/cursor/types.js";
import { discoverQwenLogs } from "../sources/qwen/discover.js";
import { listCursorLogs } from "../sources/cursor/discover.js";
import type { WorkPaths, WorkState } from "./state.js";

export interface SessionRecord {
	sessionId: string;
	source: SourceKind;
	logFile: string;
	logBytes: number;
	logMtimeMs: number;
	/** filled by det step */
	logLines?: number;
	projectDir?: string;
	project?: string;
	startedAt?: string;
	endedAt?: string;
	title?: string;
	role?: "main" | "subagent";
	/** cursor logs carry their export meta (workspace, title, timestamps) */
	cursorMeta?: CursorLogMeta;
}

/** Stable work-layer session id: hash of the absolute log path. */
export function sessionIdOf(logFile: string): string {
	return createHash("sha256").update(logFile).digest("hex").slice(0, 16);
}

export function projectSlugOf(projectDir: string | undefined): string {
	if (projectDir === undefined || projectDir.trim().length === 0) return "unknown";
	return slugify(basename(projectDir), 50);
}

export async function writeRegistry(paths: WorkPaths, records: SessionRecord[]): Promise<void> {
	await writeFile(paths.registryFile, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

export async function readRegistry(paths: WorkPaths): Promise<SessionRecord[]> {
	const out: SessionRecord[] = [];
	let raw: string;
	try {
		raw = await readFile(paths.registryFile, "utf8");
	} catch {
		return out;
	}
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			out.push(JSON.parse(line) as SessionRecord);
		} catch {
			// torn tail — skip
		}
	}
	return out;
}

/** Walk a root recursively and return every *.jsonl that is not a sidecar. */
export async function listJsonlLogs(root: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return;
		}
		for (const name of names.sort()) {
			const full = join(dir, name);
			let s;
			try {
				s = await stat(full);
			} catch {
				continue;
			}
			if (s.isDirectory()) {
				if (name === "node_modules" || name === ".git") continue;
				await walk(full);
			} else if (name.endsWith(".jsonl") && !name.endsWith(".pass1.jsonl") && s.size > 0) {
				out.push(full);
			}
		}
	};
	await walk(root);
	return out;
}

/** Build the inventory from configured roots + cursor export dirs (resumable). */
export async function inventorySessions(paths: WorkPaths, state: WorkState): Promise<SessionRecord[]> {
	const byFile = new Map<string, SessionRecord>();
	const add = (source: SourceKind, file: string, cursorMeta?: CursorLogMeta): void => {
		const key = file;
		if (byFile.has(key)) return;
		let bytes = 0;
		let mtimeMs = 0;
		try {
			const s = statSync(file);
			bytes = s.size;
			mtimeMs = s.mtimeMs;
		} catch {
			return;
		}
		byFile.set(key, {
			sessionId: sessionIdOf(file),
			source,
			logFile: file,
			logBytes: bytes,
			logMtimeMs: mtimeMs,
			...(cursorMeta !== undefined ? { cursorMeta } : {}),
		});
	};

	for (const root of state.roots.claude) for (const f of await listJsonlLogs(root)) add("claude", f);
	for (const root of state.roots.codex) for (const f of await listJsonlLogs(root)) add("codex", f);
	for (const root of state.roots.pi) for (const f of await listJsonlLogs(root)) add("pi", f);
	for (const root of state.roots.qwen ?? []) for (const f of await discoverQwenLogs(root)) add("qwen", f);
	if (state.cursorIde !== null) {
		for (const { file, meta } of await listCursorLogs(join(paths.stateDir, state.cursorIde.out))) {
			add("cursor-ide", file, meta);
		}
	}
	if (state.cursorAgent !== null) {
		for (const { file, meta } of await listCursorLogs(join(paths.stateDir, state.cursorAgent.out))) {
			add("cursor-agent", file, meta);
		}
	}
	return [...byFile.values()].sort((a, b) => a.logFile.localeCompare(b.logFile));
}

/** Read registry if present, else rebuild it from roots. */
export async function ensureRegistry(paths: WorkPaths, state: WorkState): Promise<SessionRecord[]> {
	const existing = await readRegistry(paths);
	if (existing.length > 0) return existing;
	const records = await inventorySessions(paths, state);
	await writeRegistry(paths, records);
	return records;
}
