import type {
	NormalizedSession,
	SessionEntry,
} from "../../model/session.js";
import { fileSize, readJsonl } from "../jsonl.js";
import type { CursorLogLine, CursorLogMeta } from "./types.js";

/**
 * Adapter: exported Cursor chat JSONL (CursorLogLine per line) → NormalizedSession.
 * Line numbers are preserved so @L references dereference into the exported log.
 */

export async function parseCursorLog(file: string, meta: CursorLogMeta): Promise<NormalizedSession> {
	const entries: SessionEntry[] = [];
	let startedAt = "";
	let endedAt = "";
	let lastLine = 0;

	for await (const { line, value } of await readJsonl(file)) {
		lastLine = line;
		if (value === undefined || typeof value !== "object" || value === null) continue;
		const e = value as Partial<CursorLogLine> & Record<string, unknown>;
		switch (e.kind) {
			case "user_text":
			case "assistant_thinking":
			case "assistant_text": {
				const text = typeof e.text === "string" ? e.text : "";
				if (text.trim().length === 0) break;
				entries.push({
					kind: e.kind,
					text,
					timestamp: typeof e.ts === "string" ? e.ts : "",
					logLine: line,
					sidechain: false,
				});
				break;
			}
			case "tool_call": {
				if (typeof e.name !== "string") break;
				entries.push({
					kind: "tool_call",
					name: e.name,
					input: e.input,
					toolCallId: typeof e.toolCallId === "string" ? e.toolCallId : "",
					timestamp: typeof e.ts === "string" ? e.ts : "",
					logLine: line,
					sidechain: false,
				});
				break;
			}
			case "tool_result": {
				const content = typeof e.content === "string" ? e.content : "";
				if (content.length === 0) break;
				entries.push({
					kind: "tool_result",
					toolCallId: typeof e.toolCallId === "string" ? e.toolCallId : "",
					content,
					isError: e.isError === true,
					interrupted: false,
					timestamp: typeof e.ts === "string" ? e.ts : "",
					logLine: line,
					sidechain: false,
				});
				break;
			}
			default:
				break;
		}
	}

	if (entries.length > 0) {
		startedAt = entries[0]?.timestamp ?? "";
		endedAt = entries[entries.length - 1]?.timestamp ?? "";
	}

	return {
		source: meta.source,
		sessionId: meta.sessionId,
		logFile: file,
		logLines: lastLine,
		logBytes: await fileSize(file),
		cwd: meta.workspacePath ?? "",
		startedAt,
		endedAt,
		...(meta.title ? { title: meta.title } : {}),
		role: "main",
		entries,
	};
}
