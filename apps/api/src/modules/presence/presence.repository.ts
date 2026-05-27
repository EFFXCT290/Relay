import type { FastifyInstance } from "fastify";
import { PRESENCE_HEARTBEAT_TTL_S, PRESENCE_LASTSEEN_DB_THROTTLE_S } from "@relay/contracts";

// Presence is split across two stores by lifetime (see SAFEGUARD 9):
//
//   EPHEMERAL — Redis  presence:heartbeat:{userId}  →  <last-ping unix-ms>  EX TTL
//     Existence ⇒ "online". Refreshed on connect and every presence:ping; expires
//     by itself when pings stop (disconnect / crash). The value is the last-ping
//     timestamp — self-describing in MONITOR, room for future precise last-seen.
//
//   DURABLE — Postgres  UserPresence.lastSeenAt
//     The source of truth for "last seen". Written ONLY by this layer, with an
//     explicit timestamp (the model dropped @updatedAt). Survives Redis flushes.
//
//   THROTTLE — Redis  presence:lastseen:throttle:{userId}  →  "1"  EX window  (NX)
//     A gate so steady-state 10s pings don't write Postgres every tick:
//     claimLastSeenWrite() returns true at most once per window per user.

export class PresenceRepository {
  constructor(private fastify: FastifyInstance) {}

  private heartbeatKey(userId: string) { return `presence:heartbeat:${userId}`; }
  private throttleKey(userId: string)  { return `presence:lastseen:throttle:${userId}`; }

  // ── Ephemeral online signal (Redis) ─────────────────────────────────────────
  async setHeartbeat(userId: string): Promise<void> {
    await this.fastify.redis.set(this.heartbeatKey(userId), Date.now().toString(), "EX", PRESENCE_HEARTBEAT_TTL_S);
  }

  async heartbeatExists(userId: string): Promise<boolean> {
    return (await this.fastify.redis.exists(this.heartbeatKey(userId))) === 1;
  }

  // Batched existence check — one pipelined round-trip for a list of users.
  async heartbeatExistsMany(userIds: string[]): Promise<boolean[]> {
    if (userIds.length === 0) return [];
    const pipeline = this.fastify.redis.pipeline();
    for (const id of userIds) pipeline.exists(this.heartbeatKey(id));
    const results = await pipeline.exec();
    return userIds.map((_, i) => Number(results?.[i]?.[1]) === 1);
  }

  // ── Durable last-seen (Postgres) ─────────────────────────────────────────────
  // Explicit lastSeenAt — this service is the SOLE writer (no @updatedAt). Returns
  // the timestamp written so callers can broadcast it without a re-read.
  async touchPresence(userId: string, isOnline: boolean): Promise<Date> {
    const now = new Date();
    await this.fastify.prisma.userPresence.upsert({
      where:  { userId },
      create: { userId, lastSeenAt: now, isOnline },
      update: { lastSeenAt: now, isOnline },
    });
    return now;
  }

  async getLastSeen(userId: string): Promise<string | null> {
    const row = await this.fastify.prisma.userPresence.findUnique({
      where:  { userId },
      select: { lastSeenAt: true },
    });
    return row ? row.lastSeenAt.toISOString() : null;
  }

  async getLastSeenMany(userIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (userIds.length === 0) return map;
    const rows = await this.fastify.prisma.userPresence.findMany({
      where:  { userId: { in: userIds } },
      select: { userId: true, lastSeenAt: true },
    });
    for (const r of rows) map.set(r.userId, r.lastSeenAt.toISOString());
    return map;
  }

  // ── DB-write throttle gate (Redis) ───────────────────────────────────────────
  // SET NX EX — true at most once per window per user. Caller does the durable
  // write only when this returns true.
  async claimLastSeenWrite(userId: string): Promise<boolean> {
    const res = await this.fastify.redis.set(this.throttleKey(userId), "1", "EX", PRESENCE_LASTSEEN_DB_THROTTLE_S, "NX");
    return res === "OK";
  }
}
