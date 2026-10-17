import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadConfig } from "../server/config.ts";
import type { AgentSnapshot } from "../server/hosts.ts";
import { createStore } from "../server/store.ts";
import { flushReceipts, READ_HEADER } from "../server/unread.ts";
import { type AgentMessage, type Message, MessageSchema } from "../shared/message.ts";
import { bareRemote, cli, fakeHosts, git, remoteFile, tempRoot, writeConfig } from "./helpers.ts";

const { root, cleanup } = tempRoot("hook");
const remote = bareRemote(root);
const dirA = join(root, "host-a");
const dirB = join(root, "host-b");
const lead: AgentSnapshot = { id: "lead-1", title: "Lead", labels: { "team-role": "lead" }, status: "idle" };
const designer: AgentSnapshot = { id: "designer-1", title: "Designer", labels: { "team-role": "designer" }, status: "running" };
const writer: AgentSnapshot = { id: "writer-1", title: "Writer", labels: { "team-role": "writer" }, status: "running" };
const hosts = fakeHosts({ "host-a": [lead], "host-b": [designer, writer] });
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

// The hook as an agent runs it on host B. Background syncs run in-process.
async function hook(event: object, agentId = "designer-1", config = configB): Promise<string | null> {
  const loaded = await loadConfig(config);
  const result = await cli(config, asB, ["hook"], agentId ? { PASEO_AGENT_ID: agentId } : {}, {
    stdin: async () => JSON.stringify(event),
    syncInBackground: () => {
      backgroundCalls++;
      background.push(flushReceipts(createStore(loaded.store), loaded.store.dir));
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.err, "");
  await Promise.all(background.splice(0));
  if (result.out === "") return null;
  const parsed = JSON.parse(result.out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, (event as { hook_event_name: string }).hook_event_name);
  return parsed.hookSpecificOutput.additionalContext;
}

const postToolUse = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "ok" };
const prompt = { hook_event_name: "UserPromptSubmit", prompt: "Carry on." };

async function send(...args: string[]): Promise<string> {
  const result = await cli(configA, asA, ["send", "--from", "lead", ...args], { PASEO_AGENT_ID: "lead-1" });
  assert.equal(result.code, 0, result.err);
  return result.out.split(" ")[1];
}

async function read(agentId = "designer-1", ...args: string[]): Promise<string> {
  const result = await cli(configB, asB, ["read", ...args], { PASEO_AGENT_ID: agentId });
  assert.equal(result.code, 0, result.err);
  return result.out;
}

function stored(id: string): Message {
  return MessageSchema.parse(JSON.parse(remoteFile(remote, "inbox", `messages/${id}.json`)));
}

function readBy(id: string): string | null {
  const m = stored(id);
  if (m.question === null) return m.read?.agentId ?? null;
  return m.question.state.kind === "answered" ? (m.question.state.read?.agentId ?? null) : null;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("no output and exit 0 for other events, no agent id, no config, or garbage on stdin", async () => {
  assert.equal(await hook({ hook_event_name: "Stop" }), null);
  assert.equal(await hook(postToolUse, ""), null);
  for (const stdin of ["", "not json", "[]"]) {
    const r = await cli(configB, asB, ["hook"], { PASEO_AGENT_ID: "designer-1" }, { stdin: async () => stdin });
    assert.deepEqual([r.code, r.out, r.err], [0, "", ""]);
  }
  const missing = await cli(join(root, "nope.json"), asB, ["hook"], { PASEO_AGENT_ID: "designer-1" }, {
    stdin: async () => JSON.stringify(postToolUse),
  });
  assert.deepEqual([missing.code, missing.out, missing.err], [0, "", ""]);
});

let batch: string[] = [];

test("the hook announces each batch of new messages once, by sender, and never prints a body", async () => {
  await hook(postToolUse);
  const first = await send("designer", "--ref", "REF-5", "Use code PINEAPPLE-42 for the banner.");
  const second = await send("designer", "--fyi", "--re", first, "Also: no rush.");
  await cli(configB, asB, ["sync"]);

  assert.equal(await hook(postToolUse), "Inbox: 2 unread (from Lead). Read them with the shell command: paseo-inbox read");
  assert.equal(await hook(postToolUse), null, "announced once");
  assert.equal(await hook(prompt), null, "not at the next turn either");

  const third = await send("designer", "Third: KIWI-9.");
  await cli(configB, asB, ["sync"]);
  assert.equal(await hook(prompt), "Inbox: 1 unread (from Lead). Read them with the shell command: paseo-inbox read", "only the new batch");
  batch = [first, second, third];
  for (const id of batch) assert.equal(readBy(id), null, "the hook writes no receipts");
});

test("read prints every unread message whole, oldest first, and marks exactly those read; --peek marks nothing", async () => {
  const [first, second, third] = batch;
  const forWriter = await send("writer", "For the writer only.");

  const peeked = await read("designer-1", "--peek");
  for (const id of batch) assert.equal(readBy(id), null, "--peek leaves them unread");

  const out = await read();
  assert.equal(out, peeked);
  const when = String.raw`\d{4}-\d\d-\d\d \d\d:\d\d UTC`;
  assert.match(
    out,
    new RegExp(
      `^${escape(READ_HEADER)}\\n\\n` +
        `\\[${first}\\] from Lead \\(REF-5\\), ${when}\\nUse code PINEAPPLE-42 for the banner\\.\\n` +
        `Reply: paseo-inbox send --from designer lead --re ${first} "…"\\n\\n` +
        `\\[${second}\\] from Lead \\(re ${first}\\), ${when}\\nAlso: no rush\\.\\n` +
        `Reply: paseo-inbox send --from designer lead --re ${second} "…"\\n\\n` +
        `\\[${third}\\] from Lead, ${when}\\nThird: KIWI-9\\.\\n` +
        `Reply: paseo-inbox send --from designer lead --re ${third} "…"$`,
    ),
  );
  for (const id of batch) assert.equal(readBy(id), "designer-1", id);
  assert.equal(readBy(forWriter), null, "a message it did not print stays unread");
  assert.equal((stored(first) as AgentMessage).read?.title, "Designer", "the receipt names the session");
  assert.deepEqual(readdirSync(join(dirB, ".git/paseo-inbox/receipts")), [], "receipts committed");
  const log = git(root, "--git-dir", remote, "log", "-1", "--format=%s", "inbox");
  assert.equal(log.trim(), "inbox: read 3 messages", "one commit for the batch");

  assert.equal(await read(), "No unread messages.");
  assert.equal(await hook(postToolUse), null, "nothing left to announce");
});

test("a message read before the hook saw it is never announced", async () => {
  await send("designer", "Read me first.");
  await read();
  assert.equal(await hook(postToolUse), null);
});

test("a caught-up hook leaves the launcher a fast-path file", async () => {
  await hook(postToolUse);
  const file = join(root, `paseo-inbox-${process.getuid?.() ?? 0}`, "designer-1");
  const [config, ref, sha, due] = readFileSync(file, "utf8").trimEnd().split("\n");
  assert.equal(config, configB);
  assert.equal(ref, join(dirB, ".git/refs/heads/inbox"));
  assert.equal(sha, readFileSync(ref, "utf8").trim());
  assert.ok(Number(due) >= 20, due);
});

test("an answer from a person is announced from them and read like a message", async () => {
  const asked = await cli(configB, asB, ["ask", "--from", "designer", "--to", "alice", "--title", "Ship it?", "--context", "c"], {
    PASEO_AGENT_ID: "designer-1",
  });
  const id = asked.out.split("\n")[0];
  const store = createStore((await loadConfig(configA)).store);
  const at = new Date().toISOString();
  const answered = await store.update(id, "answer", (m) =>
    m.question
      ? { ...m, question: { ...m.question, state: { kind: "answered", choice: null, text: "Yes, ship it.", by: "alice", at, delivery: { kind: "delivered", at }, read: null } } }
      : "x",
  );
  assert.equal(answered.kind, "ok");
  await cli(configB, asB, ["sync"]);
  assert.equal(await hook(postToolUse), "Inbox: 1 unread (from Alice). Read them with the shell command: paseo-inbox read");
  const out = await read();
  assert.match(out, new RegExp(`\\[${id}\\] answer from Alice, `));
  assert.ok(
    out.endsWith(
      `\nAnswer to question ${id}: Ship it?\nYes, ship it.\n` +
        'New question to Alice: paseo-inbox ask --from designer --to alice --title "…" --context "…"',
    ),
    out,
  );
  assert.equal(readBy(id), "designer-1");
});

test("a new session with the role reads what its archived predecessor left unread", async () => {
  const id = await send("designer", "For whoever is the designer now.");
  designer.archivedAt = "2026-10-17T00:00:00Z";
  const successor: AgentSnapshot = { id: "designer-2", title: "Design — Designer", labels: { "team-role": "designer" }, status: "running" };
  hosts.agents["host-b"].push(successor);
  try {
    await cli(configB, asB, ["sync"]);
    assert.equal(await hook(postToolUse, "designer-2"), "Inbox: 1 unread (from Lead). Read them with the shell command: paseo-inbox read");
    assert.match(await read("designer-2"), new RegExp(`\\[${id}\\] from Lead, `));
    assert.equal(readBy(id), "designer-2");
    assert.equal((stored(id) as AgentMessage).read?.title, "Design — Designer");
  } finally {
    delete designer.archivedAt;
    hosts.agents["host-b"].pop();
  }
});

test("show marks a message read for the agent it is for, and for no one else", async () => {
  const id = await send("designer", "Shown, not listed.");
  await cli(configB, asB, ["sync"]);
  const byLead = await cli(configA, asA, ["show", id], { PASEO_AGENT_ID: "lead-1" });
  assert.equal(byLead.code, 0, byLead.err);
  assert.equal(readBy(id), null);
  const byDesigner = await cli(configB, asB, ["show", id], { PASEO_AGENT_ID: "designer-1" });
  assert.match(byDesigner.out, new RegExp(`^>> \\[${id}\\] from Lead to Designer, .*\\nShown, not listed\\.$`));
  assert.equal(readBy(id), "designer-1");
  assert.equal(await read(), "No unread messages.");
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
  assert.ok(backgroundCalls > 0);
});

test("the notice text comes from the config", async () => {
  const polish = writeConfig(
    root,
    "host-b",
    remote,
    dirB,
    { hookHosts: ["host-b"], noticeText: "Skrzynka: {count} nowe od {from}. Przeczytaj: paseo-inbox read" },
    "inbox-host-b-polish",
  );
  await read();
  await send("designer", "Jeden.");
  await send("designer", "Dwa.");
  await cli(configB, asB, ["sync"]);
  assert.equal(await hook(postToolUse, "designer-1", polish), "Skrzynka: 2 nowe od Lead. Przeczytaj: paseo-inbox read");
});
