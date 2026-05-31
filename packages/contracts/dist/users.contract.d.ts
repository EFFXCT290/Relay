import { type Static } from "@sinclair/typebox";
export type User = Static<typeof UserSchema>;
export type UpdateProfilePayload = Static<typeof UpdateProfilePayloadSchema>;
export declare const UserSchema: import("@sinclair/typebox").TObject<{
    userId: import("@sinclair/typebox").TString;
    username: import("@sinclair/typebox").TString;
    displayName: import("@sinclair/typebox").TString;
    avatarUrl: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    isOnline: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
}>;
export declare const UpdateProfilePayloadSchema: import("@sinclair/typebox").TObject<{
    displayName: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    avatarUrl: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
