import { describe, expect, it } from "vitest";
import { computeMetrics, type BlockCounters } from "../src/pipeline/metrics.js";

function counters(overrides: Partial<BlockCounters> = {}): BlockCounters {
	return {
		total: 8,
		fallbacks: 2,
		retries: 3,
		disputes: 1,
		quoteValid: 6,
		thoughtsBySource: new Map([["thinking", 4], ["inferred", 2]]),
		thoughtsByKind: new Map([["H", 5], ["?", 1]]),
		...overrides,
	};
}

const base = {
	turns: { total: 10 },
	blocks: counters(),
	detOnly: 1,
	tokensOriginal: 4000,
	tokensCompressed: 800,
	readLogCalls: 12,
	pass2Retries: 1,
	usageFast: { requests: 5, inputTokens: 100, outputTokens: 50 },
	usageSmart: { requests: 2, inputTokens: 30, outputTokens: 20 },
};

describe("v2 metrics computeMetrics", () => {
	it("fills every field from the counters", () => {
		const m = computeMetrics({ ...base });
		expect(m.turns).toBe(10);
		expect(m.blocksCompressed).toBe(6); // total - fallbacks
		expect(m.blocksFallback).toBe(2);
		expect(m.detOnly).toBe(1);
		expect(m.retries).toBe(3);
		expect(m.disputes).toBe(1);
		expect(m.thoughtsBySource).toEqual({ thinking: 4, inferred: 2 });
		expect(m.thoughtsByKind).toEqual({ H: 5, "?": 1 });
		expect(m.quoteValidRate).toBe(0.75); // 6/8
		expect(m.coverage).toBe(0.8); // 8/10
		expect(m.tokensOriginal).toBe(4000);
		expect(m.tokensCompressed).toBe(800);
		expect(m.compressionRatio).toBe(5); // 4000/800
		expect(m.readLogCalls).toBe(12);
		expect(m.pass2Retries).toBe(1);
		expect(m.usageFast).toEqual({ requests: 5, inputTokens: 100, outputTokens: 50 });
		expect(m.usageSmart).toEqual({ requests: 2, inputTokens: 30, outputTokens: 20 });
	});

	it("handles zero turns and zero blocks without NaN", () => {
		const m = computeMetrics({
			...base,
			turns: { total: 0 },
			blocks: counters({
				total: 0,
				fallbacks: 0,
				retries: 0,
				disputes: 0,
				quoteValid: 0,
				thoughtsBySource: new Map(),
				thoughtsByKind: new Map(),
			}),
		});
		expect(m.turns).toBe(0);
		expect(m.coverage).toBe(0); // no turns → coverage 0
		expect(m.quoteValidRate).toBe(1); // no blocks → vacuously valid
		expect(m.blocksCompressed).toBe(0);
		expect(m.thoughtsBySource).toEqual({});
		expect(m.thoughtsByKind).toEqual({});
	});

	it("reports 100% fallback as zero compressed blocks", () => {
		const m = computeMetrics({ ...base, blocks: counters({ total: 5, fallbacks: 5 }) });
		expect(m.blocksCompressed).toBe(0);
		expect(m.blocksFallback).toBe(5);
	});

	it("guards the compression ratio when nothing was compressed", () => {
		const m = computeMetrics({ ...base, tokensOriginal: 500, tokensCompressed: 0 });
		expect(m.compressionRatio).toBe(0); // not Infinity
	});

	it("rounds rate/coverage to 3 decimals and ratio to 1", () => {
		const m = computeMetrics({
			...base,
			blocks: counters({ total: 3, fallbacks: 0, quoteValid: 1 }),
			tokensOriginal: 100,
			tokensCompressed: 300,
		});
		expect(m.quoteValidRate).toBe(0.333); // 1/3
		expect(m.coverage).toBe(0.3); // 3/10
		expect(m.compressionRatio).toBe(0.3); // 100/300 = 0.33…
	});
});
