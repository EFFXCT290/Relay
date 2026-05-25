// Business logic for the media domain.
// DB access MUST go through media.repository.ts — never import Prisma here.
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { PrismaClient } from "@prisma/client";
import { createMediaRepository } from "./media.repository.js";
import { buildMediaKey } from "./media.keys.js";
import { env } from "../../backend-core/runtime/env.js";
import { mediaQueue, PROCESS_IMAGE_JOB } from "../../queues/media.queue.js";
import type { UploadedMedia } from "./media.types.js";

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png":  ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
};

export async function uploadImage(
  buffer:     Buffer,
  mimeType:   string,
  uploaderId: string,
  prisma:     PrismaClient,
  s3:         S3Client,
): Promise<UploadedMedia> {
  if (!ALLOWED_MIME.has(mimeType)) {
    throw Object.assign(new Error("Unsupported MIME type"), { code: "unsupported_mime" });
  }
  if (buffer.length > env.MEDIA_MAX_SIZE_MB * 1024 * 1024) {
    throw Object.assign(new Error("File too large"), { code: "too_large" });
  }

  // .rotate() corrects EXIF orientation — must be first in every pipeline.
  let width:  number | null = null;
  let height: number | null = null;
  try {
    const meta = await sharp(buffer).rotate().metadata();
    width  = meta.width  ?? null;
    height = meta.height ?? null;
  } catch {
    // Non-fatal — dimensions are optional
  }

  const mediaId    = randomUUID();
  const ext        = MIME_TO_EXT[mimeType] ?? ".jpg";
  const storageKey = buildMediaKey({ kind: "images", id: mediaId, variant: "original", ext });

  // Upload original — the only synchronous MinIO operation in the request path.
  // Variant generation (blur, thumb) happens asynchronously in the media worker.
  await s3.send(new PutObjectCommand({
    Bucket:        env.MINIO_BUCKET,
    Key:           storageKey,
    Body:          buffer,
    ContentType:   mimeType,
    ContentLength: buffer.length,
  }));

  const repo  = createMediaRepository(prisma);
  const media = await repo.createMedia({
    id: mediaId,
    uploaderId,
    storageKey,
    mimeType,
    sizeBytes: buffer.length,
    width,
    height,
    status: "processing",
  });

  // Enqueue variant generation — worker produces blur + thumb, updates DB,
  // then emits media:ready over the socket.
  await mediaQueue.add(PROCESS_IMAGE_JOB, {
    mediaId,
    storageKey,
    mimeType,
    uploaderId,
  });

  return {
    mediaId:    media.id,
    storageKey: media.storageKey,
    mimeType:   media.mimeType,
    sizeBytes:  media.sizeBytes,
    width:      media.width,
    height:     media.height,
  };
}

export function findMedia(mediaId: string, prisma: PrismaClient) {
  return createMediaRepository(prisma).findMediaById(mediaId);
}
