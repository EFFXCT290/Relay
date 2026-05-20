import type { FastifyInstance } from "fastify";

// Presence state lives in Redis (volatile, cheap to query/expire) — NOT
// Postgres. Keys: `presence:user:{userId}` → { isOnline, lastSeen }.
// Two-minute TTL on the online state handles dead connections without
// requiring an explicit disconnect event. Only file in the module that
// touches Redis directly.

export class PresenceRepository {
  constructor(private fastify: FastifyInstance) {}

  private key(userId: string) {
    return `presence:user:${userId}`;
  }

  async setOnline(userId: string): Promise<void> {
    const payload = JSON.stringify({ isOnline: true, lastSeen: new Date().toISOString() });
    await this.fastify.redis.set(this.key(userId), payload, "EX", 120);
  }

  async setOffline(userId: string): Promise<void> {
    const payload = JSON.stringify({ isOnline: false, lastSeen: new Date().toISOString() });
    // Keep the offline state around so "last seen" survives a brief reconnect;
    // expire after a week.
    await this.fastify.redis.set(this.key(userId), payload, "EX", 7 * 24 * 3600);
  }

  async get(userId: string): Promise<{ isOnline: boolean; lastSeen: string | null } | null> {
    const raw = await this.fastify.redis.get(this.key(userId));
    return raw ? JSON.parse(raw) : null;
  }
}
