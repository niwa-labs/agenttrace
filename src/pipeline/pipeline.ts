/**
 * pipeline orchestration:
 * logs → turns → windows → PASS-1 (streaming FAST, sidecar) → gate →
 * grouped form → PASS-2 (SMART) → trace + bank + metrics.
 */

import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import type { NormalizedSession, SourceKind } from "../model/session.js";
import { parseModelSpec, registerCustomModels, resolveModel, type Models, type AnyModel } from "../agent/models.js";
import { discoverClaudeSessions } from "../sources/claude/discover.js";
import { parseClaudeSession } from "../sources/claude/parse.js";
import { discoverCodexSessions } from "../sources/codex/discover.js";
import { parseCodexSession } from "../sources/codex/parse.js";
import { discoverPiSessions } from "../sources/pi/discover.js";
import { parsePiSession } from "../sources/pi/parse.js";
import { DEFAULT_SEGMENT_OPTIONS, packWindows, segmentTurns, type Turn } from "./turns.js";
import { anchorTurn, type TurnAnchors } from "./anchors.js";
import { sealFacts, renderFacts } from "./facts.js";
import { newFastAgent, runPass1Window, PASS1_SCHEMA_VERSION, PASS1_SYSTEM_PROMPT } from "./pass1.js";
import { readSidecar, readSidecarDigests, appendSidecar, blockKey, sliceHashOf, type SidecarRecord } from "./sidecar.js";
import { gateBlock } from "./gate.js";
import { renderGroupedTurns, type TurnFormInput, type DegradeLevel } from "./groupform.js";
import { runPass2, type Pass2Item } from "./pass2.js";
import type { Pass1Block, Pass1Digest } from "./contracts.js";
import { loadBank, mergeItems, saveBank } from "./bank.js";
import { computeMetrics } from "./metrics.js";
import { renderTrace } from "./render.js";
import { toTraceSessionRef } from "../base/trace-builder.js";

export interface RefineOptions {
	rootDir: string;
	outDir: string;
	sources: SourceKind[];
	fastModel: string;
	smartModel: string;
	baseUrl?: string;
	apiKey?: string;
	windowTokens: number;
	turnTokens: number;
	maxTraces?: number;
	only?: string;
}

export interface RefineReport {
	file: string;
	sessionId: string;
	turns: number;
	ratio: number;
	coverage: number;
	fallbacks: number;
	disputes: number;
	verdict?: string;
}

const PASS2_INPUT_TOKEN_BUDGET = 25_000;
const SESSION_CONCURRENCY = 2;

export async function runRefine(opts: RefineOptions): Promise<RefineReport[]> {
	const models = createModels();
	const smartSpec = parseModelSpec(opts.smartModel);
	const fastSpec = parseModelSpec(opts.fastModel);
	if (opts.baseUrl !== undefined) {
		registerCustomModels(models, opts.baseUrl, [smartSpec, fastSpec]);
	}
	const fast = resolveModel(opts.fastModel, models);
	const smart = resolveModel(opts.smartModel, models);

	const sessions = await discoverSessions(opts.rootDir, opts.sources, opts.only);
	const limited = opts.maxTraces !== undefined ? sessions.slice(0, opts.maxTraces) : sessions;

	await mkdir(opts.outDir, { recursive: true });
	const bankDir = join(opts.outDir, "bank");
	const bank = await loadBank(bankDir);
	const reports: RefineReport[] = [];
	const segOptions = { ...DEFAULT_SEGMENT_OPTIONS, windowBudgetTokens: opts.windowTokens, turnBudgetTokens: opts.turnTokens };

	// sessions run in a small pool; bank merge is deferred so workers never race
	const queue = [...limited];
	const collected: { session: NormalizedSession; items: Pass2Item[] }[] = [];
	const worker = async (): Promise<void> => {
		for (;;) {
			const session = queue.shift();
			if (session === undefined) return;
			const ctx: SessionCtx = {
				opts,
				models,
				fast: fast.model,
				smart: smart.model,
				segOptions,
				bankDir,
				collected,
			};
			reports.push(await refineSession(session, ctx));
		}
	};
	await Promise.all(Array.from({ length: Math.min(SESSION_CONCURRENCY, queue.length) }, worker));

	for (const { session, items } of collected) {
		mergeItems(
			bank,
			items,
			`${basename(session.logFile)}@${session.sessionId.slice(0, 8)}`,
			new Date().toISOString(),
		);
	}
	await saveBank(bankDir, bank);
	return reports;
}

