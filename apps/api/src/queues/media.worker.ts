import { Worker } from "bullmq";
import sharp from "sharp";
import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { PrismaClient } from "@prisma/client";
import type { Server as IOServer } from "socket.io";
import type { FastifyBaseLogger } from "fastify";
import { buildVariantKey, parseMediaKeyDate, assertPhase6BKey, isPhase6BKeyError } from "../modules/media/media.keys.js";
import { patchManifest } from "../modules/media/media.manifest.js";
import { createMediaRepository } from "../modules/media/media.repository.js";
import {
  transcodeH264,
  remuxPassthrough,
  extractPosterFrame,
  animatedPreview,
  ladderFor,
} from "../modules/media/media.transcode.js";
import { transcribeVoice } from "../modules/media/voice.transcribe.js";
import { env } from "../backend-core/runtime/env.js";
import {
  MEDIA_QUEUE_NAME,
  VIDEO_QUEUE_NAME,
  VOICE_QUEUE_NAME,
  PROCESS_IMAGE_JOB,
  PROCESS_VIDEO_JOB,
  TRANSCRIBE_VOICE_JOB,
  queueConnection,
  type ProcessImageJobData,
  type ProcessVideoJobData,
  type TranscribeVoiceJobData,
} from "./media.queue.js";
import {
  MEDIA_EVENTS,
  VOICE_EVENTS,
  type MediaReadyEvent,
  type MediaProcessedEvent,
  type VoiceTranscriptReadyEvent,
} from "@relay/contracts";

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
  }
  return Buffer.concat(chunks);
}

type WorkerDeps = {
  s3:     S3Client;
  prisma: PrismaClient;
  io:     IOServer;
  log:    FastifyBaseLogger;
};

const connection = { ...queueConnection(), maxRetriesPerRequest: null }; // null required by BullMQ workers

// Image variant generation — fast, runs at high concurrency.
export function createMediaWorker(deps: WorkerDeps) {
  const { log, prisma } = deps;

  const worker = new Worker<ProcessImageJobData>(
    MEDIA_QUEUE_NAME,
    (job) => processImage(deps, job.data),
    { connection, concurrency: 4 },
  );

  worker.on("failed", (job, err) => {
    const isSchemaViolation = isPhase6BKeyError(err);
    log.error(
      { err, jobId: job?.id, mediaId: job?.data.mediaId,
        ...(isSchemaViolation ? { phase6bCode: err.code, rejectedKey: err.key } : {}) },
      isSchemaViolation ? "[media-worker] image job failed — Phase-6B key violation" : "[media-worker] image job failed",
    );
    if (job?.data.mediaId) {
      void prisma.media.update({ where: { id: job.data.mediaId }, data: { status: "failed" } }).catch(() => {});
    }
  });

  return worker;
}

// Video transcoding — the heaviest CPU task. Its own queue with low concurrency
// (env VIDEO_TRANSCODE_CONCURRENCY, default 1) and a long lock so a multi-minute
// ffmpeg run isn't reclaimed mid-encode. Separation (6B.15) keeps a big video
// from blocking the snappy image pipeline.
export function createVideoWorker(deps: WorkerDeps) {
  const { log, prisma } = deps;

  const worker = new Worker<ProcessVideoJobData>(
    VIDEO_QUEUE_NAME,
    (job) => processVideo(deps, job.data),
    {
      connection,
      concurrency:  env.VIDEO_TRANSCODE_CONCURRENCY,
      lockDuration: 900_000, // up to 15 min for large transcodes
    },
  );

  worker.on("failed", (job, err) => {
    const isSchemaViolation = isPhase6BKeyError(err);
    const e = err as { stderr?: string; code?: number };
    log.error(
      { err, jobId: job?.id, mediaId: job?.data.mediaId,
        ...(isSchemaViolation ? { phase6bCode: err.code, rejectedKey: err.key } : { exitCode: e.code ?? null, stderr: e.stderr?.slice(0, 2000) }) },
      isSchemaViolation ? "[video-worker] video job failed — Phase-6B key violation" : "[video-worker] video job failed",
    );
    if (job?.data.mediaId) {
      void prisma.media.update({ where: { id: job.data.mediaId }, data: { status: "failed" } }).catch(() => {});
    }
  });

  return worker;
}

