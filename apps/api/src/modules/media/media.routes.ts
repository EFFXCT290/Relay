import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { ProblemError } from "../../backend-core/http/errors.js";
import { MediaUploadResponseSchema } from "@relay/contracts";
import { uploadImage, uploadVoice, findMedia, mediaKindFromMime } from "./media.service.js";
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

      const mimeType = data.mimetype;
      const buffer   = await data.toBuffer();

      if (buffer.length === 0) throw new ProblemError("bad_request", "Empty file.");

      const clientUploadId = (request.headers["x-upload-id"] as string | undefined) ?? null;
      const kind           = mediaKindFromMime(mimeType);

      // Voice notes carry their measured duration in a header (the server can't
      // cheaply probe Opus length without decoding); images never set it.
      const durationHeader = request.headers["x-audio-duration-ms"] as string | undefined;
      const durationMs     = durationHeader != null && /^\d+$/.test(durationHeader)
        ? Number(durationHeader)
        : null;

      let result;
      try {
        result = kind === "voice"
          ? await uploadVoice(buffer, mimeType, durationMs, callerId, fastify.prisma, fastify.s3, clientUploadId)
          : await uploadImage(buffer, mimeType, callerId, fastify.prisma, fastify.s3, clientUploadId);
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
        ...(result.width      != null ? { width:      result.width      } : {}),
        ...(result.height     != null ? { height:     result.height     } : {}),
        ...(result.durationMs != null ? { durationMs: result.durationMs } : {}),
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
      const media = await findMedia(mediaId, fastify.prisma);
      if (!media) throw new ProblemError("not_found", "Media not found.");
      const url = await fastify.getMediaUrl(media.storageKey);
      return { url };
    },
  );
};

export default mediaRoutes;
