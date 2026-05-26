// Database access for the media domain.
// This is the ONLY file in this module that may import Prisma.
import type {
  PrismaClient,
  MediaKind,
  MediaDeliveryMode,
  MediaVariantType,
  MediaTaskType,
  MediaTaskState,
} from "@prisma/client";

export function createMediaRepository(db: PrismaClient) {
  return {
    createMedia: (data: {
      id:                string;
      uploaderId:        string;
      storageKey:        string;
      mimeType:          string;
      sizeBytes:         number;
      width:             number | null;
      height:            number | null;
      status:            string;
      kind?:             MediaKind;
      deliveryMode?:     MediaDeliveryMode;
      isLss?:            boolean;
      isHevcSource?:     boolean;
      durationMs?:       number | null;
      transcriptStatus?: string | null;
      clientUploadId?:   string | null;
    }) => db.media.create({ data }),

    // ── Phase 6B: normalized variants + processing tasks ────────────────────
    // Variant rows mirror the manifest's variant map. Upsert keyed on
    // (mediaId,type,label) so a retried worker overwrites rather than duplicates.
    upsertVariant: (data: {
      mediaId:    string;
      type:       MediaVariantType;
      label:      string;           // "" for singleton variants (original/optimized/poster)
      storageKey: string;
      mimeType:   string;
      codec?:     string | null;
      width?:     number | null;
      height?:    number | null;
      bitrate?:   number | null;
      sizeBytes?: number | null;
    }) =>
      db.mediaVariant.upsert({
        where:  { mediaId_type_label: { mediaId: data.mediaId, type: data.type, label: data.label } },
        create: data,
        update: data,
      }),

    findVariants: (mediaId: string) =>
      db.mediaVariant.findMany({ where: { mediaId } }),

    // Create the task row in PENDING when work is enqueued.
    ensureTask: (mediaId: string, type: MediaTaskType) =>
      db.mediaProcessingTask.upsert({
        where:  { mediaId_type: { mediaId, type } },
        create: { mediaId, type, state: "PENDING" },
        update: {},
      }),

    // Advance a task's state machine; stamps timing + increments attempts.
    setTaskState: (
      mediaId: string,
      type:    MediaTaskType,
      state:   MediaTaskState,
      error:   string | null = null,
    ) =>
      db.mediaProcessingTask.update({
        where: { mediaId_type: { mediaId, type } },
        data: {
          state,
          error,
          ...(state === "PROCESSING" ? { startedAt: new Date(), attempts: { increment: 1 } } : {}),
          ...(state === "READY" || state === "FAILED" ? { endedAt: new Date() } : {}),
        },
      }),

    findTasks: (mediaId: string) =>
      db.mediaProcessingTask.findMany({ where: { mediaId } }),

    findByClientUploadId: (clientUploadId: string) =>
      db.media.findUnique({ where: { clientUploadId } }),

    // Store the Whisper result for a voice note and flip its transcript status.
    updateTranscript: (
      id: string,
      data: { transcript: unknown; transcriptStatus: string },
    ) =>
      db.media.update({
        where: { id },
        data: { transcript: data.transcript as never, transcriptStatus: data.transcriptStatus },
      }),

    createAttachment: (data: {
      id:        string;
      messageId: string;
      mediaId:   string;
      type:      string;
    }) => db.messageAttachment.create({ data }),

    findMediaById: (id: string) =>
      db.media.findUnique({ where: { id } }),

    findAttachmentsByMessageId: (messageId: string) =>
      db.messageAttachment.findMany({
        where: { messageId },
        include: { media: true },
      }),
  };
}
