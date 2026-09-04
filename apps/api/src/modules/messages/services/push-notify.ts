import type { FastifyInstance } from "fastify";
import { pushQueue, SEND_PUSH_JOB } from "../../../queues/push.queue.js";
import { PushRepository } from "../../push/push.repository.js";
import type { PushPayload } from "../../push/push.service.js";

interface NotifyOptions {
  senderUsername: string;
  body:           string | null;
  messageType:    "TEXT" | "IMAGE" | "VIDEO" | "AUDIO";
  conversationId: string;
  recipientIds:   string[];
  onlineIds:      string[];
  log:            { info: (obj: object, msg: string) => void };
}

function previewFor(messageType: NotifyOptions["messageType"], body: string | null): string {
  if (messageType === "TEXT" && body) {
    return body.length > 120 ? body.slice(0, 120) + "…" : body;
  }
  return messageType === "IMAGE" ? "📷 Image"
    : messageType === "VIDEO"  ? "🎥 Video"
    : messageType === "AUDIO"  ? "🎙️ Voice note"
    : "(message)";
}

// Push counterpart to maybeNotifyDiscord — same "skip if online" shape, but
// fans out per offline recipient (Discord has one hardcoded alert user; push
// has one subscription set per real recipient).
export async function maybeNotifyPush(fastify: FastifyInstance, opts: NotifyOptions): Promise<void> {
  const offlineIds = opts.recipientIds.filter((uid) => !opts.onlineIds.includes(uid));
  if (offlineIds.length === 0) return;

  const repo = new PushRepository(fastify.prisma);
  const preview = previewFor(opts.messageType, opts.body);
  const payload: PushPayload = {
    v:     1,
    type:  "message",
    title: `@${opts.senderUsername}`,
    body:  preview,
    url:   `/conversations/${opts.conversationId}`,
    tag:   `conversation-${opts.conversationId}`,
  };

  await Promise.all(
    offlineIds.map(async (uid) => {
      const prefs = await repo.getPreferences(uid);
      if (prefs?.pushMessages === false) return;
      await pushQueue.add(SEND_PUSH_JOB, { userId: uid, payload });
    }),
  );

  opts.log.info({ offlineIds, conversationId: opts.conversationId }, "[push] message notify enqueued");
}
