import { type Static } from "@sinclair/typebox";
export declare const DeliveryModeSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"optimized">, import("@sinclair/typebox").TLiteral<"lss">]>;
export type DeliveryMode = Static<typeof DeliveryModeSchema>;
export declare const MediaUploadResponseSchema: import("@sinclair/typebox").TObject<{
    mediaId: import("@sinclair/typebox").TString;
    mimeType: import("@sinclair/typebox").TString;
    sizeBytes: import("@sinclair/typebox").TNumber;
    width: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
    height: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
    durationMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
    deliveryMode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"optimized">, import("@sinclair/typebox").TLiteral<"lss">]>>;
    isLss: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
}>;
export type MediaUploadResponse = Static<typeof MediaUploadResponseSchema>;
export declare const TranscriptLanguageSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"en">, import("@sinclair/typebox").TLiteral<"es">, import("@sinclair/typebox").TLiteral<"mixed">]>;
export type TranscriptLanguage = Static<typeof TranscriptLanguageSchema>;
export declare const TranscriptSegmentSchema: import("@sinclair/typebox").TObject<{
    start: import("@sinclair/typebox").TNumber;
    end: import("@sinclair/typebox").TNumber;
    text: import("@sinclair/typebox").TString;
    language: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"en">, import("@sinclair/typebox").TLiteral<"es">, import("@sinclair/typebox").TLiteral<"mixed">]>;
}>;
export type TranscriptSegment = Static<typeof TranscriptSegmentSchema>;
export declare const TranscriptSchema: import("@sinclair/typebox").TObject<{
    segments: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        start: import("@sinclair/typebox").TNumber;
        end: import("@sinclair/typebox").TNumber;
        text: import("@sinclair/typebox").TString;
        language: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"en">, import("@sinclair/typebox").TLiteral<"es">, import("@sinclair/typebox").TLiteral<"mixed">]>;
    }>>;
    fullText: import("@sinclair/typebox").TString;
    primaryLanguage: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"en">, import("@sinclair/typebox").TLiteral<"es">, import("@sinclair/typebox").TLiteral<"mixed">]>;
}>;
export type Transcript = Static<typeof TranscriptSchema>;
export declare const MEDIA_EVENTS: {
    readonly READY: "media:ready";
    readonly PROCESSED: "media:processed";
};
export type MediaEventName = (typeof MEDIA_EVENTS)[keyof typeof MEDIA_EVENTS];
export type MediaReadyEvent = {
    mediaId: string;
    blurUrl: string | null;
    thumbUrl: string | null;
    blurWidth: number | null;
    blurHeight: number | null;
    thumbWidth: number | null;
    thumbHeight: number | null;
};
export type MediaProcessedEvent = {
    mediaId: string;
    kind: "image" | "video" | "voice";
    status: "ready" | "failed";
    posterUrl?: string | null;
    thumbUrl?: string | null;
    streamUrl?: string | null;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
};
export declare const VOICE_EVENTS: {
    readonly TRANSCRIPT_READY: "voice:transcript_ready";
};
export type VoiceEventName = (typeof VOICE_EVENTS)[keyof typeof VOICE_EVENTS];
export type VoiceTranscriptReadyEvent = {
    messageId: string;
    attachmentId: string;
    mediaId: string;
    transcriptStatus: "ready" | "failed";
    transcript: Transcript | null;
};
export declare const ImageAttachmentSchema: import("@sinclair/typebox").TObject<{
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
}>;
export type ImageAttachment = Static<typeof ImageAttachmentSchema>;
export declare const VoiceAttachmentSchema: import("@sinclair/typebox").TObject<{
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
}>;
export type VoiceAttachment = Static<typeof VoiceAttachmentSchema>;
export declare const VideoAttachmentSchema: import("@sinclair/typebox").TObject<{
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
}>;
export type VideoAttachment = Static<typeof VideoAttachmentSchema>;
export declare const MessageAttachmentSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
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
}>]>;
export type MessageAttachment = Static<typeof MessageAttachmentSchema>;
