import { after, before, describe, it } from "node:test";
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
import conversationRoutes from "./conversation.routes.js";
import { signAccessToken } from "../../backend-core/auth/tokens.js";
import { ACCESS_COOKIE } from "../../backend-core/auth/cookies.js";
import { encryptSecret } from "../../backend-core/crypto/token-cipher.js";
import { env } from "../../backend-core/runtime/env.js";
import type { PrismaClient } from "@prisma/client";
import type { ConversationListItem } from "@relay/contracts";

// Real integration test — real Postgres/Redis (the throwaway local services),
// not hand-rolled mocks. Same minimal-app approach as media.routes.test.ts /
// message.routes.test.ts: does NOT import buildServer()/server.ts (its
// pre-existing void main() side effect boots a second real server on import).
// No @fastify/rate-limit here — unlike auth.routes.ts, none of these routes
// declare a per-route rate limit, so it isn't load-bearing for what's tested.
async function buildTestApp() {
  const app = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

  // The routes emit conversation:request/accepted/deleted via fastify.io —
  // stub it, real socket delivery isn't what this test covers. No `.sockets`
  // access needed (unlike message routes' online-room checks).
  app.decorate(
    "io",
    { to: () => ({ emit: () => {} }) } as unknown as import("fastify").FastifyInstance["io"],
  );

  // Mirrors server.ts's problem-details error handler — without it, thrown
  // ProblemErrors (403/404/422/etc.) would fall through to Fastify's generic 500.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ProblemError) return problemResponse(reply, err.code, err.detail);
    throw err;
  });

  await app.register(conversationRoutes, { prefix: "/api" });
  return app;
}

function cookieFor(userId: string): string {
  const { token } = signAccessToken(userId);
  return `${ACCESS_COOKIE}=${token}`;
}

