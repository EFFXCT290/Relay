import { api } from "@/frontend-core/api";
import type { Message, SendMessagePayload } from "@relay/contracts";

export const messagesApi = {
  list: (conversationId: string, cursor?: string) =>
    api<{ messages: Message[]; nextCursor: string | null }>(
      `/api/conversations/${conversationId}/messages${cursor ? `?cursor=${cursor}` : ""}`,
    ),
  send: (payload: SendMessagePayload) =>
    api<Message>("/api/messages", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  edit: (messageId: string, body: string) =>
    api<Message>(`/api/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    }),
  delete: (messageId: string) =>
    api<void>(`/api/messages/${messageId}`, { method: "DELETE" }),
};
