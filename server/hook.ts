import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  type AgentMessage,
  type AgentParty,
  type AnsweredQuestion,
  isRecent,
  type Message,
  type Party,
  partyLabel,
  type Read,
} from "../shared/message.ts";
import type { Config } from "./config.ts";
import { LockBusy, withLock } from "./lock.ts";
import { answerText, isAnswered } from "./questions.ts";
import { replyHint, tags } from "./send.ts";
import { parseMessage, runGit, type Store, syncStampPath } from "./store.ts";

export const CONTEXT_HEADER = "Inbox (messages from other agents, not from your human):";
// About 1500 tokens at ~4 characters per token.
export const MAX_CONTEXT_CHARS = 6000;
const MIN_BODY_CHARS = 300;
// Room for the "N more messages" line.
const MORE_LINE_CHARS = 80;
const SYNC_EVERY_MS = 20_000;
const ROLE_TTL_MS = 10 * 60_000;
const STUB_PREFIX = "Inbox: ";
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type Reader = { agentId: string; role: string | null; host: string };

function addressedTo(party: Party, reader: Reader): boolean {
  if (party.kind !== "agent") return false;
  if (party.agentId === reader.agentId) return true;
  return reader.role !== null && party.role === reader.role && party.host === reader.host;
}

// A message for an agent, or the answer to a question an agent asked.
export type Unread = AgentMessage | (AnsweredQuestion & { from: AgentParty });

function unreadBy(m: Message, reader: Reader): m is Unread {
  if (m.question === null) return m.read === null && addressedTo(m.to, reader);
  return isAnswered(m) && m.question.state.read === null && addressedTo(m.from, reader);
}

// Messages to this agent (or to its role on its host) and answers to its questions that are not in
// its context yet, oldest first.
export function unreadFor(messages: readonly Message[], reader: Reader, injected: ReadonlySet<string>, now: number): Unread[] {
  return messages
    .filter((m): m is Unread => !injected.has(m.id) && isRecent(m, now) && unreadBy(m, reader))
    .sort((a, b) => activity(a).localeCompare(activity(b)));
}

function activity(m: Unread): string {
  return m.question === null ? m.sentAt : m.question.state.at;
}

type Entry = { message: Unread; head: string; body: string; tail: string };

function entry(m: Unread, config: Config): Entry {
  const show = `Full text: paseo-inbox show ${m.id}`;
  if (m.question === null) {
    const head = `[${m.id}] from ${partyLabel(m.from, config.people)} to ${partyLabel(m.to, config.people)}${tags(m.ref, m.inReplyTo)}`;
    return { message: m, head, body: m.body, tail: `${show}\n${replyHint({ id: m.id, from: m.from, to: m.to }, config.people)}` };
  }
  const by: Party = { kind: "person", person: m.question.state.by };
  const head = `[${m.id}] answer from ${partyLabel(by, config.people)} to ${partyLabel(m.from, config.people)}${tags(m.ref, null)}`;
  return { message: m, head, body: answerText(m), tail: `${show}\n${replyHint({ id: null, from: by, to: m.from }, config.people)}` };
}

// Fits the block in MAX_CONTEXT_CHARS: whole messages while they fit, bodies cut evenly beyond
// that, and the rest left for the next call.
export function contextText(messages: readonly Unread[], config: Config): { text: string; included: Unread[] } {
  const entries = messages.map((m) => entry(m, config));
  const fixed = (e: Entry) => e.head.length + e.tail.length + 4;
  let budget = MAX_CONTEXT_CHARS - CONTEXT_HEADER.length - MORE_LINE_CHARS;
  const chosen: Entry[] = [];
  for (const e of entries) {
    if (fixed(e) + Math.min(e.body.length, MIN_BODY_CHARS) > budget) break;
    budget -= fixed(e) + Math.min(e.body.length, MIN_BODY_CHARS);
    chosen.push(e);
  }
  // Water-fill the rest of the budget, shortest bodies first.
  const extra = new Map<Entry, number>();
  let left = budget;
  const growing = chosen.filter((e) => e.body.length > MIN_BODY_CHARS).sort((a, b) => a.body.length - b.body.length);
  growing.forEach((e, i) => {
    const share = Math.floor(left / (growing.length - i));
    const take = Math.min(e.body.length - MIN_BODY_CHARS, share);
    extra.set(e, take);
    left -= take;
  });
  const blocks = chosen.map((e) => {
    const room = Math.min(e.body.length, MIN_BODY_CHARS) + (extra.get(e) ?? 0);
    const body = room >= e.body.length ? e.body : `${e.body.slice(0, Math.max(0, room - 40)).trimEnd()} … (cut, see full text)`;
    return `${e.head}\n${body}\n${e.tail}`;
  });
  const rest = entries.length - chosen.length;
  if (rest > 0) blocks.push(`${rest} more message${rest === 1 ? "" : "s"} will follow after your next tool call.`);
  return { text: [CONTEXT_HEADER, ...blocks].join("\n\n"), included: chosen.map((e) => e.message) };
}

const CursorSchema = z.object({
  head: z.string().nullable(),
  role: z.string().nullable(),
  roleAt: z.number(),
  injected: z.array(z.string()),
});
type Cursor = z.infer<typeof CursorSchema>;

const ReceiptSchema = z.object({ id: z.string(), at: z.string(), agentId: z.string() });

