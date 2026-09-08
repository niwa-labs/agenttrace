/**
 * trace renderer: the final MD document.
 * Body = the grouped compressed form (the "настоящая" reduced replica),
 * then SMART arcs, REASONING-INDEX, verdict. Frontmatter = typed meta.
 */

import { stringify } from "yaml";
import { estimateTokens } from "../core/tokens.js";
import type { Pass2Output } from "./contracts.js";
import type { PassMetrics } from "./metrics.js";
import type { TraceSessionRef } from "../model/trace.js";
import { deriveReasoningIndex } from "./contracts.js";
import type { SessionAccounting } from "./facts.js";

export interface TraceInput {
	sessions: TraceSessionRef[];
	groupedForm: string;
	pass2: Pass2Output | undefined;
	metrics: PassMetrics;
	generatedAt: string;
	models: { fast: string; smart: string };
	turnStats?: SessionAccounting;
	projectDir: string;
}

interface TraceMetaCurrent {
	schema: string;
	projectDir: string;
	reasoningIndex?: ReturnType<typeof deriveReasoningIndex>;
	generatedAt: string;
	source: string;
	session?: TraceSessionRef;
	sessions?: TraceSessionRef[];
	durationMs: number;
	models: { fast: string; smart: string };
	metrics: PassMetrics & { tokensTrace?: number; compressionRatioFinal?: number };
}

export function renderTrace(input: TraceInput): string {
	const primary = input.sessions[0];
	const meta: TraceMetaCurrent = {
		schema: "session-trace",
		projectDir: input.projectDir,
		generatedAt: input.generatedAt,
		source: primary?.source ?? "claude",
		...(primary !== undefined ? { session: primary } : {}),
		...(input.sessions.length > 1 ? { sessions: input.sessions } : {}),
		durationMs:
			primary !== undefined
				? Math.max(0, Date.parse(primary.endedAt) - Date.parse(primary.startedAt))
				: 0,
		models: input.models,
		metrics: input.metrics,
	};

	if (input.pass2 !== undefined) {
		meta.reasoningIndex = deriveReasoningIndex(input.pass2.arcs);
	}
	const body = renderBody(input);
	const compressedTokens = estimateTokens(body) + estimateTokens(JSON.stringify(meta));
	meta.metrics.tokensTrace = compressedTokens;
	meta.metrics.compressionRatioFinal =
		input.metrics.tokensOriginal > 0
			? Math.round((input.metrics.tokensOriginal / Math.max(1, compressedTokens)) * 10) / 10
			: 0;

	const yaml = stringify(meta, { lineWidth: 120, defaultStringType: "PLAIN", nullStr: "" });
	return `---\n${yaml}---\n${body}`;
}

