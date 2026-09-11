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

  // Cached at initiate() so a reconnect resync or a push send never needs an
  // extra DB round-trip mid-call.
  conversationId?: string;
  callerUsername?: string;
  // Set when the recipient was presence-offline at initiate() and the ring
  // was delivered via push instead of a live socket emit — tells terminate()
  // whether a stale device notification needs clearing/replacing.
  pushNotified?: boolean;
  // Running tally of relayed ICE candidates (both directions combined) —
  // logged once as a total in terminate()'s summary rather than one log line
  // per candidate, which would fire dozens of times per call for no signal.
  iceCandidateCount: number;

  // The specific socket.id actually on each side of the call — set at
  // initiate() (caller) and accept() (recipient), then repointed by
  // handleReconnect() to whatever socket.id most recently reconnected. A
  // userId alone isn't enough to identify "the call's socket": either side
  // may have other tabs/devices connected under the same userId, and their
  // disconnect/reconnect events must have zero bearing on this call.
  callerSocketId?: string;
  recipientSocketId?: string;

  // Armed by handleDisconnect() when a participant's socket drops mid-call
  // (state "active"): gives them CALL_DISCONNECT_GRACE_MS to reconnect before
  // the call is actually torn down. disconnectedUserId records WHICH
  // participant dropped, so the other peer's own (unrelated) connection event
  // can never be mistaken for the disconnected side reconnecting. Cleared by
  // handleReconnect() on a timely reconnect, or consumed when the timer fires
  // into terminate(); also cleared by destroy() so a disconnect racing a
  // legitimate end()/reject() can never fire terminate() a second time.
  disconnectGrace?: {
    timer: NodeJS.Timeout;
    disconnectedUserId: string;
  };
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
    if (session.disconnectGrace) clearTimeout(session.disconnectGrace.timer);
    sessions.delete(callId);
    if (byUser.get(session.callerId) === callId)    byUser.delete(session.callerId);
    if (byUser.get(session.recipientId) === callId) byUser.delete(session.recipientId);
  },
};