// ---------------------------------------------------------------------------

interface SessionCtx {
	opts: RefineOptions;
	models: Models;
	fast: AnyModel;
	smart: AnyModel;
	segOptions: { windowBudgetTokens: number; turnBudgetTokens: number };
	bankDir: string;
	collected: { session: NormalizedSession; items: Pass2Item[] }[];
}

interface PassUsage {
	requests: number;
	inputTokens: number;
	outputTokens: number;
}

async function refineSession(session: NormalizedSession, ctx: SessionCtx): Promise<RefineReport> {
	const mainEntries = session.entries.filter((e) => !e.sidechain);
	const turns = segmentTurns(mainEntries, ctx.segOptions);
	const windows = packWindows(turns, ctx.segOptions);
	const promptHash = `p1v${PASS1_SCHEMA_VERSION}:${ctx.opts.fastModel}`;
	const sidecar = await readSidecar(session.logFile, promptHash);
	const records: SidecarRecord[] = [];

	// PASS-1: windows, streaming, incremental via sidecar
	const sidecarDigests = await readSidecarDigests(session.logFile, promptHash);
	let previousDigest: Pass1Digest | undefined;
	const usageFast: PassUsage = { requests: 0, inputTokens: 0, outputTokens: 0 };
	for (const window of windows) {
		if (previousDigest === undefined) {
			const known = sidecarDigests.get(window.index - 1);
			if (known !== undefined) previousDigest = known as Pass1Digest;
		}
		const pending: { turn: Turn; anchors: TurnAnchors; slice: string }[] = [];
		for (const turn of window.turns) {
			const sliceText = turn.entries
				.map((e) => e.kind + ":" + e.logLine + ":" + (e.kind === "assistant_thinking" || e.kind === "assistant_text" || e.kind === "user_text" ? e.text.length : 0))
				.join("|");
			const slice = sliceHashOf(sliceText);
			const key = blockKey(turn.fromLine, turn.toLine, slice);
			if (sidecar.has(key)) continue;
			pending.push({ turn, anchors: anchorTurn(turn), slice });
		}
		if (pending.length === 0) continue;

		const agent = newFastAgent({ fast: ctx.fast, models: ctx.models }, PASS1_SYSTEM_PROMPT);
		const result = await runPass1Window(
			agent,
			window,
			previousDigest,
			{ blocks: 0, retries: 0, fallbacks: 0, digests: 0, usage: usageFast },
			window.index === windows.length,
		);
		previousDigest = result.digest ?? previousDigest;

		for (const turnResult of result.turns) {
			const p = pending.find((x) => x.turn.index === turnResult.turnIndex);
			if (p === undefined) continue;
			records.push({
				type: "block",
				schemaVersion: PASS1_SCHEMA_VERSION,
				promptHash,
				sessionId: session.sessionId,
				logFile: session.logFile,
				fromLine: turnResult.fromLine,
				toLine: turnResult.toLine,
				sliceHash: p.slice,
				windowIndex: window.index,
				toolNames: p.turn.toolNames,
				tokens: p.turn.tokens,
				result: turnResult.result,
				retries: turnResult.retries,
				fallback: turnResult.fallback,
				ts: new Date().toISOString(),
			});
		}
		if (result.digest !== undefined) {
			records.push({
				type: "digest",
				schemaVersion: PASS1_SCHEMA_VERSION,
				promptHash,
				sessionId: session.sessionId,
				logFile: session.logFile,
				windowIndex: window.index,
				sliceHash: `${window.fromLine}:${window.toLine}`,
				digest: result.digest,
				ts: new Date().toISOString(),
			});
		}
		await appendSidecar(session.logFile, records.splice(0, records.length));
	}

	// reload sidecar: full coverage including previous runs
	const coverage = await readSidecar(session.logFile, promptHash);

	// GATE + grouped form
	const turnInputs: TurnFormInput[] = [];
	let disputes = 0;
	let quoteValid = 0;
	let fallbacks = 0;
	let retries = 0;
	let detOnly = 0;
	const thoughtsBySource = new Map<string, number>();
	const thoughtsByKind = new Map<string, number>();
	let factsFooter = "";

	for (const turn of turns) {
		const anchors = anchorTurn(turn);
		const sliceText = turn.entries
			.map((e) => e.kind + ":" + e.logLine + ":" + (e.kind === "assistant_thinking" || e.kind === "assistant_text" || e.kind === "user_text" ? e.text.length : 0))
			.join("|");
		const key = blockKey(turn.fromLine, turn.toLine, sliceHashOf(sliceText));
		const rec = coverage.get(key);
		const sealed = sealFacts(turn);

		if (rec === undefined || rec.type !== "block") {
			// never processed — deterministic floor keeps isomorphy
			turnInputs.push({
				turn,
				anchors,
				entries: turn.entries,
				block: {
					anchor: { fromLine: turn.fromLine, toLine: turn.toLine },
					action:
						turn.kind === "user"
							? `Пользователь: ${turn.entries[0]?.kind === "user_text" ? turn.entries[0].text.slice(0, 1200) : "..."}`
							: `Ход (${turn.toolNames.join(",") || "без вызовов"}) — не сжат моделью [det]`,
					thoughts: [],
				},
				disputes: [],
			});
			detOnly++;
			factsFooter += `b${turn.index} @L${turn.fromLine}–L${turn.toLine}: ${renderFacts(sealed)}\n`;
			continue;
		}
		const block = rec.result as Pass1Block;
		const gate = gateBlock(block, anchors, sealed);
		disputes += gate.disputes.length;
		if (gate.quoteValid && block.thoughts.some((t) => t.source !== "inferred")) quoteValid++;
		if (block.fallback === true) fallbacks++;
		retries += rec.retries;
		for (const t of block.thoughts) {
			thoughtsBySource.set(t.source, (thoughtsBySource.get(t.source) ?? 0) + 1);
			thoughtsByKind.set(t.kind, (thoughtsByKind.get(t.kind) ?? 0) + 1);
		}
		if (block.action.trim().length < 8) {
			console.warn(`warn: ${session.sessionId.slice(0, 8)} b${turn.index}: подозрительно короткий action от FAST — "${block.action}"`);
		}
		turnInputs.push({ turn, anchors, entries: turn.entries, block, disputes: gate.disputes });
		factsFooter += `b${turn.index} @L${turn.fromLine}–L${turn.toLine}: ${renderFacts(sealed)}${gate.disputes.length > 0 ? " [DISPUTED]" : ""}\n`;
	}

	// degrade the form until it fits the pass-2 budget (thoughts always kept)
	let groupedForm = renderGroupedTurns(turnInputs);
	let degradeLevel: DegradeLevel = 0;
	while (Math.ceil(groupedForm.length / 4) > PASS2_INPUT_TOKEN_BUDGET && degradeLevel < 2) {
		degradeLevel = (degradeLevel + 1) as DegradeLevel;
		groupedForm = renderGroupedTurns(turnInputs, degradeLevel);
	}

	// PASS-2
	const usageSmart: PassUsage = { requests: 0, inputTokens: 0, outputTokens: 0 };
	const pass2 = await runPass2(
		{
			smart: ctx.smart,
			models: ctx.models,
			allowedLogFiles: new Set([session.logFile]),
			readLogBudget: 12,
			usage: usageSmart,
		},
		session.sessionId,
		groupedForm,
		factsFooter,
	);

	// gate pass-2 arcs: anchors must exist in the session log
	if (pass2.output !== undefined) {
		const before = pass2.output.arcs.length;
		pass2.output.arcs = pass2.output.arcs.filter(
			(a) => Number.isFinite(a.fromLine) && a.fromLine >= 1 && a.fromLine <= session.logLines,
		);
		const dropped = before - pass2.output.arcs.length;
		if (dropped > 0) console.warn(`warn: ${session.sessionId.slice(0, 8)}: ${dropped} дуг отброшено (якорь вне лога)`);
	}

	// bank items are merged after all workers finish (no races)
	if (pass2.output !== undefined) {
		ctx.collected.push({ session, items: pass2.output.items });
	}

	// metrics + render
	// headline ratio is bytes-based (matches the "1MB → must be much smaller" bar);
	// real processed usage is reported separately in the accounting section
	const tokensOriginal = Math.ceil(session.logBytes / 4);
	if (pass2.output === undefined) {
		console.warn(`warn: pass-2 failed for ${session.sessionId}: ${pass2.lastError ?? "unknown"}`);
	}
	const groupedTokens = Math.ceil(groupedForm.length / 4);
	const metrics = computeMetrics({
		turns: { total: turns.length },
		blocks: {
			total: turns.length,
			fallbacks,
			retries,
			disputes,
			quoteValid,
			thoughtsBySource,
			thoughtsByKind,
		},
		detOnly,
		tokensOriginal,
		tokensCompressed: groupedTokens,
		readLogCalls: pass2.readLogCalls,
		pass2Retries: pass2.retries,
		usageFast,
		usageSmart,
	});

	const sessionRef = toTraceSessionRef(session);
	const md = renderTrace({
		sessions: [sessionRef],
		projectDir: session.cwd,
		groupedForm,
		pass2: pass2.output,
		metrics,
		generatedAt: new Date().toISOString(),
		models: { fast: ctx.opts.fastModel, smart: ctx.opts.smartModel },
	});
	const outName = `${session.startedAt.slice(0, 10)}-${session.sessionId.slice(0, 8)}.md`;
	await writeFile(join(ctx.opts.outDir, outName), md, "utf8");
	await appendFile(
		join(ctx.opts.outDir, "metrics.jsonl"),
		JSON.stringify({ ts: new Date().toISOString(), file: outName, sessionId: session.sessionId, fast: ctx.opts.fastModel, smart: ctx.opts.smartModel, ...metrics }) + "\n",
		"utf8",
	);

	return {
		file: outName,
		sessionId: session.sessionId,
		turns: turns.length,
		ratio: metrics.compressionRatio,
		coverage: metrics.coverage,
		fallbacks,
		disputes,
		...(pass2.output !== undefined ? { verdict: pass2.output.verdict.status } : {}),
	};
}

async function discoverSessions(rootDir: string, sources: SourceKind[], only?: string): Promise<NormalizedSession[]> {
	const files: { file: string; source: SourceKind }[] = [];
	if (sources.includes("claude")) {
		for (const f of await discoverClaudeSessions(rootDir)) files.push({ file: f, source: "claude" });
	}
	if (sources.includes("codex")) {
		for (const f of await discoverCodexSessions(rootDir)) files.push({ file: f, source: "codex" });
	}
	if (sources.includes("pi")) {
		for (const f of await discoverPiSessions(rootDir)) files.push({ file: f, source: "pi" });
	}
	const picked = only !== undefined ? files.filter((f) => f.file.includes(only)) : files;
	const sessions: NormalizedSession[] = [];
	for (const { file, source } of picked) {
		try {
			sessions.push(
				source === "claude"
					? await parseClaudeSession(file)
					: source === "codex"
						? await parseCodexSession(file)
						: await parsePiSession(file),
			);
		} catch (err) {
			console.warn(`warn: failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return sessions;
}
