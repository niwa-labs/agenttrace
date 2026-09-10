/**
 * Work-server state: `<stateDir>/state.json` + well-known paths.
 *
 * The state dir is the whole runnable universe of an agent-driven distill
 * run: session registry, deterministic skeletons, job payloads, ledger,
 * accepted pass-2 results, final traces, bank, metrics.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SourceKind } from "../model/session.js";

export const WORK_SCHEMA_VERSION = 1;

export const PASS1_AGENT_PROMPT_HASH = "p1v3:agent";

export interface WorkState {
	schemaVersion: number;
	createdAt: string;
	/** log roots to inventory (each is a `<kind>-projects`-style dir) */
	roots: { claude: string[]; codex: string[]; pi: string[] };
	cursorIde: { db: string; out: string } | null;
	cursorAgent: { chatsRoot: string; workspaceStorageDir: string; out: string } | null;
	segOptions: { turnBudgetTokens: number; windowBudgetTokens: number };
	pass2InputTokenBudget: number;
	pass1PromptHash: string;
	leaseMinutes: number;
}

export function defaultState(stateDir: string, now = new Date().toISOString()): WorkState {
	return {
		schemaVersion: WORK_SCHEMA_VERSION,
		createdAt: now,
		roots: { claude: [], codex: [], pi: [] },
		cursorIde: null,
		cursorAgent: null,
		segOptions: { turnBudgetTokens: 8_000, windowBudgetTokens: 40_000 },
		pass2InputTokenBudget: 25_000,
		pass1PromptHash: PASS1_AGENT_PROMPT_HASH,
		leaseMinutes: 45,
	};
}

export interface WorkPaths {
	stateDir: string;
	stateFile: string;
	ledgerFile: string;
	registryFile: string;
	jobsIndexFile: string;
	detDir: string;
	jobsDir: string;
	resultsDir: string;
	tracesDir: string;
	tracesRepoDir: string;
	bankDir: string;
	metricsFile: string;
}

export function workPaths(stateDir: string): WorkPaths {
	return {
		stateDir,
		stateFile: join(stateDir, "state.json"),
		ledgerFile: join(stateDir, "ledger.jsonl"),
		registryFile: join(stateDir, "sessions.jsonl"),
		jobsIndexFile: join(stateDir, "jobs-index.jsonl"),
		detDir: join(stateDir, "det"),
		jobsDir: join(stateDir, "jobs"),
		resultsDir: join(stateDir, "results"),
		tracesDir: join(stateDir, "traces"),
		tracesRepoDir: join(stateDir, "traces-repo", "traces"),
		bankDir: join(stateDir, "bank"),
		metricsFile: join(stateDir, "metrics.jsonl"),
	};
}

export async function saveState(paths: WorkPaths, state: WorkState): Promise<void> {
	await mkdir(dirname(paths.stateFile), { recursive: true });
	await writeFile(paths.stateFile, JSON.stringify(state, null, "\t"), "utf8");
}

export async function loadState(paths: WorkPaths): Promise<WorkState> {
	const raw = await readFile(paths.stateFile, "utf8");
	const state = JSON.parse(raw) as WorkState;
	if (state.schemaVersion !== WORK_SCHEMA_VERSION) {
		throw new Error(`state schema ${String(state.schemaVersion)} != ${WORK_SCHEMA_VERSION} — rerun "work init"`);
	}
	return state;
}

/** Sources enabled in this run (cursor kinds map to exported logs). */
export function enabledSources(state: WorkState): SourceKind[] {
	const out: SourceKind[] = [];
	if (state.roots.claude.length > 0) out.push("claude");
	if (state.roots.codex.length > 0) out.push("codex");
	if (state.roots.pi.length > 0) out.push("pi");
	if (state.cursorIde !== null) out.push("cursor-ide");
	if (state.cursorAgent !== null) out.push("cursor-agent");
	return out;
}
