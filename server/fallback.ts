import { type Message, receiptOf } from "../shared/message.ts";
import type { AgentStatus } from "./hosts.ts";

// The hook tells an agent about new messages after a tool call or at a turn. An agent that makes no
// tool calls for this long, or that went idle without being woken, gets the wake text from its
// host's plugin.
export const OVERDUE_MS = 10 * 60_000;
// Older messages are left alone, so a plugin restart does not nudge agents about last week.
const WINDOW_MS = 24 * 60 * 60_000;

// Messages that need action from agents on `self`, unread for OVERDUE_MS, by recipient agent id.
export function overdue(
  messages: readonly Message[],
  opts: { self: string; now: number; nudged: ReadonlySet<string> },
): Map<string, Message[]> {
  const byAgent = new Map<string, Message[]>();
  for (const message of messages) {
    if (opts.nudged.has(message.id)) continue;
    if (message.question === null && !message.wake) continue;
    const receipt = receiptOf(message);
    if (!receipt || receipt.read !== null || receipt.reader.host !== opts.self || receipt.reader.agentId === null) continue;
    const answered = message.question?.state.kind === "answered" ? message.question.state : null;
    const age = opts.now - Date.parse(answered ? answered.at : message.sentAt);
    if (age < OVERDUE_MS || age > WINDOW_MS) continue;
    byAgent.set(receipt.reader.agentId, [...(byAgent.get(receipt.reader.agentId) ?? []), message]);
  }
  return byAgent;
}

export type FallbackDeps = {
  state(): Promise<{ messages: Message[]; self: string; hookHost: boolean; wakeText: string } | null>;
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
      for (const [agentId, waiting] of overdue(state.messages, { self: state.self, now, nudged })) {
        const status = await deps.status(agentId);
        if (status === "running" || status === "idle") await deps.steer(agentId, state.wakeText);
        for (const message of waiting) nudged.add(message.id);
      }
    },
  };
}
