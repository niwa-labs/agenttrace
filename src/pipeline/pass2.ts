/**
 * PASS-2: SMART analysis over the grouped compressed form.
 * Reasoning arcs, REASONING-INDEX, verdict, reasoning-items → bank.
 * The raw session is not given; dereferencing happens via read_log (@L),
 * within a call budget.
 */

import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	asPass2Output,
	extractJsonObject,
	validatePass2,
	type Pass2Output,
} from "./contracts.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Pass2Item } from "./contracts.js";
export type { Pass2Item };
import type { AnyModel, Models } from "../agent/models.js";

const MAX_READ_BYTES = 16 * 1024;

const ReadLogParams = Type.Object({
	file: Type.String({ description: "Absolute path to the original JSONL log (from the header)" }),
	line: Type.Integer({ description: "1-based line from an @L pointer", minimum: 1 }),
	count: Type.Integer({ description: "How many lines to read (1–40)", minimum: 1, maximum: 40, default: 1 }),
});

function readLogTool(allowedFiles: Set<string>, counter: { calls: number; budget: number }): AgentTool<typeof ReadLogParams, undefined> {
	const allowed = new Set([...allowedFiles].map((f) => resolve(f)));
	return {
		name: "read_log",
		label: "Read log lines",
		description: "Read exact lines of the original log to dereference @L pointers. Only files listed in the header.",
		parameters: ReadLogParams,
		execute: async (_id, params) => {
			if (counter.calls >= counter.budget) {
				throw new Error(`read_log budget exhausted (${counter.budget}) — continue from the form data; mark anything unverified as open`);
			}
			counter.calls++;
			const file = resolve(params.file);
			if (!allowed.has(file)) throw new Error(`file not allowed: ${params.file}`);
			const raw = await readFile(file, "utf8");
			const lines = raw.split("\n");
			const picked = lines.slice(params.line - 1, params.line - 1 + params.count);
			let text = picked.join("\n");
			if (text.length > MAX_READ_BYTES) text = `${text.slice(0, MAX_READ_BYTES)}…[truncated]`;
			return {
				content: [{ type: "text", text: text.length === 0 ? `(empty; the file has ${lines.length} lines)` : text }],
				details: undefined,
			};
		},
	};
}

export const PASS2_SYSTEM_PROMPT = `You are an analyst of coding-agent session traces (a smart model). The goal is observability: preserve and explain HOW the agent reasoned, not only what it did. Rely on both kinds of work outcomes: extract strategies from successful branches and guardrails from failures; do not narrow the picture down to "it broke→it got fixed".

You are given the compressed form of a session: 💭 lines (thoughts, with a type and an @L anchor), ⚠ lines (a claim contradicting a machine fact), one-liners of tool calls, → lines (per-turn micro-outcomes). @L pointers reference lines of the original JSONL (the file is in the header). There is a read_log tool for dereferencing.

Tasks:
1. REASONING ARCS: where a hypothesis (H) was confirmed/refuted (give the line of the outcome), where an alternative (ALT) was retrospectively right/wrong, where a reasoning error (ERR-R) was noticed or never noticed.
2. Each arc carries a subject (file/module/concept) — the arcs build a machine index for cumulative analysis across traces.
3. VERDICT: one line based on facts (cross-check against the ⚠ lines and the sealed data in the form).
4. ITEMS: at most 3 of {title, description, content(rationale chain "hypothesis → check → conclusion/course change"), polarity: strategy|guardrail, subject[], evidence[{line}]} — portable lessons for the knowledge bank.

Rules: facts, not interpretation; anything unverified gets status=open or a hypothesis mark; a claim about the agent's motive only if it is visible in 💭 or confirmed via read_log; no self-assessments; write in English.
It is FORBIDDEN to invent call outcomes: if a call in the form has no [RESULT] or carries the mark "result not recorded" — the outcome is UNKNOWN; "unknown" ≠ "empty" ≠ "failed". For such a call an arc must not get status confirmed/refuted — only open.
Base arc statuses on the form's text; "found/not found" claims only with backing from [RESULT] text or read_log; if a truncated result (⟨truncated…⟩) matters for the conclusion — read_log @L first.
Arcs were built ONLY from the form's 💭 lines and [ASSISTANT] narration: do not attribute any thoughts or intentions to turns without 💭; do not invent call results that are absent from the form ("empty" ≠ "not found" ≠ "failed").
Do not change the kind of a thought already classified in the form (💭 ? — stay with ? or ?.); an arc's subject is a file/module/concept.
In verdict.why do not attribute confidence or lack of confidence to the agent — convey its actual position from the [ASSISTANT] lines; if a 💭 (inferred) contradicts the [ASSISTANT] of the same turn — status refuted plus a note about the contradiction.

The answer format is a single JSON object:
{
  "arcs": [{"kind": "H|ALT|PIVOT|INSIGHT|ERR-R", "text": "...", "status": "confirmed|refuted|open|noticed|never", "fromLine": <int>, "toLine": <int>?, "subject": "<file/module/concept>"}],
  "verdict": {"status": "success|partial|failure", "why": "<one sentence>"},
  "items": [{"title": "≤80", "description": "≤200", "content": "≤800", "polarity": "strategy|guardrail", "subject": ["..."], "evidence": [{"line": <int>}]}]
}`;

