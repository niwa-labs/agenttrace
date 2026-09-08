/**
 * Finalize: everything the layers have produced → artifacts.
 *
 * For every session with an accepted pass-2 result: rebuild the grouped form,
 * compute metrics, render the trace into `traces/<project>/`, merge bank
 * items, append metrics.jsonl. Re-runnable; sessions without pass-2 are
 * skipped and reported so the operator knows what is missing.
 */

import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadBank, mergeItems, saveBank } from "../pipeline/bank.js";
import { computeMetrics } from "../pipeline/metrics.js";
import { renderTrace } from "../pipeline/render.js";
import { toTraceSessionRef } from "../base/trace-builder.js";
import type { Pass2Output } from "../pipeline/contracts.js";
import { loadDet } from "./det.js";
import { readRegistry, projectSlugOf, type SessionRecord } from "./registry.js";
import { loadState, workPaths } from "./state.js";
import { toRepoBound } from "./repobound.js";
import { buildSessionView } from "./view.js";
import type { DetSession } from "./det.js";

interface Pass2ResultFile {
	sessionId: string;
	output: Pass2Output;
	retries: number;
	ts: string;
}

export interface FinalizeReport {
	traces: { file: string; sessionId: string; project: string; ratio: number; coverage: number }[];
	skippedNoPass2: string[];
	skippedNoDet: string[];
	bankItems: number;
	projects: string[];
}

export async function finalize(stateDir: string, models: { fast: string; smart: string } = { fast: "external-agent", smart: "external-agent" }): Promise<FinalizeReport> {
	const paths = workPaths(stateDir);
	const state = await loadState(paths);
	const records = await readRegistry(paths);
	const bank = await loadBank(paths.bankDir);
	await mkdir(paths.tracesDir, { recursive: true });
	await mkdir(paths.tracesRepoDir, { recursive: true });
	await mkdir(paths.resultsDir, { recursive: true });

	const report: FinalizeReport = { traces: [], skippedNoPass2: [], skippedNoDet: [], bankItems: 0, projects: [] };
	const projects = new Set<string>();

	for (const record of records) {
		const det = await loadDet(paths, record.sessionId);
		if (det === undefined) {
			report.skippedNoDet.push(record.sessionId);
			continue;
		}
		let resultFile: Pass2ResultFile | undefined;
		try {
			resultFile = JSON.parse(await readFile(join(paths.resultsDir, `pass2-${record.sessionId}.json`), "utf8")) as Pass2ResultFile;
		} catch {
			report.skippedNoPass2.push(record.sessionId);
			continue;
		}

		const view = await buildSessionView(record, det, state.pass1PromptHash, state.pass2InputTokenBudget);
		const tokensOriginal = Math.ceil(record.logBytes / 4);
		const metrics = computeMetrics({
			turns: { total: view.counts.turns },
			blocks: {
				total: view.counts.turns,
				fallbacks: view.counts.fallbacks,
				retries: view.counts.retries,
				disputes: view.counts.disputes,
				quoteValid: view.counts.quoteValid,
				thoughtsBySource: view.counts.thoughtsBySource,
				thoughtsByKind: view.counts.thoughtsByKind,
			},
			detOnly: view.counts.detOnly,
			tokensOriginal,
			tokensCompressed: view.groupedTokens,
			readLogCalls: -1, // external agent — not observable
			pass2Retries: resultFile.retries,
			usageFast: { requests: 0, inputTokens: 0, outputTokens: 0 },
			usageSmart: { requests: 0, inputTokens: 0, outputTokens: 0 },
		});

		const project = projectSlugOf(det.projectDir ?? record.cursorMeta?.workspacePath);
		projects.add(project);
		const outDir = join(paths.tracesDir, project);
		await mkdir(outDir, { recursive: true });

		const sessionRef = toTraceSessionRef(makePseudoSession(record, det));
		const md = renderTrace({
			sessions: [sessionRef],
			projectDir: det.projectDir ?? record.cursorMeta?.workspacePath ?? "",
			groupedForm: view.groupedForm,
			pass2: resultFile.output,
			metrics,
			generatedAt: new Date().toISOString(),
			models,
		});
		const outName = `${(det.startedAt ?? "1970-01-01").slice(0, 10)}-${record.sessionId.slice(0, 8)}.md`;
		await writeFile(join(outDir, outName), md, "utf8");
		// repo-bound flavor: no @L refs, relative paths — committable to a public repo
		const projectDirAbs = det.projectDir ?? record.cursorMeta?.workspacePath;
		const repoDir = join(paths.tracesRepoDir, project);
		await mkdir(repoDir, { recursive: true });
		await writeFile(join(repoDir, outName), toRepoBound(md, projectDirAbs), "utf8");

		await appendFile(
			paths.metricsFile,
			JSON.stringify({
				ts: new Date().toISOString(),
				file: `${project}/${outName}`,
				sessionId: record.sessionId,
				source: record.source,
				project,
				...metrics,
			}) + "\n",
			"utf8",
		);

		if (resultFile.output.items.length > 0) {
			mergeItems(bank, resultFile.output.items, `${basename(record.logFile)}@${record.sessionId.slice(0, 8)}`, new Date().toISOString());
			report.bankItems += resultFile.output.items.length;
		}

		report.traces.push({ file: `${project}/${outName}`, sessionId: record.sessionId, project, ratio: metrics.compressionRatio, coverage: metrics.coverage });
	}

	await saveBank(paths.bankDir, bank);
	report.projects = [...projects].sort();
	return report;
}

/** Minimal shape `toTraceSessionRef` needs, reconstructed from det + registry. */
function makePseudoSession(record: SessionRecord, det: DetSession) {
	const startedAt = det.startedAt ?? record.cursorMeta?.createdAt ?? "1970-01-01T00:00:00.000Z";
	const endedAt = det.endedAt ?? record.cursorMeta?.lastUpdatedAt ?? startedAt;
	const title = det.title ?? record.cursorMeta?.title;
	return {
		source: record.source,
		sessionId: record.sessionId,
		logFile: record.logFile,
		logLines: det.logLines,
		logBytes: record.logBytes,
		cwd: det.projectDir ?? record.cursorMeta?.workspacePath ?? "",
		startedAt,
		endedAt,
		...(title !== undefined ? { title } : {}),
		role: det.role,
		entries: [],
	};
}
