import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { loadConfig } from "../server/config.ts";
import { LockBusy, STALE_LOCK_MS, withLock } from "../server/lock.ts";
import { createStore } from "../server/store.ts";
import type { Message } from "../shared/message.ts";
import { bareRemote, git, tempRoot, writeConfig } from "./helpers.ts";

const run = promisify(execFile);
const ENTRY = join(import.meta.dirname, "cli-process.ts");
const { root, cleanup } = tempRoot("concurrency");
after(cleanup);

type Outcome = { code: number; out: string; err: string };

async function cliProcess(config: string, args: string[]): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(process.execPath, [ENTRY, ...args], {
      env: { ...process.env, PASEO_INBOX_CONFIG: config, PASEO_AGENT_ID: "" },
    });
    return { code: 0, out: stdout.trim(), err: stderr.trim() };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, out: (e.stdout ?? "").trim(), err: (e.stderr ?? "").trim() };
  }
}

function remoteIds(remote: string): string[] {
  const names = git(root, "--git-dir", remote, "ls-tree", "--name-only", "inbox", "messages/").trim();
  return names === "" ? [] : names.split("\n").map((n) => n.replace(/^messages\//, "").replace(/\.json$/, ""));
}

function message(id: string, body: string): Message {
  return {
    version: 1,
    id,
    from: { kind: "agent", role: "lead", agentId: "lead-1", title: null, host: "host-a", parentRole: null, serverId: null },
    to: { kind: "person", person: "alice" },
    ref: null,
    inReplyTo: null,
    sentAt: "2026-10-17T12:00:00.000Z",
    body,
    question: { title: body, options: [], recommendation: null, state: { kind: "open" } },
  };
}

test("the lock serialises holders, takes over abandoned locks and gives up on a busy one", async () => {
  const path = join(mkdirAt("lock"), "store.lock");
  const order: string[] = [];
  const hold = (name: string, ms: number) =>
    withLock(path, async () => {
      order.push(`${name}+`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`${name}-`);
    });
  await Promise.all([hold("a", 30), hold("b", 10), hold("c", 0)]);
  for (let i = 0; i < order.length; i += 2) assert.equal(order[i].slice(0, -1), order[i + 1].slice(0, -1), order.join(" "));

  writeFileSync(path, "999999 " + Date.now() + " x");
  assert.equal(await withLock(path, async () => "dead pid", { waitMs: 0 }), "dead pid");
  writeFileSync(path, `${process.pid} ${Date.now() - STALE_LOCK_MS - 1} x`);
  assert.equal(await withLock(path, async () => "too old", { waitMs: 0 }), "too old");
  writeFileSync(path, `${process.pid} ${Date.now()} x`);
  await assert.rejects(withLock(path, async () => "busy", { waitMs: 50 }), LockBusy);
});

test("init raced from several processes on one empty checkout: all succeed, one root commit", async () => {
  const remote = bareRemote(mkdirAt("race-init"));
  const dir = join(root, "race-init", "store");
  const config = writeConfig(join(root, "race-init"), "host-a", remote, dir);
  const results = await Promise.all(Array.from({ length: 4 }, () => cliProcess(config, ["init"])));
  for (const r of results) assert.equal(r.code, 0, r.err);
  assert.equal(results.filter((r) => r.out.includes("created on the remote")).length, 1, results.map((r) => r.out).join("\n"));
  assert.equal(git(root, "--git-dir", remote, "rev-list", "--count", "inbox").trim(), "1");
  assert.equal(git(dir, "rev-parse", "HEAD"), git(root, "--git-dir", remote, "rev-parse", "inbox"));
  assert.equal(git(dir, "remote", "get-url", "origin").trim(), remote);
});

test("init repairs half-initialised checkouts and refuses a foreign one", async () => {
  const base = mkdirAt("repair");
  const remote = bareRemote(base);
  const first = writeConfig(base, "host-a", remote, join(base, "a"));
  assert.equal((await cliProcess(first, ["init"])).code, 0);

  // Interrupted before the remote was added.
  const bare = join(base, "bare");
  mkdirSync(bare);
  git(bare, "init", "-q", "-b", "inbox");
  const repairedBare = await cliProcess(writeConfig(mkdirAt("repair/c1"), "host-a", remote, bare), ["init"]);
  assert.equal(repairedBare.code, 0, repairedBare.err);
  assert.equal(git(bare, "rev-parse", "HEAD"), git(base, "--git-dir", remote, "rev-parse", "inbox"));

  // Interrupted after creating a local first commit that never reached the remote, which another host created meanwhile.
  const orphan = join(base, "orphan");
  mkdirSync(orphan);
  git(orphan, "init", "-q", "-b", "inbox");
  git(orphan, "remote", "add", "origin", remote);
  git(orphan, "commit", "-q", "--allow-empty", "-m", "inbox: create store");
  const repairedOrphan = await cliProcess(writeConfig(mkdirAt("repair/c2"), "host-a", remote, orphan), ["init"]);
  assert.equal(repairedOrphan.code, 0, repairedOrphan.err);
  assert.equal(git(orphan, "rev-parse", "HEAD"), git(base, "--git-dir", remote, "rev-parse", "inbox"));

  const foreign = join(base, "foreign");
  mkdirSync(foreign);
  git(foreign, "init", "-q", "-b", "inbox");
  git(foreign, "remote", "add", "origin", join(base, "elsewhere.git"));
  const refused = await cliProcess(writeConfig(mkdirAt("repair/c3"), "host-a", remote, foreign), ["init"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /tracks .*elsewhere\.git, not /);
});

test("CLI processes, an in-process store and another host write and sync one checkout at once; nothing is lost", async () => {
  const base = mkdirAt("writers");
  const remote = bareRemote(base);
  const dirA = join(base, "a");
  const dirB = join(base, "b");
  const configA = writeConfig(base, "host-a", remote, dirA);
  const configB = writeConfig(base, "host-b", remote, dirB);
  assert.equal((await cliProcess(configA, ["init"])).code, 0);
  assert.equal((await cliProcess(configB, ["init"])).code, 0);
  const storeA = createStore((await loadConfig(configA)).store);
  const storeB = createStore((await loadConfig(configB)).store);

  const asks = Array.from({ length: 6 }, (_, i) =>
    cliProcess(configA, ["ask", "--from", "lead", "--to", "alice", "--title", `cli ${i}`, "--context", "x"]),
  );
  const lists = Array.from({ length: 3 }, () => cliProcess(configA, ["list", "--all"]));
  const inProcess = Array.from({ length: 4 }, (_, i) => storeA.create(message(`20261017-1200-lead-a00${i}`, `a ${i}`), "ask"));
  const otherHost = Array.from({ length: 4 }, (_, i) => storeB.create(message(`20261017-1200-lead-b00${i}`, `b ${i}`), "ask"));
  const syncs = Array.from({ length: 3 }, () => storeA.list());

  const outcomes = await Promise.all([...asks, ...lists]);
  for (const o of outcomes) assert.equal(o.code, 0, o.err);
  for (const o of outcomes) assert.doesNotMatch(o.err, /sync failed|fatal|error/i, o.err);
  for (const w of await Promise.all([...inProcess, ...otherHost])) assert.equal(w.kind, "ok", JSON.stringify(w));
  for (const s of await Promise.all(syncs)) assert.equal(s.syncError, null);

  const ids = remoteIds(remote);
  const cliIds = outcomes.slice(0, 6).map((o) => o.out.split("\n")[0]);
  for (const id of [...cliIds, ...[0, 1, 2, 3].flatMap((i) => [`20261017-1200-lead-a00${i}`, `20261017-1200-lead-b00${i}`])]) {
    assert.ok(ids.includes(id), `${id} reached the remote`);
  }
  assert.equal(ids.length, 14);
  assert.equal(git(dirA, "status", "--porcelain").trim(), "");
});

function mkdirAt(path: string): string {
  const dir = join(root, path);
  mkdirSync(dir, { recursive: true });
  return dir;
}
