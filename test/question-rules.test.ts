import assert from "node:assert/strict";
import { test } from "node:test";
import { localPath, questionRefusal } from "../server/question-rules.ts";

const draft = (over: Partial<Parameters<typeof questionRefusal>[0]> = {}) => ({
  title: "Accept the new pricing page copy?",
  context: "The pricing page lists three plans.",
  options: [
    { key: "A", text: "Yes, ship it" },
    { key: "B", text: "No, keep the old copy" },
  ],
  ref: null,
  ...over,
});

test("local paths are found: absolute, home, relative with a file or a known dir, file://", () => {
  for (const [text, path] of [
    ["see /tmp/x/BRIEF-INBOX-5.md for details", "/tmp/x/BRIEF-INBOX-5.md"],
    ["under /tmp", "/tmp"],
    ["/Users/me/notes", "/Users/me/notes"],
    ["/BRIEF.md", "/BRIEF.md"],
    ["in ~/.paseo/inbox.json.", "~/.paseo/inbox.json"],
    ["(./render/home.png)", "./render/home.png"],
    ["../README.md", "../README.md"],
    ["zalaczniki/gun-368/BRIEF.md", "zalaczniki/gun-368/BRIEF.md"],
    ["Projekt: team-notes agents/Design/zalaczniki/gun-368/render (home, cennik)", "agents/Design/zalaczniki/gun-368/render"],
    ["notes in .context/plan", ".context/plan"],
    ["`docs/adr`", "docs/adr"],
    ["file:///Users/me/a.png", "file:///Users/me/a.png"],
  ]) {
    assert.equal(localPath(text), path, text);
  }
});

test("not paths: URLs, fractions, pairs, units, dates, versions, packages, prose", () => {
  for (const text of [
    "https://github.com/acme/app/blob/main/docs/BRIEF.md",
    "http://localhost:3000/a/b.png",
    "1/3 of the users",
    "A/B test",
    "50 km/h",
    "and/or",
    "TCP/IP",
    "w/o tests",
    "on 18/10/2026 or 10/18",
    "v1.2/v1.3",
    "@getpaseo/plugin/client",
    "PR design#6, GUN-368",
    "50% / 50%",
    "ratio 3/4.",
    "a / b",
    "/",
    "Node.js and Next.js",
  ]) {
    assert.equal(localPath(text), null, text);
  }
});

test("ask refuses a local path in the title, the context or an option, and says what to do", () => {
  const inContext = questionRefusal(draft({ context: "Renders in agents/Design/render (home, cennik)." }));
  assert.match(inContext ?? "", /^The context names a local path \(agents\/Design\/render\)\./);
  assert.match(inContext ?? "", /link it with https:\/\/ \(for example on GitHub\), or put the fact into the question\./);
  assert.match(questionRefusal(draft({ title: "Use ~/plan.md as the plan?" })) ?? "", /^The title names a local path/);
  const inOption = questionRefusal(draft({ options: [{ key: "A", text: "As in /tmp/a/b.png" }] }));
  assert.match(inOption ?? "", /^Option A names a local path \(\/tmp\/a\/b\.png\)/);
  assert.equal(questionRefusal(draft({ context: "Screens: https://github.com/acme/design/blob/main/render/home.png" })), null);
});

test("ask refuses a title that starts with the ref or a ticket id", () => {
  const ticket = questionRefusal(draft({ title: "GUN-368 strony oprogramowania: 5 rekomendacji" }));
  assert.match(ticket ?? "", /^The title starts with GUN-368\. The ref has its own field \(--ref\); the title says what is being decided, in the person's words\.$/);
  assert.match(questionRefusal(draft({ title: "[ABC-12] Rename the module?" })) ?? "", /starts with ABC-12/);
  assert.match(questionRefusal(draft({ title: "design#6: approve the home page?", ref: "design#6" })) ?? "", /starts with design#6/);
  for (const title of ["Rename the module to Inbox?", "Ship GUN-368 this week?", "A-B test the pricing page?"]) {
    assert.equal(questionRefusal(draft({ title, ref: "GUN-368" })), null, title);
  }
});

test("ask refuses one question that bundles several decisions", () => {
  const bundled = questionRefusal(
    draft({
      title: "Strony oprogramowania: 5 rekomendacji",
      options: [
        { key: "A", text: "przyjmuję wszystkie 5" },
        { key: "B", text: "zmiany (napisz które)" },
      ],
    }),
  );
  assert.match(bundled ?? "", /^The title counts 5 things and option A takes them all at once\. Ask one question per decision/);
  assert.match(
    questionRefusal(draft({ title: "Pricing: 3 decisions", options: [{ key: "A", text: "Accept all" }] })) ?? "",
    /counts 3 things/,
  );
  for (const [title, option] of [
    ["Ship version 2.0 to all users?", "All users"],
    ["Pricing: 5 recommendations", "Accept the first, rework the rest"],
    ["Move the 10:30 meeting?", "All of us can"],
    ["One decision about all plans?", "All plans"],
    ["Use v2 for all screens?", "All screens"],
    ["Fix 1 bug before release?", "All of it"],
    ["Is allowance 5 PLN enough?", "Fine for allowance"],
  ]) {
    assert.equal(questionRefusal(draft({ title, options: [{ key: "A", text: option }] })), null, title);
  }
});
