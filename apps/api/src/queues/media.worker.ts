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
import { buildMediaKey } from "../modules/media/media.keys.js";
import { env } from "../backend-core/runtime/env.js";
import {
  MEDIA_QUEUE_NAME,
  PROCESS_IMAGE_JOB,
  type ProcessImageJobData,
} from "./media.queue.js";
import { MEDIA_EVENTS, type MediaReadyEvent } from "@relay/contracts";

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export function createMediaWorker(deps: {
  s3:     S3Client;
  prisma: PrismaClient;
  io:     IOServer;
  log:    FastifyBaseLogger;
}) {
  const { s3, prisma, io, log } = deps;

  const worker = new Worker<ProcessImageJobData>(
    MEDIA_QUEUE_NAME,
    async (job) => {
      if (job.name !== PROCESS_IMAGE_JOB) return;

      const { mediaId, storageKey, mimeType, uploaderId } = job.data;
      log.info({ mediaId }, "[media-worker] processing image");

      // Download original from MinIO.
      const obj = await s3.send(new GetObjectCommand({
        Bucket: env.MINIO_BUCKET,
        Key:    storageKey,
      }));
      if (!obj.Body) throw new Error(`Empty body for ${storageKey}`);
      const original = await streamToBuffer(obj.Body as NodeJS.ReadableStream);

      // Determine today's date for key construction (same date path as upload time).
      // We re-derive via buildMediaKey — it uses today's date; storageKey already
      // has the correct date baked in but we can't extract it cheaply. Using today
      // is fine: blur/thumb variants always share the same id prefix as original.
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
        blurKey    = buildMediaKey({ kind: "images", id: mediaId, variant: "blur",  ext: ".jpg" });
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
        thumbKey    = buildMediaKey({ kind: "images", id: mediaId, variant: "thumb", ext: ".jpg" });
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
    },
    {
      connection: {
        host:               new URL(env.REDIS_URL).hostname,
        port:               Number(new URL(env.REDIS_URL).port || 6379),
        password:           new URL(env.REDIS_URL).password || undefined,
        maxRetriesPerRequest: null, // required by BullMQ workers
      },
      concurrency: 4,
    },
  );

  worker.on("failed", (job, err) => {
    log.error({ err, jobId: job?.id, mediaId: job?.data.mediaId }, "[media-worker] job failed");
    // Mark failed in DB so clients aren't left waiting.
    if (job?.data.mediaId) {
      void prisma.media.update({
        where: { id: job.data.mediaId },
        data: { status: "failed" },
      }).catch(() => {});
    }
  });

  return worker;
}
