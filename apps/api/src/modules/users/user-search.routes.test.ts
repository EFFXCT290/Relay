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
import minioPlugin from "../../plugins/minio.js";
import userRoutes from "./user.routes.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import type { PrismaClient } from "@prisma/client";

// Real integration test — real Postgres/Redis/MinIO. Deliberately does NOT
// import buildServer()/server.ts — see media.routes.test.ts for why (its
// unrelated, pre-existing `void main()` side effect boots a second real
// server on import). Builds only the plugins GET /users/search needs.
async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(minioPlugin); // GET /users/search calls fastify.getMediaUrl for any hit with an avatar

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ProblemError) return problemResponse(reply, err.code, err.detail);
    throw err;
  });

  await app.register(userRoutes, { prefix: "/api" });
  return app;
}

async function createUser(prisma: PrismaClient, username: string, avatarKey?: string) {
  return prisma.user.create({
    data: {
      username,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
      ...(avatarKey ? { avatarKey } : {}),
    },
  });
}

function cookieFor(userId: string): string {
  const { token } = signAccessToken(userId);
  return `${ACCESS_COOKIE}=${token}`;
}

describe("GET /api/users/search", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const suffix = randomUUID().slice(0, 8); // shared, unique-per-run prefix so `q` can't accidentally match another test's leftover data

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  it("excludes the caller themselves from results, even when their own username matches the query", async () => {
    const caller = await createUser(app.prisma, `srch-${suffix}-caller`);
    const other  = await createUser(app.prisma, `srch-${suffix}-other`);
    createdUserIds.push(caller.id, other.id);

    const res = await app.inject({
      method: "GET",
      url: `/api/users/search?q=srch-${suffix}`,
      headers: { cookie: cookieFor(caller.id) },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { users: Array<{ userId: string }> };
    const ids = body.users.map((u) => u.userId);
    assert.ok(ids.includes(other.id), "the other matching user must be present");
    assert.ok(!ids.includes(caller.id), "the caller must never see themselves in their own search results");
  });

  it("returns ONLY the public fields — no passwordHash, passwordSalt, or the raw avatarKey", async () => {
    const caller = await createUser(app.prisma, `srch-${suffix}-caller2`);
    const withAvatar = await createUser(app.prisma, `srch-${suffix}-withavatar`, "avatars/some-user/deadbeef.webp");
    createdUserIds.push(caller.id, withAvatar.id);

    const res = await app.inject({
      method: "GET",
      url: `/api/users/search?q=srch-${suffix}-withavatar`,
      headers: { cookie: cookieFor(caller.id) },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { users: Array<Record<string, unknown>> };
    assert.equal(body.users.length, 1);
    const hit = body.users[0]!;

    assert.deepEqual(Object.keys(hit).sort(), ["avatarUrl", "userId", "username"]);
    assert.equal(hit.userId, withAvatar.id);
    assert.equal(hit.username, withAvatar.username);
    // avatarUrl must be a signed URL derived from the key, never the raw
    // storage key itself (which would let a client construct bucket paths).
    assert.equal(typeof hit.avatarUrl, "string");
    assert.ok(String(hit.avatarUrl).includes("deadbeef"), "the signed URL should reference the underlying object");
    assert.notEqual(hit.avatarUrl, "avatars/some-user/deadbeef.webp", "avatarUrl must be a signed URL, not the raw MinIO key");

    for (const forbidden of ["passwordHash", "passwordSalt", "avatarKey", "email", "createdAt", "updatedAt", "pushMessages", "pushCalls"]) {
      assert.equal(hit[forbidden], undefined, `response must not include "${forbidden}"`);
    }
  });

  it("a user with no avatar gets avatarUrl: null, not an error or a broken URL", async () => {
    const caller = await createUser(app.prisma, `srch-${suffix}-caller3`);
    const noAvatar = await createUser(app.prisma, `srch-${suffix}-noavatar`);
    createdUserIds.push(caller.id, noAvatar.id);

    const res = await app.inject({
      method: "GET",
      url: `/api/users/search?q=srch-${suffix}-noavatar`,
      headers: { cookie: cookieFor(caller.id) },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { users: Array<{ avatarUrl: string | null }> };
    assert.equal(body.users.length, 1);
    assert.equal(body.users[0]!.avatarUrl, null);
  });

  it("matches usernames case-insensitively by prefix", async () => {
    const caller = await createUser(app.prisma, `srch-${suffix}-caller4`);
    const target = await createUser(app.prisma, `Srch-${suffix}-MixedCase`);
    createdUserIds.push(caller.id, target.id);

    const res = await app.inject({
      method: "GET",
      url: `/api/users/search?q=srch-${suffix}-mixedcase`,
      headers: { cookie: cookieFor(caller.id) },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { users: Array<{ userId: string }> };
    assert.ok(body.users.some((u) => u.userId === target.id));
  });

  it("rejects a query shorter than the 2-character minimum", async () => {
    const caller = await createUser(app.prisma, `srch-${suffix}-caller5`);
    createdUserIds.push(caller.id);

    const res = await app.inject({
      method: "GET",
      url: "/api/users/search?q=a",
      headers: { cookie: cookieFor(caller.id) },
    });

    assert.equal(res.statusCode, 400);
  });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: `/api/users/search?q=${suffix}` });
    assert.equal(res.statusCode, 401);
  });
});
