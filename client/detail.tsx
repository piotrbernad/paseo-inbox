import { useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Answered, Message, QuestionMessage } from "../shared/message.ts";
import { answerRpc, type ListOutput, retryDeliveryRpc } from "../shared/rpc.ts";
import { labeler, personName, useResultMutation } from "./data.ts";
import { ago, when } from "./format.ts";
import { MessageRow } from "./list.tsx";
import type { Styles } from "./styles.ts";

const STUCK_PENDING_MS = 2 * 60 * 1000;

export function Detail(props: {
  message: Message;
  data: ListOutput;
  styles: Styles;
  onSelect(id: string): void;
}) {
  const { message, data, styles, onSelect } = props;
  const label = labeler(data);
  const parent = message.inReplyTo ? data.messages.find((m) => m.id === message.inReplyTo) : undefined;
  const replies = data.messages.filter((m) => m.inReplyTo === message.id).reverse();

  return (
    <View style={{ gap: styles.gap }}>
      <View style={{ gap: 4 }}>
        {message.question ? <Text style={styles.title}>{message.question.title}</Text> : null}
        <Text style={styles.muted}>
          {label(message.from)} → {label(message.to)}
        </Text>
        <Text style={styles.small}>
          {[message.ref, `${when(message.sentAt)} (${ago(message.sentAt)})`, message.id].filter(Boolean).join(" · ")}
        </Text>
      </View>
      {message.body !== "" ? (
        <Text selectable style={styles.text}>
          {message.body}
        </Text>
      ) : null}
      {message.question ? <QuestionPanel message={message} data={data} styles={styles} /> : null}
      {message.inReplyTo && !parent ? (
        <Text style={styles.small}>In reply to {message.inReplyTo} (older than 7 days or not in the store)</Text>
      ) : null}
      {parent || replies.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text style={styles.sectionTitle}>Thread</Text>
          <View style={{ borderTopWidth: 1, borderColor: styles.colors.border }}>
            {parent ? <MessageRow message={parent} data={data} styles={styles} prefix="In reply to" onPress={() => onSelect(parent.id)} /> : null}
            {replies.map((reply) => (
              <MessageRow key={reply.id} message={reply} data={data} styles={styles} prefix="Reply" onPress={() => onSelect(reply.id)} />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function QuestionPanel({ message, data, styles }: { message: QuestionMessage; data: ListOutput; styles: Styles }) {
  const { question } = message;
  const { state } = question;
  return (
    <View style={{ gap: styles.gap }}>
      {question.options.length > 0 && state.kind !== "open" ? (
        <View style={{ gap: 6 }}>
          {question.options.map((option) => (
            <Text key={option.key} style={styles.text}>
              {option.key}: {option.text}
              {question.recommendation === option.key ? "  (recommended)" : ""}
            </Text>
          ))}
        </View>
      ) : null}
      {state.kind === "open" ? <AnswerForm message={message} data={data} styles={styles} /> : null}
      {state.kind === "answered" ? <AnswerCard message={message} state={state} data={data} styles={styles} /> : null}
      {state.kind === "withdrawn" ? (
        <View style={styles.card}>
          <Text style={styles.muted}>
            Withdrawn {when(state.at)}
            {state.reason ? `: ${state.reason}` : ""}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function AnswerForm({ message, data, styles }: { message: QuestionMessage; data: ListOutput; styles: Styles }) {
  const { question } = message;
  const by = message.to.person;
  const [choice, setChoice] = useState<string | null>(null);
  const [text, setText] = useState("");
  const answer = useResultMutation(useRpc(answerRpc), () => `Answer sent to ${labeler(data)(message.from)}`);
  const canAnswer = (choice !== null || text.trim() !== "") && !answer.isPending;

  return (
    <View style={styles.card}>
      <Text style={styles.small}>Answering as {personName(data, by)}</Text>
      {question.options.map((option) => {
        const selected = choice === option.key;
        return (
          <Pressable
            key={option.key}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            onPress={() => setChoice(selected ? null : option.key)}
            style={[styles.option, selected && styles.optionSelected]}
          >
            <Text style={[selected ? styles.optionSelectedText : styles.text, { flex: 1 }]}>
              {option.key}: {option.text}
            </Text>
            {question.recommendation === option.key ? (
              <Text style={selected ? styles.optionSelectedText : styles.small}>recommended</Text>
            ) : null}
          </Pressable>
        );
      })}
      <TextInput
        multiline
        value={text}
        onChangeText={setText}
        placeholder={question.options.length > 0 ? "Comment, or your own answer" : "Your answer"}
        placeholderTextColor={styles.colors.foregroundMuted}
        style={styles.input}
      />
      <Pressable
        accessibilityRole="button"
        disabled={!canAnswer}
        onPress={() => answer.mutate({ id: message.id, choice, text, by })}
        style={[styles.button, !canAnswer && styles.buttonDisabled]}
      >
        <Text style={styles.buttonText}>{answer.isPending ? "Sending…" : "Answer"}</Text>
      </Pressable>
    </View>
  );
}

function AnswerCard(props: { message: QuestionMessage; state: Answered; data: ListOutput; styles: Styles }) {
  const { message, state, data, styles } = props;
  const retry = useResultMutation(useRpc(retryDeliveryRpc), () => `Delivered to ${labeler(data)(message.from)}`);
  const asker = labeler(data)(message.from);
  const { delivery } = state;
  const canRetry =
    delivery.kind === "failed" || (delivery.kind === "pending" && Date.now() - Date.parse(state.at) > STUCK_PENDING_MS);
  const option = state.choice !== null ? message.question.options.find((o) => o.key === state.choice) : undefined;

  return (
    <View style={styles.card}>
      <Text style={styles.muted}>
        Answered by {personName(data, state.by)} · {when(state.at)}
      </Text>
      {state.choice !== null ? (
        <Text style={styles.text}>
          Choice: {state.choice}
          {option ? ` (${option.text})` : ""}
        </Text>
      ) : null}
      {state.text !== "" ? (
        <Text selectable style={styles.text}>
          {state.text}
        </Text>
      ) : null}
      <Text style={delivery.kind === "failed" ? styles.danger : delivery.kind === "delivered" ? styles.success : styles.small}>
        {delivery.kind === "delivered"
          ? `Delivered to ${asker} ${when(delivery.at)}`
          : delivery.kind === "failed"
            ? `Not delivered to ${asker}: ${delivery.error}`
            : `Waiting to be delivered to ${asker}`}
      </Text>
      {canRetry ? (
        <Pressable
          accessibilityRole="button"
          disabled={retry.isPending}
          onPress={() => retry.mutate({ id: message.id })}
          style={[styles.button, retry.isPending && styles.buttonDisabled]}
        >
          <Text style={styles.buttonText}>{retry.isPending ? "Sending…" : "Send again"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
