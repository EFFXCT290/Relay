// CONTRACT CATEGORY: domain
import { Type } from "@sinclair/typebox";
// ── Web Push subscription (POST/DELETE /api/push/subscriptions) ────────────
// The shape browser PushSubscription.toJSON() hands us, and exactly what
// web-push needs. additionalProperties stays open so we persist whatever the
// browser sends verbatim (future-proof) — only the fields web-push actually
// needs are pinned here.
export const WebPushSubscriptionSchema = Type.Object({
    endpoint: Type.String({ minLength: 1, maxLength: 2048 }),
    expirationTime: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    keys: Type.Object({ p256dh: Type.String(), auth: Type.String() }),
}, { additionalProperties: true });
// ── Notification preferences (GET/PATCH /api/push/preferences) ─────────────
export const PushPreferencesSchema = Type.Object({
    pushMessages: Type.Boolean(),
    pushCalls: Type.Boolean(),
});
// ── VAPID public key (GET /api/push/vapid-public-key) ───────────────────────
export const VapidPublicKeyResponseSchema = Type.Object({
    publicKey: Type.String(),
});