// Voice transcription — CPU-bound Whisper on its own queue, capped low so it
// can't starve the image pipeline or API/socket latency on a small VPS.
export function createVoiceWorker(deps: WorkerDeps) {
  const { log, prisma } = deps;

  const worker = new Worker<TranscribeVoiceJobData>(
    VOICE_QUEUE_NAME,
    (job) => transcribeVoiceJob(deps, job.data),
    {
      connection,
      concurrency:  env.VOICE_TRANSCRIBE_CONCURRENCY,
      lockDuration: 600_000, // Whisper on CPU can run for minutes; hold the lock
    },
  );

  worker.on("failed", (job, err) => {
    const e = err as { stderr?: string; code?: number };
    log.error(
      {
        job:      "voice_transcribe",
        mediaId:  job?.data.mediaId,
        jobId:    job?.id,
        exitCode: e.code ?? null,
        stderr:   e.stderr ? String(e.stderr).slice(0, 2000) : undefined,
        status:   "failed",
      },
      "[voice-worker] transcription failed",
    );
    if (job?.data.mediaId) {
      void prisma.media.update({ where: { id: job.data.mediaId }, data: { transcriptStatus: "failed" } }).catch(() => {});
      void createMediaRepository(prisma).setTaskState(job.data.mediaId, "TRANSCRIPT", "FAILED", String(e.stderr ?? "").slice(0, 500)).catch(() => {});
    }
  });

  return worker;
}

async function processImage(deps: WorkerDeps, data: ProcessImageJobData) {
  const { s3, prisma, io, log } = deps;
  const { mediaId, storageKey, uploaderId } = data;
  log.info({ mediaId }, "[media-worker] processing image");

  // Download original from MinIO.
  const obj = await s3.send(new GetObjectCommand({
    Bucket: env.MINIO_BUCKET,
    Key:    storageKey,
  }));
  if (!obj.Body) throw new Error(`Empty body for ${storageKey}`);
  const original = await streamToBuffer(obj.Body as NodeJS.ReadableStream);

      // Variants share the original's date partition — derive it from the
      // original key so retries/late jobs on a later UTC day don't scatter
      // variants across date folders. Falls back to now() only for legacy flat
      // keys (no date path), which never have variants generated anyway.
      const partitionDate = parseMediaKeyDate(storageKey) ?? undefined;

      let thumbKey:    string | null = null;
      let thumbWidth:  number | null = null;
      let thumbHeight: number | null = null;

      // Thumb variant — Phase 6B hierarchical key; WebP for consistency with
      // the new-model variants generateImageVariants also produces.
      try {
        const thumbBuf  = await sharp(original)
          .rotate()
          .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer();
        const thumbMeta = await sharp(thumbBuf).metadata();
        thumbKey    = buildVariantKey({ kind: "images", id: mediaId, group: "thumbnails", filename: "thumb_md.webp", date: partitionDate });
        assertPhase6BKey(thumbKey);
        thumbWidth  = thumbMeta.width  ?? null;
        thumbHeight = thumbMeta.height ?? null;
        await s3.send(new PutObjectCommand({
          Bucket:        env.MINIO_BUCKET,
          Key:           thumbKey,
          Body:          thumbBuf,
          ContentType:   "image/webp",
          ContentLength: thumbBuf.length,
        }));
      } catch (err) {
        log.warn({ err, mediaId }, "[media-worker] thumb generation failed");
      }

      // Update DB row with variant key + status.
      await prisma.media.update({
        where: { id: mediaId },
        data: {
          thumbStorageKey: thumbKey,
          thumbWidth,
          thumbHeight,
          status: "ready",
        },
      });

      // Sign URL and emit media:ready to the uploader's user room.
      const thumbUrl = thumbKey
        ? await getSignedUrl(s3, new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: thumbKey }), { expiresIn: env.MEDIA_SIGNED_URL_EXPIRY })
        : null;

      const event: MediaReadyEvent = {
        mediaId,
        blurUrl:    null,
        thumbUrl,
        blurWidth:  null,
        blurHeight: null,
        thumbWidth,
        thumbHeight,
      };
  io.to(`user:${uploaderId}`).emit(MEDIA_EVENTS.READY, event);

  // ── Phase 6B: per-mediaId folder layout — display variants + extra thumbnails ─
  // Produces WebP/AVIF display variants and sm/md/lg thumbnails, records them as
  // MediaVariant rows, and patches the manifest. Isolated so a failure here never
  // flips status back to "failed" after media:ready has already been emitted.
  try {
    await generateImageVariants(deps, data, original, partitionDate);
  } catch (err) {
    log.error({ err, mediaId }, "[media-worker] new-model variant generation failed (legacy variants unaffected)");
  }

  log.info({ mediaId, thumbKey }, "[media-worker] done");
}

