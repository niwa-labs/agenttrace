/**
 * Append-only job ledger: `<stateDir>/ledger.jsonl`.
 *
 * Every mutation (claim, submit-ok, submit-fail, release) is one JSON line.
 * The derived job state is computed by folding events in order, so a crashed
 * process never loses accepted work: sidecars/results are written before the
 * ledger line, and a torn last line is tolerated on read.
 */

import { appendFile, readFile } from "node:fs/promises";

export type LedgerEvent =
	| { ts: string; ev: "claim"; jobId: string; worker: string; leaseUntil: string }
	| { ts: string; ev: "submit-ok"; jobId: string; worker?: string; note?: string }
	| { ts: string; ev: "submit-fail"; jobId: string; worker?: string; errors: string[] }
	| { ts: string; ev: "release"; jobId: string; worker?: string };

export type JobStatus = "pending" | "claimed" | "done";

export interface JobState {
	jobId: string;
	status: JobStatus;
	worker?: string | undefined;
	leaseUntil?: string | undefined;
	/** submit-fail count for this claim epoch (fed back as `retries`). */
	fails: number;
	claims: number;
}

export async function readLedger(file: string): Promise<LedgerEvent[]> {
	const events: LedgerEvent[] = [];
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		return events;
	}
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			events.push(JSON.parse(line) as LedgerEvent);
		} catch {
			// torn tail write — ignore
		}
	}
	return events;
}

export async function appendLedger(file: string, events: LedgerEvent[]): Promise<void> {
	if (events.length === 0) return;
	await appendFile(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

/** Fold events into per-job state. Later events win; lease expiry is *not* folded in here. */
export function deriveJobStates(events: LedgerEvent[]): Map<string, JobState> {
	const states = new Map<string, JobState>();
	const ensure = (jobId: string): JobState => {
		let s = states.get(jobId);
		if (s === undefined) {
			s = { jobId, status: "pending", fails: 0, claims: 0 };
			states.set(jobId, s);
		}
		return s;
	};
	for (const ev of events) {
		const s = ensure(ev.jobId);
		switch (ev.ev) {
			case "claim":
				s.status = "claimed";
				s.worker = ev.worker;
				s.leaseUntil = ev.leaseUntil;
				s.claims++;
				s.fails = 0;
				break;
			case "submit-ok":
				s.status = "done";
				s.leaseUntil = undefined;
				break;
			case "submit-fail":
				s.fails++;
				break;
			case "release":
				s.status = "pending";
				s.worker = undefined;
				s.leaseUntil = undefined;
				break;
		}
	}
	return states;
}

/** A claimed job whose lease ran out may be re-claimed by another worker. */
export function leaseActive(s: JobState, now = Date.now()): boolean {
	if (s.status !== "claimed") return false;
	if (s.leaseUntil === undefined) return false;
	const t = Date.parse(s.leaseUntil);
	return Number.isFinite(t) && t > now;
}
