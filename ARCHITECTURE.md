# Architecture

## Pipeline overview

```
raw session logs (JSONL)
  │
  ├──► deterministic base ──► base trace (.md, no LLM)
  │
  └──► PASS-1 (FAST model) ──► sidecar (JSONL)
         │                         │
         ▼                         ▼
       gate ──► grouped form ──► PASS-2 (SMART model)
                                    │
                                    ▼
                          trace (.md) + bank/ + metrics.jsonl
```

Two entry points share the same deterministic layer:

- **`distill`** — base trace only (no LLM, instant). Useful as a quick map of a session.
- **`refine`** — full pipeline. The base layer feeds the LLM stages.

A third rendering, the **repo-bound flavor** (`distill --repo-bound`, also written by
`work finalize` into `traces-repo/<project>/`), is the same trace stripped of everything
that only makes sense next to the original logs: `@L` anchors, private log pointers,
absolute paths (home directories masked as `~`, project paths made repo-relative). It is
the flavor meant to be committed into a shared repository.

## Core design principle — model judgment, not mechanical rules

The product of this pipeline is a **useful, heavily compressed snapshot** of a session.
What makes a snapshot useful cannot be decided by mechanical rules: it takes judgment
about meaning — what a turn was *for*, which operator instructions steer the work,
which details can be dropped. That judgment is performed by the **models**: pass-1
distills the intent of each turn (including operator turns — abstracted to neutral
third-person intent, never verbatim quotes), pass-2 connects the reasoning arcs.

**Deterministic post-processing (regex redaction, masking) is explicitly the wrong
tool for this.** Mechanical sanitization either leaks (patterns it doesn't know) or
shreds context (patterns it does). Determinism is reserved for what machines are
genuinely good at: addressing (`@L<line>`, quote hashes), sealed machine facts, and
schema validation. Everything that requires understanding *meaning* — abstraction,
importance, compression — belongs to the model stages. When in doubt, put the
constraint in the model's contract, not in a post-filter.

## Deterministic layer (`src/base/`, `src/v2/../core/`)

Everything that requires no semantic judgment is done in code:

- **Turn segmentation** — the log is cut into turns (one assistant move: thinking + tool calls + results). Turn boundaries respect call↔result pairing; a call is never separated from its result.
- **Result truncation** — tool results lose their middle (head + tail kept, `…⟨size, lines, @L⟩` appended). Thinking is passed intact.
- **Sealed facts** — exit codes, test-run counts, diff stats, interruption markers, compaction boundaries. These are machine truth; the gate compares model claims against them.
- **Anchors** — every entry gets an `@L<line>` pointer into the original JSONL. Thought-bearing entries additionally get a `q<hash>` id.
- **Empty-thinking detection** — signature-only thinking blocks (some models emit these) are marked as "reasoning not recorded" rather than silently dropped.

## PASS-1 — FAST model (`src/pipeline/pass1.ts`)

One agent session per window (~40k tokens of turns). The model sees thinking intact, tool results truncated, and sealed facts withheld. It outputs one JSON object per turn:

```json
{
  "anchor": {"fromLine": 11, "toLine": 14},
  "action": "Verified settings.py:564 already uses '1'/'0'…",
  "thoughts": [
    {"kind": "PIVOT", "source": "thinking", "text": "the reported bug is stale", "q": "q01016a"}
  ],
  "factsClaimed": {"checks": {"run": 10, "failed": 2}}
}
```

Responses are validated against a contract; on failure the validator error is fed back into the same session (repair-in-place, 3-step ladder: full fix → minimal fix → deterministic fallback).

Output is written to a sidecar file (`<logFile>.pass1.jsonl`) keyed by `(fromLine, toLine, sliceHash, promptHash)` — re-runs skip already-processed turns.

## Gate (`src/pipeline/gate.ts`)

Free (0-token) verification:
- Anchor range must exist within the turn's lines.
- `thought.q` must reference an entry inside the anchor.
- `factsClaimed` is compared against sealed facts; contradictions become `⚠ dispute` lines visible to pass-2.

## Grouped form (`src/pipeline/groupform.ts`)

The compressed "replica" session that pass-2 reads: 💭 thought lines, ⚠ disputes, one-line tool calls with `@L`, `×N` collapse of identical consecutive calls, and `→` micro-summary per turn. If the form exceeds ~25k tokens it degrades in two steps (strip result previews → strip tool lines entirely, thoughts always kept).

## PASS-2 — SMART model (`src/pipeline/pass2.ts`)

One agent session per trace. Reads the grouped form (never the raw log — `read_log` tool available within a budget). Produces:

- **Arcs** — reasoning trajectories: `H → refuted@B19`, `ERR-R → noticed: never`, etc.
- **REASONING-INDEX** — derived from arcs (single source of truth, no model-side drift).
- **Verdict** — one line, grounded in the form and sealed facts.
- **Items** — ≤3 reasoning knowledge units per trace, fed into the bank.

Arcs with anchors outside the log are dropped by the gate.

## Bank (`src/pipeline/bank.ts`)

Persistent, never rolled back. Items follow the ReasoningBank schema (`{title, description, content, polarity: strategy|guardrail}`). Merged by exact key (normalized title + primary subject); duplicates reinforce existing items (`evidence.push`). Maturity: `candidate → confirmed` at ≥3 evidence entries.

## Session adapters (`src/sources/`)

| Source | Log location | Thinking |
|---|---|---|
| Claude Code | `~/.claude/projects/<escaped-cwd>/*.jsonl` | usually empty (signature-only) |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | encrypted (`encrypted_content`) |
| pi | `~/.pi/agent/sessions/--<escaped-cwd>--/*.jsonl` | full text, the richest source |

All adapters produce the same `NormalizedSession` shape (`src/model/session.ts`). The pipeline is source-agnostic.
