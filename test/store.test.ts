import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type Message, MessageSchema } from "../shared/message.ts";
import { loadConfig, me } from "../server/config.ts";
import { createInbox, type Deliver, type Inbox } from "../server/inbox.ts";
import { answerText } from "../server/questions.ts";
import { createStore } from "../server/store.ts";
import { bareRemote, cli, fakeHosts, git, PEOPLE, remoteFile, tempRoot, writeConfig } from "./helpers.ts";

const { root, cleanup } = tempRoot("store");
const remote = bareRemote(root);
const dirA = join(root, "host-a");
const dirB = join(root, "host-b");
const configA = writeConfig(root, "host-a", remote, dirA);
const configB = writeConfig(root, "host-b", remote, dirB);
const hosts = fakeHosts({
  "host-a": [{ id: "lead-1", title: "Lead", labels: { "team-role": "lead" } }],
  "host-b": [{ id: "designer-1", title: "Designer", labels: { "team-role": "designer" } }],
});
const NOTES = "# notes\n";

const delivered: string[] = [];
let deliveryFails = false;
const deliver: Deliver = async (question) => {
  if (deliveryFails) throw new Error("host-a unreachable");
  delivered.push(answerText(question));
};

let inboxA: Inbox;
let inboxB: Inbox;

function remoteMessage(id: string): Message {
  return MessageSchema.parse(JSON.parse(remoteFile(remote, "inbox", `messages/${id}.json`)));
}

async function ask(...args: string[]): Promise<string> {
  const result = await cli(configA, hosts.connectAs("host-a"), ["ask", "--from", "lead", ...args], {
    PASEO_AGENT_ID: "lead-1",
  });
  assert.equal(result.code, 0, result.err);
  return result.out.split("\n")[0];
}

before(async () => {
  const init = await cli(configA, hosts.connectAs("host-a"), ["init"]);
  assert.equal(init.code, 0, init.err);
  const initB = await cli(configB, hosts.connectAs("host-b"), ["init"]);
  assert.equal(initB.code, 0, initB.err);
  // Other tools may keep files in the same checkout; none of this may end up in an inbox commit.
  writeFileSync(join(dirB, "README.md"), `${readFileSync(join(dirB, "README.md"), "utf8")}local edit\n`);
  writeFileSync(join(dirB, "NOTES.md"), NOTES);
  mkdirSync(join(dirB, "messages"), { recursive: true });
  writeFileSync(join(dirB, "messages/broken.json"), "{ not json");
  for (const [dir, path] of [
    [dirA, configA],
    [dirB, configB],
  ] as const) {
    const config = await loadConfig(path);
    const inbox = createInbox({ store: createStore(config.store), people: config.people, me: me(config)?.id ?? null, deliver });
    if (dir === dirA) inboxA = inbox;
    else inboxB = inbox;
  }
});

after(cleanup);

