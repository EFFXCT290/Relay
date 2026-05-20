// CONTRACT CATEGORY: domain
import { Type, type Static } from "@sinclair/typebox";

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
export type NotificationType = Static<typeof NotificationTypeSchema>;

// All known payload variants. Components narrow on `notification.type` and
// pick the matching variant. Unknown types still type-check against the index
// signature, so the runtime is forward-compatible.
export type NotificationPayload = {
  capturedBy?:    { userId: string; username: string };
  eventType?:     "SCREENSHOT_ATTEMPT" | "RECORD_ATTEMPT";
  trigger?:       string;
  timestamp?:     string;
  mediaId?:       string;
  thumbnailUrl?:  string;
  userAgent?:     string;
  platform?:      string;
  viewer?:        { userId: string; username: string };
  viewsUsed?:     number;
  viewsAllowed?:  number;
  messageId?:     string;
  recipient?:     { userId: string; username: string };
  expiredAt?:     string;
  from?:          { userId: string; username: string };
  preview?:       string;
} & Record<string, unknown>;

export const NotificationSchema = Type.Object({
  notificationId: Type.String({ format: "uuid" }),
  type:           Type.String(),  // NotificationType in practice; widened for forward-compat
  isRead:         Type.Boolean(),
  payload:        Type.Record(Type.String(), Type.Unknown()),
  createdAt:      Type.String({ format: "date-time" }),
});

// Hand-written to keep the typed payload union — TypeBox's `Static` widens
// the payload to a plain Record, which loses the variant typing UIs rely on.
export type Notification = {
  notificationId: string;
  type:           NotificationType | string;
  isRead:         boolean;
  payload:        NotificationPayload;
  createdAt:      string;
};

// ── Socket event names ───────────────────────────────────────────────────────
export const NOTIFICATION_EVENTS = {
  NEW: "notification:new",
} as const;
export type NotificationEventName = (typeof NOTIFICATION_EVENTS)[keyof typeof NOTIFICATION_EVENTS];

// ── Socket event payloads ────────────────────────────────────────────────────
export type NotificationNewEvent = { notification: Notification };
