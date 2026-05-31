import { type Static } from "@sinclair/typebox";
export type AuthUser = Static<typeof AuthUserSchema>;
export type LoginPayload = Static<typeof LoginPayloadSchema>;
export type RegisterPayload = Static<typeof RegisterPayloadSchema>;
export declare const AuthUserSchema: import("@sinclair/typebox").TObject<{
    userId: import("@sinclair/typebox").TString;
    username: import("@sinclair/typebox").TString;
    displayName: import("@sinclair/typebox").TString;
    avatarUrl: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    createdAt: import("@sinclair/typebox").TString;
}>;
export declare const LoginPayloadSchema: import("@sinclair/typebox").TObject<{
    username: import("@sinclair/typebox").TString;
    password: import("@sinclair/typebox").TString;
}>;
export declare const RegisterPayloadSchema: import("@sinclair/typebox").TObject<{
    username: import("@sinclair/typebox").TString;
    displayName: import("@sinclair/typebox").TString;
    password: import("@sinclair/typebox").TString;
}>;
export type JwtPayload = {
    sub: string;
    jti: string;
    iat: number;
    exp: number;
};