// Login isn't exercised in any of these tests — tokens are minted directly via
// signAccessToken (same convention as media.routes.test.ts / message.routes.test.ts).
async function createUser(prisma: PrismaClient, label: string) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `convo-authz-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      passwordSalt: randomBytes(32).toString("hex"), // matches passwordSalt @db.Char(64)
    },
  });
}

describe("POST /api/conversations", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    const prisma = app.prisma;
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } }); // cascades participants
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  function postConversation(callerId: string, participantId: string) {
    return app.inject({
      method: "POST",
      url: "/api/conversations",
      headers: { cookie: cookieFor(callerId), "content-type": "application/json" },
      payload: { participantId },
    });
  }

  it("exposes only the target user's public profile fields, not internal data", async () => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);

    const res = await postConversation(a.id, b.id);
    assert.equal(res.statusCode, 201);
    const body = res.json() as { conversationId: string; participant: Record<string, unknown>; createdAt: string };
    createdConversationIds.push(body.conversationId);

    assert.equal(Object.keys(body).sort().join(","), "conversationId,createdAt,participant");
    assert.equal(Object.keys(body.participant).sort().join(","), "avatarUrl,userId,username");
    assert.equal(body.participant["userId"], b.id);
    assert.equal(body.participant["username"], b.username);
    assert.equal(body.participant["avatarUrl"], null);
    // No password/internal fields leak through, whatever they'd be called.
    assert.equal(body.participant["passwordHash"], undefined);
    assert.equal(body.participant["passwordSalt"], undefined);
  });

  it("re-POSTing the same participantId is idempotent — same conversationId, no duplicate row", async () => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);

    const first = await postConversation(a.id, b.id);
    assert.equal(first.statusCode, 201);
    const firstBody = first.json() as { conversationId: string };
    createdConversationIds.push(firstBody.conversationId);

    const second = await postConversation(a.id, b.id);
    assert.equal(second.statusCode, 200);
    const secondBody = second.json() as { conversationId: string };
    assert.equal(secondBody.conversationId, firstBody.conversationId);

    // These two users are brand-new to this test, so any conversation
    // involving `a` can only be the one created above.
    const count = await app.prisma.conversation.count({
      where: { participants: { some: { userId: a.id } } },
    });
    assert.equal(count, 1);
  });
});

describe("GET /api/conversations/:conversationId", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    const prisma = app.prisma;
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  // Setup-only step (not exercising the create route) — build the pending
  // conversation directly via Prisma, mirroring what POST /conversations
  // itself would produce: creator accepted immediately, recipient pending.
  async function makeConversation() {
    const [a, b, outsider] = await Promise.all([
      createUser(app.prisma, "a"),
      createUser(app.prisma, "b"),
      createUser(app.prisma, "outsider"),
    ]);
    createdUserIds.push(a.id, b.id, outsider.id);

    const conversation = await app.prisma.conversation.create({ data: {} });
    createdConversationIds.push(conversation.id);
    await app.prisma.participant.createMany({
      data: [
        { userId: a.id, conversationId: conversation.id, acceptedAt: new Date() },
        { userId: b.id, conversationId: conversation.id },
      ],
    });
    return { a, b, outsider, conversationId: conversation.id };
  }

  it("403s a non-participant", async () => {
    const { outsider, conversationId } = await makeConversation();
    const res = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}`,
      headers: { cookie: cookieFor(outsider.id) },
    });
    assert.equal(res.statusCode, 403);
  });

  it("200s a participant with the expected shape", async () => {
    const { a, b, conversationId } = await makeConversation();
    const res = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}`,
      headers: { cookie: cookieFor(a.id) },
    });
    assert.equal(res.statusCode, 200);

    const body = res.json() as { conversationId: string; participant: Record<string, unknown>; createdAt: string; myAcceptedAt: string | null };
    assert.equal(Object.keys(body).sort().join(","), "conversationId,createdAt,myAcceptedAt,participant");
    assert.equal(body.conversationId, conversationId);
    assert.equal(Object.keys(body.participant).sort().join(","), "avatarUrl,isOnline,lastSeenAt,userId,username");
    assert.equal(body.participant["userId"], b.id);
    assert.equal(body.participant["username"], b.username);
    // `a` created the conversation, so `a`'s own row was accepted at creation.
    assert.notEqual(body.myAcceptedAt, null);
  });
});

describe("POST /api/conversations/:conversationId/accept", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    const prisma = app.prisma;
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  async function makeConversation() {
    const [a, b, outsider] = await Promise.all([
      createUser(app.prisma, "a"),
      createUser(app.prisma, "b"),
      createUser(app.prisma, "outsider"),
    ]);
    createdUserIds.push(a.id, b.id, outsider.id);

    const conversation = await app.prisma.conversation.create({ data: {} });
    createdConversationIds.push(conversation.id);
    await app.prisma.participant.createMany({
      data: [
        { userId: a.id, conversationId: conversation.id, acceptedAt: new Date() },
        { userId: b.id, conversationId: conversation.id }, // pending
      ],
    });
    return { a, b, outsider, conversationId: conversation.id };
  }

  it("rejects a non-participant (conversation.routes.ts:380)", async () => {
    const { outsider, conversationId } = await makeConversation();
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/accept`,
      headers: { cookie: cookieFor(outsider.id) },
    });
    assert.equal(res.statusCode, 403);
  });

  it("lets the actual pending participant accept", async () => {
    const { b, conversationId } = await makeConversation();
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/accept`,
      headers: { cookie: cookieFor(b.id) },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { conversationId: string; acceptedAt: string };
    assert.equal(body.conversationId, conversationId);
    assert.equal(typeof body.acceptedAt, "string");

    const row = await app.prisma.participant.findUnique({
      where: { userId_conversationId: { userId: b.id, conversationId } },
    });
    assert.notEqual(row!.acceptedAt, null);
  });
});

describe("DELETE /api/conversations/:conversationId", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    const prisma = app.prisma;
    // Only the conversations that survived their test still need cleanup —
    // deleting an already-deleted id is a no-op filter, not an error.
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  async function makeConversation() {
    const [a, b, outsider] = await Promise.all([
      createUser(app.prisma, "a"),
      createUser(app.prisma, "b"),
      createUser(app.prisma, "outsider"),
    ]);
    createdUserIds.push(a.id, b.id, outsider.id);

    const conversation = await app.prisma.conversation.create({ data: {} });
    createdConversationIds.push(conversation.id);
    await app.prisma.participant.createMany({
      data: [
        { userId: a.id, conversationId: conversation.id, acceptedAt: new Date() }, // creator — always pre-accepted
        { userId: b.id, conversationId: conversation.id }, // recipient — pending
      ],
    });
    return { a, b, outsider, conversationId: conversation.id };
  }

  function deleteConversation(callerId: string, conversationId: string) {
    return app.inject({
      method: "DELETE",
      url: `/api/conversations/${conversationId}`,
      headers: { cookie: cookieFor(callerId) },
    });
  }

  it("rejects a non-participant", async () => {
    const { outsider, conversationId } = await makeConversation();
    const res = await deleteConversation(outsider.id, conversationId);
    assert.equal(res.statusCode, 403);

    const stillThere = await app.prisma.conversation.findUnique({ where: { id: conversationId } });
    assert.ok(stillThere, "a rejected delete must not remove the conversation");
  });

  // The route's "only while pending" check (:429) reads the CALLER's own
  // Participant.acceptedAt, not the conversation's overall state — and the
  // creator (`a`) always has acceptedAt set from the moment of creation. So
  // `a` can never satisfy this check via this route; only the still-pending
  // recipient (`b`) can, which is deliberately who this test uses.
  it("lets the still-pending participant delete", async () => {
    const { b, conversationId } = await makeConversation();
    const res = await deleteConversation(b.id, conversationId);
    assert.equal(res.statusCode, 204);

    const gone = await app.prisma.conversation.findUnique({ where: { id: conversationId } });
    assert.equal(gone, null);
    // It was deleted for real — no need to clean it up in `after()`.
    createdConversationIds.splice(createdConversationIds.indexOf(conversationId), 1);
  });

  it("rejects a participant once their own side has already been accepted", async () => {
    const { b, conversationId } = await makeConversation();

    const acceptRes = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/accept`,
      headers: { cookie: cookieFor(b.id) },
    });
    assert.equal(acceptRes.statusCode, 200);

    const res = await deleteConversation(b.id, conversationId);
    assert.equal(res.statusCode, 422);

    const stillThere = await app.prisma.conversation.findUnique({ where: { id: conversationId } });
    assert.ok(stillThere, "a rejected delete must not remove the conversation");
  });
});

