import { type Static } from "@sinclair/typebox";
export declare const TypingPayloadSchema: import("@sinclair/typebox").TObject<{
    conversationId: import("@sinclair/typebox").TString;
}>;
export type TypingPayload = Static<typeof TypingPayloadSchema>;
export declare const TYPING_EVENTS: {
    readonly START: "typing:start";
    readonly STOP: "typing:stop";
    readonly UPDATE: "typing:update";
    readonly SYNC_REQUEST: "typing:sync-request";
    readonly SYNC_RESPONSE: "typing:sync-response";
};
export type TypingEventName = (typeof TYPING_EVENTS)[keyof typeof TYPING_EVENTS];
export declare const TYPING_DEBOUNCE_MS = 2500;
export declare const TYPING_TIMEOUT_MS = 5000;
export declare const TYPING_SWEEP_INTERVAL_MS = 1000;
export type TypingInbound = TypingPayload;
export type TypingUpdateEvent = {
    conversationId: string;
    userId: string;
    isTyping: boolean;
};
export type TypingSyncRequest = {
    conversationIds: string[];
};
export type TypingSyncResponse = {
    active: Record<string, string[]>;
};
