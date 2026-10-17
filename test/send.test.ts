import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type Message, MessageSchema } from "../shared/message.ts";
import { bareRemote, cli, fakeHosts, git, remoteFile, tempRoot, writeConfig } from "./helpers.ts";

const { root, cleanup } = tempRoot("send");
const remote = bareRemote(root);
const dirA = join(root, "host-a");
const dirB = join(root, "host-b");
const configA = writeConfig(root, "host-a", remote, dirA);
const configB = writeConfig(root, "host-b", remote, dirB);
const hosts = fakeHosts({
  "host-a": [
    { id: "lead-1", title: "Lead", labels: { "team-role": "lead" } },
    { id: "loose-1", title: "Spike on caching", labels: {} },
  ],
  "host-b": [
    { id: "designer-old", title: "Designer (old)", labels: { "team-role": "designer" }, archivedAt: "2026-10-01T00:00:00Z" },
    { id: "designer-1", title: "Designer", labels: { "team-role": "designer" } },
  ],
});
const asA = hosts.connectAs("host-a");
const asB = hosts.connectAs("host-b");

function stored(id: string): Message {
  return MessageSchema.parse(JSON.parse(remoteFile(remote, "inbox", `messages/${id}.json`)));
}

function commits(): number {
  return Number(git(root, "--git-dir", remote, "rev-list", "--count", "inbox").trim());
}

before(async () => {
  assert.equal((await cli(configA, asA, ["init"])).code, 0);
  assert.equal((await cli(configB, asB, ["init"])).code, 0);
});

after(cleanup);

test("send steers the recipient on another host, then records both agent ids", async () => {
  const sent = await cli(configA, asA, ["send", "--from", "lead", "designer", "Please", "review", "the", "header."], {
    PASEO_AGENT_ID: "lead-1",
  });
  assert.equal(sent.code, 0, sent.err);
  const [, id] = sent.out.match(/^sent (\S+) to Designer$/) ?? [];
  assert.ok(id, sent.out);

  const steer = hosts.steered.at(-1);
  assert.deepEqual(steer?.options, { activeTurnBehavior: "steer" });
  assert.equal(steer?.host, "host-b");
  assert.equal(steer?.agentId, "designer-1", "archived agents with the role are skipped");
  assert.equal(
    steer?.text,
    `[inbox ${id}] from Lead to Designer\n` +
      `Reply: paseo-inbox send --from designer lead --re ${id} "…"\n\nPlease review the header.`,
  );

  const message = stored(id);
  assert.deepEqual(message.from, { kind: "agent", role: "lead", agentId: "lead-1", title: "Lead", host: "host-a" });
  assert.deepEqual(message.to, { kind: "agent", role: "designer", agentId: "designer-1", title: "Designer", host: "host-b" });
  assert.equal(message.body, "Please review the header.");
  assert.equal(message.inReplyTo, null);
  assert.equal(message.question, null);
});

test("a reply with --re and --file records inReplyTo, and the role comes from the label", async () => {
  const first = await cli(configA, asA, ["send", "--from", "lead", "designer", "Ping"], { PASEO_AGENT_ID: "lead-1" });
  const firstId = first.out.split(" ")[1];
  const file = join(root, "reply.md");
  writeFileSync(file, "Done.\nSee the second screen.\n\n");
  const reply = await cli(configB, asB, ["send", "lead", "--re", firstId, "--ref", "REF-7", "--file", file], {
    PASEO_AGENT_ID: "designer-1",
  });
  assert.equal(reply.code, 0, reply.err);
  const id = reply.out.split(" ")[1];
  const message = stored(id);
  assert.equal(message.inReplyTo, firstId);
  assert.equal(message.ref, "REF-7");
  assert.equal(message.body, "Done.\nSee the second screen.");
  assert.equal(message.from.kind === "agent" && message.from.agentId, "designer-1");
  assert.equal(message.from.kind === "agent" && message.from.role, "designer");
  assert.equal(message.to.kind === "agent" && message.to.agentId, "lead-1");
  assert.match(hosts.steered.at(-1)?.text ?? "", new RegExp(`^\\[inbox ${id}\\] from Designer to Lead \\(REF-7, re ${firstId}\\)\n`));
});

