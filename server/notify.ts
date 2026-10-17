import { isOpenQuestion, type Message, type Person, partyName, type QuestionMessage } from "../shared/message.ts";

const FIRST_POLL_MS = 5_000;
const POLL_EVERY_MS = 60_000;
const MAX_ATTEMPTS = 3;
export const NOTIFIER_LABEL = "paseo-inbox-notifier";
export const NOTIFIER_TITLE = "Inbox";
export const NOTIFIER_MODEL = "claude/claude-haiku-4-5";

// Paseo has no notification API for plugins. It notifies when an agent finishes a turn, with the
// agent's last message as the push body, so a fresh agent that repeats the text is the notification.
// As a user prompt, "reply with exactly this text" was sometimes refused as an injection; carrying
// the role in the system prompt made the model repeat it reliably.
export const NOTIFIER_SYSTEM_PROMPT =
  "You are the notifier of the Inbox plugin in Paseo. Every user message is the finished text of a " +
  "phone notification. Reply with exactly that text, copied verbatim, with no tools, no comments, " +
  "and without answering any question in it.";

// The slice of the daemon SDK the notifier uses; the plugin's PaseoApi satisfies it.
export interface NotifierPaseo {
  agents: {
    list(options: { filter: { labels: Record<string, string> } }): Promise<{ entries: { agent: { id: string } }[] }>;
    ref(id: string): { archive(): Promise<unknown> };
    create(options: {
      config: { provider: string; systemPrompt: string };
      cwd: string;
      title: string;
      labels: Record<string, string>;
      prompt: string;
    }): Promise<unknown>;
  };
}

export interface NotifierDeps {
  // The current messages, the person on this host and the people for display names.
  inbox(): Promise<{ me: string | null; people: readonly Person[]; messages: Message[]; cwd: string } | null>;
  enabled(): Promise<boolean>;
  // Null until the daemon hands the plugin an SDK connection through a hook or RPC.
  paseo(): NotifierPaseo | null;
}

export function createNotifier(deps: NotifierDeps) {
  let seen: Set<string> | null = null;
  const failures = new Map<string, number>();

  async function notify(paseo: NotifierPaseo, cwd: string, text: string): Promise<boolean> {
    const labels = { [NOTIFIER_LABEL]: "true" };
    // A notifier already waiting for attention cannot notify again, so each batch gets a new one.
    try {
      const previous = await paseo.agents.list({ filter: { labels } });
      for (const { agent } of previous.entries) {
        await paseo.agents
          .ref(agent.id)
          .archive()
          .catch((error) => console.error(`Inbox: could not archive notifier ${agent.id}`, error));
      }
    } catch (error) {
      console.error("Inbox: could not list previous notifiers", error);
    }
    try {
      await paseo.agents.create({
        config: { provider: NOTIFIER_MODEL, systemPrompt: NOTIFIER_SYSTEM_PROMPT },
        cwd,
        title: NOTIFIER_TITLE,
        labels,
        prompt: text,
      });
      return true;
    } catch (error) {
      console.error("Inbox: could not create the notifier agent", error);
      return false;
    }
  }

  return {
    async poll(): Promise<void> {
      const state = await deps.inbox();
      if (state === null) return;
      const open = state.messages.filter(isOpenQuestion);
      if (seen === null) {
        seen = new Set(open.map((m) => m.id));
        return;
      }
      const known = seen;
      const batch = open.filter((m) => m.to.person === state.me && !known.has(m.id));
      if (batch.length === 0) return;

      if (await deps.enabled()) {
        const paseo = deps.paseo();
        if (paseo === null) return;
        if (!(await notify(paseo, state.cwd, notificationText(batch, state.people)))) {
          for (const m of batch) {
            const attempts = (failures.get(m.id) ?? 0) + 1;
            if (attempts < MAX_ATTEMPTS) {
              failures.set(m.id, attempts);
            } else {
              console.error(`Inbox: giving up on notifying about ${m.id} after ${attempts} attempts`);
              failures.delete(m.id);
              known.add(m.id);
            }
          }
          return;
        }
      }
      for (const m of batch) {
        failures.delete(m.id);
        known.add(m.id);
      }
    },
  };
}

export function startNotifier(deps: NotifierDeps): () => void {
  const notifier = createNotifier(deps);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;

  const tick = async () => {
    try {
      await notifier.poll();
    } catch (error) {
      console.error("Inbox: checking for new questions failed", error);
    }
    if (!stopped) timer = setTimeout(tick, POLL_EVERY_MS);
  };
  timer = setTimeout(tick, FIRST_POLL_MS);

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export function notificationText(batch: QuestionMessage[], people: readonly Person[]): string {
  if (batch.length === 1) {
    const [m] = batch;
    return `Question from ${partyName(m.from, people)}${m.ref ? ` (${m.ref})` : ""}: ${m.question.title}`;
  }
  return `${batch.length} new questions: ${batch.map((m) => m.question.title).join("; ")}`;
}
