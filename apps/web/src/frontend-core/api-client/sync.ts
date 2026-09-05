import { api } from "@/frontend-core/api";
import type { ReplayResponse } from "@relay/contracts";

// HTTP fallback for replay (see apps/api's sync.routes.ts). Used when the
// primary socket path (SYNC_EVENTS.REPLAY_REQUEST) itself fails — the
// contract sync.socket.ts documents for its REPLAY_RESPONSE `error` field.
export const syncApi = {
  replay: (since: string, opts?: { limit?: number; conversationId?: string }) =>
    api<Omit<ReplayResponse, "error">>("/api/sync/replay", {
      method: "POST",
      body: { since, limit: opts?.limit, conversationId: opts?.conversationId },
    }),
};
