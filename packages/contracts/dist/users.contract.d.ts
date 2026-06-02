import { type Static } from "@sinclair/typebox";
export type User = Static<typeof UserSchema>;
export type UpdateProfilePayload = Static<typeof UpdateProfilePayloadSchema>;
export type AvatarResponse = Static<typeof AvatarResponseSchema>;
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
export declare const AvatarResponseSchema: import("@sinclair/typebox").TObject<{
    avatarUrl: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
}>;
export declare const USER_EVENTS: {
    readonly PROFILE_UPDATED: "user:profile-updated";
};
export type UserEventName = (typeof USER_EVENTS)[keyof typeof USER_EVENTS];
export type UserProfileUpdatedEvent = {
    userId: string;
    avatarUrl: string | null;
};
