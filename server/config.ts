import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { z } from "zod";
import { type Person, PersonSchema } from "../shared/message.ts";

export const DEFAULT_CONFIG_PATH = "~/.paseo/inbox.json";
export const DEFAULT_WAKE_TEXT = "New messages in your inbox. Read them with the shell command: paseo-inbox read";
export const DEFAULT_NOTICE_TEXT = "Inbox: {count} unread (from {from}). Read them with the shell command: paseo-inbox read";

export const ConfigSchema = z
  .object({
    self: z.string().min(1),
    // Host key -> "local" or a pairing link. Pairing links are secrets: never log them.
    hosts: z.record(z.string(), z.string().min(1)),
    people: z.array(PersonSchema).default([]),
    roleLabel: z.string().min(1).default("team-role"),
    // Messages are short and concrete; details go in a PR, ticket or file, and the message links it.
    maxBodyChars: z.number().int().positive().default(200),
    // A message that starts with one of these words, asks nothing and links nothing is an
    // acknowledgement: it wakes the recipient for nothing, so send refuses it.
    ackWords: z.array(z.string().min(1)).default(["thanks", "thank you", "got it", "ok", "okay", "noted", "acknowledged", "understood", "sounds good"]),
    // Hosts whose agents run `paseo-inbox hook`: messages reach them through the hook, and only an
    // idle recipient gets a short wake-up notice. Other hosts get the whole message in the chat.
    hookHosts: z.array(z.string().min(1)).default([]),
    // The line the hook adds to an agent's context when new messages wait for it. {count} is the
    // number of new messages, {from} their senders' session names.
    noticeText: z.string().min(1).default(DEFAULT_NOTICE_TEXT),
    // The chat message that wakes an idle agent on a hook host: an instruction to read, never the
    // message itself.
    wakeText: z.string().min(1).default(DEFAULT_WAKE_TEXT),
    store: z.object({
      repo: z.string().min(1),
      branch: z.string().min(1).default("inbox"),
      dir: z.string().min(1).default("~/.paseo/inbox-store"),
    }),
  })
  .refine((c) => c.self in c.hosts, { message: "self must be one of the keys in hosts", path: ["self"] })
  .refine((c) => c.hookHosts.every((h) => h in c.hosts), {
    message: "every hookHosts entry must be one of the keys in hosts",
    path: ["hookHosts"],
  })
  .refine((c) => new Set(c.people.map((p) => p.id)).size === c.people.length, {
    message: "people ids must be unique",
    path: ["people"],
  });
export type Config = z.infer<typeof ConfigSchema>;

export function expandHome(path: string): string {
  return path.replace(/^~(?=\/|$)/, homedir());
}

export function configPath(override?: string | null): string {
  return expandHome(override?.trim() || process.env.PASEO_INBOX_CONFIG?.trim() || DEFAULT_CONFIG_PATH);
}

export async function loadConfig(path: string): Promise<Config> {
  const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`No inbox config at ${path}. See the README for its shape.`);
    throw error;
  });
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid inbox config ${path}: ${issues.join("; ")}`);
  }
  const config = parsed.data;
  return { ...config, store: { ...config.store, dir: expandHome(config.store.dir) } };
}

export function me(config: Config): Person | null {
  return config.people.find((p) => p.host === config.self) ?? null;
}
