import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { parseClaudeSession } from "../src/sources/claude/parse.js";
import { parseCodexSession } from "../src/sources/codex/parse.js";
import { groupSession } from "../src/base/group.js";
import { buildChains } from "../src/base/chain.js";
import { distill } from "../src/base/trace-builder.js";
import { renderTraceMd } from "../src/base/render-md.js";
import { parse } from "yaml";
import type { NormalizedSession } from "../src/model/session.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "claude-session.jsonl");
const CODEX = join(import.meta.dirname, "fixtures", "codex-session.jsonl");
const SUB = join(import.meta.dirname, "fixtures", "codex-subagent.jsonl");

type LooseSessionPatch = Partial<{ [K in keyof NormalizedSession]: NormalizedSession[K] | undefined }>;

function cloneWith(s: NormalizedSession, patch: LooseSessionPatch): NormalizedSession {
	// exactOptionalPropertyTypes: explicit cast is the point of the helper
	return { ...s, ...patch } as unknown as NormalizedSession;
}

describe("chaining", () => {
	it("merges sessions with a tight time gap", async () => {
		const a = await parseClaudeSession(FIXTURE);
		const b = cloneWith(a, {
			sessionId: "fix-0002",
			startedAt: "2026-06-01T10:03:00.000Z", // 2 min after a ends
			endedAt: "2026-06-01T10:04:00.000Z",
			leafUuid: undefined,
		});
		const groupings = new Map([
			[a.sessionId, groupSession(a.entries)],
			[b.sessionId, groupSession(b.entries)],
		]);
		const chains = buildChains([a, b], groupings, {
			enabled: true,
			tightGapMinutes: 5,
			looseGapMinutes: 45,
		});
		expect(chains).toHaveLength(1);
		expect(chains[0]?.sessions).toHaveLength(2);
		expect(chains[0]?.reasons).toContain("time-gap");
	});

	it("links via leafUuid regardless of gap", async () => {
		const a = await parseClaudeSession(FIXTURE);
		const b = cloneWith(a, {
			sessionId: "fix-0003",
			startedAt: "2026-06-02T10:00:00.000Z",
			endedAt: "2026-06-02T11:00:00.000Z",
			leafUuid: a.lastUuid,
		});
		const groupings = new Map([
			[a.sessionId, groupSession(a.entries)],
			[b.sessionId, groupSession(b.entries)],
		]);
		const chains = buildChains([a, b], groupings, {
			enabled: true,
			tightGapMinutes: 5,
			looseGapMinutes: 45,
		});
		expect(chains).toHaveLength(1);
		expect(chains[0]?.reasons).toContain("leaf-uuid");
	});

	it("keeps distant unrelated sessions apart", async () => {
		const a = await parseClaudeSession(FIXTURE);
		const b = cloneWith(a, {
			sessionId: "fix-0004",
			startedAt: "2026-07-01T10:00:00.000Z",
			endedAt: "2026-07-01T11:00:00.000Z",
			leafUuid: undefined,
		});
		const groupings = new Map([
			[a.sessionId, groupSession(a.entries)],
			[b.sessionId, groupSession(b.entries)],
		]);
		const chains = buildChains([a, b], groupings, {
			enabled: true,
			tightGapMinutes: 5,
			looseGapMinutes: 45,
		});
		expect(chains).toHaveLength(2);
	});
});

describe("distill + render", () => {
	it("produces a single trace with typed yaml frontmatter", async () => {
		const a = await parseClaudeSession(FIXTURE);
		const traces = distill([a], { projectDir: "/proj/demo", chain: { enabled: true, tightGapMinutes: 5, looseGapMinutes: 45 } });
		expect(traces).toHaveLength(1);
		const md = renderTraceMd(traces[0] as NonNullable<typeof traces[0]>);

		const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
		expect(fm).not.toBeNull();
		const meta = parse(fm?.[1] ?? "") as Record<string, unknown>;
		expect(meta["schema"]).toBe("session-trace/v1");
		expect(meta["kind"]).toBe("single");
		const stats = meta["stats"] as Record<string, unknown>;
		expect((stats["toolCalls"] as number)).toBe(5);
		expect((stats["compressionRatio"] as number)).toBeGreaterThan(1);

		// body sections
		expect(md).toContain("# Починить тесты");
		expect(md).toContain("## Verdict");
		expect(md).toContain("## Задача");
		expect(md).toContain("почини тесты в apps/dist");
		expect(md).toContain("## Таймлайн");
		expect(md).toContain("@L");
		expect(md).toContain("## Сабагенты");
		expect(md).toContain("repair");
	});

	it("folds codex subagents into the parent trace", async () => {
		const parent = await parseCodexSession(CODEX);
		const sub = await parseCodexSession(SUB);
		const traces = distill([parent, sub], { projectDir: "/proj/demo", chain: { enabled: true, tightGapMinutes: 5, looseGapMinutes: 45 } });
		expect(traces).toHaveLength(1);
		expect(traces[0]?.meta.stats.subagentRuns).toBe(1);
		const md = renderTraceMd(traces[0] as NonNullable<typeof traces[0]>);
		expect(md).toContain("codex-сабагент");
	});

	it("emits chain kind with reasons for merged sessions", async () => {
		const a = await parseClaudeSession(FIXTURE);
		const b = cloneWith(a, {
			sessionId: "fix-0005",
			startedAt: "2026-06-01T10:03:00.000Z",
			endedAt: "2026-06-01T10:04:00.000Z",
			leafUuid: undefined,
		});
		const traces = distill([a, b], { projectDir: "/proj/demo", chain: { enabled: true, tightGapMinutes: 5, looseGapMinutes: 45 } });
		expect(traces).toHaveLength(1);
		expect(traces[0]?.meta.kind).toBe("chain");
		const md = renderTraceMd(traces[0] as NonNullable<typeof traces[0]>);
		expect(md).toContain("сессия 2");
	});

	it("yaml roundtrip keeps verdict structure", async () => {
		const a = await parseClaudeSession(FIXTURE);
		const traces = distill([a], { projectDir: "/proj/demo", chain: { enabled: false, tightGapMinutes: 5, looseGapMinutes: 45 } });
		const md = renderTraceMd(traces[0] as NonNullable<typeof traces[0]>);
		const fm = /^---\n([\s\S]*?)\n---\n/.exec(md)?.[1] ?? "";
		const meta = parse(fm) as { verdict: { status: string; origin: string } };
		expect(["success", "partial", "failure", "unknown"]).toContain(meta.verdict.status);
		expect(meta.verdict.origin).toBe("deterministic");
	});
});