// Logical variant name → produced key, accumulated so we can patch the manifest
// once at the end rather than read-modify-write per derivative.
type VariantOut = { name: string; key: string };

async function generateImageVariants(
  deps:          WorkerDeps,
  data:          ProcessImageJobData,
  original:      Buffer,
  partitionDate: Date | undefined,
) {
  const { s3, prisma, log } = deps;
  const { mediaId, isLss } = data;
  const repo = createMediaRepository(prisma);
  const produced: VariantOut[] = [];

  // Produce one rendition, upload it, and upsert its MediaVariant row.
  const emit = async (opts: {
    name:     string;                       // manifest logical name
    group:    "optimized" | "thumbnails";
    filename: string;
    type:     "OPTIMIZED" | "THUMBNAIL";
    label:    string;
    buf:      Buffer;
    mime:     string;
  }) => {
    const key = buildVariantKey({ kind: "images", id: mediaId, group: opts.group, filename: opts.filename, date: partitionDate });
    assertPhase6BKey(key);
    const meta = await sharp(opts.buf).metadata();
    await s3.send(new PutObjectCommand({
      Bucket: env.MINIO_BUCKET, Key: key, Body: opts.buf,
      ContentType: opts.mime, ContentLength: opts.buf.length,
      // Optimized + thumbnail derivatives are immutable → cache hard at the edge.
      CacheControl: "public, max-age=31536000, immutable",
    }));
    await repo.upsertVariant({
      mediaId, type: opts.type, label: opts.label, storageKey: key, mimeType: opts.mime,
      width: meta.width ?? null, height: meta.height ?? null, sizeBytes: opts.buf.length,
    });
    produced.push({ name: opts.name, key });
  };

  // Thumbnails (always — feed needs them, including for LSS originals).
  let thumbState: "ready" | "failed" = "ready";
  try {
    await repo.setTaskState(mediaId, "THUMBNAIL", "PROCESSING");
    for (const t of [{ label: "sm", w: 160 }, { label: "md", w: 480 }, { label: "lg", w: 1080 }]) {
      const buf = await sharp(original).rotate()
        .resize({ width: t.w, height: t.w, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 }).toBuffer();
      await emit({ name: `thumb_${t.label}`, group: "thumbnails", filename: `thumb_${t.label}.webp`, type: "THUMBNAIL", label: t.label, buf, mime: "image/webp" });
    }
    await repo.setTaskState(mediaId, "THUMBNAIL", "READY");
  } catch (err) {
    thumbState = "failed";
    log.warn({ err, mediaId }, "[media-worker] thumbnail variants failed");
    await repo.setTaskState(mediaId, "THUMBNAIL", "FAILED", String((err as Error).message).slice(0, 500)).catch(() => {});
  }

  // Optimized display variants — skipped for LSS (original is the delivery asset).
  let optState: "ready" | "failed" | undefined;
  if (!isLss) {
    optState = "ready";
    try {
      await repo.setTaskState(mediaId, "TRANSCODE", "PROCESSING");
      const display = await sharp(original).rotate()
        .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 }).toBuffer();
      await emit({ name: "display", group: "optimized", filename: "display.webp", type: "OPTIMIZED", label: "", buf: display, mime: "image/webp" });

      const display2x = await sharp(original).rotate()
        .resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 }).toBuffer();
      await emit({ name: "display@2x", group: "optimized", filename: "display@2x.webp", type: "OPTIMIZED", label: "2x", buf: display2x, mime: "image/webp" });

      const avif = await sharp(original).rotate()
        .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .avif({ quality: 50 }).toBuffer();
      await emit({ name: "avif", group: "optimized", filename: "display.avif", type: "OPTIMIZED", label: "avif", buf: avif, mime: "image/avif" });

      await repo.setTaskState(mediaId, "TRANSCODE", "READY");
    } catch (err) {
      optState = "failed";
      log.warn({ err, mediaId }, "[media-worker] optimized variants failed");
      await repo.setTaskState(mediaId, "TRANSCODE", "FAILED", String((err as Error).message).slice(0, 500)).catch(() => {});
    }
  }

  // Patch the manifest once with everything produced.
  await patchManifest(s3, { kind: "images", id: mediaId, date: partitionDate }, (m) => {
    for (const v of produced) m.variants[v.name] = v.key;
    m.processing.thumbnail = thumbState;
    if (optState) m.processing.transcode = optState;
  }).catch((err) => log.warn({ err, mediaId }, "[media-worker] manifest patch failed"));
}

