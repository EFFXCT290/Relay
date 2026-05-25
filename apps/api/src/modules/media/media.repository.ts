// Database access for the media domain.
// This is the ONLY file in this module that may import Prisma.
import type { PrismaClient } from "@prisma/client";

export function createMediaRepository(db: PrismaClient) {
  return {
    createMedia: (data: {
      id:             string;
      uploaderId:     string;
      storageKey:     string;
      mimeType:       string;
      sizeBytes:      number;
      width:          number | null;
      height:         number | null;
      status:         string;
      clientUploadId?: string | null;
    }) => db.media.create({ data }),

    findByClientUploadId: (clientUploadId: string) =>
      db.media.findUnique({ where: { clientUploadId } }),

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
