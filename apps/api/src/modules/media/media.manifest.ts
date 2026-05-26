// Phase 6B — the manifest is the single source of truth for one media object.
// It lives at `<prefix>/metadata/manifest.json` in MinIO and records every
// variant key plus the processing state of each derivative. The DB columns
// (Media.*, MediaVariant, MediaProcessingTask) are denormalized projections of
// this file for cheap querying; when the two disagree, the manifest wins.
//
// Workers are stateless: they read the manifest (or derive keys from the
// original key via media.keys helpers), produce derivatives, then patch the
// manifest + DB. Keeping the canonical map in object storage means a worker
// never needs DB access to know where a sibling variant lives.
import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { env } from "../../backend-core/runtime/env.js";
import { buildManifestKey, type MediaKind } from "./media.keys.js";

export type ManifestKind = "image" | "video" | "voice";
export type ManifestProcessingState = "pending" | "processing" | "ready" | "failed";

// logical variant name → storage key. Names are stable across kinds, e.g.
// image:   original, display, display@2x, avif, thumb_sm, thumb_md, thumb_lg
// video:   original, stream_1080p, stream_720p, stream_480p, poster, animated_preview, thumb_md
// voice:   original, waveform
export type ManifestVariants = Record<string, string>;

// derivative group → state. Keys mirror MediaTaskType, lowercased, e.g.
// transcode, thumbnail, poster, waveform, transcript.
export type ManifestProcessing = Record<string, ManifestProcessingState>;

export interface MediaManifest {
  mediaId:      string;
  kind:         ManifestKind;
  deliveryMode: "optimized" | "lss";
  isLss:        boolean;
  isHevcSource: boolean;
  mime:         string;        // delivery mime (optimized output, or original for LSS)
  originalMime: string;        // codec/container actually uploaded
  codec?:       string | null; // primary delivery codec (h264/hevc/…); video/audio
  variants:     ManifestVariants;
  dimensions?:  { width: number | null; height: number | null };
  durationMs?:  number | null;
  processing:   ManifestProcessing;
  createdAt:    string;        // ISO
  updatedAt:    string;        // ISO
}

const STORAGE_KIND_TO_MANIFEST: Record<MediaKind, ManifestKind> = {
  images: "image",
  videos: "video",
  voice:  "voice",
};

/** Build the manifest written at upload time, before any derivative exists. */
export function buildInitialManifest(opts: {
  mediaId:      string;
  storageKind:  MediaKind;
  deliveryMode: "optimized" | "lss";
  isLss:        boolean;
  isHevcSource: boolean;
  mime:         string;
  originalKey:  string;
  width?:       number | null;
  height?:      number | null;
  durationMs?:  number | null;
  codec?:       string | null;
}): MediaManifest {
  const now = new Date().toISOString();
  return {
    mediaId:      opts.mediaId,
    kind:         STORAGE_KIND_TO_MANIFEST[opts.storageKind],
    deliveryMode: opts.deliveryMode,
    isLss:        opts.isLss,
    isHevcSource: opts.isHevcSource,
    mime:         opts.mime,
    originalMime: opts.mime,
    codec:        opts.codec ?? null,
    variants:     { original: opts.originalKey },
    dimensions:   { width: opts.width ?? null, height: opts.height ?? null },
    durationMs:   opts.durationMs ?? null,
    processing:   {},
    createdAt:    now,
    updatedAt:    now,
  };
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function writeManifest(
  s3:       S3Client,
  manifest: MediaManifest,
  opts:     { kind: MediaKind; id: string; date?: Date },
): Promise<string> {
  const key  = buildManifestKey(opts);
  const body = Buffer.from(JSON.stringify({ ...manifest, updatedAt: new Date().toISOString() }, null, 2));
  await s3.send(new PutObjectCommand({
    Bucket:        env.MINIO_BUCKET,
    Key:           key,
    Body:          body,
    ContentType:   "application/json",
    ContentLength: body.length,
    // Manifest is internal/mutable — never cache it at the edge.
    CacheControl:  "no-store",
  }));
  return key;
}

export async function readManifest(
  s3:   S3Client,
  opts: { kind: MediaKind; id: string; date?: Date },
): Promise<MediaManifest | null> {
  try {
    const obj = await s3.send(new GetObjectCommand({
      Bucket: env.MINIO_BUCKET,
      Key:    buildManifestKey(opts),
    }));
    if (!obj.Body) return null;
    return JSON.parse(await streamToString(obj.Body as NodeJS.ReadableStream)) as MediaManifest;
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchKey") return null;
    throw err;
  }
}

/**
 * Read-modify-write a manifest. The mutator receives a draft it can patch
 * (add variant keys, flip processing states); the merged result is persisted.
 * Not concurrency-safe across workers writing the *same* media simultaneously —
 * our task model guarantees one task per (mediaId,type), and distinct groups
 * touch disjoint keys, so last-writer-wins on the shared map is acceptable. If
 * contention ever matters, gate this behind a per-media Redis lock.
 */
export async function patchManifest(
  s3:      S3Client,
  opts:    { kind: MediaKind; id: string; date?: Date },
  mutate:  (draft: MediaManifest) => void,
): Promise<MediaManifest | null> {
  const current = await readManifest(s3, opts);
  if (!current) return null;
  mutate(current);
  await writeManifest(s3, current, opts);
  return current;
}
