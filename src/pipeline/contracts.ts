/**
 * JSON contracts for model outputs + hand-rolled validators.
 *
 * Hand-rolled on purpose: the repair-in-place loop needs precise, actionable
 * error strings, and every constraint (lengths, enums, ranges) is a rule the
 * model can actually fix. Validation never throws — it returns error text.
 */

export type Pass1ThoughtKind = "H" | "ALT" | "?" | "PIVOT" | "INSIGHT" | "ERR-R";
export type ThoughtSource = "thinking" | "narration" | "inferred";

export interface Pass1Block {
	anchor: { fromLine: number; toLine: number };
	action: string;
	/** 0–3 distilled reasoning events of the turn (mandatory when [THINKING] present). */
	thoughts: {
		kind: Pass1ThoughtKind;
		source: ThoughtSource;
		text: string;
		/** Quote-id of the source entry; required for thinking|narration. */
		q?: string;
	}[];
	/** Runtime data: models sometimes emit null here — the type allows it. */
	factsClaimed?: {
		checks?: { run: number; failed: number };
		exitCode?: number;
	} | null;
	fallback?: boolean;
}

export interface Pass1Digest {
	goal: string;
	openHypotheses: { text: string; q?: string }[];
	currentBelief: string;
	naming?: string[];
}

export interface Pass2Arc {
	kind: "H" | "ALT" | "PIVOT" | "INSIGHT" | "ERR-R";
	text: string;
	status: "confirmed" | "refuted" | "open" | "noticed" | "never";
	fromLine: number;
	toLine?: number;
	subject?: string;
}

export interface Pass2Item {
	title: string;
	description: string;
	content: string;
	polarity: "strategy" | "guardrail";
	subject: string[];
	evidence: { line: number }[];
}

export interface Pass2Output {
	arcs: Pass2Arc[];
	verdict: { status: "success" | "partial" | "failure"; why: string };
	items: Pass2Item[];
}

/** reasoningIndex is DERIVED from arcs — single source of truth, no model-side drift. */
export function deriveReasoningIndex(arcs: Pass2Arc[]) {
	return arcs.map((a) => ({
		kind: a.kind,
		line: a.fromLine,
		subject: a.subject ?? a.text.slice(0, 60),
		status: a.status,
		note: a.text,
	}));
}

// ---------------------------------------------------------------------------
// Generic JSON extraction + validation plumbing
// ---------------------------------------------------------------------------

/** Extract the first JSON object from a model reply (fences, prose tolerated).
 *  A fenced block is the model's authoritative answer: if it parses to a
 *  non-object, we do NOT scavenge braces from the surrounding prose. */
export function extractJsonObject(text: string): unknown {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
	if (fenced !== null && fenced[1] !== undefined) {
		try {
			const parsed = JSON.parse(fenced[1].trim()) as unknown;
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
			return undefined; // fenced block is authoritative — non-object means failure
		} catch {
			// fenced block is not valid JSON — fall through to brace extraction
		}
	}
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start !== -1 && end > start) {
		try {
			const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		} catch {
			// fall through
		}
	}
	return undefined;
}

type Errors = string[];

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): v is string {
	return typeof v === "string";
}

function int(v: unknown): v is number {
	return typeof v === "number" && Number.isInteger(v);
}

// ---------------------------------------------------------------------------
// Pass-1 block
// ---------------------------------------------------------------------------

const THOUGHT_KINDS = new Set(["H", "ALT", "?", "PIVOT", "INSIGHT", "ERR-R"]);
const THOUGHT_SOURCES = new Set(["thinking", "narration", "inferred"]);

