import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { ProblemError } from "../../backend-core/http/errors.js";
import { MESSAGE_EVENTS, MessageSchema, MessageAttachmentSchema } from "@relay/contracts";
import { serializeAttachment, mediaKindFromMime } from "../media/media.service.js";
import { voiceQueue, TRANSCRIBE_VOICE_JOB } from "../../queues/media.queue.js";
import { SyncService } from "../sync/sync.service.js";
import { SyncRepository } from "../sync/sync.repository.js";
import {
  emitMessageDeleted,
  emitMessageEdited,
  emitMessageEmbedUpdate,
  emitMessageEmbedUpdateToUser,
  emitMessageNew,
  emitMessageNewToUser,
  emitMessageReaction,
} from "./message.socket.js";
import { extractUrls } from "./utils/extract-urls.js";
import { fetchEmbed } from "./services/embed.service.js";

// Guards that the caller is a participant of conversationId. Returns the
// conversation row when authorized; throws ProblemError otherwise.
async function assertParticipant(
  fastify: import("fastify").FastifyInstance,
  callerId: string,
  conversationId: string,
) {
  const conv = await fastify.prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { participants: { select: { userId: true } } },
  });
  if (!conv) throw new ProblemError("not_found", "Conversation not found.");
  if (!conv.participants.some((p) => p.userId === callerId)) {
    throw new ProblemError("forbidden", "You are not a participant.");
  }
  return conv;
}

const messageRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  // ── GET /api/conversations/:id/messages ───────────────────────────────────
  fastify.get(
    "/conversations/:conversationId/messages",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: Type.Object({ conversationId: Type.String({ format: "uuid" }) }),
        querystring: Type.Object({
          cursor: Type.Optional(Type.String({ format: "uuid" })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })),
        }),
        response: {
          200: Type.Object({
            messages: Type.Array(MessageSchema),
            nextCursor: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
          }),
        },
      },
    },
    async (request) => {
      const callerId = request.userId!;
      const { conversationId } = request.params;
      const { cursor, limit = 30 } = request.query;
      await assertParticipant(fastify, callerId, conversationId);

      const rows = await fastify.prisma.message.findMany({
        where: { conversationId },
        include: {
          sender:      { select: { id: true, username: true } },
          replyTo:     { select: { id: true, body: true, type: true } },
          reactions:   { select: { emoji: true, userId: true } },
          reads:       { select: { readerId: true, readAt: true } },
          embed:       true,
          attachments: { include: { media: true } },
        },
        orderBy: { createdAt: "desc" },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const slice = hasMore ? rows.slice(0, -1) : rows;
      const nextCursor = hasMore ? slice[slice.length - 1]?.id ?? null : null;

      const messages = await Promise.all(slice.map(async (m) => {
        const counts: Record<string, number> = {};
        let mine: string | null = null;
        for (const r of m.reactions) {
          counts[r.emoji] = (counts[r.emoji] ?? 0) + 1;
          if (r.userId === callerId) mine = r.emoji;
        }

        const attachments = await Promise.all(
          (m.attachments ?? []).map((att) =>
            serializeAttachment(att.id, att.type, att.media, (key) => fastify.getMediaUrl(key)),
          ),
        );

        return {
          messageId:      m.id,
          conversationId: m.conversationId,
          senderId:       m.senderId,
          senderUsername: m.sender.username,
          type:           m.type,
          body:           m.isDeleted ? null : m.body,
          replyTo: m.replyTo
            ? {
                messageId: m.replyTo.id,
                preview:   m.replyTo.body ? m.replyTo.body.slice(0, 80) : null,
                type:      m.replyTo.type,
              }
            : null,
          isEdited:    m.isEdited,
          editedAt:    m.editedAt ? m.editedAt.toISOString() : null,
          isDeleted:   m.isDeleted,
          reactions:   counts,
          myReaction:  mine,
          readBy:      m.reads.map((r) => ({ userId: r.readerId, readAt: r.readAt.toISOString() })),
          deliveredAt: m.deliveredAt ? m.deliveredAt.toISOString() : null,
          createdAt:   m.createdAt.toISOString(),
          embed: m.embed
            ? {
                url:         m.embed.url,
                title:       m.embed.title,
                description: m.embed.description,
                imageUrl:    m.embed.imageUrl,
                siteName:    m.embed.siteName,
                faviconUrl:  m.embed.faviconUrl,
                provider:    m.embed.provider,
              }
            : null,
          ...(attachments.length > 0 ? { attachments } : {}),
        };
      }));

      return { messages, nextCursor };
    },
  );

  // ── POST /api/conversations/:id/messages (text) ──────────────────────────
  fastify.post(
    "/conversations/:conversationId/messages",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: Type.Object({ conversationId: Type.String({ format: "uuid" }) }),
        body: Type.Object({
          body:            Type.String({ minLength: 1, maxLength: 4000 }),
          replyToId:       Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
          clientMessageId: Type.Optional(Type.String({ format: "uuid" })),
        }),
        response: {
          201: Type.Object({
            messageId:      Type.String({ format: "uuid" }),
            conversationId: Type.String({ format: "uuid" }),
            senderId:       Type.String({ format: "uuid" }),
            senderUsername: Type.String(),
            type:           Type.Literal("TEXT"),
            body:           Type.String(),
            replyTo:        Type.Union([Type.Null(), Type.Object({ messageId: Type.String(), preview: Type.Union([Type.String(), Type.Null()]), type: Type.String() })]),
            reactions:      Type.Record(Type.String(), Type.Integer()),
            myReaction:     Type.Union([Type.String(), Type.Null()]),
            readBy:         Type.Array(Type.Object({ userId: Type.String({ format: "uuid" }), readAt: Type.String({ format: "date-time" }) })),
            deliveredAt:    Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
            createdAt:      Type.String({ format: "date-time" }),
          }),
        },
      },
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const callerId = request.userId!;
      const { conversationId } = request.params;
      const { body, replyToId, clientMessageId } = request.body;
      await assertParticipant(fastify, callerId, conversationId);

      // Idempotency: if this clientMessageId was already committed, return the
      // existing message instead of creating a duplicate (handles retries and
      // double-taps safely).
      if (clientMessageId) {
        const existing = await fastify.prisma.message.findUnique({
          where: { senderId_clientMessageId: { senderId: callerId, clientMessageId } },
          include: {
            sender:  { select: { username: true } },
            replyTo: { select: { id: true, body: true, type: true } },
          },
        });
        if (existing) {
          return reply.code(201).send({
            messageId:      existing.id,
            conversationId: existing.conversationId,
            senderId:       existing.senderId,
            senderUsername: existing.sender.username,
            type:           "TEXT" as const,
            body:           existing.body!,
            replyTo:        existing.replyTo
              ? { messageId: existing.replyTo.id, preview: existing.replyTo.body?.slice(0, 80) ?? null, type: existing.replyTo.type }
              : null,
            reactions:   {} as Record<string, number>,
            myReaction:  null as string | null,
            readBy:      [] as { userId: string; readAt: string }[],
            deliveredAt: existing.deliveredAt ? existing.deliveredAt.toISOString() : null,
            createdAt:   existing.createdAt.toISOString(),
          });
        }
      }

      if (replyToId) {
        const parent = await fastify.prisma.message.findUnique({
          where: { id: replyToId },
          select: { conversationId: true, body: true, type: true, id: true },
        });
        if (!parent || parent.conversationId !== conversationId) {
          throw new ProblemError("bad_request", "replyToId is not in this conversation.");
        }
      }

      const participants = await fastify.prisma.participant.findMany({
        where: { conversationId },
        select: { userId: true },
      });
      const otherIds = participants.map((p) => p.userId).filter((uid) => uid !== callerId);
      const allRecipientsOnline =
        otherIds.length > 0 &&
        otherIds.every((uid) => (fastify.io.sockets.adapter.rooms.get(`user:${uid}`)?.size ?? 0) > 0);
      const deliveredAt = allRecipientsOnline ? new Date() : null;

      const created = await fastify.prisma.$transaction(async (tx) => {
        const msg = await tx.message.create({
          data: {
            conversationId,
            senderId: callerId,
            type:     "TEXT",
            body,
            ...(replyToId       ? { replyToId }       : {}),
            ...(deliveredAt     ? { deliveredAt }      : {}),
            ...(clientMessageId ? { clientMessageId }  : {}),
          },
          include: {
            replyTo: { select: { id: true, body: true, type: true } },
            sender:  { select: { username: true } },
          },
        });
        await tx.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
        return msg;
      });

      const httpPayload = {
        messageId:      created.id,
        conversationId: created.conversationId,
        senderId:       created.senderId,
        senderUsername: created.sender.username,
        type:           "TEXT" as const,
        body:           created.body!,
        replyTo: created.replyTo
          ? { messageId: created.replyTo.id, preview: created.replyTo.body ? created.replyTo.body.slice(0, 80) : null, type: created.replyTo.type }
          : null,
        reactions:   {} as Record<string, number>,
        myReaction:  null as string | null,
        readBy:      [] as { userId: string; readAt: string }[],
        deliveredAt: created.deliveredAt ? created.deliveredAt.toISOString() : null,
        createdAt:   created.createdAt.toISOString(),
      };

      // clientMessageId is included so the sender's client can atomically swap
      // its optimistic tempId placeholder for the real server ID on WS echo.
      const broadcastMessage = { ...httpPayload, isEdited: false, editedAt: null, isDeleted: false, clientMessageId: clientMessageId ?? null };
      emitMessageNew(fastify.io, conversationId, { message: broadcastMessage });
      for (const p of participants) emitMessageNewToUser(fastify.io, p.userId, { message: broadcastMessage });

      // Record in outbox per recipient, scoped to this conversation, so
      // replay requests can be narrowed without returning unrelated events.
      // Each recipient gets a unique eventId so their ACK is independent.
      const syncSvc = new SyncService(new SyncRepository(fastify.prisma));
      await Promise.all(
        otherIds.map((uid) =>
          syncSvc.record(
            {
              eventId:   randomUUID(),
              eventName: MESSAGE_EVENTS.NEW,
              payload:   { message: broadcastMessage },
              timestamp: created.createdAt.toISOString(),
            },
            uid,
            conversationId,
          ),
        ),
      );

      // Async embed fetch — does not block the HTTP response.
      void (async () => {
        try {
          const urls = extractUrls(body);
          const firstUrl = urls[0];
          fastify.log.info({ firstUrl, body }, "[embed] extractUrls result");
          if (!firstUrl) return;
          const embedData = await fetchEmbed(firstUrl);
          fastify.log.info({ embedData, firstUrl }, "[embed] fetchEmbed result");
          if (!embedData) return;
          try {
            await fastify.prisma.messageEmbed.create({
              data: {
                messageId:   created.id,
                url:         embedData.url,
                title:       embedData.title,
                description: embedData.description,
                imageUrl:    embedData.imageUrl,
                siteName:    embedData.siteName,
                faviconUrl:  embedData.faviconUrl,
                type:        embedData.type,
                provider:    embedData.provider,
              },
            });
          } catch (dbErr) {
            fastify.log.warn({ dbErr }, "[embed] DB insert failed (likely duplicate), skipping emit");
            return;
          }
          const embedEvent = {
            messageId: created.id,
            embed: {
              url: embedData.url, title: embedData.title, description: embedData.description,
              imageUrl: embedData.imageUrl, siteName: embedData.siteName,
              faviconUrl: embedData.faviconUrl, provider: embedData.provider,
            },
          };
          fastify.log.info({ messageId: created.id, conversationId }, "[embed] emitting message:embed:update");
          emitMessageEmbedUpdate(fastify.io, conversationId, embedEvent);
          for (const p of participants) emitMessageEmbedUpdateToUser(fastify.io, p.userId, embedEvent);
        } catch (err) {
          fastify.log.error({ err }, "[embed] unhandled error in embed IIFE");
        }
      })();

      return reply.code(201).send(httpPayload);
    },
  );

  // ── POST /api/conversations/:id/messages/media ───────────────────────────
  fastify.post(
    "/conversations/:conversationId/messages/media",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: Type.Object({ conversationId: Type.String({ format: "uuid" }) }),
        body: Type.Object({
          mediaIds:  Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
          replyToId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
        }),
        response: {
          201: Type.Object({
            messageId:      Type.String({ format: "uuid" }),
            conversationId: Type.String({ format: "uuid" }),
            senderId:       Type.String({ format: "uuid" }),
            type:           Type.Union([Type.Literal("IMAGE"), Type.Literal("AUDIO")]),
            body:           Type.Null(),
            replyTo:        Type.Union([Type.Null(), Type.Object({ messageId: Type.String(), preview: Type.Union([Type.String(), Type.Null()]), type: Type.String() })]),
            reactions:      Type.Record(Type.String(), Type.Integer()),
            myReaction:     Type.Union([Type.String(), Type.Null()]),
            readBy:         Type.Array(Type.Object({ userId: Type.String({ format: "uuid" }), readAt: Type.String({ format: "date-time" }) })),
            deliveredAt:    Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
            createdAt:      Type.String({ format: "date-time" }),
            attachments:    Type.Array(MessageAttachmentSchema),
          }),
        },
      },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const callerId = request.userId!;
      const { conversationId } = request.params;
      const { mediaIds, replyToId } = request.body;

      await assertParticipant(fastify, callerId, conversationId);

      // Verify all media belong to the caller
      const mediaItems = await fastify.prisma.media.findMany({
        where: { id: { in: mediaIds } },
      });
      if (mediaItems.length !== mediaIds.length) {
        throw new ProblemError("not_found", "One or more media items not found.");
      }
      const forbidden = mediaItems.find((m) => m.uploaderId !== callerId);
      if (forbidden) throw new ProblemError("forbidden", "Not your media.");

      // Per-media attachment kind, derived from stored MIME. A batch that is all
      // voice becomes an AUDIO message; anything else stays IMAGE (voice notes
      // are sent on their own from the recorder, so the mixed case is moot).
      const mediaMap   = new Map(mediaItems.map((m) => [m.id, m]));
      const kindFor    = (mediaId: string) => mediaKindFromMime(mediaMap.get(mediaId)!.mimeType) ?? "image";
      const messageType: "IMAGE" | "AUDIO" = mediaIds.every((id) => kindFor(id) === "voice") ? "AUDIO" : "IMAGE";

      if (replyToId) {
        const parent = await fastify.prisma.message.findUnique({
          where: { id: replyToId },
          select: { conversationId: true },
        });
        if (!parent || parent.conversationId !== conversationId) {
          throw new ProblemError("bad_request", "replyToId is not in this conversation.");
        }
      }

      const participants = await fastify.prisma.participant.findMany({
        where: { conversationId },
        select: { userId: true },
      });
      const otherIds = participants.map((p) => p.userId).filter((uid) => uid !== callerId);
      const allRecipientsOnline =
        otherIds.length > 0 &&
        otherIds.every((uid) => (fastify.io.sockets.adapter.rooms.get(`user:${uid}`)?.size ?? 0) > 0);
      const deliveredAt = allRecipientsOnline ? new Date() : null;

      // Create message + all attachment rows in a single transaction.
      const attachmentRecords: { id: string; mediaId: string; type: string }[] = [];
      const created = await fastify.prisma.$transaction(async (tx) => {
        const msg = await tx.message.create({
          data: {
            conversationId,
            senderId: callerId,
            type: messageType,
            body: null,
            ...(replyToId ? { replyToId } : {}),
            ...(deliveredAt ? { deliveredAt } : {}),
          },
          include: {
            replyTo: { select: { id: true, body: true, type: true } },
            sender:  { select: { username: true } },
          },
        });
        for (const mediaId of mediaIds) {
          const id   = randomUUID();
          const type = kindFor(mediaId);
          await tx.messageAttachment.create({
            data: { id, messageId: msg.id, mediaId, type },
          });
          attachmentRecords.push({ id, mediaId, type });
        }
        await tx.conversation.update({
          where: { id: conversationId },
          data: { updatedAt: new Date() },
        });
        return msg;
      });

      // Transcription is NOT kicked off here — it's opt-in, triggered later by a
      // user via POST …/attachments/:id/transcribe.

      // Sign URLs for all attachments in parallel.
      const attachments = await Promise.all(
        attachmentRecords.map(({ id, mediaId, type }) =>
          serializeAttachment(id, type, mediaMap.get(mediaId)!, (key) => fastify.getMediaUrl(key)),
        ),
      );

      const httpPayload = {
        messageId:      created.id,
        conversationId: created.conversationId,
        senderId:       created.senderId,
        type:           messageType,
        body:           null,
        replyTo: created.replyTo
          ? {
              messageId: created.replyTo.id,
              preview:   created.replyTo.body ? created.replyTo.body.slice(0, 80) : null,
              type:      created.replyTo.type,
            }
          : null,
        reactions:   {} as Record<string, number>,
        myReaction:  null as string | null,
        readBy:      [] as { userId: string; readAt: string }[],
        deliveredAt: created.deliveredAt ? created.deliveredAt.toISOString() : null,
        createdAt:   created.createdAt.toISOString(),
        attachments,
      };

      const broadcastMessage = {
        ...httpPayload,
        senderUsername: created.sender.username,
        isEdited:  false,
        editedAt:  null,
        isDeleted: false,
      };

      emitMessageNew(fastify.io, conversationId, { message: broadcastMessage });
      for (const p of participants) {
        emitMessageNewToUser(fastify.io, p.userId, { message: broadcastMessage });
      }

      return reply.code(201).send(httpPayload);
    },
  );

  // ── POST /api/messages/:messageId/attachments/:attachmentId/transcribe ─────
  // On-demand voice transcription. Transcription never runs automatically; a
  // participant explicitly requests it here, which enqueues the Whisper job.
  fastify.post(
    "/messages/:messageId/attachments/:attachmentId/transcribe",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: Type.Object({
          messageId:    Type.String({ format: "uuid" }),
          attachmentId: Type.String(),
        }),
        response: {
          202: Type.Object({ status: Type.Union([Type.Literal("pending"), Type.Literal("ready")]) }),
        },
      },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const callerId = request.userId!;
      const { messageId, attachmentId } = request.params;

      const attachment = await fastify.prisma.messageAttachment.findUnique({
        where:   { id: attachmentId },
        include: { media: true, message: { select: { conversationId: true } } },
      });
      if (!attachment || attachment.messageId !== messageId) {
        throw new ProblemError("not_found", "Attachment not found.");
      }
      await assertParticipant(fastify, callerId, attachment.message.conversationId);
      if (attachment.type !== "voice") {
        throw new ProblemError("bad_request", "Attachment is not a voice note.");
      }

      // Already transcribed → nothing to do (idempotent).
      if (attachment.media.transcriptStatus === "ready" && attachment.media.transcript) {
        return reply.code(202).send({ status: "ready" });
      }

      await fastify.prisma.media.update({
        where: { id: attachment.mediaId },
        data:  { transcriptStatus: "pending" },
      });
      await voiceQueue.add(TRANSCRIBE_VOICE_JOB, {
        mediaId:        attachment.mediaId,
        attachmentId:   attachment.id,
        messageId,
        conversationId: attachment.message.conversationId,
        storageKey:     attachment.media.storageKey,
      });

      return reply.code(202).send({ status: "pending" });
    },
  );

  // ── PATCH /api/messages/:messageId (edit text) ────────────────────────────
  fastify.patch(
    "/messages/:messageId",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: Type.Object({ messageId: Type.String({ format: "uuid" }) }),
        body: Type.Object({ body: Type.String({ minLength: 1, maxLength: 4000 }) }),
        response: {
          200: Type.Object({
            messageId: Type.String({ format: "uuid" }),
            body: Type.String(),
            isEdited: Type.Literal(true),
            editedAt: Type.String({ format: "date-time" }),
          }),
        },
      },
    },
    async (request) => {
      const callerId = request.userId!;
      const msg = await fastify.prisma.message.findUnique({
        where: { id: request.params.messageId },
      });
      if (!msg) throw new ProblemError("not_found", "Message not found.");
      if (msg.senderId !== callerId) throw new ProblemError("forbidden", "Not your message.");
      if (msg.type !== "TEXT") {
        throw new ProblemError("validation_error", "Only text messages can be edited.");
      }
      if (msg.isDeleted) {
        throw new ProblemError("validation_error", "Cannot edit a deleted message.");
      }

      const editedAt = new Date();
      const updated = await fastify.prisma.message.update({
        where: { id: msg.id },
        data: { body: request.body.body, isEdited: true, editedAt },
      });

      emitMessageEdited(fastify.io, msg.conversationId, {
        messageId: updated.id,
        body: updated.body!,
        editedAt: editedAt.toISOString(),
      });

      return {
        messageId: updated.id,
        body: updated.body!,
        isEdited: true as const,
        editedAt: editedAt.toISOString(),
      };
    },
  );

  // ── POST /api/messages/:messageId/react ───────────────────────────────────
  // Instagram-style single-reaction-per-user: re-posting the SAME emoji
  // removes it (toggle), posting a different emoji replaces the prior one.
  fastify.post(
    "/messages/:messageId/react",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: Type.Object({ messageId: Type.String({ format: "uuid" }) }),
        body: Type.Object({
          emoji: Type.String({ minLength: 1, maxLength: 16 }),
        }),
        response: {
          200: Type.Object({
            messageId: Type.String({ format: "uuid" }),
            reactions: Type.Record(Type.String(), Type.Integer()),
            myReaction: Type.Union([Type.String(), Type.Null()]),
          }),
        },
      },
    },
    async (request) => {
      const callerId = request.userId!;
      const { messageId } = request.params;
      const { emoji } = request.body;

      const msg = await fastify.prisma.message.findUnique({
        where: { id: messageId },
        select: { conversationId: true, isDeleted: true },
      });
      if (!msg) throw new ProblemError("not_found", "Message not found.");
      if (msg.isDeleted) {
        throw new ProblemError("validation_error", "Cannot react to a deleted message.");
      }

      // Caller must be a participant of the conversation.
      const member = await fastify.prisma.participant.findUnique({
        where: { userId_conversationId: { userId: callerId, conversationId: msg.conversationId } },
        select: { userId: true },
      });
      if (!member) throw new ProblemError("forbidden", "You are not a participant.");

      const existing = await fastify.prisma.reaction.findUnique({
        where: { messageId_userId: { messageId, userId: callerId } },
      });

      if (existing?.emoji === emoji) {
        // Toggle off — same emoji tapped again.
        await fastify.prisma.reaction.delete({ where: { id: existing.id } });
      } else if (existing) {
        // Replace with a different emoji.
        await fastify.prisma.reaction.update({
          where: { id: existing.id },
          data: { emoji },
        });
      } else {
        await fastify.prisma.reaction.create({
          data: { messageId, userId: callerId, emoji },
        });
      }

      const [all, mine] = await Promise.all([
        fastify.prisma.reaction.groupBy({
          by: ["emoji"],
          where: { messageId },
          _count: { emoji: true },
        }),
        fastify.prisma.reaction.findUnique({
          where: { messageId_userId: { messageId, userId: callerId } },
          select: { emoji: true },
        }),
      ]);

      const reactions = Object.fromEntries(all.map((r) => [r.emoji, r._count.emoji]));
      const payload = {
        messageId,
        reactions,
        myReaction: mine?.emoji ?? null,
      };

      emitMessageReaction(fastify.io, msg.conversationId, {
        messageId: payload.messageId,
        reactions: payload.reactions,
        actorId:   callerId,
      });

      return payload;
    },
  );

  // ── DELETE /api/messages/:messageId (soft delete) ─────────────────────────
  fastify.delete(
    "/messages/:messageId",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: Type.Object({ messageId: Type.String({ format: "uuid" }) }),
      },
    },
    async (request, reply) => {
      const callerId = request.userId!;
      const msg = await fastify.prisma.message.findUnique({
        where: { id: request.params.messageId },
      });
      if (!msg) throw new ProblemError("not_found", "Message not found.");
      if (msg.senderId !== callerId) throw new ProblemError("forbidden", "Not your message.");

      await fastify.prisma.message.update({
        where: { id: msg.id },
        data: { isDeleted: true, deletedAt: new Date() },
      });

      emitMessageDeleted(fastify.io, msg.conversationId, {
        messageId:      msg.id,
        conversationId: msg.conversationId,
      });

      return reply.code(204).send();
    },
  );
};

export default messageRoutes;
