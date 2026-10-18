import type { AgentParty, Titles } from "../shared/message.ts";
import type { Config } from "./config.ts";
import { bundledModule, paseoResources } from "./paseo-app.ts";

export type AgentStatus = "initializing" | "idle" | "running" | "error" | "closed";

export interface AgentSnapshot {
  id: string;
  status?: AgentStatus;
  title?: string | null;
  labels?: Record<string, string>;
  archivedAt?: string | null;
}

// The slice of the CLI's DaemonClient this package uses; tests pass a fake.
export interface HostClient {
  fetchAgents(options: { filter: { labels: Record<string, string> } }): Promise<{ entries: { agent: AgentSnapshot }[] }>;
  fetchAgent(options: { agentId: string }): Promise<{ agent: AgentSnapshot } | null>;
  sendAgentMessage(agentId: string, text: string, options: { activeTurnBehavior: "steer" }): Promise<unknown>;
  close(): Promise<unknown>;
}

// endpoint is a value from config.hosts: "local" or a pairing link.
export type Connect = (endpoint: string) => Promise<HostClient>;

export function paseoConnect(): Connect {
  type CliModules = {
    connectToDaemon(options: { target: unknown }): Promise<HostClient>;
    selectDaemonTarget(options: { host?: string }): unknown;
  };
  let modules: Promise<CliModules> | null = null;
  return async (endpoint) => {
    modules ??= (async () => {
      const resources = paseoResources();
      const client = await import(bundledModule(resources, "@getpaseo/cli/dist/utils/client.js"));
      const target = await import(bundledModule(resources, "@getpaseo/cli/dist/utils/daemon-target.js"));
      return { connectToDaemon: client.connectToDaemon, selectDaemonTarget: target.selectDaemonTarget };
    })();
    const { connectToDaemon, selectDaemonTarget } = await modules;
    const target = selectDaemonTarget(endpoint === "local" ? {} : { host: endpoint });
    try {
      return await connectToDaemon({ target });
    } catch (error) {
      // The CLI's own errors already redact the pairing link.
      const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
      throw new Error(message);
    }
  };
}

export type Located = { host: string; agent: AgentSnapshot };

// Paseo labels a session started by another agent (MCP create_agent) with that agent's id. Both
// live on the same daemon.
export const PARENT_LABEL = "paseo.parent-agent-id";

export function createDirectory(config: Config, connect: Connect) {
  async function on<T>(host: string, fn: (client: HostClient) => Promise<T>): Promise<T> {
    const endpoint = config.hosts[host];
    if (endpoint === undefined) throw new Error(`Unknown host ${host}.`);
    const client = await connect(endpoint);
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => {});
    }
  }

  async function fetchLive(client: HostClient, agentId: string): Promise<AgentSnapshot | null> {
    const found = await client.fetchAgent({ agentId }).catch(() => null);
    return found && !found.agent.archivedAt ? found.agent : null;
  }

  function hostOrder(prefer?: string): string[] {
    const keys = Object.keys(config.hosts);
    const first = prefer && keys.includes(prefer) ? prefer : config.self;
    return [first, ...keys.filter((k) => k !== first)];
  }

  const roleOf = (agent: AgentSnapshot) => agent.labels?.[config.roleLabel]?.trim() || null;

  // The role of the agent that started this one; null when none started it, or it cannot be found.
  async function parentRole(located: Located): Promise<string | null> {
    const parentId = located.agent.labels?.[PARENT_LABEL]?.trim();
    if (!parentId) return null;
    const parent = await on(located.host, (client) => client.fetchAgent({ agentId: parentId })).catch(() => null);
    return parent ? roleOf(parent.agent) : null;
  }

  async function party(located: Located): Promise<AgentParty> {
    const { agent, host } = located;
    return {
      kind: "agent",
      role: roleOf(agent),
      agentId: agent.id,
      title: agent.title ?? null,
      host,
      parentRole: await parentRole(located),
    };
  }

  return {
    on,
    party,

    async findRole(role: string): Promise<Located> {
      const unreachable: string[] = [];
      for (const host of hostOrder()) {
        try {
          const agent = await on(host, async (client) => {
            const { entries } = await client.fetchAgents({ filter: { labels: { [config.roleLabel]: role } } });
            return entries.map((e) => e.agent).find((a) => !a.archivedAt && a.labels?.[config.roleLabel] === role);
          });
          if (agent) return { host, agent };
        } catch (error) {
          unreachable.push(`${host} (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      const suffix = unreachable.length ? `; unreachable: ${unreachable.join(", ")}` : "";
      throw new Error(`No agent with ${config.roleLabel}=${role} on any host${suffix}`);
    },

    async findAgent(agentId: string, preferHost?: string): Promise<Located | null> {
      for (const host of hostOrder(preferHost)) {
        const agent = await on(host, (client) => fetchLive(client, agentId)).catch(() => null);
        if (agent) return { host, agent };
      }
      return null;
    },

    async self(agentId: string): Promise<Located | null> {
      const agent = await on(config.self, (client) => fetchLive(client, agentId));
      return agent ? { host: config.self, agent } : null;
    },

    // The current session titles of these agents, one connection per host. Agents on hosts that
    // cannot be reached are left out.
    async titles(agents: readonly AgentParty[]): Promise<Titles> {
      const byHost = new Map<string, Set<string>>();
      for (const { host, agentId } of agents) {
        if (agentId === null || !(host in config.hosts)) continue;
        byHost.set(host, (byHost.get(host) ?? new Set()).add(agentId));
      }
      const found = new Map<string, string>();
      await Promise.all(
        [...byHost].map(([host, ids]) =>
          on(host, async (client) => {
            for (const agentId of ids) {
              const title = (await client.fetchAgent({ agentId }).catch(() => null))?.agent.title?.trim();
              if (title) found.set(agentId, title);
            }
          }).catch(() => {}),
        ),
      );
      return found;
    },

    steer(located: Located, text: string): Promise<unknown> {
      return on(located.host, (client) => client.sendAgentMessage(located.agent.id, text, { activeTurnBehavior: "steer" }));
    },
  };
}

export type Directory = ReturnType<typeof createDirectory>;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
