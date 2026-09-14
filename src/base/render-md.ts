/**
 * MD trace renderer: strict template = typed YAML frontmatter + fixed sections.
 * The document is a compressed view; every dropped payload is reachable via the
 * `@L<line>` pointers into the original session logs (see the Сессии table).
 */

import { stringify } from "yaml";
import { estimateTokens } from "../core/tokens.js";
import { formatBytes } from "../core/refs.js";
import type { CompressedTrace, TimelineBlock } from "../model/trace.js";

const LABEL_TITLES: Record<string, string> = {
	research: "исследование",
	edit: "правки",
	run: "запуски",
	checks: "проверки",
	web: "веб",
	delegation: "делегирование",
	mcp: "mcp",
	tools: "инструменты",
};

export function renderTraceMd(trace: CompressedTrace): string {
	const meta = trace.meta;
	const title =
		trace.sessions[0]?.title ??
		cap(trace.sessions[0]?.firstPrompt ?? "сессия", 70);

	const body = renderBody(trace, title);

	meta.stats.approxTokensTrace = estimateTokens(body) + estimateTokens(JSON.stringify(meta));
	meta.stats.compressionRatio =
		meta.stats.approxTokensTrace > 0
			? Math.round((meta.stats.approxTokensOriginal / meta.stats.approxTokensTrace) * 10) / 10
			: 0;

	const yaml = stringify(meta, { lineWidth: 120, defaultStringType: "PLAIN", nullStr: "" });
	return `---\n${yaml}---\n${body}`;
}

function renderBody(trace: CompressedTrace, title: string): string {
	const out: string[] = [];
	out.push(`# ${title}`, "");

	if (trace.meta.kind === "chain") {
		out.push(
			`> Цепочка из ${trace.meta.sessions.length} сессий, слитых в один трейс (${trace.meta.chainReasons.join(", ")}).`,
			"",
		);
	}

	const fileIndex = buildFileIndex(trace);
	renderSessionsTable(out, trace);
	renderVerdict(out, trace);
	renderTask(out, trace);
	renderWorkingSet(out, trace, fileIndex);
	renderTimeline(out, trace, fileIndex);
	renderSubagents(out, trace);
	renderNotes(out, trace);
	renderRecovery(out, trace);
	return out.join("\n");
}

export interface FileIndexEntry {
	id: number;
	path: string;
	modified: boolean;
}

/**
 * Deterministic declaration table for file paths (pi-style file-ops index):
 * modified files get the lowest ids (sorted by path), read-only files follow.
 * The body references paths as `[F<n>]` — each full path appears exactly once.
 */
export function buildFileIndex(trace: CompressedTrace): FileIndexEntry[] {
	const modified = trace.workingSet.filter((w) => w.modified).map((w) => w.path).sort();
	const read = trace.workingSet.filter((w) => !w.modified).map((w) => w.path).sort();
	const out: FileIndexEntry[] = [];
	let id = 1;
	for (const path of modified) out.push({ id: id++, path, modified: true });
	for (const path of read) out.push({ id: id++, path, modified: false });
	return out;
}

/** Replace full indexed paths with `[F<n>]` refs (longest first, no prefix collisions). */
export function substituteFileRefs(text: string, fileIndex: FileIndexEntry[]): string {
	if (fileIndex.length === 0) return text;
	let out = text;
	for (const entry of [...fileIndex].sort((a, b) => b.path.length - a.path.length)) {
		out = out.split(entry.path).join(`[F${entry.id}]`);
	}
	return out;
}

function renderSessionsTable(out: string[], trace: CompressedTrace): void {
	out.push("## Сессии", "");
	out.push("| # | источник | id | окно | строк | модель | ветка |");
	out.push("|---|---|---|---|---|---|---|");
	trace.sessions.forEach((s, i) => {
		const win = `${hhmm(s.startedAt)}–${hhmm(s.endedAt)} (${s.startedAt.slice(0, 10)})`;
		out.push(
			`| ${i + 1} | ${s.source} | \`${s.sessionId.slice(0, 8)}\` | ${win} | ${s.logLines} (${formatBytes(s.logBytes)}) | ${s.model ?? "?"} | ${s.gitBranch ?? "?"} |`,
		);
	});
	out.push("");
	trace.sessions.forEach((s, i) => {
		out.push(`- s${i + 1} @L → ${s.logFile}`);
	});
	out.push("");
	out.push(
		"> Разыменование: `@L<n>` — строка `<n>` в logFile сессии с этим номером: `sed -n '<n>p' <logFile>`. `#x1b2c3d4` — отпечаток содержимого.",
		"",
	);
}

