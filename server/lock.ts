import { link, readFile, rm, writeFile } from "node:fs/promises";

// A lock older than this is abandoned: every git call under it times out well before.
export const STALE_LOCK_MS = 120_000;

export class LockBusy extends Error {}

// Cross-process mutual exclusion through a file that only one process can create. The file holds
// "<pid> <ms> <nonce>", so a lock left by a crashed or hung process can be taken over.
export async function withLock<T>(path: string, fn: () => Promise<T>, opts: { waitMs?: number } = {}): Promise<T> {
  const waitMs = opts.waitMs ?? STALE_LOCK_MS + 10_000;
  const token = await acquire(path, waitMs);
  try {
    return await fn();
  } finally {
    const held = await readFile(path, "utf8").catch(() => null);
    if (held === token) await rm(path, { force: true });
  }
}

async function acquire(path: string, waitMs: number): Promise<string> {
  const deadline = Date.now() + waitMs;
  let delay = 10;
  for (;;) {
    const nonce = Math.random().toString(36).slice(2);
    const token = `${process.pid} ${Date.now()} ${nonce}`;
    // link() creates the lock atomically with its content in place, so nobody reads it half written.
    const draft = `${path}.${process.pid}.${nonce}`;
    await writeFile(draft, token);
    try {
      await link(draft, path);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await rm(draft, { force: true });
    }
    const held = await readFile(path, "utf8").catch(() => null);
    if (held !== null && isAbandoned(held)) {
      // Re-read right before removing, so a lock another process just took over is left alone.
      if ((await readFile(path, "utf8").catch(() => null)) === held) await rm(path, { force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new LockBusy(`${path} is held by ${held ?? "another process"}`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))));
    delay = Math.min(delay * 2, 500);
  }
}

function isAbandoned(held: string): boolean {
  const [pid, at] = held.split(" ").map(Number);
  if (!Number.isFinite(at) || Date.now() - at > STALE_LOCK_MS) return true;
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
