import { type Static } from "@sinclair/typebox";
export declare const EventEnvelopeSchema: import("@sinclair/typebox").TObject<{
    eventId: import("@sinclair/typebox").TString;
    eventName: import("@sinclair/typebox").TString;
    payload: import("@sinclair/typebox").TUnknown;
    timestamp: import("@sinclair/typebox").TString;
    attempts: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
}>;
export type EventEnvelope<T = unknown> = Omit<Static<typeof EventEnvelopeSchema>, "payload"> & {
    payload: T;
};
export declare const AckSchema: import("@sinclair/typebox").TObject<{
    eventId: import("@sinclair/typebox").TString;
    status: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"ok">, import("@sinclair/typebox").TLiteral<"error">]>;
    error: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        code: import("@sinclair/typebox").TString;
        message: import("@sinclair/typebox").TString;
    }>>;
}>;
export type Ack = Static<typeof AckSchema>;
export declare const ACK_EVENT: "ack";
export declare const ACK_TIMEOUT_MS = 5000;
export declare const ACK_MAX_ATTEMPTS = 3;
export declare const ACK_BACKOFF_BASE = 500;
export declare const DEDUP_WINDOW = 1024;
export declare const SYNC_EVENTS: {
    readonly REPLAY_REQUEST: "sync:replay-request";
    readonly REPLAY_RESPONSE: "sync:replay-response";
};
export type SyncEventName = (typeof SYNC_EVENTS)[keyof typeof SYNC_EVENTS];
export declare const ReplayRequestSchema: import("@sinclair/typebox").TObject<{
    since: import("@sinclair/typebox").TString;
    limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
    conversationId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export type ReplayRequest = Static<typeof ReplayRequestSchema>;
export type ReplayResponse = {
    events: EventEnvelope[];
    nextCursor: string | null;
};
