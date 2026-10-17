import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { type Config, configPath, loadConfig, me } from "./server/config.ts";
import { createDirectory, paseoConnect } from "./server/hosts.ts";
import { createInbox, type Inbox } from "./server/inbox.ts";
import { startNotifier } from "./server/notify.ts";
import { deliverAnswer } from "./server/send.ts";
import { createStore, type Store } from "./server/store.ts";
import { answerRpc, inboxSettings, listRpc, retryDeliveryRpc } from "./shared/rpc.ts";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(inboxSettings);
  const connect = paseoConnect();
  // One store per checkout keeps its pull throttle across config reloads.
  const stores = new Map<string, { store: Store; ready: Promise<unknown> }>();
  // The SDK connection reaches plugins only through hook and RPC contexts, never at startup.
  let paseo: PluginHandlerContext["paseo"] | null = null;
  const capture = (_: unknown, context: PluginHandlerContext) => {
    paseo = context.paseo;
  };

  async function current(): Promise<{ config: Config; inbox: Inbox }> {
    const state = await settings.read();
    const config = await loadConfig(configPath(state.status === "ready" ? state.values.configPath : null));
    const key = `${config.store.dir}\n${config.store.branch}\n${config.store.repo}`;
    let entry = stores.get(key);
    if (!entry) {
      const store = createStore(config.store);
      const ready = store.init().catch((error) => {
        stores.delete(key);
        console.error("Inbox: could not set up the store", error);
      });
      entry = { store, ready };
      stores.set(key, entry);
    }
    await entry.ready;
    const { store } = entry;
    const directory = createDirectory(config, connect);
    const inbox = createInbox({
      store,
      people: config.people,
      me: me(config)?.id ?? null,
      deliver: (question) => deliverAnswer({ config, directory }, question),
    });
    return { config, inbox };
  }

  server.on("agent.turn_started", capture);
  server.handle(listRpc, async (input, context) => {
    capture(input, context);
    return (await current()).inbox.list();
  });
  server.handle(answerRpc, async (input, context) => {
    capture(input, context);
    return (await current()).inbox.answer(input);
  });
  server.handle(retryDeliveryRpc, async (input, context) => {
    capture(input, context);
    return (await current()).inbox.retryDelivery(input.id);
  });

  const stopNotifier = startNotifier({
    async inbox() {
      const { config, inbox } = await current();
      const { me, people, messages } = await inbox.list();
      return { me, people, messages, cwd: config.store.dir };
    },
    async enabled() {
      const state = await settings.read();
      return state.status !== "ready" || state.values.notify;
    },
    paseo: () => paseo,
  });
  return () => stopNotifier();
}
