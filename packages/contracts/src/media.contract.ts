// CONTRACT CATEGORY: domain
import { Type, type Static } from "@sinclair/typebox";

// ── Upload response ───────────────────────────────────────────────────────────
export const MediaUploadResponseSchema = Type.Object({
  mediaId:    Type.String(),
  mimeType:   Type.String(),
  sizeBytes:  Type.Number(),
  width:      Type.Optional(Type.Number()),
  height:     Type.Optional(Type.Number()),
  durationMs: Type.Optional(Type.Number()),   // voice notes only
});
export type MediaUploadResponse = Static<typeof MediaUploadResponseSchema>;

// ── Transcript (voice notes) ──────────────────────────────────────────────────
// Bilingual EN/ES: speech is preserved verbatim and labelled per segment, never
// translated or normalised. "mixed" marks a segment that code-switches.
export const TranscriptLanguageSchema = Type.Union([
  Type.Literal("en"),
  Type.Literal("es"),
  Type.Literal("mixed"),
]);
export type TranscriptLanguage = Static<typeof TranscriptLanguageSchema>;

export const TranscriptSegmentSchema = Type.Object({
  start:    Type.Number(),                 // seconds
  end:      Type.Number(),                 // seconds
  text:     Type.String(),
  language: TranscriptLanguageSchema,
});
export type TranscriptSegment = Static<typeof TranscriptSegmentSchema>;

export const TranscriptSchema = Type.Object({
  segments:        Type.Array(TranscriptSegmentSchema),
  fullText:        Type.String(),
  primaryLanguage: TranscriptLanguageSchema,
});
export type Transcript = Static<typeof TranscriptSchema>;

// ── Realtime events ───────────────────────────────────────────────────────────
export const MEDIA_EVENTS = {
  READY: "media:ready",
} as const;
export type MediaEventName = (typeof MEDIA_EVENTS)[keyof typeof MEDIA_EVENTS];

// Emitted by the worker once blur/thumb variants are ready.
export type MediaReadyEvent = {
  mediaId:    string;
  blurUrl:    string | null;
  thumbUrl:   string | null;
  blurWidth:  number | null;
  blurHeight: number | null;
  thumbWidth:  number | null;
  thumbHeight: number | null;
};

export const VOICE_EVENTS = {
  TRANSCRIPT_READY: "voice:transcript_ready",
} as const;
export type VoiceEventName = (typeof VOICE_EVENTS)[keyof typeof VOICE_EVENTS];

// Emitted by the transcription worker once Whisper output is stored.
export type VoiceTranscriptReadyEvent = {
  messageId:        string;
  attachmentId:     string;
  mediaId:          string;
  transcriptStatus: "ready" | "failed";
  transcript:       Transcript | null;   // null when transcriptStatus === "failed"
};

// ── Attachment shapes (embedded in MessageSchema.attachments) ─────────────────
// A message attachment is a discriminated union on `type`. Image attachments
// carry blur/thumb variants; voice attachments carry duration + transcript.
export const ImageAttachmentSchema = Type.Object({
  id:   Type.String(),
  type: Type.Literal("image"),
  media: Type.Object({
    id:          Type.String(),
    url:         Type.String(),
    blurUrl:     Type.Optional(Type.Union([Type.String(), Type.Null()])),
    thumbUrl:    Type.Optional(Type.Union([Type.String(), Type.Null()])),
    width:       Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    height:      Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    blurWidth:   Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    blurHeight:  Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    thumbWidth:  Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    thumbHeight: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    mimeType:    Type.String(),
    sizeBytes:   Type.Number(),
  }),
});
export type ImageAttachment = Static<typeof ImageAttachmentSchema>;

export const VoiceAttachmentSchema = Type.Object({
  id:   Type.String(),
  type: Type.Literal("voice"),
  media: Type.Object({
    id:               Type.String(),
    url:              Type.String(),
    mimeType:         Type.String(),
    sizeBytes:        Type.Number(),
    durationMs:       Type.Union([Type.Number(), Type.Null()]),
    transcriptStatus: Type.Union([Type.String(), Type.Null()]),  // "pending" | "ready" | "failed"
    transcript:       Type.Union([TranscriptSchema, Type.Null()]),
  }),
});
export type VoiceAttachment = Static<typeof VoiceAttachmentSchema>;

export const MessageAttachmentSchema = Type.Union([
  ImageAttachmentSchema,
  VoiceAttachmentSchema,
]);
export type MessageAttachment = Static<typeof MessageAttachmentSchema>;
