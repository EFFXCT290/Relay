import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { ProblemError } from "../../backend-core/http/errors.js";
import {
  MediaUploadResponseSchema,
  MediaViewResponseSchema,
  MEDIA_EVENTS,
  type MediaViewedEvent,
} from "@relay/contracts";
import { uploadImage, uploadVideo, uploadVoice, mediaKindFromMime, resolveUploadMime, pickVideoStream } from "./media.service.js";
import { env } from "../../backend-core/runtime/env.js";

const mediaRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  // ── POST /api/media/upload ──────────────────────────────────────────────────
  fastify.post(
    "/media/upload",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: { 201: MediaUploadResponseSchema },
      },
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const callerId = request.userId!;
      const data = await request.file();

      if (!data) throw new ProblemError("bad_request", "No file uploaded.");

      // Trust a recognized browser MIME; otherwise sniff the extension (DNG/.mov
      // often arrive as octet-stream/empty).
      const mimeType = resolveUploadMime(data.mimetype, data.filename);
      const buffer   = await data.toBuffer();

      if (buffer.length === 0) throw new ProblemError("bad_request", "Empty file.");

      const clientUploadId = (request.headers["x-upload-id"] as string | undefined) ?? null;
      const kind           = mediaKindFromMime(mimeType);

      // Phase 6B: client picks delivery mode in the composer. Default optimized;
      // the server may auto-promote to lss (DNG/HEVC). Anything else is rejected.
      const modeHeader = (request.headers["x-delivery-mode"] as string | undefined)?.toLowerCase();
      if (modeHeader != null && modeHeader !== "optimized" && modeHeader !== "lss") {
        throw new ProblemError("validation_error", "Invalid delivery mode. Use 'optimized' or 'lss'.");
      }
      const requestedMode: "optimized" | "lss" = modeHeader === "lss" ? "lss" : "optimized";

      // Voice notes carry their measured duration in a header (the server can't
      // cheaply probe Opus length without decoding); images never set it.
      const durationHeader = request.headers["x-audio-duration-ms"] as string | undefined;
      const durationMs     = durationHeader != null && /^\d+$/.test(durationHeader)
        ? Number(durationHeader)
        : null;

      let result;
      try {
        result =
          kind === "voice" ? await uploadVoice(buffer, mimeType, durationMs, callerId, fastify.prisma, fastify.s3, clientUploadId)
        : kind === "video" ? await uploadVideo(buffer, mimeType, callerId, fastify.prisma, fastify.s3, clientUploadId, requestedMode)
        :                    await uploadImage(buffer, mimeType, callerId, fastify.prisma, fastify.s3, clientUploadId, requestedMode);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "unsupported_mime") {
          throw new ProblemError("validation_error", "Unsupported format. Use a JPEG/PNG/WEBP image or an Opus voice note.");
        }
        if (code === "too_large") {
          throw new ProblemError("validation_error", `File must be under ${env.MEDIA_MAX_SIZE_MB}MB.`);
        }
        if (code === "forbidden") {
          throw new ProblemError("forbidden", "Upload ID belongs to another user.");
        }
        if (code === "ECONNREFUSED" || code === "ENOTFOUND") {
          throw new ProblemError("internal_error", "Storage is temporarily unavailable. Try again shortly.");
        }
        throw err;
      }

      return reply.code(201).send({
        mediaId:   result.mediaId,
        mimeType:  result.mimeType,
        sizeBytes: result.sizeBytes,
        ...(result.width        != null ? { width:        result.width        } : {}),
        ...(result.height       != null ? { height:       result.height       } : {}),
        ...(result.durationMs   != null ? { durationMs:   result.durationMs   } : {}),
        ...(result.deliveryMode != null ? { deliveryMode: result.deliveryMode } : {}),
        ...(result.isLss        != null ? { isLss:        result.isLss        } : {}),
      });
    },
  );

  // ── GET /api/media/:mediaId/url ─────────────────────────────────────────────
  fastify.get(
    "/media/:mediaId/url",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params:   Type.Object({ mediaId: Type.String() }),
        response: { 200: Type.Object({ url: Type.String() }) },
      },
    },
    async (request) => {
      const { mediaId } = request.params;
      const media = await fastify.prisma.media.findUnique({
        where: { id: mediaId },
        include: { temporary: true },
      });
      if (!media) throw new ProblemError("not_found", "Media not found.");
      // Phase 6E: ephemeral media must NEVER be served through the generic URL
      // endpoint — that would hand out an unmetered link and bypass the view
      // count. The only path to ephemeral bytes is POST /media/:id/view.
      if (media.temporary) {
        throw new ProblemError("forbidden", "This media is view-once. Open it from the chat.");
      }
      const url = await fastify.getMediaUrl(media.storageKey);
      return { url };
    },
  );

  // ── POST /api/media/:mediaId/view (Phase 6E) ────────────────────────────────
  // Ephemeral view-count consume. Only a recipient (a participant who is NOT the
  // uploader) can spend a view. Atomically increments viewCount under a guard so
  // it can never exceed maxViews, stamps consumedAt at the cap, and returns a
  // short-lived signed URL for this single open — refused once consumed. Emits
  // media:viewed so the sender's "Opened X/N" and the recipient's other devices
  // stay in sync.
  fastify.post(
    "/media/:mediaId/view",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params:   Type.Object({ mediaId: Type.String() }),
        response: { 200: MediaViewResponseSchema },
      },
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request) => {
      const callerId = request.userId!;
      const { mediaId } = request.params;

      const media = await fastify.prisma.media.findUnique({
        where: { id: mediaId },
        include: {
          temporary: true,
          variants:  true,
          attachments: {
            include: {
              message: {
                include: {
                  conversation: { include: { participants: { select: { userId: true } } } },
                },
              },
            },
          },
        },
      });
      if (!media) throw new ProblemError("not_found", "Media not found.");

      // Authz: the caller must be a participant of a conversation this media was
      // sent into, and must not be the uploader.
      const att = media.attachments.find((a) =>
        a.message.conversation.participants.some((p) => p.userId === callerId),
      );
      if (!att) throw new ProblemError("forbidden", "You can't view this media.");
      if (media.uploaderId === callerId) {
        throw new ProblemError("forbidden", "You can't open your own view-once media.");
      }

      // For video, serve the browser-playable optimized stream (HEVC/.mov sources
      // are passthrough/transcoded by the worker). Images/voice use the original.
      const stream = att.type === "video" ? pickVideoStream(media.variants) : null;
      const keyToServe = stream?.storageKey ?? media.storageKey;

      // Don't spend a view on a video that isn't browser-ready yet: the optimized
      // stream hasn't been produced and the raw source may be unplayable. Refuse
      // WITHOUT incrementing/consuming so the recipient can retry once the worker
      // finishes. A failed transcode (status "failed") falls through and serves
      // the original best-effort rather than blocking forever.
      if (att.type === "video" && !stream && media.status === "processing") {
        throw new ProblemError("conflict", "Video is still processing. Try again in a moment.");
      }

      const temp = media.temporary;
      // Non-ephemeral media wouldn't show a locked card; just sign defensively.
      if (!temp) {
        const url = await fastify.getMediaUrl(keyToServe);
        return { consumed: false, viewCount: 0, maxViews: 0, url };
      }

      // Already spent before this request → no URL, no further mint.
      if (temp.consumedAt || temp.viewCount >= temp.maxViews) {
        return { consumed: true, viewCount: temp.viewCount, maxViews: temp.maxViews };
      }

      // Guarded atomic increment: bumps only while strictly under the cap, so a
      // double-tap (or a future second recipient) can never over-count.
      const viewedAt = new Date();
      const bumped = await fastify.prisma.temporaryMedia.updateMany({
        where: { mediaId, viewCount: { lt: temp.maxViews } },
        data:  { viewCount: { increment: 1 } },
      });
      const fresh = await fastify.prisma.temporaryMedia.findUnique({ where: { mediaId } });
      const viewCount = fresh?.viewCount ?? temp.maxViews;
      const consumed  = viewCount >= temp.maxViews;

      if (bumped.count === 0) {
        // Lost the race for the last view — refuse, no URL.
        return { consumed: true, viewCount, maxViews: temp.maxViews };
      }
      if (consumed && !fresh?.consumedAt) {
        await fastify.prisma.temporaryMedia.updateMany({
          where: { mediaId, consumedAt: null },
          data:  { consumedAt: viewedAt },
        });
      }

      // Short-lived URL for this single open; whoever spends the last view still
      // gets to see it this once.
      const url = await fastify.getMediaUrl(keyToServe, env.MEDIA_EPHEMERAL_SIGNED_URL_EXPIRY);

      const event: MediaViewedEvent = {
        mediaId,
        messageId: att.message.id,
        viewCount,
        maxViews:  temp.maxViews,
        consumed,
        viewedAt:  viewedAt.toISOString(),
      };
      for (const p of att.message.conversation.participants) {
        fastify.io.to(`user:${p.userId}`).emit(MEDIA_EVENTS.VIEWED, event);
      }

      return { consumed, viewCount, maxViews: temp.maxViews, url };
    },
  );
};

export default mediaRoutes;
