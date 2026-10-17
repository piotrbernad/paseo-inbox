import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  type AgentMessage,
  type AgentParty,
  type AnsweredQuestion,
  isRecent,
  type Message,
  type Party,
  partyName,
  type Read,
} from "../shared/message.ts";
import type { Config } from "./config.ts";
import { answerText, formatWhen, isAnswered } from "./questions.ts";
import { replyHint, tags } from "./send.ts";
import { stateDir, type Store, writeAtomic } from "./store.ts";

// The agent reading its inbox: its session, and its role on this host.
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

// Messages to this agent (or to its role on its host) and answers to its questions that it has
// not read, oldest first. `skip`: ids to leave out, such as receipts not committed yet.
export function unreadFor(messages: readonly Message[], reader: Reader, skip: ReadonlySet<string>, now: number): Unread[] {
  return messages
    .filter((m): m is Unread => !skip.has(m.id) && isRecent(m, now) && unreadBy(m, reader))
    .sort((a, b) => arrivedAt(a).localeCompare(arrivedAt(b)));
}

function arrivedAt(m: Unread): string {
  return m.question === null ? m.sentAt : m.question.state.at;
}

// Who a message is from, for the agent reading it: the sender, or the person who answered.
export function senderOf(m: Unread): Party {
  return m.question === null ? m.from : { kind: "person", person: m.question.state.by };
}

export const READ_HEADER = "Unread inbox messages (sent through paseo-inbox, not by your human in this chat):";

// What `paseo-inbox read` prints: every message whole, with the command that answers it.
export function readText(messages: readonly Unread[], config: Config): string {
  if (messages.length === 0) return "No unread messages.";
  const blocks = messages.map((m) => {
    const from = senderOf(m);
    const when = formatWhen(arrivedAt(m));
    if (m.question === null) {
      return [
        `[${m.id}] from ${partyName(from, config.people)}${tags(m.ref, m.inReplyTo)}, ${when}`,
        m.body,
        replyHint({ id: m.id, from, to: m.to }, config.people),
      ].join("\n");
    }
    return [
      `[${m.id}] answer from ${partyName(from, config.people)}${tags(m.ref, null)}, ${when}`,
      answerText(m),
      replyHint({ id: null, from, to: m.from }, config.people),
    ].join("\n");
  });
  return [READ_HEADER, ...blocks].join("\n\n");
}

// Read receipts wait in .git/paseo-inbox/receipts until a sync commits them, all in one commit.
function receiptsDir(dir: string): string {
  return join(stateDir(dir), "receipts");
}

const ReceiptSchema = z.object({ id: z.string(), at: z.string(), agentId: z.string(), title: z.string().nullable().default(null) });

export async function queueReceipts(dir: string, ids: readonly string[], read: Read): Promise<void> {
  for (const id of ids) await writeAtomic(join(receiptsDir(dir), `${id}.json`), JSON.stringify({ id, ...read }));
}

export async function queuedIds(dir: string): Promise<Set<string>> {
  const names = await readdir(receiptsDir(dir)).catch(() => [] as string[]);
  return new Set(names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -".json".length)));
}

function withReceipt(m: Message, read: Read): Message | null {
  if (m.question === null) return m.read === null ? { ...m, read } : null;
  if (!isAnswered(m) || m.question.state.read !== null) return null;
  return { ...m, question: { ...m.question, state: { ...m.question.state, read } } };
}

// Commits the queued receipts in one commit, then syncs. Receipts that are in the store (or whose
// message is gone) are removed; the rest wait for the next sync.
export async function flushReceipts(store: Store, dir: string): Promise<string | null> {
  const receipts = new Map<string, { file: string; read: Read }>();
  for (const id of await queuedIds(dir)) {
    const file = join(receiptsDir(dir), `${id}.json`);
    const parsed = ReceiptSchema.safeParse(safeJson(await readFile(file, "utf8").catch(() => "")));
    if (parsed.success) {
      const { at, agentId, title } = parsed.data;
      receipts.set(parsed.data.id, { file, read: { at, agentId, title } });
    } else await rm(file, { force: true });
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

export function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
