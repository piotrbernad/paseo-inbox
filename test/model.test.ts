import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  isRecent,
  isWatched,
  type Message,
  MessageSchema,
  nextWatched,
  partyEntries,
  partyKey,
  RECENT_MS,
} from "../shared/message.ts";
import { loadConfig, me } from "../server/config.ts";
import { PEOPLE, tempRoot } from "./helpers.ts";

const { root, cleanup } = tempRoot("model");
after(cleanup);

const lead = { kind: "agent", role: "lead", agentId: "lead-1", title: "Lead", host: "host-a" } as const;
const loose = { kind: "agent", role: null, agentId: "loose-1", title: "Spike", host: "host-b" } as const;

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

test("a message is visible when its sender or recipient is watched; nothing watched shows all", () => {
  const m = message();
  assert.equal(isWatched(m, []), true);
  assert.equal(isWatched(m, ["role:lead"]), true);
  assert.equal(isWatched(m, ["agent:loose-1"]), true);
  assert.equal(isWatched(m, ["person:alice", "role:designer"]), false);
  assert.equal(isWatched(question({ kind: "open" }), ["person:alice"]), true);
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

test("party entries list people first, then everyone in the messages, with display labels", () => {
  assert.deepEqual(partyEntries([message()], PEOPLE), [
    { key: "person:alice", label: "Alice" },
    { key: "person:bob", label: "Bob" },
    { key: "role:lead", label: "lead · host-a" },
    { key: "agent:loose-1", label: "Spike · host-b" },
  ]);
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
});

test("watch toggles: empty means everyone, toggling off from everyone keeps the rest", () => {
  const all = ["person:alice", "role:lead", "agent:loose-1"];
  assert.deepEqual(nextWatched([], all, "role:lead"), ["person:alice", "agent:loose-1"]);
  assert.deepEqual(nextWatched(["person:alice", "agent:loose-1"], all, "role:lead"), []);
  assert.deepEqual(nextWatched(["person:alice"], all, "role:lead"), ["person:alice", "role:lead"]);
  assert.deepEqual(nextWatched(["person:alice"], all, "person:alice"), ["person:alice"], "the last one stays on");
});
