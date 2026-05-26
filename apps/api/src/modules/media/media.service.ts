// Business logic for the media domain.
// DB access MUST go through media.repository.ts — never import Prisma here.
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { PrismaClient, Media, MediaVariant } from "@prisma/client";
import type { MessageAttachment, Transcript } from "@relay/contracts";
import { createMediaRepository } from "./media.repository.js";
import { buildMediaKey, buildVariantKey } from "./media.keys.js";
import { buildInitialManifest, writeManifest } from "./media.manifest.js";
import { resolveDeliveryMode, probeVideo } from "./media.probe.js";
import { env } from "../../backend-core/runtime/env.js";
import { mediaQueue, videoQueue, PROCESS_IMAGE_JOB, PROCESS_VIDEO_JOB } from "../../queues/media.queue.js";
import type { UploadedMedia } from "./media.types.js";

// DNG raw is image-kind but never re-encoded — it is auto-LSS and sharp can't
// process it, so variant generation is skipped (original + manifest only).
const DNG_MIME = new Set(["image/x-adobe-dng", "image/dng"]);
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic",
  ...DNG_MIME,
]);

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg":          ".jpg",
  "image/png":           ".png",
  "image/webp":          ".webp",
  "image/heic":          ".heic",
  "image/x-adobe-dng":   ".dng",
  "image/dng":           ".dng",
};

// Recorders emit Opus in either an Ogg (Firefox/Safari) or WebM (Chrome)
// container; the base type before the `;codecs=` parameter is what we match.
const ALLOWED_VOICE_MIME = new Set(["audio/ogg", "audio/webm", "audio/mp4", "audio/mpeg"]);

// Video containers (Phase 6B). The actual codec (h264 vs hevc) is determined by
// ffprobe at upload, not the MIME — a .mov/.mp4 can hold either.
const ALLOWED_VIDEO_MIME = new Set(["video/mp4", "video/quicktime"]);

/** Discriminate media kind from the request MIME type. */
export function mediaKindFromMime(mimeType: string): "image" | "voice" | "video" | null {
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  if (ALLOWED_MIME.has(base)) return "image";
  if (ALLOWED_VIDEO_MIME.has(base)) return "video";
  if (ALLOWED_VOICE_MIME.has(base)) return "voice";
  return null;
}

// Browsers report inconsistent MIMEs for some formats — notably DNG (often
// "" / "application/octet-stream") and occasionally .mov. When the supplied
// MIME isn't one we recognize, fall back to the filename extension so the right
// pipeline (and the DNG auto-LSS rule) still kicks in.
const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  heic: "image/heic", dng: "image/x-adobe-dng",
  mp4: "video/mp4", mov: "video/quicktime",
};

/** Resolve the effective MIME: trust a recognized browser MIME, else sniff the
 *  extension. Returns the original MIME when nothing matches (caller rejects). */
export function resolveUploadMime(mimeType: string, filename: string | undefined): string {
  if (mediaKindFromMime(mimeType)) return mimeType;
  const ext = filename?.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_MIME[ext] ?? mimeType;
}