function renderVerdict(out: string[], trace: CompressedTrace): void {
	const v = trace.meta.verdict;
	const o = trace.meta.outcome;
	out.push("## Verdict", "");
	out.push(`**${v.status}** — ${v.why} _(${v.origin})_`);
	const facts: string[] = [];
	if (o.interrupted) facts.push("были прерванные вызовы");
	if (o.compactions > 0) facts.push(`компакций истории: ${o.compactions}`);
	if (trace.meta.stats.repairCycles > 0) facts.push(`repair-циклов: ${trace.meta.stats.repairCycles}`);
	if (trace.meta.stats.subagentRuns > 0) facts.push(`сабагентов: ${trace.meta.stats.subagentRuns}`);
	if (facts.length > 0) out.push(`- исход: ${facts.join("; ")}`);
	const c = trace.meta.stats.checks;
	if (c.run > 0 || c.failed > 0) {
		out.push(`- проверки: последний прогон ${c.run}, failed ${c.failed}`);
		for (const name of c.failedNames.slice(0, 3)) out.push(`  - падал: \`${name}\``);
	}
	out.push("");
}

function renderTask(out: string[], trace: CompressedTrace): void {
	if (trace.taskPrompts.length === 0) {
		out.push("## Задача", "", "_явных пользовательских промптов не найдено_", "");
		return;
	}
	out.push("## Задача", "");
	trace.taskPrompts.forEach((p, i) => {
		const sessionTag = trace.sessions.length > 1 ? ` [сессия ${p.sessionIndex}]` : "";
		out.push(`**${i + 1}.** ${hhmm(p.timestamp)} @L${p.logLine}${sessionTag}`);
		for (const line of p.text.split("\n")) out.push(`> ${line}`);
		out.push("");
	});
}

function renderWorkingSet(out: string[], trace: CompressedTrace, fileIndex: FileIndexEntry[]): void {
	if (trace.workingSet.length === 0) return;
	const idByPath = new Map(fileIndex.map((f) => [f.path, f.id] as const));
	const ref = (path: string): string => {
		const id = idByPath.get(path);
		return id !== undefined ? `[F${id}]` : path;
	};
	out.push("## Рабочий набор", "");
	const modified = trace.workingSet.filter((w) => w.modified);
	const read = trace.workingSet.filter((w) => !w.modified);
	for (const w of modified) {
		const diff = w.diff !== undefined ? ` +${w.diff.added}/−${w.diff.removed}` : "";
		out.push(`- изменён${diff} — ${ref(w.path)} \`${w.path}\` @L${w.modifyRefs.join(", @L")}`);
	}
	for (const w of read.slice(0, 20)) {
		out.push(`- читался ×${w.reads} — ${ref(w.path)} \`${w.path}\` @L${w.readRefs.join(", @L")}${w.readRefs.length < w.reads ? " …" : ""}`);
	}
	if (read.length > 20) out.push(`- …ещё ${read.length - 20} файлов только для чтения`);
	out.push("");
}

function renderTimeline(out: string[], trace: CompressedTrace, fileIndex: FileIndexEntry[]): void {
	out.push("## Таймлайн", "");
	let lastSessionIndex = -1;
	for (const block of trace.blocks) {
		if (block.sessionIndex !== lastSessionIndex && trace.sessions.length > 1) {
			const s = trace.sessions[block.sessionIndex - 1];
			if (s !== undefined) {
				out.push(`### — сессия ${block.sessionIndex} (\`${s.sessionId.slice(0, 8)}\`) —`, "");
			}
			lastSessionIndex = block.sessionIndex;
		}
		renderBlock(out, block, trace.sessions.length > 1, fileIndex);
	}
	if (trace.blocks.length === 0) out.push("_активности нет_", "");
}

