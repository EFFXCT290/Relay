import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { ProblemError } from "../../backend-core/http/errors.js";
import { env } from "../../backend-core/runtime/env.js";
import { PushRepository, type WebPushSubscription } from "./push.repository.js";
import { pushQueue, SEND_PUSH_JOB } from "../../queues/push.queue.js";
import type { PushPayload } from "./push.service.js";

// The browser's PushSubscription.toJSON() shape. additionalProperties is left
// open so we persist whatever the browser sends verbatim (future-proof) — we
// only pin the fields web-push actually needs.
const SubscriptionSchema = Type.Object(
  {
    endpoint:       Type.String({ minLength: 1, maxLength: 2048 }),
    expirationTime: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    keys:           Type.Object({ p256dh: Type.String(), auth: Type.String() }),
  },
  { additionalProperties: true },
);

const PreferencesSchema = Type.Object({
  pushMessages: Type.Boolean(),
  pushCalls:    Type.Boolean(),
});

const pushRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const repo = new PushRepository(fastify.prisma);

  // ── GET /api/push/vapid-public-key ───────────────────────────────────────
  // Public (it IS the public key); the global rate-limit still applies. The web
  // client normally reads the key from /runtime-env.js — this is a fallback.
  fastify.get(
    "/push/vapid-public-key",
    { schema: { response: { 200: Type.Object({ publicKey: Type.String() }) } } },
    async () => ({ publicKey: env.VAPID_PUBLIC_KEY }),
  );

  // ── POST /api/push/subscribe ─────────────────────────────────────────────
  fastify.post(
    "/push/subscribe",
    {
      preHandler: [fastify.authenticate],
      schema: { body: SubscriptionSchema },
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

  // ── DELETE /api/push/subscribe ───────────────────────────────────────────
  fastify.delete(
    "/push/subscribe",
    {
      preHandler: [fastify.authenticate],
      schema: { body: Type.Object({ endpoint: Type.String({ minLength: 1, maxLength: 2048 }) }) },
    },
    async (request, reply) => {
      await repo.deleteByEndpoint(request.userId!, request.body.endpoint);
      return reply.code(204).send();
    },
  );

  // ── GET /api/push/preferences ────────────────────────────────────────────
  fastify.get(
    "/push/preferences",
    {
      preHandler: [fastify.authenticate],
      schema: { response: { 200: PreferencesSchema } },
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
        body:     Type.Partial(PreferencesSchema),
        response: { 200: PreferencesSchema },
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
