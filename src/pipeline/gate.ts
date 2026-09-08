/**
 * Gate: free verification of pass-1 results against the anchor system and
 * sealed facts. Produces disputes — never silent acceptance.
 */

import { renderFacts, type SealedFacts } from "./facts.js";
import type { TurnAnchors } from "./anchors.js";
import type { Pass1Block } from "./contracts.js";

export interface Dispute {
	kind: "checks" | "exitCode";
	claimed: string;
	sealed: string;
	line: number;
}

export interface GateResult {
	/** thought quote verified against the turn's quote ids (else downgraded). */
	quoteValid: boolean;
	/** anchor corrected to the deterministic turn range. */
	anchorCorrected: boolean;
	disputes: Dispute[];
}

export function gateBlock(
	block: Pass1Block,
	anchors: TurnAnchors,
	sealed: SealedFacts,
): GateResult {
	const issues: GateResult = { quoteValid: true, anchorCorrected: false, disputes: [] };

	// anchor correction: semantic class error — fix deterministically, don't drop
	if (block.anchor.fromLine < anchors.fromLine || block.anchor.toLine > anchors.toLine) {
		block.anchor = { fromLine: anchors.fromLine, toLine: anchors.toLine };
		issues.anchorCorrected = true;
	}

	// thought quote membership
	for (const t of block.thoughts) {
		if (t.source === "thinking" || t.source === "narration") {
			if (t.q === undefined || !anchors.byQ.has(t.q)) {
				// downgrade: an unprovable thought becomes an inference
				t.source = "inferred";
				issues.quoteValid = false;
			}
		}
	}

	// sealed-fact disputes
	const claimed = block.factsClaimed;
	if (claimed !== null && claimed !== undefined) {
		if (claimed.checks !== undefined && sealed.checks !== undefined) {
			if (
				claimed.checks.run !== sealed.checks.run ||
				claimed.checks.failed !== sealed.checks.failed
			) {
				issues.disputes.push({
					kind: "checks",
					claimed: `${claimed.checks.run} run / ${claimed.checks.failed} failed`,
					sealed: `${sealed.checks.run} run / ${sealed.checks.failed} failed`,
					line: block.anchor.toLine,
				});
			}
		}
		if (claimed.exitCode !== undefined && sealed.lastExitCode !== undefined && claimed.exitCode !== sealed.lastExitCode) {
			issues.disputes.push({
				kind: "exitCode",
				claimed: `exit ${claimed.exitCode}`,
				sealed: `exit ${sealed.lastExitCode}`,
				line: block.anchor.toLine,
			});
		}
	}
	void renderFacts;
	return issues;
}
