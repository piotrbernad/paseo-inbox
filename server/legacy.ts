import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MESSAGE_ID, type Message, QuestionStateSchema } from "../shared/message.ts";

// The earlier one-file-per-question format ("questions/<id>.json"), imported once into messages.
const LegacyQuestionSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(MESSAGE_ID),
  to: z.string().min(1),
  from: z.string().min(1),
  fromHost: z.string().min(1),
  ticket: z.string().nullable(),
  title: z.string().min(1),
  context: z.string(),
  options: z.array(z.object({ key: z.string().min(1), text: z.string() })),
  recommendation: z.string().nullable(),
  askedAt: z.iso.datetime(),
  state: QuestionStateSchema,
});
type LegacyQuestion = z.infer<typeof LegacyQuestionSchema>;

export function fromLegacy(q: LegacyQuestion): Message {
  return {
    version: 1,
    id: q.id,
    from: { kind: "agent", role: q.from, agentId: null, title: null, host: q.fromHost },
    to: { kind: "person", person: q.to },
    ref: q.ticket,
    inReplyTo: null,
    sentAt: q.askedAt,
    body: q.context,
    question: { title: q.title, options: q.options, recommendation: q.recommendation, state: q.state },
  };
}

export async function readLegacyQuestions(dir: string): Promise<{ messages: Message[]; invalid: string[] }> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  const messages: Message[] = [];
  const invalid: string[] = [];
  for (const name of names) {
    const raw = await readFile(join(dir, name), "utf8");
    let parsed: ReturnType<typeof LegacyQuestionSchema.safeParse> | null = null;
    try {
      parsed = LegacyQuestionSchema.safeParse(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    if (parsed?.success && `${parsed.data.id}.json` === name) messages.push(fromLegacy(parsed.data));
    else invalid.push(name);
  }
  return { messages, invalid };
}
