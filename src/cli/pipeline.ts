/**
 * Distill pipeline: discover → parse → group/chain → render → write traces.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverClaudeSessions, DEFAULT_CLAUDE_PROJECTS_DIR } from "../sources/claude/discover.js";
import { parseClaudeSession } from "../sources/claude/parse.js";
import { discoverCodexSessions } from "../sources/codex/discover.js";
import { parseCodexSession } from "../sources/codex/parse.js";
import { discoverPiSessions, DEFAULT_PI_SESSIONS_DIR } from "../sources/pi/discover.js";
import { parsePiSession } from "../sources/pi/parse.js";
import { discoverQwenSessions } from "../sources/qwen/discover.js";
import { parseQwenSession } from "../sources/qwen/parse.js";
import { discoverKimiSessions } from "../sources/kimi/discover.js";
import { parseKimiSession } from "../sources/kimi/parse.js";
import { distill, DEFAULT_DISTILL_OPTIONS } from "../base/trace-builder.js";
import type { ChainOptions } from "../base/chain.js";
import { renderTraceMd } from "../base/render-md.js";
import { traceFileName } from "../base/naming.js";
import { toRepoBound } from "../work/repobound.js";
import type { NormalizedSession, SourceKind } from "../model/session.js";

export interface DistillRunOptions {
	rootDir: string;
	outDir: string;
	sources: SourceKind[];
	chain: ChainOptions;
	/** substring filter on log path, applied before parsing (mirrors refine) */
	only?: string;
	/** Render the repo-bound flavor (no `@L` anchors, no absolute private paths) — committable to a repository. */
	repoBound?: boolean;
	/** overrides for tests / non-default install locations */
	claudeProjectsDir?: string;
	piSessionsDir?: string;
}

export interface TraceReportEntry {
	file: string;
	kind: string;
	sessions: number;
	toolCalls: number;
	tokensOriginal: number;
	tokensTrace: number;
	ratio: number;
	verdict: string;
}

export interface DistillReport {
	rootDir: string;
	outDir: string;
	logsScanned: number;
	logsParsed: number;
	traces: TraceReportEntry[];
}

export async function runDistill(opts: DistillRunOptions): Promise<DistillReport> {
	const logFiles: { file: string; source: SourceKind }[] = [];
	if (opts.sources.includes("claude")) {
		for (const f of await discoverClaudeSessions(opts.rootDir, opts.claudeProjectsDir ?? DEFAULT_CLAUDE_PROJECTS_DIR))
			logFiles.push({ file: f, source: "claude" });
	}
	if (opts.sources.includes("codex")) {
		for (const f of await discoverCodexSessions(opts.rootDir)) logFiles.push({ file: f, source: "codex" });
	}
	if (opts.sources.includes("pi")) {
		for (const f of await discoverPiSessions(opts.rootDir, opts.piSessionsDir ?? DEFAULT_PI_SESSIONS_DIR))
			logFiles.push({ file: f, source: "pi" });
	}
	if (opts.sources.includes("qwen")) {
		for (const f of await discoverQwenSessions(opts.rootDir)) logFiles.push({ file: f, source: "qwen" });
	}
	if (opts.sources.includes("kimi")) {
		for (const f of await discoverKimiSessions(opts.rootDir)) logFiles.push({ file: f.logFile, source: "kimi" });
	}
	const only = opts.only;
	const picked = only !== undefined ? logFiles.filter((f) => f.file.includes(only)) : logFiles;

	const sessions: NormalizedSession[] = [];
	for (const { file, source } of picked) {
		try {
			sessions.push(
				source === "claude"
					? await parseClaudeSession(file)
					: source === "codex"
						? await parseCodexSession(file)
						: source === "qwen"
							? await parseQwenSession(file)
							: source === "kimi"
								? await parseKimiSession(file)
								: await parsePiSession(file),
			);
		} catch (err) {
			console.warn(`warn: failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const traces = distill(sessions, {
		projectDir: opts.rootDir,
		chain: opts.chain,
	});

	await mkdir(opts.outDir, { recursive: true });
	const report: TraceReportEntry[] = [];
	const usedNames = new Set<string>();
	for (const trace of traces) {
		const rendered = renderTraceMd(trace);
		const md = opts.repoBound === true ? toRepoBound(rendered, opts.rootDir) : rendered;
		const base = traceFileName(trace.sessions, trace.sessions[0]?.title);
		// distinct traces can produce the same name (same day, same slug) — keep both
		let name = base;
		let n = 2;
		while (usedNames.has(name)) {
			name = base.replace(/\.md$/, `-${n}.md`);
			n++;
		}
		usedNames.add(name);
		const file = join(opts.outDir, name);
		await writeFile(file, md, "utf8");
		report.push({
			file,
			kind: trace.meta.kind,
			sessions: trace.sessions.length,
			toolCalls: trace.meta.stats.toolCalls,
			tokensOriginal: trace.meta.stats.approxTokensOriginal,
			tokensTrace: trace.meta.stats.approxTokensTrace,
			ratio: trace.meta.stats.compressionRatio,
			verdict: trace.meta.verdict.status,
		});
	}

	return {
		rootDir: opts.rootDir,
		outDir: opts.outDir,
		logsScanned: picked.length,
		logsParsed: sessions.length,
		traces: report,
	};
}

export const RUN_DEFAULTS = DEFAULT_DISTILL_OPTIONS;
