import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import cookie from "@fastify/cookie";
import "../../backend-core/runtime/formats.js";
import { ProblemError, problemResponse } from "../../backend-core/http/errors.js";
import prismaPlugin from "../../plugins/prisma.js";
import redisPlugin from "../../plugins/redis.js";
import authPlugin from "../../plugins/auth.js";
import callRoutes from "./calls.routes.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import type { PrismaClient } from "@prisma/client";
import type { CallHistoryResponse } from "@relay/contracts";

async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ProblemError) return problemResponse(reply, err.code, err.detail);
    throw err;
  });
  await app.register(callRoutes, { prefix: "/api" });
  return app;
}

function cookieFor(userId: string): string {
  const { token } = signAccessToken(userId);
  return `${ACCESS_COOKIE}=${token}`;
}

async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `calls-route-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
    },
  });
}

describe("GET /api/calls — scoped to the caller's own userId only", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    await app.prisma.call.deleteMany({ where: { OR: [{ callerId: { in: createdUserIds } }, { recipientId: { in: createdUserIds } }] } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  it("returns only calls where the caller is the caller or the recipient, never a call between two other users", async () => {
    const [a, b, c] = await Promise.all([
      createUser(app.prisma, "a"),
      createUser(app.prisma, "b"),
      createUser(app.prisma, "c"),
    ]);
    createdUserIds.push(a.id, b.id, c.id);

    // A ↔ B: A is the caller — must appear for A as "outgoing".
    const abCall = await app.prisma.call.create({
      data: { callerId: a.id, recipientId: b.id, type: "AUDIO", status: "ENDED", durationSec: 42 },
    });
    // C ↔ B: has nothing to do with A — must NOT appear in A's history.
    await app.prisma.call.create({
      data: { callerId: c.id, recipientId: b.id, type: "VIDEO", status: "MISSED" },
    });
    // B ↔ A, reversed direction: A is the recipient — must appear for A as "incoming".
    const baCall = await app.prisma.call.create({
      data: { callerId: b.id, recipientId: a.id, type: "VIDEO", status: "REJECTED" },
    });

    const res = await app.inject({ method: "GET", url: "/api/calls", headers: { cookie: cookieFor(a.id) } });
    assert.equal(res.statusCode, 200);
    const body = res.json() as CallHistoryResponse;

    assert.equal(body.calls.length, 2, "only the two calls involving A must be returned");
    const ids = body.calls.map((c) => c.id).sort();
    assert.deepEqual(ids, [abCall.id, baCall.id].sort());

    const outgoing = body.calls.find((c) => c.id === abCall.id)!;
    assert.equal(outgoing.direction, "outgoing");
    assert.equal(outgoing.otherUser.id, b.id);
    assert.equal(outgoing.durationSec, 42);

    const incoming = body.calls.find((c) => c.id === baCall.id)!;
    assert.equal(incoming.direction, "incoming");
    assert.equal(incoming.otherUser.id, b.id);
  });

  it("returns an empty list for a user with no call history, not every call in the system", async () => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    await app.prisma.call.create({ data: { callerId: a.id, recipientId: b.id, type: "AUDIO", status: "ENDED" } });

    const bystander = await createUser(app.prisma, "bystander");
    createdUserIds.push(bystander.id);

    const res = await app.inject({ method: "GET", url: "/api/calls", headers: { cookie: cookieFor(bystander.id) } });
    assert.equal(res.statusCode, 200);
    const body = res.json() as CallHistoryResponse;
    assert.deepEqual(body.calls, []);
  });

  it("401s when unauthenticated", async () => {
    const res = await app.inject({ method: "GET", url: "/api/calls" });
    assert.equal(res.statusCode, 401);
  });
});