function renderBody(input: TraceInput): string {
	const out: string[] = [];
	const primary = input.sessions[0];
	out.push(`# ${primary !== undefined && primary.title !== undefined ? primary.title : cap(primary?.firstPrompt ?? "сессия", 70)}`, "");
	if (primary !== undefined) {
		out.push(`- s1 @L → ${primary.logFile}`, "");
	}
	out.push(
		"> `@L<n>` — строка `<n>` исходного лога: `sed -n '<n>p' <logFile>`. Форма ниже — сжатая копия сессии (все ходы, мысли сжаты, результаты урезаны).",
		"",
	);

	out.push("## Сжатая сессия", "");
	out.push(input.groupedForm.trimEnd(), "");

	const pass2 = input.pass2;
	if (pass2 !== undefined && pass2.arcs.length > 0) {
		out.push("## Дуги рассуждения", "");
		for (const arc of pass2.arcs) {
			const to = Number.isFinite(arc.toLine) ? `→L${arc.toLine}` : "";
			out.push(`- **${arc.kind}** [${arc.status}] ${arc.text} @L${arc.fromLine}${to}`);
		}
		out.push("");
	}

	out.push("## Verdict", "");
	if (pass2 !== undefined) {
		out.push(`**${pass2.verdict.status}** — ${pass2.verdict.why} _(agent)_`, "");
	} else {
		out.push(`_pass-2 не выполнен — см. метрики и детерминированные факты_`, "");
	}

	// ---- session accounting: what we can compute ourselves ----
	if (primary !== undefined) {
		out.push("## Учёт сессии", "");
		const wallMs = Math.max(0, Date.parse(primary.endedAt) - Date.parse(primary.startedAt));
		const resumeHint =
			primary.source === "claude"
				? `claude --resume ${primary.sessionId}`
				: primary.source === "codex"
					? `codex resume ${primary.sessionId}`
					: `pi --session ${primary.sessionId}`;
		out.push(`- session: \`${primary.sessionId.slice(0, 8)}\` (${primary.source}) · resume: \`${resumeHint}\``);
		out.push(`- окно: ${hhms(primary.startedAt)} → ${hhms(primary.endedAt)} (wall ${fmtDur(wallMs)}${primary.activeMs !== undefined ? `, активная работа ~${fmtDur(primary.activeMs)}` : ""})`);
		const stats = input.turnStats;
		if (stats !== undefined) {
			const total = stats.toolCalls;
			const ok = total - stats.toolErrors;
			const rate = total > 0 ? Math.round((ok / total) * 1000) / 10 : 100;
			out.push(
				`- вызовы: ${total} (ok ${ok}, err ${stats.toolErrors}; success rate ${rate}%)${stats.interrupted > 0 ? ` · прервано: ${stats.interrupted}` : ""}`,
			);
			if (stats.diffAdded > 0 || stats.diffRemoved > 0) {
				out.push(`- правки: +${stats.diffAdded}/−${stats.diffRemoved} в ${stats.filesModified} файлах`);
			}
			if (stats.checks !== undefined) {
				out.push(`- проверки: ${stats.checks.run} run / ${stats.checks.failed} failed`);
			}
			if (stats.compactions > 0) out.push(`- компакций истории: ${stats.compactions}`);
		}
		const usage = primary.tokenUsage;
		if (usage !== undefined) {
			out.push(`- модель: \`${primary.model ?? "?"}\` · запросов ${usage.requests}`);
			out.push(
				`- токены: in ${fmtNum(usage.inputTokens)} (cache read ${fmtNum(usage.cacheReadTokens)}, write ${fmtNum(usage.cacheWriteTokens)}) · out ${fmtNum(usage.outputTokens)}${usage.reasoningTokens > 0 ? ` · reasoning ${fmtNum(usage.reasoningTokens)}` : ""}${usage.costUsd !== undefined ? ` · $${usage.costUsd.toFixed(2)}` : ""}`,
			);
			const totalIn = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
			if (totalIn > 0 && usage.cacheReadTokens / totalIn > 0.1) {
				out.push(
					`- кэш: ${Math.round((usage.cacheReadTokens / totalIn) * 100)}% входных токенов из кэша`,
				);
			}
		}
		out.push("");
	}

	const m = input.metrics;
	out.push(
		"## Метрики прохода",
		"",
		`ходов ${m.turns} · покрытие ${m.coverage} · fallback ${m.blocksFallback} · det-only ${m.detOnly} · ретраев ${m.retries} · споров ${m.disputes}`,
		`мысли: source ${JSON.stringify(m.thoughtsBySource)} · kind ${JSON.stringify(m.thoughtsByKind)}`,
		`исходник ${m.tokensOriginal} tok → сжатая форма ${m.tokensCompressed} tok (×${m.compressionRatio})`,
		`read_log ×${m.readLogCalls} · pass2 ретраев ${m.pass2Retries}`,
		"",
	);
	return out.join("\n");
}

function fmtDur(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const min = Math.floor(ms / 60_000);
	const sec = Math.round((ms % 60_000) / 1000);
	return `${min}m${sec > 0 ? ` ${sec}s` : ""}`;
}

function hhms(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "??:??";
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtNum(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);
}

function cap(text: string, n: number): string {
	return text.length <= n ? text : `${text.slice(0, n - 1)}…`;
}
