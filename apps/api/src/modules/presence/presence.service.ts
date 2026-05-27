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
//   lastSeen  = UserPresence.lastSeenAt in Postgres — written by THIS service on
//               heartbeats (throttled) and flushed on the offline transition.
//               Durable (survives Redis flush); this service is the sole writer.
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
    await this.repo.touchPresence(userId, true); // durable lastSeen + ensure row exists
    if (!wasOnline) {
      this.fastify.log.debug({ userId }, "presence: online transition");
      this.broadcastOnline(userId);
    }
  }

  // Called on presence:ping. Refreshes heartbeat TTL (no broadcast) and writes the
  // durable lastSeen — throttled so steady-state pings touch Postgres ≤1×/window.
  async pulse(userId: string): Promise<void> {
    await this.repo.setHeartbeat(userId);
    if (await this.repo.claimLastSeenWrite(userId)) {
      await this.repo.touchPresence(userId, true);
    }
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

  // Double-checks heartbeat before writing. A live heartbeat here means one of
  // two things, indistinguishable from the key alone: (a) the user genuinely
  // reconnected and markOnline refreshed it, or (b) the grace window elapsed
  // before the heartbeat's TTL did. Rather than give up (which stranded the
  // user "online" with a stale lastSeen — the ~30% disconnect bug), we RE-ARM.
  // If the user is truly back, markOnline cancels the timer; if they're gone,
  // the heartbeat expires and a later check writes lastSeen. Correct regardless
  // of the GRACE_MS / HEARTBEAT_TTL_S relationship. See SAFEGUARD 9.
  async checkAndMarkOffline(userId: string): Promise<void> {
    if (await this.repo.heartbeatExists(userId)) {
      this.fastify.log.debug({ userId }, "presence: heartbeat alive after grace — re-arming offline check");
      this.scheduleOffline(userId);
      return;
    }
    // Durable flush — sole writer of lastSeenAt. touchPresence returns the
    // timestamp it wrote, so we broadcast it without a re-read.
    const lastSeen = (await this.repo.touchPresence(userId, false)).toISOString();
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

  // Online from Redis (one pipelined round-trip); lastSeen from Postgres (one
  // batched query). No per-user N+1.
  async getMany(userIds: string[]): Promise<Array<{ userId: string; isOnline: boolean; lastSeen: string | null }>> {
    const [onlineFlags, lastSeenMap] = await Promise.all([
      this.repo.heartbeatExistsMany(userIds),
      this.repo.getLastSeenMany(userIds),
    ]);
    return userIds.map((userId, i) => ({
      userId,
      isOnline: onlineFlags[i] ?? false,
      lastSeen: lastSeenMap.get(userId) ?? null,
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
