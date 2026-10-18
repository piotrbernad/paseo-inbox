import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { lastActivity, type Message, type PartyEntry, partyName, receiptOf } from "../shared/message.ts";
import type { ListOutput } from "../shared/rpc.ts";
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
  const tag = badge(message, styles);
  const subject = message.question?.title ?? message.body.split("\n")[0];
  const unread = receiptOf(message)?.read === null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      style={[styles.row, selected && styles.rowSelected]}
    >
      <View style={styles.rowTop}>
        {unread ? <View accessibilityLabel="Not read by its agent yet" style={styles.unreadDot} /> : null}
        <Text numberOfLines={1} style={styles.rowParties}>
          {prefix ? `${prefix} · ` : ""}
          {partyName(message.from, data.people)} → {partyName(message.to, data.people)}
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
  // The chosen person or agent, null for all.
  viewLabel: string | null;
  onSelect(id: string): void;
}) {
  const { messages, data, styles, selectedId, viewLabel, onSelect } = props;
  if (messages.length === 0) {
    const whose = viewLabel === null ? "" : ` from or to ${viewLabel}`;
    return <Text style={styles.empty}>No messages{whose} in the last 7 days.</Text>;
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

// One choice: all messages, or those of one person or standing agent.
export function PartiesPanel(props: {
  choices: readonly PartyEntry[];
  view: string;
  styles: Styles;
  disabled: boolean;
  onChange(view: string): void;
}) {
  const { choices, view, styles, disabled, onChange } = props;
  const chip = (key: string, label: string) => {
    const on = key === view;
    return (
      <Pressable
        key={key}
        accessibilityRole="radio"
        accessibilityState={{ checked: on, disabled }}
        disabled={disabled}
        onPress={() => onChange(key)}
        style={[styles.chip, on && styles.chipOn]}
      >
        {on ? <Icon name="Check" size={12} color={styles.colors.accentForeground} /> : null}
        <Text style={on ? styles.chipTextOn : styles.chipText}>{label}</Text>
      </Pressable>
    );
  };
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.sectionTitle}>People & agents</Text>
      <View accessibilityRole="radiogroup" style={styles.chips}>
        {chip("all", "All")}
        {choices.map((p) => chip(p.key, p.label))}
      </View>
    </View>
  );
}
