import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { MESSAGE_ID, type Message, MessageSchema } from "../shared/message.ts";
import { LockBusy, withLock } from "./lock.ts";

const run = promisify(execFile);
const SYNC_EVERY_MS = 15_000;
// Network git calls give up well before a held lock counts as abandoned.
const GIT_TIMEOUT_MS = 60_000;
// Other hosts push to the same branch; each rejected push costs a sync and a short random wait.
const PUSH_ATTEMPTS = 8;
const DIR = "messages";

export type Write = { kind: "ok"; message: Message } | { kind: "refused"; reason: string };
export type Mutation = (current: Message) => Message | string;

export type Store = ReturnType<typeof createStore>;

const README = `# Inbox store

Written by paseo-inbox. One JSON file per message in \`messages/\`. Do not edit by hand.
`;

export function createStore(opts: { dir: string; branch: string; repo: string }) {
  const { dir, branch, repo } = opts;
  const lockPath = storeLockPath(dir);
  const tracking = `refs/remotes/origin/${branch}`;
  let lastSyncAt = 0;
  let lastSyncError: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  // The CLI, the plugin, hooks and other hosts share this checkout and its remote. Every git
  // sequence runs in this process's queue and, across processes, under the store's lock file.
  function serial<T>(fn: () => Promise<T>, lock: { waitMs?: number } = {}): Promise<T> {
    const locked = async () => {
      await mkdir(dirname(lockPath), { recursive: true });
      return withLock(lockPath, fn, lock);
    };
    const next = queue.then(locked, locked);
    queue = next.catch(() => {});
    return next;
  }

  function git(...args: string[]): Promise<string> {
    return runGit(dir, args);
  }

  // Fetch and replay onto origin/<branch> by name. `git pull` resolves FETCH_HEAD, which another
  // process's fetch can rewrite halfway ("Cannot rebase onto multiple branches").
  async function sync(): Promise<void> {
    try {
      await git("fetch", "-q", "origin", `+refs/heads/${branch}:${tracking}`);
      await git("rebase", "-q", "--autostash", tracking).catch(async (error) => {
        await git("rebase", "--abort").catch(() => {});
        throw error;
      });
      lastSyncError = null;
      await touch(syncStampPath(dir));
    } catch (error) {
      lastSyncError = errorText(error);
      throw error;
    } finally {
      lastSyncAt = Date.now();
    }
  }

  async function remoteHasBranch(): Promise<boolean> {
    const heads = await git("ls-remote", "--heads", "origin", branch).catch((error) => {
      throw new Error(`Cannot reach ${repo}: ${errorText(error)}`);
    });
    return heads.trim() !== "";
  }

  // Converges any state of the checkout (missing, empty, interrupted at any step) on a clone of the
  // remote branch, creating the branch when the remote has none.
  async function initLocked(): Promise<"existing" | "cloned" | "created"> {
    await mkdir(dir, { recursive: true });
    const fresh = !existsSync(join(dir, ".git"));
    if (fresh) {
      if ((await readdir(dir)).length > 0) throw new Error(`${dir} exists and is not a git checkout.`);
      await git("init", "-q", "-b", branch);
    }
    const url = await git("remote", "get-url", "origin").then((s) => s.trim(), () => null);
    if (url === null) await git("remote", "add", "-t", branch, "origin", repo);
    else if (url !== repo) throw new Error(`${dir} tracks ${url}, not ${repo}.`);
    const current = (await git("symbolic-ref", "-q", "--short", "HEAD").catch(() => "")).trim();
    if (current !== branch) throw new Error(`${dir} is on ${current || "a detached HEAD"}, not on branch ${branch}.`);
    const hasCommit = await git("rev-parse", "-q", "--verify", "HEAD").then(() => true, () => false);

    if (await remoteHasBranch()) {
      await git("fetch", "-q", "origin", `+refs/heads/${branch}:${tracking}`);
      const related = hasCommit && (await git("merge-base", "HEAD", tracking).then(() => true, () => false));
      if (!related) {
        // Nothing here yet, or only a first commit that lost the race to create the branch.
        await git("reset", "-q", "--hard", tracking);
        await upstream();
        return "cloned";
      }
      await sync();
      return fresh ? "cloned" : "existing";
    }

    if (!hasCommit) {
      await writeFile(join(dir, "README.md"), README);
      await git("add", "README.md");
      await git("commit", "-q", "-m", "inbox: create store");
    }
    try {
      await git("push", "-q", "origin", `HEAD:${branch}`);
      await upstream();
      return "created";
    } catch {
      // Another host created the branch first: adopt theirs.
      await git("fetch", "-q", "origin", `+refs/heads/${branch}:${tracking}`);
      await git("reset", "-q", "--hard", tracking);
      await upstream();
      return "cloned";
    }
  }

  async function upstream(): Promise<void> {
    await git("branch", "-q", `--set-upstream-to=origin/${branch}`).catch(() => {});
  }

  function pathOf(id: string): string {
    return join(DIR, `${id}.json`);
  }

  async function readOne(id: string): Promise<Message | null> {
    const raw = await readFile(join(dir, pathOf(id)), "utf8").catch(() => null);
    return raw === null ? null : parseMessage(raw);
  }

  async function readAll(): Promise<{ messages: Message[]; skipped: number }> {
    const names = await readdir(join(dir, DIR)).catch(() => [] as string[]);
    const messages: Message[] = [];
    let skipped = 0;
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const message = await readOne(name.slice(0, -".json".length));
      if (message && `${message.id}.json` === name) messages.push(message);
      else skipped++;
    }
    return { messages, skipped };
  }

  // Commits exactly these files and pushes. A rejected push undoes the local commit and starts
  // again from a fresh sync, so a change made meanwhile on another host is re-checked by `prepare`
  // instead of being rebased over.
  async function commit(
    verb: string,
    prepare: () => Promise<{ files: { id: string; message: Message }[] } | string>,
  ): Promise<{ files: { id: string; message: Message }[] } | string> {
    let lastError = "";
    for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(Math.random() * 200 * attempt);
      try {
        await sync();
      } catch (error) {
        return `Could not sync the inbox store: ${errorText(error)}`;
      }
      const prepared = await prepare();
      if (typeof prepared === "string" || prepared.files.length === 0) return prepared;
      await mkdir(join(dir, DIR), { recursive: true });
      const paths = prepared.files.map((f) => pathOf(f.id));
      for (const file of prepared.files) {
        await writeFile(join(dir, pathOf(file.id)), `${JSON.stringify(file.message, null, 2)}\n`);
      }
      const label = prepared.files.length === 1 ? prepared.files[0].id : `${prepared.files.length} messages`;
      await git("add", "--", ...paths);
      await git("commit", "-q", "-m", `inbox: ${verb} ${label}`, "--", ...paths);
      try {
        await git("push", "-q", "origin", `HEAD:${branch}`);
        return prepared;
      } catch (error) {
        lastError = errorText(error);
        await git("reset", "-q", "--keep", "HEAD~1");
      }
    }
    return `Could not push to the inbox store: ${lastError}`;
  }

  function missing(): string | null {
    return existsSync(join(dir, ".git")) ? null : `No inbox store at ${dir}. Run: paseo-inbox init`;
  }

  return {
    dir,

    init(): Promise<"existing" | "cloned" | "created"> {
      return serial(initLocked);
    },

    // Fetches and fast-forwards now; `waitMs: 0` skips the sync when another process holds the lock.
    sync(lock: { waitMs?: number } = {}): Promise<string | null> {
      return serial(async () => {
        const absent = missing();
        if (absent) return absent;
        return sync().then(() => null, errorText);
      }, lock).catch((error) => (error instanceof LockBusy ? null : errorText(error)));
    },

    list(): Promise<{ messages: Message[]; skipped: number; syncError: string | null }> {
      return serial(async () => {
        const absent = missing();
        if (absent) return { messages: [], skipped: 0, syncError: absent };
        if (Date.now() - lastSyncAt >= SYNC_EVERY_MS) await sync().catch(() => {});
        return { ...(await readAll()), syncError: lastSyncError };
      });
    },

    read(id: string): Promise<Message | null | string> {
      return serial(async () => {
        try {
          await sync();
        } catch (error) {
          return `Could not sync the inbox store: ${errorText(error)}`;
        }
        return readOne(id);
      });
    },

    create(message: Message, verb: string): Promise<Write> {
      return serial(async () => {
        const result = await commit(verb, async () =>
          existsSync(join(dir, pathOf(message.id)))
            ? `Message ${message.id} already exists.`
            : { files: [{ id: message.id, message: MessageSchema.parse(message) }] },
        );
        return typeof result === "string" ? refused(result) : { kind: "ok", message: result.files[0].message };
      });
    },

    update(id: string, verb: string, mutate: Mutation): Promise<Write> {
      return serial(async () => {
        if (!MESSAGE_ID.test(id)) return refused(`Invalid message id: ${id}`);
        const result = await commit(verb, async () => {
          const current = await readOne(id);
          if (current === null) return `No message ${id}.`;
          const next = mutate(current);
          return typeof next === "string" ? next : { files: [{ id, message: MessageSchema.parse(next) }] };
        });
        return typeof result === "string" ? refused(result) : { kind: "ok", message: result.files[0].message };
      });
    },

    // One commit for every message `mutate` changes; null leaves a message as it is.
    updateMany(ids: string[], verb: string, mutate: (current: Message) => Message | null): Promise<string[] | string> {
      return serial(async () => {
        const result = await commit(verb, async () => {
          const files = [];
          for (const id of ids.filter((i) => MESSAGE_ID.test(i))) {
            const current = await readOne(id);
            const next = current && mutate(current);
            if (next) files.push({ id, message: MessageSchema.parse(next) });
          }
          return { files };
        });
        return typeof result === "string" ? result : result.files.map((f) => f.id);
      });
    },

    addMissing(messages: Message[], verb: string): Promise<string[] | string> {
      return serial(async () => {
        const result = await commit(verb, async () => {
          const files = [];
          for (const message of messages) {
            if (!existsSync(join(dir, pathOf(message.id)))) {
              files.push({ id: message.id, message: MessageSchema.parse(message) });
            }
          }
          return { files };
        });
        return typeof result === "string" ? result : result.files.map((f) => f.id);
      });
    },
  };
}

function refused(reason: string): Write {
  return { kind: "refused", reason };
}

export function errorText(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error && String(error.stderr).trim()) {
    return String(error.stderr).trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Next to the checkout rather than inside it, so `init` can take it before the directory exists.
export function storeLockPath(dir: string): string {
  return `${resolve(dir)}.lock`;
}

// Local state of this checkout that is not in the store: receipts waiting for a sync, hook cursors.
export function stateDir(dir: string): string {
  return join(dir, ".git", "paseo-inbox");
}

// Touched after every successful sync; hooks read its age to throttle their own syncs.
export function syncStampPath(dir: string): string {
  return join(stateDir(dir), "synced-at");
}

export async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const draft = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  await writeFile(draft, text);
  await rename(draft, path);
}

async function touch(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const now = new Date();
  await utimes(path, now, now).catch(() => writeFile(path, ""));
}

export function parseMessage(raw: string): Message | null {
  try {
    const parsed = MessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Waits out an index.lock left by a git process outside this package (an editor, a shell).
export async function runGit(dir: string, args: string[]): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { stdout } = await run("git", ["-C", dir, ...args], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const message = errorText(error);
      if (!message.includes("index.lock") || attempt >= 6) throw new Error(message);
      await sleep(300);
    }
  }
}
