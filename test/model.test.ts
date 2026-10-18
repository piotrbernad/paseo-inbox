import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  inView,
  isRecent,
  type Message,
  MessageSchema,
  partyEntries,
  partyKey,
  partyName,
  RECENT_MS,
  viewChoices,
  viewFromWatched,
  withTitles,
} from "../shared/message.ts";
import { inboxSettings, migrateSettings } from "../shared/rpc.ts";
import { loadConfig, me } from "../server/config.ts";
import { PEOPLE, tempRoot } from "./helpers.ts";

const { root, cleanup } = tempRoot("model");
after(cleanup);

const lead = { kind: "agent", role: "lead", agentId: "lead-1", title: "Lead", host: "host-a", parentRole: null } as const;
const loose = { kind: "agent", role: null, agentId: "loose-1", title: "Spike", host: "host-b", parentRole: null } as const;
// A session the designer started.
const child = { kind: "agent", role: null, agentId: "child-1", title: "Icon pass", host: "host-b", parentRole: "designer" } as const;

function message(extra: Partial<Message> = {}): Message {
  return {
    version: 1,
    id: "20261017-1200-lead-abcd",
    from: lead,
    to: loose,
    ref: null,
    inReplyTo: null,
    sentAt: "2026-10-17T12:00:00Z",
    body: "Hello",
    question: null,
    ...extra,
  } as Message;
}

const question = (state: object) =>
  message({
    to: { kind: "person", person: "alice" },
    question: { title: "Q", options: [], recommendation: null, state },
  } as Partial<Message>);

test("party keys", () => {
  assert.equal(partyKey({ kind: "person", person: "alice" }), "person:alice");
  assert.equal(partyKey(lead), "role:lead");
  assert.equal(partyKey(loose), "agent:loose-1");
});

test("a view shows the messages from or to its party; all shows everything", () => {
  const m = message();
  assert.equal(inView(m, "all"), true);
  assert.equal(inView(m, "role:lead"), true);
  assert.equal(inView(m, "agent:loose-1"), true);
  assert.equal(inView(m, "person:alice"), false);
  assert.equal(inView(m, "role:designer"), false);
  assert.equal(inView(question({ kind: "open" }), "person:alice"), true);
});

test("a standing agent's view includes the sessions it started, from either side", () => {
  const fromChild = message({ from: child, to: lead });
  const toChild = message({ from: lead, to: child });
  assert.equal(inView(fromChild, "role:designer"), true);
  assert.equal(inView(toChild, "role:designer"), true);
  assert.equal(inView(fromChild, "role:lead"), true);
  assert.equal(inView(message({ from: child, to: loose }), "role:lead"), false);
  const old = MessageSchema.parse({ ...message({ from: lead, to: loose }), to: { ...loose, parentRole: undefined } });
  assert.equal(old.to.kind === "agent" && old.to.parentRole, null, "messages from before parentRole parse as null");
  assert.equal(inView(old, "role:designer"), false);
  assert.equal(inView(old, "all"), true);
});

test("open questions stay; everything else drops off after seven days of quiet", () => {
  const sent = Date.parse("2026-10-17T12:00:00Z");
  const later = sent + RECENT_MS + 1;
  assert.equal(isRecent(message(), sent), true);
  assert.equal(isRecent(message(), later), false);
  assert.equal(isRecent(question({ kind: "open" }), later), true);
  const answeredLate = question({
    kind: "answered", choice: null, text: "ok", by: "alice", at: "2026-10-20T12:00:00Z", delivery: { kind: "pending" },
  });
  assert.equal(isRecent(answeredLate, later), true);
});

test("the schema keeps questions for people and plain messages for agents", () => {
  assert.equal(MessageSchema.safeParse(message()).success, true);
  assert.equal(MessageSchema.safeParse(question({ kind: "open" })).success, true);
  assert.equal(MessageSchema.safeParse(message({ to: { kind: "person", person: "alice" } } as Partial<Message>)).success, false);
  assert.equal(
    MessageSchema.safeParse(message({ question: { title: "Q", options: [], recommendation: null, state: { kind: "open" } } } as Partial<Message>)).success,
    false,
  );
  assert.equal(MessageSchema.safeParse(message({ from: { ...loose, agentId: null } } as Partial<Message>)).success, false);
});

test("files written before receipts existed parse as already read when they reached the chat", () => {
  const old = MessageSchema.parse(message());
  assert.ok(old.question === null);
  assert.equal(old.wake, true);
  assert.deepEqual(old.read, { at: "2026-10-17T12:00:00Z", agentId: "loose-1", title: null }, "sent whole into the chat");

  const answeredAt = { kind: "answered", choice: null, text: "ok", by: "alice", at: "2026-10-17T12:05:00Z" };
  const pending = MessageSchema.parse(question({ ...answeredAt, delivery: { kind: "pending" } }));
  assert.equal(pending.question?.state.kind === "answered" && pending.question.state.read, null, "never reached the asker");
  const delivered = MessageSchema.parse(question({ ...answeredAt, delivery: { kind: "delivered", at: "2026-10-17T12:06:00Z" } }));
  assert.deepEqual(delivered.question?.state.kind === "answered" && delivered.question.state.read, {
    at: "2026-10-17T12:06:00Z",
    agentId: "lead-1",
    title: null,
  });

  const fyi = MessageSchema.parse({ ...message(), wake: false, read: null });
  assert.deepEqual(fyi.question === null && [fyi.wake, fyi.read], [false, null]);
  assert.equal(MessageSchema.safeParse({ ...message(), read: { at: "yesterday", agentId: "loose-1" } }).success, false);
});

