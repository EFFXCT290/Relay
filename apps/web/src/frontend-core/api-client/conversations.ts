import { api } from "@/frontend-core/api";
import type { Conversation } from "@relay/contracts";

export const conversationsApi = {
  list: () => api<{ conversations: Conversation[] }>("/api/conversations"),
  get:  (id: string) => api<Conversation>(`/api/conversations/${id}`),
  create: (participantId: string) =>
    api<Conversation>("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ participantId }),
    }),
  delete: (id: string) =>
    api<void>(`/api/conversations/${id}`, { method: "DELETE" }),
};
