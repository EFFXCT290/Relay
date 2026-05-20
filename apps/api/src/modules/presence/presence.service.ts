import type { FastifyInstance } from "fastify";
import {
  PRESENCE_EVENTS,
  type PresenceOfflineEvent,
  type PresenceOnlineEvent,
} from "@relay/contracts";
import { PresenceRepository } from "./presence.repository.js";

// ─────────────────────────────────────────────────────────────────────────────
// SAFEGUARD 9 — presence is a UI signal, NOT system truth.
//
// What lives here: "is this user's socket currently connected?" and "when was
// their last heartbeat?". Anything that consumes presence must treat it as
// hint, not fact. Specifically, presence MUST NOT:
//   - influence message delivery (use sync + outbox instead)
//   - decide what gets replayed (sync owns that)
//   - mutate unread state (messages module owns that)
//   - block / gate writes (use auth + permissions)
//
// If you find yourself reading from PresenceService inside sync/, messages/,
// or any read-receipt path, you're about to write a bug.
//
// All presence logic lives here. The socket layer just calls into these
// methods on connect / disconnect — it does not decide who counts as online,
// when to broadcast, or how long state lingers.
// ─────────────────────────────────────────────────────────────────────────────

export class PresenceService {
  private repo: PresenceRepository;

  constructor(private fastify: FastifyInstance) {
    this.repo = new PresenceRepository(fastify);
  }

  async markOnline(userId: string): Promise<void> {
    await this.repo.setOnline(userId);
    this.broadcastOnline(userId);
  }

  async markOffline(userId: string): Promise<void> {
    const state = await this.repo.get(userId);
    await this.repo.setOffline(userId);
    this.broadcastOffline(userId, state?.lastSeen ?? new Date().toISOString());
  }

  async getFor(userId: string) {
    return this.repo.get(userId);
  }

  // ── Broadcast helpers ──────────────────────────────────────────────────────
  // Service emits — socket handlers never call io.emit() directly. Keeps the
  // "who hears about whom" policy in one place.
  private broadcastOnline(userId: string) {
    const event: PresenceOnlineEvent = { userId };
    this.fastify.io.emit(PRESENCE_EVENTS.ONLINE, event);
  }

  private broadcastOffline(userId: string, lastSeen: string) {
    const event: PresenceOfflineEvent = { userId, lastSeen };
    this.fastify.io.emit(PRESENCE_EVENTS.OFFLINE, event);
  }
}