function renderBlock(out: string[], block: TimelineBlock, multiSession: boolean, fileIndex: FileIndexEntry[]): void {
	const label = LABEL_TITLES[block.label] ?? block.label;
	const sessTag = multiSession ? ` s${block.sessionIndex}` : "";
	out.push(
		`### ${block.index} · ${hhmm(block.startedAt)} · ${label}${sessTag}`,
		"",
	);
	out.push(block.summary);
	if (block.refinedSummary !== undefined) out.push(`↳ ${block.refinedSummary}`);
	const st = block.stats;
	const statParts = [
		`вызовов ${st.calls}`,
		st.errors > 0 ? `ошибок ${st.errors}` : undefined,
		`@L${st.lineFrom}${st.lineTo !== st.lineFrom ? `–L${st.lineTo}` : ""}`,
	];
	out.push(`( ${statParts.filter((p) => p !== undefined).join(" · ")} )`, "");
	for (const tool of block.tools) out.push(`- ${substituteFileRefs(tool.text, fileIndex)}`);
	if (block.assistantText !== undefined) {
		out.push("", `→ ${substituteFileRefs(block.assistantText.replace(/\n/g, " "), fileIndex)}`);
	}
	out.push("");
}

function renderSubagents(out: string[], trace: CompressedTrace): void {
	if (trace.subagents.length === 0) return;
	out.push("## Сабагенты", "");
	for (const s of trace.subagents) {
		out.push(`- **${s.title}** — ${s.summary}`);
		const parts = [`origin: ${s.origin}`];
		if (s.logFile !== undefined) {
			const range =
				s.lineFrom !== undefined ? ` L${s.lineFrom}–L${s.lineTo ?? s.lineFrom}` : "";
			parts.push(`log: ${s.logFile}${range}`);
		}
		if (s.sessionId !== undefined) parts.push(`id: ${s.sessionId.slice(0, 8)}`);
		if (s.parentSessionIndex !== undefined) parts.push(`parent: s${s.parentSessionIndex}`);
		out.push(`  ${parts.join(" · ")}`);
	}
	out.push("");
}

function renderNotes(out: string[], trace: CompressedTrace): void {
	if (trace.notes.length === 0) return;
	out.push("## Заметки", "");
	for (const n of trace.notes) {
		const sessTag = trace.sessions.length > 1 ? ` [s${n.sessionIndex}]` : "";
		out.push(`- ${hhmm(n.timestamp)}${sessTag} ${n.text} @L${n.logLine}`);
	}
	out.push("");
}

/**
 * Self-describing recovery section (kimi-code pattern): teaches any reader —
 * human or agent — how to expand the compressed view back to 100% using the
 * append-only original logs. Stripped in the repo-bound flavor (originals are
 * not published).
 */
function renderRecovery(out: string[], trace: CompressedTrace): void {
	const multi = trace.sessions.length > 1;
	out.push("## Trace Recovery", "");
	out.push(
		`Всё, что вырезано из этого трейса, остаётся в исходных логах сессий (append-only JSONL).${multi ? " Лог каждой сессии — под своим номером в «Сессиях»." : ""} Способы восстановления:`,
	);
	out.push(
		"- томбстон `…⟨N kB, M ln, #hash, @Lстрока⟩` — результат целиком лежит в логе на строке `строка`: `sed -n '<строка>p' <logFile>`; `#hash` (первые 8 hex sha256) сверяет, что нашли именно тот результат;",
	);
	out.push(
		"- маркер `…⟨truncated: A→B chars @Lстрока, sha:#hash⟩` — середина вырезана, head+tail сохранены, полный текст — на строке `строка` того же лога;",
	);
	out.push(
		"- записи — длинный JSON: ищи по ключевому слову (`grep -n keyword <logFile>`), затем читай ровно нужную строку (`sed -n 'Np' <logFile> | jq -r '.message.content[0].text'`);",
	);
	out.push("- файлы сессии объявлены один раз в «Рабочем наборе» (`[F<id>]`), в таймлайне на них ссылаются по этим индексам.");
	out.push("");
}

export function hhmm(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "??:??";
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function cap(text: string, n: number): string {
	return text.length <= n ? text : `${text.slice(0, n - 1)}…`;
}
