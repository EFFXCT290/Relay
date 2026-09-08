// CONTRACT CATEGORY: domain
import { Type, type Static } from "@sinclair/typebox";

// ─────────────────────────────────────────────────────────────────────────────
// Private, per-owner nicknames for a conversation partner (see
// apps/api/src/modules/nicknames/). Two directions:
//   - "my nickname for them" — private by default, only ever visible to the
//     owner, rides along on the conversation participant payloads
//     (ConversationParticipantSchema.nickname in conversations.contract.ts).
//   - "their nickname for me" — only surfaces at all once the owner opts in
//     via sharedWithTarget, via the sharedNicknameForMe field on the
//     conversation-detail response and the user:nickname-shared-updated event.
// ─────────────────────────────────────────────────────────────────────────────

// ── GET/PUT /api/users/:userId/nickname (my nickname for that user) ─────────
export const NicknameInfoSchema = Type.Object({
  nickname:         Type.Union([Type.String(), Type.Null()]),
  sharedWithTarget: Type.Boolean(),
});
export type NicknameInfo = Static<typeof NicknameInfoSchema>;

export const SetNicknamePayloadSchema = Type.Object({
  nickname:         Type.String({ minLength: 1, maxLength: 60 }),
  sharedWithTarget: Type.Boolean(),
});
export type SetNicknamePayload = Static<typeof SetNicknamePayloadSchema>;

// ── Socket event names ───────────────────────────────────────────────────────
export const USER_NICKNAME_EVENTS = {
  // → target user only (not a shared-conversations broadcast like
  // user:profile-updated — nickname sharing is a strict one-to-one owner→
  // target relationship). Fires whenever the EFFECTIVE value the target can
  // see changes: sharing turned on, sharing turned off, or the nickname text
  // changed while already shared. nickname: null covers both "never shared"
  // and "unshared/cleared" — the target never needed to tell those apart.
  SHARED_UPDATED: "user:nickname-shared-updated",
} as const;
export type UserNicknameEventName = (typeof USER_NICKNAME_EVENTS)[keyof typeof USER_NICKNAME_EVENTS];

// ── Socket event payloads ────────────────────────────────────────────────────
export type UserNicknameSharedUpdatedEvent = {
  ownerId:  string;
  nickname: string | null;
};
