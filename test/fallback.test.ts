import assert from "node:assert/strict";
import { test } from "node:test";
import { createFallback, OVERDUE_MS, overdue } from "../server/fallback.ts";
import type { AgentStatus } from "../server/hosts.ts";
import { type Message, MessageSchema } from "../shared/message.ts";
import { PEOPLE } from "./helpers.ts";

const NOW = Date.parse("2026-10-17T20:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
let n = 0;

function message(extra: { to?: string; host?: string; wake?: boolean; read?: object | null; sent?: number; ref?: string | null } = {}): Message {
  n++;
  return MessageSchema.parse({
    version: 1,
    id: `20261017-1900-lead-${String(n).padStart(4, "0")}`,
    from: { kind: "agent", role: "lead", agentId: "lead-1", title: null, host: "host-a" },
    to: { kind: "agent", role: "designer", agentId: extra.to ?? "designer-1", title: null, host: extra.host ?? "host-b" },
    ref: extra.ref ?? null,
    inReplyTo: null,
    sentAt: minutesAgo(extra.sent ?? 11),
    body: "b",
    question: null,
    wake: extra.wake ?? true,
    read: extra.read === undefined ? null : extra.read,
  });
}

function answer(minutes: number, read: object | null = null): Message {
  n++;
  return MessageSchema.parse({
    version: 1,
    id: `20261017-1800-designer-${String(n).padStart(4, "0")}`,
    from: { kind: "agent", role: "designer", agentId: "designer-1", title: null, host: "host-b" },
    to: { kind: "person", person: "alice" },
    ref: "REF-2",
    inReplyTo: null,
    sentAt: minutesAgo(120),
    body: "",
    question: {
      title: "Q",
      options: [],
      recommendation: null,
      state: { kind: "answered", choice: null, text: "yes", by: "alice", at: minutesAgo(minutes), delivery: { kind: "delivered", at: minutesAgo(minutes) }, read },
    },
  });
}

test("overdue: unread actionable messages and answers for agents on this host, 10 minutes to a day old", () => {
  const due = message({ ref: "REF-1" });
  const dueAnswer = answer(15);
  const skipped = [
    message({ sent: 9 }),
    message({ sent: 25 * 60 }),
    message({ wake: false }),
    message({ read: { at: minutesAgo(1), agentId: "designer-1" } }),
    message({ host: "host-a" }),
    answer(5),
    answer(30, { at: minutesAgo(1), agentId: "designer-1" }),
  ];
  const nudgedBefore = message();
  const result = overdue([due, dueAnswer, ...skipped, nudgedBefore], {
    self: "host-b",
    now: NOW,
    nudged: new Set([nudgedBefore.id]),
    people: PEOPLE,
  });
  assert.deepEqual([...result.keys()], ["designer-1"]);
  assert.deepEqual(result.get("designer-1")?.map((w) => [w.message.id, w.from]), [[due.id, "lead"], [dueAnswer.id, "Alice"]]);
  assert.equal(OVERDUE_MS, 600_000);
});

test("the fallback steers one stub per agent that is running or idle, once, and only on a hook host", async () => {
  const steered: [string, string][] = [];
  const statuses: Record<string, AgentStatus | null> = { "designer-1": "running", "designer-2": "closed", "designer-3": "idle" };
  const messages = [message({ ref: "REF-7" }), message({ to: "designer-2" }), message({ to: "designer-3" }), message({ to: "designer-3" })];
  let hookHost = false;
  const fallback = createFallback({
    state: async () => ({ messages, self: "host-b", hookHost, people: PEOPLE }),
    status: async (id) => statuses[id] ?? null,
    steer: async (id, text) => {
      steered.push([id, text]);
    },
    now: () => new Date(NOW),
  });
  await fallback.poll();
  assert.deepEqual(steered, [], "hosts without the hook have nothing to fall back on");
  hookHost = true;
  await fallback.poll();
  assert.deepEqual(steered, [
    ["designer-1", "Inbox: 1 new message from lead (REF-7)."],
    ["designer-3", "Inbox: 2 new messages from lead."],
  ]);
  await fallback.poll();
  assert.equal(steered.length, 2, "each message is nudged about once");
});
