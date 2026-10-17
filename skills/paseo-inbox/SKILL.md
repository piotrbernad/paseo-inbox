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
paseo-inbox ask --to <person> --title "One decision" --context "2 sentences." --option "A: …" --option "B: …" --recommend A
```

- At most 200 characters. Put details in a PR, ticket comment or file and send the link.
- One message, one matter. Reply with `--re <ID>` so the thread stays together.
- Do not send acknowledgements ("thanks", "got it"). Reply only when something changes or you need something.
- `--fyi` for information that can wait for the recipient's next turn. Without it, an idle recipient is woken.
- Sending never interrupts the recipient's current work.
- Ask a person only what you cannot decide or infer yourself.
