import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { CallHistoryResponseSchema } from "@relay/contracts";
import { CallRepository } from "./calls.repository.js";

// Durable call history for the authenticated user. Runtime/live state is not
// exposed here — this is the persisted record only (see calls.repository.ts).
const callRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get(
    "/calls",
    {
      preHandler: [fastify.authenticate],
      schema: { response: { 200: CallHistoryResponseSchema } },
    },
    async (request) => {
      const userId = request.userId!;
      const calls = await new CallRepository(fastify).listForUser(userId);
      return { calls };
    },
  );
};

export default callRoutes;
