/**
 * Submit acceptance: validate an external agent's answer for a claimed job
 * and persist it (pass-1 → sidecar records; pass-2 → results file).
 *
 * Rejection returns machine-fixable error strings (repair-in-place: the same
 * agent resubmits until accepted). Sidecar/results are written BEFORE the
 * ledger event, so an interrupted submit loses nothing.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	asPass1Block,
	asPass1Digest,
	asPass2Output,
	extractJsonObject,
	validatePass1Block,
	validatePass1Digest,
	validatePass2,
	type Pass1Block,
	type Pass1Digest,
} from "../pipeline/contracts.js";
import { appendSidecar, SIDECAR_SCHEMA_VERSION, type SidecarRecord } from "../pipeline/sidecar.js";
import { appendLedger, deriveJobStates, readLedger } from "./ledger.js";
import { withLock } from "./lock.js";
import { parseJobId, type Pass1Job } from "./jobs.js";
import { workPaths, type WorkPaths } from "./state.js";

export interface SubmitOk {
	ok: true;
	jobId: string;
	layer: "pass1" | "pass2";
	accepted: string;
	sessionProgress?: { windowsDone: number; windowsTotal: number };
	note?: string;
}

export interface SubmitFail {
	ok: false;
	jobId: string;
	errors: string[];
}

export async function submitJob(stateDir: string, jobId: string, stdinText: string): Promise<SubmitOk | SubmitFail> {
	const paths = workPaths(stateDir);
	const parsedId = parseJobId(jobId); // throws on malformed id
	return withLock(stateDir, async () => {
		const states = deriveJobStates(await readLedger(paths.ledgerFile));
		const st = states.get(jobId);
		if (st === undefined) return { ok: false as const, jobId, errors: [`job ${jobId} was never claimed — run "work claim" first`] };
		if (st.status === "done") return { ok: false as const, jobId, errors: [`job ${jobId} already done`] };

		const body = extractJsonObject(stdinText);
		if (body === undefined) {
			return reject(paths, jobId, st.fails, ["stdin contains no JSON object"]);
		}
		return parsedId.layer === "pass1" ? acceptPass1(paths, jobId, body, st.fails) : acceptPass2(paths, jobId, body, st.fails);
	});
}

async function acceptPass1(paths: WorkPaths, jobId: string, body: unknown, fails: number): Promise<SubmitOk | SubmitFail> {
	const payload = await readPayload<Pass1Job>(paths, jobId);
	if (payload === undefined) return reject(paths, jobId, fails, [`payload file missing for ${jobId} — claim again`]);

	const blocks = (body as { blocks?: unknown }).blocks;
	if (!Array.isArray(blocks) || blocks.length === 0) {
		return reject(paths, jobId, fails, ['answer must be {"blocks": [...], "digest"?: {...}} with a non-empty blocks array']);
	}

	const errors: string[] = [];
	const byTurn = new Map(payload.turns.map((t) => [t.turnIndex, t]));
	const seen = new Set<number>();
	const validated: { turn: Pass1Job["turns"][number]; block: Pass1Block }[] = [];

	for (const raw of blocks) {
		const turnIndex = (raw as { turnIndex?: unknown }).turnIndex;
		if (typeof turnIndex !== "number" || !Number.isInteger(turnIndex)) {
			errors.push("every block needs an integer turnIndex matching the job's turns");
			continue;
		}
		if (seen.has(turnIndex)) {
			errors.push(`duplicate block for turnIndex ${turnIndex}`);
			continue;
		}
		const turn = byTurn.get(turnIndex);
		if (turn === undefined) {
			errors.push(`turnIndex ${turnIndex} is not part of this window (valid: ${[...byTurn.keys()].join(", ")})`);
			continue;
		}
		seen.add(turnIndex);
		const vErrors = validatePass1Block(raw, {
			fromLine: turn.fromLine,
			toLine: turn.toLine,
			quoteIds: new Set(turn.quoteIds),
		});
		// semantic checks beyond the schema
		const thoughts = (raw as { thoughts?: unknown }).thoughts;
		if (
			vErrors.length === 0 &&
			turn.thoughtQs.length > 0 &&
			Array.isArray(thoughts) &&
			thoughts.length === 0
		) {
			vErrors.push(
				`turn ${turnIndex} contains [THINKING] (${turn.thoughtQs.join(", ")}) — thoughts must not be empty: distill the main idea (source="thinking", q=<id>)`,
			);
		}
		if (vErrors.length === 0) {
			const anchor = (raw as { anchor?: { fromLine?: unknown; toLine?: unknown } }).anchor;
			const from = anchor?.fromLine;
			const to = anchor?.toLine;
			if (from !== turn.fromLine || to !== turn.toLine) {
				vErrors.push(`anchor must be exactly {fromLine: ${turn.fromLine}, toLine: ${turn.toLine}} for turnIndex ${turnIndex}`);
			}
		}
		if (vErrors.length > 0) {
			errors.push(`turnIndex ${turnIndex}: ${vErrors.join("; ")}`);
			continue;
		}
		validated.push({ turn, block: asPass1Block(raw) });
	}

	for (const turnIndex of byTurn.keys()) {
		if (!seen.has(turnIndex)) errors.push(`missing block for turnIndex ${turnIndex}`);
	}

	let digest: Pass1Digest | undefined;
	if (payload.isLastWindow) {
		const d = (body as { digest?: unknown }).digest;
		if (d !== undefined && d !== null) {
			const dErrors = validatePass1Digest(d);
			if (dErrors.length > 0) errors.push(`digest: ${dErrors.join("; ")}`);
			else digest = asPass1Digest(d);
		}
	} else {
		const d = (body as { digest?: unknown }).digest;
		if (d === undefined || d === null) {
			errors.push("digest is required for non-final windows (continuity into the next window)");
		} else {
			const dErrors = validatePass1Digest(d);
			if (dErrors.length > 0) errors.push(`digest: ${dErrors.join("; ")}`);
			else digest = asPass1Digest(d);
		}
	}

	if (errors.length > 0) return reject(paths, jobId, fails, errors);

	// persist: sidecar first, ledger second
	const ts = new Date().toISOString();
	const records: SidecarRecord[] = validated.map(({ turn, block }) => ({
		type: "block",
		schemaVersion: SIDECAR_SCHEMA_VERSION,
		promptHash: payload.promptHash,
		sessionId: payload.sessionId,
		logFile: payload.logFile,
		fromLine: turn.fromLine,
		toLine: turn.toLine,
		sliceHash: turn.sliceHash,
		windowIndex: payload.windowIndex,
		toolNames: turn.toolNames,
		tokens: turn.tokens,
		result: block,
		retries: fails,
		fallback: block.fallback === true,
		ts,
	}));
	if (digest !== undefined) {
		records.push({
			type: "digest",
			schemaVersion: SIDECAR_SCHEMA_VERSION,
			promptHash: payload.promptHash,
			sessionId: payload.sessionId,
			logFile: payload.logFile,
			windowIndex: payload.windowIndex,
			sliceHash: `${payload.windowFromLine}:${payload.windowToLine}`,
			digest,
			ts,
		});
	}
	await appendSidecar(payload.logFile, records);


	await appendLedger(paths.ledgerFile, [{ ts, ev: "submit-ok", jobId, worker: payload.worker }]);
	return {
		ok: true,
		jobId,
		layer: "pass1",
		accepted: `${validated.length} block(s)${digest !== undefined ? " + digest" : ""}`,
		sessionProgress: { windowsDone: payload.windowIndex, windowsTotal: payload.windowCount },
	};
}

async function acceptPass2(paths: WorkPaths, jobId: string, body: unknown, fails: number): Promise<SubmitOk | SubmitFail> {
	const errors = validatePass2(body);
	if (errors.length > 0) return reject(paths, jobId, fails, errors);
	const output = asPass2Output(body);
	const { sessionId } = parseJobId(jobId);

	// arcs must anchor inside the log; out-of-range anchors are dropped, not fatal
	let dropped = 0;
	const payload = await readPayload<{ logLines?: number }>(paths, jobId);
	const logLines = payload?.logLines;
	if (logLines !== undefined) {
		const before = output.arcs.length;
		output.arcs = output.arcs.filter((a) => Number.isFinite(a.fromLine) && a.fromLine >= 1 && a.fromLine <= logLines);
		dropped = before - output.arcs.length;
	}

	const ts = new Date().toISOString();
	await writeFile(
		join(paths.resultsDir, `pass2-${sessionId}.json`),
		JSON.stringify({ sessionId, output, retries: fails, ts }, null, "\t"),
		"utf8",
	);
	await appendLedger(paths.ledgerFile, [{ ts, ev: "submit-ok", jobId }]);
	return {
		ok: true,
		jobId,
		layer: "pass2",
		accepted: `${output.arcs.length} arc(s), ${output.items.length} item(s), verdict ${output.verdict.status}`,
		...(dropped > 0 ? { note: `${dropped} arc(s) dropped: anchor outside the log` } : {}),
	};
}

async function reject(paths: WorkPaths, jobId: string, fails: number, errors: string[]): Promise<SubmitFail> {
	await appendLedger(paths.ledgerFile, [{ ts: new Date().toISOString(), ev: "submit-fail", jobId, errors }]);
	// keep a hard cap so a broken agent cannot spin forever
	if (fails + 1 >= 20) {
		await appendLedger(paths.ledgerFile, [{ ts: new Date().toISOString(), ev: "release", jobId }]);
		return { ok: false, jobId, errors: [...errors, "too many rejected submissions (20) — job released, claim it again"] };
	}
	return { ok: false, jobId, errors };
}

async function readPayload<T>(paths: WorkPaths, jobId: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(join(paths.jobsDir, `${jobId}.json`), "utf8")) as T;
	} catch {
		return undefined;
	}
}
