/**
 * PASS-1: streaming FAST compression.
 *
 * One agent session per window; one JSON answer per turn, validated against
 * the contract; on failure — repair-in-place (validator error back into the
 * same session), then a minimal-answer retry, then a deterministic fallback
 * floor so isomorphy (every turn covered) always holds.
 */

import { Agent } from "@earendil-works/pi-agent-core";

import { anchorTurn, type TurnAnchors } from "./anchors.js";
import {
	asPass1Block,
	asPass1Digest,
	extractJsonObject,
	validatePass1Block,
	validatePass1Digest,
	type Pass1Block,
	type Pass1Digest,
} from "./contracts.js";
import { renderTurn, renderOptionsForTurn } from "./render-turn.js";
import { sealFacts } from "./facts.js";
import type { Window } from "./turns.js";
import type { AnyModel, Models } from "../agent/models.js";
export const PASS1_SCHEMA_VERSION = 3;



export const PASS1_SYSTEM_PROMPT = `You are a coding-agent session log compressor (a fast model). You are given the turns (TURN) of the original session one by one: thinking in full, the narration, tool calls with truncated results.

For each TURN reply with a SINGLE JSON object, no text around it:
{
  "anchor": {"fromLine": <int>, "toLine": <int>},
  "action": "<compressed description of the turn's actions, ≤240 chars>",
  "thoughts": [  // 0–3 reasoning events of the turn
    {"kind": "H"|"ALT"|"?"|"PIVOT"|"INSIGHT"|"ERR-R",
     "source": "thinking"|"narration"|"inferred",
     "text": "<the gist of the thought in your own words, ≤320 chars>",
     "q": "<q-id from the [q...] label, required for thinking|narration>"}
  ],
  "factsClaimed": {"checks": {"run": <int>, "failed": <int>}, "exitCode": <int>}  // optional
}

Rules:
- MERGING: consecutive insignificant turns (routine reads, status checks, repeats with no new information, turns without thinking) may be merged into ONE answer: the anchor covers them exactly (fromLine of the first, toLine of the last), turnIndex is the first of them, action is a single compressed description of the run. Do not merge turns that contain thinking, errors, or decisions.
- Operator turns ([USER]): abstract the intent in the third person, do NOT quote verbatim, do not include flag names, paths, or other exact values.
- anchor is the actual lines of the TURN (given in its header).
- thoughts MUST be non-empty when the turn has [THINKING] blocks — one event per the most essential thought of each block (source="thinking", q is the block id). At most 3; pick the most important ones: pivots, discoveries, hypotheses, doubts, reasons for choices.
- If there is no thinking but the [ASSISTANT] narration contains reasoning/conclusions — a thought with source="narration". Only when there are neither thoughts nor conclusions — thoughts: [].
- Phrase a thought as an INTENT/hypothesis in the present tense ("looking for X", "assuming Y"), not as an accomplished fact — unless it is a conclusion.
- Do not add details from the prompt or from call results to a thought — only what is written in the [THINKING] itself.
- source=inferred is allowed only with kind H or ? (when the reasoning is not recorded but you can see the intent from the actions); inferred must not contradict the turn's [ASSISTANT] text.
- factsClaimed — only what is actually visible in this turn's [RESULT]. Do not invent results: if a call has no [RESULT], the result does not exist.
- Text marked [delegation:*] is an incoming message from ANOTHER agent/thread: a request or a report addressed to the agent, not its own work. Do not attribute it to this agent in action/thought.
- Reply in the language of the user's original request (a Russian request → a Russian answer; an English request → an English answer). If the language cannot be determined — reply in English.
- No text other than the JSON.`;

export interface Pass1TurnResult {
	turnIndex: number;
	fromLine: number;
	toLine: number;
	result: Pass1Block;
	retries: number;
	fallback: boolean;
}

export interface Pass1WindowResult {
	windowIndex: number;
	turns: Pass1TurnResult[];
	digest?: Pass1Digest;
}

export interface Pass1Deps {
	fast: AnyModel;
	models: Models;
}

export interface Pass1SessionInfo {
	sessionId: string;
	logFile: string;
}

export interface Pass1Counters {
	blocks: number;
	retries: number;
	fallbacks: number;
	digests: number;
	usage: { requests: number; inputTokens: number; outputTokens: number };
}

export function newFastAgent(deps: Pass1Deps, systemPrompt: string): Agent {
	return new Agent({
		initialState: {
			systemPrompt,
			model: deps.fast,
			tools: [],
			messages: [],
			thinkingLevel: "off",
		},
		streamFn: deps.models.streamSimple.bind(deps.models),
	});
}

