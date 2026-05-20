import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { ProblemError } from "../../backend-core/http/errors.js";

const NotificationSchema = Type.Object({
  notificationId: Type.String({ format: "uuid" }),
  type: Type.String(),
  isRead: Type.Boolean(),
  payload: Type.Unknown(),
  createdAt: Type.String({ format: "date-time" }),
});

const notificationRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  // ── GET /api/notifications ────────────────────────────────────────────────
  fastify.get(
    "/notifications",
    {
      preHandler: [fastify.authenticate],
      schema: {
        querystring: Type.Object({
          cursor: Type.Optional(Type.String({ format: "uuid" })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })),
          unreadOnly: Type.Optional(Type.Boolean({ default: false })),
        }),
        response: {
          200: Type.Object({
            notifications: Type.Array(NotificationSchema),
            unreadCount: Type.Integer(),
            nextCursor: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
          }),
        },
      },
    },
    async (request) => {
      const userId = request.userId!;
      const { cursor, limit = 30, unreadOnly = false } = request.query;

      const where = { userId, ...(unreadOnly ? { isRead: false } : {}) };

      const [rows, unreadCount] = await Promise.all([
        fastify.prisma.notification.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
        fastify.prisma.notification.count({ where: { userId, isRead: false } }),
      ]);

      const hasMore = rows.length > limit;
      const slice = hasMore ? rows.slice(0, -1) : rows;
      const nextCursor = hasMore ? slice[slice.length - 1]?.id ?? null : null;

      return {
        notifications: slice.map((n) => ({
          notificationId: n.id,
          type: n.type,
          isRead: n.isRead,
          payload: n.payload,
          createdAt: n.createdAt.toISOString(),
        })),
        unreadCount,
        nextCursor,
      };
    },
  );

  // ── PATCH /api/notifications/:notificationId/read ─────────────────────────
  fastify.patch(
    "/notifications/:notificationId/read",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: Type.Object({ notificationId: Type.String({ format: "uuid" }) }),
      },
    },
    async (request, reply) => {
      const userId = request.userId!;
      const { notificationId } = request.params;

      const n = await fastify.prisma.notification.findUnique({ where: { id: notificationId } });
      if (!n) throw new ProblemError("not_found", "Notification not found.");
      if (n.userId !== userId) throw new ProblemError("forbidden", "Not yours.");

      if (!n.isRead) {
        await fastify.prisma.notification.update({
          where: { id: notificationId },
          data: { isRead: true },
        });
      }
      return reply.code(204).send();
    },
  );

  // ── PATCH /api/notifications/read-all ─────────────────────────────────────
  fastify.patch(
    "/notifications/read-all",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      await fastify.prisma.notification.updateMany({
        where: { userId: request.userId!, isRead: false },
        data: { isRead: true },
      });
      return reply.code(204).send();
    },
  );
};

export default notificationRoutes;
