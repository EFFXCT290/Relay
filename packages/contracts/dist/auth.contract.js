// CONTRACT CATEGORY: identity
// Contracts define SHAPE, never behavior. No functions, no classes, no
// branching logic. Only: TypeBox schemas, Static-derived types, and protocol
// constants. If you need behavior, put it in a service.
import { Type } from "@sinclair/typebox";
// ── Schemas ───────────────────────────────────────────────────────────────────
export const AuthUserSchema = Type.Object({
    userId: Type.String({ format: "uuid" }),
    username: Type.String(),
    displayName: Type.String(),
    avatarUrl: Type.Optional(Type.String()),
    createdAt: Type.String({ format: "date-time" }),
});
export const LoginPayloadSchema = Type.Object({
    username: Type.String({ minLength: 3 }),
    password: Type.String({ minLength: 8 }),
});
export const RegisterPayloadSchema = Type.Object({
    username: Type.String({ minLength: 3, maxLength: 30 }),
    displayName: Type.String({ minLength: 1, maxLength: 50 }),
    password: Type.String({ minLength: 8 }),
});
