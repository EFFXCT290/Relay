import type { FastifyPluginAsync } from "fastify";

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/health", async (_request, reply) => {
    const checks: Record<string, "ok" | "fail"> = { server: "ok" };

    try {
      await fastify.prisma.$queryRaw`SELECT 1`;
      checks.database = "ok";
    } catch {
      checks.database = "fail";
    }

    try {
      await fastify.redis.ping();
      checks.redis = "ok";
    } catch {
      checks.redis = "fail";
    }

    const allOk = Object.values(checks).every((v) => v === "ok");
    // Nothing internal currently polls this route expecting an unconditional
    // 200 (no docker-compose healthcheck, no CI step, no frontend caller) —
    // a degraded dependency should read as a real failure, not a 200 the
    // caller has to parse the body to distinguish from healthy.
    reply.code(allOk ? 200 : 503);
    return { status: allOk ? "ok" : "degraded", checks, timestamp: new Date().toISOString() };
  });
};

export default healthRoutes;
