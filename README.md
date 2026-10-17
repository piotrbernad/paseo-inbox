# paseo-inbox

An inbox for a team of [Paseo](https://paseo.sh) agents and the people they work for, across several Paseo hosts.

Every message between agents, and every question from an agent to a person, is a JSON file in a git repository you choose. People read and answer in the **Inbox** screen of the Paseo app. Agents use a small CLI, `paseo-inbox`.

- An agent sends another agent a message by role. The message reaches the recipient's session without interrupting its current turn, then lands in the inbox.
- An agent asks a person a question with options and a recommendation. The person answers in Paseo, and the answer goes back to the agent that asked.
- Paseo notifies the person on their host about a new question: a push to the phone when they have been away from Paseo for 3 minutes, otherwise in the app.

## Requirements

- Paseo 0.11.2 or later on every host, with plugins enabled.
- The CLI runs on macOS with Paseo.app installed. It uses the Node runtime and connection code inside the app, so there is nothing else to install.
- A git repository every host can push to. A dedicated branch of a private repository works well.

## Install

Install the plugin on each host:

```bash
paseo plugin add git:piotrbernad/paseo-inbox
```

Put the CLI where your agents can run it:

```bash
git clone https://github.com/piotrbernad/paseo-inbox ~/.paseo/paseo-inbox
ln -s ~/.paseo/paseo-inbox/bin/paseo-inbox ~/.local/bin/paseo-inbox
```

## Configure

Each host reads `~/.paseo/inbox.json`. Set `PASEO_INBOX_CONFIG` to use another path for the CLI, or set the path in the plugin settings.

```json
{
  "self": "host-a",
  "hosts": { "host-a": "local", "host-b": "<pairing link of host-b>" },
  "people": [
    { "id": "alice", "name": "Alice", "host": "host-a" },
    { "id": "bob", "name": "Bob", "host": "host-b" }
  ],
  "roleLabel": "team-role",
  "store": { "repo": "git@github.com:org/private.git", "branch": "inbox", "dir": "~/.paseo/inbox-store" }
}
```

| Field | Meaning |
| --- | --- |
| `self` | This host's key in `hosts`. |
| `hosts` | Every host of the team. `local` is this machine; other hosts use their Paseo pairing link. |
| `people` | The people agents can ask. A person belongs to the host they use Paseo on; that host's plugin notifies them. |
| `roleLabel` | The Paseo agent label that names an agent's role. Defaults to `team-role`. |
| `store` | The git repository, branch and local checkout of the inbox. `branch` defaults to `inbox`, `dir` to `~/.paseo/inbox-store`. |

Pairing links are secrets. Keep the file out of git and readable only by you:

```bash
chmod 600 ~/.paseo/inbox.json
```

Give each team agent a role label, for example `paseo agent update <agent-id> --label team-role=lead`. Then create the store once:

```bash
paseo-inbox init
```

`init` clones the branch, or creates it on the remote as an orphan branch with a short README. Running it again is safe. The plugin runs the same step on first use.

## CLI

```text
paseo-inbox init
paseo-inbox send [--from ROLE] TO "message" [--re ID] [--ref X] [--file path] [--no-record]
paseo-inbox ask [--from ROLE] --to PERSON --title "..." (--context "..." | --context-file path)
                [--option "A: text"]... [--recommend A] [--ref X]
paseo-inbox list [--all] [--for PARTY]
paseo-inbox withdraw ID [reason]
paseo-inbox import-questions DIR
```

Inside a Paseo agent, `PASEO_AGENT_ID` identifies the sender. `--from` names its role; without it, the CLI reads the role label of the agent. `TO` is a role, `role:ROLE`, or `agent:AGENT_ID` for a session without a role. The CLI finds the recipient on this host first, then on the other hosts.

`send` delivers first and records after, so every message in the store reached its recipient. The recipient sees a header with the message id and the exact reply command:

```text
[inbox 20261017-1602-lead-k3f9] from lead · host-a to designer · host-b
Reply: paseo-inbox send --from designer lead --re 20261017-1602-lead-k3f9 "…"
```

`ask` only records the question. The answer arrives later as a message from the person. `list` shows open questions; `--all` adds everything from the last 7 days, and `--for` narrows it to messages from or to one party (`person:ID`, `role:ROLE`, `agent:AGENT_ID`).

## How agents should use it

Paste something like this into your agents' instructions:

```text
Talk to other agents with `paseo-inbox send --from <your role> <their role> "message"`.
Reply with the command printed in the header of the message you got.
Ask a person with `paseo-inbox ask --from <your role> --to <person> --title "one line"
--context "two or three sentences" --option "A: ..." --option "B: ..." --recommend A`.
Then keep working on what does not depend on the answer; it arrives as a message.
Do not ask people in chat messages. Withdraw a question that no longer matters.
```

## The plugin

The **Inbox** screen lists open questions and everything from the last 7 days, newest first. The sidebar item shows how many open questions wait for the person on this host.

- Watch people and agents with the toggles under **People & agents**. A message shows when its sender or recipient is watched. **All** shows everything.
- Open a message for its thread: the message it replies to and the replies to it.
- Answer an open question by picking an option, writing text, or both. The answer is saved in the question and delivered to the agent that asked. A failed delivery shows **Send again**.

Plugin settings, per host: the config file path, and whether to notify about new questions. Notifications come from a short-lived agent the plugin starts on its host; it repeats the text, Paseo turns its reply into the notification, and the next notification archives it. It uses `claude/claude-haiku-4-5`.

## Store format

One file per message, `messages/<id>.json`, validated with the zod schema in `shared/message.ts`:

```ts
type Party =
  | { kind: "person"; person: string }
  | { kind: "agent"; role: string | null; agentId: string | null; title: string | null; host: string };

type Message = {
  version: 1;
  id: string; // yyyymmdd-HHMM-<sender>-<4 random>
  from: Party;
  to: Party; // a person exactly when `question` is set
  ref: string | null;
  inReplyTo: string | null;
  sentAt: string;
  body: string;
  question: null | {
    title: string;
    options: { key: string; text: string }[];
    recommendation: string | null;
    state: { kind: "open" } | { kind: "answered"; choice; text; by; at; delivery } | { kind: "withdrawn"; at; reason };
  };
};
```

Every write commits only its own file. Pulls use `--autostash`, so other files in the checkout stay untouched. When a push is rejected, the commit is undone and the change is checked again against a fresh pull, so two people answering the same question at once get one answer and one refusal.

## Development

```bash
npm install
npm run typecheck
npm test
```

Tests use temporary git remotes and fake Paseo hosts. They never connect to a daemon.

## License

MIT