export function validatePass1Block(
	v: unknown,
	ctx: { fromLine: number; toLine: number; quoteIds: Set<string> },
): Errors {
	const errors: Errors = [];
	if (!isObj(v)) return ["response is not a JSON object"];
	if (!isObj(v["anchor"])) errors.push("missing object 'anchor'");
	else {
		const a = v["anchor"];
		if (!int(a["fromLine"])) errors.push("anchor.fromLine must be an integer");
		if (!int(a["toLine"])) errors.push("anchor.toLine must be an integer");
		if (int(a["fromLine"]) && int(a["toLine"])) {
			if ((a["fromLine"]) < ctx.fromLine || (a["fromLine"]) > ctx.toLine) {
				errors.push(`anchor_out_of_block: anchor.fromLine outside this turn's lines ${ctx.fromLine}–${ctx.toLine}`);
			}
			if ((a["toLine"]) < (a["fromLine"])) {
				errors.push("anchor.toLine must be ≥ anchor.fromLine");
			}
			if ((a["toLine"]) > ctx.toLine + 2) {
				errors.push(`anchor_out_of_block: anchor.toLine beyond this turn's lines (max ${ctx.toLine})`);
			}
		}
	}
	if (!str(v["action"])) errors.push("missing string 'action'");
	else if ((v["action"]).length > 400) errors.push("action exceeds 400 chars — compress it");
	if (v["thought"] !== null && v["thought"] !== undefined) {
		if (!isObj(v["thought"])) {
			errors.push("'thought' must be an object or null");
		} else {
			const t = v["thought"];
			if (!str(t["kind"]) || !THOUGHT_KINDS.has(t["kind"])) {
				errors.push(`thought.kind must be one of ${[...THOUGHT_KINDS].join("|")}`);
			}
			if (!str(t["source"]) || !THOUGHT_SOURCES.has(t["source"])) {
				errors.push(`thought.source must be one of ${[...THOUGHT_SOURCES].join("|")}`);
			}
			if (!str(t["text"])) errors.push("missing string 'thought.text'");
			else if ((t["text"]).length > 400) errors.push("thought.text exceeds 400 chars — compress it");
			const source = t["source"];
			if (source === "thinking" || source === "narration") {
				if (!str(t["q"])) errors.push("thought.q is required when source is thinking|narration");
				else if (!ctx.quoteIds.has(t["q"])) {
					errors.push(`thought.q "${String(t["q"])}" does not match any [q-id] shown in this turn`);
				}
			}
			if (source === "inferred" && str(t["kind"]) && !["H", "?"].includes(t["kind"])) {
				errors.push("thought.source=inferred allows only kind H or ?");
			}
		}
	}
	if (v["factsClaimed"] !== undefined && v["factsClaimed"] !== null && !isObj(v["factsClaimed"])) {
		errors.push("'factsClaimed' must be an object when present");
	}
	return errors;
}

// ---------------------------------------------------------------------------
// Pass-1 digest
// ---------------------------------------------------------------------------

export function validatePass1Digest(v: unknown): Errors {
	const errors: Errors = [];
	if (!isObj(v)) return ["response is not a JSON object"];
	if (!str(v["goal"])) errors.push("missing string 'goal'");
	else if ((v["goal"]).length > 300) errors.push("goal exceeds 300 chars");
	if (!Array.isArray(v["openHypotheses"])) errors.push("missing array 'openHypotheses'");
	else {
		for (const [i, h] of (v["openHypotheses"] as unknown[]).entries()) {
			if (!isObj(h) || !str(h["text"])) errors.push(`openHypotheses[${i}].text must be a string`);
		}
	}
	if (!str(v["currentBelief"])) errors.push("missing string 'currentBelief'");
	return errors;
}

// ---------------------------------------------------------------------------
// Pass-2
// ---------------------------------------------------------------------------

const ARC_KINDS = new Set(["H", "ALT", "PIVOT", "INSIGHT", "ERR-R"]);
const ARC_STATUSES = new Set(["confirmed", "refuted", "open", "noticed", "never"]);