export async function runPass1Window(
	agent: Agent,
	window: Window,
	previousDigest: Pass1Digest | undefined,
	counters: Pass1Counters,
	isLastWindow: boolean,
): Promise<Pass1WindowResult> {
	const results: Pass1TurnResult[] = [];
	let digest: Pass1Digest | undefined;

	if (previousDigest !== undefined) {
		await agent.prompt(
			`Compressed state of the previous window (for continuity; do not reply to it):\n${JSON.stringify(previousDigest)}`,
		);
		await agent.waitForIdle();
	}

	for (const turn of window.turns) {
		const anchors: TurnAnchors = anchorTurn(turn);
		const rendered = renderTurn(turn, anchors, renderOptionsForTurn(turn));
		const ctx = { fromLine: turn.fromLine, toLine: turn.toLine, quoteIds: new Set(anchors.byQ.keys()) };
		const promptText = `${rendered}\n\nReply with JSON per the schema for TURN b${turn.index}.`;

		let retries = 0;
		let fallback = false;
		let block: Pass1Block | undefined;
		let lastValidatorError = "";
		const thinkingQs = anchors.quotes.filter((q) => q.source === "thinking").map((q) => q.q);
		for (let attempt = 0; attempt <= 3; attempt++) {
			const minimal = `Return a MINIMAL valid JSON for TURN b${turn.index}: anchor (fromLine=${turn.fromLine}, toLine=${turn.toLine}), action, thoughts: [].`;
			const prompt =
				attempt === 0
					? promptText
					: attempt === 1
						? `${lastValidatorError}\nReturn the corrected JSON for TURN b${turn.index}.`
						: attempt === 2 && thinkingQs.length > 0
							? `thoughts must not be empty: the turn has [THINKING] (${thinkingQs.join(", ")}). Extract the main idea — source="thinking", q=<id>, text=the gist in your own words.`
							: minimal;
			await agent.prompt(prompt);
			await agent.waitForIdle();
			countUsage(counters.usage, agent);
			const text = lastAssistantText(agent);
			const parsed = text !== undefined ? extractJsonObject(text) : undefined;
			let errors =
				parsed === undefined ? ["response contains no JSON object"] : validatePass1Block(parsed, ctx);
			// semantic rule: [THINKING] present ⇒ at least one thought is mandatory
			if (
				errors.length === 0 &&
				parsed !== undefined &&
				thinkingQs.length > 0 &&
				Array.isArray((parsed as { thoughts?: unknown }).thoughts) &&
				(parsed as { thoughts: unknown[] }).thoughts.length === 0
			) {
				errors = [
					`turn contains [THOUGHT-SOURCES] (${thinkingQs.join(", ")}) — thoughts must not be empty: distill the main idea (source="thinking", q=<id>)`,
				];
			}
			if (errors.length === 0 && parsed !== undefined) {
				const candidate = asPass1Block(parsed);
				// dispute repair: claims contradict machine facts — one recheck round
				const sealed = sealFacts(turn);
				const disputed =
					(candidate.factsClaimed?.checks !== undefined && sealed.checks !== undefined && candidate.factsClaimed.checks.failed !== sealed.checks.failed) ||
					(candidate.factsClaimed?.exitCode !== undefined && sealed.lastExitCode !== undefined && candidate.factsClaimed.exitCode !== sealed.lastExitCode);
				if (disputed && attempt < 3) {
					retries++;
					lastValidatorError = "factsClaimed contradicts the machine facts of this turn. Re-read the [RESULT] lines and fix factsClaimed (the values are not disclosed — check them yourself).";
					continue;
				}
				block = candidate;
				break;
			}
			retries++;
			lastValidatorError = `The validator rejected the answer:\n${errors.map((e) => `- ${e}`).join("\n")}`;
		}
		if (block === undefined) {
			// last resort: a FRESH agent session (only this turn, clean context).
			// Four failed attempts in the shared session usually mean the model
			// got stuck on stale context, not that the turn is uncompressible —
			// a blank-slate retry recovers the thinking instead of dropping it.
			try {
				const fresh = new Agent({
					initialState: {
						systemPrompt: PASS1_SYSTEM_PROMPT,
						model: agent.state.model,
						tools: [],
						messages: [],
						thinkingLevel: "off",
					},
					streamFn: agent.streamFunction,
				});
				await fresh.prompt(promptText);
				await fresh.waitForIdle();
				countUsage(counters.usage, fresh);
				const text = lastAssistantText(fresh);
				const parsed = text !== undefined ? extractJsonObject(text) : undefined;
				const errors = parsed === undefined ? ["response contains no JSON object"] : validatePass1Block(parsed, ctx);
				if (errors.length === 0 && parsed !== undefined) {
					block = asPass1Block(parsed);
					retries++;
					counters.retries += 1;
				}
			} catch {
				// fresh-session retry is best-effort; det fallback below still holds
			}
		}
		if (block === undefined) {
			fallback = true;
			// honest floor: keep whatever the deterministic layer knows. If the
			// turn carries thinking, surface the quote ids and a head of the
			// text in the action instead of losing it silently.
			const thinkingHead = turn.entries
				.filter((e) => e.kind === "assistant_thinking" && e.text.trim().length > 0)
				.map((e) => (e as { text: string }).text.replace(/\s+/g, " ").slice(0, 200))
				.filter((t) => t.length > 0)
				.join(" | ");
			block = {
				anchor: { fromLine: turn.fromLine, toLine: turn.toLine },
				action: thinkingHead.length > 0
					? `${detFallbackAction(turn)}; thinking: ${thinkingHead}`
					: detFallbackAction(turn),
				thoughts: [],
				fallback: true,
			};
		}
		counters.blocks++;
		counters.retries += retries;
		if (fallback) counters.fallbacks++;
		results.push({ turnIndex: turn.index, fromLine: turn.fromLine, toLine: turn.toLine, result: block, retries, fallback });
	}

	if (!isLastWindow) {
		await agent.prompt(DIGEST_PROMPT);
		await agent.waitForIdle();
		countUsage(counters.usage, agent);
		const text = lastAssistantText(agent);
		const parsed = text !== undefined ? extractJsonObject(text) : undefined;
		const errors = parsed === undefined ? ["no JSON in digest reply"] : validatePass1Digest(parsed);
		// sanity gate: a digest runaway (comparable to the window it summarizes)
		// defeats the purpose — fall back to the deterministic skeleton
		if (errors.length === 0 && parsed !== undefined && text !== undefined && text.length > 4000) {
			digest = detDigest(window);
		} else if (errors.length === 0 && parsed !== undefined) {
			digest = asPass1Digest(parsed);
			counters.digests++;
		} else {
			digest = detDigest(window);
		}
	}
	return { windowIndex: window.index, turns: results, ...(digest !== undefined ? { digest } : {}) };
}

