// CONTRACT CATEGORY: identity
import { Type, type Static } from "@sinclair/typebox";

export type User = Static<typeof UserSchema>;
export type UpdateProfilePayload = Static<typeof UpdateProfilePayloadSchema>;
export type AvatarResponse = Static<typeof AvatarResponseSchema>;

export const UserSchema = Type.Object({
  userId:      Type.String({ format: "uuid" }),
  username:    Type.String(),
  displayName: Type.String(),
  avatarUrl:   Type.Optional(Type.String()),
  isOnline:    Type.Optional(Type.Boolean()),
});

export const UpdateProfilePayloadSchema = Type.Object({
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
  avatarUrl:   Type.Optional(Type.String()),
});

// ── Avatar ─────────────────────────────────────────────────────────────────
// Response from POST /api/users/me/avatar. avatarUrl is a freshly-signed,
// short-lived URL for the just-uploaded image; null after a DELETE.
export const AvatarResponseSchema = Type.Object({
  avatarUrl: Type.Union([Type.String(), Type.Null()]),
});

// ── Socket event names ───────────────────────────────────────────────────────
export const USER_EVENTS = {
  PROFILE_UPDATED: "user:profile-updated", // server → users who share a conversation (+ uploader's other tabs)
} as const;
export type UserEventName = (typeof USER_EVENTS)[keyof typeof USER_EVENTS];

// ── Socket event payloads ────────────────────────────────────────────────────
// user:profile-updated — a user changed their avatar. avatarUrl is a signed URL
// (or null when cleared); recipients swap it in immediately. The URL expires on
// the normal media-signing schedule, by which point a fresh fetch supersedes it.
export type UserProfileUpdatedEvent = { userId: string; avatarUrl: string | null };