export async function uploadImage(
  buffer:         Buffer,
  mimeType:       string,
  uploaderId:     string,
  prisma:         PrismaClient,
  s3:             S3Client,
  clientUploadId: string | null = null,
  requestedMode:  "optimized" | "lss" = "optimized",
): Promise<UploadedMedia> {
  if (!ALLOWED_MIME.has(mimeType)) {
    throw Object.assign(new Error("Unsupported MIME type"), { code: "unsupported_mime" });
  }
  if (buffer.length > env.MEDIA_MAX_SIZE_MB * 1024 * 1024) {
    throw Object.assign(new Error("File too large"), { code: "too_large" });
  }

  const repo = createMediaRepository(prisma);

  // Idempotency: same clientUploadId → return the existing Media row without
  // re-uploading. The caller gets the same mediaId, which is safe to attach.
  if (clientUploadId) {
    const existing = await repo.findByClientUploadId(clientUploadId);
    if (existing) {
      if (existing.uploaderId !== uploaderId) {
        throw Object.assign(new Error("Forbidden"), { code: "forbidden" });
      }
      return toUploaded(existing);
    }
  }

  // DNG raw is auto-LSS (6B.4): no re-encode, sharp can't process it.
  const isDng = DNG_MIME.has(mimeType);
  const { deliveryMode } = resolveDeliveryMode({ requested: requestedMode, isHevc: false, isDng });
  const isLss = deliveryMode === "lss";

  // .rotate() corrects EXIF orientation — must be first in every pipeline.
  let width:  number | null = null;
  let height: number | null = null;
  if (!isDng) {
    try {
      const meta = await sharp(buffer).rotate().metadata();
      width  = meta.width  ?? null;
      height = meta.height ?? null;
    } catch {
      // Non-fatal — dimensions are optional
    }
  }

  const mediaId    = randomUUID();
  const ext        = MIME_TO_EXT[mimeType] ?? ".jpg";
  // Phase-6B per-mediaId layout: original lives at <id>/original/source.ext so
  // every derivative the worker produces is colocated under one prefix.
  const storageKey = buildVariantKey({ kind: "images", id: mediaId, group: "original", filename: `source${ext}` });

  // Upload original — the only synchronous MinIO operation in the request path.
  // Derivative generation happens asynchronously in the media worker.
  await s3.send(new PutObjectCommand({
    Bucket:        env.MINIO_BUCKET,
    Key:           storageKey,
    Body:          buffer,
    ContentType:   mimeType,
    ContentLength: buffer.length,
  }));

  // Manifest is the source of truth; write it before the row so a worker that
  // somehow races the enqueue still finds it. DNG/LSS have no async work, so
  // they are immediately "ready"; processable images stay "processing".
  const willProcess = !isDng;
  const manifest = buildInitialManifest({
    mediaId,
    storageKind:  "images",
    deliveryMode,
    isLss,
    isHevcSource: false,
    mime:         mimeType,
    originalKey:  storageKey,
    width,
    height,
  });
  await writeManifest(s3, manifest, { kind: "images", id: mediaId });

  const media = await repo.createMedia({
    id: mediaId,
    uploaderId,
    storageKey,
    mimeType,
    sizeBytes: buffer.length,
    width,
    height,
    kind:         "IMAGE",
    deliveryMode: isLss ? "LSS" : "OPTIMIZED",
    isLss,
    status: willProcess ? "processing" : "ready",
    ...(clientUploadId ? { clientUploadId } : {}),
  });

  // Record the canonical ORIGINAL variant (mirrors the manifest).
  await repo.upsertVariant({
    mediaId, type: "ORIGINAL", label: "", storageKey, mimeType,
    width, height, sizeBytes: buffer.length,
  });

  if (willProcess) {
    // Feed always needs thumbnails; optimized mode additionally produces display
    // variants. LSS skips the optimize (TRANSCODE) task — original is pristine.
    await repo.ensureTask(mediaId, "THUMBNAIL");
    if (!isLss) await repo.ensureTask(mediaId, "TRANSCODE");

    await mediaQueue.add(PROCESS_IMAGE_JOB, {
      mediaId,
      storageKey,
      mimeType,
      uploaderId,
      deliveryMode,
      isLss,
    });
  }

  return toUploaded(media);
}

function toUploaded(media: Media): UploadedMedia {
  return {
    mediaId:      media.id,
    storageKey:   media.storageKey,
    mimeType:     media.mimeType,
    sizeBytes:    media.sizeBytes,
    width:        media.width,
    height:       media.height,
    durationMs:   media.durationMs,
    deliveryMode: media.deliveryMode === "LSS" ? "lss" : "optimized",
    isLss:        media.isLss,
  };
}

// Video upload (6B.6/6B.14). ffprobe decides H.264-vs-HEVC, which drives the
// auto-LSS rule (6B.4): HEVC is never transcoded, only container-normalized.
// Every video gets poster + thumbnails + animated preview regardless of mode;
// optimized H.264 additionally gets the adaptive streaming ladder.
const VIDEO_EXT: Record<string, string> = {
  "video/mp4":        ".mp4",
  "video/quicktime":  ".mov",
};

