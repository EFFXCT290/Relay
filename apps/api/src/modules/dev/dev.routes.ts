import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { notify } from "../notifications/notification.service.js";

// Dev-only routes — registered conditionally in server.ts when NODE_ENV is
// not "production". Used to exercise WS flows during development without
// having to drive them via the real capture-report pipeline.
const devRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.post(
    "/dev/notifications/test",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: Type.Object({
          variant: Type.Union([
            Type.Literal("capture"),
            Type.Literal("view"),
            Type.Literal("expired"),
            Type.Literal("message"),
          ]),
          fromUsername: Type.Optional(Type.String()),
        }),
      },
    },
    async (request, reply) => {
      const userId = request.userId!;
      const { variant, fromUsername } = request.body;

      // Pick a real partner (anyone other than the caller). Falls back to a
      // synthetic "ghost" so the endpoint works even on a single-user instance.
      const partner = fromUsername
        ? await fastify.prisma.user.findUnique({ where: { username: fromUsername } })
        : await fastify.prisma.user.findFirst({ where: { id: { not: userId } } });
      const partnerRef = partner
        ? { userId: partner.id, username: partner.username }
        : { userId: "00000000-0000-0000-0000-000000000000", username: "ghost" };

      switch (variant) {
        case "capture":
          await notify(fastify, userId, "SYSTEM_ALERT", {
            capturedBy: partnerRef,
            eventType: "SCREENSHOT_ATTEMPT",
            trigger: "visibilitychange burst",
            timestamp: new Date().toISOString(),
            userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) Safari/605.1.15",
            platform: "macOS",
          });
          break;
        case "message":
          await notify(fastify, userId, "MESSAGE_RECEIVED", {
            from: partnerRef,
            preview: "ping — testing live notifications",
            messageId: "00000000-0000-0000-0000-000000000aa4",
          });
          break;
      }
      return reply.code(202).send({ ok: true });
    },
  );
};

export default devRoutes;
