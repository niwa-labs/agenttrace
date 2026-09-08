import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBank, mergeItems, saveBank, type BankItem, type BankState } from "../src/pipeline/bank.js";
import type { Pass2Item } from "../src/pipeline/contracts.js";

function item(title: string, subject: string[] = ["auth"], polarity: "strategy" | "guardrail" = "strategy"): Pass2Item {
	return {
		title,
		description: `desc: ${title}`,
		content: `content: ${title}`,
		polarity,
		subject,
		evidence: [{ line: 3 }],
	};
}

function bankItem(title: string, subject: string[], overrides: Partial<BankItem> = {}): BankItem {
	return {
		title,
		description: `desc: ${title}`,
		content: `content: ${title}`,
		polarity: "strategy",
		subject,
		evidence: [{ trace: "t0", line: 0 }],
		firstSeen: "d1",
		lastSeen: "d1",
		status: "candidate",
		...overrides,
	};
}

describe("v2 bank mergeItems", () => {
	it("merges on the exact key: normalized title + primary subject", () => {
		const state: BankState = { items: [bankItem("fix auth flow", ["auth"])] };
		const res = mergeItems(state, [item("Fix  AUTH flow")], "trace-a", "d2");
		expect(res).toEqual({ added: 0, reinforced: 1 });
		expect(state.items).toHaveLength(1);
		const merged = state.items[0];
		expect(merged?.title).toBe("fix auth flow"); // original title preserved
		expect(merged?.evidence).toEqual([{ trace: "t0", line: 0 }, { trace: "trace-a", line: 0 }]);
		expect(merged?.lastSeen).toBe("d2");
		expect(merged?.firstSeen).toBe("d1");
	});

	it("treats a different primary subject as a new item", () => {
		const state: BankState = { items: [bankItem("fix auth", ["auth"])] };
		const res = mergeItems(state, [item("fix auth", ["api"])], "trace-a", "d2");
		expect(res).toEqual({ added: 1, reinforced: 0 });
		expect(state.items).toHaveLength(2);
	});

	it("defaults an empty subject to 'general'", () => {
		const state: BankState = { items: [] };
		mergeItems(state, [item("orphan habit", [])], "trace-a", "d1");
		expect(state.items[0]?.subject).toEqual(["general"]);
	});

	it("duplicates inside one batch: first adds, second reinforces", () => {
		const res = mergeItems({ items: [] }, [item("same key"), item("same key")], "trace-a", "d1");
		expect(res).toEqual({ added: 1, reinforced: 1 });
	});

	it("promotes candidate → confirmed at ≥3 evidence entries", () => {
		const state: BankState = { items: [] };
		expect(mergeItems(state, [item("check before deploy")], "trace-1", "d1")).toEqual({ added: 1, reinforced: 0 });
		expect(state.items[0]?.status).toBe("candidate");

		mergeItems(state, [item("check before deploy")], "trace-2", "d2");
		expect(state.items[0]?.evidence).toHaveLength(2);
		expect(state.items[0]?.status).toBe("candidate"); // 2 < 3 — still candidate

		mergeItems(state, [item("check before deploy")], "trace-3", "d3");
		expect(state.items[0]?.evidence).toHaveLength(3);
		expect(state.items[0]?.status).toBe("confirmed");
	});

	it("keeps confirmed status on further reinforcement", () => {
		const state: BankState = {
			items: [bankItem("mature", ["ci"], { status: "confirmed", evidence: [{ trace: "a", line: 1 }, { trace: "b", line: 2 }, { trace: "c", line: 3 }] })],
		};
		const res = mergeItems(state, [item("mature", ["ci"])], "trace-d", "d9");
		expect(res).toEqual({ added: 0, reinforced: 1 });
		expect(state.items[0]?.status).toBe("confirmed");
		expect(state.items[0]?.evidence).toHaveLength(4);
	});
});

describe("v2 bank persistence", () => {
	it("saveBank writes bank.json, INDEX.md in the documented format, and appends log.md", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bank-"));
		try {
			const bankDir = join(dir, "nested", "bank"); // saveBank must mkdir -p
			const state: BankState = { items: [] };
			mergeItems(
				state,
				[
					item("Use gate before merge", ["ci"]),
					item("Never trust green without counts", ["testing"], "guardrail"),
				],
				"trace-x",
				"2026-01-01T00:00:00.000Z",
			);
			await saveBank(bankDir, state);

			const index = await readFile(join(bankDir, "INDEX.md"), "utf8");
			expect(index).toContain("# Reasoning bank index");
			expect(index).toContain(
				"- **Use gate before merge** [strategy] (candidate, evidence ×1) — desc: Use gate before merge · subjects: ci",
			);
			expect(index).toContain(
				"- **Never trust green without counts** [guardrail] (candidate, evidence ×1) — desc: Never trust green without counts · subjects: testing",
			);

			const log = await readFile(join(bankDir, "log.md"), "utf8");
			expect(log).toContain("items: 2 (evidence entries: 2)");

			const raw = JSON.parse(await readFile(join(bankDir, "bank.json"), "utf8")) as BankState;
			expect(raw.items).toHaveLength(2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("loadBank round-trips a saved bank and returns empty for a missing dir", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bank-"));
		try {
			const bankDir = join(dir, "bank");
			expect(await loadBank(join(dir, "absent"))).toEqual({ items: [] });

			const state: BankState = { items: [] };
			mergeItems(state, [item("Round trip", ["io"])], "trace-r", "d1");
			await saveBank(bankDir, state);
			const loaded = await loadBank(bankDir);
			expect(loaded.items).toEqual(state.items);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