export interface Pass2Deps {
	smart: AnyModel;
	models: Models;
	allowedLogFiles: Set<string>;
	readLogBudget: number;
	usage: { requests: number; inputTokens: number; outputTokens: number };
}

export interface Pass2Result {
	output: Pass2Output | undefined;
	retries: number;
	readLogCalls: number;
	lastError?: string;
}

export async function runPass2(
	deps: Pass2Deps,
	sessionId: string,
	groupedForm: string,
	factsFooter: string,
): Promise<Pass2Result> {
	const readCounter = { calls: 0, budget: deps.readLogBudget };
	const agent = new Agent({
		initialState: {
			systemPrompt: PASS2_SYSTEM_PROMPT,
			model: deps.smart,
			tools: [readLogTool(deps.allowedLogFiles, readCounter)],
			messages: [],
			thinkingLevel: "medium",
		},
		streamFn: deps.models.streamSimple.bind(deps.models),
	});

	const header = [
		"# Session for analysis",
		`sessionId: ${sessionId}`,
		"Original logs (for read_log via @L):",
		...[...deps.allowedLogFiles].map((f) => `- ${f}`),
		"",
		"## Compressed form",
		"",
		groupedForm,
		"",
		"## Sealed machine facts (believe them, do not dispute them)",
		"",
		factsFooter,
	].join("\n");

	let retries = 0;
	let output: Pass2Output | undefined;
	let lastError = "";
	for (let attempt = 0; attempt <= 2; attempt++) {
		const prompt =
			attempt === 0
				? `${header}\n\nPerform the analysis and output the JSON.`
				: `The validator rejected the answer. Return the corrected JSON in full.`;
		await agent.prompt(prompt);
		await agent.waitForIdle();
		const text = lastText(agent);
		const parsed = text !== undefined ? extractJsonObject(text) : undefined;
		const errors = parsed === undefined ? ["no JSON object in reply"] : validatePass2(parsed);
		if (errors.length === 0 && parsed !== undefined) {
			output = asPass2Output(parsed);
			break;
		}
		retries++;
		lastError = errors.join("; ");
		if (attempt === 1) {
			await agent.prompt(
				`Hint: a minimally valid answer is {"arcs": [], "reasoningIndex": [], "verdict": {"status": "partial", "why": "..."}, "items": []}`,
			);
			await agent.waitForIdle();
		}
	}
	return { output, retries, readLogCalls: readCounter.calls, ...(lastError !== "" ? { lastError } : {}) };
}

function lastText(agent: Agent): string | undefined {
	for (let i = agent.state.messages.length - 1; i >= 0; i--) {
		const m = agent.state.messages[i];
		if (m === undefined || m.role !== "assistant") continue;
		const text = m.content
			.map((c) => ("text" in c ? c.text : ""))
			.filter((s) => s.length > 0)
			.join("\n");
		return text.length > 0 ? text : undefined;
	}
	return undefined;
}
