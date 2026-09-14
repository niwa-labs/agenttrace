# raiseki

Takes raw session logs from coding agents (Claude Code, Codex CLI, pi, Cursor, Qwen Code, Kimi, MiniMax Code) and turns them into short markdown traces that keep the agent's reasoning (thoughts, decisions, mistakes) and drop the bulk (tool output, retries, boilerplate). Every distilled item keeps an `@L<line>` reference to the exact line of the original log. Run it locally against your own LLM endpoint, or hands-off through the built-in work server that external agents drive.

## Quick start

```bash
npm install

# deterministic trace, no LLM (instant)
raiseki distill ~/projects/myapp --out traces/myapp

# full pipeline: PASS-1 (FAST) + PASS-2 (SMART) + reasoning bank
raiseki refine ~/projects/myapp \
  --fast-model my-gateway/minimax/MiniMax-M3 \
  --model my-gateway/zai/glm-5.3-flash \
  --base-url http://127.0.0.1:10081/v1 \
  --out traces/myapp

# repo-bound flavor: no @L anchors, no private log paths, home paths masked as ~,
# project paths relative to the repo root — safe to commit alongside the code
raiseki distill ~/projects/myapp --out traces/myapp --repo-bound
```

Both commands discover sessions whose `cwd` in the log matches the given directory or any subdirectory. From a repo clone (no global install, no build step) prefix every command with `npm run raiseki --`.

## What the output looks like

An MD file with typed YAML frontmatter and a compressed timeline where every thought and action is preserved in distilled form with `@L` anchors:

```md
#### b3 · @L11–L14 · read,bash
💭 PIVOT: Config loader already normalizes 'yes'/'no' to booleans — the parser bug report is stale. @L14
`read` …/settings.py @L11 → value = cast_bool(raw) ⟨1.4kB, 29 ln, @L12⟩
`bash` find …/legacy-app/… @L11 → ERR (no output) @L13
`bash` ls …/legacy-app … @L14 → no such directory
→ Verified settings.py:87 already handles 'yes'/'no'… searching for cast_bool callers…

## Reasoning arcs
- **PIVOT** [confirmed] settings.py already normalizes 'yes'/'no' — the reported bug is stale @L12→L14
- **ERR-R** [noticed] Assumed the app lives at apps/legacy-app — find returned exit 1 @L11→L14
```

Every compressed element dereferences via `sed -n '<n>p' <logFile>`.

## How it works

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full pipeline description.

**Deterministic base** (`distill`) — turn segmentation, result tombstones, sealed facts (exit codes, test counts, diffs), `@L` anchors, session chaining, subagent folding. No LLM needed.

**Two-pass refine** (`refine`) — PASS-1 (FAST model) compresses each turn into JSON with distilled thoughts; a 0-token gate verifies anchors and facts; PASS-2 (SMART model) reads the compressed form, selectively dereferences the original via `read_log`, and emits reasoning arcs + verdict + bank items. All model outputs are JSON validated against contracts with repair-in-place in the same session.

**Agent-facing work server** (`work`) — the same pipeline driven by *external* agents instead of built-in model calls. `work init` exports Cursor chats, inventories all session logs (each assigned to a project), and builds deterministic skeletons; `work claim` hands one agent exactly one bounded batch (a ~40k-token window for pass-1, one session's grouped form for pass-2) as JSON on stdout; the agent answers and `work submit` validates the JSON against the same contracts — accept persists to sidecars/results, reject returns machine-fixable errors for repair-in-place. Layers are strict (a session's pass-2 unlocks only when every pass-1 window of *that session* is done; window *n* only after *n−1*, carrying the compression digest), claims hold leases (expired ones are reclaimable), and an append-only ledger makes every step crash-safe and resumable. `work layer` (cursor-paginated) lists a layer's jobs; `work reindex` re-splits windows (e.g. 40k → 20k tokens) without losing done work — already-compressed turns are reconciled from sidecars.

```bash
raiseki work init     --state ~/raiseki-run --claude-root ~/.claude/projects --pi-root ~/.pi/agent/sessions
raiseki work claim    --state ~/raiseki-run --layer pass1 --worker agent-1
raiseki work submit   --state ~/raiseki-run p1-<sid>-w3 < answer.json
raiseki work release  --state ~/raiseki-run p1-<sid>-w3
raiseki work status   --state ~/raiseki-run
raiseki work reindex  --state ~/raiseki-run --window-tokens 20000
raiseki work finalize --state ~/raiseki-run   # traces/<project>/*.md (private, with @L) + traces-repo/traces/<project>/*.md (same repo-bound flavor as distill --repo-bound) + bank + metrics
```

## Supported sources

| Source | Thinking | Notes |
|---|---|---|
| Claude Code | usually empty | signature-only blocks |
| Codex CLI | encrypted | summaries only |
| pi | full text | richest source |
| Qwen Code | full text | `thought:true` parts |
| Kimi CLI / Kimi Code | full text | `wire.jsonl`, two layouts |
| MiniMax Code (mcode) | full text | `messages.jsonl` |
| Cursor IDE | `bubble.thinking` | exported from `state.vscdb` (cursorDiskKV) to line-addressable JSONL |
| cursor-agent CLI | — | exported from `~/.cursor/chats/*/store.db` |

Cursor sources are ingested via the work server (`work init` exports chats to line-addressable JSONL in the state dir); `--source` for `distill`/`refine` accepts `claude,codex,pi,qwen,kimi,minimax`. Traces are assigned to a project from the session's cwd (or the Cursor workspace path) and written under `traces/<project>/`.

## Models

Any OpenAI-compatible endpoint via `--base-url`. Defaults to `anthropic/claude-sonnet-4-5` (or `$RAISEKI_MODEL`). Use `--fast-model` for a cheaper first pass — e.g. `--fast-model my-gateway/minimax/MiniMax-M3 --model my-gateway/zai/glm-5.3-flash --base-url http://localhost:10081/v1`.

## Reasoning bank

PASS-2 extracts ≤3 knowledge items per trace (`strategy` or `guardrail`) into a persistent bank (`bank/INDEX.md`, `bank/items/`, `bank/log.md`) that compounds across runs. Maturity: `candidate → confirmed` at ≥3 evidence entries.

## Documentation

- [AGENTS.md](AGENTS.md) — for coding agents: setup, source layout, the `raiseki work` protocol, invariants, and gotchas.
- [ARCHITECTURE.md](ARCHITECTURE.md) — how the pipeline works internally.

## Development

```bash
npm run test:all     # typecheck + lint + tests
npm run raiseki   # CLI without build (tsx)
```

Node ≥ 22.19, ESM. Dependencies: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `yaml`.

## License

MIT
