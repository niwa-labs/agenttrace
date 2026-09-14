#!/usr/bin/env node
/**
 * raiseki — compress coding-agent session logs (claude, codex, pi, qwen,
 * kimi, minimax; cursor via the work server) into token-efficient,
 * losslessly-referenced MD traces.
 *
 *   raiseki distill [rootDir]  — deterministic base trace (fast, no LLM)
 *   raiseki refine  [rootDir]  — full pipeline: streaming FAST pass + SMART pass + bank
 */

import { parseArgs } from "node:util";
import { basename, join, resolve } from "node:path";
import { runDistill } from "./cli/pipeline.js";
import { runRefine } from "./pipeline/pipeline.js";
import { runWorkCli } from "./work/cli.js";

type CliValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

interface Parsed {
	command: string;
	positionals: string[];
	values: CliValues;
}

const COMMON_OPTIONS = {
	out: { type: "string" },
	only: { type: "string" },
	max: { type: "string" },
	model: { type: "string", default: process.env["RAISEKI_MODEL"] ?? "anthropic/claude-sonnet-4-5" },
	"fast-model": { type: "string", default: process.env["RAISEKI_FAST_MODEL"] },
	"base-url": { type: "string", default: process.env["RAISEKI_BASE_URL"] },
	"api-key": { type: "string", default: process.env["RAISEKI_API_KEY"] ?? "stub" },
} as const;

function parse(): Parsed {
	const argv = process.argv.slice(2);
	const command = argv[0] ?? "distill";
	if (command === "--help" || command === "-h") {
		printUsage();
		process.exit(0);
	}
	if (command !== "distill" && command !== "refine" && command !== "work") {
		console.error(`unknown command: ${command}`);
		printUsage();
		process.exit(1);
	}
	type OptionSpec = NonNullable<NonNullable<Parameters<typeof parseArgs>[0]>["options"]>;
	const options: OptionSpec =
		command === "distill"
			? {
					...COMMON_OPTIONS,
					source: { type: "string", default: "claude,codex" },
					"no-chain": { type: "boolean", default: false },
					"chain-gap": { type: "string", default: "45" },
					"repo-bound": { type: "boolean", default: false },
				}
			: {
					...COMMON_OPTIONS,
					source: { type: "string", default: "claude,codex,pi" },
					"window-tokens": { type: "string", default: "40000" },
					"turn-tokens": { type: "string", default: "8000" },
				};
	const { positionals, values } = parseArgs({
		args: argv.slice(1),
		allowPositionals: true,
		options,
	});
	return { command, positionals, values };
}

function printUsage(): void {
	console.log(`raiseki — сжатые трейсы агентских сессий

Использование:
  raiseki distill [rootDir] [options]     детерминированный трейс-скелет (без LLM)
    --out <dir>          куда писать (по умолчанию ./traces)
    --source <list>      claude,codex,pi,qwen,kimi,minimax (по умолчанию claude,codex)
    --no-chain           не сливать связанные сессии
    --chain-gap <min>    зазор для слияния, минут (45)
    --repo-bound         вариант для коммита в репозиторий: без @L-якорей и абсолютных путей

  raiseki refine [rootDir] [options]      полный: FAST-проход + SMART + банк
    --fast-model <p/id>  простая модель ($RAISEKI_FAST_MODEL; по умолчанию = --model)
    --model <p/id>       умная модель ($RAISEKI_MODEL; anthropic/claude-sonnet-4-5)
    --base-url <url>     OpenAI-совместимый эндпоинт ($RAISEKI_BASE_URL)
    --api-key <key>      ключ ($RAISEKI_API_KEY, по умолчанию stub)
    --window-tokens <n>  окно pass-1 в токенах (40000)
    --turn-tokens <n>    бюджет хода (8000)
    --source <list>      claude,codex,pi,qwen,kimi,minimax (по умолчанию claude,codex,pi)
    --max <n> / --only <substr>

Общее: обе команды матчат сессии по cwd (текущая директория и поддиры).
`);
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
	if (typeof v !== "string") return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

function parseSources(v: string): ("claude" | "codex" | "pi" | "qwen" | "kimi" | "minimax")[] {
	const out: ("claude" | "codex" | "pi" | "qwen" | "kimi" | "minimax")[] = [];
	for (const part of v.split(",")) {
		const s = part.trim();
		if (s === "claude" || s === "codex" || s === "pi" || s === "qwen" || s === "kimi" || s === "minimax") out.push(s);
	}
	return out.length > 0 ? out : ["claude", "codex"];
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv[0] === "work") {
		// agent-facing work server: own subcommand router, JSON protocol
		process.exitCode = await runWorkCli(argv.slice(1));
		return;
	}
	const { command, positionals, values } = parse();
	const rootDir = resolve(positionals[0] ?? process.cwd());

	if (command === "distill") {
		const outDir = resolve(str(values["out"]) ?? join(rootDir, "traces"));
		const sources = parseSources(str(values["source"]) ?? "claude,codex");
		const chainGap = num(values["chain-gap"]) ?? 45;
		const only = str(values["only"]);
		const report = await runDistill({
			rootDir,
			outDir,
			sources,
			chain: { enabled: values["no-chain"] !== true, tightGapMinutes: 5, looseGapMinutes: chainGap },
			...(only !== undefined ? { only } : {}),
			...(values["repo-bound"] === true ? { repoBound: true } : {}),
		});
		console.log(`просмотрено логов: ${report.logsScanned}, распарсено: ${report.logsParsed}`);
		console.log(`трейсов: ${report.traces.length} → ${outDir}`);
		for (const t of report.traces) {
			console.log(
				`  ${basename(t.file)}  [${t.kind}] sessions=${t.sessions} tools=${t.toolCalls} ~${t.tokensTrace} tok (из ~${t.tokensOriginal}, ×${t.ratio}) verdict=${t.verdict}`,
			);
		}
		return;
	}

	// refine
	const outDir = resolve(str(values["out"]) ?? join(rootDir, "traces"));
	const sources = parseSources(str(values["source"]) ?? "claude,codex,pi");
	const fastModel = str(values["fast-model"]);
	const smartModel = str(values["model"]) ?? "anthropic/claude-sonnet-4-5";
	const baseUrl = str(values["base-url"]);
	const apiKey = str(values["api-key"]);
	const max = num(values["max"]);
	const only = str(values["only"]);
	const reports = await runRefine({
		rootDir,
		outDir,
		sources,
		fastModel: fastModel ?? smartModel,
		smartModel,
		...(baseUrl !== undefined ? { baseUrl } : {}),
		...(apiKey !== undefined ? { apiKey } : {}),
		windowTokens: num(values["window-tokens"]) ?? 40_000,
		turnTokens: num(values["turn-tokens"]) ?? 8_000,
		...(max !== undefined ? { maxTraces: max } : {}),
		...(only !== undefined ? { only } : {}),
	});
	console.log(`fast: ${fastModel ?? smartModel} · smart: ${smartModel}`);
	console.log(`трейсов: ${reports.length} → ${outDir}`);
	for (const r of reports) {
		console.log(
			`  ${r.file}: ходов ${r.turns}, покрытие ${r.coverage}, ×${r.ratio}, fallback ${r.fallbacks}, споров ${r.disputes}${r.verdict !== undefined ? `, вердикт: ${r.verdict}` : ""}`,
		);
	}
}

main().catch((err: unknown) => {
	console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
