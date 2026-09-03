/**
 * Reasoning bank: persistent, never-rolled-back store of reasoning items
 * (ReasoningBank schema) with an index, a maturity counter, and an audit log.
 * Layout: bank.json (machine truth) + INDEX.md + log.md (human view).
 */

import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Pass2Item } from "./contracts.js";

export interface BankItem {
	title: string;
	description: string;
	content: string;
	polarity: "strategy" | "guardrail";
	subject: string[];
	/** {trace, line} pairs — lineage walkable to the raw log. */
	evidence: { trace: string; line: number }[];
	firstSeen: string;
	lastSeen: string;
	status: "candidate" | "confirmed";
}

export interface BankState {
	items: BankItem[];
}

const EMPTY: BankState = { items: [] };

export async function loadBank(dir: string): Promise<BankState> {
	try {
		const raw = await readFile(join(dir, "bank.json"), "utf8");
		const parsed = JSON.parse(raw) as { items?: BankItem[] };
		return { items: parsed.items ?? [] };
	} catch {
		return { items: [...EMPTY.items] };
	}
}

function normalizeTitle(title: string): string {
	return title.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Merge pass-2 items into the bank. Exact key: normalized title + primary
 * subject. A matching item gains an evidence entry; otherwise a new item is
 * appended (minimal consolidation, ReasoningBank-style).
 */
export function mergeItems(
	state: BankState,
	incoming: Pass2Item[],
	traceRef: string,
	now: string,
): { added: number; reinforced: number } {
	let added = 0;
	let reinforced = 0;
	for (const item of incoming) {
		const subject = item.subject.length > 0 ? item.subject : ["general"];
		const key = normalizeTitle(item.title);
		const existing = state.items.find(
			(b) => normalizeTitle(b.title) === key && b.subject[0] === subject[0],
		);
		if (existing !== undefined) {
			existing.evidence.push({ trace: traceRef, line: 0 });
			existing.lastSeen = now;
			if (existing.evidence.length >= 3) existing.status = "confirmed";
			reinforced++;
		} else {
			state.items.push({
				title: item.title,
				description: item.description,
				content: item.content,
				polarity: item.polarity,
				subject,
				evidence: [{ trace: traceRef, line: 0 }],
				firstSeen: now,
				lastSeen: now,
				status: "candidate",
			});
			added++;
		}
	}
	return { added, reinforced };
}

/** Persist machine truth + human view. */
export async function saveBank(dir: string, state: BankState): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "bank.json"), JSON.stringify(state, null, 2), "utf8");
	const lines = state.items
		.map(
			(it) =>
				`- **${it.title}** [${it.polarity}] (${it.status}, evidence ×${it.evidence.length}) — ${it.description} · subjects: ${it.subject.join(", ")}`,
		)
		.join("\n");
	await writeFile(
		join(dir, "INDEX.md"),
		`# Reasoning bank index\n\n${lines}\n`,
		"utf8",
	);
	await appendFile(
		join(dir, "log.md"),
		`\n## ${new Date().toISOString()}\nitems: ${state.items.length} (evidence entries: ${state.items.reduce((a, it) => a + it.evidence.length, 0)})\n`,
		"utf8",
	);
}
