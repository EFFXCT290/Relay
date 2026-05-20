import fp from "fastify-plugin";
import { Redis } from "ioredis";
import { env } from "../backend-core/runtime/env.js";

export default fp(async (fastify) => {
  const redis = new Redis(env.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
  });

  redis.on("error", (err) => fastify.log.error({ err }, "redis error"));

  fastify.decorate("redis", redis);

  fastify.addHook("onClose", async () => {
    redis.disconnect();
  });
});
