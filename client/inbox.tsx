import type { PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { inView, viewChoices } from "../shared/message.ts";
import { inboxSettings, type ListOutput } from "../shared/rpc.ts";
import { openQuestionsFor, useInbox } from "./data.ts";
import { Detail } from "./detail.tsx";
import { MessageList, PartiesPanel } from "./list.tsx";
import { makeStyles, type Styles } from "./styles.ts";

export function InboxSidebarItem({ host, theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const { data } = useInbox(host.id);
  const count = openQuestionsFor(data);
  return (
    <SidebarRow
      icon="Inbox"
      active={currentScreen?.screenId === "inbox"}
      onPress={() => openScreen({ screenId: "inbox" })}
      trailing={
        count > 0 ? (
          <View
            style={{
              minWidth: 20,
              paddingHorizontal: 6,
              borderRadius: 10,
              backgroundColor: theme.colors.accent,
              alignItems: "center",
            }}
          >
            <Text style={{ color: theme.colors.accentForeground, fontSize: 12, fontWeight: "600" }}>{count}</Text>
          </View>
        ) : null
      }
    />
  );
}

export function InboxScreen({ host, theme, layout }: PluginScreenProps) {
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const { data, error, isPending } = useInbox(host.id);
  const settings = useSettings(inboxSettings);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);

  if (isPending) return <Text style={[styles.screen, styles.empty]}>Loading the inbox…</Text>;
  if (!data) {
    return (
      <Text style={[styles.screen, styles.empty, styles.danger]}>
        Could not load the inbox: {error instanceof Error ? error.message : String(error)}
      </Text>
    );
  }

  const view = settings.status === "ready" ? settings.values.view : "all";
  const choices = viewChoices(data.parties, view);
  const viewLabel = choices.find((c) => c.key === view)?.label ?? null;
  const choose = (next: string) => {
    setFilterOpen(false);
    if (settings.status !== "ready" || next === view) return;
    void settings.save({ ...settings.values, view: next }, settings.revision);
  };
  const visible = data.messages.filter((m) => inView(m, view));
  const selected = data.messages.find((m) => m.id === selectedId) ?? null;
  const parties = (
    <PartiesPanel
      choices={choices}
      view={view}
      styles={styles}
      disabled={settings.status !== "ready" || settings.saving}
      onChange={choose}
    />
  );
  const list = (highlighted: string | null) => (
    <MessageList
      messages={visible}
      data={data}
      styles={styles}
      selectedId={highlighted}
      viewLabel={viewLabel}
      onSelect={setSelectedId}
    />
  );
  const notices = <Notices data={data} styles={styles} />;
  const detail = selected ? <Detail message={selected} data={data} styles={styles} onSelect={setSelectedId} /> : null;

  if (layout.compact) {
    if (detail) {
      return (
        <View style={styles.screen}>
          <View style={styles.toolbar}>
            <Pressable accessibilityRole="button" onPress={() => setSelectedId(null)} style={styles.buttonQuiet}>
              <Icon name="ChevronLeft" size={16} color={theme.colors.foreground} />
              <Text style={styles.text}>Inbox</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            {detail}
          </ScrollView>
        </View>
      );
    }
    return (
      <View style={styles.screen}>
        <View style={styles.toolbar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`People & agents: ${viewLabel ?? "All"}`}
            onPress={() => setFilterOpen(true)}
            style={styles.buttonQuiet}
          >
            <Icon name="ListFilter" size={16} color={theme.colors.foreground} />
            <Text numberOfLines={1} style={styles.text}>
              {viewLabel ?? "All"}
            </Text>
          </Pressable>
        </View>
        <ScrollView style={styles.scroll}>
          {notices}
          {list(null)}
        </ScrollView>
        <Modal
          title="People & agents"
          icon={<Icon name="ListFilter" size={18} color={theme.colors.foreground} />}
          open={filterOpen}
          onOpenChange={setFilterOpen}
        >
          <Modal.Content>{parties}</Modal.Content>
        </Modal>
      </View>
    );
  }

  return (
    <View style={[styles.screen, styles.columns]}>
      <View style={styles.sideColumn}>
        <ScrollView style={styles.scroll}>
          <View style={styles.content}>{parties}</View>
          {notices}
          {list(selectedId)}
        </ScrollView>
      </View>
      <View style={styles.mainColumn}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          {detail ?? <Text style={styles.muted}>Select a message.</Text>}
        </ScrollView>
      </View>
    </View>
  );
}

function Notices({ data, styles }: { data: ListOutput; styles: Styles }) {
  if (!data.syncError && data.skipped === 0 && data.me) return null;
  return (
    <View style={[styles.content, { gap: 4 }]}>
      {data.syncError ? <Text style={styles.small}>Not synced: {data.syncError}</Text> : null}
      {data.skipped > 0 ? <Text style={styles.small}>Skipped unreadable message files: {data.skipped}</Text> : null}
      {data.me ? null : (
        <Text style={styles.small}>No person in the config lives on this host, so nothing here counts as yours.</Text>
      )}
    </View>
  );
}
