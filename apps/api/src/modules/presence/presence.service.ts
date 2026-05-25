import type { FastifyInstance } from "fastify";
import {
  PRESENCE_EVENTS,
  PRESENCE_GRACE_MS,
  type PresenceOfflineEvent,
  type PresenceOnlineEvent,
} from "@relay/contracts";
import { PresenceRepository } from "./presence.repository.js";

// ─────────────────────────────────────────────────────────────────────────────
// SAFEGUARD 9 — presence is a UI signal, NOT system truth.
//
// Presence model:
//   isOnline  = Redis heartbeat key exists (refreshed by client pings)
//   lastSeen  = timestamp of last confirmed offline (written only on transition)
//
// Timer model:
//   One pending offline check per userId maximum (offlineTimers map below).
//   markOnline cancels the timer immediately on reconnect — explicit cancellation
//   is cheaper and safer than relying solely on the heartbeat re-check race.
//   scheduleOffline replaces any existing timer, so rapid disconnect/reconnect
//   cycles and multi-tab scenarios never stack multiple timers.
// ─────────────────────────────────────────────────────────────────────────────

// Module-level — survives across service instances (new instance per socket).
// One slot per userId: creating a new timer always evicts the old one.
const offlineTimers = new Map<string, NodeJS.Timeout>();

export class PresenceService {
  private repo: PresenceRepository;

  constructor(private fastify: FastifyInstance) {
    this.repo = new PresenceRepository(fastify);
  }

  // Called on socket connect. Cancels any pending offline timer first —
  // explicit cancellation prevents the race where the timer fires during
  // the async heartbeatExists call inside checkAndMarkOffline. Only
  // broadcasts presence:online on the absent → present transition.
  async markOnline(userId: string): Promise<void> {
    const pending = offlineTimers.get(userId);
    if (pending) {
      clearTimeout(pending);
      offlineTimers.delete(userId);
      this.fastify.log.debug({ userId, timerMapSize: offlineTimers.size }, "presence: offline timer canceled (reconnect)");
    }

    const wasOnline = await this.repo.heartbeatExists(userId);
    await this.repo.setHeartbeat(userId);
    if (!wasOnline) {
      this.fastify.log.debug({ userId }, "presence: online transition");
      this.broadcastOnline(userId);
    }
  }

  // Called on presence:ping. Silently refreshes heartbeat TTL — no broadcast.
  async pulse(userId: string): Promise<void> {
    await this.repo.setHeartbeat(userId);
  }

  // Schedules the offline check after PRESENCE_GRACE_MS. Always replaces the
  // existing timer so only one can be pending per userId at a time.
  scheduleOffline(userId: string): void {
    const existing = offlineTimers.get(userId);
    if (existing) {
      clearTimeout(existing);
      this.fastify.log.debug({ userId }, "presence: offline timer replaced");
    }

    const timer = setTimeout(() => {
      offlineTimers.delete(userId);
      void this.checkAndMarkOffline(userId);
    }, PRESENCE_GRACE_MS);

    // Don't hold the process open for pending grace timers during shutdown.
    timer.unref?.();
    offlineTimers.set(userId, timer);
    this.fastify.log.debug({ userId, graceMs: PRESENCE_GRACE_MS, timerMapSize: offlineTimers.size }, "presence: offline timer started");
  }

  // Double-checks heartbeat before writing. Guards the narrow race where
  // markOnline couldn't cancel the timer (already fired) but DID refresh
  // the heartbeat before this async check completes.
  async checkAndMarkOffline(userId: string): Promise<void> {
    if (await this.repo.heartbeatExists(userId)) {
      this.fastify.log.debug({ userId }, "presence: offline check skipped (heartbeat alive after grace)");
      return;
    }
    const lastSeen = new Date().toISOString();
    await this.repo.setLastSeen(userId, lastSeen);
    this.fastify.log.debug({ userId, lastSeen }, "presence: offline confirmed, lastSeen written");
    this.broadcastOffline(userId, lastSeen);
  }

  async getFor(userId: string): Promise<{ isOnline: boolean; lastSeen: string | null }> {
    const [isOnline, lastSeen] = await Promise.all([
      this.repo.heartbeatExists(userId),
      this.repo.getLastSeen(userId),
    ]);
    return { isOnline, lastSeen };
  }

  async getMany(userIds: string[]): Promise<Array<{ userId: string; isOnline: boolean; lastSeen: string | null }>> {
    return Promise.all(userIds.map(async (userId) => {
      const [isOnline, lastSeen] = await Promise.all([
        this.repo.heartbeatExists(userId),
        this.repo.getLastSeen(userId),
      ]);
      return { userId, isOnline, lastSeen };
    }));
  }

  // ── Broadcast helpers ──────────────────────────────────────────────────────
  private broadcastOnline(userId: string) {
    const event: PresenceOnlineEvent = { userId };
    this.fastify.io.emit(PRESENCE_EVENTS.ONLINE, event);
    this.fastify.log.debug({ userId }, "presence: presence:online emitted");
  }

  private broadcastOffline(userId: string, lastSeen: string) {
    const event: PresenceOfflineEvent = { userId, lastSeen };
    this.fastify.io.emit(PRESENCE_EVENTS.OFFLINE, event);
    this.fastify.log.debug({ userId, lastSeen }, "presence: presence:offline emitted");
  }
}
