import type { AnsweredQuestion, Delivery, Message, Person, QuestionMessage } from "../shared/message.ts";

export function answer(
  current: Message,
  input: { choice: string | null; text: string; by: string },
  people: readonly Person[],
  now: string,
): Message | string {
  if (current.question === null) return "That message is not a question.";
  if (current.question.state.kind !== "open") return refusalFor(current, people);
  if (current.to.person !== input.by) {
    return `This question is for ${nameOf(current.to.person, people)}, not ${nameOf(input.by, people)}.`;
  }
  if (input.choice !== null && !current.question.options.some((o) => o.key === input.choice)) {
    return `The question has no option ${input.choice}.`;
  }
  const text = input.text.trim();
  if (input.choice === null && text === "") return "Pick an option or write an answer.";
  return {
    ...current,
    question: {
      ...current.question,
      state: { kind: "answered", choice: input.choice, text, by: input.by, at: now, delivery: { kind: "pending" } },
    },
  };
}

export function withdraw(current: Message, reason: string, people: readonly Person[], now: string): Message | string {
  if (current.question === null) return "That message is not a question.";
  if (current.question.state.kind !== "open") return refusalFor(current, people);
  return { ...current, question: { ...current.question, state: { kind: "withdrawn", at: now, reason } } };
}

export function recordDelivery(current: Message, delivery: Delivery, people: readonly Person[]): Message | string {
  if (current.question === null) return "That message is not a question.";
  const { state } = current.question;
  if (state.kind !== "answered") return refusalFor(current, people);
  return { ...current, question: { ...current.question, state: { ...state, delivery } } };
}

export function isAnswered(message: Message): message is AnsweredQuestion {
  return message.question !== null && message.question.state.kind === "answered";
}

export function answerText(message: AnsweredQuestion): string {
  const { question } = message;
  const { state } = question;
  const lines = [`Answer to question ${message.id}${message.ref ? ` (${message.ref})` : ""}: ${question.title}`];
  if (state.choice !== null) {
    const option = question.options.find((o) => o.key === state.choice);
    lines.push(`Choice: ${state.choice}${option ? ` (${option.text})` : ""}`);
  }
  if (state.text !== "") lines.push(state.text);
  return lines.join("\n");
}

export function refusalFor(message: QuestionMessage, people: readonly Person[]): string {
  const { state } = message.question;
  if (state.kind === "answered") return `Already answered by ${nameOf(state.by, people)} at ${formatWhen(state.at)}.`;
  if (state.kind === "withdrawn") {
    return `Withdrawn at ${formatWhen(state.at)}${state.reason ? `: ${state.reason}` : ""}.`;
  }
  return "The question is still open.";
}

export function formatWhen(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function nameOf(id: string, people: readonly Person[]): string {
  return people.find((p) => p.id === id)?.name ?? id;
}
