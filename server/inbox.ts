import {
  type AgentParty,
  agentsIn,
  type AnsweredQuestion,
  type Delivery,
  isRecent,
  newestFirst,
  partyEntries,
  type Person,
  type Read,
  type Titles,
  withTitles,
} from "../shared/message.ts";
import type { AnswerInput, ListOutput, Result } from "../shared/rpc.ts";
import { answer, isAnswered, recordDelivery } from "./questions.ts";
import type { AgentSnapshot } from "./hosts.ts";
import type { DeliveryMode } from "./send.ts";
import { errorText, type Store } from "./store.ts";

// Hands the answer to the asking agent; the whole answer in its chat counts as read.
export type Deliver = (question: AnsweredQuestion) => Promise<{ mode: DeliveryMode; reader: AgentSnapshot }>;

export type Inbox = ReturnType<typeof createInbox>;

export function createInbox(opts: {
  store: Store;
  people: readonly Person[];
  me: string | null;
  deliver: Deliver;
  // Current session titles of these agents; the list shows them instead of the stored ones.
  titles?: (agents: AgentParty[]) => Promise<Titles>;
  now?: () => Date;
}) {
  const { store, people, deliver } = opts;
  const now = () => opts.now?.() ?? new Date();

  async function deliverAndRecord(message: AnsweredQuestion): Promise<Result> {
    let delivery: Delivery;
    let read: Read | null = null;
    try {
      const { mode, reader } = await deliver(message);
      delivery = { kind: "delivered", at: now().toISOString() };
      if (mode === "message") read = { at: delivery.at, agentId: reader.id, title: reader.title ?? null };
    } catch (error) {
      delivery = { kind: "failed", at: now().toISOString(), error: errorText(error) };
    }
    const recorded = await store.update(message.id, "delivery", (current) => recordDelivery(current, delivery, read, people));
    if (recorded.kind === "refused") {
      const sent = delivery.kind === "delivered" ? "delivered" : "not delivered";
      return { kind: "refused", reason: `Answer saved and ${sent}, but its delivery state was not saved. ${recorded.reason}` };
    }
    return recorded;
  }

  return {
    store,

    async list(): Promise<ListOutput> {
      const { messages, skipped, syncError } = await store.list();
      const at = now().getTime();
      const recent = messages.filter((m) => isRecent(m, at)).sort(newestFirst);
      const titles = (await opts.titles?.(agentsIn(recent)).catch(() => null)) ?? new Map<string, string>();
      const visible = recent.map((m) => withTitles(m, titles));
      return {
        me: opts.me,
        people: [...people],
        messages: visible,
        parties: partyEntries(visible, people),
        skipped,
        syncError,
      };
    },

    async answer(input: AnswerInput): Promise<Result> {
      const answered = await store.update(input.id, "answer", (current) =>
        answer(current, input, people, now().toISOString()),
      );
      if (answered.kind === "refused") return answered;
      return isAnswered(answered.message) ? deliverAndRecord(answered.message) : answered;
    },

    async retryDelivery(id: string): Promise<Result> {
      const current = await store.read(id);
      if (typeof current === "string") return { kind: "refused", reason: current };
      if (current === null) return { kind: "refused", reason: `No message ${id}.` };
      if (!isAnswered(current)) return { kind: "refused", reason: "That question has no answer to deliver." };
      if (current.question.state.delivery.kind === "delivered") {
        return { kind: "refused", reason: `Already delivered at ${current.question.state.delivery.at}.` };
      }
      return deliverAndRecord(current);
    },
  };
}
