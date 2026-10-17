import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { LAUNCHER } from "../server/cli/commands.ts";
import { hookCommand } from "../server/install-hooks.ts";
import { cli, fakeHosts, tempRoot } from "./helpers.ts";

const { root, cleanup } = tempRoot("install-hooks");
after(cleanup);
const connect = fakeHosts({ "host-a": [], "host-b": [] }).connectAs("host-a");
const command = hookCommand(LAUNCHER);

const existing = {
  model: "opus",
  permissions: { allow: ["Bash(ls:*)"] },
  hooks: {
    PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "prettier --write" }] }],
    Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
  },
};

async function run(...args: string[]) {
  const result = await cli(join(root, "unused.json"), connect, ["install-hooks", ...args], {}, {
    now: () => new Date("2026-10-17T20:00:00Z"),
  });
  assert.equal(result.code, 0, result.err);
  return result.out;
}

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("install merges into existing Claude settings, keeps everything else, backs up, and is idempotent", async () => {
  const dir = join(root, "claude");
  mkdirSync(dir);
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify(existing, null, 2));

  const out = await run("--claude", "--claude-settings", path);
  assert.match(out, new RegExp(`^Claude Code: hook added to ${path} \\(backup: .*/claude/settings\\.json\\.bak-2026-10-17T20-00-00-000Z\\)\\n  Claude Code picks the hook up`));
  assert.deepEqual(read(path), {
    ...existing,
    hooks: {
      ...existing.hooks,
      PostToolUse: [...existing.hooks.PostToolUse, { hooks: [{ type: "command", command, timeout: 30 }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: 30 }] }],
    },
  });
  assert.deepEqual(read(`${path}.bak-2026-10-17T20-00-00-000Z`), existing);

  const again = await run("--claude", "--claude-settings", path);
  assert.match(again, /^Claude Code: hook already installed in /);
  assert.equal(readdirSync(dir).length, 2, "no second backup");

  const removed = await run("--claude", "--claude-settings", path, "--uninstall");
  assert.match(removed, /^Claude Code: hook removed from /);
  assert.deepEqual(read(path), existing);
  assert.match(await run("--claude", "--claude-settings", path, "--uninstall"), /^Claude Code: hook not installed in /);
});

test("Codex: hooks.json is created in CODEX_HOME when missing, and uninstall leaves an empty object", async () => {
  const home = join(root, "codex");
  const out = await run("--codex", "--codex-home", home);
  assert.match(out, /^Codex: hook added to .*codex\/hooks\.json\n  Codex runs a new hook only once you trust it: open Codex, run \/hooks/);
  const path = join(home, "hooks.json");
  assert.deepEqual(read(path), {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: 30 }] }],
      PostToolUse: [{ hooks: [{ type: "command", command, timeout: 30 }] }],
    },
  });
  await run("--codex", "--codex-home", home, "--uninstall");
  assert.deepEqual(read(path), {});
});

test("without flags both are installed; a broken settings file is refused, not overwritten", async () => {
  const claude = join(root, "both", "settings.json");
  const codexHome = join(root, "both", "codex");
  const out = await run("--claude-settings", claude, "--codex-home", codexHome);
  assert.match(out, /Claude Code: hook added/);
  assert.match(out, /Codex: hook added/);

  const broken = join(root, "broken.json");
  writeFileSync(broken, "{ not json");
  const result = await cli(join(root, "unused.json"), connect, ["install-hooks", "--claude", "--claude-settings", broken]);
  assert.equal(result.code, 1);
  assert.equal(readFileSync(broken, "utf8"), "{ not json");
});

test("the hook command is the launcher path, quoted when it needs to be", () => {
  assert.equal(hookCommand("/opt/paseo-inbox/bin/paseo-inbox"), "/opt/paseo-inbox/bin/paseo-inbox hook");
  assert.equal(hookCommand("/Users/a b/paseo-inbox/bin/paseo-inbox"), "'/Users/a b/paseo-inbox/bin/paseo-inbox' hook");
  assert.match(command, /\/bin\/paseo-inbox hook$/);
});
