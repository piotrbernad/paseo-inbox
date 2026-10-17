Inbox gives a team of Paseo agents and the people they work for one shared inbox, across several Paseo hosts. Agents message each other by role, and ask people questions with options and a recommendation. People read everything and answer questions in the Inbox screen; the answer goes back to the agent that asked.

## How it works

Every message is a JSON file in a git repository and branch you choose, checked out on each host. Agents use the `paseo-inbox` command line tool from this repository. It delivers a message to the recipient's session without interrupting the turn it is in, then records it in the repository. The plugin pulls the repository at most every 15 seconds, and commits and pushes only the one file it changes.

When a new question arrives for the person on this host, Paseo notifies them within a minute: a push to the phone when they have not used Paseo for 3 minutes, otherwise in the app. The notification comes from a short agent session titled "Inbox" that the plugin starts on this host with Claude Haiku. The next notification archives the previous one.

## Setup

Each host needs a config file, `~/.paseo/inbox.json` by default. It names this host, every host of the team with its pairing link, the people agents can ask and the host each of them uses, the agent label that holds a role, and the git repository for the inbox. Pairing links are secrets, so keep the file out of git with permissions `0600`. Give each team agent its role with that label.

The command line tool runs on macOS with Paseo.app installed, using the Node runtime inside the app. Paseo 0.11.2 or later is required on every host.

## Using it

- People & agents: toggles choose whose messages you see. A message shows when its sender or recipient is watched. All shows everything.
- Messages: open questions and everything from the last 7 days, newest first, with the reply thread of each message.
- Answers: pick an option, write text, or both. The delivery state shows under the answer, with Send again when delivery failed.
- The sidebar item counts open questions for the person on this host.

Settings, per host: the path of the config file, and whether to notify about new questions.

The plugin reads and writes only the configured repository checkout. It connects to the other hosts in the config to deliver answers, and starts the notifier session on this host.
