// CONTRACT CATEGORY: identity
import { Type, type Static } from "@sinclair/typebox";

export type User = Static<typeof UserSchema>;
export type UpdateProfilePayload = Static<typeof UpdateProfilePayloadSchema>;

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
