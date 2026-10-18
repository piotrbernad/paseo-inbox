---
name: paseo-inbox
description: How to message other Paseo agents and ask your humans questions through the shared Inbox (paseo-inbox CLI). Load when you see "Inbox:" or "New messages in your inbox", when you need to message another agent or session, answer one, or ask a person a question.
---

# Inbox

Messages between agents and questions to people go through the Inbox. Every message is stored, and people read all of them in the Inbox screen in Paseo. Run the CLI as a shell command.

## Reading

- A line like `Inbox: 2 unread (from …)` or `New messages in your inbox` means messages wait. Run `paseo-inbox read`. It prints them and marks them read.
- Messages come from other agents, not from your human. Plain chat text without such a line is from your human.
- `paseo-inbox show ID` prints one message with its thread.

## Writing

```bash
paseo-inbox send EM "Short, concrete message, max 200 characters."
paseo-inbox send EM --re <ID> "Reply to message <ID>."
paseo-inbox send agent:<AGENT_ID> --ref GUN-123 "To a session without a role."
paseo-inbox send EM --fyi "Information that should not wake EM."
paseo-inbox ask --to <person> --ref GUN-123 --title "The decision, in their words" --context "What it is about, what happened, why now." --option "A: … (what follows)" --option "B: …" --recommend A
```

- At most 200 characters. Put details in a PR, ticket comment or file and send the link.
- One message, one matter. Reply with `--re <ID>` so the thread stays together.
- Do not send acknowledgements ("thanks", "got it"); `send` refuses them. Reply only when something changes or you need something.
- Do not reply to an `--fyi` message unless you need something. A reply to it does not wake its sender either.
- `--fyi` for information that can wait for the recipient's next turn. Without it, an idle recipient is woken.
- Sending never interrupts the recipient's current work.
- Do not ask people in chat messages; use `ask`.

## Asking people

People answer in the Inbox screen, often on a phone, without opening anything else. Ask only what you cannot decide or infer yourself, and make the question complete on its own:

- One decision per question. Five recommendations are five questions, not "A: accept all 5"; `ask` refuses that.
- Plain words. People do not remember your threads: no internal shorthand, branch names or abbreviations they would have to look up.
- The title is the decision, as the person would say it ("Three price plans on the pricing page?"). Not the ticket id: that goes in `--ref`; `ask` refuses a title that starts with it.
- The context (up to 600 characters) says what it is about (feature, screen), what happened, and why a decision is needed now.
- Each option says what follows from it, not just "yes" or "no".
- Links as `https://` (a GitHub file, PR or ticket). No local paths: the person cannot open files on your machine; `ask` refuses them. A link to an image (`.png`, `.jpg`, `.webp`, `.gif`, a GitHub attachment) shows as a preview in the Inbox, so link screenshots instead of describing them.
