import { z } from "zod";

const Iso = z.iso.datetime();

export const MESSAGE_ID = /^\d{8}-\d{4}-[a-z0-9]+-[a-z0-9]{4}$/;

export const PersonSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().min(1),
  host: z.string().min(1),
});
export type Person = z.infer<typeof PersonSchema>;

export const PersonPartySchema = z.object({ kind: z.literal("person"), person: z.string().min(1) });
export type PersonParty = z.infer<typeof PersonPartySchema>;

export const AgentPartySchema = z
  .object({
    kind: z.literal("agent"),
    role: z.string().min(1).nullable(),
    agentId: z.string().min(1).nullable(),
    title: z.string().nullable(),
    host: z.string().min(1),
  })
  .refine((p) => p.role !== null || p.agentId !== null, "An agent party needs a role or an agent id.");
export type AgentParty = z.infer<typeof AgentPartySchema>;

export const PartySchema = z.union([PersonPartySchema, AgentPartySchema]);
export type Party = z.infer<typeof PartySchema>;

export const DeliverySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending") }),
  z.object({ kind: z.literal("delivered"), at: Iso }),
  z.object({ kind: z.literal("failed"), at: Iso, error: z.string() }),
]);
export type Delivery = z.infer<typeof DeliverySchema>;

// The recipient agent's read receipt, written when a hook put the message into its context.
export const ReadSchema = z.object({ at: Iso, agentId: z.string().min(1) });
export type Read = z.infer<typeof ReadSchema>;


export const AnsweredSchema = z.object({
  kind: z.literal("answered"),
  choice: z.string().nullable(),
  text: z.string(),
  by: z.string().min(1),
  at: Iso,
  delivery: DeliverySchema,
  // The asking agent's receipt for the answer.
  read: ReadSchema.nullable(),
});
export type Answered = z.infer<typeof AnsweredSchema>;

export const QuestionStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open") }),
  AnsweredSchema,
  z.object({ kind: z.literal("withdrawn"), at: Iso, reason: z.string() }),
]);
export type QuestionState = z.infer<typeof QuestionStateSchema>;

export const QuestionSchema = z.object({
  title: z.string().min(1),
  options: z.array(z.object({ key: z.string().min(1), text: z.string() })),
  recommendation: z.string().nullable(),
  state: QuestionStateSchema,
});
export type Question = z.infer<typeof QuestionSchema>;

const envelope = {
  version: z.literal(1),
  id: z.string().regex(MESSAGE_ID),
  from: PartySchema,
  ref: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  sentAt: Iso,
  body: z.string(),
};

// `read` is set once the message is in its recipient's context: put there by the hook, or sent
// whole into its chat.
export const AgentMessageSchema = z.object({
  ...envelope,
  to: AgentPartySchema,
  question: z.null(),
  // false (`send --fyi`): never wake an idle recipient; it reads the message at its next turn.
  wake: z.boolean().default(true),
  read: ReadSchema.nullable(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const QuestionMessageSchema = z.object({ ...envelope, to: PersonPartySchema, question: QuestionSchema });

// A question is exactly a message addressed to a person; agents never receive one and people
// never receive anything else.
export const MessageSchema = z.preprocess(
  withLegacyReceipts,
  z.union([AgentMessageSchema, QuestionMessageSchema]),
);
export type Message = z.infer<typeof MessageSchema>;
export type QuestionMessage = Extract<Message, { question: Question }>;
export type AnsweredQuestion = QuestionMessage & { question: Question & { state: Answered } };

// Files written before receipts existed have none. Back then every message, and every delivered
// answer, went whole into the recipient's chat, so those count as read at delivery.
function withLegacyReceipts(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const agentOf = (party: unknown) =>
    isRecord(party) ? String(party.agentId ?? party.role ?? "unknown") : "unknown";
  if (raw.question === null && !("read" in raw)) {
    return { ...raw, read: { at: raw.sentAt, agentId: agentOf(raw.to) } };
  }
  const question = raw.question;
  if (!isRecord(question) || !isRecord(question.state)) return raw;
  const { state } = question;
  if (state.kind !== "answered" || "read" in state) return raw;
  const delivery = isRecord(state.delivery) ? state.delivery : {};
  const read = delivery.kind === "delivered" ? { at: delivery.at, agentId: agentOf(raw.from) } : null;
  return { ...raw, question: { ...question, state: { ...state, read } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOpenQuestion(message: Message): message is QuestionMessage {
  return message.question !== null && message.question.state.kind === "open";
}

export function partyKey(party: Party): string {
  if (party.kind === "person") return `person:${party.person}`;
  return party.role !== null ? `role:${party.role}` : `agent:${party.agentId}`;
}

export function partyLabel(party: Party, people: readonly Person[]): string {
  if (party.kind === "person") return people.find((p) => p.id === party.person)?.name ?? party.person;
  const name = party.role ?? party.title ?? party.agentId?.slice(0, 8) ?? "agent";
  return `${name} · ${party.host}`;
}

export function partyName(party: Party, people: readonly Person[]): string {
  if (party.kind === "person") return people.find((p) => p.id === party.person)?.name ?? party.person;
  return party.role ?? party.title ?? party.agentId?.slice(0, 8) ?? "an agent";
}

export function isWatched(message: Message, watched: readonly string[]): boolean {
  if (watched.length === 0) return true;
  return watched.includes(partyKey(message.from)) || watched.includes(partyKey(message.to));
}

// Empty `watched` means everyone. Toggling one party off from "everyone" watches all the others.
export function nextWatched(watched: readonly string[], allKeys: readonly string[], key: string): string[] {
  const current = watched.length === 0 ? [...allKeys] : [...watched];
  const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
  if (next.length === 0) return [...watched];
  return allKeys.every((k) => next.includes(k)) ? [] : next;
}

export function lastActivity(message: Message): string {
  const state = message.question?.state;
  return state && state.kind !== "open" && state.at > message.sentAt ? state.at : message.sentAt;
}

export const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

// Open questions stay until someone acts on them; everything else drops off after a week.
export function isRecent(message: Message, now: number): boolean {
  return isOpenQuestion(message) || Date.parse(lastActivity(message)) >= now - RECENT_MS;
}

export function newestFirst(a: Message, b: Message): number {
  return lastActivity(b).localeCompare(lastActivity(a));
}

export type PartyEntry = { key: string; label: string };

export function partyEntries(messages: readonly Message[], people: readonly Person[]): PartyEntry[] {
  const entries = new Map<string, PartyEntry>();
  for (const person of people) {
    const key = partyKey({ kind: "person", person: person.id });
    entries.set(key, { key, label: person.name });
  }
  for (const message of [...messages].sort(newestFirst)) {
    for (const party of [message.from, message.to]) {
      const key = partyKey(party);
      if (!entries.has(key)) entries.set(key, { key, label: partyLabel(party, people) });
    }
  }
  return [...entries.values()];
}
