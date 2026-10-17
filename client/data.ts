import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isOpenQuestion, type Message, type Party, partyKey, partyLabel } from "../shared/message.ts";
import { type ListOutput, listRpc, type Result } from "../shared/rpc.ts";

export function useInbox(hostId: string) {
  const list = useRpc(listRpc);
  return useQuery({
    queryKey: ["paseo-inbox", hostId],
    queryFn: () => list({}),
    refetchInterval: 30_000,
  });
}

export function openQuestionsFor(data: ListOutput | undefined): number {
  if (!data?.me) return 0;
  return data.messages.filter((m) => isOpenQuestion(m) && m.to.person === data.me).length;
}

export function useResultMutation<Input>(call: (input: Input) => Promise<Result>, success: (message: Message) => string) {
  const toast = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess(result) {
      if (result.kind === "refused") return toast.error(result.reason);
      const state = result.message.question?.state;
      if (state?.kind === "answered" && state.delivery.kind === "failed") {
        return toast.error(`Saved, but not delivered: ${state.delivery.error}`);
      }
      toast.show(success(result.message), { variant: "success" });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["paseo-inbox"] }),
  });
}

export function labeler(data: ListOutput): (party: Party) => string {
  const labels = new Map(data.parties.map((p) => [p.key, p.label]));
  return (party) => labels.get(partyKey(party)) ?? partyLabel(party, data.people);
}

export function personName(data: ListOutput, id: string): string {
  return data.people.find((p) => p.id === id)?.name ?? id;
}
