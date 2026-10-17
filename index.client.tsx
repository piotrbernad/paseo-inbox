import type { PluginClientContext } from "@getpaseo/plugin/client";
import { InboxScreen, InboxSidebarItem } from "./client/inbox.tsx";
import { InboxSettings } from "./client/settings.tsx";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "inbox", title: "Inbox", Component: InboxScreen });
  client.addSidebarHeaderItem({ id: "inbox", title: "Inbox", Component: InboxSidebarItem });
  client.addSettingsScreen({ id: "settings", title: "Inbox", icon: "Inbox", Component: InboxSettings });
  return () => {};
}
