import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { MessageSchema, PersonSchema, ViewSchema, viewFromWatched } from "./message.ts";

export const ResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok"), message: MessageSchema }),
  z.object({ kind: z.literal("refused"), reason: z.string() }),
]);
export type Result = z.infer<typeof ResultSchema>;

export const ListOutputSchema = z.object({
  me: z.string().nullable(),
  people: z.array(PersonSchema),
  messages: z.array(MessageSchema),
  parties: z.array(z.object({ key: z.string(), label: z.string() })),
  skipped: z.number().int(),
  syncError: z.string().nullable(),
});
export type ListOutput = z.infer<typeof ListOutputSchema>;

export const listRpc = defineRpc({
  name: "inbox.list",
  input: z.object({}),
  output: ListOutputSchema,
});

export const AnswerInputSchema = z.object({
  id: z.string(),
  choice: z.string().nullable(),
  text: z.string(),
  by: z.string(),
});
export type AnswerInput = z.infer<typeof AnswerInputSchema>;

export const answerRpc = defineRpc({
  name: "inbox.answer",
  input: AnswerInputSchema,
  output: ResultSchema,
});

export const retryDeliveryRpc = defineRpc({
  name: "inbox.retry-delivery",
  input: z.object({ id: z.string() }),
  output: ResultSchema,
});

export const inboxSettings = defineSettings({
  id: "inbox",
  scope: "host",
  version: 2,
  schema: z.object({
    configPath: z.string().default(""),
    notify: z.boolean().default(true),
    // "all", "person:<id>" or "role:<role>": the last choice on the Inbox screen.
    view: ViewSchema.default("all"),
  }),
  migrate: migrateSettings,
});

// Version 1 kept `watched`, a list of party keys (empty for everyone).
export function migrateSettings(values: unknown, fromVersion: number): unknown {
  if (fromVersion >= 2 || typeof values !== "object" || values === null) return values;
  const { watched, ...rest } = values as Record<string, unknown>;
  return { ...rest, view: viewFromWatched(watched) };
}
