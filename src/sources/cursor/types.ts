/**
 * Cursor AI chats: normalized intermediate log format.
 *
 * Cursor stores chats in two very different places:
 *  - IDE chats: sqlite `state.vscdb` (composerHeaders + cursorDiskKV bubbles)
 *  - cursor-agent CLI: `~/.cursor/chats/<wsHash>/<chatId>/store.db`
 *
 * Both exporters flatten their native shapes into CursorLogLine JSONL files
 * (one JSON object per line) so a single parser can turn them into
 * NormalizedSessions.
 */

export type CursorLogLine =
	| { kind: "user_text"; text: string; ts: string; bid: string }
	| { kind: "assistant_thinking"; text: string; ts: string; bid: string }
	| { kind: "assistant_text"; text: string; ts: string; bid: string }
	| { kind: "tool_call"; name: string; input: unknown; toolCallId: string; ts: string; bid: string }
	| { kind: "tool_result"; toolCallId: string; content: string; isError: boolean; ts: string; bid: string };

export interface CursorLogMeta {
	sessionId: string; // composerId or "<wsHash>-<chatId>"
	source: "cursor-ide" | "cursor-agent";
	title?: string; // composer name
	workspacePath?: string; // project path
	createdAt?: string; // ISO
	lastUpdatedAt?: string; // ISO
	msgCount: number; // lines in the log
}

/** Counters returned by the Cursor exporters. */
export interface CursorExportReport {
	exported: number;
	skipped: number;
	/** Composers/chats with no usable bubbles. */
	noBubbles: number;
	errors: string[];
}

/** node:sqlite DatabaseSync gained `readOnly` after @types/node 22.10 (runtime supports it). */
export interface DatabaseSyncOptionsRO {
	open?: boolean;
	readOnly?: boolean;
}
