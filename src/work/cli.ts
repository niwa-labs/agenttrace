/**
 * Agent-facing CLI for the work server (`sd work ...`).
 *
 * Every command prints exactly one JSON object to stdout (machine protocol);
 * human-readable progress goes to stderr. Agents drive the pipeline layer by
 * layer: `claim` → do the work → `submit` (JSON on stdin) → exit.
 *
 *   sd work init     --state <dir> [roots/cursor flags]   build state (resumable)
 *   sd work status   --state <dir>                        counters per layer/project
 *   sd work claim    --state <dir> --layer <L> --worker <name>
 *   sd work submit   --state <dir> <jobId>                JSON body on stdin
 *   sd work release  --state <dir> <jobId>
 *   sd work layer    --state <dir> <L> [--cursor] [--limit]
 *   sd work finalize --state <dir>                        traces + bank + metrics
 */

import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runInit } from "./init.js";
import { claimJob, listLayerPage, releaseJob, statusSummary, type Layer } from "./jobs.js";
import { submitJob } from "./submit.js";
import { finalize } from "./finalize.js";
import { runReindex } from "./reindex.js";
import { defaultState, workPaths } from "./state.js";

export async function runWorkCli(argv: string[]): Promise<number> {
	const sub = argv[0] ?? "--help";
	if (sub === "--help" || sub === "-h") {
		printWorkUsage();
		return 0;
	}
	const rest = argv.slice(1);
	const shared = {
		state: { type: "string", default: join(process.cwd(), ".sd-work") },
	} as const;

	try {
		switch (sub) {
			case "init": {
				const { values } = parseArgs({
					args: rest,
					allowPositionals: true,
					options: {
						...shared,
						"claude-root": { type: "string", multiple: true },
						"codex-root": { type: "string", multiple: true },
						"pi-root": { type: "string", multiple: true },
						"no-cursor": { type: "boolean", default: false },
						"cursor-ide-db": { type: "string" },
						"cursor-agent-root": { type: "string" },
						"only": { type: "string" },
						"window-tokens": { type: "string", default: "40000" },
						"turn-tokens": { type: "string", default: "8000" },
						"lease-min": { type: "string", default: "45" },
					},
				});
				const stateDir = resolve(str(values["state"]) ?? shared.state.default);
				const state = defaultState(stateDir);
				const claudeRoots = strs(values["claude-root"]) ?? [join(homedir(), ".claude-my", "projects"), join(homedir(), ".claude", "projects")];
				const piRoots = strs(values["pi-root"]) ?? [join(homedir(), ".pi", "agent", "sessions")];
				state.roots.claude = claudeRoots.map(expand);
				state.roots.codex = (strs(values["codex-root"]) ?? []).map(expand);
				state.roots.pi = piRoots.map(expand);
				if (values["no-cursor"] !== true) {
					state.cursorIde = {
						db: expand(str(values["cursor-ide-db"]) ?? join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")),
						out: "logs/cursor-ide",
					};
					state.cursorAgent = {
						chatsRoot: expand(str(values["cursor-agent-root"]) ?? join(homedir(), ".cursor", "chats")),
						workspaceStorageDir: join(homedir(), "Library", "Application Support", "Cursor", "User", "workspaceStorage"),
						out: "logs/cursor-agent",
					};
				}
				state.segOptions = {
					turnBudgetTokens: num(values["turn-tokens"]) ?? 8_000,
					windowBudgetTokens: num(values["window-tokens"]) ?? 40_000,
				};
				state.leaseMinutes = num(values["lease-min"]) ?? 45;
				const report = await runInit(stateDir, state);
				if (values["only"] !== undefined && typeof values["only"] === "string") {
					// scoped run: drop registry records not matching the filter
					const { readRegistry, writeRegistry } = await import("./registry.js");
					const paths = workPaths(stateDir);
					const kept = (await readRegistry(paths)).filter((r) => r.logFile.includes(values["only"] as string));
					await writeRegistry(paths, kept);
					emit({ ok: true, ...report, sessions: kept.length, note: `registry filtered to ${kept.length} sessions by --only` });
					return 0;
				}
				emit({ ok: true, ...report });
				return 0;
			}
			case "status": {
				const { values } = parseArgs({ args: rest, allowPositionals: true, options: shared });
				emit({ ok: true, ...(await statusSummary(resolve(str(values["state"]) ?? shared.state.default))) });
				return 0;
			}
			case "claim": {
				const { values } = parseArgs({
					args: rest,
					allowPositionals: true,
					options: {
						...shared,
						layer: { type: "string" },
						worker: { type: "string", default: "anonymous" },
						project: { type: "string" },
					},
				});
				const layer = str(values["layer"]) as Layer | undefined;
				if (layer !== "pass1" && layer !== "pass2") {
					emit({ ok: false, error: `--layer must be pass1|pass2, got ${String(layer)}` });
					return 1;
				}
				const stateDir = resolve(str(values["state"]) ?? shared.state.default);
				const { loadState, workPaths: wp } = await import("./state.js");
				const leaseMinutes = (await loadState(wp(stateDir))).leaseMinutes;
				const project = str(values["project"]);
				const result = await claimJob(stateDir, layer, str(values["worker"]) ?? "anonymous", leaseMinutes, project !== undefined ? { project } : undefined);
				emit(result);
				return result.ok ? 0 : 0; // not-ok claims are protocol answers, not crashes
			}
			case "submit": {
				const { values, positionals } = parseArgs({
					args: rest,
					allowPositionals: true,
					options: shared,
				});
				const jobId = positionals[0];
				if (jobId === undefined) {
					emit({ ok: false, error: "usage: sd work submit <jobId>  (JSON on stdin)" });
					return 1;
				}
				const stdin = await readStdin();
				const result = await submitJob(resolve(str(values["state"]) ?? shared.state.default), jobId, stdin);
				emit(result);
				return result.ok ? 0 : 1;
			}
			case "release": {
				const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: shared });
				const jobId = positionals[0];
				if (jobId === undefined) {
					emit({ ok: false, error: "usage: sd work release <jobId>" });
					return 1;
				}
				emit(await releaseJob(resolve(str(values["state"]) ?? shared.state.default), jobId));
				return 0;
			}
			case "layer": {
				const { values, positionals } = parseArgs({
					args: rest,
					allowPositionals: true,
					options: { ...shared, cursor: { type: "string" }, limit: { type: "string", default: "20" } },
				});
				const layer = positionals[0] as Layer | undefined;
				if (layer !== "pass1" && layer !== "pass2") {
					emit({ ok: false, error: "usage: sd work layer <pass1|pass2> [--cursor <tok>] [--limit <n>]" });
					return 1;
				}
				const page = await listLayerPage(resolve(str(values["state"]) ?? shared.state.default), layer, str(values["cursor"]), num(values["limit"]) ?? 20);
				emit({ ok: true, ...page });
				return 0;
			}
			case "finalize": {
				const { values } = parseArgs({ args: rest, allowPositionals: true, options: shared });
				const report = await finalize(resolve(str(values["state"]) ?? shared.state.default));
				emit({ ok: true, ...report });
				return 0;
			}
			case "reindex": {
				const { values } = parseArgs({
					args: rest,
					allowPositionals: true,
					options: { ...shared, "window-tokens": { type: "string" }, "turn-tokens": { type: "string" } },
				});
				const windowTokens = num(values["window-tokens"]);
				const turnTokens = num(values["turn-tokens"]);
				const report = await runReindex(resolve(str(values["state"]) ?? shared.state.default), {
					...(windowTokens !== undefined ? { windowTokens } : {}),
					...(turnTokens !== undefined ? { turnTokens } : {}),
				});
				emit({ ok: true, ...report });
				return 0;
			}
			default:
				emit({ ok: false, error: `unknown work subcommand: ${sub}` });
				printWorkUsage();
				return 1;
		}
	} catch (err) {
		emit({ ok: false, error: err instanceof Error ? err.message : String(err) });
		return 1;
	}
}

