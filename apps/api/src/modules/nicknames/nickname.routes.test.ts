import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import cookie from "@fastify/cookie";
import "../../backend-core/runtime/formats.js"; // side effect: registers uuid/date-time/email TypeBox formats
import { ProblemError, problemResponse } from "../../backend-core/http/errors.js";
import prismaPlugin from "../../plugins/prisma.js";
import redisPlugin from "../../plugins/redis.js";
import authPlugin from "../../plugins/auth.js";
import nicknameRoutes from "./nickname.routes.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import type { PrismaClient } from "@prisma/client";
import type { NicknameInfo } from "@relay/contracts";

// Real integration test — real Postgres/Redis (the throwaway local services),
// same minimal-app approach as conversation.routes.test.ts / dev.routes.test.ts.
// fastify.io.to() is replaced with a recording spy (not a real socket) so the
// "does the live event fire, and with what payload" assertions don't need a
// real connected client — same rationale as dev.routes.test.ts's io stub, one
// step further since we need to inspect what was emitted, not just swallow it.
type Emitted = { room: string; event: string; payload: unknown };

async function buildTestApp(emitted: Emitted[]) {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

  app.decorate(
    "io",
    {
      to: (room: string) => ({
        emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }),
      }),
    } as unknown as import("fastify").FastifyInstance["io"],
  );

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ProblemError) return problemResponse(reply, err.code, err.detail);
    throw err;
  });

  await app.register(nicknameRoutes, { prefix: "/api" });
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
      username: `nick-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
    },
  });
}

describe("PUT/GET/DELETE /api/users/:userId/nickname", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let emitted: Emitted[] = [];
  let ownerId: string;
  let targetId: string;
  const createdUserIds: string[] = [];

  before(async () => {
    emitted = [];
    app = await buildTestApp(emitted);
    const [owner, target] = await Promise.all([
      createUser(app.prisma, "owner"),
      createUser(app.prisma, "target"),
    ]);
    ownerId = owner.id;
    targetId = target.id;
    createdUserIds.push(ownerId, targetId);
  });

  beforeEach(async () => {
    emitted.length = 0;
    await app.prisma.userNickname.deleteMany({ where: { ownerId } });
    await app.prisma.notification.deleteMany({ where: { userId: targetId } });
  });

  after(async () => {
    await app.prisma.userNickname.deleteMany({ where: { ownerId: { in: createdUserIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  function put(callerId: string, forUserId: string, body: { nickname: string; sharedWithTarget: boolean }) {
    return app.inject({
      method: "PUT",
      url: `/api/users/${forUserId}/nickname`,
      headers: { cookie: cookieFor(callerId), "content-type": "application/json" },
      payload: body,
    });
  }
  function get(callerId: string, forUserId: string) {
    return app.inject({ method: "GET", url: `/api/users/${forUserId}/nickname`, headers: { cookie: cookieFor(callerId) } });
  }
  function del(callerId: string, forUserId: string) {
    return app.inject({ method: "DELETE", url: `/api/users/${forUserId}/nickname`, headers: { cookie: cookieFor(callerId) } });
  }
  // `emitted` also captures notification.service.ts's own notification:new
  // emit (same fastify.io.to().emit() call site) whenever a NICKNAME_SHARED
  // alert fires alongside the live update — filter to the event under test
  // rather than asserting on the raw array length.
  function nicknameEvents() {
    return emitted.filter((e) => e.event === "user:nickname-shared-updated");
  }

  it("GET on an unset pair returns nickname:null, sharedWithTarget:false", async () => {
    const res = await get(ownerId, targetId);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { nickname: null, sharedWithTarget: false });
  });

  it("PUT with sharedWithTarget:false is fully private — no alert, no live event, GET reflects it back", async () => {
    const res = await put(ownerId, targetId, { nickname: "Bug", sharedWithTarget: false });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json<NicknameInfo>(), { nickname: "Bug", sharedWithTarget: false });

    assert.equal(emitted.length, 0);
    const alerts = await app.prisma.notification.findMany({ where: { userId: targetId, type: "NICKNAME_SHARED" } });
    assert.equal(alerts.length, 0);

    const got = await get(ownerId, targetId);
    assert.deepEqual(got.json(), { nickname: "Bug", sharedWithTarget: false });
  });

  it("PUT with sharedWithTarget:true on a BRAND NEW nickname is a genuinely new share: fires one alert and one live event", async () => {
    const res = await put(ownerId, targetId, { nickname: "Bug", sharedWithTarget: true });
    assert.equal(res.statusCode, 200);

    const alerts = await app.prisma.notification.findMany({ where: { userId: targetId, type: "NICKNAME_SHARED" } });
    assert.equal(alerts.length, 1);
    const payload = alerts[0]!.payload as { from?: { userId: string }; nickname?: string };
    assert.equal(payload.from?.userId, ownerId);
    assert.equal(payload.nickname, "Bug");

    const events = nicknameEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.room, `user:${targetId}`);
    assert.deepEqual(events[0]!.payload, { ownerId, nickname: "Bug" });
  });

  it("PUT again with the SAME nickname while already shared (idempotent re-save) does NOT re-notify or re-emit", async () => {
    await put(ownerId, targetId, { nickname: "Bug", sharedWithTarget: true });
    emitted.length = 0;
    await app.prisma.notification.deleteMany({ where: { userId: targetId } });

    const res = await put(ownerId, targetId, { nickname: "Bug", sharedWithTarget: true });
    assert.equal(res.statusCode, 200);

    assert.equal(nicknameEvents().length, 0, "no live re-emit for an unchanged already-shared nickname");
    const alerts = await app.prisma.notification.findMany({ where: { userId: targetId, type: "NICKNAME_SHARED" } });
    assert.equal(alerts.length, 0, "no re-notify for an unchanged already-shared nickname");
  });

  it("PUT with a CHANGED nickname while already shared DOES notify and emit again", async () => {
    await put(ownerId, targetId, { nickname: "Bug", sharedWithTarget: true });
    emitted.length = 0;
    await app.prisma.notification.deleteMany({ where: { userId: targetId } });

    const res = await put(ownerId, targetId, { nickname: "Buggy", sharedWithTarget: true });
    assert.equal(res.statusCode, 200);

    const alerts = await app.prisma.notification.findMany({ where: { userId: targetId, type: "NICKNAME_SHARED" } });
    assert.equal(alerts.length, 1, "a changed nickname while shared is notify-worthy");
    assert.equal((alerts[0]!.payload as { nickname?: string }).nickname, "Buggy");

    const events = nicknameEvents();
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.payload, { ownerId, nickname: "Buggy" });
  });

  it("turning sharing OFF (true -> false) does NOT alert, but DOES emit the live event with nickname:null", async () => {
    await put(ownerId, targetId, { nickname: "Bug", sharedWithTarget: true });
    emitted.length = 0;
    await app.prisma.notification.deleteMany({ where: { userId: targetId } });

    const res = await put(ownerId, targetId, { nickname: "Bug", sharedWithTarget: false });
    assert.equal(res.statusCode, 200);

    const alerts = await app.prisma.notification.findMany({ where: { userId: targetId, type: "NICKNAME_SHARED" } });
    assert.equal(alerts.length, 0, "unsharing is not a share action — no alert");

    const events = nicknameEvents();
    assert.equal(events.length, 1, "the target's live badge must still disappear immediately");
    assert.deepEqual(events[0]!.payload, { ownerId, nickname: null });
  });

  it("re-sharing after having unshared (false -> true) is treated as a genuinely new share again", async () => {
    await put(ownerId, targetId, { nickname: "Bug", sharedWithTarget: true });
    await put(ownerId, targetId, { nickname: "Bug", sharedWithTarget: false });
    emitted.length = 0;
    await app.prisma.notification.deleteMany({ where: { userId: targetId } });

    const res = await put(ownerId, targetId, { nickname: "Bug", sharedWithTarget: true });
    assert.equal(res.statusCode, 200);

    const alerts = await app.prisma.notification.findMany({ where: { userId: targetId, type: "NICKNAME_SHARED" } });
    assert.equal(alerts.length, 1);
    const events = nicknameEvents();
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.payload, { ownerId, nickname: "Bug" });
  });

  it("DELETE clears the nickname: GET reverts to null, and if it was shared, emits nickname:null with no alert", async () => {
    await put(ownerId, targetId, { nickname: "Bug", sharedWithTarget: true });
    emitted.length = 0;
    await app.prisma.notification.deleteMany({ where: { userId: targetId } });

    const res = await del(ownerId, targetId);
    assert.equal(res.statusCode, 204);

    const got = await get(ownerId, targetId);
    assert.deepEqual(got.json(), { nickname: null, sharedWithTarget: false });

    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0]!.payload, { ownerId, nickname: null });
    const alerts = await app.prisma.notification.findMany({ where: { userId: targetId, type: "NICKNAME_SHARED" } });
    assert.equal(alerts.length, 0, "clearing is never a share action");
  });

  it("DELETE on a PRIVATE (never-shared) nickname clears it silently — no live event, since the target never saw it", async () => {
    await put(ownerId, targetId, { nickname: "Bug", sharedWithTarget: false });
    emitted.length = 0;

    const res = await del(ownerId, targetId);
    assert.equal(res.statusCode, 204);
    assert.equal(emitted.length, 0);
  });

  it("DELETE on an already-unset pair is a no-op, not a 404/500", async () => {
    const res = await del(ownerId, targetId);
    assert.equal(res.statusCode, 204);
    assert.equal(emitted.length, 0);
  });

  it("cannot set a nickname for yourself", async () => {
    const res = await put(ownerId, ownerId, { nickname: "Me", sharedWithTarget: false });
    assert.equal(res.statusCode, 400);
  });

  it("setting a nickname for a user that doesn't exist returns 404", async () => {
    const res = await put(ownerId, randomUUID(), { nickname: "Ghost", sharedWithTarget: false });
    assert.equal(res.statusCode, 404);
  });

  it("every route requires auth", async () => {
    const unauth = await app.inject({ method: "GET", url: `/api/users/${targetId}/nickname` });
    assert.equal(unauth.statusCode, 401);
  });
});
