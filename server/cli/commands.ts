import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import {
  agentsIn,
  isOpenQuestion,
  isRecent,
  isWatched,
  type Message,
  newestFirst,
  type Party,
  partyName,
  type Person,
  withTitles,
} from "../../shared/message.ts";
import { type Config, configPath, expandHome, loadConfig } from "../config.ts";
import { type Connect, createDirectory, type Directory, paseoConnect, withTimeout } from "../hosts.ts";
import { flushReceipts, runHook } from "../hook.ts";
import { hookCommand, updateHookFile } from "../install-hooks.ts";
import { readLegacyQuestions } from "../legacy.ts";
import { formatWhen, withdraw } from "../questions.ts";
import { newMessageId, type Recipient, send, tags } from "../send.ts";
import { createStore, type Store } from "../store.ts";

export type Io = {
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  err(line: string): void;
  connect?: Connect;
  now?: () => Date;
  stdin?: () => Promise<string>;
  syncInBackground?: () => void;
};

class UsageError extends Error {}

const HELP = `paseo-inbox: messages and questions between Paseo agents and their people

  paseo-inbox init
      Clone the store branch from config.store, or create it on the remote.
  paseo-inbox send [--from ROLE] TO "message" [--re ID] [--ref X] [--file path] [--fyi] [--no-record]
      Send a message to an agent without interrupting its turn, and record it.
      TO is a role, role:ROLE or agent:AGENT_ID. --fyi never wakes an idle recipient
      on a host with the hook; it reads the message at its next turn.
  paseo-inbox ask [--from ROLE] --to PERSON --title "..." (--context "..." | --context-file path)
                  [--option "A: text"]... [--recommend A] [--ref X]
      Ask a person a question. The answer comes back as a message from them.
  paseo-inbox list [--all] [--for PARTY]
      Open questions; --all adds everything from the last 7 days.
      PARTY is person:ID, role:ROLE, agent:AGENT_ID, or a bare person id or role.
  paseo-inbox show ID
      Print a message in full, with the messages it replies to and the replies to it.
  paseo-inbox withdraw ID [reason]
      Withdraw an open question.
  paseo-inbox import-questions DIR
      Import questions/<id>.json files of the earlier format. Safe to run again.
  paseo-inbox hook
      Agent hook (UserPromptSubmit, PostToolUse): adds unread messages to the agent's context.
  paseo-inbox install-hooks [--claude] [--codex] [--claude-settings PATH] [--codex-home PATH] [--uninstall]
      Add the hook to Claude Code and Codex settings (both when neither flag is given).
  paseo-inbox sync
      Commit the read receipts hooks left and fetch the store. Hooks start it in the background.

Config: ~/.paseo/inbox.json, or the path in PASEO_INBOX_CONFIG.
Inside a Paseo agent, PASEO_AGENT_ID identifies the sender; --from names its role.`;

