import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadConfig } from "../server/config.ts";
import { CONTEXT_HEADER, contextText, flushReceipts, MAX_CONTEXT_CHARS } from "../server/hook.ts";
import type { AgentSnapshot } from "../server/hosts.ts";
import { createStore } from "../server/store.ts";
import { type AgentMessage, AgentMessageSchema, type Message, MessageSchema } from "../shared/message.ts";
import { bareRemote, cli, fakeHosts, git, remoteFile, tempRoot, writeConfig } from "./helpers.ts";

const { root, cleanup } = tempRoot("hook");
const remote = bareRemote(root);
const dirA = join(root, "host-a");
const dirB = join(root, "host-b");
const lead: AgentSnapshot = { id: "lead-1", title: "Lead", labels: { "team-role": "lead" }, status: "idle" };
const designer: AgentSnapshot = { id: "designer-1", title: "Designer", labels: { "team-role": "designer" }, status: "running" };
const hosts = fakeHosts({ "host-a": [lead], "host-b": [designer] });
const configA = writeConfig(root, "host-a", remote, dirA, { hookHosts: ["host-b"] });
const configB = writeConfig(root, "host-b", remote, dirB, { hookHosts: ["host-b"] });
const asA = hosts.connectAs("host-a");
const asB = hosts.connectAs("host-b");

const background: Promise<unknown>[] = [];
let backgroundCalls = 0;

before(async () => {
  assert.equal((await cli(configA, asA, ["init"])).code, 0);
  assert.equal((await cli(configB, asB, ["init"])).code, 0);
});
after(cleanup);

async function flushB(): Promise<void> {
  await Promise.all(background.splice(0));
}

