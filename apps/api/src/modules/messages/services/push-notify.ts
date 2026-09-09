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
  // Redaction is already applied to `body` by the caller (message.routes.ts)
  // before it ever reaches here — `isDisappearing` exists only to pick the
  // WORDING for that redacted case ("X sent a disappearing message" instead
  // of the generic media-type fallback). senderDisplayNames is each
  // recipient's own private nickname override for the sender (per-recipient,
  // since nicknames are per-viewer) — falls back to senderUsername per
  // recipient when absent. Both optional so every pre-existing call site
  // (non-disappearing sends) keeps compiling unchanged.
  isDisappearing?:     boolean;
  senderDisplayNames?: Map<string, string>;
  log: { info: (obj: object, msg: string) => void };
}

export function previewFor(messageType: NotifyOptions["messageType"], body: string | null): string {
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

  // Payload is built PER recipient (not once, shared) because the
  // disappearing-message placeholder embeds a nickname that's private per
  // viewer — two offline recipients can legitimately see two different
  // strings for the exact same message.
  await Promise.all(
    offlineIds.map(async (uid) => {
      const prefs = await repo.getPreferences(uid);
      if (prefs?.pushMessages === false) return;

      const preview = opts.isDisappearing
        ? `${opts.senderDisplayNames?.get(uid) ?? opts.senderUsername} sent a disappearing message`
        : previewFor(opts.messageType, opts.body);
      const payload: PushPayload = {
        v:     1,
        type:  "message",
        title: `@${opts.senderUsername}`,
        body:  preview,
        url:   `/conversations/${opts.conversationId}`,
        tag:   `conversation-${opts.conversationId}`,
      };
      await pushQueue.add(SEND_PUSH_JOB, { userId: uid, payload });
    }),
  );

  opts.log.info({ offlineIds, conversationId: opts.conversationId }, "[push] message notify enqueued");
}
