// Business logic for the media domain.
// DB access MUST go through media.repository.ts — never import Prisma here.
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { PrismaClient } from "@prisma/client";
import { createMediaRepository } from "./media.repository.js";
import { buildMediaKey } from "./media.keys.js";
import { env } from "../../backend-core/runtime/env.js";
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

  let width:  number | null = null;
  let height: number | null = null;
  try {
    const meta = await sharp(buffer).metadata();
    width  = meta.width  ?? null;
    height = meta.height ?? null;
  } catch {
    // Non-fatal — dimensions are optional
  }

  // Blur placeholder: a tiny, heavily-compressed, intentionally-blurry JPEG
  // (~a few hundred bytes) the client paints instantly while the original
  // loads. Not a thumbnail — never displayed sharp. Always JPEG regardless of
  // the source MIME. Synchronous on purpose: no queue/worker yet (Phase 2.1).
  let blurBuffer: Buffer | null = null;
  let blurWidth:  number | null = null;
  let blurHeight: number | null = null;
  try {
    blurBuffer = await sharp(buffer)
      .resize(32)
      .blur()
      .jpeg({ quality: 40 })
      .toBuffer();
    const blurMeta = await sharp(blurBuffer).metadata();
    blurWidth  = blurMeta.width  ?? null;
    blurHeight = blurMeta.height ?? null;
  } catch {
    // Non-fatal — image still works without a placeholder, just less smooth.
    blurBuffer = null;
  }

  const mediaId    = randomUUID();
  const ext        = MIME_TO_EXT[mimeType] ?? ".jpg";
  const storageKey = buildMediaKey({ kind: "images", id: mediaId, variant: "original", ext });
  const blurKey    = blurBuffer
    ? buildMediaKey({ kind: "images", id: mediaId, variant: "blur", ext: ".jpg" })
    : null;

  await s3.send(new PutObjectCommand({
    Bucket:        env.MINIO_BUCKET,
    Key:           storageKey,
    Body:          buffer,
    ContentType:   mimeType,
    ContentLength: buffer.length,
  }));

  if (blurBuffer && blurKey) {
    await s3.send(new PutObjectCommand({
      Bucket:        env.MINIO_BUCKET,
      Key:           blurKey,
      Body:          blurBuffer,
      ContentType:   "image/jpeg",
      ContentLength: blurBuffer.length,
    }));
  }

  const repo  = createMediaRepository(prisma);
  const media = await repo.createMedia({
    id: mediaId,
    uploaderId,
    storageKey,
    blurStorageKey: blurKey,
    mimeType,
    sizeBytes: buffer.length,
    width,
    height,
    blurWidth,
    blurHeight,
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
