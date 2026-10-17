import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type Message, partyName } from "../shared/message.ts";
import type { Config } from "./config.ts";
import { LockBusy, withLock } from "./lock.ts";
import { parseMessage, runGit, stateDir, syncStampPath, writeAtomic } from "./store.ts";
import { queuedIds, type Reader, safeJson, senderOf, type Unread, unreadFor } from "./unread.ts";

const SYNC_EVERY_MS = 20_000;
const ROLE_TTL_MS = 10 * 60_000;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The hook never puts a message into the agent's context. It tells the agent, once per batch, that
// messages wait, and the agent reads them with `paseo-inbox read`.
export function noticeText(batch: readonly Unread[], config: Config): string {
  const from = [...new Set(batch.map((m) => partyName(senderOf(m), config.people)))].join(", ");
  return config.noticeText.replaceAll("{count}", String(batch.length)).replaceAll("{from}", from);
}

// Per agent: the commit it last looked at, its role, and the unread messages it was told about.
const CursorSchema = z.object({
  head: z.string().nullable(),
  role: z.string().nullable(),
  roleAt: z.number(),
  announced: z.array(z.string()),
});
type Cursor = z.infer<typeof CursorSchema>;

// HEAD without spawning git: the loose ref, then packed-refs. `refFile` is the loose ref, when
// there is one, for the launcher's fast path.
export async function readHead(dir: string): Promise<{ sha: string; refFile: string | null } | null> {
  const gitDir = join(dir, ".git");
  const head = (await readFile(join(gitDir, "HEAD"), "utf8").catch(() => "")).trim();
  if (!head.startsWith("ref: ")) return /^[0-9a-f]{40,64}$/.test(head) ? { sha: head, refFile: null } : null;
  const ref = head.slice("ref: ".length);
  const refFile = join(gitDir, ref);
  const loose = (await readFile(refFile, "utf8").catch(() => "")).trim();
  if (loose) return { sha: loose, refFile };
  const packed = await readFile(join(gitDir, "packed-refs"), "utf8").catch(() => "");
  const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
  return line ? { sha: line.split(" ")[0], refFile: null } : null;
}

// bin/paseo-inbox answers a PostToolUse hook without starting Node when this agent's file says
// nothing changed and no sync is due. Its lines: the config path as the launcher spells it, the ref
// file, the commit last read, and the second from which a sync is due.
export type FastPath = { dir: string; config: string };

async function writeFastPath(fast: FastPath | null, agentId: string, lines: string[] | null): Promise<void> {
  if (!fast) return;
  const file = join(fast.dir, agentId);
  if (lines === null) return rm(file, { force: true });
  await mkdir(fast.dir, { recursive: true, mode: 0o700 });
  await writeAtomic(file, `${[fast.config, ...lines].join("\n")}\n`);
}

async function changedIds(dir: string, from: string | null, to: string, now: number): Promise<string[]> {
  const names = from
    ? await runGit(dir, ["diff", "--name-only", "--no-renames", from, to, "--", "messages/"]).catch(() => null)
    : null;
  if (names !== null) return idsOf(names);
  // No usable cursor: everything recent enough to be unread.
  const since = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  const all = idsOf(await runGit(dir, ["ls-tree", "--name-only", to, "messages/"]));
  return all.filter((id) => id.slice(0, 8) >= since);
}

function idsOf(names: string): string[] {
  return names
    .split("\n")
    .map((n) => n.trim().match(/^messages\/(.+)\.json$/)?.[1])
    .filter((id): id is string => id !== undefined);
}

// Reads the messages as of `commit` in one git call, never from a working tree a sync may be
// rewriting at this moment.
async function readAt(dir: string, commit: string, ids: readonly string[]): Promise<Message[]> {
  if (ids.length === 0) return [];
  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", ["-C", dir, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git cat-file exited ${code}`))));
    child.stdin.end(ids.map((id) => `${commit}:messages/${id}.json\n`).join(""));
  });
  const messages: Message[] = [];
  let at = 0;
  while (at < output.length) {
    const eol = output.indexOf(10, at);
    if (eol === -1) break;
    const line = output.subarray(at, eol).toString();
    at = eol + 1;
    const size = Number(line.split(" ")[2]);
    if (!line.includes(" blob ") || !Number.isFinite(size)) continue;
    const message = parseMessage(output.subarray(at, at + size).toString("utf8"));
    if (message) messages.push(message);
    at += size + 1;
  }
  return messages;
}

