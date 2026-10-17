import type { AgentParty } from "../shared/message.ts";
import type { Config } from "./config.ts";
import { bundledModule, paseoResources } from "./paseo-app.ts";

export interface AgentSnapshot {
  id: string;
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

  // This host first, then the others in config order.
  function hostOrder(prefer?: string): string[] {
    const keys = Object.keys(config.hosts);
    const first = prefer && keys.includes(prefer) ? prefer : config.self;
    return [first, ...keys.filter((k) => k !== first)];
  }

  function party(located: Located): AgentParty {
    const { agent, host } = located;
    return {
      kind: "agent",
      role: agent.labels?.[config.roleLabel] ?? null,
      agentId: agent.id,
      title: agent.title ?? null,
      host,
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

    steer(located: Located, text: string): Promise<unknown> {
      return on(located.host, (client) => client.sendAgentMessage(located.agent.id, text, { activeTurnBehavior: "steer" }));
    },
  };
}

export type Directory = ReturnType<typeof createDirectory>;
