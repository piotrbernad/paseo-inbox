import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { MESSAGE_ID, type Message, MessageSchema } from "../shared/message.ts";

const run = promisify(execFile);
const PULL_EVERY_MS = 15_000;
const DIR = "messages";

export type Write = { kind: "ok"; message: Message } | { kind: "refused"; reason: string };
// Returns the next version of the message, or a refusal shown to the caller.
export type Mutation = (current: Message) => Message | string;

export type Store = ReturnType<typeof createStore>;

const README = `# Inbox store

Written by paseo-inbox. One JSON file per message in \`messages/\`. Do not edit by hand.
`;

export function createStore(opts: { dir: string; branch: string; repo: string }) {
  const { dir, branch, repo } = opts;
  let lastPullAt = 0;
  let lastPullError: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  // The CLI, the plugin and other hosts share this checkout and its remote, so every git step in
  // this process goes through one queue and waits out an index.lock held by another process.
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  }

  async function git(...args: string[]): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      try {
        const { stdout } = await run("git", ["-C", dir, ...args], {
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        return stdout;
      } catch (error) {
        const message = errorText(error);
        if (!message.includes("index.lock") || attempt >= 6) throw new Error(message);
        await sleep(300);
      }
    }
  }

  async function pull(): Promise<void> {
    try {
      await git("pull", "-q", "--rebase", "--autostash", "origin", branch);
      lastPullError = null;
    } catch (error) {
      lastPullError = errorText(error);
      throw error;
    } finally {
      lastPullAt = Date.now();
    }
  }

  function pathOf(id: string): string {
    return join(DIR, `${id}.json`);
  }

  async function readOne(id: string): Promise<Message | null> {
    const raw = await readFile(join(dir, pathOf(id)), "utf8").catch(() => null);
    if (raw === null) return null;
    try {
      const parsed = MessageSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
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
  // again from a fresh pull, so a change made meanwhile on another host is re-checked by `prepare`
  // instead of being rebased over.
  async function commit(
    verb: string,
    prepare: () => Promise<{ files: { id: string; message: Message }[] } | string>,
  ): Promise<{ files: { id: string; message: Message }[] } | string> {
    let lastError = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await pull();
      } catch (error) {
        return `Could not pull the inbox store: ${errorText(error)}`;
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

  return {
    dir,

    // Clones the store branch, or creates it on the remote as an orphan branch when it is missing.
    // Safe to run again on an existing checkout.
    init(): Promise<"existing" | "cloned" | "created"> {
      return serial(async () => {
        if (existsSync(join(dir, ".git"))) return "existing";
        const heads = await run("git", ["ls-remote", "--heads", repo, branch], {
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        }).catch((error) => {
          throw new Error(`Cannot reach ${repo}: ${errorText(error)}`);
        });
        if (heads.stdout.trim() !== "") {
          await run("git", ["clone", "-q", "--branch", branch, "--single-branch", repo, dir]);
          return "cloned";
        }
        await mkdir(dir, { recursive: true });
        await run("git", ["init", "-q", "-b", branch, dir]);
        await git("remote", "add", "origin", repo);
        await writeFile(join(dir, "README.md"), README);
        await git("add", "README.md");
        await git("commit", "-q", "-m", "inbox: create store");
        try {
          await git("push", "-q", "origin", `HEAD:${branch}`);
          await git("branch", "-q", `--set-upstream-to=origin/${branch}`).catch(() => {});
          return "created";
        } catch {
          // Another host created the branch first: adopt theirs.
          await git("fetch", "-q", "origin", branch);
          await git("reset", "-q", "--hard", "FETCH_HEAD");
          return "cloned";
        }
      });
    },

    list(): Promise<{ messages: Message[]; skipped: number; syncError: string | null }> {
      return serial(async () => {
        if (!existsSync(join(dir, ".git"))) {
          return { messages: [], skipped: 0, syncError: `No inbox store at ${dir}. Run: paseo-inbox init` };
        }
        if (Date.now() - lastPullAt >= PULL_EVERY_MS) await pull().catch(() => {});
        return { ...(await readAll()), syncError: lastPullError };
      });
    },

    // Pulls first so the caller sees the newest state of one message.
    read(id: string): Promise<Message | null | string> {
      return serial(async () => {
        try {
          await pull();
        } catch (error) {
          return `Could not pull the inbox store: ${errorText(error)}`;
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

    // Adds every message whose file does not exist yet, in one commit. Returns the ids it added.
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
