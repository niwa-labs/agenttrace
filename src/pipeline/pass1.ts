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



export const PASS1_SYSTEM_PROMPT = `Ты — сжиматель логов агентских сессий (быстрая модель). Тебе последовательно дают ходы (TURN) исходной сессии: thinking целиком, наррацию, вызовы инструментов с урезанными результатами.

На каждый TURN ответь ОДНИМ JSON-объектом, без текста вокруг:
{
  "anchor": {"fromLine": <int>, "toLine": <int>},
  "action": "<сжатое описание действий хода, ≤240 символов>",
  "thoughts": [  // 0–3 события рассуждения хода
    {"kind": "H"|"ALT"|"?"|"PIVOT"|"INSIGHT"|"ERR-R",
     "source": "thinking"|"narration"|"inferred",
     "text": "<суть мысли своими словами, ≤320 символов>",
     "q": "<q-id из [q...] метки, обязателен для thinking|narration>"}
  ],
  "factsClaimed": {"checks": {"run": <int>, "failed": <int>}, "exitCode": <int>}  // опционально
}

Правила:
- anchor — фактические строки TURN'а (они указаны в заголовке).
- thoughts ОБЯЗАТЕЛЬНО непустой, если в ходе есть блоки [THINKING] — по одному событию на самую существенную мысль каждого блока (source="thinking", q — id блока). Максимум 3, выбирай самые важные: развороты, открытия, гипотезы, сомнения, причины выбора.
- Если thinking нет, но [ASSISTANT]-наррация содержит обоснование/вывод — thought с source="narration". Только если ни мыслей, ни обоснований нет — thoughts: [].
- Мысль формулируй как НАМЕРЕНИЕ/гипотезу в настоящем времени («ищу X», «предполагаю Y»), не как свершившийся факт, — если только это не вывод.
- Не добавляй в мысль детали из промпта или результатов вызова — только то, что написано в самом [THINKING].
- source=inferred разрешён только с kind H или ? (когда рассуждение не зафиксировано, а ты видишь намерение по действиям); inferred не должен противоречить [ASSISTANT]-тексту хода.
- factsClaimed — только то, что реально видно в [RESULT] этого хода. Не выдумывай результаты: если у вызова нет [RESULT] — результата не существует.
- Текст с пометкой [delegation:*] — входящее сообщение ДРУГОГО агента/потока: это запрос или отчёт, адресованный агенту, а не его собственная работа. Не приписывай её себе в action/thought.
- Отвечай на языке исходного запроса пользователя (русский текст запроса → русский ответ; английский → английский). Если язык определить нельзя — по-русски.
- Никакого текста кроме JSON.`;

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
			`Состояние сжатия предыдущего окна (для непрерывности, не отвечай на него):\n${JSON.stringify(previousDigest)}`,
		);
		await agent.waitForIdle();
	}

	for (const turn of window.turns) {
		const anchors: TurnAnchors = anchorTurn(turn);
		const rendered = renderTurn(turn, anchors, renderOptionsForTurn(turn));
		const ctx = { fromLine: turn.fromLine, toLine: turn.toLine, quoteIds: new Set(anchors.byQ.keys()) };
		const promptText = `${rendered}\n\nОтветь JSON по схеме для TURN b${turn.index}.`;

		let retries = 0;
		let fallback = false;
		let block: Pass1Block | undefined;
		let lastValidatorError = "";
		const thinkingQs = anchors.quotes.filter((q) => q.source === "thinking").map((q) => q.q);
		for (let attempt = 0; attempt <= 3; attempt++) {
			const minimal = `Верни МИНИМАЛЬНЫЙ корректный JSON для TURN b${turn.index}: anchor (fromLine=${turn.fromLine}, toLine=${turn.toLine}), action, thoughts: [].`;
			const prompt =
				attempt === 0
					? promptText
					: attempt === 1
						? `${lastValidatorError}\nВерни исправленный JSON для TURN b${turn.index}.`
						: attempt === 2 && thinkingQs.length > 0
							? `thoughts не может быть пустым: в ходе есть [THINKING] (${thinkingQs.join(", ")}). Извлеки главную мысль — источник="thinking", q=<id>, text=суть своими словами.`
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
					lastValidatorError = "factsClaimed противоречит машинным фактам этого хода. Перечитай [RESULT]-строки и исправь factsClaimed (значения не сообщаются — смотри сам).";
					continue;
				}
				block = candidate;
				break;
			}
			retries++;
			lastValidatorError = `Валидатор отклонил ответ:\n${errors.map((e) => `- ${e}`).join("\n")}`;
		}
		if (block === undefined) {
			fallback = true;
			block = {
				anchor: { fromLine: turn.fromLine, toLine: turn.toLine },
				action: detFallbackAction(turn),
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
		if (errors.length === 0 && parsed !== undefined) {
			digest = asPass1Digest(parsed);
			counters.digests++;
		} else {
			digest = detDigest(window);
		}
	}
	return { windowIndex: window.index, turns: results, ...(digest !== undefined ? { digest } : {}) };
}

const DIGEST_PROMPT = `Окно сжато. Выдай JSON-дайджест окна для следующего окна (тот же протокол: один JSON-объект):
{
  "goal": "<что делается, ≤200 символов>",
  "openHypotheses": [{"text": "<нерешённая гипотеза>", "q": "<q-id, если есть>"}],
  "currentBelief": "<текущая картина мира, ≤300 символов>",
  "naming": ["<как названы ключевые сущности>"]
}`;

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
	const tools = turn.toolNames.length > 0 ? turn.toolNames.join(",") : "без вызовов";
	const kind = turn.entries.some((e) => e.kind === "tool_call") ? "ход" : "реплика";
	return `${kind} (${tools})${turn.interrupted ? " — прервано" : ""} [fallback: не сжато моделью]`;
}

function detDigest(window: Window): Pass1Digest {
	return {
		goal: `(окно ${window.index}: модель не выдала digest)`,
		openHypotheses: [],
		currentBelief: "(неизвестно — детерминированный digest)",
	};
}
