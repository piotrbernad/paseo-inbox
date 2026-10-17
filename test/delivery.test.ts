import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadConfig } from "../server/config.ts";
import { createDirectory, type AgentSnapshot } from "../server/hosts.ts";
import { createInbox } from "../server/inbox.ts";
import { deliverAnswer, deliveryMode, stubText } from "../server/send.ts";
import { createStore } from "../server/store.ts";
import { type Message, MessageSchema } from "../shared/message.ts";
import { bareRemote, cli, fakeHosts, remoteFile, tempRoot, writeConfig } from "./helpers.ts";

test("delivery decision table", () => {
  const cases: [hookHost: boolean, recorded: boolean, status: AgentSnapshot["status"] | null, wake: boolean, mode: string][] = [
    [false, true, "idle", true, "message"],
    [false, true, "running", false, "message"],
    [true, false, "idle", true, "message"],
    [true, false, "running", true, "message"],
    [true, true, "running", true, "none"],
    [true, true, "running", false, "none"],
    [true, true, "initializing", true, "none"],
    [true, true, "idle", true, "stub"],
    [true, true, "idle", false, "none"],
    [true, true, "error", true, "stub"],
    [true, true, "closed", false, "none"],
    [true, true, null, true, "stub"],
  ];
  for (const [hookHost, recorded, status, wake, mode] of cases) {
    assert.equal(deliveryMode({ hookHost, recorded, status: status ?? null, wake }), mode, JSON.stringify({ hookHost, recorded, status, wake }));
  }
  assert.equal(stubText(["lead"], "REF-12"), "Inbox: 1 new message from lead (REF-12).");
  assert.equal(stubText(["lead", "designer", "lead"], null), "Inbox: 3 new messages from lead, designer.");
});

const { root, cleanup } = tempRoot("delivery");
const remote = bareRemote(root);
const dirA = join(root, "host-a");
const lead: AgentSnapshot = { id: "lead-1", title: "Lead", labels: { "team-role": "lead" }, status: "running" };
const designer: AgentSnapshot = { id: "designer-1", title: "Designer", labels: { "team-role": "designer" }, status: "idle" };
const hosts = fakeHosts({ "host-a": [lead], "host-b": [designer] });
// host-b runs the hook; host-a does not.
const configA = writeConfig(root, "host-a", remote, dirA, { hookHosts: ["host-b"] });
const asA = hosts.connectAs("host-a");

function stored(id: string): Message {
  return MessageSchema.parse(JSON.parse(remoteFile(remote, "inbox", `messages/${id}.json`)));
}

async function sendAs(env: Record<string, string>, ...args: string[]) {
  const before = hosts.steered.length;
  const result = await cli(configA, asA, ["send", ...args], env);
  assert.equal(result.code, 0, result.err);
  const id = result.out.match(/^sent (\S+) to /)?.[1] ?? null;
  return { ...result, id, steered: hosts.steered.slice(before) };
}

before(async () => {
  assert.equal((await cli(configA, asA, ["init"])).code, 0);
});
after(cleanup);

test("hook host, idle recipient: the message is recorded unread, then a stub without the body wakes it", async () => {
  designer.status = "idle";
  const sent = await sendAs({ PASEO_AGENT_ID: "lead-1" }, "--from", "lead", "designer", "--ref", "REF-3", "Secret body");
  assert.equal(sent.out, `sent ${sent.id} to designer · host-b (woke it with a notice)`);
  assert.deepEqual(sent.steered.map((s) => [s.agentId, s.text]), [["designer-1", "Inbox: 1 new message from lead (REF-3)."]]);
  const message = stored(sent.id as string);
  assert.ok(message.question === null);
  assert.equal(message.read, null);
  assert.equal(message.wake, true);
});

test("hook host, running recipient: recorded, nothing sent to its chat", async () => {
  designer.status = "running";
  const sent = await sendAs({ PASEO_AGENT_ID: "lead-1" }, "--from", "lead", "designer", "While you work");
  assert.equal(sent.out, `sent ${sent.id} to designer · host-b (it reads it at its next tool call or turn)`);
  assert.deepEqual(sent.steered, []);
  const message = stored(sent.id as string);
  assert.equal(message.question === null && message.read, null);
});

test("--fyi never wakes an idle recipient and is stored with wake false", async () => {
  designer.status = "idle";
  const sent = await sendAs({ PASEO_AGENT_ID: "lead-1" }, "--from", "lead", "designer", "--fyi", "No rush");
  assert.deepEqual(sent.steered, []);
  const message = stored(sent.id as string);
  assert.equal(message.question === null && message.wake, false);
});

test("a host without the hook gets the whole message, recorded as read on delivery", async () => {
  lead.status = "idle";
  const sent = await sendAs({ PASEO_AGENT_ID: "designer-1" }, "--from", "designer", "lead", "--fyi", "Full text");
  assert.equal(sent.out, `sent ${sent.id} to lead · host-a`);
  assert.equal(sent.steered.length, 1);
  assert.match(sent.steered[0].text, /^\[inbox \S+\] from designer · host-a to lead · host-a\nReply: .*\n\nFull text$/);
  const message = stored(sent.id as string);
  assert.equal(message.question === null && message.wake, false);
  assert.equal(message.question === null && message.read?.agentId, "lead-1");
});

test("answers use the same modes: whole text off hook hosts, a stub to an idle asker on one", async () => {
  const config = await loadConfig(configA);
  const directory = createDirectory(config, asA);
  const store = createStore(config.store);
  const inbox = createInbox({
    store,
    people: config.people,
    me: "alice",
    deliver: (question) => deliverAnswer({ config, directory }, question),
  });
  const ask = async (env: string, role: string) => {
    const result = await cli(configA, asA, ["ask", "--from", role, "--to", "alice", "--title", "Ship it?", "--context", "c", "--ref", "REF-9"], {
      PASEO_AGENT_ID: env,
    });
    assert.equal(result.code, 0, result.err);
    return result.out.split("\n")[0];
  };

  designer.status = "idle";
  const toDesigner = await ask("designer-1", "designer");
  let before = hosts.steered.length;
  const answered = await inbox.answer({ id: toDesigner, choice: null, text: "Yes", by: "alice" });
  assert.equal(answered.kind, "ok");
  assert.deepEqual(hosts.steered.slice(before).map((s) => s.text), ["Inbox: 1 new message from Alice (REF-9)."]);
  const state = stored(toDesigner).question?.state;
  assert.ok(state?.kind === "answered" && state.delivery.kind === "delivered");
  assert.equal(state.read, null, "the hook has not read it yet");

  lead.status = "idle";
  const toLead = await ask("lead-1", "lead");
  before = hosts.steered.length;
  await inbox.answer({ id: toLead, choice: null, text: "No", by: "alice" });
  assert.match(hosts.steered[before]?.text ?? "", /^\[inbox\] from Alice to lead · host-a \(REF-9, re \S+\)\n.*\n\nAnswer to question/);
  const leadState = stored(toLead).question?.state;
  assert.equal(leadState?.kind === "answered" && leadState.read?.agentId, "lead-1");
});
