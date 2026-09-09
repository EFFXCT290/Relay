import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { ProblemError } from "../../backend-core/http/errors.js";
import { MESSAGE_EVENTS, SpotifyConversationSummarySchema, type SpotifyConversationSummary } from "@relay/contracts";
import {
  emitConversationAccepted,
  emitConversationDeleted,
  emitConversationRequest,
} from "./conversation.socket.js";
import { PresenceService } from "../presence/presence.service.js";
import { SpotifyService } from "../spotify/spotify.service.js";
import { NicknameService } from "../nicknames/nickname.service.js";

const ParticipantSchema = Type.Object({
  userId:     Type.String({ format: "uuid" }),
  username:   Type.String(),
  avatarUrl:  Type.Optional(Type.Union([Type.String(), Type.Null()])),
  isOnline:   Type.Optional(Type.Boolean()),
  lastSeenAt: Type.Optional(Type.Union([Type.String({ format: "date-time" }), Type.Null()])),
  // The CALLER's own private nickname for this participant — see
  // ConversationParticipantSchema in @relay/contracts for the full contract.
  nickname:   Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

// A disappearing message's text must never leak through the conversation
// list's passive preview — a list row isn't an explicit "open" and
// shouldn't get to reveal content for free (mirrors message.routes.ts's
// notifyBody redaction for push/Discord, and visibleBody()'s own-read
// gating for the message list itself). Mode-specific:
//   - VIEWS: redacted for the message's entire life. There's no partial
//     reveal — visibleBody() already treats VIEWS as permanently withheld
//     from every normal read ("every read spends a look"), and a list
//     preview is exactly the kind of read that must never spend one.
//   - TIME: redacted only until the recipient's first explicit open
//     (firstOpenedAt null) — once opened, normal preview rules resume,
//     mirroring visibleBody()'s identical rule for the message list.
function isRedactedDisappearing(disappear: { mode: "VIEWS" | "TIME"; firstOpenedAt: Date | null } | null): boolean {
  if (!disappear) return false;
  if (disappear.mode === "VIEWS") return true;
  return disappear.firstOpenedAt === null;
}

function lastMessagePreview(
  last: { body: string | null; senderId: string; sender: { username: string }; disappear: { mode: "VIEWS" | "TIME"; firstOpenedAt: Date | null } | null },
  myNicknames: Map<string, string>,
): string | null {
  if (isRedactedDisappearing(last.disappear)) {
    const displayName = myNicknames.get(last.senderId) ?? last.sender.username;
    return `${displayName} sent a disappearing message`;
  }
  return last.body ? last.body.slice(0, 80) : null;
}

// Batch-fetch presence for a set of userIds. Returns a Map so callers
// can attach isOnline/lastSeenAt to each participant in O(1).
async function presencesFor(
  fastify: import("fastify").FastifyInstance,
  userIds: string[],
): Promise<Map<string, { isOnline: boolean; lastSeen: string | null }>> {
  if (userIds.length === 0) return new Map();
  const results = await new PresenceService(fastify).getMany(userIds);
  return new Map(results.map((r) => [r.userId, r]));
}

// Batch "now playing" for the list. Each lookup goes through
// SpotifyService.getBadgeForUser() — the SAME method the standalone badge
// endpoint uses — which checks the 45s Redis cache FIRST and only calls
// Spotify's API on a genuine miss. Running it once per conversation here
// therefore still hits that one shared cache; it does not bypass it or stand
// up a second cache layer, and repeat views within the TTL cost a Redis GET
// per participant, not a Spotify API call. Lookups fan out via Promise.all,
// so N conversations cost one round trip's worth of latency, not N
// sequential ones. showOnProfile / 24h-hide / needsReconnect are already
// enforced inside getBadgeForUser — this only reshapes its result down to
// the slim {trackName, artistName, isPlaying} shape this list needs, it does
// not re-implement any of that logic.
async function spotifySummariesFor(
  fastify: import("fastify").FastifyInstance,
  userIds: string[],
): Promise<Map<string, SpotifyConversationSummary | null>> {
  if (userIds.length === 0) return new Map();
  const service = new SpotifyService(fastify.prisma, fastify.redis, fastify.log);
  const uniqueIds = [...new Set(userIds)];
  const entries = await Promise.all(
    uniqueIds.map(async (id): Promise<[string, SpotifyConversationSummary | null]> => {
      const badge = await service.getBadgeForUser(id);
      return [
        id,
        badge ? { trackName: badge.trackName, artistName: badge.artistName, isPlaying: badge.isPlaying } : null,
      ];
    }),
  );
  return new Map(entries);
}

// Batch "my nickname for each of these people" — same Promise.all-friendly
// Map-keyed-by-userId shape as spotifySummariesFor above, mirrored exactly per
// the same batching convention. Two SEPARATE lookups are needed per
// conversation, this being one direction (mine, for THEIR displayed name in
// my own view); sharedNicknamesForMe below is the other (theirs, for me).
async function myNicknamesFor(
  fastify: import("fastify").FastifyInstance,
  callerId: string,
  userIds: string[],
): Promise<Map<string, string>> {
  return new NicknameService(fastify).myNicknamesFor(callerId, userIds);
}

// Batch "who among these participants has SHARED a nickname with me" — the
// reverse direction, only ever consumed by the single-conversation detail
// route below (the "X calls you: Y" badge is thread-scoped, not a list-row
// feature).
async function sharedNicknamesForMe(
  fastify: import("fastify").FastifyInstance,
  callerId: string,
  ownerIds: string[],
): Promise<Map<string, string>> {
  return new NicknameService(fastify).sharedNicknamesForMe(callerId, ownerIds);
}

const ListItemSchema = Type.Object({
  conversationId: Type.String({ format: "uuid" }),
  participant: ParticipantSchema,
  lastMessage: Type.Union([
    Type.Null(),
    Type.Object({
      messageId: Type.String({ format: "uuid" }),
      type: Type.String(),
      preview: Type.Union([Type.String(), Type.Null()]),
      sentAt: Type.String({ format: "date-time" }),
    }),
  ]),
  unreadCount: Type.Integer({ minimum: 0 }),
  // Optional: only GET /conversations populates this (see spotifySummariesFor
  // below); GET /conversations/requests shares this same schema and simply
  // omits the field rather than paying for a lookup pending requests don't need.
  spotify: Type.Optional(Type.Union([SpotifyConversationSummarySchema, Type.Null()])),
  updatedAt: Type.String({ format: "date-time" }),
});

async function unreadCountsFor(
  fastify: import("fastify").FastifyInstance,
  callerId: string,
  conversationIds: string[],
): Promise<Map<string, number>> {
  if (conversationIds.length === 0) return new Map();
  const grouped = await fastify.prisma.message.groupBy({
    by: ["conversationId"],
    where: {
      conversationId: { in: conversationIds },
      senderId: { not: callerId },
      isDeleted: false,
      reads: { none: { readerId: callerId } },
    },
    _count: { _all: true },
  });
  return new Map(grouped.map((g) => [g.conversationId, g._count._all]));
}

const conversationRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  // ── POST /api/conversations ───────────────────────────────────────────────
  // Creates a 1:1 conversation as a "message request": the creator is
  // implicitly accepted, the recipient stays pending until they hit accept.
  // Returns the existing conversation if one already exists (idempotent).
  fastify.post(
    "/conversations",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: Type.Object({ participantId: Type.String({ format: "uuid" }) }),
        response: {
          200: Type.Object({
            conversationId: Type.String({ format: "uuid" }),
            participant: ParticipantSchema,
            createdAt: Type.String({ format: "date-time" }),
          }),
          201: Type.Object({
            conversationId: Type.String({ format: "uuid" }),
            participant: ParticipantSchema,
            createdAt: Type.String({ format: "date-time" }),
          }),
        },
      },
    },
    async (request, reply) => {
      const callerId = request.userId!;
      const { participantId } = request.body;

      if (participantId === callerId) {
        throw new ProblemError("bad_request", "Cannot start a conversation with yourself.");
      }

      const other = await fastify.prisma.user.findUnique({
        where: { id: participantId },
        select: { id: true, username: true, avatarKey: true },
      });
      if (!other) throw new ProblemError("not_found", "Participant not found.");
      const otherAvatarUrl = other.avatarKey ? await fastify.getMediaUrl(other.avatarKey) : null;
      // A nickname can already exist even before any conversation did (e.g.
      // set from a mutual-contacts surface elsewhere) — same batched lookup
      // as every other participant-bearing response, just a single-element
      // call here.
      const nickname = (await myNicknamesFor(fastify, callerId, [other.id])).get(other.id) ?? null;

      // Look for an existing 1:1 conversation that has *exactly* these two
      // participants (so future group conversations don't collide).
      const existing = await fastify.prisma.conversation.findFirst({
        where: {
          AND: [
            { participants: { some: { userId: callerId } } },
            { participants: { some: { userId: participantId } } },
          ],
          participants: { every: { userId: { in: [callerId, participantId] } } },
        },
        select: { id: true, createdAt: true, participants: { select: { userId: true } } },
      });

      if (existing && existing.participants.length === 2) {
        return reply.code(200).send({
          conversationId: existing.id,
          participant: { userId: other.id, username: other.username, avatarUrl: otherAvatarUrl, nickname },
          createdAt: existing.createdAt.toISOString(),
        });
      }

      const acceptedAt = new Date();
      const created = await fastify.prisma.conversation.create({
        data: {
          participants: {
            create: [
              { userId: callerId, acceptedAt },
              { userId: participantId },
            ],
          },
        },
      });

      // Live: tell the recipient a new request landed so their inbox updates.
      const fromMe = await fastify.prisma.user.findUnique({
        where: { id: callerId },
        select: { username: true },
      });
      emitConversationRequest(fastify.io, participantId, {
        conversationId: created.id,
        from: { userId: callerId, username: fromMe?.username ?? "" },
        createdAt: created.createdAt.toISOString(),
      });

      return reply.code(201).send({
        conversationId: created.id,
        participant: { userId: other.id, username: other.username, avatarUrl: otherAvatarUrl, nickname },
        createdAt: created.createdAt.toISOString(),
      });
    },
  );

  // ── GET /api/conversations ────────────────────────────────────────────────
  // Returns only conversations the caller has accepted (or initiated).
  fastify.get(
    "/conversations",
    {
      preHandler: [fastify.authenticate],
      schema: {
        querystring: Type.Object({
          cursor: Type.Optional(Type.String({ format: "uuid" })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
        }),
        response: {
          200: Type.Object({
            conversations: Type.Array(ListItemSchema),
            nextCursor: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
          }),
        },
      },
    },
    async (request) => {
      const callerId = request.userId!;
      const { cursor, limit = 20 } = request.query;

      const rows = await fastify.prisma.conversation.findMany({
        where: {
          participants: { some: { userId: callerId, acceptedAt: { not: null } } },
        },
        include: {
          participants: { include: { user: { select: { id: true, username: true, avatarKey: true } } } },
          messages: {
            where: { isDeleted: false },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              id: true, type: true, body: true, createdAt: true, senderId: true,
              sender:    { select: { username: true } },
              disappear: { select: { mode: true, firstOpenedAt: true } },
            },
          },
        },
        orderBy: { updatedAt: "desc" },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const slice = hasMore ? rows.slice(0, -1) : rows;
      const nextCursor = hasMore ? slice[slice.length - 1]?.id ?? null : null;

      const otherIds = slice.map((c) => {
        const other = c.participants.find((p) => p.userId !== callerId);
        return other?.userId ?? callerId;
      });

      const [unreadCounts, presences, spotifies, nicknames] = await Promise.all([
        unreadCountsFor(fastify, callerId, slice.map((c) => c.id)),
        presencesFor(fastify, otherIds),
        spotifySummariesFor(fastify, otherIds),
        myNicknamesFor(fastify, callerId, otherIds),
      ]);

      return {
        conversations: await Promise.all(slice.map(async (c) => {
          const other = c.participants.find((p) => p.userId !== callerId);
          const last  = c.messages[0];
          const p     = presences.get(other?.userId ?? callerId);
          const avatarUrl = other?.user.avatarKey ? await fastify.getMediaUrl(other.user.avatarKey) : null;
          return {
            conversationId: c.id,
            participant: other
              ? {
                  userId: other.user.id,
                  username: other.user.username,
                  avatarUrl,
                  isOnline: p?.isOnline,
                  lastSeenAt: p?.lastSeen ?? null,
                  nickname: nicknames.get(other.user.id) ?? null,
                }
              : { userId: callerId, username: "—" },
            lastMessage: last
              ? {
                  messageId: last.id,
                  type: last.type,
                  preview: lastMessagePreview(last, nicknames),
                  sentAt: last.createdAt.toISOString(),
                }
              : null,
            unreadCount: unreadCounts.get(c.id) ?? 0,
            spotify: spotifies.get(other?.userId ?? callerId) ?? null,
            updatedAt: c.updatedAt.toISOString(),
          };
        })),
        nextCursor,
      };
    },
  );

  // ── GET /api/conversations/requests ───────────────────────────────────────
  // Pending message requests — conversations the caller hasn't accepted.
  fastify.get(
    "/conversations/requests",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: Type.Object({
            requests: Type.Array(ListItemSchema),
          }),
        },
      },
    },
    async (request) => {
      const callerId = request.userId!;
      const rows = await fastify.prisma.conversation.findMany({
        where: {
          participants: { some: { userId: callerId, acceptedAt: null } },
        },
        include: {
          participants: { include: { user: { select: { id: true, username: true, avatarKey: true } } } },
          messages: {
            where: { isDeleted: false },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              id: true, type: true, body: true, createdAt: true, senderId: true,
              sender:    { select: { username: true } },
              disappear: { select: { mode: true, firstOpenedAt: true } },
            },
          },
        },
        orderBy: { updatedAt: "desc" },
      });

      const otherIds = rows.map((c) => {
        const other = c.participants.find((p) => p.userId !== callerId);
        return other?.userId ?? callerId;
      });

      const [unreadCounts, presences, nicknames] = await Promise.all([
        unreadCountsFor(fastify, callerId, rows.map((c) => c.id)),
        presencesFor(fastify, otherIds),
        myNicknamesFor(fastify, callerId, otherIds),
      ]);

      return {
        requests: await Promise.all(rows.map(async (c) => {
          const other = c.participants.find((p) => p.userId !== callerId);
          const last  = c.messages[0];
          const p     = presences.get(other?.userId ?? callerId);
          const avatarUrl = other?.user.avatarKey ? await fastify.getMediaUrl(other.user.avatarKey) : null;
          return {
            conversationId: c.id,
            participant: other
              ? {
                  userId: other.user.id,
                  username: other.user.username,
                  avatarUrl,
                  isOnline: p?.isOnline,
                  lastSeenAt: p?.lastSeen ?? null,
                  nickname: nicknames.get(other.user.id) ?? null,
                }
              : { userId: callerId, username: "—" },
            lastMessage: last
              ? {
                  messageId: last.id,
                  type: last.type,
                  preview: lastMessagePreview(last, nicknames),
                  sentAt: last.createdAt.toISOString(),
                }
              : null,
            unreadCount: unreadCounts.get(c.id) ?? 0,
            updatedAt: c.updatedAt.toISOString(),
          };
        })),
      };
    },
  );

  // ── GET /api/conversations/:conversationId ────────────────────────────────
  fastify.get(
    "/conversations/:conversationId",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: Type.Object({ conversationId: Type.String({ format: "uuid" }) }),
        response: {
          200: Type.Object({
            conversationId: Type.String({ format: "uuid" }),
            participant: ParticipantSchema,
            createdAt: Type.String({ format: "date-time" }),
            myAcceptedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
            // THEIR nickname for ME, only present at all once they've shared
            // it — the reverse direction from participant.nickname above.
            // Drives the "X calls you: Y" badge; never leaks to anyone but
            // the actual target (see conversation.routes.test.ts).
            sharedNicknameForMe: Type.Union([Type.String(), Type.Null()]),
          }),
        },
      },
    },
    async (request) => {
      const callerId = request.userId!;
      const conv = await fastify.prisma.conversation.findUnique({
        where: { id: request.params.conversationId },
        include: {
          participants: { include: { user: { select: { id: true, username: true, avatarKey: true } } } },
        },
      });
      if (!conv) throw new ProblemError("not_found", "Conversation not found.");

      const me = conv.participants.find((p) => p.userId === callerId);
      if (!me) throw new ProblemError("forbidden", "You are not a participant.");

      const other = conv.participants.find((p) => p.userId !== callerId) ?? conv.participants[0]!;
      const [presence, myNicknames, sharedNicknames] = await Promise.all([
        new PresenceService(fastify).getFor(other.user.id),
        myNicknamesFor(fastify, callerId, [other.user.id]),
        sharedNicknamesForMe(fastify, callerId, [other.user.id]),
      ]);
      return {
        conversationId: conv.id,
        participant: {
          userId:     other.user.id,
          username:   other.user.username,
          avatarUrl:  other.user.avatarKey ? await fastify.getMediaUrl(other.user.avatarKey) : null,
          isOnline:   presence.isOnline,
          lastSeenAt: presence.lastSeen ?? null,
          nickname:   myNicknames.get(other.user.id) ?? null,
        },
        createdAt: conv.createdAt.toISOString(),
        myAcceptedAt: me.acceptedAt ? me.acceptedAt.toISOString() : null,
        sharedNicknameForMe: sharedNicknames.get(other.user.id) ?? null,
      };
    },
  );

  // ── POST /api/conversations/:conversationId/accept ────────────────────────
  fastify.post(
    "/conversations/:conversationId/accept",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: Type.Object({ conversationId: Type.String({ format: "uuid" }) }),
        response: {
          200: Type.Object({
            conversationId: Type.String({ format: "uuid" }),
            acceptedAt: Type.String({ format: "date-time" }),
          }),
        },
      },
    },
    async (request) => {
      const callerId = request.userId!;
      const { conversationId } = request.params;

      const me = await fastify.prisma.participant.findUnique({
        where: { userId_conversationId: { userId: callerId, conversationId } },
        select: { userId: true, acceptedAt: true },
      });
      if (!me) throw new ProblemError("forbidden", "You are not a participant.");
      if (me.acceptedAt) {
        return { conversationId, acceptedAt: me.acceptedAt.toISOString() };
      }

      const acceptedAt = new Date();
      await fastify.prisma.participant.update({
        where: { userId_conversationId: { userId: callerId, conversationId } },
        data: { acceptedAt },
      });

      // Live: notify other participants so any "pending" badge clears.
      const others = await fastify.prisma.participant.findMany({
        where: { conversationId, userId: { not: callerId } },
        select: { userId: true },
      });
      for (const p of others) {
        emitConversationAccepted(fastify.io, p.userId, {
          conversationId,
          acceptedBy: callerId,
          acceptedAt: acceptedAt.toISOString(),
        });
      }

      return { conversationId, acceptedAt: acceptedAt.toISOString() };
    },
  );

  // ── DELETE /api/conversations/:conversationId ─────────────────────────────
  // For v1: only deletes pending requests (caller hasn't accepted yet).
  // Cascade removes the conversation for everyone; sender's inbox updates via
  // the conversation:deleted WS event.
  fastify.delete(
    "/conversations/:conversationId",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: Type.Object({ conversationId: Type.String({ format: "uuid" }) }),
      },
    },
    async (request, reply) => {
      const callerId = request.userId!;
      const { conversationId } = request.params;

      const me = await fastify.prisma.participant.findUnique({
        where: { userId_conversationId: { userId: callerId, conversationId } },
        select: { userId: true, acceptedAt: true },
      });
      if (!me) throw new ProblemError("forbidden", "You are not a participant.");
      if (me.acceptedAt) {
        throw new ProblemError(
          "validation_error",
          "Already accepted conversations can't be deleted yet.",
        );
      }

      const participants = await fastify.prisma.participant.findMany({
        where: { conversationId },
        select: { userId: true },
      });

      await fastify.prisma.conversation.delete({ where: { id: conversationId } });

      for (const p of participants) {
        emitConversationDeleted(fastify.io, p.userId, { conversationId });
      }

      return reply.code(204).send();
    },
  );

  // ── POST /api/conversations/:conversationId/read ──────────────────────────
  // Marks every unread message from the other participant as read for the
  // caller. Idempotent via `skipDuplicates` so rapid re-opens don't 500.
  // Notifies each unique sender so their receipts update live.
  fastify.post(
    "/conversations/:conversationId/read",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: Type.Object({ conversationId: Type.String({ format: "uuid" }) }),
      },
    },
    async (request, reply) => {
      const callerId = request.userId!;
      const { conversationId } = request.params;

      const member = await fastify.prisma.participant.findUnique({
        where: { userId_conversationId: { userId: callerId, conversationId } },
        select: { userId: true },
      });
      if (!member) throw new ProblemError("forbidden", "You are not a participant.");

      const unread = await fastify.prisma.message.findMany({
        where: {
          conversationId,
          senderId: { not: callerId },
          isDeleted: false,
          reads: { none: { readerId: callerId } },
        },
        select: { id: true, senderId: true, deliveredAt: true },
      });

      if (unread.length === 0) return reply.code(204).send();

      const readAt = new Date();
      // Reading implies delivery — backfill deliveredAt for any that came in
      // while the receiver was offline so senders see ✓✓ blue, not just sent.
      const undeliveredIds = unread.filter((m) => !m.deliveredAt).map((m) => m.id);
      if (undeliveredIds.length > 0) {
        await fastify.prisma.message.updateMany({
          where: { id: { in: undeliveredIds } },
          data: { deliveredAt: readAt },
        });
      }
      await fastify.prisma.messageRead.createMany({
        data: unread.map((m) => ({ messageId: m.id, readerId: callerId, readAt })),
        skipDuplicates: true,
      });

      // Group by sender — one ws event per unique recipient with their batch.
      const senderIds = [...new Set(unread.map((m) => m.senderId))];
      for (const senderId of senderIds) {
        const messageIds = unread.filter((m) => m.senderId === senderId).map((m) => m.id);
        fastify.log.info(
          { conversationId, senderId, readBy: callerId, count: messageIds.length },
          "emit message:read",
        );
        fastify.io.to(`user:${senderId}`).emit(MESSAGE_EVENTS.READ, {
          conversationId,
          readBy: callerId,
          messageIds,
          readAt: readAt.toISOString(),
          deliveredAt: readAt.toISOString(),
        });
      }

      return reply.code(204).send();
    },
  );
};

export default conversationRoutes;
