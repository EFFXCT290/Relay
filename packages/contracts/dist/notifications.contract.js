// CONTRACT CATEGORY: domain
import { Type } from "@sinclair/typebox";
// ─────────────────────────────────────────────────────────────────────────────
// Notification source of truth. Payload is intentionally an open record —
// each notification `type` has its own payload variant the UI narrows on.
// Adding a new type? Add the variant here, not in a feature file.
// ─────────────────────────────────────────────────────────────────────────────
export const NotificationTypeSchema = Type.Union([
    Type.Literal("SYSTEM_ALERT"),
    Type.Literal("MESSAGE_RECEIVED"),
    Type.Literal("VIEW_COUNT_UPDATE"),
    Type.Literal("MEDIA_EXPIRED"),
]);
export const NotificationSchema = Type.Object({
    notificationId: Type.String({ format: "uuid" }),
    type: Type.String(), // NotificationType in practice; widened for forward-compat
    isRead: Type.Boolean(),
    payload: Type.Record(Type.String(), Type.Unknown()),
    createdAt: Type.String({ format: "date-time" }),
});
// ── Socket event names ───────────────────────────────────────────────────────
export const NOTIFICATION_EVENTS = {
    NEW: "notification:new",
};
