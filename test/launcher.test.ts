import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { LAUNCHER } from "../server/cli/commands.ts";
import { tempRoot } from "./helpers.ts";

const { root, cleanup } = tempRoot("launcher");
after(cleanup);

const uid = process.getuid?.() ?? 0;
const config = join(root, "inbox.json");
const ref = join(root, "store/.git/refs/heads/inbox");
const sha = "5ae053f9a0f2a708f97f83beb4a515d468e5cf8e";
mkdirSync(join(root, "store/.git/refs/heads"), { recursive: true });
mkdirSync(join(root, `paseo-inbox-${uid}`));

const postToolUse = JSON.stringify({
  session_id: "s",
  transcript_path: "/tmp/t.jsonl",
  cwd: "/tmp",
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_response: "z".repeat(2_000_000),
});

// Without Paseo.app the launcher can only answer through its fast path; anything else exits 1.
function launch(stdin: string, opts: { due?: number; head?: string; config?: string } = {}) {
  writeFileSync(ref, `${opts.head ?? sha}\n`);
  const due = opts.due ?? Math.floor(Date.now() / 1000) + 20;
  writeFileSync(join(root, `paseo-inbox-${uid}`, "agent-1"), `${opts.config ?? config}\n${ref}\n${sha}\n${due}\n`);
  return spawnSync("/bin/bash", [LAUNCHER, "hook"], {
    input: stdin,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, PASEO_AGENT_ID: "agent-1", PASEO_INBOX_CONFIG: config, PASEO_RESOURCES: join(root, "none") },
  });
}

test("the launcher answers a PostToolUse hook itself while the store has not moved, even with megabytes of tool output", () => {
  const started = Date.now();
  const fast = launch(postToolUse);
  assert.deepEqual([fast.status, fast.stdout, fast.stderr], [0, "", ""]);
  assert.ok(Date.now() - started < 2_000, `${Date.now() - started} ms`);
});

test("anything else goes to Node: new commits, a due sync, another config, other events", () => {
  const cases = {
    moved: launch(postToolUse, { head: "0".repeat(40) }),
    due: launch(postToolUse, { due: Math.floor(Date.now() / 1000) - 1 }),
    otherConfig: launch(postToolUse, { config: join(root, "other.json") }),
    prompt: launch(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Inbox: 1 new message from lead." })),
  };
  for (const [name, r] of Object.entries(cases)) {
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, /Paseo\.app not found/, name);
  }
});
