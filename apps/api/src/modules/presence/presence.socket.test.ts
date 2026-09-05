import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import cookie from "@fastify/cookie";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import "../../backend-core/runtime/formats.js"; // side effect: registers uuid/date-time/email TypeBox formats
import prismaPlugin from "../../plugins/prisma.js";
import redisPlugin from "../../plugins/redis.js";
import authPlugin from "../../plugins/auth.js";
import socketPlugin from "../../plugins/socket.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import type { PrismaClient } from "@prisma/client";

// Real integration test — a real Socket.IO server bound to a real port, real
// Postgres/Redis, driven by a real socket.io-client connection. Regression
// test for a bug found (and fixed) while building the user-profile-broadcast
// socket test in this same session: presence.socket.ts's on-connect
// `void service.markOnline(userId)` had no `.catch()`. Any rejection there —
// reproduced below by deleting the user's row right after it connects, which
// makes the service's UserPresence upsert hit a foreign-key violation — was
// an unhandled promise rejection. Node's default behavior for that crashes
// the *entire process*, disconnecting every connected user, not just the one
// that triggered it. Same fix pattern as plugins/socket.ts's
// MessageService.sweepUndelivered().catch(...).
async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin); // real Socket.IO server — this is what actually runs markOnline on connect

  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url };
}

async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `presence-crash-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
    },
  });
}

function connectSocket(url: string, userId: string): Promise<ClientSocket> {
  const { token } = signAccessToken(userId);
  const socket = ioClient(url, {
    extraHeaders: { cookie: `${ACCESS_COOKIE}=${token}` },
    forceNew: true,
    reconnection: false,
    transports: ["websocket"], // see user-profile-broadcast.socket.test.ts for why
  });
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("presence.socket.ts — fire-and-forget presence calls don't crash the process on failure", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>["app"];
  let url: string;

  before(async () => {
    ({ app, url } = await buildTestApp());
  });

  after(async () => {
    const { pushQueue } = await import("../../queues/push.queue.js");
    await pushQueue.close();
    await app.close();
    // See user-profile-broadcast.socket.test.ts's after() for why this test
    // style needs an explicit exit rather than relying on natural drain.
    process.exit(0);
  });

  it("a markOnline failure (the connecting user's row disappearing) is caught, not an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const user = await createUser(app.prisma, "a");
      const socket = await connectSocket(url, user.id);

      // Force the exact race that crashed the process: the user row is gone
      // by the time markOnline's fire-and-forget UserPresence upsert runs.
      await app.prisma.user.delete({ where: { id: user.id } });

      // Give the fire-and-forget markOnline() call time to settle (reject).
      await sleep(500);
      socket.close();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    assert.equal(
      rejections.length,
      0,
      "markOnline's failure must be caught internally, not surfaced as a process-level unhandled rejection",
    );
  });
});
