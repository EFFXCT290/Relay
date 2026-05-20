import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { ProblemError } from "../../backend-core/http/errors.js";

const PublicUserSchema = Type.Object({
  userId: Type.String({ format: "uuid" }),
  username: Type.String(),
});

const userRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  // ── GET /api/users/search?q=...&limit=... ─────────────────────────────────
  fastify.get(
    "/users/search",
    {
      preHandler: [fastify.authenticate],
      schema: {
        querystring: Type.Object({
          q: Type.String({ minLength: 2, maxLength: 30 }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
        }),
        response: { 200: Type.Object({ users: Type.Array(PublicUserSchema) }) },
      },
    },
    async (request) => {
      const { q, limit = 20 } = request.query;
      const users = await fastify.prisma.user.findMany({
        where: {
          username: { startsWith: q, mode: "insensitive" },
          NOT: { id: request.userId },
        },
        select: { id: true, username: true },
        take: limit,
        orderBy: { username: "asc" },
      });
      return { users: users.map((u) => ({ userId: u.id, username: u.username })) };
    },
  );

  // ── GET /api/users/:userId ────────────────────────────────────────────────
  fastify.get(
    "/users/:userId",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: Type.Object({ userId: Type.String({ format: "uuid" }) }),
        response: {
          200: Type.Object({
            userId: Type.String({ format: "uuid" }),
            username: Type.String(),
            createdAt: Type.String({ format: "date-time" }),
          }),
        },
      },
    },
    async (request) => {
      const user = await fastify.prisma.user.findUnique({
        where: { id: request.params.userId },
        select: { id: true, username: true, createdAt: true },
      });
      if (!user) throw new ProblemError("not_found", "User not found.");
      return {
        userId: user.id,
        username: user.username,
        createdAt: user.createdAt.toISOString(),
      };
    },
  );
};

export default userRoutes;
