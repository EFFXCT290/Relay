import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { ProblemError } from "../../backend-core/http/errors.js";
import { ReplayRequestSchema } from "@relay/contracts";
import { SyncRepository } from "./sync.repository.js";
import { SyncService } from "./sync.service.js";

// ─────────────────────────────────────────────────────────────────────────────
// HTTP fallback for replay. The primary path is the socket REPLAY_REQUEST
// (see sync.socket.ts) — this HTTP variant exists for:
//   - cold-start (no socket yet)
//   - testing / debugging
//   - non-realtime clients (e.g. future mobile background fetch)
// ─────────────────────────────────────────────────────────────────────────────

const syncRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const service = new SyncService(new SyncRepository(app.prisma));

  app.post(
    "/sync/replay",
    {
      preHandler: [app.authenticate],
      schema: {
        body: ReplayRequestSchema,
        response: {
          200: Type.Object({
            events:     Type.Array(Type.Any()),
            nextCursor: Type.Union([Type.String(), Type.Null()]),
          }),
        },
      },
    },
    async (req) => {
      const userId = req.userId!;
      try {
        return await service.replayFor(userId, req.body.since, req.body.limit);
      } catch (err) {
        throw new ProblemError(
          "bad_request",
          err instanceof Error ? err.message : "Replay failed",
        );
      }
    },
  );
};

export default syncRoutes;
