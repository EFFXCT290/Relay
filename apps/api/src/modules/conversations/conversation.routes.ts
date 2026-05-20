import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { ProblemError } from "../../backend-core/http/errors.js";
import { MESSAGE_EVENTS } from "@relay/contracts";
import {
  emitConversationAccepted,
  emitConversationDeleted,
  emitConversationRequest,
} from "./conversation.socket.js";

const ParticipantSchema = Type.Object({
  userId: Type.String({ format: "uuid" }),
  username: Type.String(),
});

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
        select: { id: true, username: true },
      });
      if (!other) throw new ProblemError("not_found", "Participant not found.");

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
          participant: { userId: other.id, username: other.username },
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
        participant: { userId: other.id, username: other.username },
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
          participants: { include: { user: { select: { id: true, username: true } } } },
          messages: {
            where: { isDeleted: false },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true, type: true, body: true, createdAt: true },
          },
        },
        orderBy: { updatedAt: "desc" },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const slice = hasMore ? rows.slice(0, -1) : rows;
      const nextCursor = hasMore ? slice[slice.length - 1]?.id ?? null : null;

      const unreadCounts = await unreadCountsFor(
        fastify,
        callerId,
        slice.map((c) => c.id),
      );

      return {
        conversations: slice.map((c) => {
          const other = c.participants.find((p) => p.userId !== callerId);
          const last = c.messages[0];
          return {
            conversationId: c.id,
            participant: other
              ? { userId: other.user.id, username: other.user.username }
              : { userId: callerId, username: "—" },
            lastMessage: last
              ? {
                  messageId: last.id,
                  type: last.type,
                  preview: last.body ? last.body.slice(0, 80) : null,
                  sentAt: last.createdAt.toISOString(),
                }
              : null,
            unreadCount: unreadCounts.get(c.id) ?? 0,
            updatedAt: c.updatedAt.toISOString(),
          };
        }),
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
          participants: { include: { user: { select: { id: true, username: true } } } },
          messages: {
            where: { isDeleted: false },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true, type: true, body: true, createdAt: true },
          },
        },
        orderBy: { updatedAt: "desc" },
      });

      const unreadCounts = await unreadCountsFor(
        fastify,
        callerId,
        rows.map((c) => c.id),
      );

      return {
        requests: rows.map((c) => {
          const other = c.participants.find((p) => p.userId !== callerId);
          const last = c.messages[0];
          return {
            conversationId: c.id,
            participant: other
              ? { userId: other.user.id, username: other.user.username }
              : { userId: callerId, username: "—" },
            lastMessage: last
              ? {
                  messageId: last.id,
                  type: last.type,
                  preview: last.body ? last.body.slice(0, 80) : null,
                  sentAt: last.createdAt.toISOString(),
                }
              : null,
            unreadCount: unreadCounts.get(c.id) ?? 0,
            updatedAt: c.updatedAt.toISOString(),
          };
        }),
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
          }),
        },
      },
    },
    async (request) => {
      const callerId = request.userId!;
      const conv = await fastify.prisma.conversation.findUnique({
        where: { id: request.params.conversationId },
        include: {
          participants: { include: { user: { select: { id: true, username: true } } } },
        },
      });
      if (!conv) throw new ProblemError("not_found", "Conversation not found.");

      const me = conv.participants.find((p) => p.userId === callerId);
      if (!me) throw new ProblemError("forbidden", "You are not a participant.");

      const other = conv.participants.find((p) => p.userId !== callerId) ?? conv.participants[0]!;
      return {
        conversationId: conv.id,
        participant: { userId: other.user.id, username: other.user.username },
        createdAt: conv.createdAt.toISOString(),
        myAcceptedAt: me.acceptedAt ? me.acceptedAt.toISOString() : null,
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