// --- helpers ---

function emit(value: unknown): void {
	process.stdout.write(JSON.stringify(value) + "\n");
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function strs(v: unknown): string[] | undefined {
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
	if (typeof v === "string") return [v];
	return undefined;
}

function num(v: unknown): number | undefined {
	if (typeof v !== "string") return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

function expand(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

function printWorkUsage(): void {
	console.error(`sd work — агентский режим: скрипт раздаёт данные слоями, агент сжимает и сдаёт результат

  sd work init --state <dir>     собрать состояние: cursor-экспорт, реестр сессий, det-скелеты
      --claude-root <dir> ...    корни логов claude (по умолчанию ~/.claude-my/projects, ~/.claude/projects)
      --codex-root <dir> ...     корни логов codex (по умолчанию выключены)
      --pi-root <dir> ...        корни логов pi (~/.pi/agent/sessions)
      --no-cursor                не импортировать Cursor (IDE + agent CLI)
      --only <substr>            оставить в реестре только логи с подстрокой
  sd work status --state <dir>                    счётчики по слоям/проектам
  sd work claim --state <dir> --layer pass1 --worker <name>
      взять одну пачку (окно ~40k tok); pass2 откроется, когда весь pass1 готов
  sd work submit --state <dir> <jobId> < result.json
      сдать результат (JSON на stdin); ошибки валидации → ok:false, чини и сдавай снова
  sd work release --state <dir> <jobId>           отказаться от пачки
  sd work layer --state <dir> pass1 [--cursor <tok>] [--limit <n>]
      постраничный обзор пачек слоя
  sd work finalize --state <dir>                  трейсы по проектам + банк + метрики
  sd work reindex --state <dir> [--window-tokens N] [--turn-tokens N]
      перестроить окна (меньшие пачки); уже сжатые ходы зачитываются по сайдкару

Все ответы — один JSON-объект на stdout.
`);
}