export async function main(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      io.out(HELP);
      return 0;
    }
    if (command === "hook") return await hook(io);
    if (command === "install-hooks") return await installHooks(rest, io);
    const handler = COMMANDS[command];
    if (!handler) throw new UsageError(`Unknown command: ${command}`);
    const config = await loadConfig(configPath(io.env.PASEO_INBOX_CONFIG));
    const store = createStore(config.store);
    const directory = createDirectory(config, io.connect ?? paseoConnect());
    return await handler(rest, { config, store, directory, io, now: () => io.now?.() ?? new Date() });
  } catch (error) {
    io.err(`paseo-inbox: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof UsageError) io.err("Run `paseo-inbox help` for usage.");
    return 1;
  }
}

type Ctx = { config: Config; store: Store; directory: Directory; io: Io; now: () => Date };

const COMMANDS: Record<string, (args: string[], ctx: Ctx) => Promise<number>> = {
  async init(args, { config, store, io }) {
    parse(args, {});
    const result = await store.init();
    const verb = { existing: "already set up", cloned: "cloned", created: "created on the remote" }[result];
    io.out(`store ${verb}: ${config.store.dir} (branch ${config.store.branch})`);
    return 0;
  },

  async send(args, ctx) {
    const { values, positionals } = parse(args, {
      from: { type: "string" },
      re: { type: "string" },
      ref: { type: "string" },
      file: { type: "string" },
      fyi: { type: "boolean" },
      "no-record": { type: "boolean" },
    });
    const [toArg, ...words] = positionals;
    if (!toArg) throw new UsageError("send needs a recipient.");
    const body = values.file !== undefined ? await readFile(values.file, "utf8") : words.join(" ");
    if (body.trim() === "") throw new UsageError("send needs a message, or --file path.");
    if (values.re !== undefined && !/^[a-z0-9-]+$/.test(values.re)) throw new UsageError(`Invalid --re id: ${values.re}`);

    const from = await sender(values.from, ctx, { allowPerson: true });
    const sent = await send(
      { config: ctx.config, directory: ctx.directory, store: values["no-record"] ? null : ctx.store, now: ctx.now },
      {
        from,
        to: recipient(toArg, ctx.config),
        body: body.replace(/\s+$/, ""),
        ref: values.ref ?? null,
        inReplyTo: values.re ?? null,
        wake: !values.fyi,
      },
    );
    const label = partyName(sent.to, ctx.config.people);
    const how = { message: "", stub: " (woke it with a notice)", none: " (it reads it at its next tool call or turn)" }[sent.mode];
    ctx.io.out(sent.recorded ? `sent ${sent.id} to ${label}${how}` : `sent to ${label} (not recorded)`);
    if (sent.recordError) ctx.io.err(`paseo-inbox: delivered, but not recorded in the store: ${sent.recordError}`);
    return 0;
  },

  async ask(args, ctx) {
    const { values } = parse(args, {
      from: { type: "string" },
      to: { type: "string" },
      title: { type: "string" },
      context: { type: "string" },
      "context-file": { type: "string" },
      option: { type: "string", multiple: true },
      recommend: { type: "string" },
      ref: { type: "string" },
    });
    const person = ctx.config.people.find((p) => p.id === values.to);
    if (!person) throw new UsageError(`--to must be one of: ${ctx.config.people.map((p) => p.id).join(", ") || "(no people in config)"}`);
    const title = values.title?.trim() ?? "";
    if (title === "" || title.includes("\n")) throw new UsageError("--title must be one non-empty line.");
    if ((values.context === undefined) === (values["context-file"] === undefined)) {
      throw new UsageError("Pass exactly one of --context or --context-file.");
    }
    const context = values.context ?? (await readFile(values["context-file"] as string, "utf8"));
    const options = (values.option ?? []).map((raw) => {
      const at = raw.indexOf(":");
      const key = at === -1 ? "" : raw.slice(0, at).trim();
      if (key === "") throw new UsageError(`--option must look like "A: text", got: ${raw}`);
      return { key, text: raw.slice(at + 1).trim() };
    });
    const keys = options.map((o) => o.key);
    if (new Set(keys).size !== keys.length) throw new UsageError("--option keys must be unique.");
    if (values.recommend !== undefined && !keys.includes(values.recommend)) {
      throw new UsageError(`--recommend ${values.recommend} is not an option key (${keys.join(", ") || "no options"}).`);
    }

    const from = await sender(values.from, ctx, { allowPerson: false });
    const now = ctx.now();
    const message: Message = {
      version: 1,
      id: newMessageId(from, now),
      from,
      to: { kind: "person", person: person.id },
      ref: values.ref ?? null,
      inReplyTo: null,
      sentAt: now.toISOString(),
      body: context.trim(),
      question: { title, options, recommendation: values.recommend ?? null, state: { kind: "open" } },
    };
    const written = await ctx.store.create(message, "ask");
    if (written.kind === "refused") throw new Error(written.reason);
    ctx.io.out(message.id);
    ctx.io.out(`The answer will arrive as a message from ${person.name}.`);
    return 0;
  },

  async list(args, { config, store, directory, io, now }) {
    const { values } = parse(args, { all: { type: "boolean" }, for: { type: "string" } });
    const { messages, skipped, syncError } = await store.list();
    if (syncError) io.err(`paseo-inbox: showing local data, sync failed: ${syncError}`);
    const at = now().getTime();
    const watched = values.for !== undefined ? [partyFilter(values.for, config)] : [];
    const rows = messages
      .filter((m) => (values.all ? isRecent(m, at) : isOpenQuestion(m)))
      .filter((m) => isWatched(m, watched))
      .sort(newestFirst);
    for (const m of await retitle(rows, directory)) io.out(row(m, config.people));
    if (rows.length === 0) io.out(values.all ? "no messages in the last 7 days" : "no open questions");
    if (skipped) io.err(`paseo-inbox: skipped ${skipped} invalid file(s) in ${config.store.dir}/messages`);
    return 0;
  },

  async show(args, { config, store, directory, io }) {
    const { positionals } = parse(args, {});
    const [id] = positionals;
    if (!id || positionals.length > 1) throw new UsageError("show needs one message id.");
    const found = await store.read(id);
    if (typeof found === "string") io.err(`paseo-inbox: showing local data, ${found}`);
    const { messages } = await store.list();
    const message = messages.find((m) => m.id === id);
    if (!message) throw new Error(`No message ${id}.`);
    const thread = await retitle(threadOf(message, messages), directory);
    io.out(thread.map((m) => describe(m, config.people, m.id === id)).join("\n\n"));
    return 0;
  },

  async sync(args, { config, store, io }) {
    parse(args, {});
    const error = await flushReceipts(store, config.store.dir);
    if (error) throw new Error(error);
    io.out(`store synced: ${config.store.dir}`);
    return 0;
  },

  async withdraw(args, { config, store, io, now }) {
    const { positionals } = parse(args, {});
    const [id, ...reason] = positionals;
    if (!id) throw new UsageError("withdraw needs a question id.");
    const result = await store.update(id, "withdraw", (current) =>
      withdraw(current, reason.join(" "), config.people, now().toISOString()),
    );
    if (result.kind === "refused") throw new Error(result.reason);
    io.out(`withdrawn ${id}`);
    return 0;
  },

  async "import-questions"(args, { store, io }) {
    const { positionals } = parse(args, {});
    const [dir] = positionals;
    if (!dir || positionals.length > 1) throw new UsageError("import-questions needs one directory.");
    const { messages, invalid } = await readLegacyQuestions(dir);
    for (const name of invalid) io.err(`paseo-inbox: skipped invalid file ${name}`);
    const added = await store.addMissing(messages, "import");
    if (typeof added === "string") throw new Error(added);
    io.out(`imported ${added.length}, already present ${messages.length - added.length}, invalid ${invalid.length}`);
    return 0;
  },
};

async function installHooks(args: string[], io: Io): Promise<number> {
  const { values } = parse(args, {
    claude: { type: "boolean" },
    codex: { type: "boolean" },
    "claude-settings": { type: "string" },
    "codex-home": { type: "string" },
    uninstall: { type: "boolean" },
  });
  const both = !values.claude && !values.codex;
  const command = hookCommand(LAUNCHER);
  const now = io.now?.() ?? new Date();
  const uninstall = values.uninstall === true;
  const targets: { name: string; path: string; note: string }[] = [];
  if (both || values.claude) {
    targets.push({
      name: "Claude Code",
      path: expandHome(values["claude-settings"] ?? "~/.claude/settings.json"),
      note: "Claude Code picks the hook up in sessions started from now on.",
    });
  }
  if (both || values.codex) {
    const home = expandHome(values["codex-home"] ?? io.env.CODEX_HOME ?? "~/.codex");
    targets.push({
      name: "Codex",
      path: join(home, "hooks.json"),
      note: "Codex runs a new hook only once you trust it: open Codex, run /hooks and trust paseo-inbox.",
    });
  }
  for (const target of targets) {
    const { outcome, backup } = await updateHookFile(target.path, command, uninstall, now);
    const where = { added: "added to", "already installed": "already installed in", removed: "removed from", "not installed": "not installed in" }[outcome];
    io.out(`${target.name}: hook ${where} ${target.path}${backup ? ` (backup: ${backup})` : ""}`);
    if (outcome === "added") io.out(`  ${target.note}`);
  }
  if (!uninstall) io.out(`Hook command: ${command}`);
  return 0;
}

// A hook must never break its agent: every failure ends in exit 0 and no output.
async function hook(io: Io): Promise<number> {
  try {
    const input = await (io.stdin ?? readStdin)();
    const config = await loadConfig(configPath(io.env.PASEO_INBOX_CONFIG));
    const directory = createDirectory(config, io.connect ?? paseoConnect());
    const output = await runHook(input, {
      config,
      store: createStore(config.store),
      agentId: io.env.PASEO_AGENT_ID?.trim(),
      now: () => io.now?.() ?? new Date(),
      lookupRole: (agentId) =>
        withTimeout(
          directory.self(agentId).then((found) => found?.agent.labels?.[config.roleLabel] ?? null),
          LOOKUP_MS,
        ),
      syncInBackground: io.syncInBackground ?? syncInBackground,
      fastPath: {
        dir: join(io.env.TMPDIR || "/tmp", `paseo-inbox-${process.getuid?.() ?? 0}`),
        config: io.env.PASEO_INBOX_CONFIG || `${io.env.HOME}/.paseo/inbox.json`,
      },
    });
    if (output !== null) io.out(output);
  } catch (error) {
    if (io.env.PASEO_INBOX_DEBUG) io.err(`paseo-inbox hook: ${error instanceof Error ? error.stack : String(error)}`);
  }
  return 0;
}

const LOOKUP_MS = 3_000;

// Messages as shown: their agents carry their current session titles, when their hosts answer in
// time.
async function retitle(messages: Message[], directory: Directory): Promise<Message[]> {
  const titles = await withTimeout(directory.titles(agentsIn(messages)), LOOKUP_MS).catch(() => new Map<string, string>());
  return messages.map((m) => withTitles(m, titles));
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export const LAUNCHER = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/paseo-inbox");

function syncInBackground(): void {
  spawn(LAUNCHER, ["sync"], { detached: true, stdio: "ignore" }).unref();
}

function threadOf(message: Message, messages: readonly Message[]): Message[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const thread = new Map<string, Message>([[message.id, message]]);
  for (let up = message.inReplyTo ? byId.get(message.inReplyTo) : undefined; up && !thread.has(up.id); ) {
    thread.set(up.id, up);
    up = up.inReplyTo ? byId.get(up.inReplyTo) : undefined;
  }
  const queue = [message.id];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const reply of messages.filter((m) => m.inReplyTo === parent && !thread.has(m.id))) {
      thread.set(reply.id, reply);
      queue.push(reply.id);
    }
  }
  return [...thread.values()].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
}

function describe(m: Message, people: readonly Person[], focus: boolean): string {
  const lines = [
    `${focus ? ">> " : ""}[${m.id}] from ${partyName(m.from, people)} to ${partyName(m.to, people)}${tags(m.ref, m.inReplyTo)}, ${formatWhen(m.sentAt)}`,
  ];
  if (m.question) {
    const { question } = m;
    lines.push(`Question: ${question.title}`);
    for (const o of question.options) {
      lines.push(`  ${o.key}: ${o.text}${question.recommendation === o.key ? " (recommended)" : ""}`);
    }
  }
  if (m.body !== "") lines.push(m.body);
  const state = m.question?.state;
  if (state?.kind === "open") lines.push("Open.");
  if (state?.kind === "withdrawn") lines.push(`Withdrawn ${formatWhen(state.at)}${state.reason ? `: ${state.reason}` : ""}.`);
  if (state?.kind === "answered") {
    lines.push(`Answered by ${partyName({ kind: "person", person: state.by }, people)} ${formatWhen(state.at)}:`);
    if (state.choice !== null) lines.push(`  Choice: ${state.choice}`);
    if (state.text !== "") lines.push(`  ${state.text}`);
  }
  const read = m.question === null ? m.read : state?.kind === "answered" ? state.read : null;
  if (read) lines.push(`Read ${formatWhen(read.at)} by ${read.title ?? `agent ${read.agentId}`}.`);
  return lines.join("\n");
}

function parse<const O extends ParseArgsOptionsConfig>(args: string[], options: O) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

// Who is sending: a person id from config, or the agent this command runs in (PASEO_AGENT_ID),
// named by --from or by its role label.
async function sender(fromArg: string | undefined, ctx: Ctx, opts: { allowPerson: boolean }): Promise<Party> {
  const { config, directory, io } = ctx;
  if (fromArg !== undefined && config.people.some((p) => p.id === fromArg)) {
    if (!opts.allowPerson) throw new UsageError(`${fromArg} is a person; questions come from agents.`);
    return { kind: "person", person: fromArg };
  }
  const agentId = io.env.PASEO_AGENT_ID?.trim() || null;
  const self = agentId ? await directory.self(agentId).catch(() => null) : null;
  const role = fromArg ?? self?.agent.labels?.[config.roleLabel] ?? null;
  if (role === null && agentId === null) {
    throw new UsageError("Pass --from ROLE, or run inside a Paseo agent (PASEO_AGENT_ID).");
  }
  return { kind: "agent", role, agentId, title: self?.agent.title ?? null, host: config.self };
}

function recipient(arg: string, config: Config): Recipient {
  if (arg.startsWith("agent:")) {
    const agentId = arg.slice("agent:".length);
    if (!agentId) throw new UsageError("agent: needs an agent id.");
    return { kind: "party", party: { kind: "agent", role: null, agentId, title: null, host: config.self } };
  }
  const person = arg.startsWith("person:") ? arg.slice("person:".length) : arg;
  if (config.people.some((p) => p.id === person)) {
    throw new UsageError(`${person} is a person. Ask them with: paseo-inbox ask --to ${person} ...`);
  }
  const role = arg.startsWith("role:") ? arg.slice("role:".length) : arg;
  if (!role) throw new UsageError("role: needs a role.");
  return { kind: "role", role };
}

function partyFilter(arg: string, config: Config): string {
  if (/^(person|role|agent):/.test(arg)) return arg;
  return config.people.some((p) => p.id === arg) ? `person:${arg}` : `role:${arg}`;
}

function row(m: Message, people: readonly Person[]): string {
  const state = m.question?.state;
  const status =
    state === undefined
      ? "message"
      : state.kind === "open"
        ? "open"
        : state.kind === "answered"
          ? `answered by ${state.by} ${formatWhen(state.at)}, delivery ${state.delivery.kind}`
          : `withdrawn ${formatWhen(state.at)}`;
  const subject = m.question?.title ?? m.body.split("\n")[0];
  return [m.id, status, partyName(m.from, people), partyName(m.to, people), m.ref ?? "-", subject].join("\t");
}