test("--no-record delivers without touching the store", async () => {
  const before = commits();
  const steeredBefore = hosts.steered.length;
  const sent = await cli(configA, asA, ["send", "--from", "lead", "designer", "--no-record", "Heads", "up"], {
    PASEO_AGENT_ID: "lead-1",
  });
  assert.equal(sent.code, 0, sent.err);
  assert.equal(sent.out, "sent to Designer (not recorded)");
  assert.equal(hosts.steered.length, steeredBefore + 1);
  assert.match(hosts.steered.at(-1)?.text ?? "", /^\[inbox\] from Lead to Designer\nReply: paseo-inbox send --from designer lead "…"\n\nHeads up$/);
  assert.equal(commits(), before);
});

test("a message from a person points the agent at ask, not at a reply", async () => {
  const sent = await cli(configA, asA, ["send", "--from", "alice", "lead", "--no-record", "--re", "20261017-1200-lead-abcd", "Answer"]);
  assert.equal(sent.code, 0, sent.err);
  assert.equal(
    hosts.steered.at(-1)?.text,
    "[inbox] from Alice to Lead (re 20261017-1200-lead-abcd)\n" +
      'New question to Alice: paseo-inbox ask --from lead --to alice --title "…" --context "…"\n\nAnswer',
  );
});

test("an agent without a role is addressed by id, and replies reach it by id", async () => {
  const sent = await cli(configA, asA, ["send", "designer", "Question about caching"], { PASEO_AGENT_ID: "loose-1" });
  assert.equal(sent.code, 0, sent.err);
  const id = sent.out.split(" ")[1];
  assert.match(id, /-agent-[a-z0-9]{4}$/);
  assert.match(hosts.steered.at(-1)?.text ?? "", /\nReply: paseo-inbox send --from designer agent:loose-1 --re /);
  const message = stored(id);
  assert.deepEqual(message.from, { kind: "agent", role: null, agentId: "loose-1", title: "Spike on caching", host: "host-a" });

  const reply = await cli(configB, asB, ["send", "agent:loose-1", "--re", id, "Use the CDN."], { PASEO_AGENT_ID: "designer-1" });
  assert.equal(reply.code, 0, reply.err);
  assert.equal(hosts.steered.at(-1)?.agentId, "loose-1");
  assert.equal(hosts.steered.at(-1)?.host, "host-a");
});

test("failures: unknown role, a person as recipient, no sender identity, unreachable host", async () => {
  const unknown = await cli(configA, asA, ["send", "--from", "lead", "writer", "hi"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /No agent with team-role=writer on any host/);

  const person = await cli(configA, asA, ["send", "--from", "lead", "bob", "hi"]);
  assert.match(person.err, /bob is a person\. Ask them with: paseo-inbox ask --to bob/);

  const anonymous = await cli(configA, asA, ["send", "designer", "hi"]);
  assert.match(anonymous.err, /Pass --from ROLE, or run inside a Paseo agent/);

  hosts.down.add("host-b");
  try {
    const down = await cli(configA, asA, ["send", "--from", "lead", "designer", "hi"]);
    assert.equal(down.code, 1);
    assert.match(down.err, /No agent with team-role=designer on any host; unreachable: host-b \(Cannot connect to host-b\)/);
  } finally {
    hosts.down.delete("host-b");
  }
});

test("list and show name agents by their current session title, as their hosts report it", async () => {
  const sent = await cli(configA, asA, ["send", "--from", "lead", "designer", "Renamed later"], { PASEO_AGENT_ID: "lead-1" });
  const id = sent.out.split(" ")[1];
  const lead = hosts.agents["host-a"][0];
  lead.title = "EM — Engineering Manager";
  try {
    const listed = await cli(configB, asB, ["list", "--all", "--for", "role:lead"]);
    assert.ok(listed.out.split("\n").some((l) => l.startsWith(`${id}\tmessage\tEM — Engineering Manager\tDesigner\t`)), listed.out);
    const shown = await cli(configB, asB, ["show", id]);
    assert.match(shown.out, new RegExp(`^>> \\[${id}\\] from EM — Engineering Manager to Designer, `));
    assert.equal((stored(id).from as { title: string }).title, "Lead", "the store keeps the title from send time");

    hosts.down.add("host-a");
    const offline = await cli(configB, asB, ["show", id]);
    assert.match(offline.out, new RegExp(`^>> \\[${id}\\] from Lead to Designer, `), "the stored title when the host is down");
  } finally {
    lead.title = "Lead";
    hosts.down.delete("host-a");
  }
});