export type HookEvent = { name: "UserPromptSubmit" | "PostToolUse" };

export function parseHookEvent(stdin: string): HookEvent | null {
  const json = safeJson(stdin);
  if (typeof json !== "object" || json === null) return null;
  const { hook_event_name: name } = json as Record<string, unknown>;
  return name === "UserPromptSubmit" || name === "PostToolUse" ? { name } : null;
}

export type HookDeps = {
  config: Config;
  agentId: string | undefined;
  now(): Date;
  // The agent's role label from its daemon; null when unknown.
  lookupRole(agentId: string): Promise<string | null>;
  // Starts `paseo-inbox sync` without waiting for it.
  syncInBackground(): void;
  fastPath: FastPath | null;
};

// Returns the hook's stdout, or null for no output. Throws only on bugs; the CLI swallows those.
export async function runHook(stdin: string, deps: HookDeps): Promise<string | null> {
  const event = parseHookEvent(stdin);
  const { agentId, config } = deps;
  const { dir } = config.store;
  if (!event || !agentId || !AGENT_ID.test(agentId) || !existsSync(join(dir, ".git"))) return null;

  let synced = await stat(syncStampPath(dir)).then((s) => s.mtimeMs, () => 0);
  if (deps.now().getTime() - synced >= SYNC_EVERY_MS) {
    deps.syncInBackground();
    synced = 0;
  }
  const syncDue = Math.floor((synced + SYNC_EVERY_MS) / 1000);

  const agents = join(stateDir(dir), "agents");
  await mkdir(agents, { recursive: true });
  // Tool calls can run in parallel: one hook per agent at a time, the others find nothing new.
  return withLock(join(agents, `${agentId}.lock`), () => announce(event, agentId, deps, join(agents, `${agentId}.json`), syncDue), {
    waitMs: 3_000,
  }).catch((error) => {
    if (error instanceof LockBusy) return null;
    throw error;
  });
}

async function announce(event: HookEvent, agentId: string, deps: HookDeps, cursorPath: string, syncDue: number): Promise<string | null> {
  const { config } = deps;
  const { dir } = config.store;
  const current = await readHead(dir);
  if (current === null) return null;
  const head = current.sha;
  const caughtUp = () =>
    writeFastPath(deps.fastPath, agentId, current.refFile ? [current.refFile, head, String(syncDue)] : null);
  const parsed = CursorSchema.safeParse(safeJson(await readFile(cursorPath, "utf8").catch(() => "")));
  const cursor: Cursor = parsed.success ? parsed.data : { head: null, role: null, roleAt: 0, announced: [] };
  if (cursor.head === head) {
    await caughtUp();
    return null;
  }

  const now = deps.now();
  let { role, roleAt } = cursor;
  if (now.getTime() - roleAt >= ROLE_TTL_MS) {
    role = (await deps.lookupRole(agentId).catch(() => undefined)) ?? role;
    roleAt = now.getTime();
  }
  const reader: Reader = { agentId, role, host: config.self };
  const messages = await readAt(dir, head, await changedIds(dir, cursor.head, head, now.getTime()));
  const announced = new Set(cursor.announced);
  // Receipts `read` has queued but not committed yet.
  const batch = unreadFor(messages, reader, new Set([...announced, ...(await queuedIds(dir))]), now.getTime());
  for (const m of batch) announced.add(m.id);
  const since = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  const next: Cursor = { head, role, roleAt, announced: [...announced].filter((id) => id.slice(0, 8) >= since) };
  await writeAtomic(cursorPath, JSON.stringify(next));
  await caughtUp();
  if (batch.length === 0) return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event.name, additionalContext: noticeText(batch, config) } });
}