export async function uploadVideo(
  buffer:         Buffer,
  mimeType:       string,
  uploaderId:     string,
  prisma:         PrismaClient,
  s3:             S3Client,
  clientUploadId: string | null = null,
  requestedMode:  "optimized" | "lss" = "optimized",
): Promise<UploadedMedia> {
  if (mediaKindFromMime(mimeType) !== "video") {
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
      return toUploaded(existing);
    }
  }

  // Probe up front: codec + dimensions + duration feed both the auto-LSS
  // decision and the manifest. A probe failure means the file isn't a video we
  // can handle, so reject rather than store something unprocessable.
  let probe;
  try {
    probe = await probeVideo(buffer);
  } catch {
    throw Object.assign(new Error("Unreadable video"), { code: "unsupported_mime" });
  }

  const { deliveryMode } = resolveDeliveryMode({ requested: requestedMode, isHevc: probe.isHevc, isDng: false });
  const isLss = deliveryMode === "lss";

  const mediaId    = randomUUID();
  const ext        = VIDEO_EXT[mimeType] ?? ".mp4";
  const storageKey = buildVariantKey({ kind: "videos", id: mediaId, group: "original", filename: `source${ext}` });

  await s3.send(new PutObjectCommand({
    Bucket:        env.MINIO_BUCKET,
    Key:           storageKey,
    Body:          buffer,
    ContentType:   mimeType,
    ContentLength: buffer.length,
  }));

  const manifest = buildInitialManifest({
    mediaId,
    storageKind:  "videos",
    deliveryMode,
    isLss,
    isHevcSource: probe.isHevc,
    mime:         mimeType,
    originalKey:  storageKey,
    width:        probe.width,
    height:       probe.height,
    durationMs:   probe.durationMs,
    codec:        probe.codec,
  });
  await writeManifest(s3, manifest, { kind: "videos", id: mediaId });

  const media = await repo.createMedia({
    id: mediaId,
    uploaderId,
    storageKey,
    mimeType,
    sizeBytes:    buffer.length,
    width:        probe.width,
    height:       probe.height,
    durationMs:   probe.durationMs,
    kind:         "VIDEO",
    deliveryMode: isLss ? "LSS" : "OPTIMIZED",
    isLss,
    isHevcSource: probe.isHevc,
    status:       "processing",
    ...(clientUploadId ? { clientUploadId } : {}),
  });

  await repo.upsertVariant({
    mediaId, type: "ORIGINAL", label: "", storageKey, mimeType,
    codec: probe.codec, width: probe.width, height: probe.height, sizeBytes: buffer.length,
  });

  // Tasks: poster + thumbnail always; TRANSCODE only for the H.264 ladder
  // (LSS/HEVC still runs the worker for poster/thumb/preview + remux).
  await repo.ensureTask(mediaId, "POSTER");
  await repo.ensureTask(mediaId, "THUMBNAIL");
  await repo.ensureTask(mediaId, "TRANSCODE");

  await videoQueue.add(PROCESS_VIDEO_JOB, {
    mediaId,
    storageKey,
    mimeType,
    uploaderId,
    deliveryMode,
    isLss,
    isHevc:     probe.isHevc,
    width:      probe.width,
    height:     probe.height,
    durationMs: probe.durationMs,
  });

  return toUploaded(media);
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
  media:        Media & { variants?: MediaVariant[] },
  signUrl:      (key: string) => Promise<string>,
): Promise<MessageAttachment> {
  const url = await signUrl(media.storageKey);

  if (type === "video") {
    const variants  = media.variants ?? [];
    const optimized = variants.filter((v) => v.type === "OPTIMIZED");
    // Feed stream = highest-resolution optimized rung (or the HEVC passthrough).
    const stream    = [...optimized].sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0] ?? null;
    const poster    = variants.find((v) => v.type === "POSTER" && v.label === "") ?? null;
    const thumb     = variants.find((v) => v.type === "THUMBNAIL" && v.label === "md")
                   ?? variants.find((v) => v.type === "THUMBNAIL" && v.label === "sm") ?? null;
    const originalV = variants.find((v) => v.type === "ORIGINAL");

    const [streamUrl, posterUrl, thumbUrl] = await Promise.all([
      stream ? signUrl(stream.storageKey) : Promise.resolve(null),
      poster ? signUrl(poster.storageKey) : Promise.resolve(null),
      thumb  ? signUrl(thumb.storageKey)  : Promise.resolve(null),
    ]);

    return {
      id:   attachmentId,
      type: "video",
      media: {
        id:           media.id,
        url,                                 // original/highest quality (fullscreen + download)
        streamUrl,                           // feed-safe optimized/passthrough stream
        posterUrl,
        thumbUrl,
        width:        media.width,
        height:       media.height,
        durationMs:   media.durationMs,
        mimeType:     media.mimeType,
        sizeBytes:    media.sizeBytes,
        codec:        stream?.codec ?? originalV?.codec ?? null,
        isLss:        media.isLss,
        deliveryMode: media.deliveryMode === "LSS" ? "lss" : "optimized",
        status:       media.status,
      },
    };
  }

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
      isLss:        media.isLss,
      deliveryMode: media.deliveryMode === "LSS" ? "lss" : "optimized",
    },
  };
}
