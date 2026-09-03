import { basename } from "node:path";
import type { NormalizedSession, SessionEntry } from "../../model/session.js";
import { emptyUsage } from "../../model/session.js";
import { fileSize, readJsonl } from "../jsonl.js";

/**
 * Adapter: pi session JSONL → NormalizedSession.
 *
 * Layout: line 1 `{type:"session", id, cwd}`, then `{type:"message",
 * message:{role, content:[blocks]}}` entries. Block types: text, thinking,
 * toolCall (inside assistant); tool results arrive as messages with role
 * `toolResult`. pi is the source where thinking is usually PRESENT, so the
 * adapter must carry it losslessly — this is the universality benchmark.
 */

export async function parsePiSession(file: string): Promise<NormalizedSession> {
	const entries: SessionEntry[] = [];
	let sessionId = basename(file, ".jsonl").replace(/^\d{4}-\d{2}-\d{2}T[\d-.]+Z_/, "");
	let cwd = "";
	let model: string | undefined;
	let firstUserText: string | undefined;
	let startedAt = "";
	let endedAt = "";
	let lastLine = 0;
	/** toolCall block id → tool name, for pairing results. */
	const callNames = new Map<string, string>();
	const usage = emptyUsage();

	for await (const { line, value } of await readJsonl(file)) {
		lastLine = line;
		if (value === undefined || typeof value !== "object") continue;
		const e = value as Record<string, unknown>;
		const type = e["type"];
		if (typeof type !== "string") continue;

		const ts = typeof e["timestamp"] === "string" ? e["timestamp"] : endedAt;
		if (ts && (!startedAt || ts < startedAt)) startedAt = ts;
		if (ts) endedAt = ts;

		if (type === "session") {
			const id = e["id"];
			if (typeof id === "string") sessionId = id;
			if (typeof e["cwd"] === "string") cwd = e["cwd"];
			continue;
		}
		if (type === "model_change") {
			const m = e["model"];
			if (typeof m === "string") model = m;
			continue;
		}
		if (type !== "message") continue; // label, compaction, custom… — metadata

		const msg = asRecord(e["message"]);
		if (!msg) continue;
		const role = msg["role"];
		const content = msg["content"];
		if (!Array.isArray(content)) continue;

		const u = asRecord(msg["usage"]);
		if (u !== undefined) {
			usage.requests++;
			usage.inputTokens += num0(u["input"]);
			usage.outputTokens += num0(u["output"]);
			usage.cacheReadTokens += num0(u["cacheRead"]);
			usage.cacheWriteTokens += num0(u["cacheWrite"]);
			usage.reasoningTokens += num0(u["reasoning"]);
			if (typeof u["cost"] === "number") {
				usage.costUsd = (usage.costUsd ?? 0) + u["cost"];
			}
		}

		if (role === "toolResult") {
			const toolCallId = typeof msg["toolCallId"] === "string" ? msg["toolCallId"] : "";
			const text = collectText(content);
			entries.push({
				kind: "tool_result",
				toolCallId,
				content: text,
				isError: msg["isError"] === true,
				interrupted: false,
				timestamp: ts,
				logLine: line,
				sidechain: false,
			});
			continue;
		}

		for (const block of content) {
			const b = asRecord(block);
			if (!b) continue;
			switch (b["type"]) {
				case "text": {
					const text = typeof b["text"] === "string" ? b["text"] : "";
					if (text.trim().length === 0) break;
					if (role === "user") {
						if (isInstructionNoise(text)) break;
						entries.push({ kind: "user_text", text, timestamp: ts, logLine: line, sidechain: false });
						if (firstUserText === undefined) firstUserText = text;
					} else if (role === "assistant") {
						entries.push({ kind: "assistant_text", text, timestamp: ts, logLine: line, sidechain: false });
					}
					break;
				}
				case "thinking": {
					const text = typeof b["thinking"] === "string" ? b["thinking"] : "";
					if (text.trim().length === 0) break;
					entries.push({
						kind: "assistant_thinking",
						text,
						timestamp: ts,
						logLine: line,
						sidechain: false,
					});
					break;
				}
				case "toolCall": {
					const id = typeof b["id"] === "string" ? b["id"] : "";
					const name = typeof b["name"] === "string" ? b["name"] : "unknown";
					if (id !== "") callNames.set(id, name);
					entries.push({
						kind: "tool_call",
						name,
						input: b["arguments"],
						toolCallId: id,
						timestamp: ts,
						logLine: line,
						sidechain: false,
					});
					break;
				}
				default:
					break;
			}
		}
	}

	return {
		source: "pi",
		sessionId,
		logFile: file,
		logLines: lastLine,
		logBytes: await fileSize(file),
		cwd,
		startedAt: startedAt || endedAt,
		endedAt,
		...(model !== undefined ? { model } : {}),
		...(firstUserText !== undefined ? { firstPrompt: firstUserText.slice(0, 200) } : {}),
		role: "main",
		...(usage.requests > 0 ? { tokenUsage: usage } : {}),
		...(entries.length > 0 ? { activeMs: computeActiveMs(entries) } : {}),
		entries,
	};
}

function collectText(content: unknown[]): string {
	return content
		.map((c) => {
			const r = asRecord(c);
			if (!r) return "";
			if (typeof r["text"] === "string") return r["text"];
			return "";
		})
		.filter((s) => s.length > 0)
		.join("\n");
}

function isInstructionNoise(text: string): boolean {
	return text.startsWith("<") && /<\/[a-z-]+>\s*$/.test(text.slice(0, 200));
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: undefined;
}

function num0(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function computeActiveMs(entries: SessionEntry[]): number {
	const ts = entries
		.map((e) => Date.parse(e.timestamp))
		.filter((t) => Number.isFinite(t))
		.sort((a, b) => a - b);
	let active = 0;
	for (let i = 1; i < ts.length; i++) {
		const gap = (ts[i] as number) - (ts[i - 1] as number);
		if (gap <= 120_000) active += gap;
	}
	return active;
}
