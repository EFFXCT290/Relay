import { type Static } from "@sinclair/typebox";
export declare const WebPushSubscriptionSchema: import("@sinclair/typebox").TObject<{
    endpoint: import("@sinclair/typebox").TString;
    expirationTime: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TNumber, import("@sinclair/typebox").TNull]>>;
    keys: import("@sinclair/typebox").TObject<{
        p256dh: import("@sinclair/typebox").TString;
        auth: import("@sinclair/typebox").TString;
    }>;
}>;
export type WebPushSubscriptionPayload = Static<typeof WebPushSubscriptionSchema>;
export declare const PushPreferencesSchema: import("@sinclair/typebox").TObject<{
    pushMessages: import("@sinclair/typebox").TBoolean;
    pushCalls: import("@sinclair/typebox").TBoolean;
}>;
export type PushPreferencesPayload = Static<typeof PushPreferencesSchema>;
export declare const VapidPublicKeyResponseSchema: import("@sinclair/typebox").TObject<{
    publicKey: import("@sinclair/typebox").TString;
}>;
export type VapidPublicKeyResponse = Static<typeof VapidPublicKeyResponseSchema>;
