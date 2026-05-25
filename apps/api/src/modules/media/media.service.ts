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

  // .rotate() corrects EXIF orientation on all variants — without it iPhone
  // photos randomly appear rotated. Must be the first operation in every pipeline.
  let width:  number | null = null;
  let height: number | null = null;
  try {
    const meta = await sharp(buffer).rotate().metadata();
    width  = meta.width  ?? null;
    height = meta.height ?? null;
  } catch {
    // Non-fatal — dimensions are optional
  }

  // Blur placeholder: tiny (~few hundred bytes), intentionally blurry JPEG the
  // client paints instantly while thumb loads. Never displayed sharp.
  let blurBuffer: Buffer | null = null;
  let blurWidth:  number | null = null;
  let blurHeight: number | null = null;
  try {
    blurBuffer = await sharp(buffer)
      .rotate()
      .resize(32)
      .blur()
      .jpeg({ quality: 40 })
      .toBuffer();
    const blurMeta = await sharp(blurBuffer).metadata();
    blurWidth  = blurMeta.width  ?? null;
    blurHeight = blurMeta.height ?? null;
  } catch {
    blurBuffer = null;
  }

  // Thumbnail: max 480px long edge, high quality — used in chat bubbles.
  // The original is reserved for lightbox/fullscreen only.
  let thumbBuffer: Buffer | null = null;
  let thumbWidth:  number | null = null;
  let thumbHeight: number | null = null;
  try {
    thumbBuffer = await sharp(buffer)
      .rotate()
      .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    const thumbMeta = await sharp(thumbBuffer).metadata();
    thumbWidth  = thumbMeta.width  ?? null;
    thumbHeight = thumbMeta.height ?? null;
  } catch {
    thumbBuffer = null;
  }

  const mediaId    = randomUUID();
  const ext        = MIME_TO_EXT[mimeType] ?? ".jpg";
  const storageKey = buildMediaKey({ kind: "images", id: mediaId, variant: "original", ext });
  const blurKey    = blurBuffer
    ? buildMediaKey({ kind: "images", id: mediaId, variant: "blur",  ext: ".jpg" })
    : null;
  const thumbKey   = thumbBuffer
    ? buildMediaKey({ kind: "images", id: mediaId, variant: "thumb", ext: ".jpg" })
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

  if (thumbBuffer && thumbKey) {
    await s3.send(new PutObjectCommand({
      Bucket:        env.MINIO_BUCKET,
      Key:           thumbKey,
      Body:          thumbBuffer,
      ContentType:   "image/jpeg",
      ContentLength: thumbBuffer.length,
    }));
  }

  const repo  = createMediaRepository(prisma);
  const media = await repo.createMedia({
    id: mediaId,
    uploaderId,
    storageKey,
    blurStorageKey:  blurKey,
    thumbStorageKey: thumbKey,
    mimeType,
    sizeBytes: buffer.length,
    width,
    height,
    blurWidth,
    blurHeight,
    thumbWidth,
    thumbHeight,
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
