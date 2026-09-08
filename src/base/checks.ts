/**
 * Test/check-run detection in tool outputs (false-green-gate practice: counts,
 * not adjectives). Only patterns with numbers count as evidence.
 */

export interface CheckObservation {
	run: number;
	failed: number;
	failedNames: string[];
}

/**
 * Extract the check summary from one tool output. Returns undefined when the
 * output doesn't look like a test/check runner summary.
 */
export function detectChecks(output: string): CheckObservation | undefined {
	const head = output.length > 8000 ? output.slice(-8000) : output;
	let run = 0;
	let failed = 0;
	const failedNames: string[] = [];

	// vitest / jest summary lines: "Tests:  2 failed | 10 passed (12)"
	for (const m of head.matchAll(/Tests?:\s*(?:(\d+)\s*failed)?\s*\|?\s*(?:(\d+)\s*passed)?/gi)) {
		const f = num(m[1]);
		const p = num(m[2]);
		if (f === undefined && p === undefined) continue;
		failed = Math.max(failed, f ?? 0);
		run = Math.max(run, (f ?? 0) + (p ?? 0));
	}

	// pytest: "5 passed, 2 failed, 1 skipped in 0.3s" / "1 failed, 8 passed"
	if (run === 0) {
		for (const m of head.matchAll(/(\d+)\s+(passed|failed)/g)) {
			const n = num(m[1]) ?? 0;
			if (m[2] === "failed") failed = Math.max(failed, n);
			run += n;
		}
	}

	// cargo: "test result: ok. 12 passed; 0 failed; 3 ignored"
	for (const m of head.matchAll(/test result:\s*\w+\.\s*(\d+) passed;\s*(\d+) failed/g)) {
		run = Math.max(run, (num(m[1]) ?? 0) + (num(m[2]) ?? 0));
		failed = Math.max(failed, num(m[2]) ?? 0);
	}

	// go test: "--- FAIL: TestName"
	for (const m of head.matchAll(/--- FAIL:\s*(\S+)/g)) {
		failed = Math.max(failed, failedNames.length === 0 ? 1 : failed + 1);
		failedNames.push(m[1] ?? "");
	}

	// runner-listed failures: "FAIL src/auth.test.ts > refresh" / "FAILED tests/test_x.py::test_y"
	for (const m of head.matchAll(/^\s*(?:FAIL|FAILED)\s+(.+?)\s*$/gm)) {
		const name = m[1]?.trim() ?? "";
		if (name.length > 0 && failedNames.length < 5 && !failedNames.includes(name)) failedNames.push(name);
	}

	if (run === 0 && failed === 0 && failedNames.length === 0) return undefined;
	return { run, failed, failedNames };
}

export function emptyChecks(): CheckObservation {
	return { run: 0, failed: 0, failedNames: [] };
}

function num(v: string | undefined): number | undefined {
	if (v === undefined) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}
