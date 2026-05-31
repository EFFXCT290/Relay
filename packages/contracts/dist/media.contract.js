// CONTRACT CATEGORY: domain
import { Type } from "@sinclair/typebox";
// ── Delivery mode (Phase 6B) ──────────────────────────────────────────────────
// optimized = bandwidth-friendly derivatives generated; lss = original preserved
// (no resize/re-encode). HEVC video + DNG raw are auto-promoted to lss server-side.
export const DeliveryModeSchema = Type.Union([
    Type.Literal("optimized"),
    Type.Literal("lss"),
]);
// ── Upload response ───────────────────────────────────────────────────────────
export const MediaUploadResponseSchema = Type.Object({
    mediaId: Type.String(),
    mimeType: Type.String(),
    sizeBytes: Type.Number(),
    width: Type.Optional(Type.Number()),
    height: Type.Optional(Type.Number()),
    durationMs: Type.Optional(Type.Number()), // voice notes only
    // Phase 6B: echoes the *effective* mode (may differ from requested if auto-promoted).
    deliveryMode: Type.Optional(DeliveryModeSchema),
    isLss: Type.Optional(Type.Boolean()),
});
// ── Transcript (voice notes) ──────────────────────────────────────────────────
// Bilingual EN/ES: speech is preserved verbatim and labelled per segment, never
// translated or normalised. "mixed" marks a segment that code-switches.
export const TranscriptLanguageSchema = Type.Union([
    Type.Literal("en"),
    Type.Literal("es"),
    Type.Literal("mixed"),
]);
export const TranscriptSegmentSchema = Type.Object({
    start: Type.Number(), // seconds
    end: Type.Number(), // seconds
    text: Type.String(),
    language: TranscriptLanguageSchema,
});
export const TranscriptSchema = Type.Object({
    segments: Type.Array(TranscriptSegmentSchema),
    fullText: Type.String(),
    primaryLanguage: TranscriptLanguageSchema,
});
// ── Realtime events ───────────────────────────────────────────────────────────
export const MEDIA_EVENTS = {
    READY: "media:ready", // legacy image blur/thumb (kept for back-compat)
    PROCESSED: "media:processed", // Phase 6B: any media's derivatives finished
};
export const VOICE_EVENTS = {
    TRANSCRIPT_READY: "voice:transcript_ready",
};
// ── Attachment shapes (embedded in MessageSchema.attachments) ─────────────────
// A message attachment is a discriminated union on `type`. Image attachments
// carry blur/thumb variants; voice attachments carry duration + transcript.
export const ImageAttachmentSchema = Type.Object({
    id: Type.String(),
    type: Type.Literal("image"),
    media: Type.Object({
        id: Type.String(),
        url: Type.String(),
        blurUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        thumbUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        width: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        height: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        blurWidth: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        blurHeight: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        thumbWidth: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        thumbHeight: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        mimeType: Type.String(),
        sizeBytes: Type.Number(),
        // Phase 6B: drives the LSS badge (6B.11). Optional/legacy-safe — absent on
        // pre-6B attachments, which render without a badge.
        isLss: Type.Optional(Type.Boolean()),
        deliveryMode: Type.Optional(DeliveryModeSchema),
    }),
});
export const VoiceAttachmentSchema = Type.Object({
    id: Type.String(),
    type: Type.Literal("voice"),
    media: Type.Object({
        id: Type.String(),
        url: Type.String(),
        mimeType: Type.String(),
        sizeBytes: Type.Number(),
        durationMs: Type.Union([Type.Number(), Type.Null()]),
        transcriptStatus: Type.Union([Type.String(), Type.Null()]), // "pending" | "ready" | "failed"
        transcript: Type.Union([TranscriptSchema, Type.Null()]),
    }),
});
// Video attachment (Phase 6B). `url` is the highest-quality source (LSS/original
// or top optimized rung); `streamUrl` is the feed-safe optimized/passthrough
// stream; poster/thumb drive progressive loading. `status` lets the bubble show
// a processing state until the worker finishes transcoding.
export const VideoAttachmentSchema = Type.Object({
    id: Type.String(),
    type: Type.Literal("video"),
    media: Type.Object({
        id: Type.String(),
        url: Type.String(), // original / highest quality
        streamUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])), // feed-safe optimized stream
        posterUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        thumbUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        width: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        height: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        durationMs: Type.Union([Type.Number(), Type.Null()]),
        mimeType: Type.String(),
        sizeBytes: Type.Number(),
        codec: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        isLss: Type.Optional(Type.Boolean()),
        deliveryMode: Type.Optional(DeliveryModeSchema),
        status: Type.Optional(Type.String()), // "processing" | "ready" | "failed"
    }),
});
export const MessageAttachmentSchema = Type.Union([
    ImageAttachmentSchema,
    VideoAttachmentSchema,
    VoiceAttachmentSchema,
]);
