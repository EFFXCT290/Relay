import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { ProblemError } from "../../backend-core/http/errors.js";
import { AvatarResponseSchema } from "@relay/contracts";
import { putAvatar, clearAvatar, AvatarBadFormatError, AvatarTooLargeError } from "./avatar.service.js";
import { broadcastProfileUpdate } from "./user.socket.js";
import { connectedUserIds, isConnected } from "../conversations/connection.service.js";

const PublicUserSchema = Type.Object({
  userId: Type.String({ format: "uuid" }),
  username: Type.String(),
  avatarUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
      const callerId = request.userId!;
      const { q, limit = 20 } = request.query;
      const users = await fastify.prisma.user.findMany({
        where: {
          username: { startsWith: q, mode: "insensitive" },
          NOT: { id: callerId },
        },
        select: { id: true, username: true, avatarKey: true },
        take: limit,
        orderBy: { username: "asc" },
      });
      // A stranger's real avatar must never leave the server for a viewer
      // who isn't connected to them yet (accepted conversation on both
      // sides) — see connection.service.ts. Batched: one query for every
      // hit in this page, not N+1.
      const connected = await connectedUserIds(fastify, callerId, users.map((u) => u.id));
      const serialized = await Promise.all(
        users.map(async (u) => ({
          userId:    u.id,
          username:  u.username,
          avatarUrl: u.avatarKey && connected.has(u.id) ? await fastify.getMediaUrl(u.avatarKey) : null,
        })),
      );
      return { users: serialized };
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
            avatarUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            createdAt: Type.String({ format: "date-time" }),
          }),
        },
      },
    },
    async (request) => {
      const callerId = request.userId!;
      const user = await fastify.prisma.user.findUnique({
        where: { id: request.params.userId },
        select: { id: true, username: true, avatarKey: true, createdAt: true },
      });
      if (!user) throw new ProblemError("not_found", "User not found.");
      // Looking yourself up here is allowed and unaffected by this gate —
      // only an OTHER user's real avatar requires a connection check.
      const isSelf = user.id === callerId;
      const canSeeAvatar = isSelf || (await isConnected(fastify, callerId, user.id));
      return {
        userId: user.id,
        username: user.username,
        avatarUrl: user.avatarKey && canSeeAvatar ? await fastify.getMediaUrl(user.avatarKey) : null,
        createdAt: user.createdAt.toISOString(),
      };
    },
  );

  // ── POST /api/users/me/avatar ─────────────────────────────────────────────
  // Multipart upload of the caller's profile photo. The image is normalized to
  // a square 256×256 webp, stored under the caller's avatar key, and the old
  // object (if any) is removed. Returns a freshly-signed URL.
  fastify.post(
    "/users/me/avatar",
    {
      preHandler: [fastify.authenticate],
      schema: { response: { 200: AvatarResponseSchema } },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request) => {
      const userId = request.userId!;
      const data = await request.file();
      if (!data) throw new ProblemError("bad_request", "No file uploaded.");

      const buffer = await data.toBuffer();
      if (buffer.length === 0) throw new ProblemError("bad_request", "Empty file.");

      let key: string;
      try {
        key = await putAvatar({ userId, buffer, mimeType: data.mimetype, prisma: fastify.prisma, s3: fastify.s3, log: fastify.log });
      } catch (err) {
        if (err instanceof AvatarBadFormatError) throw new ProblemError("validation_error", err.message);
        if (err instanceof AvatarTooLargeError)  throw new ProblemError("validation_error", err.message);
        throw err;
      }

      const avatarUrl = await fastify.getMediaUrl(key);
      await broadcastProfileUpdate(fastify, userId, avatarUrl);
      return { avatarUrl };
    },
  );

  // ── DELETE /api/users/me/avatar ───────────────────────────────────────────
  fastify.delete(
    "/users/me/avatar",
    {
      preHandler: [fastify.authenticate],
      schema: { response: { 200: AvatarResponseSchema } },
    },
    async (request) => {
      const userId = request.userId!;
      await clearAvatar({ userId, prisma: fastify.prisma, s3: fastify.s3, log: fastify.log });
      await broadcastProfileUpdate(fastify, userId, null);
      return { avatarUrl: null };
    },
  );
};

export default userRoutes;
