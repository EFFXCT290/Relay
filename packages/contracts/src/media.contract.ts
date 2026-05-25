// CONTRACT CATEGORY: domain
import { Type, type Static } from "@sinclair/typebox";

// ── Upload response ───────────────────────────────────────────────────────────
export const MediaUploadResponseSchema = Type.Object({
  mediaId:   Type.String(),
  mimeType:  Type.String(),
  sizeBytes: Type.Number(),
  width:     Type.Optional(Type.Number()),
  height:    Type.Optional(Type.Number()),
});
export type MediaUploadResponse = Static<typeof MediaUploadResponseSchema>;

// ── Attachment shape (embedded in MessageSchema.attachments) ──────────────────
export const MessageAttachmentSchema = Type.Object({
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
export type MessageAttachment = Static<typeof MessageAttachmentSchema>;
