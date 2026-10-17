import { type Message, partyName, type Person, receiptOf } from "../shared/message.ts";
import type { AgentStatus } from "./hosts.ts";
import { stubText } from "./send.ts";

// A hook reads messages after a tool call or at a turn. An agent that makes no tool calls for this
// long, or that went idle without being woken, gets the wake-up stub from its host's plugin.
export const OVERDUE_MS = 10 * 60_000;
// Older messages are left alone, so a plugin restart does not nudge agents about last week.
const WINDOW_MS = 24 * 60 * 60_000;

type Waiting = { message: Message; from: string };

// Messages that need action from agents on `self`, unread for OVERDUE_MS, by recipient agent id.
export function overdue(
  messages: readonly Message[],
  opts: { self: string; now: number; nudged: ReadonlySet<string>; people: readonly Person[] },
): Map<string, Waiting[]> {
  const byAgent = new Map<string, Waiting[]>();
  for (const message of messages) {
    if (opts.nudged.has(message.id)) continue;
    if (message.question === null && !message.wake) continue;
    const receipt = receiptOf(message);
    if (!receipt || receipt.read !== null || receipt.reader.host !== opts.self || receipt.reader.agentId === null) continue;
    const answered = message.question?.state.kind === "answered" ? message.question.state : null;
    const age = opts.now - Date.parse(answered ? answered.at : message.sentAt);
    if (age < OVERDUE_MS || age > WINDOW_MS) continue;
    const from = answered ? partyName({ kind: "person", person: answered.by }, opts.people) : partyName(message.from, opts.people);
    const list = byAgent.get(receipt.reader.agentId) ?? [];
    list.push({ message, from });
    byAgent.set(receipt.reader.agentId, list);
  }
  return byAgent;
}

export type FallbackDeps = {
  state(): Promise<{ messages: Message[]; self: string; hookHost: boolean; people: readonly Person[] } | null>;
  // Null when the agent is gone from this host.
  status(agentId: string): Promise<AgentStatus | null>;
  steer(agentId: string, text: string): Promise<void>;
  now?: () => Date;
};

export function createFallback(deps: FallbackDeps) {
  const nudged = new Set<string>();
  return {
    async poll(): Promise<void> {
      const state = await deps.state();
      if (!state?.hookHost) return;
      const now = (deps.now?.() ?? new Date()).getTime();
      for (const [agentId, waiting] of overdue(state.messages, { ...state, now, nudged })) {
        const status = await deps.status(agentId);
        if (status === "running" || status === "idle") {
          const ref = waiting.length === 1 ? waiting[0].message.ref : null;
          await deps.steer(agentId, stubText(waiting.map((w) => w.from), ref));
        }
        for (const { message } of waiting) nudged.add(message.id);
      }
    },
  };
}
