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
	file: Type.String({ description: "Абсолютный путь к исходному JSONL-логу (из шапки)" }),
	line: Type.Integer({ description: "1-based строка из указателя @L", minimum: 1 }),
	count: Type.Integer({ description: "Сколько строк прочитать (1–40)", minimum: 1, maximum: 40, default: 1 }),
});

function readLogTool(allowedFiles: Set<string>, counter: { calls: number; budget: number }): AgentTool<typeof ReadLogParams, undefined> {
	const allowed = new Set([...allowedFiles].map((f) => resolve(f)));
	return {
		name: "read_log",
		label: "Read log lines",
		description: "Прочитать точные строки исходного лога для разыменования @L. Только файлы из шапки.",
		parameters: ReadLogParams,
		execute: async (_id, params) => {
			if (counter.calls >= counter.budget) {
				throw new Error(`read_log budget exhausted (${counter.budget}) — продолжай по данным формы, помечай непроверенное как open`);
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
				content: [{ type: "text", text: text.length === 0 ? `(пусто; в файле ${lines.length} строк)` : text }],
				details: undefined,
			};
		},
	};
}

export const PASS2_SYSTEM_PROMPT = `Ты — аналитик трейсов агентских сессий (умная модель). Цель — наблюдаемость: сохранить и объяснить КАК агент рассуждал, а не только что он сделал. Опирайся на оба исхода работы: из успешных ветвей извлекай стратегии, из неудач — guardrails; не сужай картинку до «сломалось→починили».

Тебе дают сжатую форму сессии: строки 💭 (мысли, с типом и якорем @L), строка ⚠ (расхождение заявления с машинным фактом), однострочники вызовов, строки → (микро-итоги ходов). Указатели @L указывают на строки исходного JSONL (файл — в шапке). Есть инструмент read_log для разыменования.

Задачи:
1. ДУГИ рассуждения: где гипотеза (H) подтвердилась/опровергнута (укажи строку исхода), где альтернатива (ALT) ретроспективно была права/нет, где ошибка рассуждения (ERR-R) была замечена (noticed) или не замечена (never).
2. Каждая дуга несёт subject (файл/модуль/понятие) — из дуг строится машинный индекс для накопительного анализа поперёк трейсов.
3. VERDICT: одна строка по фактам (сверяйся с ⚠/запечатанными данными в форме).
4. ITEMS: ≤3 штук {title, description, content(rationale-цепочка «гипотеза → проверка → вывод/смена курса»), polarity: strategy|guardrail, subject[], evidence[{line}]} — переносимые уроки для банка знаний.

Правила: факты, не интерпретация; непроверенное — status=open или пометка hypothesis; утверждение о мотиве агента — только если видно в 💭 или подтверждено read_log; без самооценок; по-русски.
ЗАПРЕЩЕНО придумывать исходы вызовов: если в форме у вызова нет [RESULT] или стоит пометка «результат не зафиксирован» — исход НЕИЗВЕСТЕН; «неизвестно» ≠ «пусто» ≠ «провалено». По такому вызову нельзя ставить дуге статус confirmed/refuted — только open.
Статусы дуг опирай на текст формы; утверждения «найдено/не найдено» — только с опорой на [RESULT]-текст или read_log; если урезанный результат (⟨урезано…⟩) важен для вывода — сначала read_log @L.
Дуги строились ТОЛЬКО по 💭-строкам и [ASSISTANT]-наррации формы: не приписывай ходам без 💭 никаких мыслей и намерений; не выдумывай результаты вызовов, которых нет в форме («пусто» ≠ «не найдено» ≠ «провалено»).
Не меняй kind уже классифицированной в форме мысли (💭 ? — оставайся ? или ?.); subject в дуге — файл/модуль/понятие.
verdict.why не приписывай агенту уверенность/неуверенность — передавай его фактическую позицию из [ASSISTANT]-строк; если 💭 (inferred) противоречит [ASSISTANT] того же хода — статус refuted и note о противоречии.

Формат ответа — один JSON-объект:
{
  "arcs": [{"kind": "H|ALT|PIVOT|INSIGHT|ERR-R", "text": "...", "status": "confirmed|refuted|open|noticed|never", "fromLine": <int>, "toLine": <int>?, "subject": "<файл/модуль/понятие>"}],
  "verdict": {"status": "success|partial|failure", "why": "<одно предложение>"},
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
		"# Сессия для анализа",
		`sessionId: ${sessionId}`,
		"Исходные логи (для read_log по @L):",
		...[...deps.allowedLogFiles].map((f) => `- ${f}`),
		"",
		"## Сжатая форма",
		"",
		groupedForm,
		"",
		"## Запечатанные машинные факты (им верь, их не оспаривай)",
		"",
		factsFooter,
	].join("\n");

	let retries = 0;
	let output: Pass2Output | undefined;
	let lastError = "";
	for (let attempt = 0; attempt <= 2; attempt++) {
		const prompt =
			attempt === 0
				? `${header}\n\nВыполни анализ и выдай JSON.`
				: `Валидатор отклонил ответ. Верни исправленный JSON целиком.`;
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
				`Подсказка: минимально корректный ответ — {"arcs": [], "reasoningIndex": [], "verdict": {"status": "partial", "why": "..."}, "items": []}`,
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
