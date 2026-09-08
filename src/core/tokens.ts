/**
 * Token estimation.
 *
 * All harnesses we studied (pi, grok-cli, Hermes gateway, Claude Code fallback)
 * estimate tokens as ~chars/4 for ASCII code text. We intentionally use the
 * same cheap deterministic estimator — traces are compared by ratio, not billed.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