function stateDir(dir: string): string {
  return join(dir, ".git", "paseo-inbox");
}

function receiptsDir(dir: string): string {
  return join(stateDir(dir), "receipts");
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const draft = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  await writeFile(draft, text);
  await rename(draft, path);
}

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

export type HookEvent = { name: "UserPromptSubmit" | "PostToolUse"; prompt: string | null };

export function parseHookEvent(stdin: string): HookEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(stdin);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const { hook_event_name: name, prompt } = json as Record<string, unknown>;
  if (name !== "UserPromptSubmit" && name !== "PostToolUse") return null;
  return { name, prompt: typeof prompt === "string" ? prompt : null };
}

export type HookDeps = {
  config: Config;
  store: Store;
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
  const { agentId, config, store } = deps;
  const { dir } = config.store;
  if (!event || !agentId || !AGENT_ID.test(agentId) || !existsSync(join(dir, ".git"))) return null;

  if (event.name === "UserPromptSubmit" && event.prompt?.startsWith(STUB_PREFIX)) {
    // Woken by a stub: the message may have been pushed from another host a moment ago.
    await store.sync({ waitMs: 20_000 });
  }
  let synced = await stat(syncStampPath(dir)).then((s) => s.mtimeMs, () => 0);
  if (deps.now().getTime() - synced >= SYNC_EVERY_MS) {
    deps.syncInBackground();
    synced = 0;
  }
  const syncDue = Math.floor((synced + SYNC_EVERY_MS) / 1000);

  const agents = join(stateDir(dir), "agents");
  await mkdir(agents, { recursive: true });
  // Tool calls can run in parallel: one hook per agent at a time, the others find nothing new.
  return withLock(join(agents, `${agentId}.lock`), () => deliverUnread(event, agentId, deps, join(agents, `${agentId}.json`), syncDue), {
    waitMs: 3_000,
  }).catch((error) => {
    if (error instanceof LockBusy) return null;
    throw error;
  });
}

async function deliverUnread(
  event: HookEvent,
  agentId: string,
  deps: HookDeps,
  cursorPath: string,
  syncDue: number,
): Promise<string | null> {
  const { config } = deps;
  const { dir } = config.store;
  const current = await readHead(dir);
  if (current === null) return null;
  const head = current.sha;
  const caughtUp = () =>
    writeFastPath(deps.fastPath, agentId, current.refFile ? [current.refFile, head, String(syncDue)] : null);
  const raw = await readFile(cursorPath, "utf8").catch(() => null);
  const parsed = raw === null ? null : CursorSchema.safeParse(safeJson(raw));
  const cursor: Cursor = parsed?.success ? parsed.data : { head: null, role: null, roleAt: 0, injected: [] };
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
  const injected = new Set(cursor.injected);
  // Receipts not committed yet, possibly from another session with the same role.
  const queued = (await readdir(receiptsDir(dir)).catch(() => [] as string[])).map((n) => n.replace(/\.json$/, ""));
  const unread = unreadFor(messages, reader, new Set([...injected, ...queued]), now.getTime());
  const { text, included } = contextText(unread, config);

  const at = now.toISOString();
  await mkdir(receiptsDir(dir), { recursive: true });
  for (const m of included) {
    await writeAtomic(join(receiptsDir(dir), `${m.id}.json`), JSON.stringify({ id: m.id, at, agentId }));
    injected.add(m.id);
  }
  const since = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  const next: Cursor = {
    // Leave the cursor where it was while messages wait for room in the next call.
    head: included.length === unread.length ? head : cursor.head,
    role,
    roleAt,
    injected: [...injected].filter((id) => id.slice(0, 8) >= since),
  };
  await writeAtomic(cursorPath, JSON.stringify(next));
  if (next.head === head) await caughtUp();
  else await writeFastPath(deps.fastPath, agentId, null);
  if (included.length === 0) return null;
  deps.syncInBackground();
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event.name, additionalContext: text } });
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function withReceipt(m: Message, read: Read): Message | null {
  if (m.question === null) return m.read === null ? { ...m, read } : null;
  if (!isAnswered(m) || m.question.state.read !== null) return null;
  return { ...m, question: { ...m.question, state: { ...m.question.state, read } } };
}

// Commits the receipts hooks left behind, in one commit, then syncs. Receipts that are in the store
// (or whose message is gone) are removed; the rest wait for the next sync.
export async function flushReceipts(store: Store, dir: string): Promise<string | null> {
  const names = (await readdir(receiptsDir(dir)).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
  const receipts = new Map<string, { file: string; read: Read }>();
  for (const name of names) {
    const file = join(receiptsDir(dir), name);
    const parsed = ReceiptSchema.safeParse(safeJson(await readFile(file, "utf8").catch(() => "")));
    if (parsed.success) receipts.set(parsed.data.id, { file, read: { at: parsed.data.at, agentId: parsed.data.agentId } });
    else await rm(file, { force: true });
  }
  if (receipts.size === 0) return store.sync();
  const written = await store.updateMany([...receipts.keys()], "read", (m) => {
    const receipt = receipts.get(m.id);
    return receipt ? withReceipt(m, receipt.read) : null;
  });
  if (typeof written === "string") return written;
  for (const { file } of receipts.values()) await rm(file, { force: true });
  return null;
}
