# AGENTS.md

Guidance for coding agents working inside this repository.

## What this repo is

`raiseki` compresses coding-agent session logs (Claude Code, Codex CLI, pi, Cursor) into token-efficient Markdown traces with lossless `@L<line>` references back into the original JSONL. It has two halves:

- a **two-pass LLM pipeline** — `distill` (deterministic base trace, no LLM) and `refine` (FAST pass-1 compression + gate + SMART pass-2 reasoning arcs + reasoning bank);
- an **agent-facing work server** (`sd work`) — the same pipeline driven by *external* agents: the program hands out bounded job batches, agents do the model work and submit results for machine validation.

## Setup

- Node ≥ 22.19, `npm install`. There is **no build step** — everything runs through tsx: `npm run sd -- <command>`.
- `npm run test:all` = `vitest run --typecheck` + `eslint .` + `tsc --noEmit`. Run it before committing and keep it green (currently: 111 tests, 0 failures).
- Strict TypeScript: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, ESM with mandatory `.js` suffixes on relative imports, tab indentation.

## Source layout (`src/`)

- `pipeline/` — the two-pass refinement: `pass1`/`pass2` agents, 0-token `gate`, `groupform`, hand-rolled JSON `contracts` + validators, `sidecar` persistence, `bank`, `metrics`, rendering.
- `base/` — deterministic trace builder (turn segmentation, `@L` anchors, sealed facts, session chaining, MD rendering). No LLM.
- `sources/` — session adapters producing one normalized shape: `claude/`, `codex/`, `pi/`, `cursor/` (IDE `state.vscdb` export + cursor-agent CLI chats).
- `core/` — shared text/token/reference helpers; `agent/` — model client setup; `model/` — normalized session/trace types.
- `work/` — the work server: state, session registry, jobs index, claim/submit/release, append-only ledger, lock, reindex, finalize. `index.ts` + `cli/pipeline.ts` route `distill`/`refine`; `work/cli.ts` routes `sd work`.

## Two entry modes — pick deliberately

1. **`distill` / `refine`** — the script calls the LLM itself. Model/endpoint via flags or env: `SD_MODEL`, `SD_FAST_MODEL`, `SD_BASE_URL`, `SD_API_KEY`; any OpenAI-compatible gateway through `--base-url`. `--source` accepts `claude,codex,pi`.
2. **`work`** — the script **never** calls an LLM. External agents drive the pipeline: claim a batch → do the compression → submit the answer as JSON on stdin. Use this mode when the "compute" is you (an agent), not a scripted model call.

## `sd work` protocol (quick reference)

Every subcommand prints exactly **one JSON object on stdout**; progress and usage go to stderr. Default state dir: `./.sd-work`.

```bash
sd work init     --state <dir> [roots/flags]   # build/resume state
sd work claim    --state <dir> --layer pass1 --worker <name>
sd work submit   --state <dir> <jobId>          # JSON on stdin
sd work release  --state <dir> <jobId>
sd work layer    --state <dir> pass1 [--cursor <tok>] [--limit <n>]
sd work status   --state <dir>
sd work reindex  --state <dir> [--window-tokens N] [--turn-tokens N]
sd work finalize --state <dir>
```

- `init` — exports Cursor chats, inventories session logs into `sessions.jsonl` (each session assigned to a project), builds deterministic skeletons (`det/`) and `jobs-index.jsonl`. Roots: `--claude-root`, `--codex-root`, `--pi-root` (repeatable), `--no-cursor`, `--cursor-ide-db`, `--cursor-agent-root`, `--only <substr>`, plus `--window-tokens`/`--turn-tokens`/`--lease-min`. Resumable.
- `claim --layer pass1|pass2` — one bounded batch as JSON on stdout: pass-1 ≈ one window of turns (~40k tokens by default); pass-2 = one session's grouped form + facts footer. `ok:false` answers (`layer-locked`, `all-claimed`, `empty`) are protocol responses, not crashes.
- `submit <jobId>` — validator accepts (`ok:true`, persisted) or rejects with `ok:false, errors[]` of machine-fixable messages: fix exactly those and resubmit — the job stays yours. Protocol: give up after 3 rejected attempts and `release`; the server hard-auto-releases after 20 rejects. Resubmitting an already-done job is a safe no-op.
- `finalize` — writes `traces/<project>/*.md`, `bank/`, `metrics.jsonl`. Idempotent; runnable any time.
- `reindex` — re-splits windows (e.g. 40k → 20k tokens) without losing done work: turns already compressed under the same prompt hash are reconciled from sidecars and marked done automatically.

State dir contents: `state.json`, `sessions.jsonl` (registry), `jobs-index.jsonl`, `det/` (skeletons), `ledger.jsonl` (append-only journal), `jobs/` (claimed payloads), `results/` (accepted pass-2), `traces/`, `bank/`, `metrics.jsonl`, `logs/cursor-*/` (Cursor exports), `lock`.

## Invariants — do not break

- **Only the program writes persistent state.** Agents deliver work exclusively via `work submit` (JSON on stdin). Never hand-edit the state dir, sidecars, or ledger.
- The ledger is **append-only**; sidecars/results are written **before** the ledger event, so an interrupted submit loses nothing (crash-safe, resumable).
- **Layers are strict, per session:** a pass-2 job unlocks only when every pass-1 window of that same session is done; pass-1 window *n* is claimable only after window *n−1* (digest chaining carries context forward).
- Claims hold **leases** (default 45 min, `--lease-min`); expired leases are silently reclaimable — interrupted agents lose nothing.
- Submit validation is strict: anchors must match the turn's exact `(fromLine, toLine)`; `thoughts` must be non-empty when the turn contains `[THINKING]`; `q` ids must match shown quote ids; `digest` is mandatory for non-final windows.
- **ENGLISH-ONLY** for everything models/agents produce (actions, thoughts, digests, arcs, verdicts, bank items), regardless of the session's language.
- Contract length caps (validator-enforced): `action` ≤ 400 chars, thought `text` ≤ 400, digest `goal` ≤ 300. The worker protocol asks for tighter budgets (action ≤ 240, thought ≤ 320, goal ≤ 200, belief ≤ 300) — aim for those.

## Tests

- Vitest suites live in `test/`; per-source log fixtures in `test/fixtures/` (one JSONL per source format).
- New features require tests — parsers, contracts/validators edge cases, and work-server behavior all have coverage. Type-level tests live in `test/type/`.
- `npm run test:all` must pass before every commit.

## Gotchas

- `exactOptionalPropertyTypes` is on: never assign `undefined` to an optional property — use conditional spread: `...(x !== undefined ? { x } : {})`.
- The `node:sqlite` experimental warning at startup is expected (Cursor export uses it) — not a failure.
- Host account concurrency/quota limits (rate limits from the model gateway) are environment problems, not repo bugs — do not "fix" them in code.

## Living example

A state dir is fully self-contained: `work init` + the CLI are all an agent needs — no access to the operator's home files is expected or required.
