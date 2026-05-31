import "./backend-core/runtime/formats.js"; // side-effect: registers uuid/date-time/email TypeBox formats

import Fastify, { type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import {
  TypeBoxTypeProvider,
  TypeBoxValidatorCompiler,
} from "@fastify/type-provider-typebox";

import { env, isProd } from "./backend-core/runtime/env.js";
import { ProblemError, problemResponse } from "./backend-core/http/errors.js";

import prismaPlugin from "./plugins/prisma.js";
import redisPlugin from "./plugins/redis.js";
import authPlugin from "./plugins/auth.js";
import socketPlugin from "./plugins/socket.js";
import minioPlugin from "./plugins/minio.js";
import { createMediaWorker, createVideoWorker, createVoiceWorker } from "./queues/media.worker.js";

import healthRoutes from "./modules/health/health.routes.js";
import mediaRoutes from "./modules/media/media.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import userRoutes from "./modules/users/user.routes.js";
import conversationRoutes from "./modules/conversations/conversation.routes.js";
import callRoutes from "./modules/calls/calls.routes.js";
import messageRoutes from "./modules/messages/message.routes.js";
import notificationRoutes from "./modules/notifications/notification.routes.js";
import syncRoutes from "./modules/sync/sync.routes.js";
import devRoutes from "./modules/dev/dev.routes.js";

export async function buildServer() {
  const app = Fastify({
    logger: isProd
      ? { level: "info" }
      : {
          level: "debug",
          transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss" } },
        },
    trustProxy: isProd,
    disableRequestLogging: false,
  })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  // ── Security & utility plugins ───────────────────────────────────────────
  await app.register(sensible);
  await app.register(helmet, {
    contentSecurityPolicy: isProd ? undefined : false,
    hsts: isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  });
  await app.register(cors, {
    origin: env.WEB_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(cookie, { secret: env.COOKIE_SECRET, parseOptions: { sameSite: "strict" } });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    redis: undefined, // populated below — registered after redis plugin
  });

  // ── App plugins ──────────────────────────────────────────────────────────
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(minioPlugin);

  // Start the in-process media worker after all plugins are registered so it
  // has access to prisma, s3, and io. Closed automatically in onClose below.
  const workerDeps = { s3: app.s3, prisma: app.prisma, io: app.io, log: app.log };
  const mediaWorker = createMediaWorker(workerDeps);
  const videoWorker = createVideoWorker(workerDeps);
  const voiceWorker = createVoiceWorker(workerDeps);
  app.addHook("onClose", async () => {
    await Promise.all([mediaWorker.close(), videoWorker.close(), voiceWorker.close()]);
  });
  await app.register(multipart, {
    limits: { fileSize: env.MEDIA_MAX_SIZE_MB * 1024 * 1024 },
  });

  // ── Global error handler — RFC 9457 Problem Details ──────────────────────
  // TypeBox provider widens the err type to unknown; narrow here so we can
  // read Fastify's standard validation/statusCode fields.
  app.setErrorHandler((rawErr, _req, reply) => {
    const err = rawErr as FastifyError;
    if (err instanceof ProblemError) {
      return problemResponse(reply, err.code, err.detail);
    }
    if (err.validation) {
      return problemResponse(
        reply,
        "validation_error",
        err.validation[0]?.message ?? "Request failed validation.",
      );
    }
    if (err.statusCode === 429) {
      return problemResponse(reply, "rate_limited", "Too many requests.");
    }
    app.log.error({ err }, "unhandled error");
    return problemResponse(reply, "internal_error", "Something went wrong.");
  });

  app.setNotFoundHandler((_req, reply) => problemResponse(reply, "not_found", "Route not found."));

  // ── Routes ───────────────────────────────────────────────────────────────
  await app.register(healthRoutes, { prefix: "/api" });
  await app.register(mediaRoutes,  { prefix: "/api" });
  await app.register(authRoutes,   { prefix: "/api" });
  await app.register(userRoutes, { prefix: "/api" });
  await app.register(conversationRoutes, { prefix: "/api" });
  await app.register(callRoutes, { prefix: "/api" });
  await app.register(messageRoutes, { prefix: "/api" });
  await app.register(notificationRoutes, { prefix: "/api" });
  await app.register(syncRoutes, { prefix: "/api" });

  if (!isProd) {
    await app.register(devRoutes, { prefix: "/api" });
  }

  return app;
}

async function main() {
  const app = await buildServer();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "shutdown failed");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  console.log("=== DEBUG ENVIRONMENT BINDING ===");
  console.log("process.env.HOST:", process.env.HOST);
  console.log("env.HOST from file:", env.HOST);
  console.log("env.PORT:", env.PORT);
  console.log("=========================================");
  
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
  } catch (err) {
    app.log.error({ err }, "failed to start");
    process.exit(1);
  }
}

void main();
