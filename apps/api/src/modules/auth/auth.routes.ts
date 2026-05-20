import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  accessCookieOpts,
  clearAccessCookieOpts,
  clearRefreshCookieOpts,
  refreshCookieOpts,
} from "../../backend-core/auth/cookies.js";
import { ProblemError, problemResponse } from "../../backend-core/http/errors.js";
import { generateSalt, hashPassword, verifyPassword } from "../../backend-core/crypto/passwords.js";
import {
  blocklistJti,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from "../../backend-core/auth/tokens.js";
import {
  AuthSuccessSchema,
  CredentialsSchema,
  MeSchema,
} from "./auth.schema.js";

// Per-route limit for login + register (15 min window) overrides the global
// authenticated limit. Tracked per-IP since the user isn't authenticated yet.
const ipKey = (req: { ip: string }) => req.ip;

const authRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  // ── POST /api/auth/register ───────────────────────────────────────────────
  fastify.post(
    "/auth/register",
    {
      schema: {
        body: CredentialsSchema,
        response: { 201: AuthSuccessSchema },
      },
      config: {
        rateLimit: { max: 3, timeWindow: "1 hour", keyGenerator: ipKey },
      },
    },
    async (request, reply) => {
      const { username, password } = request.body;

      const existing = await fastify.prisma.user.findUnique({ where: { username } });
      if (existing) {
        return problemResponse(reply, "conflict", "Username is already taken.");
      }

      const salt = generateSalt();
      const passwordHash = await hashPassword(password, salt);

      const user = await fastify.prisma.user.create({
        data: { username, passwordHash, passwordSalt: salt },
      });

      const access = signAccessToken(user.id);
      const refresh = signRefreshToken(user.id);
      reply.setCookie(ACCESS_COOKIE, access.token, accessCookieOpts);
      reply.setCookie(REFRESH_COOKIE, refresh.token, refreshCookieOpts);

      return reply.code(201).send({ userId: user.id, username: user.username });
    },
  );

  // ── POST /api/auth/login ──────────────────────────────────────────────────
  fastify.post(
    "/auth/login",
    {
      schema: {
        body: CredentialsSchema,
        response: { 200: AuthSuccessSchema },
      },
      config: {
        rateLimit: { max: 5, timeWindow: "15 minutes", keyGenerator: ipKey },
      },
    },
    async (request, reply) => {
      const { username, password } = request.body;
      const lockoutKey = `login:lockout:${username.toLowerCase()}`;
      const failKey = `login:fail:${username.toLowerCase()}`;

      // Soft per-username lockout after 10 consecutive failures.
      if (await fastify.redis.exists(lockoutKey)) {
        return problemResponse(reply, "unauthorized", "Invalid credentials.");
      }

      const user = await fastify.prisma.user.findUnique({ where: { username } });

      // Constant-ish-time response: do a throwaway verify against a known-bad
      // hash when the user doesn't exist, so timing doesn't leak existence.
      const valid = user
        ? await verifyPassword(user.passwordHash, password, user.passwordSalt)
        : await verifyPassword(
            "$argon2id$v=19$m=65536,t=3,p=4$YWFhYWFhYWFhYWFhYWFhYQ$dummyhashvaluetonotleak",
            password,
            "0".repeat(64),
          ).catch(() => false);

      if (!user || !valid) {
        const count = await fastify.redis.incr(failKey);
        if (count === 1) await fastify.redis.expire(failKey, 60 * 30);
        if (count >= 10) await fastify.redis.set(lockoutKey, "1", "EX", 60 * 30);
        return problemResponse(reply, "unauthorized", "Invalid credentials.");
      }

      // Successful login — clear the fail counter.
      await fastify.redis.del(failKey);

      const access = signAccessToken(user.id);
      const refresh = signRefreshToken(user.id);
      reply.setCookie(ACCESS_COOKIE, access.token, accessCookieOpts);
      reply.setCookie(REFRESH_COOKIE, refresh.token, refreshCookieOpts);

      return reply.code(200).send({ userId: user.id, username: user.username });
    },
  );

  // ── POST /api/auth/refresh ────────────────────────────────────────────────
  fastify.post(
    "/auth/refresh",
    {
      schema: { response: { 200: Type.Object({ ok: Type.Literal(true) }) } },
      config: {
        rateLimit: { max: 10, timeWindow: "15 minutes", keyGenerator: ipKey },
      },
    },
    async (request, reply) => {
      const oldRefresh = request.cookies[REFRESH_COOKIE];
      if (!oldRefresh) {
        return problemResponse(reply, "unauthorized", "Refresh token missing.");
      }

      let payload;
      try {
        payload = verifyRefreshToken(oldRefresh);
      } catch {
        return problemResponse(reply, "unauthorized", "Refresh token invalid or expired.");
      }

      const blockKey = `jti:${payload.jti}`;
      if (await fastify.redis.exists(blockKey)) {
        return problemResponse(reply, "unauthorized", "Refresh token has been revoked.");
      }

      // Rotate both tokens — blocklist the old refresh jti so it can't be
      // re-used (defense against stolen refresh cookies replayed in parallel).
      await blocklistJti(
        fastify.redis,
        payload.jti,
        new Date(payload.exp * 1000),
      );

      const access = signAccessToken(payload.sub);
      const refresh = signRefreshToken(payload.sub);
      reply.setCookie(ACCESS_COOKIE, access.token, accessCookieOpts);
      reply.setCookie(REFRESH_COOKIE, refresh.token, refreshCookieOpts);

      return { ok: true as const };
    },
  );

  // ── POST /api/auth/logout ─────────────────────────────────────────────────
  fastify.post("/auth/logout", async (request, reply) => {
    // Best-effort revocation of whatever tokens are present. We don't 401 here
    // — if you're already logged out, the desired end state is the same.
    const access = request.cookies[ACCESS_COOKIE];
    const refresh = request.cookies[REFRESH_COOKIE];

    if (access) {
      try {
        const payload = verifyAccessToken(access);
        await blocklistJti(fastify.redis, payload.jti, new Date(payload.exp * 1000));
      } catch {
        /* ignore */
      }
    }
    if (refresh) {
      try {
        const payload = verifyRefreshToken(refresh);
        await blocklistJti(fastify.redis, payload.jti, new Date(payload.exp * 1000));
      } catch {
        /* ignore */
      }
    }

    reply.clearCookie(ACCESS_COOKIE, clearAccessCookieOpts);
    reply.clearCookie(REFRESH_COOKIE, clearRefreshCookieOpts);
    return reply.code(204).send();
  });

  // ── GET /api/auth/me ──────────────────────────────────────────────────────
  fastify.get(
    "/auth/me",
    {
      preHandler: [fastify.authenticate],
      schema: { response: { 200: MeSchema } },
    },
    async (request, reply) => {
      const user = await fastify.prisma.user.findUnique({
        where: { id: request.userId! },
        select: { id: true, username: true, createdAt: true },
      });
      if (!user) throw new ProblemError("not_found", "User not found.");
      return {
        userId: user.id,
        username: user.username,
        createdAt: user.createdAt.toISOString(),
      };
    },
  );
};

export default authRoutes;
