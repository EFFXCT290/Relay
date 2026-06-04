import { Prisma, type PrismaClient, type PushSubscription } from "@prisma/client";

// Shape the browser hands us (and exactly what web-push consumes). Stored raw in
// the `subscription` Json column so we're forward-compatible with providers that
// add fields; `endpoint` is denormalized out for dedup + indexing.
export type WebPushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  [k: string]: unknown;
};

export type PushPreferences = { pushMessages: boolean; pushCalls: boolean };

// Only file in the push module that touches Prisma. Takes a PrismaClient (not a
// FastifyInstance) so both HTTP routes (fastify.prisma) and the BullMQ worker
// (which has a bare prisma) can share it.
export class PushRepository {
  constructor(private prisma: PrismaClient) {}

  // Upsert on the unique endpoint: re-subscribing the same device refreshes its
  // keys + owner and bumps lastUsedAt rather than inserting a duplicate row.
  upsert(userId: string, sub: WebPushSubscription, userAgent: string | null): Promise<PushSubscription> {
    const now = new Date();
    const subscription = sub as unknown as Prisma.InputJsonValue;
    return this.prisma.pushSubscription.upsert({
      where:  { endpoint: sub.endpoint },
      create: { userId, endpoint: sub.endpoint, subscription, userAgent, lastUsedAt: now },
      update: { userId, subscription, userAgent, lastUsedAt: now },
    });
  }

  listForUser(userId: string): Promise<PushSubscription[]> {
    return this.prisma.pushSubscription.findMany({ where: { userId } });
  }

  deleteByEndpoint(userId: string, endpoint: string): Promise<Prisma.BatchPayload> {
    return this.prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
  }

  // Reactive prune: ids that returned 404/410 from the push service are dead.
  deleteByIds(ids: string[]): Promise<Prisma.BatchPayload> {
    return this.prisma.pushSubscription.deleteMany({ where: { id: { in: ids } } });
  }

  // Bump lastUsedAt for subscriptions that just took a successful send.
  touch(ids: string[]): Promise<Prisma.BatchPayload> {
    return this.prisma.pushSubscription.updateMany({ where: { id: { in: ids } }, data: { lastUsedAt: new Date() } });
  }

  // Backstop sweep only — 404/410 pruning is the real cleanup. The window is
  // generous (180d) and lastUsedAt is bumped on (re)subscribe too, so a valid
  // device that simply never received a push isn't aged out.
  pruneStale(olderThanMs: number): Promise<Prisma.BatchPayload> {
    const cutoff = new Date(Date.now() - olderThanMs);
    return this.prisma.pushSubscription.deleteMany({ where: { lastUsedAt: { lt: cutoff } } });
  }

  async getPreferences(userId: string): Promise<PushPreferences | null> {
    return this.prisma.user.findUnique({
      where:  { id: userId },
      select: { pushMessages: true, pushCalls: true },
    });
  }

  async setPreferences(userId: string, prefs: Partial<PushPreferences>): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: prefs });
  }
}