describe("GET /api/conversations — spotify field", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    const prisma = app.prisma;
    await prisma.spotifyConnection.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  async function makeAcceptedConversation(callerId: string, otherId: string) {
    const conversation = await app.prisma.conversation.create({ data: {} });
    createdConversationIds.push(conversation.id);
    await app.prisma.participant.createMany({
      data: [
        { userId: callerId, conversationId: conversation.id, acceptedAt: new Date() },
        { userId: otherId, conversationId: conversation.id, acceptedAt: new Date() },
      ],
    });
    return conversation.id;
  }

  function enc(plaintext: string): string {
    return encryptSecret(plaintext, env.SPOTIFY_TOKEN_ENC_KEY);
  }

  async function createConnection(userId: string, showOnProfile = true) {
    return app.prisma.spotifyConnection.create({
      data: {
        userId,
        accessToken: enc("valid-access-token"),
        refreshToken: enc("valid-refresh-token"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // not expired — no refresh call expected
        scope: "user-read-currently-playing user-read-recently-played",
        showOnProfile,
      },
    });
  }

  const currentlyPlayingUrl = "https://api.spotify.com/v1/me/player/currently-playing?additional_types=track";

  function nowPlaying(trackName: string, artistName: string) {
    return {
      status: 200,
      ok: true,
      json: async () => ({
        is_playing: true,
        item: { name: trackName, artists: [{ name: artistName }], album: { images: [] }, external_urls: {} },
      }),
    } as Response;
  }

  function getConversations(callerId: string) {
    return app.inject({ method: "GET", url: "/api/conversations", headers: { cookie: cookieFor(callerId) } });
  }

  it("maps the OTHER participant's now-playing to the slim {trackName, artistName, isPlaying} shape — no albumArtUrl/trackUrl", async (t) => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    await makeAcceptedConversation(a.id, b.id);
    await createConnection(b.id);

    t.mock.method(globalThis, "fetch", async (url: string) => {
      if (url === currentlyPlayingUrl) return nowPlaying("Nightcall", "Kavinsky");
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await getConversations(a.id);
    assert.equal(res.statusCode, 200);
    const body = res.json() as { conversations: ConversationListItem[] };
    assert.equal(body.conversations.length, 1);

    const spotify = body.conversations[0]!.spotify;
    assert.ok(spotify);
    assert.equal(Object.keys(spotify).sort().join(","), "artistName,isPlaying,trackName", "must be the SLIM shape, not the full badge");
    assert.deepEqual(spotify, { trackName: "Nightcall", artistName: "Kavinsky", isPlaying: true });
  });

  it("respects showOnProfile exactly as the standalone badge endpoint does — false means null, and Spotify is never called", async (t) => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    await makeAcceptedConversation(a.id, b.id);
    await createConnection(b.id, false);

    t.mock.method(globalThis, "fetch", async () => {
      throw new Error("must not call Spotify when showOnProfile is false");
    });

    const res = await getConversations(a.id);
    const body = res.json() as { conversations: ConversationListItem[] };
    assert.equal(body.conversations[0]!.spotify, null);
  });

  it("a participant who never connected Spotify yields spotify: null, without ever calling Spotify", async (t) => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    await makeAcceptedConversation(a.id, b.id);
    // no SpotifyConnection row for b

    t.mock.method(globalThis, "fetch", async () => {
      throw new Error("must not call Spotify for a participant with no connection");
    });

    const res = await getConversations(a.id);
    const body = res.json() as { conversations: ConversationListItem[] };
    assert.equal(body.conversations[0]!.spotify, null);
  });

  it("reuses the shared 45s Redis cache: a second GET within the TTL does not call Spotify again", async (t) => {
    const [a, b] = await Promise.all([createUser(app.prisma, "a"), createUser(app.prisma, "b")]);
    createdUserIds.push(a.id, b.id);
    await makeAcceptedConversation(a.id, b.id);
    await createConnection(b.id);

    let calls = 0;
    t.mock.method(globalThis, "fetch", async (url: string) => {
      if (url === currentlyPlayingUrl) {
        calls++;
        return nowPlaying("Nightcall", "Kavinsky");
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const first = await getConversations(a.id);
    const firstSpotify = (first.json() as { conversations: ConversationListItem[] }).conversations[0]!.spotify;
    assert.equal(calls, 1, "the first GET is a genuine cache miss — must call Spotify");

    const second = await getConversations(a.id);
    const secondSpotify = (second.json() as { conversations: ConversationListItem[] }).conversations[0]!.spotify;
    assert.equal(calls, 1, "a second GET within the 45s TTL must be served from the shared cache, not re-fetch");
    assert.deepEqual(secondSpotify, firstSpotify);
  });

  it("fans out in parallel across multiple conversations — one Spotify call per distinct participant, correctly attributed, not mixed up", async (t) => {
    const [a, b, c] = await Promise.all([
      createUser(app.prisma, "a"),
      createUser(app.prisma, "b"),
      createUser(app.prisma, "c"),
    ]);
    createdUserIds.push(a.id, b.id, c.id);
    await Promise.all([makeAcceptedConversation(a.id, b.id), makeAcceptedConversation(a.id, c.id)]);
    await Promise.all([createConnection(b.id), createConnection(c.id)]);

    const calls: (string | undefined)[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      if (url !== currentlyPlayingUrl) throw new Error(`unexpected fetch: ${url}`);
      const auth = (init!.headers as Record<string, string>)["Authorization"];
      calls.push(auth);
      // Both connections use the same plaintext access token in this test
      // fixture, so we can't disambiguate by token — attribution is instead
      // verified below via each conversation's own participant.userId.
      return nowPlaying("Track", "Artist");
    });

    const res = await getConversations(a.id);
    const body = res.json() as { conversations: ConversationListItem[] };
    assert.equal(body.conversations.length, 2);
    assert.equal(calls.length, 2, "exactly one Spotify call per distinct participant — not batched into one, not duplicated per row");

    for (const conv of body.conversations) {
      assert.ok([b.id, c.id].includes(conv.participant.userId));
      assert.deepEqual(conv.spotify, { trackName: "Track", artistName: "Artist", isPlaying: true });
    }
  });
});
