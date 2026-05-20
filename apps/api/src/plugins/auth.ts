import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { ACCESS_COOKIE } from "../backend-core/auth/cookies.js";
import { ProblemError } from "../backend-core/http/errors.js";
import { isBlocklisted, verifyAccessToken } from "../backend-core/auth/tokens.js";

// Adds fastify.authenticate(request) — a verifier you call in route preHandlers.
// On success, sets request.userId and request.accessJti.
export default fp(async (fastify) => {
  async function authenticate(request: FastifyRequest): Promise<void> {
    const token = request.cookies[ACCESS_COOKIE];
    if (!token) throw new ProblemError("unauthorized", "Access token is missing.");

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch {
      throw new ProblemError("unauthorized", "Access token is invalid or expired.");
    }

    if (await isBlocklisted(fastify.redis, payload.jti)) {
      throw new ProblemError("unauthorized", "Access token has been revoked.");
    }

    request.userId = payload.sub;
    request.accessJti = payload.jti;
  }

  fastify.decorate("authenticate", authenticate);
});
