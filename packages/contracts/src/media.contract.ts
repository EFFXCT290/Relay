// CONTRACT CATEGORY: domain
import { Type, type Static } from "@sinclair/typebox";

// ── Delivery mode (Phase 6B) ──────────────────────────────────────────────────
// optimized = bandwidth-friendly derivatives generated; lss = original preserved
// (no resize/re-encode). HEVC video + DNG raw are auto-promoted to lss server-side.
export const DeliveryModeSchema = Type.Union([
  Type.Literal("optimized"),
  Type.Literal("lss"),
]);
export type DeliveryMode = Static<typeof DeliveryModeSchema>;

// ── Ephemeral / view-once (Phase 6E) ──────────────────────────────────────────
// View-COUNT based (Instagram-style), not a timer. The sender picks maxViews
// (1 = "view once" … 5); "unlimited" sends no ephemeral block and behaves as
// normal media. When an attachment is ephemeral the server serializes NO signed
// URL (see ImageAttachment.media.url becoming optional) — the client renders a
// locked "tap to view" card and mints a short-lived URL on explicit open via
// POST /media/:id/view. `consumedAt` is set once viewCount reaches maxViews.
export const EphemeralSendSchema = Type.Object({
  maxViews: Type.Integer({ minimum: 1, maximum: 5 }),
});
export type EphemeralSend = Static<typeof EphemeralSendSchema>;

export const EphemeralStateSchema = Type.Object({
  maxViews:   Type.Integer(),
  viewCount:  Type.Integer(),
  consumedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});
export type EphemeralState = Static<typeof EphemeralStateSchema>;

// Response of POST /api/media/:mediaId/view. `url` is the freshly-minted short
// lived link, omitted once the media is consumed.
export const MediaViewResponseSchema = Type.Object({
  consumed:  Type.Boolean(),
  viewCount: Type.Integer(),
  maxViews:  Type.Integer(),
  url:       Type.Optional(Type.String()),
});
export type MediaViewResponse = Static<typeof MediaViewResponseSchema>;

// ── Upload response ───────────────────────────────────────────────────────────
export const MediaUploadResponseSchema = Type.Object({
  mediaId:    Type.String(),
  mimeType:   Type.String(),
  sizeBytes:  Type.Number(),
  width:      Type.Optional(Type.Number()),
  height:     Type.Optional(Type.Number()),
  durationMs: Type.Optional(Type.Number()),   // voice notes only
  // Phase 6B: echoes the *effective* mode (may differ from requested if auto-promoted).
  deliveryMode: Type.Optional(DeliveryModeSchema),
  isLss:        Type.Optional(Type.Boolean()),
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
  READY:     "media:ready",      // legacy image blur/thumb (kept for back-compat)
  PROCESSED: "media:processed",  // Phase 6B: any media's derivatives finished
  VIEWED:    "media:viewed",     // Phase 6E: ephemeral view-count ticked / consumed
} as const;
export type MediaEventName = (typeof MEDIA_EVENTS)[keyof typeof MEDIA_EVENTS];

// Phase 6E: emitted to both participants when a recipient opens ephemeral media.
// Lets the sender's UI tick "Opened X/N" live and the recipient's other devices
// reconcile the locked/consumed state. `consumed` is true once the count is spent.
export type MediaViewedEvent = {
  mediaId:   string;
  messageId: string;
  viewCount: number;
  maxViews:  number;
  consumed:  boolean;
  viewedAt:  string;
};

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

// Phase 6B unified event (6B.17): fired when a media object's processing tasks
// settle. Carries freshly-signed delivery URLs so a live client can swap a
// poster/placeholder for the playable stream without a refetch. Per-variant
// progress is coarse (one event at completion) to keep socket traffic light.
export type MediaProcessedEvent = {
  mediaId:   string;
  kind:      "image" | "video" | "voice";
  status:    "ready" | "failed";
  // Signed URLs for the variants a client needs to render the final asset.
  posterUrl?: string | null;   // video poster (webp)
  thumbUrl?:  string | null;   // chat-list thumbnail
  streamUrl?: string | null;   // video: optimized/passthrough stream
  width?:     number | null;
  height?:    number | null;
  durationMs?: number | null;
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
    // Optional since Phase 6E: ephemeral (locked) media carries NO url/blur/thumb
    // until the recipient opens it via POST /media/:id/view.
    url:         Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
    // Phase 6B: drives the LSS badge (6B.11). Optional/legacy-safe — absent on
    // pre-6B attachments, which render without a badge.
    isLss:        Type.Optional(Type.Boolean()),
    deliveryMode: Type.Optional(DeliveryModeSchema),
    // Phase 6E: present iff this media is ephemeral. When set, url/blur/thumb are
    // absent and the bubble renders a locked "tap to view" card.
    ephemeral:    Type.Optional(Type.Union([Type.Null(), EphemeralStateSchema])),
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

// Video attachment (Phase 6B). `url` is the highest-quality source (LSS/original
// or top optimized rung); `streamUrl` is the feed-safe optimized/passthrough
// stream; poster/thumb drive progressive loading. `status` lets the bubble show
// a processing state until the worker finishes transcoding.
export const VideoAttachmentSchema = Type.Object({
  id:   Type.String(),
  type: Type.Literal("video"),
  media: Type.Object({
    id:           Type.String(),
    // Optional since Phase 6E (see ImageAttachment): ephemeral video is locked
    // until opened via POST /media/:id/view.
    url:          Type.Optional(Type.Union([Type.String(), Type.Null()])),   // original / highest quality
    streamUrl:    Type.Optional(Type.Union([Type.String(), Type.Null()])),  // feed-safe optimized stream
    posterUrl:    Type.Optional(Type.Union([Type.String(), Type.Null()])),
    thumbUrl:     Type.Optional(Type.Union([Type.String(), Type.Null()])),
    width:        Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    height:       Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    durationMs:   Type.Union([Type.Number(), Type.Null()]),
    mimeType:     Type.String(),
    sizeBytes:    Type.Number(),
    codec:        Type.Optional(Type.Union([Type.String(), Type.Null()])),
    isLss:        Type.Optional(Type.Boolean()),
    deliveryMode: Type.Optional(DeliveryModeSchema),
    status:       Type.Optional(Type.String()),                    // "processing" | "ready" | "failed"
    // Phase 6E: present iff this video is ephemeral (locked until opened).
    ephemeral:    Type.Optional(Type.Union([Type.Null(), EphemeralStateSchema])),
  }),
});
export type VideoAttachment = Static<typeof VideoAttachmentSchema>;

export const MessageAttachmentSchema = Type.Union([
  ImageAttachmentSchema,
  VideoAttachmentSchema,
  VoiceAttachmentSchema,
]);
export type MessageAttachment = Static<typeof MessageAttachmentSchema>;
