import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { lastActivity, type Message, nextWatched } from "../shared/message.ts";
import type { ListOutput } from "../shared/rpc.ts";
import { labeler } from "./data.ts";
import { ago } from "./format.ts";
import type { Styles } from "./styles.ts";

function badge(message: Message, styles: Styles): { text: string; color: string } | null {
  const state = message.question?.state;
  if (!state) return null;
  if (state.kind === "open") return { text: "Open question", color: styles.colors.accent };
  if (state.kind === "answered") return { text: "Answered", color: styles.colors.statusSuccess };
  return { text: "Withdrawn", color: styles.colors.foregroundMuted };
}

export function MessageRow(props: {
  message: Message;
  data: ListOutput;
  styles: Styles;
  selected?: boolean;
  prefix?: string;
  onPress(): void;
}) {
  const { message, data, styles, selected, prefix, onPress } = props;
  const label = labeler(data);
  const tag = badge(message, styles);
  const subject = message.question?.title ?? message.body.split("\n")[0];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      style={[styles.row, selected && styles.rowSelected]}
    >
      <View style={styles.rowTop}>
        <Text numberOfLines={1} style={styles.rowParties}>
          {prefix ? `${prefix} · ` : ""}
          {label(message.from)} → {label(message.to)}
        </Text>
        <Text style={styles.small}>{ago(lastActivity(message))}</Text>
      </View>
      <View style={styles.rowTop}>
        <Text numberOfLines={1} style={[styles.rowSubject, { flex: 1 }]}>
          {subject}
        </Text>
        {tag ? (
          <View style={[styles.badge, { borderColor: tag.color }]}>
            <Text style={[styles.badgeText, { color: tag.color }]}>{tag.text}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export function MessageList(props: {
  messages: Message[];
  data: ListOutput;
  styles: Styles;
  selectedId: string | null;
  onSelect(id: string): void;
}) {
  const { messages, data, styles, selectedId, onSelect } = props;
  if (messages.length === 0) {
    return <Text style={styles.empty}>Nothing here from the people and agents you watch in the last 7 days.</Text>;
  }
  return (
    <View>
      {messages.map((m) => (
        <MessageRow
          key={m.id}
          message={m}
          data={data}
          styles={styles}
          selected={m.id === selectedId}
          onPress={() => onSelect(m.id)}
        />
      ))}
    </View>
  );
}

export function PartiesPanel(props: {
  data: ListOutput;
  watched: readonly string[];
  styles: Styles;
  disabled: boolean;
  onChange(watched: string[]): void;
}) {
  const { data, watched, styles, disabled, onChange } = props;
  const keys = data.parties.map((p) => p.key);
  const all = watched.length === 0;
  const chip = (key: string, label: string, on: boolean, onPress: () => void) => (
    <Pressable
      key={key}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
    >
      {on ? <Icon name="Check" size={12} color={styles.colors.accentForeground} /> : null}
      <Text style={on ? styles.chipTextOn : styles.chipText}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.sectionTitle}>People & agents</Text>
      <View style={styles.chips}>
        {chip("all", "All", all, () => onChange([]))}
        {data.parties.map((p) =>
          chip(p.key, p.label, all || watched.includes(p.key), () => onChange(nextWatched(watched, keys, p.key))),
        )}
      </View>
    </View>
  );
}
