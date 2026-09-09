import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { ProblemError } from "../../backend-core/http/errors.js";
import { env } from "../../backend-core/runtime/env.js";
import {
  PushPreferencesSchema,
  VapidPublicKeyResponseSchema,
  WebPushSubscriptionSchema,
} from "@relay/contracts";
import { PushRepository, type WebPushSubscription } from "./push.repository.js";
import { pushQueue, SEND_PUSH_JOB } from "../../queues/push.queue.js";
import type { PushPayload } from "./push.service.js";

const pushRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const repo = new PushRepository(fastify.prisma);

  // ── GET /api/push/vapid-public-key ───────────────────────────────────────
  // Public (it IS the public key); the global rate-limit still applies. The web
  // client normally reads the key from /runtime-env.js — this is a fallback.
  fastify.get(
    "/push/vapid-public-key",
    { schema: { response: { 200: VapidPublicKeyResponseSchema } } },
    async () => ({ publicKey: env.VAPID_PUBLIC_KEY }),
  );

  // ── POST /api/push/subscriptions ─────────────────────────────────────────
  fastify.post(
    "/push/subscriptions",
    {
      preHandler: [fastify.authenticate],
      schema: { body: WebPushSubscriptionSchema },
    },
    async (request, reply) => {
      const sub = request.body as WebPushSubscription;
      // No provider-host allowlist (maintenance debt): require https + a sane
      // length and let web-push + 404/410 pruning be the real validity guard.
      let host: URL;
      try {
        host = new URL(sub.endpoint);
      } catch {
        throw new ProblemError("validation_error", "Invalid push endpoint URL.");
      }
      if (host.protocol !== "https:") {
        throw new ProblemError("validation_error", "Push endpoint must be https.");
      }

      const userAgent = request.headers["user-agent"] ?? null;
      await repo.upsert(request.userId!, sub, userAgent);
      return reply.code(201).send();
    },
  );

  // ── DELETE /api/push/subscriptions?endpoint=... ──────────────────────────
  // A subscription has no client-facing id — the browser's PushSubscription
  // object only ever exposes its `endpoint` URL, which is also the DB's
  // unique key (see push.repository.ts's upsert). That rules out a path
  // segment (`endpoint` is a full URL up to 2048 chars — embedding one verbatim
  // as a path segment means URL-encoding its own "/", which nginx and other
  // reverse proxies routinely mishandle/reject ahead of routing); a query
  // param carries it with no such ambiguity, the same way every other
  // identify-by-opaque-string case in this API (q, cursor) already does.
  fastify.delete(
    "/push/subscriptions",
    {
      preHandler: [fastify.authenticate],
      schema: { querystring: Type.Object({ endpoint: Type.String({ minLength: 1, maxLength: 2048 }) }) },
    },
    async (request, reply) => {
      await repo.deleteByEndpoint(request.userId!, request.query.endpoint);
      return reply.code(204).send();
    },
  );

  // ── GET /api/push/preferences ────────────────────────────────────────────
  fastify.get(
    "/push/preferences",
    {
      preHandler: [fastify.authenticate],
      schema: { response: { 200: PushPreferencesSchema } },
    },
    async (request) => {
      const prefs = await repo.getPreferences(request.userId!);
      return prefs ?? { pushMessages: true, pushCalls: true };
    },
  );

  // ── PATCH /api/push/preferences ──────────────────────────────────────────
  fastify.patch(
    "/push/preferences",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body:     Type.Partial(PushPreferencesSchema),
        response: { 200: PushPreferencesSchema },
      },
    },
    async (request) => {
      await repo.setPreferences(request.userId!, request.body);
      const prefs = await repo.getPreferences(request.userId!);
      return prefs ?? { pushMessages: true, pushCalls: true };
    },
  );

  // ── POST /api/push/test ──────────────────────────────────────────────────
  // Enqueues a push to the caller's own devices through the real worker path —
  // the smoke test to run before wiring message/call notifications.
  fastify.post(
    "/push/test",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const payload: PushPayload = {
        v:     1,
        type:  "test",
        title: "Relay",
        body:  "Push notifications are working.",
        url:   "/conversations",
        tag:   "relay-test",
      };
      await pushQueue.add(SEND_PUSH_JOB, { userId: request.userId!, payload });
      return reply.code(202).send();
    },
  );
};

export default pushRoutes;
