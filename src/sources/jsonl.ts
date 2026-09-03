import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";

export interface JsonlLine {
	/** 1-based line number in the file. */
	line: number;
	/** Parsed JSON value, or undefined when the line is not valid JSON. */
	value: unknown;
}

/** Stream a JSONL file, yielding parsed values with 1-based line numbers. */
export function readJsonl(file: string, signal?: AbortSignal): Promise<AsyncIterable<JsonlLine>> {
	const rl = createInterface({
		input: createReadStream(file, { encoding: "utf8" }),
		crlfDelay: Infinity,
	});
	const iterator = (async function* () {
		try {
			let n = 0;
			for await (const raw of rl) {
				if (signal?.aborted) break;
				n++;
				const trimmed = raw.trim();
				if (trimmed.length === 0) continue;
				let value: unknown;
				try {
					value = JSON.parse(trimmed) as unknown;
				} catch {
					value = undefined;
				}
				yield { line: n, value };
			}
		} finally {
			rl.close();
		}
	})();
	return Promise.resolve(iterator);
}

export async function fileSize(file: string): Promise<number> {
	const s = await stat(file);
	return s.size;
}

/** Read the first N bytes of a file as text (for cheap field sniffing). */
export async function head(file: string, bytes: number): Promise<string> {
	const { open } = await import("node:fs/promises");
	const fh = await open(file, "r");
	try {
		const buf = Buffer.alloc(bytes);
		const { bytesRead } = await fh.read(buf, 0, bytes, 0);
		return buf.toString("utf8", 0, bytesRead);
	} finally {
		await fh.close();
	}
}
