import { type Static } from "@sinclair/typebox";
export declare const ConversationParticipantSchema: import("@sinclair/typebox").TObject<{
    userId: import("@sinclair/typebox").TString;
    username: import("@sinclair/typebox").TString;
    isOnline: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    lastSeenAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
}>;
export declare const ConversationLastMessageSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TNull, import("@sinclair/typebox").TObject<{
    messageId: import("@sinclair/typebox").TString;
    type: import("@sinclair/typebox").TString;
    preview: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
    sentAt: import("@sinclair/typebox").TString;
}>]>;
export declare const ConversationListItemSchema: import("@sinclair/typebox").TObject<{
    conversationId: import("@sinclair/typebox").TString;
    participant: import("@sinclair/typebox").TObject<{
        userId: import("@sinclair/typebox").TString;
        username: import("@sinclair/typebox").TString;
        isOnline: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        lastSeenAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    }>;
    lastMessage: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TNull, import("@sinclair/typebox").TObject<{
        messageId: import("@sinclair/typebox").TString;
        type: import("@sinclair/typebox").TString;
        preview: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
        sentAt: import("@sinclair/typebox").TString;
    }>]>;
    unreadCount: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
    isTyping: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    captureAlert: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    updatedAt: import("@sinclair/typebox").TString;
}>;
export type ConversationListItem = Static<typeof ConversationListItemSchema>;
export declare const ConversationSchema: import("@sinclair/typebox").TObject<{
    conversationId: import("@sinclair/typebox").TString;
    participants: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        userId: import("@sinclair/typebox").TString;
        username: import("@sinclair/typebox").TString;
        isOnline: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        lastSeenAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    }>>;
    lastMessage: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TNull, import("@sinclair/typebox").TObject<{
        messageId: import("@sinclair/typebox").TString;
        type: import("@sinclair/typebox").TString;
        preview: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
        sentAt: import("@sinclair/typebox").TString;
    }>]>>;
    unreadCount: import("@sinclair/typebox").TNumber;
    createdAt: import("@sinclair/typebox").TString;
}>;
export type Conversation = Static<typeof ConversationSchema>;
export declare const CreateConversationPayloadSchema: import("@sinclair/typebox").TObject<{
    participantId: import("@sinclair/typebox").TString;
}>;
export type CreateConversationPayload = Static<typeof CreateConversationPayloadSchema>;
export declare const CONVERSATION_EVENTS: {
    readonly CREATE: "conversation:create";
    readonly READ: "conversation:read";
    readonly JOIN: "conversation:join";
    readonly LEAVE: "conversation:leave";
    readonly REQUEST: "conversation:request";
    readonly ACCEPTED: "conversation:accepted";
    readonly DELETED: "conversation:deleted";
};
export type ConversationEventName = (typeof CONVERSATION_EVENTS)[keyof typeof CONVERSATION_EVENTS];
export type ConversationCreateInbound = CreateConversationPayload;
export type ConversationReadInbound = {
    conversationId: string;
};
export type ConversationJoinInbound = {
    conversationId: string;
};
export type ConversationLeaveInbound = {
    conversationId: string;
};
export type ConversationRequestEvent = {
    conversationId: string;
    from: {
        userId: string;
        username: string;
    };
    createdAt: string;
};
export type ConversationAcceptedEvent = {
    conversationId: string;
    acceptedBy: string;
    acceptedAt: string;
};
export type ConversationDeletedEvent = {
    conversationId: string;
};
