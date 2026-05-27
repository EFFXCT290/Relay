import type { CallType } from "@relay/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Ephemeral call runtime — the live state of ringing/active calls.
//
// Two module-level Maps (survive across CallService instances — one service is
// created per socket, like PresenceService's offlineTimers):
//   sessions   callId  → ActiveCallSession   (the source of truth while live)
//   byUser     userId  → callId               (enforces one call per user, and
//                                               lets disconnect find the session)
//
// This is NOT durable. Missed/answered/duration all persist to Postgres (the
// Call model) — the runtime only tracks what's needed to negotiate and tear
// down a live call. No Redis: single API instance, and Socket.IO has no Redis
// adapter here, so cross-instance state would buy nothing yet.
//
// One call per participant is the key invariant: it removes whole classes of
// bugs (double ringing, simultaneous negotiation, multiple live mics).
// ─────────────────────────────────────────────────────────────────────────────

export type CallSessionState = "ringing" | "active";

export type ActiveCallSession = {
  callId:      string;
  callerId:    string;
  recipientId: string;
  type:        CallType;
  state:       CallSessionState;
  answeredAt?: number;          // epoch ms — set on accept; duration is measured from here
  ringTimer?:  NodeJS.Timeout;  // fires the MISSED teardown if unanswered
};

const sessions = new Map<string, ActiveCallSession>();
const byUser   = new Map<string, string>();

export const callRuntime = {
  create(session: ActiveCallSession): void {
    sessions.set(session.callId, session);
    byUser.set(session.callerId, session.callId);
    byUser.set(session.recipientId, session.callId);
  },

  get(callId: string): ActiveCallSession | undefined {
    return sessions.get(callId);
  },

  getByUser(userId: string): ActiveCallSession | undefined {
    const callId = byUser.get(userId);
    return callId ? sessions.get(callId) : undefined;
  },

  isBusy(userId: string): boolean {
    return byUser.has(userId);
  },

  // The other participant of a session relative to `userId`.
  peerOf(session: ActiveCallSession, userId: string): string {
    return session.callerId === userId ? session.recipientId : session.callerId;
  },

  isParticipant(session: ActiveCallSession, userId: string): boolean {
    return session.callerId === userId || session.recipientId === userId;
  },

  // Idempotent: clears the ring timer and removes the session + both byUser
  // entries. Safe to call twice (the second call is a no-op) — the shared
  // terminate() routine relies on this.
  destroy(callId: string): void {
    const session = sessions.get(callId);
    if (!session) return;
    if (session.ringTimer) clearTimeout(session.ringTimer);
    sessions.delete(callId);
    if (byUser.get(session.callerId) === callId)    byUser.delete(session.callerId);
    if (byUser.get(session.recipientId) === callId) byUser.delete(session.recipientId);
  },
};
