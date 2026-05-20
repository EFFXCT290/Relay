import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { Server as IOServer } from "socket.io";

// System-level Fastify augmentation ONLY. Anything that crosses the api ↔ web
// boundary belongs in @relay/contracts — not here. See Safeguard 1.
declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
    redis: Redis;
    io: IOServer;
    authenticate: (request: FastifyRequest) => Promise<void>;
  }

  interface FastifyRequest {
    userId?: string;
    accessJti?: string;
  }
}