test("the choices are people, then standing agents sorted by session name; sessions without a role never", () => {
  const designer = { ...lead, role: "designer", agentId: "designer-1", title: "Designer" };
  const messages = [
    message({ sentAt: "2026-10-17T15:00:00Z", from: lead, to: loose }),
    message({ id: "20261017-1300-agent-abcd", sentAt: "2026-10-17T13:00:00Z", from: child, to: designer }),
    message({ id: "20261017-1400-agent-efgh", sentAt: "2026-10-17T14:00:00Z", from: { ...child, parentRole: "writer" }, to: loose }),
  ];
  const entries = partyEntries(messages, PEOPLE);
  assert.deepEqual(entries, [
    { key: "person:alice", label: "Alice" },
    { key: "person:bob", label: "Bob" },
    { key: "role:designer", label: "Designer" },
    { key: "role:lead", label: "Lead" },
    { key: "role:writer", label: "writer" },
  ]);
  assert.ok(entries.every((e) => !e.key.startsWith("agent:")));
  assert.deepEqual(viewChoices(entries, "role:lead"), entries);
  assert.deepEqual(viewChoices(entries, "all"), entries);
  assert.deepEqual(viewChoices(entries, "role:gone").at(-1), { key: "role:gone", label: "gone" }, "the choice stays visible");
});

test("a party is shown by its session title, else its role, else its id; current titles replace stored ones", () => {
  const agent = (title: string | null, role: string | null, agentId: string | null) =>
    ({ kind: "agent", role, agentId, title, host: "host-a", parentRole: null }) as const;
  assert.equal(partyName(agent("EM — Engineering Manager", "em", "a-1"), PEOPLE), "EM — Engineering Manager");
  assert.equal(partyName(agent("  ", "em", "a-1"), PEOPLE), "em");
  assert.equal(partyName(agent(null, null, "a-1"), PEOPLE), "a-1");
  assert.equal(partyName({ kind: "person", person: "alice" }, PEOPLE), "Alice");
  assert.equal(partyName({ kind: "person", person: "carol" }, PEOPLE), "carol");

  const m = MessageSchema.parse(message());
  const shown = withTitles(m, new Map([["loose-1", "Caching spike"], ["other", "x"]]));
  assert.equal(partyName(shown.to, PEOPLE), "Caching spike");
  assert.equal(shown.from, m.from, "parties without a known title stay as they are");
  assert.equal(partyName(withTitles(m, new Map()).to, PEOPLE), "Spike");
});

test("config: me is the person on this host; ~ expands; mistakes are reported by field", async () => {
  const path = join(root, "inbox.json");
  const config = {
    self: "host-b",
    hosts: { "host-a": "link", "host-b": "local" },
    people: PEOPLE,
    store: { repo: "git@example.com:org/private.git" },
  };
  writeFileSync(path, JSON.stringify(config));
  const loaded = await loadConfig(path);
  assert.equal(me(loaded)?.id, "bob");
  assert.equal(loaded.roleLabel, "team-role");
  assert.equal(loaded.store.branch, "inbox");
  assert.ok(!loaded.store.dir.startsWith("~"));

  writeFileSync(path, JSON.stringify({ ...config, self: "host-c" }));
  await assert.rejects(loadConfig(path), /self: self must be one of the keys in hosts/);
  writeFileSync(path, JSON.stringify({ ...config, people: [...PEOPLE, PEOPLE[0]] }));
  await assert.rejects(loadConfig(path), /people: people ids must be unique/);
  writeFileSync(path, JSON.stringify({ ...config, people: [] }));
  assert.equal(me(await loadConfig(path)), null);
  assert.deepEqual(loaded.hookHosts, []);
  writeFileSync(path, JSON.stringify({ ...config, hookHosts: ["host-c"] }));
  await assert.rejects(loadConfig(path), /hookHosts: every hookHosts entry must be one of the keys in hosts/);
});

test("settings: the old watched list becomes one view; one person or role stays, anything else is all", async () => {
  assert.equal(viewFromWatched([]), "all");
  assert.equal(viewFromWatched(["role:lead"]), "role:lead");
  assert.equal(viewFromWatched(["person:alice"]), "person:alice");
  assert.equal(viewFromWatched(["agent:loose-1"]), "all", "sessions without a role are no longer a choice");
  assert.equal(viewFromWatched(["role:lead", "person:alice"]), "all");
  assert.equal(viewFromWatched(undefined), "all");

  const migrate = inboxSettings.migrate;
  assert.equal(migrate, migrateSettings);
  const v1 = { configPath: "/x/inbox.json", notify: false, watched: ["role:lead"] };
  const migrated = inboxSettings.schema.parse(await migrateSettings(v1, 1));
  assert.deepEqual(migrated, { configPath: "/x/inbox.json", notify: false, view: "role:lead" });
  assert.equal(inboxSettings.schema.parse(await migrateSettings({ watched: ["a", "b"] }, 1)).view, "all");
  assert.equal(inboxSettings.schema.parse({}).view, "all");
  assert.equal(inboxSettings.schema.safeParse({ view: "agent:loose-1" }).success, false);
});
