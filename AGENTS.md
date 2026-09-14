# AGENTS.md

`raiseki` compresses coding-agent session logs (Claude Code, Codex CLI, pi, Cursor, Qwen Code, Kimi, MiniMax Code) into token-efficient Markdown traces with lossless `@L<line>` references back into the original logs.

Three entry points: `distill` (deterministic base trace, no LLM) · `refine` (two-pass LLM pipeline: FAST compression → 0-token gate → SMART reasoning arcs + bank) · `work` (agent-facing server: the program never calls an LLM — external agents claim bounded batches and submit JSON for machine validation). Details: [README.md](README.md), internals: [ARCHITECTURE.md](ARCHITECTURE.md).

## Commands

```bash
npm install
npm run raiseki -- <command>   # CLI via tsx, no build step (Node ≥ 22.19)
npm run raiseki -- work --help # work-server protocol reference
npm run test:all                  # vitest --typecheck + eslint + tsc --noEmit
```

`npm run test:all` must pass before every commit. `npm run build` is only needed for publishing.

Refine env: `RAISEKI_MODEL`, `RAISEKI_FAST_MODEL`, `RAISEKI_BASE_URL`, `RAISEKI_API_KEY` — any OpenAI-compatible gateway.

## Layout (`src/`)

- `base/` — deterministic trace builder: turn segmentation, `@L` anchors, sealed facts, chaining. No LLM.
- `pipeline/` — refine: pass1/pass2 agents, gate, groupform, contracts/validators, sidecar, bank, metrics.
- `sources/` — per-agent adapters → one `NormalizedSession` shape (`claude`, `codex`, `pi`, `qwen`, `kimi`, `minimax`, `cursor-ide`, `cursor-agent`).
- `work/` — work server: state, registry, jobs, claim/submit, append-only ledger, reindex, finalize.
- CLI entry: `index.ts`; `test/` — vitest suites, per-source fixtures in `test/fixtures/`, type tests in `test/type/`.

## Rules

- Strict TS with `exactOptionalPropertyTypes`: never assign `undefined` to an optional prop — conditional spread `...(x !== undefined ? { x } : {})`. ESM: relative imports need the `.js` suffix.
- New features require tests (parsers, validators, work-server behavior are all covered today).
- Work state is program-owned: submit only via `work submit`; the ledger is append-only; never hand-edit the state dir or sidecars.
- Layers are strict per session: pass-2 unlocks only after all pass-1 windows of that session are done; window *n* after *n−1* (digest chaining).
- Everything models/agents produce (actions, thoughts, arcs, bank items) is ENGLISH-ONLY, regardless of session language.
- The `node:sqlite` ExperimentalWarning at startup is expected (Cursor export), not a failure.
- Gateway rate limits are environment problems, not repo bugs — do not "fix" them in code.
