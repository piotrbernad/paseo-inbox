import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { type Message, MessageSchema } from "../shared/message.ts";
import { bareRemote, cli, fakeHosts, git, mkdirp, remoteFile, tempRoot, writeConfig } from "./helpers.ts";

const { root, cleanup } = tempRoot("import");
after(cleanup);

const legacy = (id: string, state: object) => ({
  version: 1,
  id,
  to: "alice",
  from: "lead",
  fromHost: "host-a",
  ticket: id.endsWith("aaaa") ? "REF-1" : null,
  title: `Question ${id.slice(-4)}`,
  context: "Context.",
  options: [{ key: "A", text: "Yes" }],
  recommendation: "A",
  askedAt: "2026-10-17T10:00:00Z",
  state,
});

test("import-questions maps the earlier format and is idempotent", async () => {
  const remote = bareRemote(root);
  const dir = join(root, "host-a");
  const config = writeConfig(root, "host-a", remote, dir);
  const connect = fakeHosts({ "host-a": [], "host-b": [] }).connectAs("host-a");
  assert.equal((await cli(config, connect, ["init"])).code, 0);

  const questions = mkdirp(join(root, "questions"));
  const answered = {
    kind: "answered", choice: "A", text: "Go.", by: "alice", at: "2026-10-17T11:00:00Z",
    delivery: { kind: "delivered", at: "2026-10-17T11:00:05Z" },
  };
  writeFileSync(join(questions, "20261017-1000-lead-aaaa.json"), JSON.stringify(legacy("20261017-1000-lead-aaaa", { kind: "open" })));
  writeFileSync(join(questions, "20261017-1000-lead-bbbb.json"), JSON.stringify(legacy("20261017-1000-lead-bbbb", answered)));
  writeFileSync(join(questions, "renamed.json"), JSON.stringify(legacy("20261017-1000-lead-cccc", { kind: "open" })));

  const first = await cli(config, connect, ["import-questions", questions]);
  assert.equal(first.code, 0, first.err);
  assert.equal(first.out, "imported 2, already present 0, invalid 1");
  assert.match(first.err, /skipped invalid file renamed\.json/);

  const message: Message = MessageSchema.parse(JSON.parse(remoteFile(remote, "inbox", "messages/20261017-1000-lead-aaaa.json")));
  assert.deepEqual(message, {
    version: 1,
    id: "20261017-1000-lead-aaaa",
    from: { kind: "agent", role: "lead", agentId: null, title: null, host: "host-a" },
    to: { kind: "person", person: "alice" },
    ref: "REF-1",
    inReplyTo: null,
    sentAt: "2026-10-17T10:00:00Z",
    body: "Context.",
    question: { title: "Question aaaa", options: [{ key: "A", text: "Yes" }], recommendation: "A", state: { kind: "open" } },
  });
  const imported = MessageSchema.parse(JSON.parse(remoteFile(remote, "inbox", "messages/20261017-1000-lead-bbbb.json")));
  assert.deepEqual(imported.question?.state, answered);

  const commitsAfterFirst = git(root, "--git-dir", remote, "rev-list", "--count", "inbox");
  const second = await cli(config, connect, ["import-questions", questions]);
  assert.equal(second.out, "imported 0, already present 2, invalid 1");
  assert.equal(git(root, "--git-dir", remote, "rev-list", "--count", "inbox"), commitsAfterFirst);
});
