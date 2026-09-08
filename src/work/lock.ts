/**
 * Coarse state-dir lock for mutating work-server commands.
 *
 * One writer at a time (claim/submit/init/finalize mutate the ledger and
 * sidecars); readers (status/layer) run without the lock. A lock older than
 * STALE_MS is considered abandoned (crashed process) and broken.
 */

import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const STALE_MS = 60 * 60_000;
/** Patient: reindex/init hold the lock for many minutes; a submit must outwait them. */
const RETRIES = 7200;
const RETRY_DELAY_MS = 250;

export class LockError extends Error {}

export async function withLock<T>(stateDir: string, fn: () => Promise<T>): Promise<T> {
	const lockFile = join(stateDir, "lock");
	await acquire(lockFile);
	try {
		return await fn();
	} finally {
		await unlink(lockFile).catch(() => {});
	}
}

async function acquire(lockFile: string): Promise<void> {
	for (let i = 0; i < RETRIES; i++) {
		try {
			const handle = await open(lockFile, "wx");
			await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
			await handle.close();
			return;
		} catch (err) {
			const code = (err as { code?: string }).code;
			if (code !== "EEXIST") throw err;
			if (await stale(lockFile)) {
				await unlink(lockFile).catch(() => {});
				continue;
			}
			await sleep(RETRY_DELAY_MS);
		}
	}
	throw new LockError(`could not acquire ${lockFile} after ${RETRIES} tries`);
}

/** A lock is stale only when its holder process is dead (mtime age as fallback). */
async function stale(lockFile: string): Promise<boolean> {
	let raw = "";
	try {
		raw = (await readFile(lockFile, "utf8")).trim();
	} catch {
		return false; // vanished — let the next acquire attempt race for it
	}
	const pid = Number(raw.split(" ")[0]);
	if (Number.isInteger(pid) && pid > 0) {
		try {
			process.kill(pid, 0); // signal 0 = liveness probe
			return false; // holder alive → keep waiting, however long it takes
		} catch (err) {
			if ((err as { code?: string }).code === "ESRCH") return true; // holder dead
			return false; // EPERM etc. — alive but unreachable
		}
	}
	try {
		const s = await stat(lockFile);
		return Date.now() - s.mtimeMs > STALE_MS;
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reserved for tests/debug: force-write a live-looking lock. */
export async function holdLock(stateDir: string): Promise<void> {
	await writeFile(join(stateDir, "lock"), `${process.pid} ${new Date().toISOString()}\n`, "utf8");
}
