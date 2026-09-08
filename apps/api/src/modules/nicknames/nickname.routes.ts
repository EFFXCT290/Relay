import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { NicknameInfoSchema, SetNicknamePayloadSchema } from "@relay/contracts";
import { ProblemError } from "../../backend-core/http/errors.js";
import { NicknameService } from "./nickname.service.js";

const nicknameRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const service = new NicknameService(fastify);

  // ── GET /api/users/:userId/nickname ───────────────────────────────────────
  // Self-only view of MY nickname for :userId — never another viewer's. There
  // is deliberately no "get their nickname for me" route: that value only
  // ever rides along on conversation responses (sharedNicknameForMe), gated
  // by sharedWithTarget, never fetched standalone.
  fastify.get(
    "/users/:userId/nickname",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params:   Type.Object({ userId: Type.String({ format: "uuid" }) }),
        response: { 200: NicknameInfoSchema },
      },
    },
    async (request) => service.getMyNicknameFor(request.userId!, request.params.userId),
  );

  // ── PUT /api/users/:userId/nickname ───────────────────────────────────────
  fastify.put(
    "/users/:userId/nickname",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params:   Type.Object({ userId: Type.String({ format: "uuid" }) }),
        body:     SetNicknamePayloadSchema,
        response: { 200: NicknameInfoSchema },
      },
    },
    async (request) => {
      const callerId = request.userId!;
      const { userId: targetUserId } = request.params;
      if (targetUserId === callerId) {
        throw new ProblemError("bad_request", "Cannot set a nickname for yourself.");
      }
      const target = await fastify.prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
      if (!target) throw new ProblemError("not_found", "User not found.");

      return service.setNickname(callerId, targetUserId, request.body.nickname, request.body.sharedWithTarget);
    },
  );

  // ── DELETE /api/users/:userId/nickname ────────────────────────────────────
  fastify.delete(
    "/users/:userId/nickname",
    {
      preHandler: [fastify.authenticate],
      schema: { params: Type.Object({ userId: Type.String({ format: "uuid" }) }) },
    },
    async (request, reply) => {
      await service.clearNickname(request.userId!, request.params.userId);
      return reply.code(204).send();
    },
  );
};

export default nicknameRoutes;
