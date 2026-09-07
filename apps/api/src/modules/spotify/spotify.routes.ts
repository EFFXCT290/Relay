import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { randomBytes } from "node:crypto";
import { ProblemError } from "../../backend-core/http/errors.js";
import { env, isSpotifyConfigured } from "../../backend-core/runtime/env.js";
import {
  SpotifyBadgeResponseSchema,
  SpotifyConnectionStatusSchema,
  UpdateSpotifyPreferencesPayloadSchema,
} from "@relay/contracts";
import { SpotifyNotConnectedError, SpotifyService } from "./spotify.service.js";

const STATE_TTL_S = 600; // 10 min — comfortably covers Spotify's consent screen
const stateKey = (state: string) => `spotify:oauth:state:${state}`;

const spotifyRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const service = new SpotifyService(fastify.prisma, fastify.redis, fastify.log);

  // ── GET /api/spotify/connect ──────────────────────────────────────────────
  // A full-page navigation (the user clicks "Connect Spotify"), not an XHR.
  // request.userId comes off the normal auth cookie, which is present here
  // (same-site click) but must NOT be relied on to survive the round trip
  // through accounts.spotify.com — the app sets cookies SameSite=strict, which
  // a cross-site redirect back from Spotify can drop. `state` carries the
  // identity across that gap instead (see /callback) and doubles as the CSRF
  // token.
  fastify.get(
    "/spotify/connect",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      if (!isSpotifyConfigured()) {
        return reply.redirect(`${env.WEB_ORIGIN}/profile?spotify=error&reason=not_configured`);
      }
      const state = randomBytes(24).toString("hex");
      await fastify.redis.set(stateKey(state), request.userId!, "EX", STATE_TTL_S);
      return reply.redirect(service.buildAuthorizeUrl(state));
    },
  );

  // ── GET /api/spotify/callback ─────────────────────────────────────────────
  fastify.get(
    "/spotify/callback",
    {
      schema: {
        querystring: Type.Object({
          code:  Type.Optional(Type.String()),
          state: Type.Optional(Type.String()),
          error: Type.Optional(Type.String()),
        }),
      },
    },
    async (request, reply) => {
      const { code, state, error } = request.query;
      const fail = (reason: string) =>
        reply.redirect(`${env.WEB_ORIGIN}/profile?spotify=error&reason=${reason}`);

      if (error) return fail("denied");
      if (!code || !state) return fail("missing_params");

      const userId = await fastify.redis.get(stateKey(state));
      if (!userId) return fail("invalid_state");
      await fastify.redis.del(stateKey(state)); // one-time use — no replay

      try {
        await service.connect(userId, code);
      } catch (err) {
        fastify.log.warn({ err, userId }, "[spotify] callback token exchange failed");
        return fail("exchange_failed");
      }

      return reply.redirect(`${env.WEB_ORIGIN}/profile?spotify=connected`);
    },
  );

  // ── DELETE /api/spotify/disconnect ────────────────────────────────────────
  // Only removes Relay's copy of the tokens. Spotify has no API for a third
  // party to revoke its own grant server-side — the user's Spotify account
  // will still list Relay under Settings → Apps until they remove it there
  // themselves; the frontend disconnect confirmation says so explicitly.
  fastify.delete(
    "/spotify/disconnect",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      await service.disconnect(request.userId!);
      return reply.code(204).send();
    },
  );

  // ── GET /api/spotify/status ────────────────────────────────────────────────
  // Self-only. Powers the settings UI (connect/disconnect button state, the
  // showOnProfile toggle) — distinct from the public badge endpoint below,
  // which deliberately can't tell "off" from "never connected".
  fastify.get(
    "/spotify/status",
    {
      preHandler: [fastify.authenticate],
      schema: { response: { 200: SpotifyConnectionStatusSchema } },
    },
    async (request) => service.getStatus(request.userId!),
  );

  // ── PATCH /api/spotify/preferences ────────────────────────────────────────
  fastify.patch(
    "/spotify/preferences",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body:     UpdateSpotifyPreferencesPayloadSchema,
        response: { 200: SpotifyConnectionStatusSchema },
      },
    },
    async (request) => {
      try {
        await service.setShowOnProfile(request.userId!, request.body.showOnProfile);
      } catch (err) {
        if (err instanceof SpotifyNotConnectedError) {
          throw new ProblemError("not_found", "Spotify is not connected.");
        }
        throw err;
      }
      return service.getStatus(request.userId!);
    },
  );

  // ── GET /api/users/:userId/spotify ────────────────────────────────────────
  // Public-facing: any authenticated user can view another's badge. Privacy
  // is enforced entirely inside SpotifyService.getBadgeForUser — showOnProfile
  // off, never connected, and "nothing in the last 24h" all collapse to the
  // same `spotify: null`, so a viewer can't distinguish which case it is.
  fastify.get(
    "/users/:userId/spotify",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params:   Type.Object({ userId: Type.String({ format: "uuid" }) }),
        response: { 200: SpotifyBadgeResponseSchema },
      },
    },
    async (request) => {
      const spotify = await service.getBadgeForUser(request.params.userId);
      return { spotify };
    },
  );
};

export default spotifyRoutes;
