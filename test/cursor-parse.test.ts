import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exportCursorIdeSessions } from "../src/sources/cursor/ide.js";
import { exportCursorAgentSessions } from "../src/sources/cursor/agentcli.js";
import { parseCursorLog } from "../src/sources/cursor/parse.js";
import { listCursorLogs } from "../src/sources/cursor/discover.js";
import type { CursorLogMeta } from "../src/sources/cursor/types.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "cursor-log.jsonl");

describe("cursor parser", () => {
	const meta: CursorLogMeta = {
		sessionId: "comp-1",
		source: "cursor-ide",
		title: "Починить логин",
		workspacePath: "/proj/demo/apps/dist",
		createdAt: "2026-07-01T10:00:00.000Z",
		lastUpdatedAt: "2026-07-01T10:05:00.000Z",
		msgCount: 8,
	};

	it("parses all line kinds with correct log line numbers", async () => {
		const s = await parseCursorLog(FIXTURE, meta);
		expect(s.source).toBe("cursor-ide");
		expect(s.sessionId).toBe("comp-1");
		expect(s.cwd).toBe("/proj/demo/apps/dist");
		expect(s.title).toBe("Починить логин");
		expect(s.logLines).toBe(8);
		expect(s.logBytes).toBeGreaterThan(0);
		expect(s.role).toBe("main");
		expect(s.startedAt).toBe("2026-07-01T10:00:00.000Z");
		expect(s.endedAt).toBe("2026-07-01T10:01:11.000Z");
		expect(s.entries.map((e) => e.kind)).toEqual([
			"user_text",
			"assistant_thinking",
			"assistant_text",
			"tool_call",
			"tool_result",
			"user_text",
			"tool_call",
			"tool_result",
		]);
		expect(s.entries.map((e) => e.logLine)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(s.entries.every((e) => e.sidechain === false)).toBe(true);
	});

	it("maps tool calls and results by id", async () => {
		const s = await parseCursorLog(FIXTURE, meta);
		const call = s.entries[3];
		expect(call?.kind).toBe("tool_call");
		if (call?.kind !== "tool_call") return;
		expect(call.name).toBe("read_file_v2");
		expect(call.input).toEqual({ path: "/proj/demo/apps/dist/src/index.ts", offset: 1, limit: 50 });
		expect(call.toolCallId).toBe("b3:0");
		expect(call.timestamp).toBe("2026-07-01T10:00:07.000Z");

		const result = s.entries[4];
		expect(result?.kind).toBe("tool_result");
		if (result?.kind !== "tool_result") return;
		expect(result.toolCallId).toBe("b3:0");
		expect(result.isError).toBe(false);
		expect(result.interrupted).toBe(false);
	});

	it("falls back to empty cwd/timestamps when meta lacks them", async () => {
		const s = await parseCursorLog(FIXTURE, { sessionId: "s", source: "cursor-agent", msgCount: 8 });
		expect(s.cwd).toBe("");
		expect(s.title).toBeUndefined();
		expect(s.startedAt).toBe("2026-07-01T10:00:00.000Z");
	});

	it("discovers exported logs by meta files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cursor-discover-"));
		try {
			await writeFile(join(dir, "a.meta.json"), JSON.stringify({ sessionId: "a", source: "cursor-ide", msgCount: 1 }));
			await writeFile(join(dir, "a.jsonl"), "{\"kind\":\"user_text\",\"text\":\"x\",\"ts\":\"\",\"bid\":\"1\"}\n");
			await writeFile(join(dir, "b.meta.json"), JSON.stringify({ sessionId: "b", source: "cursor-agent", msgCount: 0 }));
			// b.jsonl missing — must be skipped
			await writeFile(join(dir, "broken.meta.json"), "not json");
			const found = await listCursorLogs(dir);
			expect(found.map((f) => f.meta.sessionId)).toEqual(["a"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("cursor-ide exporter", () => {
	it("exports composers from state.vscdb, skipping subagents and resuming", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cursor-ide-"));
		try {
			const dbPath = join(dir, "state.vscdb");
			seedIdeDb(dbPath);
			const outDir = join(dir, "out");

			const report = await exportCursorIdeSessions(dbPath, outDir, { limit: 2 });
			expect(report.errors).toEqual([]);
			expect(report.exported).toBe(1);
			expect(report.noBubbles).toBe(1);
			expect(report.skipped).toBe(0);

			const logPath = join(outDir, "composer-aaa.jsonl");
			const lines = (await readFile(logPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
			expect(lines.map((l) => l["kind"])).toEqual([
				"user_text",
				"assistant_thinking",
				"assistant_text",
				"tool_call",
				"tool_result",
				"tool_call",
				"tool_result",
			]);
			// thinking precedes assistant text within one bubble
			expect(lines[1]).toMatchObject({ kind: "assistant_thinking", bid: "b2", text: "думаю" });
			expect(lines[2]).toMatchObject({ kind: "assistant_text", bid: "b2", text: "смотрю" });
			// bubble-level toolFormerData: parsed rawArgs, string result
			expect(lines[3]).toMatchObject({
				kind: "tool_call",
				name: "read_file_v2",
				toolCallId: "b3:0",
				input: { path: "/proj/alpha/src/a.ts" },
			});
			expect(lines[4]).toMatchObject({ kind: "tool_result", toolCallId: "b3:0", content: "{\"contents\":\"x\"}", isError: false });
			// toolResults[] entry: non-JSON rawArgs kept raw, non-string result serialized
			expect(lines[5]).toMatchObject({ kind: "tool_call", name: "grep", toolCallId: "b4:0", input: "not json {{{" });
			expect(lines[6]).toMatchObject({ kind: "tool_result", toolCallId: "b4:0", content: "{\"a\":1}" });

			const meta = JSON.parse(await readFile(join(outDir, "composer-aaa.meta.json"), "utf8")) as CursorLogMeta;
			expect(meta).toMatchObject({
				sessionId: "composer-aaa",
				source: "cursor-ide",
				title: "Fix login",
				workspacePath: "/proj/alpha",
				createdAt: "2023-11-14T22:13:20.000Z",
				lastUpdatedAt: "2023-11-14T22:15:00.000Z",
				msgCount: 7,
			});

			// second run: everything already exported
			const again = await exportCursorIdeSessions(dbPath, outDir, { limit: 2 });
			expect(again.exported).toBe(0);
			expect(again.skipped).toBe(1);
			expect(again.noBubbles).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("cursor-agent exporter", () => {
	it("exports store.db chats with hex meta and nested messages", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cursor-agent-"));
		try {
			const chatsRoot = join(dir, "chats");
			const wsStorage = join(dir, "workspaceStorage");
			await seedAgentStore(join(chatsRoot, "ws1", "chat1"), "Agent chat", 1_700_000_000_000, "Workspace Path: /tmp/proj\nпривет");
			await seedAgentStore(join(chatsRoot, "ws2", "chat2"), undefined, undefined, "без пути");
			await mkdir(join(wsStorage, "ws1"), { recursive: true });
			await writeFile(join(wsStorage, "ws1", "workspace.json"), JSON.stringify({ folder: "file:///tmp/proj-actual" }));
			const outDir = join(dir, "out");

			const report = await exportCursorAgentSessions(chatsRoot, outDir, { workspaceStorageDir: wsStorage });
			expect(report.errors).toEqual([]);
			expect(report.exported).toBe(2);

			const lines = (await readFile(join(outDir, "ws1-chat1.jsonl"), "utf8")).trim().split("\n")
				.map((l) => JSON.parse(l) as Record<string, unknown>);
			expect(lines.map((l) => l["kind"])).toEqual([
				"user_text",
				"assistant_thinking",
				"assistant_text",
				"user_text",
				"assistant_text",
			]);
			expect(lines[0]).toMatchObject({ bid: "1", text: "Workspace Path: /tmp/proj\nпривет" });
			expect(lines[1]).toMatchObject({ bid: "2", text: "думаю" });
			expect(lines[2]).toMatchObject({ bid: "2", text: "часть1\nчасть2" });
			expect(lines[3]).toMatchObject({ bid: "4", text: "вложенный" });
			expect(lines[4]).toMatchObject({ bid: "4", text: "ответ" });

			const meta = JSON.parse(await readFile(join(outDir, "ws1-chat1.meta.json"), "utf8")) as CursorLogMeta;
			expect(meta).toMatchObject({
				sessionId: "ws1-chat1",
				source: "cursor-agent",
				title: "Agent chat",
				workspacePath: "/tmp/proj-actual",
				createdAt: "2023-11-14T22:13:20.000Z",
				msgCount: 5,
			});

			// chat2: no workspace.json, no Workspace Path in texts, no meta createdAt
			const meta2 = JSON.parse(await readFile(join(outDir, "ws2-chat2.meta.json"), "utf8")) as CursorLogMeta;
			expect(meta2.sessionId).toBe("ws2-chat2");
			expect(meta2.workspacePath).toBeUndefined();
			expect(Number.isFinite(Date.parse(meta2.createdAt ?? ""))).toBe(true);

			// exported log round-trips through the parser
			const s = await parseCursorLog(join(outDir, "ws1-chat1.jsonl"), meta);
			expect(s.entries).toHaveLength(5);
			expect(s.startedAt).toBe("");
			expect(s.endedAt).toBe("");

			// second run: everything already exported
			const again = await exportCursorAgentSessions(chatsRoot, outDir, { workspaceStorageDir: wsStorage });
			expect(again.exported).toBe(0);
			expect(again.skipped).toBe(2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------

function seedIdeDb(dbPath: string): void {
	const db = new DatabaseSync(dbPath);
	try {
		db.exec(`
			CREATE TABLE composerHeaders (
				composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER,
				isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT
			);
			CREATE TABLE cursorDiskKV (key TEXT, value BLOB);
		`);
		const insertHeader = db.prepare(
			"INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		const insertKv = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");

		// subagent composer: must be skipped before export
		insertHeader.run("composer-bbb", "ws", 500, 600, 0, 1, 600, null, null);

		// main composer with 5 bubbles: user / thinking+text / tool / toolResults-only / empty
		const headersOnly = [
			{ bubbleId: "b1", type: 1 },
			{ bubbleId: "b2", type: 2 },
			{ bubbleId: "b3", type: 2 },
			{ bubbleId: "b4", type: 2 },
			{ bubbleId: "b5", type: 2 },
		];
		const composerData = JSON.stringify({
			composerId: "composer-aaa",
			name: "Fix login",
			createdAt: 1_700_000_000_000,
			lastUpdatedAt: 1_700_000_100_000,
			workspaceIdentifier: { id: "ws-id", uri: { fsPath: "/proj/alpha", scheme: "file" } },
			fullConversationHeadersOnly: headersOnly,
		});
		insertHeader.run(
			"composer-aaa",
			"ws",
			1_000,
			1_100,
			0,
			0,
			1_100,
			null,
			JSON.stringify({ composerId: "composer-aaa", name: "Fix login", createdAt: 1_700_000_000_000, lastUpdatedAt: 1_700_000_100_000 }),
		);
		// composerData stored as BLOB to exercise the utf8 decode path
		insertKv.run("composerData:composer-aaa", Buffer.from(composerData, "utf8"));
		const bubbles: [string, string][] = [
			["b1", JSON.stringify({ bubbleId: "b1", type: 1, text: "почини логин", createdAt: "2026-07-01T10:00:00.000Z" })],
			["b2", JSON.stringify({ bubbleId: "b2", type: 2, text: "смотрю", thinking: { text: "думаю" }, createdAt: "2026-07-01T10:00:05.000Z" })],
			[
				"b3",
				JSON.stringify({
					bubbleId: "b3",
					type: 2,
					text: "",
					toolFormerData: {
						name: "read_file_v2",
						rawArgs: JSON.stringify({ path: "/proj/alpha/src/a.ts" }),
						result: "{\"contents\":\"x\"}",
						status: "completed",
					},
					createdAt: "2026-07-01T10:00:07.000Z",
				}),
			],
			[
				"b4",
				JSON.stringify({
					bubbleId: "b4",
					type: 2,
					text: "",
					toolResults: [{ toolFormerData: { name: "grep", rawArgs: "not json {{{", result: { a: 1 } } }],
					createdAt: "2026-07-01T10:00:09.000Z",
				}),
			],
			["b5", JSON.stringify({ bubbleId: "b5", type: 2, text: "", createdAt: "2026-07-01T10:00:10.000Z" })],
		];
		for (const [bid, bubble] of bubbles) {
			insertKv.run(`bubbleId:composer-aaa:${bid}`, Buffer.from(bubble, "utf8"));
		}

		// composer without composerData: counts as noBubbles
		insertHeader.run("composer-ccc", "ws", 2_000, 2_100, 0, 0, 2_100, null, null);
	} finally {
		db.close();
	}
}

async function seedAgentStore(
	chatDir: string,
	name: string | undefined,
	createdAt: number | undefined,
	userText: string,
): Promise<void> {
	await mkdir(chatDir, { recursive: true });
	const dbPath = join(chatDir, "store.db");
	const db = new DatabaseSync(dbPath);
	try {
		db.exec("CREATE TABLE meta (key TEXT, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);");
		const meta: Record<string, unknown> = { agentId: "agent-1" };
		if (name !== undefined) meta["name"] = name;
		if (createdAt !== undefined) meta["createdAt"] = createdAt;
		db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(Buffer.from(JSON.stringify(meta), "utf8").toString("hex"));

		const insertBlob = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
		insertBlob.run("r1", JSON.stringify({ role: "user", content: userText }));
		insertBlob.run(
			"r2",
			JSON.stringify({ role: "assistant", content: [{ type: "text", text: "часть1" }, { type: "text", text: "часть2" }], thinking: "думаю" }),
		);
		insertBlob.run("r3", Buffer.from([0x00, 0x01, 0x02, 0x03])); // protobuf junk — skipped
		insertBlob.run("r4", JSON.stringify({ messages: [{ role: "user", content: "вложенный" }, { role: "assistant", content: "ответ" }] }));
	} finally {
		db.close();
	}
}
