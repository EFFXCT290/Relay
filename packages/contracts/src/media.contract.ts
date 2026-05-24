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
    id:        Type.String(),
    url:       Type.String(),
    width:     Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    height:    Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    mimeType:  Type.String(),
    sizeBytes: Type.Number(),
  }),
});
export type MessageAttachment = Static<typeof MessageAttachmentSchema>;