async function processVideo(deps: WorkerDeps, data: ProcessVideoJobData) {
  const { s3, prisma, io, log } = deps;
  const { mediaId, storageKey, uploaderId, isLss, isHevc, height } = data;
  const repo = createMediaRepository(prisma);
  const partitionDate = parseMediaKeyDate(storageKey) ?? undefined;
  log.info({ mediaId, isHevc, isLss, height }, "[video-worker] processing video");

  // Download original once; ffmpeg/sharp operate on the buffer via temp files.
  const obj = await s3.send(new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: storageKey }));
  if (!obj.Body) throw new Error(`Empty body for ${storageKey}`);
  const original = await streamToBuffer(obj.Body as NodeJS.ReadableStream);

  const produced: VariantOut[] = [];
  const put = async (opts: {
    name: string; group: "optimized" | "previews" | "thumbnails"; filename: string;
    type: "OPTIMIZED" | "POSTER" | "PREVIEW" | "THUMBNAIL"; label: string;
    buf: Buffer; mime: string; codec?: string | null; width?: number | null; height?: number | null;
  }) => {
    const key = buildVariantKey({ kind: "videos", id: mediaId, group: opts.group, filename: opts.filename, date: partitionDate });
    assertPhase6BKey(key);
    await s3.send(new PutObjectCommand({
      Bucket: env.MINIO_BUCKET, Key: key, Body: opts.buf,
      ContentType: opts.mime, ContentLength: opts.buf.length,
      CacheControl: "public, max-age=31536000, immutable",
    }));
    await repo.upsertVariant({
      mediaId, type: opts.type, label: opts.label, storageKey: key, mimeType: opts.mime,
      codec: opts.codec ?? null, width: opts.width ?? null, height: opts.height ?? null, sizeBytes: opts.buf.length,
    });
    produced.push({ name: opts.name, key });
  };

  // ── Poster + thumbnails (from a single extracted frame) ───────────────────
  let posterState: "ready" | "failed" = "ready";
  let thumbState:  "ready" | "failed" = "ready";
  let posterKey: string | null = null;
  let thumbKey:  string | null = null;
  try {
    await repo.setTaskState(mediaId, "POSTER", "PROCESSING");
    await repo.setTaskState(mediaId, "THUMBNAIL", "PROCESSING");
    const frame = await extractPosterFrame(original, 1);

    const posterWebp = await sharp(frame).resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    const pMeta = await sharp(posterWebp).metadata();
    await put({ name: "poster", group: "previews", filename: "poster.webp", type: "POSTER", label: "", buf: posterWebp, mime: "image/webp", width: pMeta.width ?? null, height: pMeta.height ?? null });
    posterKey = produced[produced.length - 1]!.key;

    const posterJpg = await sharp(frame).resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    await put({ name: "poster_jpg", group: "previews", filename: "poster.jpg", type: "POSTER", label: "jpg", buf: posterJpg, mime: "image/jpeg" });
    await repo.setTaskState(mediaId, "POSTER", "READY");

    for (const t of [{ label: "sm", w: 160 }, { label: "md", w: 480 }]) {
      const buf = await sharp(frame).resize({ width: t.w, height: t.w, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
      await put({ name: `thumb_${t.label}`, group: "thumbnails", filename: `thumb_${t.label}.webp`, type: "THUMBNAIL", label: t.label, buf, mime: "image/webp" });
      if (t.label === "md") thumbKey = produced[produced.length - 1]!.key;
    }
    await repo.setTaskState(mediaId, "THUMBNAIL", "READY");
  } catch (err) {
    posterState = "failed"; thumbState = "failed";
    log.warn({ err, mediaId }, "[video-worker] poster/thumbnail failed");
    await repo.setTaskState(mediaId, "POSTER", "FAILED", String((err as Error).message).slice(0, 500)).catch(() => {});
    await repo.setTaskState(mediaId, "THUMBNAIL", "FAILED", String((err as Error).message).slice(0, 500)).catch(() => {});
  }

  // ── Animated preview (best-effort, no task row) ───────────────────────────
  try {
    const preview = await animatedPreview(original, 3, 360);
    await put({ name: "animated_preview", group: "previews", filename: "animated_preview.mp4", type: "PREVIEW", label: "", buf: preview, mime: "video/mp4", codec: "h264" });
  } catch (err) {
    log.warn({ err, mediaId }, "[video-worker] animated preview failed");
  }

  // ── Streaming delivery: H.264 ladder (optimized) or passthrough (HEVC/LSS) ─
  let transcodeState: "ready" | "failed" = "ready";
  let streamKey: string | null = null;
  try {
    await repo.setTaskState(mediaId, "TRANSCODE", "PROCESSING");
    if (isLss || isHevc) {
      const passthrough = await remuxPassthrough(original);
      await put({ name: "passthrough", group: "optimized", filename: "passthrough.mp4", type: "OPTIMIZED", label: "passthrough", buf: passthrough, mime: "video/mp4", codec: isHevc ? "hevc" : null, height });
      streamKey = produced[produced.length - 1]!.key;
    } else {
      const rungs = ladderFor(height);
      for (const rung of rungs) {
        const out = await transcodeH264(original, rung.height, rung.crf);
        await put({ name: `stream_${rung.label}`, group: "optimized", filename: `stream_${rung.label}.mp4`, type: "OPTIMIZED", label: rung.label, buf: out, mime: "video/mp4", codec: "h264", height: rung.height });
        // Highest rung produced is the default stream URL surfaced to clients.
        streamKey = produced[produced.length - 1]!.key;
      }
    }
    await repo.setTaskState(mediaId, "TRANSCODE", "READY");
  } catch (err) {
    transcodeState = "failed";
    log.warn({ err, mediaId }, "[video-worker] transcode failed");
    await repo.setTaskState(mediaId, "TRANSCODE", "FAILED", String((err as Error).message).slice(0, 500)).catch(() => {});
  }

  // Patch manifest + flip the media row to ready (failed only if the playable
  // stream couldn't be produced — poster/thumb failing alone still leaves a
  // usable original).
  await patchManifest(s3, { kind: "videos", id: mediaId, date: partitionDate }, (m) => {
    for (const v of produced) m.variants[v.name] = v.key;
    m.processing.poster    = posterState;
    m.processing.thumbnail = thumbState;
    m.processing.transcode = transcodeState;
  }).catch((err) => log.warn({ err, mediaId }, "[video-worker] manifest patch failed"));

  const finalStatus = transcodeState === "failed" ? "failed" : "ready";
  await prisma.media.update({ where: { id: mediaId }, data: { status: finalStatus } });

  // Emit the unified event with freshly-signed URLs so live clients can swap the
  // poster for the playable stream without refetching the message.
  const sign = (k: string | null) =>
    k ? getSignedUrl(s3, new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: k }), { expiresIn: env.MEDIA_SIGNED_URL_EXPIRY }) : Promise.resolve(null);
  const [posterUrl, thumbUrl, streamUrl] = await Promise.all([sign(posterKey), sign(thumbKey), sign(streamKey)]);
  const event: MediaProcessedEvent = {
    mediaId, kind: "video", status: finalStatus,
    posterUrl, thumbUrl, streamUrl,
    width: data.width, height: data.height, durationMs: data.durationMs,
  };
  io.to(`user:${uploaderId}`).emit(MEDIA_EVENTS.PROCESSED, event);

  log.info({ mediaId, status: finalStatus, variants: produced.length }, "[video-worker] done");
}

