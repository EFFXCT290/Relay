import { Type, type Static } from "@sinclair/typebox";

// Username — server-side regex matches the spec (3–30 chars, alphanumeric + underscore)
export const UsernameSchema = Type.String({
  minLength: 3,
  maxLength: 30,
  pattern: "^[A-Za-z0-9_]+$",
  description: "Alphanumeric and underscores, 3–30 chars.",
});

export const PasswordSchema = Type.String({
  minLength: 12,
  maxLength: 256,
});

export const CredentialsSchema = Type.Object({
  username: UsernameSchema,
  password: PasswordSchema,
});
export type Credentials = Static<typeof CredentialsSchema>;

export const AuthSuccessSchema = Type.Object({
  userId: Type.String({ format: "uuid" }),
  username: Type.String(),
});

export const MeSchema = Type.Object({
  userId: Type.String({ format: "uuid" }),
  username: Type.String(),
  createdAt: Type.String({ format: "date-time" }),
});
