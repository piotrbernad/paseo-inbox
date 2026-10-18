import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, QuestionMessage, QuestionState } from "../shared/message.ts";
import {
  createNotifier,
  NOTIFIER_MODEL,
  NOTIFIER_SYSTEM_PROMPT,
  notificationText,
  type NotifierPaseo,
} from "../server/notify.ts";
import { PEOPLE } from "./helpers.ts";

let counter = 0;

function question(to: string, title: string, extra: { ref?: string; state?: QuestionState } = {}): QuestionMessage {
  counter++;
  return {
    version: 1,
    id: `20261017-1200-lead-${String(counter).padStart(4, "0")}`,
    from: { kind: "agent", role: "lead", agentId: "lead-1", title: "Lead", host: "host-a", parentRole: null },
    to: { kind: "person", person: to },
    ref: extra.ref ?? null,
    inReplyTo: null,
    sentAt: `2026-10-17T12:${String(counter).padStart(2, "0")}:00.000Z`,
    body: "",
    question: { title, options: [], recommendation: null, state: extra.state ?? { kind: "open" } },
  };
}

type Call = { kind: "list" } | { kind: "archive"; id: string } | { kind: "create"; options: unknown };

function harness(opts: { me?: string | null; enabled?: boolean; failCreates?: number } = {}) {
  const messages: Message[] = [];
  const calls: Call[] = [];
  const live = new Set<string>();
  let failCreates = opts.failCreates ?? 0;
  let created = 0;
  const settings = { enabled: opts.enabled ?? true };
  const paseo: NotifierPaseo = {
    agents: {
      async list() {
        calls.push({ kind: "list" });
        return { entries: [...live].map((id) => ({ agent: { id } })) };
      },
      ref(id) {
        return {
          async archive() {
            calls.push({ kind: "archive", id });
            live.delete(id);
          },
        };
      },
      async create(options) {
        calls.push({ kind: "create", options });
        if (failCreates > 0) {
          failCreates--;
          throw new Error("provider unavailable");
        }
        live.add(`notifier-${++created}`);
      },
    },
  };
  const notifier = createNotifier({
    inbox: async () => ({
      me: opts.me === undefined ? "alice" : opts.me,
      people: PEOPLE,
      messages: [...messages],
      cwd: "/store",
    }),
    enabled: async () => settings.enabled,
    paseo: () => paseo,
  });
  const creates = () =>
    calls.filter((c): c is Extract<Call, { kind: "create" }> => c.kind === "create").map((c) => c.options);
  return { messages, calls, creates, notifier, settings };
}

test("the first poll seeds open questions without notifying", async () => {
  const h = harness();
  h.messages.push(question("alice", "Old question"));
  await h.notifier.poll();
  await h.notifier.poll();
  assert.deepEqual(h.calls, []);
});

test("a new question to me notifies once with the exact text", async () => {
  const h = harness();
  await h.notifier.poll();
  h.messages.push(question("alice", "Turn off the old checkout?", { ref: "REF-12" }));
  await h.notifier.poll();
  await h.notifier.poll();
  assert.deepEqual(h.creates(), [
    {
      config: { provider: NOTIFIER_MODEL, systemPrompt: NOTIFIER_SYSTEM_PROMPT },
      cwd: "/store",
      title: "Inbox",
      labels: { "paseo-inbox-notifier": "true" },
      prompt: "Question from Lead (REF-12): Turn off the old checkout?",
    },
  ]);
});

test("a question without a ref drops the parenthesis", () => {
  assert.equal(notificationText([question("alice", "Which colour?")], PEOPLE), "Question from Lead: Which colour?");
});

test("a question to another person never notifies", async () => {
  const h = harness();
  await h.notifier.poll();
  h.messages.push(question("bob", "Package price?"));
  await h.notifier.poll();
  assert.deepEqual(h.calls, []);
});

test("closed questions and plain messages never notify", async () => {
  const h = harness();
  await h.notifier.poll();
  h.messages.push(question("alice", "Done", { state: { kind: "withdrawn", at: "2026-10-17T12:00:00.000Z", reason: "outdated" } }));
  await h.notifier.poll();
  assert.deepEqual(h.calls, []);
});

test("without a person on this host nothing is notified", async () => {
  const h = harness({ me: null });
  await h.notifier.poll();
  h.messages.push(question("alice", "Question"));
  await h.notifier.poll();
  assert.deepEqual(h.calls, []);
});

test("two new questions make one combined notification", async () => {
  const h = harness();
  await h.notifier.poll();
  h.messages.push(question("alice", "First"), question("bob", "Not mine"), question("alice", "Second"));
  await h.notifier.poll();
  assert.equal(h.creates().length, 1);
  assert.equal((h.creates()[0] as { prompt: string }).prompt, "2 new questions: First; Second");
});

test("previous notifier agents are archived before the next create", async () => {
  const h = harness();
  await h.notifier.poll();
  h.messages.push(question("alice", "First"));
  await h.notifier.poll();
  h.messages.push(question("alice", "Second"));
  await h.notifier.poll();
  assert.deepEqual(
    h.calls.map((c) => (c.kind === "archive" ? `archive ${c.id}` : c.kind)),
    ["list", "create", "list", "archive notifier-1", "create"],
  );
});

test("with notify off nothing is created and the questions count as seen", async () => {
  const h = harness({ enabled: false });
  await h.notifier.poll();
  h.messages.push(question("alice", "Question"));
  await h.notifier.poll();
  h.settings.enabled = true;
  await h.notifier.poll();
  assert.deepEqual(h.calls, []);
});

test("a failed create is retried on the next poll", async () => {
  const h = harness({ failCreates: 1 });
  await h.notifier.poll();
  h.messages.push(question("alice", "Question"));
  const original = console.error;
  console.error = () => {};
  try {
    await h.notifier.poll();
    await h.notifier.poll();
    await h.notifier.poll();
  } finally {
    console.error = original;
  }
  assert.equal(h.creates().length, 2);
});

test("a batch is given up after three failed creates", async () => {
  const h = harness({ failCreates: 99 });
  await h.notifier.poll();
  h.messages.push(question("alice", "Question"));
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args[0]);
  try {
    for (let i = 0; i < 5; i++) await h.notifier.poll();
  } finally {
    console.error = original;
  }
  assert.equal(h.creates().length, 3);
  assert.ok(errors.some((e) => String(e).includes("giving up")));
});

test("without an SDK connection the question waits for the next poll", async () => {
  let paseo: NotifierPaseo | null = null;
  const created: unknown[] = [];
  const messages: Message[] = [];
  const notifier = createNotifier({
    inbox: async () => ({ me: "alice", people: PEOPLE, messages: [...messages], cwd: "/store" }),
    enabled: async () => true,
    paseo: () => paseo,
  });
  await notifier.poll();
  messages.push(question("alice", "Question"));
  await notifier.poll();
  paseo = {
    agents: {
      list: async () => ({ entries: [] }),
      ref: () => ({ archive: async () => {} }),
      create: async (options) => {
        created.push(options);
      },
    },
  };
  await notifier.poll();
  assert.equal(created.length, 1);
});
