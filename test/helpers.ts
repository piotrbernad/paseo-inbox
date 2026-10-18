import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Io, main } from "../server/cli/commands.ts";
import type { AgentSnapshot, Connect, HostClient } from "../server/hosts.ts";

for (const key of ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]) process.env[key] = "Test";
for (const key of ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]) process.env[key] = "test@example.com";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function tempRoot(name: string): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), `paseo-inbox-${name}-`));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// A bare remote with one unrelated branch, so the store branch has to be created as an orphan.
export function bareRemote(root: string): string {
  const remote = join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "main", seed);
  writeFileSync(join(seed, "code.txt"), "unrelated history\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", remote, "main");
  return remote;
}

export function remoteFile(remote: string, branch: string, path: string): string {
  return execFileSync("git", ["--git-dir", remote, "show", `${branch}:${path}`], { encoding: "utf8" });
}

export const PEOPLE = [
  { id: "alice", name: "Alice", host: "host-a" },
  { id: "bob", name: "Bob", host: "host-b" },
];

export function writeConfig(
  root: string,
  self: "host-a" | "host-b",
  remote: string,
  storeDir: string,
  extra: { hookHosts?: string[]; noticeText?: string; wakeText?: string; maxBodyChars?: number; maxContextChars?: number; ackWords?: string[] } = {},
  name = `inbox-${self}${extra.hookHosts ? "-hooks" : ""}`,
): string {
  const path = join(root, `${name}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      self,
      hosts: self === "host-a" ? { "host-a": "local", "host-b": "link-b" } : { "host-a": "link-a", "host-b": "local" },
      people: PEOPLE,
      roleLabel: "team-role",
      store: { repo: remote, branch: "inbox", dir: storeDir },
      ...extra,
    }),
  );
  return path;
}

export const serverIdOf = (host: string) => `server-${host}`;

export type Steered = { host: string; agentId: string; text: string; options: unknown };

// In-memory Paseo hosts. Each config reaches its own host as "local" and the other as "link-<x>".
export function fakeHosts(agents: Record<"host-a" | "host-b", AgentSnapshot[]>) {
  const steered: Steered[] = [];
  const down = new Set<string>();
  function connectAs(self: "host-a" | "host-b"): Connect {
    return async (endpoint) => {
      const host = endpoint === "local" ? self : endpoint === "link-a" ? "host-a" : endpoint === "link-b" ? "host-b" : null;
      if (host === null || down.has(host)) throw new Error(`Cannot connect to ${host ?? "unknown host"}`);
      const list = agents[host];
      const client: HostClient = {
        async fetchAgents({ filter }) {
          const match = list.filter((a) => Object.entries(filter.labels).every(([k, v]) => a.labels?.[k] === v));
          return { entries: match.map((agent) => ({ agent })) };
        },
        async fetchAgent({ agentId }) {
          const agent = list.find((a) => a.id === agentId);
          return agent ? { agent } : null;
        },
        async sendAgentMessage(agentId, text, options) {
          if (!list.some((a) => a.id === agentId)) throw new Error(`Agent not found: ${agentId}`);
          steered.push({ host, agentId, text, options });
        },
        getLastServerInfoMessage: () => ({ serverId: serverIdOf(host) }),
        async close() {},
      };
      return client;
    };
  }
  return { connectAs, steered, down, agents };
}

export async function cli(
  configPath: string,
  connect: Connect,
  args: string[],
  env: Record<string, string> = {},
  io: Partial<Io> = {},
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, {
    env: { PASEO_INBOX_CONFIG: configPath, TMPDIR: dirname(configPath), ...env },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    connect,
    ...io,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

export function mkdirp(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}