async function transcribeVoiceJob(deps: WorkerDeps, data: TranscribeVoiceJobData) {
  const { s3, prisma, io, log } = deps;
  const { mediaId, attachmentId, messageId, conversationId, storageKey } = data;
  const jobStart = Date.now();

  // 6B.18: voice shares the MediaProcessingTask state machine. ensureTask is
  // idempotent (the route already created it); a throw later flips it to FAILED
  // via the worker's failed handler.
  const repo = createMediaRepository(prisma);
  await repo.ensureTask(mediaId, "TRANSCRIPT").catch(() => {});
  await repo.setTaskState(mediaId, "TRANSCRIPT", "PROCESSING").catch(() => {});

  // Reuse an already-computed transcript (e.g. same media re-sent) instead of
  // running Whisper again — just re-emit it to this message's recipients.
  const existing = await prisma.media.findUnique({
    where:  { id: mediaId },
    select: { transcript: true, transcriptStatus: true, durationMs: true },
  });

  let transcript = existing?.transcript ?? null;
  const cached   = existing?.transcriptStatus === "ready" && !!transcript;

  if (!cached) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: storageKey }));
    if (!obj.Body) throw new Error(`Empty body for ${storageKey}`);
    const audio = await streamToBuffer(obj.Body as NodeJS.ReadableStream);

    // Subprocess errors propagate (with .stderr/.code) to the worker's failed
    // handler, which logs the detail and marks transcriptStatus "failed".
    const result = await transcribeVoice(audio);
    transcript = result.transcript as unknown as typeof transcript;
    await prisma.media.update({
      where: { id: mediaId },
      data:  { transcript: result.transcript as never, transcriptStatus: "ready" },
    });

    // Structured success log — one line per transcription for grepping/alerting.
    log.info(
      {
        job:          "voice_transcribe",
        mediaId,
        messageId,
        durationMs:   existing?.durationMs ?? null,
        whisperModel: env.WHISPER_MODEL,
        ffmpegMs:     result.ffmpegMs,
        transcribeMs: result.transcribeMs,
        totalMs:      Date.now() - jobStart,
        segments:     result.transcript.segments.length,
        primaryLanguage: result.transcript.primaryLanguage,
        status:       "success",
      },
      "[voice-worker] transcription success",
    );
  }

  // Notify every participant so live chats patch the transcript into the bubble.
  const participants = await prisma.participant.findMany({
    where:  { conversationId },
    select: { userId: true },
  });
  const event: VoiceTranscriptReadyEvent = {
    messageId,
    attachmentId,
    mediaId,
    transcriptStatus: "ready",
    transcript: transcript as VoiceTranscriptReadyEvent["transcript"],
  };
  for (const p of participants) {
    io.to(`user:${p.userId}`).emit(VOICE_EVENTS.TRANSCRIPT_READY, event);
  }

  await repo.setTaskState(mediaId, "TRANSCRIPT", "READY").catch(() => {});
}
