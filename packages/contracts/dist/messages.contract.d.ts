import { type Static } from "@sinclair/typebox";
export declare const ReplyToSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TNull, import("@sinclair/typebox").TObject<{
    messageId: import("@sinclair/typebox").TString;
    preview: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
    type: import("@sinclair/typebox").TString;
}>]>;
export declare const ReadReceiptSchema: import("@sinclair/typebox").TObject<{
    userId: import("@sinclair/typebox").TString;
    readAt: import("@sinclair/typebox").TString;
}>;
export declare const MessageEmbedSchema: import("@sinclair/typebox").TObject<{
    url: import("@sinclair/typebox").TString;
    title: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
    description: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
    imageUrl: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
    siteName: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
    faviconUrl: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
    provider: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
}>;
export type MessageEmbed = Static<typeof MessageEmbedSchema>;
export declare const MessageSchema: import("@sinclair/typebox").TObject<{
    messageId: import("@sinclair/typebox").TString;
    conversationId: import("@sinclair/typebox").TString;
    senderId: import("@sinclair/typebox").TString;
    senderUsername: import("@sinclair/typebox").TString;
    type: import("@sinclair/typebox").TString;
    body: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
    replyTo: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TNull, import("@sinclair/typebox").TObject<{
        messageId: import("@sinclair/typebox").TString;
        preview: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
        type: import("@sinclair/typebox").TString;
    }>]>;
    isEdited: import("@sinclair/typebox").TBoolean;
    editedAt: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
    isDeleted: import("@sinclair/typebox").TBoolean;
    reactions: import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TInteger>;
    myReaction: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
    readBy: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        userId: import("@sinclair/typebox").TString;
        readAt: import("@sinclair/typebox").TString;
    }>>;
    deliveredAt: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
    createdAt: import("@sinclair/typebox").TString;
    embed: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TNull, import("@sinclair/typebox").TObject<{
        url: import("@sinclair/typebox").TString;
        title: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
        description: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
        imageUrl: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
        siteName: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
        faviconUrl: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
        provider: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    }>]>>;
    attachments: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        type: import("@sinclair/typebox").TLiteral<"image">;
        media: import("@sinclair/typebox").TObject<{
            id: import("@sinclair/typebox").TString;
            url: import("@sinclair/typebox").TString;
            blurUrl: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
            thumbUrl: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
            width: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TNumber, import("@sinclair/typebox").TNull]>>;
            height: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TNumber, import("@sinclair/typebox").TNull]>>;
            blurWidth: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TNumber, import("@sinclair/typebox").TNull]>>;
            blurHeight: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TNumber, import("@sinclair/typebox").TNull]>>;
            thumbWidth: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TNumber, import("@sinclair/typebox").TNull]>>;
            thumbHeight: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TNumber, import("@sinclair/typebox").TNull]>>;
            mimeType: import("@sinclair/typebox").TString;
            sizeBytes: import("@sinclair/typebox").TNumber;
            isLss: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            deliveryMode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"optimized">, import("@sinclair/typebox").TLiteral<"lss">]>>;
        }>;
    }>, import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        type: import("@sinclair/typebox").TLiteral<"video">;
        media: import("@sinclair/typebox").TObject<{
            id: import("@sinclair/typebox").TString;
            url: import("@sinclair/typebox").TString;
            streamUrl: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
            posterUrl: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
            thumbUrl: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
            width: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TNumber, import("@sinclair/typebox").TNull]>>;
            height: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TNumber, import("@sinclair/typebox").TNull]>>;
            durationMs: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TNumber, import("@sinclair/typebox").TNull]>;
            mimeType: import("@sinclair/typebox").TString;
            sizeBytes: import("@sinclair/typebox").TNumber;
            codec: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
            isLss: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            deliveryMode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"optimized">, import("@sinclair/typebox").TLiteral<"lss">]>>;
            status: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>;
    }>, import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        type: import("@sinclair/typebox").TLiteral<"voice">;
        media: import("@sinclair/typebox").TObject<{
            id: import("@sinclair/typebox").TString;
            url: import("@sinclair/typebox").TString;
            mimeType: import("@sinclair/typebox").TString;
            sizeBytes: import("@sinclair/typebox").TNumber;
            durationMs: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TNumber, import("@sinclair/typebox").TNull]>;
            transcriptStatus: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
            transcript: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
                segments: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
                    start: import("@sinclair/typebox").TNumber;
                    end: import("@sinclair/typebox").TNumber;
                    text: import("@sinclair/typebox").TString;
                    language: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"en">, import("@sinclair/typebox").TLiteral<"es">, import("@sinclair/typebox").TLiteral<"mixed">]>;
                }>>;
                fullText: import("@sinclair/typebox").TString;
                primaryLanguage: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"en">, import("@sinclair/typebox").TLiteral<"es">, import("@sinclair/typebox").TLiteral<"mixed">]>;
            }>, import("@sinclair/typebox").TNull]>;
        }>;
    }>]>>>;
    clientMessageId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
}>;
export type Message = Static<typeof MessageSchema>;
export type MessageType = "TEXT" | "IMAGE" | "VIDEO" | "AUDIO";
export declare const SendMessagePayloadSchema: import("@sinclair/typebox").TObject<{
    conversationId: import("@sinclair/typebox").TString;
    body: import("@sinclair/typebox").TString;
    replyToId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export type SendMessagePayload = Static<typeof SendMessagePayloadSchema>;
export declare const EditMessagePayloadSchema: import("@sinclair/typebox").TObject<{
    body: import("@sinclair/typebox").TString;
}>;
export type EditMessagePayload = Static<typeof EditMessagePayloadSchema>;
export declare const MESSAGE_EVENTS: {
    readonly SEND: "message:send";
    readonly EDIT: "message:edit";
    readonly DELETE: "message:delete";
    readonly REACTION: "message:reaction";
    readonly READ: "message:read";
    readonly NEW: "message:new";
    readonly EDITED: "message:edited";
    readonly DELETED: "message:deleted";
    readonly DELIVERED: "message:delivered";
    readonly EMBED_UPDATE: "message:embed:update";
};
export type MessageEventName = (typeof MESSAGE_EVENTS)[keyof typeof MESSAGE_EVENTS];
export type MessageSendInbound = SendMessagePayload & {
    clientMessageId?: string;
};
export type MessageEditInbound = {
    messageId: string;
    body: string;
};
export type MessageDeleteInbound = {
    messageId: string;
};
export type MessageReactionInbound = {
    messageId: string;
    emoji: string;
};
export type MessageReadInbound = {
    conversationId: string;
    messageIds?: string[];
};
export type MessageNewEvent = {
    message: Message;
};
export type MessageEditedEvent = {
    messageId: string;
    body: string;
    editedAt: string;
};
export type MessageDeletedEvent = {
    messageId: string;
    conversationId?: string;
};
export type MessageDeliveredEvent = {
    conversationId: string;
    messageIds: string[];
    deliveredAt: string;
};
export type MessageReactionEvent = {
    messageId: string;
    reactions: Record<string, number>;
    actorId: string;
};
export type MessageReadEvent = {
    conversationId: string;
    readBy: string;
    messageIds: string[];
    readAt: string;
    deliveredAt?: string | null;
};
export type MessageEmbedUpdateEvent = {
    messageId: string;
    embed: MessageEmbed;
};
