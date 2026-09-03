# session-distiller

Compresses coding-agent session logs (Claude Code, Codex CLI, pi) into token-efficient MD traces (×25–180) with lossless `@L<line>` references into the original JSONL — so a session can be fed to an LLM for analysis without shipping megabytes of raw log.

## Quick start

```bash
npm install

# deterministic trace, no LLM (instant)
npm run sd -- distill ~/projects/myapp --out traces/myapp

# full pipeline: PASS-1 (FAST) + PASS-2 (SMART) + reasoning bank
npm run sd -- refine ~/projects/myapp \
  --fast-model bifrost/minimax/MiniMax-M3 \
  --model bifrost/zai/glm-5.3-flash \
  --base-url http://127.0.0.1:10081/v1 \
  --out traces/myapp
```

Both commands discover sessions whose `cwd` in the log matches the given directory or any subdirectory.

## What the output looks like

An MD file with typed YAML frontmatter and a compressed timeline where every thought and action is preserved in distilled form with `@L` anchors:

```md
#### b3 · @L11–L14 · read,bash
💭 PIVOT: Code already emits '1'/'0', not Python True — the reported bug is stale. @L14
`read` …/settings.py @L11 → response = super().get(…) ⟨1.4kB, 29 ln, @L12⟩
`bash` find …/legacy-app/… @L11 → ERR (no output) @L13
`bash` ls …/legacy-app … @L14 → нет результата
→ Verified settings.py:564 already uses '1'/'0'… searching for cast_bool…

## Дуги рассуждения
- **PIVOT** [confirmed] settings.py already emits '1'/'0' — the reported bug is stale @L12→L14
- **ERR-R** [noticed] Assumed legacy-app at apps/legacy-app — find returned exit 1 @L11→L14
```

Every compressed element dereferences via `sed -n '<n>p' <logFile>`.

## How it works

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full pipeline description.

**Deterministic base** (`distill`) — turn segmentation, result tombstones, sealed facts (exit codes, test counts, diffs), `@L` anchors, session chaining, subagent folding. No LLM needed.

**Two-pass refine** (`refine`) — PASS-1 (FAST model) compresses each turn into JSON with distilled thoughts; a 0-token gate verifies anchors and facts; PASS-2 (SMART model) reads the compressed form, selectively dereferences the original via `read_log`, and emits reasoning arcs + verdict + bank items. All model outputs are JSON validated against contracts with repair-in-place in the same session.

## Supported sources

| Source | Thinking | Notes |
|---|---|---|
| Claude Code | usually empty | signature-only blocks |
| Codex CLI | encrypted | summaries only |
| pi | full text | richest source |

## Models

Any OpenAI-compatible endpoint via `--base-url`. Defaults to `anthropic/claude-sonnet-4-5` (or `$SD_MODEL`). Use `--fast-model` for a cheaper first pass — e.g. `--fast-model bifrost/agnes/agnes-2.5-flash --model bifrost/minimax/MiniMax-M3 --base-url http://localhost:10081/v1`.

## Reasoning bank

PASS-2 extracts ≤3 knowledge items per trace (`strategy` or `guardrail`) into a persistent bank (`bank/INDEX.md`, `bank/items/`, `bank/log.md`) that compounds across runs. Maturity: `candidate → confirmed` at ≥3 evidence entries.

## Development

```bash
npm run test:all    # typecheck + lint + tests
npm run sd          # CLI without build (tsx)
```

Node ≥ 22.19, ESM. Dependencies: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `yaml`.

## License

MIT
