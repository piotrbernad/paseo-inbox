import { readFile } from "node:fs/promises";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import {
  isOpenQuestion,
  isRecent,
  isWatched,
  type Message,
  newestFirst,
  type Party,
  partyLabel,
  type Person,
} from "../../shared/message.ts";
import { type Config, configPath, loadConfig } from "../config.ts";
import { type Connect, createDirectory, type Directory, paseoConnect } from "../hosts.ts";
import { readLegacyQuestions } from "../legacy.ts";
import { formatWhen, withdraw } from "../questions.ts";
import { newMessageId, type Recipient, send } from "../send.ts";
import { createStore, type Store } from "../store.ts";

export type Io = {
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  err(line: string): void;
  connect?: Connect;
  now?: () => Date;
};

class UsageError extends Error {}

const HELP = `paseo-inbox: messages and questions between Paseo agents and their people

  paseo-inbox init
      Clone the store branch from config.store, or create it on the remote.
  paseo-inbox send [--from ROLE] TO "message" [--re ID] [--ref X] [--file path] [--no-record]
      Deliver a message to an agent without interrupting its turn, then record it.
      TO is a role, role:ROLE or agent:AGENT_ID.
  paseo-inbox ask [--from ROLE] --to PERSON --title "..." (--context "..." | --context-file path)
                  [--option "A: text"]... [--recommend A] [--ref X]
      Ask a person a question. The answer comes back as a message from them.
  paseo-inbox list [--all] [--for PARTY]
      Open questions; --all adds everything from the last 7 days.
      PARTY is person:ID, role:ROLE, agent:AGENT_ID, or a bare person id or role.
  paseo-inbox withdraw ID [reason]
      Withdraw an open question.
  paseo-inbox import-questions DIR
      Import questions/<id>.json files of the earlier format. Safe to run again.

Config: ~/.paseo/inbox.json, or the path in PASEO_INBOX_CONFIG.
Inside a Paseo agent, PASEO_AGENT_ID identifies the sender; --from names its role.`;

export async function main(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      io.out(HELP);
      return 0;
    }
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
      },
    );
    const label = partyLabel(sent.to, ctx.config.people);
    ctx.io.out(sent.id ? `sent ${sent.id} to ${label}` : `sent to ${label} (not recorded)`);
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

  async list(args, { config, store, io, now }) {
    const { values } = parse(args, { all: { type: "boolean" }, for: { type: "string" } });
    const { messages, skipped, syncError } = await store.list();
    if (syncError) io.err(`paseo-inbox: showing local data, sync failed: ${syncError}`);
    const at = now().getTime();
    const watched = values.for !== undefined ? [partyFilter(values.for, config)] : [];
    const rows = messages
      .filter((m) => (values.all ? isRecent(m, at) : isOpenQuestion(m)))
      .filter((m) => isWatched(m, watched))
      .sort(newestFirst);
    for (const m of rows) io.out(row(m, config.people));
    if (rows.length === 0) io.out(values.all ? "no messages in the last 7 days" : "no open questions");
    if (skipped) io.err(`paseo-inbox: skipped ${skipped} invalid file(s) in ${config.store.dir}/messages`);
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
  return [m.id, status, partyLabel(m.from, people), partyLabel(m.to, people), m.ref ?? "-", subject].join("\t");
}
