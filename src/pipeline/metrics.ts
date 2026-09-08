/**
 * Pass metrics — collected without a human, written to metrics.jsonl.
 * These decide model/window/schema changes; without them tuning is taste.
 */

export interface TurnCounters {
	total: number;
}

export interface BlockCounters {
	total: number;
	fallbacks: number;
	retries: number;
	disputes: number;
	quoteValid: number;
	thoughtsBySource: Map<string, number>;
	thoughtsByKind: Map<string, number>;
}

export interface PassMetrics {
	turns: number;
	blocksCompressed: number;
	blocksFallback: number;
	detOnly: number;
	retries: number;
	disputes: number;
	thoughtsBySource: Record<string, number>;
	thoughtsByKind: Record<string, number>;
	quoteValidRate: number;
	coverage: number;
	tokensOriginal: number;
	tokensCompressed: number;
	compressionRatio: number;
	readLogCalls: number;
	pass2Retries: number;
	usageFast: { requests: number; inputTokens: number; outputTokens: number };
	usageSmart: { requests: number; inputTokens: number; outputTokens: number };
}

export function computeMetrics(input: {
	turns: TurnCounters;
	blocks: BlockCounters;
	detOnly: number;
	tokensOriginal: number;
	tokensCompressed: number;
	readLogCalls: number;
	pass2Retries: number;
	usageFast: { requests: number; inputTokens: number; outputTokens: number };
	usageSmart: { requests: number; inputTokens: number; outputTokens: number };
}): PassMetrics {
	const blocksCompressed = input.blocks.total - input.blocks.fallbacks;
	const quoteValid = input.blocks.total > 0 ? input.blocks.quoteValid / input.blocks.total : 1;
	const coverage = input.turns.total > 0 ? input.blocks.total / input.turns.total : 0;
	const ratio = input.tokensCompressed > 0 ? input.tokensOriginal / input.tokensCompressed : 0;
	return {
		turns: input.turns.total,
		blocksCompressed,
		blocksFallback: input.blocks.fallbacks,
		detOnly: input.detOnly,
		retries: input.blocks.retries,
		disputes: input.blocks.disputes,
		thoughtsBySource: Object.fromEntries(input.blocks.thoughtsBySource),
		thoughtsByKind: Object.fromEntries(input.blocks.thoughtsByKind),
		quoteValidRate: Math.round(quoteValid * 1000) / 1000,
		coverage: Math.round(coverage * 1000) / 1000,
		tokensOriginal: input.tokensOriginal,
		tokensCompressed: input.tokensCompressed,
		compressionRatio: Math.round(ratio * 10) / 10,
		readLogCalls: input.readLogCalls,
		pass2Retries: input.pass2Retries,
		usageFast: input.usageFast,
		usageSmart: input.usageSmart,
	};
}
