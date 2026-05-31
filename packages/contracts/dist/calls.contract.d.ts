import { type Static } from "@sinclair/typebox";
export type CallType = "AUDIO" | "VIDEO";
export type CallStatus = "RINGING" | "ANSWERED" | "MISSED" | "REJECTED" | "FAILED" | "ENDED";
export type CallDirection = "incoming" | "outgoing";
export declare const CALL_RING_TIMEOUT_MS = 30000;
export declare const CALL_EVENTS: {
    readonly INIT: "call:init";
    readonly ACCEPT: "call:accept";
    readonly REJECT: "call:reject";
    readonly OFFER: "call:offer";
    readonly ANSWER: "call:answer";
    readonly ICE: "call:ice-candidate";
    readonly END: "call:end";
    readonly MEDIA_STATE: "call:media-state";
    readonly RINGING: "call:ringing";
    readonly ACCEPTED: "call:accepted";
    readonly BUSY: "call:busy";
    readonly TIMEOUT: "call:timeout";
    readonly ENDED: "call:ended";
    readonly FAILED: "call:failed";
    readonly PEER_MEDIA_STATE: "call:peer-media-state";
};
export type CallEventName = (typeof CALL_EVENTS)[keyof typeof CALL_EVENTS];
export type CallInitInbound = {
    targetUserId: string;
    type: CallType;
    conversationId?: string;
};
export type CallByIdInbound = {
    callId: string;
};
export type CallSdpInbound = {
    callId: string;
    sdp: RTCSessionDescriptionInitLike;
};
export type CallIceInbound = {
    callId: string;
    candidate: RTCIceCandidateInitLike;
};
export type CallMediaStateInbound = {
    callId: string;
    cameraOn: boolean;
};
export type CallInitAck = {
    ok: true;
    callId: string;
} | {
    ok: false;
    reason: "self" | "offline" | "busy" | "not_found" | "error";
};
export type CallRingingEvent = {
    callId: string;
    caller: {
        id: string;
        username: string;
    };
    type: CallType;
    conversationId?: string;
};
export type CallAcceptedEvent = {
    callId: string;
};
export type CallSdpEvent = {
    callId: string;
    sdp: RTCSessionDescriptionInitLike;
};
export type CallIceEvent = {
    callId: string;
    candidate: RTCIceCandidateInitLike;
};
export type CallBusyEvent = {
    callId: string;
};
export type CallTimeoutEvent = {
    callId: string;
};
export type CallEndedEvent = {
    callId: string;
    status: CallStatus;
};
export type CallFailedEvent = {
    callId: string;
};
export type CallPeerMediaStateEvent = {
    callId: string;
    cameraOn: boolean;
};
export type RTCSessionDescriptionInitLike = {
    type: "offer" | "answer";
    sdp?: string;
};
export type RTCIceCandidateInitLike = {
    candidate?: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
    usernameFragment?: string | null;
};
export type CallHistoryItem = {
    id: string;
    direction: CallDirection;
    otherUser: {
        id: string;
        username: string;
    };
    type: CallType;
    status: CallStatus;
    durationSec: number;
    createdAt: string;
};
export declare const CallHistoryItemSchema: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
    direction: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"incoming">, import("@sinclair/typebox").TLiteral<"outgoing">]>;
    otherUser: import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        username: import("@sinclair/typebox").TString;
    }>;
    type: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"AUDIO">, import("@sinclair/typebox").TLiteral<"VIDEO">]>;
    status: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"RINGING">, import("@sinclair/typebox").TLiteral<"ANSWERED">, import("@sinclair/typebox").TLiteral<"MISSED">, import("@sinclair/typebox").TLiteral<"REJECTED">, import("@sinclair/typebox").TLiteral<"FAILED">, import("@sinclair/typebox").TLiteral<"ENDED">]>;
    durationSec: import("@sinclair/typebox").TInteger;
    createdAt: import("@sinclair/typebox").TString;
}>;
export declare const CallHistoryResponseSchema: import("@sinclair/typebox").TObject<{
    calls: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        direction: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"incoming">, import("@sinclair/typebox").TLiteral<"outgoing">]>;
        otherUser: import("@sinclair/typebox").TObject<{
            id: import("@sinclair/typebox").TString;
            username: import("@sinclair/typebox").TString;
        }>;
        type: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"AUDIO">, import("@sinclair/typebox").TLiteral<"VIDEO">]>;
        status: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"RINGING">, import("@sinclair/typebox").TLiteral<"ANSWERED">, import("@sinclair/typebox").TLiteral<"MISSED">, import("@sinclair/typebox").TLiteral<"REJECTED">, import("@sinclair/typebox").TLiteral<"FAILED">, import("@sinclair/typebox").TLiteral<"ENDED">]>;
        durationSec: import("@sinclair/typebox").TInteger;
        createdAt: import("@sinclair/typebox").TString;
    }>>;
}>;
export type CallHistoryResponse = Static<typeof CallHistoryResponseSchema>;
