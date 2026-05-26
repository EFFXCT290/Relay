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
import { buildMediaKey, parseMediaKeyDate } from "../modules/media/media.keys.js";
import { transcribeVoice } from "../modules/media/voice.transcribe.js";
import { env } from "../backend-core/runtime/env.js";
import {
  MEDIA_QUEUE_NAME,
  VOICE_QUEUE_NAME,
  PROCESS_IMAGE_JOB,
  TRANSCRIBE_VOICE_JOB,
  queueConnection,
  type ProcessImageJobData,
  type TranscribeVoiceJobData,
} from "./media.queue.js";
import {
  MEDIA_EVENTS,
  VOICE_EVENTS,
  type MediaReadyEvent,
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
    log.error({ err, jobId: job?.id, mediaId: job?.data.mediaId }, "[media-worker] image job failed");
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

      let blurKey:    string | null = null;
      let blurWidth:  number | null = null;
      let blurHeight: number | null = null;
      let thumbKey:   string | null = null;
      let thumbWidth:  number | null = null;
      let thumbHeight: number | null = null;

      // Blur variant
      try {
        const blurBuf  = await sharp(original).rotate().resize(32).blur().jpeg({ quality: 40 }).toBuffer();
        const blurMeta = await sharp(blurBuf).metadata();
        blurKey    = buildMediaKey({ kind: "images", id: mediaId, variant: "blur",  ext: ".jpg", date: partitionDate });
        blurWidth  = blurMeta.width  ?? null;
        blurHeight = blurMeta.height ?? null;
        await s3.send(new PutObjectCommand({
          Bucket:        env.MINIO_BUCKET,
          Key:           blurKey,
          Body:          blurBuf,
          ContentType:   "image/jpeg",
          ContentLength: blurBuf.length,
        }));
      } catch (err) {
        log.warn({ err, mediaId }, "[media-worker] blur generation failed");
      }

      // Thumb variant
      try {
        const thumbBuf  = await sharp(original)
          .rotate()
          .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer();
        const thumbMeta = await sharp(thumbBuf).metadata();
        thumbKey    = buildMediaKey({ kind: "images", id: mediaId, variant: "thumb", ext: ".jpg", date: partitionDate });
        thumbWidth  = thumbMeta.width  ?? null;
        thumbHeight = thumbMeta.height ?? null;
        await s3.send(new PutObjectCommand({
          Bucket:        env.MINIO_BUCKET,
          Key:           thumbKey,
          Body:          thumbBuf,
          ContentType:   "image/jpeg",
          ContentLength: thumbBuf.length,
        }));
      } catch (err) {
        log.warn({ err, mediaId }, "[media-worker] thumb generation failed");
      }

      // Update DB row with variant keys + status.
      await prisma.media.update({
        where: { id: mediaId },
        data: {
          blurStorageKey:  blurKey,
          thumbStorageKey: thumbKey,
          blurWidth,
          blurHeight,
          thumbWidth,
          thumbHeight,
          status: "ready",
        },
      });

      // Sign URLs and emit media:ready to the uploader's user room.
      const [blurUrl, thumbUrl] = await Promise.all([
        blurKey  ? getSignedUrl(s3, new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: blurKey }),  { expiresIn: env.MEDIA_SIGNED_URL_EXPIRY }) : Promise.resolve(null),
        thumbKey ? getSignedUrl(s3, new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: thumbKey }), { expiresIn: env.MEDIA_SIGNED_URL_EXPIRY }) : Promise.resolve(null),
      ]);

      const event: MediaReadyEvent = {
        mediaId,
        blurUrl,
        thumbUrl,
        blurWidth,
        blurHeight,
        thumbWidth,
        thumbHeight,
      };
  io.to(`user:${uploaderId}`).emit(MEDIA_EVENTS.READY, event);

  log.info({ mediaId, blurKey, thumbKey }, "[media-worker] done");
}

async function transcribeVoiceJob(deps: WorkerDeps, data: TranscribeVoiceJobData) {
  const { s3, prisma, io, log } = deps;
  const { mediaId, attachmentId, messageId, conversationId, storageKey } = data;
  const jobStart = Date.now();

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
}
