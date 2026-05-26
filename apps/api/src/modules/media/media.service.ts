// Business logic for the media domain.
// DB access MUST go through media.repository.ts — never import Prisma here.
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { PrismaClient, Media } from "@prisma/client";
import type { MessageAttachment, Transcript } from "@relay/contracts";
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

// Recorders emit Opus in either an Ogg (Firefox/Safari) or WebM (Chrome)
// container; the base type before the `;codecs=` parameter is what we match.
const ALLOWED_VOICE_MIME = new Set(["audio/ogg", "audio/webm", "audio/mp4", "audio/mpeg"]);

/** Discriminate media kind from the request MIME type. */
export function mediaKindFromMime(mimeType: string): "image" | "voice" | null {
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  if (ALLOWED_MIME.has(base)) return "image";
  if (ALLOWED_VOICE_MIME.has(base)) return "voice";
  return null;
}

export async function uploadImage(
  buffer:         Buffer,
  mimeType:       string,
  uploaderId:     string,
  prisma:         PrismaClient,
  s3:             S3Client,
  clientUploadId: string | null = null,
): Promise<UploadedMedia> {
  if (!ALLOWED_MIME.has(mimeType)) {
    throw Object.assign(new Error("Unsupported MIME type"), { code: "unsupported_mime" });
  }
  if (buffer.length > env.MEDIA_MAX_SIZE_MB * 1024 * 1024) {
    throw Object.assign(new Error("File too large"), { code: "too_large" });
  }

  // Idempotency: same clientUploadId → return the existing Media row without
  // re-uploading. The caller gets the same mediaId, which is safe to attach.
  if (clientUploadId) {
    const repo = createMediaRepository(prisma);
    const existing = await repo.findByClientUploadId(clientUploadId);
    if (existing) {
      if (existing.uploaderId !== uploaderId) {
        throw Object.assign(new Error("Forbidden"), { code: "forbidden" });
      }
      return {
        mediaId:    existing.id,
        storageKey: existing.storageKey,
        mimeType:   existing.mimeType,
        sizeBytes:  existing.sizeBytes,
        width:      existing.width,
        height:     existing.height,
        durationMs: existing.durationMs,
      };
    }
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
    ...(clientUploadId ? { clientUploadId } : {}),
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
    durationMs: media.durationMs,
  };
}

// Voice notes reuse the image pipeline's idempotency + size guards, but skip
// variant generation: the .opus file is immediately playable. Only the Whisper
// transcript is async, tracked separately via transcriptStatus. The original is
// stored under voice/YYYY/MM/DD/<id>_original.opus per the canonical layout.
export async function uploadVoice(
  buffer:         Buffer,
  mimeType:       string,
  durationMs:     number | null,
  uploaderId:     string,
  prisma:         PrismaClient,
  s3:             S3Client,
  clientUploadId: string | null = null,
): Promise<UploadedMedia> {
  if (mediaKindFromMime(mimeType) !== "voice") {
    throw Object.assign(new Error("Unsupported MIME type"), { code: "unsupported_mime" });
  }
  if (buffer.length > env.MEDIA_MAX_SIZE_MB * 1024 * 1024) {
    throw Object.assign(new Error("File too large"), { code: "too_large" });
  }

  const repo = createMediaRepository(prisma);

  if (clientUploadId) {
    const existing = await repo.findByClientUploadId(clientUploadId);
    if (existing) {
      if (existing.uploaderId !== uploaderId) {
        throw Object.assign(new Error("Forbidden"), { code: "forbidden" });
      }
      return {
        mediaId:    existing.id,
        storageKey: existing.storageKey,
        mimeType:   existing.mimeType,
        sizeBytes:  existing.sizeBytes,
        width:      existing.width,
        height:     existing.height,
        durationMs: existing.durationMs,
      };
    }
  }

  const mediaId    = randomUUID();
  const storageKey = buildMediaKey({ kind: "voice", id: mediaId, variant: "original", ext: ".opus" });

  await s3.send(new PutObjectCommand({
    Bucket:        env.MINIO_BUCKET,
    Key:           storageKey,
    Body:          buffer,
    ContentType:   mimeType,
    ContentLength: buffer.length,
  }));

  const media = await repo.createMedia({
    id: mediaId,
    uploaderId,
    storageKey,
    mimeType,
    sizeBytes: buffer.length,
    width:  null,
    height: null,
    status: "ready",            // file is immediately usable
    durationMs,
    transcriptStatus: null,      // transcription is opt-in — triggered by the user, never automatic
    ...(clientUploadId ? { clientUploadId } : {}),
  });

  return {
    mediaId:    media.id,
    storageKey: media.storageKey,
    mimeType:   media.mimeType,
    sizeBytes:  media.sizeBytes,
    width:      media.width,
    height:     media.height,
    durationMs: media.durationMs,
  };
}

export function findMedia(mediaId: string, prisma: PrismaClient) {
  return createMediaRepository(prisma).findMediaById(mediaId);
}

// Single source of truth for the attachment wire shape. Both the history GET and
// the media-send POST route through here so image/voice payloads stay identical
// to the MessageAttachment contract union. `signUrl` produces a presigned URL.
export async function serializeAttachment(
  attachmentId: string,
  type:         string,
  media:        Media,
  signUrl:      (key: string) => Promise<string>,
): Promise<MessageAttachment> {
  const url = await signUrl(media.storageKey);

  if (type === "voice") {
    return {
      id:   attachmentId,
      type: "voice",
      media: {
        id:               media.id,
        url,
        mimeType:         media.mimeType,
        sizeBytes:        media.sizeBytes,
        durationMs:       media.durationMs,
        transcriptStatus: media.transcriptStatus,
        transcript:       (media.transcript as Transcript | null) ?? null,
      },
    };
  }

  const [blurUrl, thumbUrl] = await Promise.all([
    media.blurStorageKey  ? signUrl(media.blurStorageKey)  : Promise.resolve(null),
    media.thumbStorageKey ? signUrl(media.thumbStorageKey) : Promise.resolve(null),
  ]);
  return {
    id:   attachmentId,
    type: "image",
    media: {
      id:          media.id,
      url,
      blurUrl,
      thumbUrl,
      width:       media.width,
      height:      media.height,
      blurWidth:   media.blurWidth,
      blurHeight:  media.blurHeight,
      thumbWidth:  media.thumbWidth,
      thumbHeight: media.thumbHeight,
      mimeType:    media.mimeType,
      sizeBytes:   media.sizeBytes,
    },
  };
}
