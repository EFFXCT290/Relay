import { type Static } from "@sinclair/typebox";
export declare const NicknameInfoSchema: import("@sinclair/typebox").TObject<{
    nickname: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
    sharedWithTarget: import("@sinclair/typebox").TBoolean;
}>;
export type NicknameInfo = Static<typeof NicknameInfoSchema>;
export declare const SetNicknamePayloadSchema: import("@sinclair/typebox").TObject<{
    nickname: import("@sinclair/typebox").TString;
    sharedWithTarget: import("@sinclair/typebox").TBoolean;
}>;
export type SetNicknamePayload = Static<typeof SetNicknamePayloadSchema>;
export declare const USER_NICKNAME_EVENTS: {
    readonly SHARED_UPDATED: "user:nickname-shared-updated";
};
export type UserNicknameEventName = (typeof USER_NICKNAME_EVENTS)[keyof typeof USER_NICKNAME_EVENTS];
export type UserNicknameSharedUpdatedEvent = {
    ownerId: string;
    nickname: string | null;
};