export function validatePass2(v: unknown): Errors {
	const errors: Errors = [];
	if (!isObj(v)) return ["response is not a JSON object"];
	if (!Array.isArray(v["arcs"])) errors.push("missing array 'arcs'");
	else {
		for (const [i, a] of (v["arcs"] as unknown[]).entries()) {
			if (!isObj(a)) {
				errors.push(`arcs[${i}] must be an object`);
				continue;
			}
			if (!str(a["kind"]) || !ARC_KINDS.has(a["kind"])) {
				errors.push(`arcs[${i}].kind must be one of ${[...ARC_KINDS].join("|")}`);
			}
			if (!str(a["status"]) || !ARC_STATUSES.has(a["status"])) {
				errors.push(`arcs[${i}].status must be one of ${[...ARC_STATUSES].join("|")}`);
			}
			if (!str(a["text"])) errors.push(`arcs[${i}].text must be a string`);
			if (!int(a["fromLine"])) errors.push(`arcs[${i}].fromLine must be an integer`);
		}
	}
	if (!isObj(v["verdict"])) errors.push("missing object 'verdict'");
	else {
		const verdict = v["verdict"];
		if (!str(verdict["status"]) || !["success", "partial", "failure"].includes(verdict["status"])) {
			errors.push("verdict.status must be success|partial|failure");
		}
		if (!str(verdict["why"])) errors.push("missing string 'verdict.why'");
	}
	if (!Array.isArray(v["items"])) errors.push("missing array 'items'");
	else {
		for (const [i, it] of (v["items"] as unknown[]).entries()) {
			if (!isObj(it)) {
				errors.push(`items[${i}] must be an object`);
				continue;
			}
			if (!str(it["title"])) errors.push(`items[${i}].title must be a string`);
			if (!str(it["description"])) errors.push(`items[${i}].description must be a string`);
			if (!str(it["content"])) errors.push(`items[${i}].content must be a string`);
			if (!str(it["polarity"]) || !["strategy", "guardrail"].includes(it["polarity"])) {
				errors.push(`items[${i}].polarity must be strategy|guardrail`);
			}
			if (!Array.isArray(it["subject"])) errors.push(`items[${i}].subject must be an array`);
			if (!Array.isArray(it["evidence"])) errors.push(`items[${i}].evidence must be an array`);
		}
	}
	return errors;
}

/** Cast helpers used after successful validation. */
export function asPass1Block(v: unknown): Pass1Block {
	const b = v as Pass1Block;
	return {
		anchor: { fromLine: b.anchor.fromLine, toLine: b.anchor.toLine },
		action: b.action,
		thoughts: b.thoughts.map((t) => ({
			kind: t.kind,
			source: t.source,
			text: t.text,
			...(t.q !== undefined ? { q: t.q } : {}),
		})),
		...(b.factsClaimed !== undefined && b.factsClaimed !== null ? { factsClaimed: b.factsClaimed } : {}),
	};
}

export function asPass1Digest(v: unknown): Pass1Digest {
	const d = v as Pass1Digest;
	return {
		goal: d.goal,
		openHypotheses: d.openHypotheses.map((h) => ({
			text: h.text,
			...(h.q !== undefined ? { q: h.q } : {}),
		})),
		currentBelief: d.currentBelief,
		...(d.naming !== undefined ? { naming: d.naming } : {}),
	};
}

export function asPass2Output(v: unknown): Pass2Output {
	const p = v as Pass2Output;
	return {
		arcs: p.arcs.map((a) => ({
			kind: a.kind,
			text: a.text,
			status: a.status,
			fromLine: a.fromLine,
			...(a.toLine !== undefined ? { toLine: a.toLine } : {}),
		})),
		verdict: { status: p.verdict.status, why: p.verdict.why },
		items: p.items.map((it) => ({
			title: it.title,
			description: it.description,
			content: it.content,
			polarity: it.polarity,
			subject: Array.isArray(it.subject) ? it.subject : [],
			evidence: Array.isArray(it.evidence) ? it.evidence : [],
		})),
	};
}
