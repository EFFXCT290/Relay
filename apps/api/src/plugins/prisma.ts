import fp from "fastify-plugin";
import { PrismaClient } from "@prisma/client";

export default fp(async (fastify) => {
  const prisma = new PrismaClient({
    log: fastify.log.level === "debug" ? ["query", "warn", "error"] : ["warn", "error"],
  });

  await prisma.$connect();
  fastify.decorate("prisma", prisma);

  fastify.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
});
