import { describe, expectTypeOf, it } from "vitest";
import type { TraceMeta, SingleTraceMeta, ChainedTraceMeta, CompressedTrace } from "../../src/model/trace.js";
import type { SessionEntry, ToolCallEntry, NormalizedSession } from "../../src/model/session.js";
import { refTag, tombstone } from "../../src/core/refs.js";
import { estimateTokens } from "../../src/core/tokens.js";
import { detectChecks, type CheckObservation } from "../../src/base/checks.js";

describe("trace model types", () => {
	it("TraceMeta is a discriminated union on kind", () => {
		expectTypeOf<TraceMeta>().toExtend<SingleTraceMeta | ChainedTraceMeta>();

		const meta = {} as TraceMeta;
		if (meta.kind === "chain") {
			expectTypeOf(meta).toExtend<ChainedTraceMeta>();
			expectTypeOf(meta.chainReasons).toExtend<string[]>();
			expectTypeOf(meta.sessions).toExtend<[object, ...object[]]>();
		} else {
			expectTypeOf(meta).toExtend<SingleTraceMeta>();
			expectTypeOf(meta.session).toExtend<object>();
		}
	});

	it("frontmatter fields have declared types", () => {
		const meta = {} as TraceMeta;
		expectTypeOf(meta.schema).toEqualTypeOf<"session-trace/v1">();
		expectTypeOf(meta.stats.approxTokensTrace).toEqualTypeOf<number>();
		expectTypeOf(meta.verdict.status).toExtend<"success" | "partial" | "failure" | "unknown">();
		expectTypeOf(meta.outcome.interrupted).toEqualTypeOf<boolean>();
	});

	it("session entries narrow by kind", () => {
		const entry = {} as SessionEntry;
		if (entry.kind === "tool_call") {
			expectTypeOf(entry).toExtend<ToolCallEntry>();
			expectTypeOf(entry.input).toEqualTypeOf<unknown>();
		}
		if (entry.kind === "user_text") {
			expectTypeOf(entry.text).toEqualTypeOf<string>();
		}
	});

	it("normalized session exposes optional refs", () => {
		const s = {} as NormalizedSession;
		expectTypeOf(s.leafUuid).toEqualTypeOf<string | undefined>();
		expectTypeOf(s.role).toExtend<"main" | "subagent">();
		expectTypeOf(s.entries).toExtend<SessionEntry[]>();
	});
});

describe("core helpers", () => {
	it("ref helpers return template strings", () => {
		expectTypeOf(refTag).returns.toExtend<string>();
		expectTypeOf(tombstone).returns.toExtend<string>();
		expectTypeOf(tombstone).parameters.toExtend<[number, number, string, number]>();
	});

	it("token estimator takes and returns numbers", () => {
		expectTypeOf(estimateTokens).parameters.toExtend<[string]>();
		expectTypeOf(estimateTokens("x")).toEqualTypeOf<number>();
	});

	it("check observations are concrete shapes", () => {
		const obs = detectChecks("x");
		expectTypeOf(obs).toExtend<CheckObservation | undefined>();
		expectTypeOf<CheckObservation["failedNames"]>().toExtend<string[]>();
	});

	it("compressed trace body arrays line up", () => {
		const t = {} as CompressedTrace;
		expectTypeOf(t.blocks).toExtend<{ index: number; sessionIndex: number; summary: string }[]>();
		expectTypeOf(t.workingSet).toExtend<{ path: string; reads: number }[]>();
	});
});