// The hook as the designer's agent runs it on host B. Background syncs flush receipts in-process.
async function hook(event: object, agentId = "designer-1"): Promise<{ text: string | null; raw: string }> {
  const config = await loadConfig(configB);
  const result = await cli(configB, asB, ["hook"], agentId ? { PASEO_AGENT_ID: agentId } : {}, {
    stdin: async () => JSON.stringify(event),
    syncInBackground: () => {
      backgroundCalls++;
      background.push(flushReceipts(createStore(config.store), config.store.dir));
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.err, "");
  if (result.out === "") return { text: null, raw: "" };
  const parsed = JSON.parse(result.out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, (event as { hook_event_name: string }).hook_event_name);
  return { text: parsed.hookSpecificOutput.additionalContext, raw: result.out };
}

const postToolUse = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "ok" };

async function send(...args: string[]): Promise<string> {
  const result = await cli(configA, asA, ["send", "--from", "lead", ...args], { PASEO_AGENT_ID: "lead-1" });
  assert.equal(result.code, 0, result.err);
  return result.out.split(" ")[1];
}

function stored(id: string): Message {
  return MessageSchema.parse(JSON.parse(remoteFile(remote, "inbox", `messages/${id}.json`)));
}

test("no output and exit 0 for other events, no agent id, no config, or garbage on stdin", async () => {
  assert.equal((await hook({ hook_event_name: "Stop" })).text, null);
  assert.equal((await hook(postToolUse, "")).text, null);
  for (const stdin of ["", "not json", "[]"]) {
    const r = await cli(configB, asB, ["hook"], { PASEO_AGENT_ID: "designer-1" }, { stdin: async () => stdin });
    assert.deepEqual([r.code, r.out, r.err], [0, "", ""]);
  }
  const missing = await cli(join(root, "nope.json"), asB, ["hook"], { PASEO_AGENT_ID: "designer-1" }, {
    stdin: async () => JSON.stringify(postToolUse),
  });
  assert.deepEqual([missing.code, missing.out, missing.err], [0, "", ""]);
});

test("a running agent gets new messages after its next tool call, once, and they are marked read", async () => {
  await hook(postToolUse); // first call: nothing addressed to it yet
  await flushB();
  const first = await send("designer", "--ref", "REF-5", "Use code PINEAPPLE-42 for the banner.");
  const second = await send("designer", "--fyi", "--re", first, "Also: no rush.");
  // Host B's checkout learns about them through its throttled background sync.
  await flushB();
  await cli(configB, asB, ["sync"]);

  const { text } = await hook(postToolUse);
  assert.equal(
    text,
    [
      CONTEXT_HEADER,
      `[${first}] from Lead to Designer (REF-5)\nUse code PINEAPPLE-42 for the banner.\n` +
        `Full text: paseo-inbox show ${first}\nReply: paseo-inbox send --from designer lead --re ${first} "…"`,
      `[${second}] from Lead to Designer (re ${first})\nAlso: no rush.\n` +
        `Full text: paseo-inbox show ${second}\nReply: paseo-inbox send --from designer lead --re ${second} "…"`,
    ].join("\n\n"),
  );
  assert.equal((await hook(postToolUse)).text, null, "not injected twice");

  await flushB();
  for (const id of [first, second]) {
    const m = stored(id) as AgentMessage;
    assert.equal(m.read?.agentId, "designer-1", `${id} has a receipt`);
  }
  assert.deepEqual(readdirSync(join(dirB, ".git/paseo-inbox/receipts")), [], "receipts flushed");
});

test("a caught-up hook leaves the launcher a fast-path file; a deferred one removes it", async () => {
  await hook(postToolUse);
  const file = join(root, `paseo-inbox-${process.getuid?.() ?? 0}`, "designer-1");
  const [config, ref, sha, due] = readFileSync(file, "utf8").trimEnd().split("\n");
  assert.equal(config, configB);
  assert.equal(ref, join(dirB, ".git/refs/heads/inbox"));
  assert.equal(sha, readFileSync(ref, "utf8").trim());
  assert.ok(Number(due) >= 20, due);
});

test("the receipts of one hook call land in one commit", async () => {
  const ids = [await send("designer", "one"), await send("designer", "two"), await send("designer", "three")];
  await cli(configB, asB, ["sync"]);
  const { text } = await hook(postToolUse);
  for (const id of ids) assert.ok(text?.includes(`[${id}]`));
  await flushB();
  const log = git(root, "--git-dir", remote, "log", "-1", "--format=%s", "--name-only", "inbox");
  assert.match(log, /^inbox: read 3 messages\n/);
  for (const id of ids) assert.ok(log.includes(`messages/${id}.json`));
});

test("a stub prompt makes the hook fetch at once, so an idle agent woken from another host sees the message", async () => {
  designer.status = "idle";
  const before = hosts.steered.length;
  const id = await send("designer", "--ref", "REF-8", "Wake up: code MANGO-7.");
  const stub = hosts.steered.slice(before);
  assert.deepEqual(stub.map((s) => s.text), ["Inbox: 1 new message from Lead (REF-8)."]);
  const { text } = await hook({ hook_event_name: "UserPromptSubmit", prompt: stub[0].text });
  assert.match(text ?? "", new RegExp(`\\[${id}\\] from Lead to Designer \\(REF-8\\)\\nWake up: code MANGO-7\\.`));
  await flushB();
  designer.status = "running";
});

test("an answer from a person in the Inbox reaches the asking agent through the hook", async () => {
  const asked = await cli(configB, asB, ["ask", "--from", "designer", "--to", "alice", "--title", "Ship it?", "--context", "c"], {
    PASEO_AGENT_ID: "designer-1",
  });
  const id = asked.out.split("\n")[0];
  const config = await loadConfig(configA);
  const store = createStore(config.store);
  const answered = await store.update(id, "answer", (m) =>
    m.question ? { ...m, question: { ...m.question, state: { kind: "answered", choice: null, text: "Yes, ship it.", by: "alice", at: new Date().toISOString(), delivery: { kind: "delivered", at: new Date().toISOString() }, read: null } } } : "x",
  );
  assert.equal(answered.kind, "ok");
  await cli(configB, asB, ["sync"]);
  const { text } = await hook(postToolUse);
  assert.equal(
    text,
    `${CONTEXT_HEADER}\n\n[${id}] answer from Alice to Designer\nAnswer to question ${id}: Ship it?\nYes, ship it.\n` +
      `Full text: paseo-inbox show ${id}\nNew question to Alice: paseo-inbox ask --from designer --to alice --title "…" --context "…"`,
  );
  await flushB();
  const state = stored(id).question?.state;
  assert.equal(state?.kind === "answered" && state.read?.agentId, "designer-1");
});

test("a new session with the role reads what its archived predecessor left unread", async () => {
  const id = await send("designer", "For whoever is the designer now.");
  designer.archivedAt = "2026-10-17T00:00:00Z";
  const successor: AgentSnapshot = { id: "designer-2", title: "Designer", labels: { "team-role": "designer" }, status: "running" };
  hosts.agents["host-b"].push(successor);
  try {
    await cli(configB, asB, ["sync"]);
    const { text } = await hook(postToolUse, "designer-2");
    assert.ok(text?.includes(`[${id}] from Lead to Designer`), text ?? "");
    assert.equal((await hook(postToolUse, "designer-1")).text, null, "the receipt is already queued; the old session does not get it again");
    await flushB();
    assert.equal((stored(id) as AgentMessage).read?.agentId, "designer-2");
  } finally {
    delete designer.archivedAt;
    hosts.agents["host-b"].pop();
  }
});

test("the context block stays under the cap: long bodies are cut, and what does not fit comes after the next tool call", async () => {
  const long = [];
  for (let i = 0; i < 4; i++) long.push(await send("designer", `${i} ${"x".repeat(4_000)}`));
  await cli(configB, asB, ["sync"]);
  const cut = await hook(postToolUse);
  assert.ok((cut.text?.length ?? 0) <= MAX_CONTEXT_CHARS, `${cut.text?.length}`);
  for (const id of long) assert.ok(cut.text?.includes(`[${id}]`), "all four fit once cut");
  assert.equal(cut.text?.match(/… \(cut, see full text\)/g)?.length, 4);
  await flushB();

  const many = [];
  for (let i = 0; i < 14; i++) many.push(await send("designer", `${i} ${"y".repeat(400)}`));
  await cli(configB, asB, ["sync"]);
  const first = await hook(postToolUse);
  assert.ok((first.text?.length ?? 0) <= MAX_CONTEXT_CHARS, `${first.text?.length}`);
  const got = many.filter((id) => first.text?.includes(`[${id}]`));
  assert.ok(got.length >= 1 && got.length < many.length, `${got.length} fit`);
  assert.match(first.text ?? "", new RegExp(`${many.length - got.length} more messages? will follow after your next tool call\\.$`));
  assert.equal(existsSync(join(root, `paseo-inbox-${process.getuid?.() ?? 0}`, "designer-1")), false, "no fast path while messages wait");
  const second = await hook(postToolUse);
  const rest = many.filter((id) => second.text?.includes(`[${id}]`));
  assert.deepEqual([...got, ...rest].sort(), [...many].sort());
  assert.equal((await hook(postToolUse)).text, null);
  await flushB();
});

test("contextText shares the budget, keeping short bodies whole", async () => {
  const config = await loadConfig(configB);
  const make = (n: number, body: string): AgentMessage =>
    AgentMessageSchema.parse({
      version: 1,
      id: `20261017-120${n}-lead-abc${n}`,
      from: { kind: "agent", role: "lead", agentId: "lead-1", title: null, host: "host-a" },
      to: { kind: "agent", role: "designer", agentId: "designer-1", title: null, host: "host-b" },
      ref: null,
      inReplyTo: null,
      sentAt: `2026-10-17T12:0${n}:00Z`,
      body,
      question: null,
      read: null,
    });
  const { text, included } = contextText([make(1, "short"), make(2, "y".repeat(20_000))], config);
  assert.equal(included.length, 2);
  assert.ok(text.includes("\nshort\n"));
  assert.ok(text.length <= MAX_CONTEXT_CHARS && text.length > MAX_CONTEXT_CHARS - 200, `${text.length}`);
});

test("show prints a message in full with its thread", async () => {
  const first = await send("designer", "Question one\nwith two lines");
  const reply = await cli(configB, asB, ["send", "lead", "--re", first, "Answer one"], { PASEO_AGENT_ID: "designer-1" });
  const replyId = reply.out.split(" ")[1];
  const shown = await cli(configB, asB, ["show", first]);
  assert.equal(shown.code, 0, shown.err);
  const blocks = shown.out.split("\n\n");
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], new RegExp(`^>> \\[${first}\\] from Lead to Designer, \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC\\nQuestion one\\nwith two lines`));
  assert.match(blocks[1], new RegExp(`^\\[${replyId}\\] from Designer to Lead \\(re ${first}\\), .*\\nAnswer one\\nRead .* by Lead\\.$`));
  assert.equal(existsSync(join(dirB, ".git/paseo-inbox")), true);
  assert.ok(backgroundCalls > 0);
});