test("init creates the store branch as an orphan with a README, and is safe to repeat", async () => {
  assert.match(remoteFile(remote, "inbox", "README.md"), /^# Inbox store/);
  const parents = git(root, "--git-dir", remote, "log", "--format=%P", "inbox").trim();
  assert.equal(parents, "", "the first inbox commit has no parent");
  assert.equal(git(dirB, "rev-parse", "HEAD"), git(dirA, "rev-parse", "HEAD"));
  const again = await cli(configA, hosts.connectAs("host-a"), ["init"]);
  assert.equal(again.out, `store already set up: ${dirA} (branch inbox)`);
});

test("an agent asks on host A, Bob answers on host B, the answer is delivered and pushed", async () => {
  const id = await ask(
    "--to", "bob",
    "--title", "Colour of the save button",
    "--context", "Two variants in the mockup.\nBoth pass contrast.",
    "--option", "A: Green",
    "--option", "B: Black",
    "--recommend", "A",
    "--ref", "REF-12",
  );
  assert.match(id, /^\d{8}-\d{4}-lead-[a-z0-9]{4}$/);

  const listed = await inboxB.list();
  assert.equal(listed.me, "bob");
  assert.equal(listed.skipped, 1);
  assert.equal(listed.syncError, null);
  const message = listed.messages.find((m) => m.id === id);
  assert.ok(message?.question, "host B sees the question asked on host A");
  assert.deepEqual(message.from, { kind: "agent", role: "lead", agentId: "lead-1", title: "Lead", host: "host-a" });
  assert.deepEqual(message.to, { kind: "person", person: "bob" });
  assert.equal(message.ref, "REF-12");
  assert.equal(message.body, "Two variants in the mockup.\nBoth pass contrast.");
  assert.deepEqual(message.question.state, { kind: "open" });
  assert.equal(message.question.recommendation, "A");

  const answered = await inboxB.answer({ id, choice: "A", text: "As in the mockup.", by: "bob" });
  assert.equal(answered.kind, "ok", JSON.stringify(answered));
  assert.deepEqual(delivered, [
    `Answer to question ${id} (REF-12): Colour of the save button\nChoice: A (Green)\nAs in the mockup.`,
  ]);
  const pushed = remoteMessage(id);
  assert.equal(pushed.question?.state.kind, "answered");
  assert.equal(pushed.question?.state.kind === "answered" && pushed.question.state.delivery.kind, "delivered");

  const again = await inboxA.answer({ id, choice: "B", text: "", by: "bob" });
  assert.equal(again.kind, "refused");
  assert.match(again.kind === "refused" ? again.reason : "", /^Already answered by Bob at \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/);
  assert.equal(delivered.length, 1);

  const withdraw = await cli(configA, hosts.connectAs("host-a"), ["withdraw", id, "outdated"]);
  assert.equal(withdraw.code, 1);
  assert.match(withdraw.err, /Already answered by Bob/);
});

test("only the person a question is for can answer it", async () => {
  const id = await ask("--to", "alice", "--title", "Rename the module?", "--context", "Working name.");
  const wrong = await inboxB.answer({ id, choice: null, text: "Yes", by: "bob" });
  assert.deepEqual(wrong, { kind: "refused", reason: "This question is for Alice, not Bob." });
});

test("a failed delivery is recorded and a retry delivers it once", async () => {
  const id = await ask("--to", "alice", "--title", "Turn off the old form?", "--context", "Nobody uses it.");
  deliveryFails = true;
  const answered = await inboxA.answer({ id, choice: null, text: "Yes, turn it off.", by: "alice" });
  deliveryFails = false;
  assert.equal(answered.kind, "ok");
  const failed = remoteMessage(id).question?.state;
  assert.ok(failed?.kind === "answered" && failed.delivery.kind === "failed");
  assert.equal(failed.delivery.error, "host-a unreachable");

  const before = delivered.length;
  const retried = await inboxB.retryDelivery(id);
  assert.equal(retried.kind, "ok", JSON.stringify(retried));
  assert.equal(delivered.length, before + 1);
  assert.equal(delivered.at(-1), `Answer to question ${id}: Turn off the old form?\nYes, turn it off.`);
  const done = remoteMessage(id).question?.state;
  assert.ok(done?.kind === "answered" && done.delivery.kind === "delivered");

  const twice = await inboxB.retryDelivery(id);
  assert.equal(twice.kind, "refused");
  assert.equal(delivered.length, before + 1);
});

test("answers from both hosts at once: exactly one wins", async () => {
  const id = await ask("--to", "bob", "--title", "Launch in November?", "--context", "Or December.", "--option", "A: Yes", "--option", "B: No");
  const results = await Promise.all([
    inboxA.answer({ id, choice: "A", text: "", by: "bob" }),
    inboxB.answer({ id, choice: "B", text: "", by: "bob" }),
  ]);
  assert.deepEqual(results.map((r) => r.kind).sort(), ["ok", "refused"]);
  const winner = results.find((r) => r.kind === "ok");
  const pushed = remoteMessage(id).question?.state;
  assert.ok(winner?.kind === "ok" && pushed?.kind === "answered");
  const won = winner.message.question?.state;
  assert.equal(pushed.choice, won?.kind === "answered" ? won.choice : "?");
});

test("an answer needs a known option or text; withdrawn questions are refused", async () => {
  const id = await ask("--to", "alice", "--title", "Module name", "--context", "Working name.", "--option", "A: Inbox");
  const unknown = await inboxB.answer({ id, choice: "Z", text: "", by: "alice" });
  assert.deepEqual(unknown, { kind: "refused", reason: "The question has no option Z." });
  const empty = await inboxB.answer({ id, choice: null, text: "  ", by: "alice" });
  assert.deepEqual(empty, { kind: "refused", reason: "Pick an option or write an answer." });

  const withdraw = await cli(configA, hosts.connectAs("host-a"), ["withdraw", id, "decided", "in", "a", "call"]);
  assert.equal(withdraw.code, 0, withdraw.err);
  const late = await inboxB.answer({ id, choice: "A", text: "", by: "alice" });
  assert.equal(late.kind, "refused");
  assert.match(late.kind === "refused" ? late.reason : "", /^Withdrawn at .* UTC: decided in a call\.$/);

  const bad = await cli(configA, hosts.connectAs("host-a"), [
    "ask", "--from", "lead", "--to", "alice", "--title", "x", "--context", "y", "--option", "A: a", "--recommend", "B",
  ]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /--recommend B is not an option key \(A\)/);
  const nobody = await cli(configA, hosts.connectAs("host-a"), ["ask", "--from", "lead", "--to", "carol", "--title", "x", "--context", "y"]);
  assert.match(nobody.err, /--to must be one of: alice, bob/);
});

test("list shows open questions, --all adds recent closed ones, --for filters by party", async () => {
  const open = await cli(configB, hosts.connectAs("host-b"), ["list"]);
  assert.equal(open.code, 0, open.err);
  const openLines = open.out.split("\n");
  assert.equal(openLines.length, 1);
  assert.match(openLines[0], /\topen\tlead · host-a\tAlice\t-\tRename the module\?$/);
  assert.match(open.err, /skipped 1 invalid file/);

  const all = await cli(configB, hosts.connectAs("host-b"), ["list", "--all"]);
  const lines = all.out.split("\n");
  assert.equal(lines.length, 5);
  assert.ok(lines.some((l) => /\tanswered by bob .* UTC, delivery delivered\tlead · host-a\tBob\tREF-12\tColour of the save button$/.test(l)));
  assert.ok(lines.some((l) => /\twithdrawn .*\tModule name$/.test(l)));

  const forBob = await cli(configB, hosts.connectAs("host-b"), ["list", "--all", "--for", "bob"]);
  assert.equal(forBob.out.split("\n").length, 2);
  const forNobody = await cli(configB, hosts.connectAs("host-b"), ["list", "--for", "role:designer"]);
  assert.equal(forNobody.out, "no open questions");
});

test("unrelated files in the checkout are never committed", () => {
  assert.equal(git(dirB, "show", "origin/inbox:README.md"), remoteFile(remote, "inbox", "README.md"));
  assert.match(readFileSync(join(dirB, "README.md"), "utf8"), /local edit\n$/);
  assert.equal(readFileSync(join(dirB, "NOTES.md"), "utf8"), NOTES);
  git(dirB, "fetch", "-q", "origin");
  const tracked = git(dirB, "ls-tree", "-r", "--name-only", "origin/inbox").trim().split("\n");
  assert.ok(!tracked.includes("NOTES.md"));
  assert.ok(!tracked.includes("messages/broken.json"));
  const subjects = git(dirB, "log", "--format=%s", "origin/inbox").trim().split("\n");
  assert.ok(subjects.every((s) => s === "inbox: create store" || /^inbox: (ask|answer|delivery|withdraw) /.test(s)), subjects.join("\n"));
  for (const sha of git(dirB, "log", "--format=%H", "origin/inbox").trim().split("\n").slice(0, -1)) {
    const files = git(dirB, "show", "--name-only", "--format=", sha).trim().split("\n");
    assert.equal(files.length, 1);
    assert.match(files[0], /^messages\/[a-z0-9-]+\.json$/);
  }
});

test("people and me come from the config", async () => {
  const listedA = await inboxA.list();
  assert.equal(listedA.me, "alice");
  assert.deepEqual(listedA.people, PEOPLE);
  assert.deepEqual(
    listedA.parties.slice(0, 3),
    [
      { key: "person:alice", label: "Alice" },
      { key: "person:bob", label: "Bob" },
      { key: "role:lead", label: "lead · host-a" },
    ],
  );
});
