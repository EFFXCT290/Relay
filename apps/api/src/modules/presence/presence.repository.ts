import type { FastifyInstance } from "fastify";
import { PRESENCE_HEARTBEAT_TTL_S } from "@relay/contracts";

// Two keys per user — intentionally split:
//
//   presence:heartbeat:{userId}  →  "1"  EX PRESENCE_HEARTBEAT_TTL_S
//     Ephemeral. EXISTS → online. Refreshed by every presence:ping and on
//     connect. Expires automatically when pings stop (disconnect / crash).
//
//   presence:user:{userId}  →  { lastSeen: ISO }  EX 7d
//     Persistent. Written only when the user is confirmed offline (after grace
//     window). Never overwritten on connect/reconnect — that would corrupt the
//     "last seen" text on a tab reload.

export class PresenceRepository {
  constructor(private fastify: FastifyInstance) {}

  private heartbeatKey(userId: string) { return `presence:heartbeat:${userId}`; }
  private userKey(userId: string)      { return `presence:user:${userId}`; }

  async setHeartbeat(userId: string): Promise<void> {
    await this.fastify.redis.set(this.heartbeatKey(userId), "1", "EX", PRESENCE_HEARTBEAT_TTL_S);
  }

  async heartbeatExists(userId: string): Promise<boolean> {
    return (await this.fastify.redis.exists(this.heartbeatKey(userId))) === 1;
  }

  async setLastSeen(userId: string, lastSeen: string): Promise<void> {
    const payload = JSON.stringify({ lastSeen });
    await this.fastify.redis.set(this.userKey(userId), payload, "EX", 7 * 24 * 3600);
  }

  async getLastSeen(userId: string): Promise<string | null> {
    const raw = await this.fastify.redis.get(this.userKey(userId));
    if (!raw) return null;
    return (JSON.parse(raw) as { lastSeen: string }).lastSeen;
  }
}
