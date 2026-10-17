import { randomInt } from "node:crypto";
import {
  type AgentMessage,
  type AgentParty,
  type AnsweredQuestion,
  type Party,
  partyName,
  type Person,
} from "../shared/message.ts";
import type { Config } from "./config.ts";
import type { AgentSnapshot, AgentStatus, Directory, Located } from "./hosts.ts";
import { answerText } from "./questions.ts";
import type { Store } from "./store.ts";

export type Recipient = { kind: "role"; role: string } | { kind: "party"; party: AgentParty };

export type SendInput = {
  from: Party;
  to: Recipient;
  body: string;
  ref: string | null;
  inReplyTo: string | null;
  wake: boolean;
};

// How a message reaches its recipient's session:
// - "message": the whole message as a chat message (hosts without the hook, or nothing recorded
//   for the recipient to read);
// - "wake": config.wakeText wakes the idle recipient, which reads its inbox with `paseo-inbox read`;
// - "none": the recipient's hook tells it at its next tool call or turn.
export type DeliveryMode = "message" | "wake" | "none";

export function deliveryMode(opts: {
  hookHost: boolean;
  recorded: boolean;
  status: AgentStatus | null;
  wake: boolean;
}): DeliveryMode {
  if (!opts.hookHost || !opts.recorded) return "message";
  if (opts.status === "running" || opts.status === "initializing") return "none";
  return opts.wake ? "wake" : "none";
}

export type Sent = {
  id: string | null;
  to: AgentParty;
  mode: DeliveryMode;
  recorded: boolean;
  recordError: string | null;
};

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

export function tags(ref: string | null, inReplyTo: string | null): string {
  const list = [ref, inReplyTo ? `re ${inReplyTo}` : null].filter(Boolean).join(", ");
  return list ? ` (${list})` : "";
}

// The command the recipient answers with: a reply to an agent, or a new question to a person.
export function replyHint(opts: { id: string | null; from: Party; to: AgentParty }, people: readonly Person[]): string {
  const { id, from, to } = opts;
  const replyAs = to.role !== null ? `--from ${to.role} ` : "";
  if (from.kind === "person") {
    return `New question to ${partyName(from, people)}: paseo-inbox ask ${replyAs}--to ${from.person} --title "…" --context "…"`;
  }
  return `Reply: paseo-inbox send ${replyAs}${addressOf(from)}${id ? ` --re ${id}` : ""} "…"`;
}

export function header(
  opts: { id: string | null; from: Party; to: AgentParty; ref: string | null; inReplyTo: string | null },
  config: Config,
): string {
  const { id, from, to, ref, inReplyTo } = opts;
  const first = `[inbox${id ? ` ${id}` : ""}] from ${partyName(from, config.people)} to ${partyName(to, config.people)}${tags(ref, inReplyTo)}`;
  return `${first}\n${replyHint({ id, from, to }, config.people)}`;
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

type Deps = { config: Config; directory: Directory; store: Store | null; now?: () => Date };

// On a hook host the message is recorded first, because the recipient reads it from the store. Elsewhere it is delivered first and recorded after, so a message in the store reached
// its recipient's chat. `store: null` delivers without recording.
export async function send(deps: Deps, input: SendInput): Promise<Sent> {
  const now = deps.now?.() ?? new Date();
  const located = await resolveRecipient(deps.directory, input.to);
  const to = deps.directory.party(located);
  const id = deps.store ? newMessageId(input.from, now) : null;
  const mode = deliveryMode({
    hookHost: deps.config.hookHosts.includes(located.host),
    recorded: deps.store !== null,
    status: located.agent.status ?? null,
    wake: input.wake,
  });
  const whole = () =>
    deps.directory.steer(
      located,
      `${header({ id, from: input.from, to, ref: input.ref, inReplyTo: input.inReplyTo }, deps.config)}\n\n${input.body}`,
    );
  if (!deps.store || !id) {
    await whole();
    return { id, to, mode, recorded: false, recordError: null };
  }

  const message = (read: AgentMessage["read"]): AgentMessage => ({
    version: 1,
    id,
    from: input.from,
    to,
    ref: input.ref,
    inReplyTo: input.inReplyTo,
    sentAt: now.toISOString(),
    body: input.body,
    question: null,
    wake: input.wake,
    read,
  });
  if (mode === "message") {
    await whole();
    const written = await deps.store.create(message({ at: now.toISOString(), agentId: located.agent.id, title: located.agent.title ?? null }), "send");
    return { id, to, mode, recorded: written.kind === "ok", recordError: written.kind === "ok" ? null : written.reason };
  }
  const written = await deps.store.create(message(null), "send");
  if (written.kind === "refused") {
    // The recipient cannot read what is not in the store: hand the whole message over instead.
    await whole();
    return { id, to, mode: "message", recorded: false, recordError: written.reason };
  }
  if (mode === "wake") await deps.directory.steer(located, deps.config.wakeText);
  return { id, to, mode, recorded: true, recordError: null };
}

// An answer is already in the store (in its question), so an agent on a hook host reads it like a
// message.
export async function deliverAnswer(
  deps: { config: Config; directory: Directory },
  question: AnsweredQuestion,
): Promise<{ mode: DeliveryMode; reader: AgentSnapshot }> {
  if (question.from.kind !== "agent") {
    throw new Error("The question was asked by a person, so there is no agent to deliver the answer to.");
  }
  const located = await resolveRecipient(deps.directory, { kind: "party", party: question.from });
  const mode = deliveryMode({
    hookHost: deps.config.hookHosts.includes(located.host),
    recorded: true,
    status: located.agent.status ?? null,
    wake: true,
  });
  if (mode === "message") {
    const from: Party = { kind: "person", person: question.question.state.by };
    const to = deps.directory.party(located);
    const text = `${header({ id: null, from, to, ref: question.ref, inReplyTo: question.id }, deps.config)}\n\n${answerText(question)}`;
    await deps.directory.steer(located, text);
  } else if (mode === "wake") {
    await deps.directory.steer(located, deps.config.wakeText);
  }
  return { mode, reader: located.agent };
}
