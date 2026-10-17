import { randomInt } from "node:crypto";
import { type AgentParty, type Message, type Party, partyLabel, partyName } from "../shared/message.ts";
import type { Config } from "./config.ts";
import type { Directory, Located } from "./hosts.ts";
import type { Store } from "./store.ts";

export type Recipient = { kind: "role"; role: string } | { kind: "party"; party: AgentParty };

export type SendInput = {
  from: Party;
  to: Recipient;
  body: string;
  ref: string | null;
  inReplyTo: string | null;
};

export type Sent = { id: string | null; to: AgentParty; recorded: boolean; recordError: string | null };

export function newMessageId(sender: Party, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
  const raw = sender.kind === "person" ? sender.person : (sender.role ?? "agent");
  const slug = raw.toLowerCase().replace(/[^a-z0-9]/g, "") || "agent";
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const rand = Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return `${stamp}-${slug}-${rand}`;
}

// How the recipient names the sender in its reply; also accepted by `send` as TO.
export function addressOf(party: Party): string {
  if (party.kind === "person") return party.person;
  return party.role ?? `agent:${party.agentId}`;
}

export function header(opts: { id: string | null; from: Party; to: AgentParty; ref: string | null; inReplyTo: string | null }, config: Config): string {
  const { id, from, to, ref, inReplyTo } = opts;
  const tags = [ref, inReplyTo ? `re ${inReplyTo}` : null].filter(Boolean).join(", ");
  const first = `[inbox${id ? ` ${id}` : ""}] from ${partyLabel(from, config.people)} to ${partyLabel(to, config.people)}${tags ? ` (${tags})` : ""}`;
  const replyAs = to.role !== null ? `--from ${to.role} ` : "";
  if (from.kind === "person") {
    const name = partyName(from, config.people);
    return `${first}\nNew question to ${name}: paseo-inbox ask ${replyAs}--to ${from.person} --title "…" --context "…"`;
  }
  const re = id ? ` --re ${id}` : "";
  return `${first}\nReply: paseo-inbox send ${replyAs}${addressOf(from)}${re} "…"`;
}

export async function resolveRecipient(directory: Directory, to: Recipient): Promise<Located> {
  if (to.kind === "role") return directory.findRole(to.role);
  const { party } = to;
  if (party.agentId !== null) {
    const found = await directory.findAgent(party.agentId, party.host);
    if (found) return found;
  }
  if (party.role !== null) return directory.findRole(party.role);
  throw new Error(`Agent ${party.agentId} is gone and has no role to look up.`);
}

// Delivers first and records after: a message in the store was seen by its recipient's session.
// `store: null` delivers without recording (answers to questions live in the question itself).
export async function send(
  deps: { config: Config; directory: Directory; store: Store | null; now?: () => Date },
  input: SendInput,
): Promise<Sent> {
  const now = deps.now?.() ?? new Date();
  const located = await resolveRecipient(deps.directory, input.to);
  const to = deps.directory.party(located);
  const id = deps.store ? newMessageId(input.from, now) : null;
  const text = `${header({ id, from: input.from, to, ref: input.ref, inReplyTo: input.inReplyTo }, deps.config)}\n\n${input.body}`;
  await deps.directory.steer(located, text);
  if (!deps.store || !id) return { id, to, recorded: false, recordError: null };

  const message: Message = {
    version: 1,
    id,
    from: input.from,
    to,
    ref: input.ref,
    inReplyTo: input.inReplyTo,
    sentAt: now.toISOString(),
    body: input.body,
    question: null,
    wake: true,
    read: { at: now.toISOString(), agentId: to.agentId ?? to.role ?? "unknown" },
  };
  const written = await deps.store.create(message, "send");
  return written.kind === "ok"
    ? { id, to, recorded: true, recordError: null }
    : { id, to, recorded: false, recordError: written.reason };
}
