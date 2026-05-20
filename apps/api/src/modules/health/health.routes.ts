import type { FastifyPluginAsync } from "fastify";

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/health", async () => {
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
    return { status: allOk ? "ok" : "degraded", checks, timestamp: new Date().toISOString() };
  });
};

export default healthRoutes;
