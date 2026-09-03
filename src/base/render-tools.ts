/**
 * One-line tool call rendering: signature + compact result fact + tombstone
 * with a dereferenceable @L pointer into the original log. The huge tool
 * payload itself never enters the trace — only its size, hash and pointer.
 */

import { capLine, firstLine } from "../core/text.js";
import { shortHash, tombstone } from "../core/refs.js";
import type { ToolCallEntry, ToolFamily, ToolResultEntry } from "../model/session.js";
import { classifyTool, diffFromEditInput, toolSignature } from "../model/session.js";
import { diffFromApplyPatch, stripExecHeader } from "../sources/codex/parse.js";

export interface RenderedCall {
	name: string;
	signature: string;
	family: ToolFamily;
	/** Rendered call part, e.g. `` `Bash` pnpm test ``. */
	callPart: string;
	/** Rendered result fact, e.g. `exit 101` or `…⟨12.4kB, 310 ln, #ab12, @L52⟩`. */
	resultPart: string;
	isError: boolean;
	callLine: number;
	resultLine?: number;
	/** Full rendered line for the trace. */
	text: string;
}

const SHELL_TOOLS = new Set(["Bash", "exec_command", "shell", "local_shell", "bash"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "apply_patch", "create_file", "str_replace_based_edit_tool", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "view", "view_image"]);

export function renderCall(call: ToolCallEntry, result: ToolResultEntry | undefined, cwd?: string): RenderedCall {
	const family = classifyTool(call.name);
	let sig = capLine(toolSignature(call.name, call.input), 110);
	if (cwd !== undefined && sig.startsWith(`cd ${cwd} && `)) {
		// repeated `cd <project> &&` is pure noise across a whole session
		sig = capLine(sig.slice(`cd ${cwd} && `.length), 110);
	}
	const name = displayName(call.name);
	const callRef = `@L${call.logLine}`;

	const resultRef =
		result !== undefined && result.logLine - call.logLine > 2
			? `@L${result.logLine}`
			: undefined;

	const fact = result ? renderFact(call, result) : "нет результата";
	const parts = [`\`${name}\``];
	if (sig.length > 0) parts.push(sig);
	parts.push(callRef);
	const line = `${parts.join(" ")} → ${fact}${resultRef ? ` ${resultRef}` : ""}`;

	return {
		name: call.name,
		signature: sig,
		family,
		callPart: `${name} ${sig}`,
		resultPart: fact,
		isError: result?.isError === true,
		callLine: call.logLine,
		...(result !== undefined ? { resultLine: result.logLine } : {}),
		text: line,
	};
}

function displayName(name: string): string {
	if (name.startsWith("mcp__")) {
		// mcp__server__tool → mcp:server/tool
		const rest = name.slice("mcp__".length);
		return `mcp:${rest.replace(/__/g, "/")}`;
	}
	return name;
}

function renderFact(call: ToolCallEntry, result: ToolResultEntry): string {
	if (result.interrupted) return "прервано";
	if (result.isError) {
		const body = stripIfExec(result.content).body;
		return `ERR ${firstLine(body, 140)}`;
	}

	if (EDIT_TOOLS.has(call.name)) {
		const diff = diffForEdit(call, result);
		if (diff) return `+${diff.added}/−${diff.removed}`;
	}

	if (READ_TOOLS.has(call.name)) {
		const lines = countLines(result.content);
		return `${lines} ln ${miniTombstone(result)}`;
	}

	const { body, originalTokens } = stripIfExec(result.content);
	const size = body.length;
	if (size <= 160) {
		const text = firstLine(body, 140);
		return text.length > 0 ? text : "ok";
	}
	const head = firstLine(body, 90);
	const tail = tombstone(size, countLines(body), shortHash(result.content), result.logLine);
	const tok = originalTokens !== undefined ? `, ~${originalTokens} tok` : "";
	return `${head} ${tail}${tok}`;
}

function diffForEdit(call: ToolCallEntry, result: ToolResultEntry) {
	if (call.name === "apply_patch") return diffFromApplyPatch(call.input);
	if (result.diff !== undefined) return result.diff;
	return diffFromEditInput(call.name, call.input);
}

/** Codex exec outputs carry a machine header before the actual payload. */
function stripIfExec(content: string): { body: string; originalTokens?: number } {
	if (content.startsWith("Chunk ID:")) {
		const { body, originalTokens } = stripExecHeader(content);
		return { body, ...(originalTokens !== undefined ? { originalTokens } : {}) };
	}
	return { body: content };
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	const n = text.split("\n").length;
	return text.endsWith("\n") ? n - 1 : n;
}

function miniTombstone(result: ToolResultEntry): string {
	const size = result.content.length;
	const lines = countLines(result.content);
	return tombstone(size, lines, shortHash(result.content), result.logLine);
}

export { SHELL_TOOLS };
export function isShellTool(name: string): boolean {
	return SHELL_TOOLS.has(name);
}
