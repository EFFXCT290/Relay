// CONTRACT CATEGORY: identity
// Contracts define SHAPE, never behavior. No functions, no classes, no
// branching logic. Only: TypeBox schemas, Static-derived types, and protocol
// constants. If you need behavior, put it in a service.
import { Type, type Static } from "@sinclair/typebox";

// ── Types ─────────────────────────────────────────────────────────────────────
export type AuthUser = Static<typeof AuthUserSchema>;
export type LoginPayload = Static<typeof LoginPayloadSchema>;
export type RegisterPayload = Static<typeof RegisterPayloadSchema>;

// ── Schemas ───────────────────────────────────────────────────────────────────
export const AuthUserSchema = Type.Object({
  userId:      Type.String({ format: "uuid" }),
  username:    Type.String(),
  displayName: Type.String(),
  avatarUrl:   Type.Optional(Type.String()),
  createdAt:   Type.String({ format: "date-time" }),
});

export const LoginPayloadSchema = Type.Object({
  username: Type.String({ minLength: 3 }),
  password: Type.String({ minLength: 8 }),
});

export const RegisterPayloadSchema = Type.Object({
  username:    Type.String({ minLength: 3, maxLength: 30 }),
  displayName: Type.String({ minLength: 1, maxLength: 50 }),
  password:    Type.String({ minLength: 8 }),
});

// ── JWT ──────────────────────────────────────────────────────────────────────
// Crosses the auth boundary (signed by api, decoded by api + future consumers).
// Lives here, not in any app's types.ts, per "contracts are the REAL API layer".
export type JwtPayload = {
  sub: string;  // userId
  jti: string;  // unique token id (for blocklisting / refresh rotation)
  iat: number;
  exp: number;
};
