import type { FastifyInstance } from "fastify";
import {
  TYPING_EVENTS,
  TYPING_TIMEOUT_MS,
  TYPING_SWEEP_INTERVAL_MS,
  type TypingUpdateEvent,
} from "@relay/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Typing is ephemeral UI state — and intentionally decoupled from the socket
// transport heartbeat, the presence system, delivery ACKs, and read receipts.
// Nothing else in the app should read from this service.
//
// State model (per the agreed architecture):
//
//   typingUsers[conversationId][userId] = { expiresAt, socketId }
//
// Lifecycle:
//   - typing:start  → upsert entry with expiresAt = now + TYPING_TIMEOUT_MS;
//                     broadcast typing:update{isTyping:true} only on the
//                     transition from absent → present (idempotent refresh
//                     otherwise — clients don't get spammed).
//   - typing:stop   → remove entry; broadcast typing:update{isTyping:false}
//                     only if it was present.
//   - sweep tick    → every TYPING_SWEEP_INTERVAL_MS, drop expired entries and
//                     broadcast typing:update{isTyping:false} for each. This
//                     covers disconnects, crashes, and clients that never
//                     send typing:stop. The server is the source of truth for
//                     "is this user typing right now?"; receivers never run
//                     their own timeout.
// ─────────────────────────────────────────────────────────────────────────────

type Entry = { expiresAt: number; socketId: string };
type ConversationMap = Map<string /* userId */, Entry>;

const state = new Map<string /* conversationId */, ConversationMap>();

let sweepStarted = false;
let sweepTimer: NodeJS.Timeout | null = null;

// MUST be called during fastify plugin load (before listen()). Lazy-init on
// the first socket connection is too late: Fastify forbids addHook after the
// instance is listening, so we register the onClose teardown here.
export function startTypingSweep(fastify: FastifyInstance): void {
  if (sweepStarted) return;
  sweepStarted = true;
  sweepTimer = setInterval(() => sweepExpired(fastify), TYPING_SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive just for this.
  sweepTimer.unref?.();
  fastify.addHook("onClose", async () => {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
    sweepStarted = false;
    state.clear();
  });
}

export function typingStart(
  fastify:        FastifyInstance,
  conversationId: string,
  userId:         string,
  socketId:       string,
): void {
  let convo = state.get(conversationId);
  if (!convo) {
    convo = new Map();
    state.set(conversationId, convo);
  }
  const existing = convo.get(userId);
  const wasActive = !!existing && existing.expiresAt > Date.now();
  convo.set(userId, { expiresAt: Date.now() + TYPING_TIMEOUT_MS, socketId });
  if (!wasActive) broadcast(fastify, conversationId, userId, true);
}

export function typingStop(
  fastify:        FastifyInstance,
  conversationId: string,
  userId:         string,
): void {
  const convo = state.get(conversationId);
  if (!convo) return;
  const existing = convo.get(userId);
  if (!existing) return;
  convo.delete(userId);
  if (convo.size === 0) state.delete(conversationId);
  broadcast(fastify, conversationId, userId, false);
}

// Sync query — returns active typers for a set of conversation IDs.
// Used to answer typing:sync-request so clients get correct state on
// connect/reconnect without waiting for the next sweep tick.
export function getActiveTypers(conversationIds: string[]): Record<string, string[]> {
  const now = Date.now();
  const result: Record<string, string[]> = {};
  for (const id of conversationIds) {
    const convo = state.get(id);
    if (!convo) continue;
    const active: string[] = [];
    for (const [userId, entry] of convo) {
      if (entry.expiresAt > now) active.push(userId);
    }
    if (active.length > 0) result[id] = active;
  }
  return result;
}

// Disconnect cleanup — clear every conversation this socket was typing in.
export function typingClearForSocket(
  fastify:  FastifyInstance,
  socketId: string,
): void {
  for (const [conversationId, convo] of state) {
    for (const [userId, entry] of convo) {
      if (entry.socketId !== socketId) continue;
      convo.delete(userId);
      broadcast(fastify, conversationId, userId, false);
    }
    if (convo.size === 0) state.delete(conversationId);
  }
}

function sweepExpired(fastify: FastifyInstance): void {
  const now = Date.now();
  for (const [conversationId, convo] of state) {
    for (const [userId, entry] of convo) {
      if (entry.expiresAt > now) continue;
      convo.delete(userId);
      broadcast(fastify, conversationId, userId, false);
    }
    if (convo.size === 0) state.delete(conversationId);
  }
}

function broadcast(
  fastify:        FastifyInstance,
  conversationId: string,
  userId:         string,
  isTyping:       boolean,
): void {
  const event: TypingUpdateEvent = { conversationId, userId, isTyping };
  fastify.io.to(`conversation:${conversationId}`).emit(TYPING_EVENTS.UPDATE, event);
}