const DIGEST_PROMPT = `The window is compressed. Produce a JSON digest of this window for the next window (same protocol: a single JSON object):
{
  "goal": "<what is being done, ≤200 chars>",
  "openHypotheses": [{"text": "<unresolved hypothesis>", "q": "<q-id, if any>"}],
  "currentBelief": "<current picture of the world, ≤300 chars>",
  "naming": ["<how the key entities are named>"],
  "checkpoint": {
    "intent": "<the operator's request/intent, ≤400 chars or empty>",
    "concepts": "<key technical concepts of the window, ≤400 or empty>",
    "files": "<affected files/paths, comma-separated, ≤400 or empty>",
    "errors": "<errors and how they were resolved, ≤400 or empty>",
    "pending": "<unfinished tasks, ≤400 or empty>",
    "current": "<what was happening right in this window, ≤400 or empty>",
    "next": "<the obvious next step, ≤400 or empty>",
    "critical": "<critical context without which continuation would break, ≤400 or empty>"
  }
}
Checkpoint rules: consolidate with the previous digest — if it already had a checkpoint, keep what is STILL TRUE, drop what is OUTDATED, add what is new (do not copy verbatim); an empty section = an empty string. The whole digest must be noticeably shorter than the window.`;

function countUsage(usage: { requests: number; inputTokens: number; outputTokens: number }, agent: Agent): void {
	for (let i = agent.state.messages.length - 1; i >= 0; i--) {
		const m = agent.state.messages[i];
		if (m === undefined || m.role !== "assistant") continue;
		const u = (m as { usage?: unknown }).usage;
		if (u !== null && typeof u === "object") {
			const rec = u as Record<string, unknown>;
			usage.requests++;
			usage.inputTokens += numOr0(rec["input"]) + numOr0(rec["inputTokens"]);
			usage.outputTokens += numOr0(rec["output"]) + numOr0(rec["outputTokens"]);
		}
		return;
	}
}

function numOr0(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function lastAssistantText(agent: Agent): string | undefined {
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

function detFallbackAction(turn: { toolNames: string[]; entries: { kind: string }[]; interrupted: boolean }): string {
	const tools = turn.toolNames.length > 0 ? turn.toolNames.join(",") : "no calls";
	const kind = turn.entries.some((e) => e.kind === "tool_call") ? "turn" : "message";
	return `${kind} (${tools})${turn.interrupted ? " — interrupted" : ""} [fallback: not compressed by the model]`;
}

function detDigest(window: Window): Pass1Digest {
	return {
		goal: `(window ${window.index}: the model produced no digest)`,
		openHypotheses: [],
		currentBelief: "(unknown — deterministic digest)",
		checkpoint: {
			intent: "",
			concepts: "",
			files: "",
			errors: "",
			pending: "",
			current: "",
			next: "",
			critical: "",
		},
	};
}
