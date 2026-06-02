// CONTRACT CATEGORY: identity
import { Type } from "@sinclair/typebox";
export const UserSchema = Type.Object({
    userId: Type.String({ format: "uuid" }),
    username: Type.String(),
    displayName: Type.String(),
    avatarUrl: Type.Optional(Type.String()),
    isOnline: Type.Optional(Type.Boolean()),
});
export const UpdateProfilePayloadSchema = Type.Object({
    displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
    avatarUrl: Type.Optional(Type.String()),
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
};
