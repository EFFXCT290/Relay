"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ImagePlus, MoreHorizontal } from "lucide-react";
import imageCompression from "browser-image-compression";
import { ApiError, api } from "@/frontend-core/api";
import { getSocket, getReconnectEpoch } from "@/frontend-core/socket";
import { Avatar } from "@/shared/components/avatar";
import {
  DaySeparator,
  MessageBubble,
  TypingBubble,
  type Message,
} from "@/features/messages/components/message-bubble";
import { ChatComposer } from "@/features/messages/components/chat-composer";
import { UploadPreview } from "@/features/messages/components/upload-preview";
import { mediaApi } from "@/frontend-core/api-client/media";
import {
  saveSession,
  updateSession,
  removeSession,
  drainSessions,
} from "@/frontend-core/upload-session";
import { ImageLightbox, type LightboxState } from "@/features/messages/components/lightbox/image-lightbox";
import { ACK_EVENT, MEDIA_EVENTS, PRESENCE_EVENTS, SYNC_EVENTS, TYPING_EVENTS, type MediaReadyEvent, type MessageAttachment, type PresenceSyncResponse, type ReplayResponse, type TypingSyncResponse } from "@relay/contracts";
import { formatLastSeen } from "@/frontend-core/format-presence";

const PAGE_SIZE = 30;

const mono = "var(--font-mono)";
const display = "var(--font-display)";

// Must match server-side ALLOWED_MIME in media.service.ts
const ACCEPTED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);

function extractImageFiles(transfer: DataTransfer | ClipboardEvent["clipboardData"]): File[] {
  if (!transfer) return [];
  const files: File[] = [];
  // DataTransfer.items gives richer type info than .files for paste events
  if (transfer.items) {
    for (const item of Array.from(transfer.items)) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f && ACCEPTED_IMAGE_MIME.has(f.type)) files.push(f);
      }
    }
    return files;
  }
  // Fallback for drop events that only expose .files
  for (const f of Array.from(transfer.files)) {
    if (ACCEPTED_IMAGE_MIME.has(f.type)) files.push(f);
  }
  return files;
}

function hasDragImages(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

const MAX_CONCURRENT_UPLOADS = 3;
const UPLOAD_RETRY_DELAYS_MS = [1_000, 2_000, 5_000]; // exponential steps

// Concurrency pool — runs tasks with at most `limit` in-flight at once.
async function uploadPool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]!();
    }
  });
  await Promise.all(workers);
  return results;
}

// Per-file upload with automatic retry on network errors only.
// Server-side errors (ApiError) are not retried — bubble up for manual retry.
async function uploadWithRetry(
  file:     Blob,
  uploadId: string,
  signal:   AbortSignal,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await mediaApi.upload(file, uploadId, signal);
      return r.mediaId;
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof ApiError) throw err; // server error → manual retry
      const delay = UPLOAD_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw err;    // exhausted retries
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

type ConversationDetail = {
  conversationId: string;
  participant: {
    userId: string;
    username: string;
    isOnline?: boolean;
    lastSeenAt?: string | null;
  };
  createdAt: string;
  myAcceptedAt: string | null;
};

export default function ChatThreadPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const conversationId = params.id;

  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const [meId, setMeId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

  type PendingBatch = {
    batchId:         string;
    files:           File[];
    previews:        { localId: string; blobUrl: string }[];
    status:          "uploading" | "sending" | "error";
    clientUploadIds: string[];  // stable per-file; reused on retry for server-side dedup
  };
  const [pendingBatches, setPendingBatches] = useState<PendingBatch[]>([]);
  const batchControllersRef = useRef(new Map<string, AbortController>());
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const dragCounterRef = useRef(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  // meId resolves async from /api/auth/me. The WS effect must not re-subscribe
  // when it lands (the join/leave churn dropped events on first mount). Read it
  // through a ref so handlers always see the current value.
  const meIdRef = useRef<string | null>(null);
  useEffect(() => { meIdRef.current = meId; }, [meId]);

  // Sync barrier — buffers live message:new events that arrive while a
  // reconnect replay is in flight, then flushes them after replay completes
  // so messages are always applied oldest-first without duplicates.
  const isSyncingRef  = useRef(false);
  const syncQueueRef  = useRef<Array<{ message: Message }>>([]);
  // Cursor for replay: createdAt of the last message the client has seen.
  // Updated in applyMessageNew so it always reflects in-memory state.
  const replayCursorRef = useRef<string | null>(null);

  // Same pattern as meIdRef — detail resolves async, but WS handlers must
  // not re-subscribe when it lands (churn drops events). Read through a ref.
  const partnerIdRef = useRef<string | null>(null);
  useEffect(() => { partnerIdRef.current = detail?.participant.userId ?? null; }, [detail]);

  // Initial loads — me, detail, history — fired in parallel.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [me, det, hist] = await Promise.all([
          api<{ userId: string }>("/api/auth/me"),
          api<ConversationDetail>(`/api/conversations/${conversationId}`),
          api<{ messages: Message[]; nextCursor: string | null }>(
            `/api/conversations/${conversationId}/messages?limit=${PAGE_SIZE}`,
          ),
        ]);
        if (cancelled) return;
        setMeId(me.userId);
        setDetail(det);
        // API returns newest-first; reverse so DOM order is oldest-first.
        const ordered = [...hist.messages].reverse();
        setMessages(ordered);
        setNextCursor(hist.nextCursor);
        // Seed the replay cursor so reconnect knows where to resume from.
        const lastMsg = ordered[ordered.length - 1];
        if (lastMsg) replayCursorRef.current = lastMsg.createdAt;

        // Mark whatever's unread now as read — fire-and-forget. The server
        // will broadcast message:read to the original sender.
        void api(`/api/conversations/${conversationId}/read`, { method: "POST" }).catch(() => {});
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) {
          router.replace("/conversations");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load conversation");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, router]);

  // Session recovery — fires once on mount. If the page was refreshed while
  // a batch was in the "sending" state (uploads done, POST not sent), auto-
  // resume by sending the message now. Orphaned "uploading" sessions (files
  // gone) are drained and discarded without showing UI.
  useEffect(() => {
    const { resumable } = drainSessions(conversationId);
    for (const session of resumable) {
      void api(`/api/conversations/${conversationId}/messages/media`, {
        method: "POST",
        body:   { mediaIds: session.mediaIds },
      }).catch(() => {
        // If recovery POST fails, the session was already removed from storage.
        // The user will need to re-upload — silent failure is acceptable here.
      });
    }
  }, [conversationId]);

  // Once the conversation detail resolves we know the partner's userId and can
  // request their current presence state. joinAndSync (called on socket connect)
  // skips this on initial mount because partnerIdRef isn't set yet.
  useEffect(() => {
    const partnerId = detail?.participant.userId;
    if (!partnerId) return;
    getSocket().emit(PRESENCE_EVENTS.SYNC_REQUEST, { userIds: [partnerId] });
  }, [detail?.participant.userId]);

  // WebSocket subscription — join the conversation room and react to events.
  useEffect(() => {
    const socket = getSocket();

    const joinAndSync = () => {
      socket.emit("conversation:join", { conversationId });
      socket.emit(TYPING_EVENTS.SYNC_REQUEST, { conversationIds: [conversationId] });
      // Presence sync on reconnect — partnerIdRef is populated by then.
      // Initial load is handled by a separate effect once detail resolves.
      const partnerId = partnerIdRef.current;
      if (partnerId) socket.emit(PRESENCE_EVENTS.SYNC_REQUEST, { userIds: [partnerId] });
    };

    // Applies a message:new payload to local state. Used by both the live
    // handler and the replay handler so dedup + auto-read logic is shared.
    const applyMessageNew = (payload: { message: Message }) => {
      if (payload.message.conversationId !== conversationId) return;
      setMessages((prev) => {
        if (!prev) return prev;
        if (prev.some((m) => m.messageId === payload.message.messageId)) return prev;
        const next = [
          ...prev,
          {
            ...payload.message,
            reactions:  payload.message.reactions  ?? {},
            myReaction: payload.message.myReaction ?? null,
            readBy:     payload.message.readBy     ?? [],
          },
        ];
        // Advance replay cursor as we apply messages.
        replayCursorRef.current = payload.message.createdAt;
        return next;
      });
      if (
        payload.message.senderId !== meIdRef.current &&
        typeof document !== "undefined" &&
        document.visibilityState === "visible"
      ) {
        void api(`/api/conversations/${conversationId}/read`, { method: "POST" }).catch(() => {});
      }
    };

    // Initial join (or rejoin if already connected mid-handshake).
    joinAndSync();

    // Active replay handler — one per reconnect. Replaced (not accumulated) on
    // each reconnect so epoch validation is always tied to the right closure.
    let currentReplayHandler: ((res: ReplayResponse) => void) | null = null;

    // Reconnect: Socket.IO clears server-side rooms on disconnect. Rejoin,
    // clear stale typing, open the sync barrier, then request replay so any
    // messages that arrived during the disconnect are replayed in order.
    //
    // Per-reconnect handler pattern: each reconnect creates a fresh closure
    // that captures the epoch at that exact moment. If another reconnect fires
    // before the response arrives, the old handler is deregistered and any
    // response that still sneaks through is discarded by the epoch check.
    const onReconnect = () => {
      setPartnerTyping(false);
      isSyncingRef.current = true;
      syncQueueRef.current  = [];

      // Deregister previous handler so stale responses can't apply.
      if (currentReplayHandler) {
        socket.off(SYNC_EVENTS.REPLAY_RESPONSE, currentReplayHandler);
        currentReplayHandler = null;
      }

      const epoch  = getReconnectEpoch();
      joinAndSync();

      const cursor = replayCursorRef.current;
      if (!cursor) {
        // No cursor yet (page still loading) — skip replay, just un-block.
        isSyncingRef.current = false;
        return;
      }

      socket.emit(SYNC_EVENTS.REPLAY_REQUEST, { since: cursor, conversationId });

      // Relay response — apply missed events oldest-first, then flush any
      // live events that buffered while the barrier was up.
      const handleReplay = (res: ReplayResponse) => {
        // Stale check: a newer reconnect fired while this response was in
        // flight. The new reconnect's handler will take over.
        if (epoch !== getReconnectEpoch()) {
          isSyncingRef.current = false;
          syncQueueRef.current  = [];
          return;
        }
        for (const env of res.events) {
          if (env.eventName === "message:new") {
            applyMessageNew(env.payload as { message: Message });
          }
          // ACK each replayed envelope so it's marked delivered and won't
          // appear in future replay responses.
          socket.emit(ACK_EVENT, { eventId: env.eventId, status: "ok" });
        }
        // If nextCursor is null the server has fully caught us up — close the
        // barrier and flush any live events that queued during the sync window.
        if (!res.nextCursor) {
          socket.off(SYNC_EVENTS.REPLAY_RESPONSE, handleReplay);
          currentReplayHandler  = null;
          isSyncingRef.current  = false;
          const queued = syncQueueRef.current.splice(0);
          for (const p of queued) applyMessageNew(p);
        }
      };

      currentReplayHandler = handleReplay;
      socket.on(SYNC_EVENTS.REPLAY_RESPONSE, handleReplay);
    };
    socket.on("connect", onReconnect);

    // Live message:new — buffer during replay barrier, apply immediately otherwise.
    const onMessageNew = (payload: { message: Message }) => {
      if (isSyncingRef.current) {
        syncQueueRef.current.push(payload);
        return;
      }
      applyMessageNew(payload);
    };

    const onMessageRead = (payload: {
      conversationId: string;
      readBy: string;
      messageIds: string[];
      readAt: string;
      deliveredAt?: string | null;
    }) => {
      if (payload.conversationId !== conversationId) return;
      const ids = new Set(payload.messageIds);
      setMessages(
        (prev) =>
          prev?.map((m) => {
            if (!ids.has(m.messageId)) return m;
            const alreadyRead = m.readBy.some((r) => r.userId === payload.readBy);
            return {
              ...m,
              readBy: alreadyRead
                ? m.readBy
                : [...m.readBy, { userId: payload.readBy, readAt: payload.readAt }],
              // Read implies delivered. Backfill in case the receiver came
              // online and went straight to reading without a separate
              // delivered event landing first.
              deliveredAt: m.deliveredAt ?? payload.deliveredAt ?? payload.readAt,
            };
          }) ?? null,
      );
    };

    const onMessageDelivered = (payload: {
      conversationId: string;
      messageIds: string[];
      deliveredAt: string;
    }) => {
      if (payload.conversationId !== conversationId) return;
      const ids = new Set(payload.messageIds);
      setMessages(
        (prev) =>
          prev?.map((m) =>
            ids.has(m.messageId) && !m.deliveredAt
              ? { ...m, deliveredAt: payload.deliveredAt }
              : m,
          ) ?? null,
      );
    };

    const onMessageEdited = (payload: {
      messageId: string;
      body: string;
      editedAt: string;
    }) => {
      setMessages(
        (prev) =>
          prev?.map((m) =>
            m.messageId === payload.messageId
              ? { ...m, body: payload.body, isEdited: true, editedAt: payload.editedAt }
              : m,
          ) ?? null,
      );
    };

    const onMessageDeleted = (payload: { messageId: string }) => {
      setMessages(
        (prev) =>
          prev?.map((m) =>
            m.messageId === payload.messageId
              ? { ...m, isDeleted: true, body: null }
              : m,
          ) ?? null,
      );
    };

    const onMessageReaction = (payload: {
      messageId: string;
      reactions: Record<string, number>;
      actorId: string;
    }) => {
      // The actor already applied the server response inside handleReact —
      // the WS echo would clobber `myReaction` because the payload can't
      // distinguish the actor's selection from anyone else's totals. Skip it.
      if (payload.actorId === meIdRef.current) return;
      setMessages(
        (prev) =>
          prev?.map((m) => {
            if (m.messageId !== payload.messageId) return m;
            // For other users' reactions my own selection is unchanged —
            // preserve it if it still appears in the totals, drop it if gone.
            const stillMine =
              m.myReaction && payload.reactions[m.myReaction] ? m.myReaction : null;
            return { ...m, reactions: payload.reactions, myReaction: stillMine };
          }) ?? null,
      );
    };

    const onTypingUpdate = (payload: {
      conversationId: string;
      userId:         string;
      isTyping:       boolean;
    }) => {
      if (payload.conversationId !== conversationId) return;
      if (payload.userId === meIdRef.current) return;
      setPartnerTyping(payload.isTyping);
    };

    const onTypingSyncResponse = (res: TypingSyncResponse) => {
      const typers = res.active[conversationId] ?? [];
      const partnerId = partnerIdRef.current;
      setPartnerTyping(!!partnerId && typers.includes(partnerId));
    };

    const onPresenceSyncResponse = (res: PresenceSyncResponse) => {
      const partnerId = partnerIdRef.current;
      if (!partnerId) return;
      const entry = res.users.find((u) => u.userId === partnerId);
      if (!entry) return;
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              participant: {
                ...prev.participant,
                isOnline:   entry.isOnline,
                lastSeenAt: entry.lastSeen ?? prev.participant.lastSeenAt,
              },
            }
          : prev,
      );
    };

    const onPresenceOnline = (payload: { userId: string }) => {
      if (payload.userId !== partnerIdRef.current) return;
      setDetail((prev) =>
        prev ? { ...prev, participant: { ...prev.participant, isOnline: true } } : prev,
      );
    };

    const onPresenceOffline = (payload: { userId: string; lastSeen: string }) => {
      if (payload.userId !== partnerIdRef.current) return;
      setDetail((prev) =>
        prev
          ? { ...prev, participant: { ...prev.participant, isOnline: false, lastSeenAt: payload.lastSeen } }
          : prev,
      );
    };

    const onMessageEmbedUpdate = (payload: {
      messageId: string;
      embed: Message["embed"];
    }) => {
      setMessages(
        (prev) =>
          prev?.map((m) =>
            m.messageId === payload.messageId ? { ...m, embed: payload.embed } : m,
          ) ?? null,
      );
    };

    const onMediaReady = (payload: MediaReadyEvent) => {
      setMessages((prev) =>
        prev?.map((m) => {
          if (!m.attachments?.some((a) => a.media.id === payload.mediaId)) return m;
          return {
            ...m,
            attachments: m.attachments.map((a) =>
              a.media.id !== payload.mediaId
                ? a
                : {
                    ...a,
                    media: {
                      ...a.media,
                      blurUrl:    payload.blurUrl,
                      thumbUrl:   payload.thumbUrl,
                      blurWidth:  payload.blurWidth,
                      blurHeight: payload.blurHeight,
                      thumbWidth:  payload.thumbWidth,
                      thumbHeight: payload.thumbHeight,
                    },
                  },
            ),
          };
        }) ?? null,
      );
    };

    socket.on("message:new", onMessageNew);
    socket.on("message:edited", onMessageEdited);
    socket.on("message:deleted", onMessageDeleted);
    socket.on("message:reaction", onMessageReaction);
    socket.on("message:read", onMessageRead);
    socket.on("message:delivered", onMessageDelivered);
    socket.on("message:embed:update", onMessageEmbedUpdate);
    socket.on("typing:update", onTypingUpdate);
    socket.on(TYPING_EVENTS.SYNC_RESPONSE, onTypingSyncResponse);
    socket.on(PRESENCE_EVENTS.SYNC_RESPONSE, onPresenceSyncResponse);
    socket.on("presence:online", onPresenceOnline);
    socket.on("presence:offline", onPresenceOffline);
    socket.on(MEDIA_EVENTS.READY, onMediaReady);

    return () => {
      // Leave the room and clear the barrier — prevents stale state from
      // leaking into the next conversation or mount cycle.
      isSyncingRef.current = false;
      syncQueueRef.current  = [];
      socket.off("connect", onReconnect);
      socket.emit("conversation:leave", { conversationId });
      if (currentReplayHandler) {
        socket.off(SYNC_EVENTS.REPLAY_RESPONSE, currentReplayHandler);
        currentReplayHandler = null;
      }
      socket.off("message:new", onMessageNew);
      socket.off("message:edited", onMessageEdited);
      socket.off("message:deleted", onMessageDeleted);
      socket.off("message:reaction", onMessageReaction);
      socket.off("message:read", onMessageRead);
      socket.off("message:delivered", onMessageDelivered);
      socket.off("message:embed:update", onMessageEmbedUpdate);
      socket.off("typing:update", onTypingUpdate);
      socket.off(TYPING_EVENTS.SYNC_RESPONSE, onTypingSyncResponse);
      socket.off(PRESENCE_EVENTS.SYNC_RESPONSE, onPresenceSyncResponse);
      socket.off("presence:online", onPresenceOnline);
      socket.off("presence:offline", onPresenceOffline);
      socket.off(MEDIA_EVENTS.READY, onMediaReady);
    };
  }, [conversationId]);

  // Mark-read also fires whenever the tab becomes visible again. Without this,
  // a message that arrives in a backgrounded tab never gets marked read —
  // sender stays stuck on ✓✓ delivered, never sees blue.
  useEffect(() => {
    const onVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState !== "visible") return;
      void api(`/api/conversations/${conversationId}/read`, { method: "POST" }).catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [conversationId]);

  // Auto-scroll to the bottom on initial load + on new bottom-side messages.
  // We only stick to bottom when the user was already there (within 120px),
  // so reading older messages mid-scroll isn't yanked away.
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distFromBottom < 120;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);


  // Infinite scroll up — when scrolled near the top, fetch one more page.
  // Anchor preservation: capture scrollHeight before prepend, then shift
  // scrollTop by the delta so the user's viewport doesn't jump.
  const loadOlder = useCallback(async () => {
    if (!nextCursor || loadingOlder || !scrollRef.current) return;
    setLoadingOlder(true);
    const beforeHeight = scrollRef.current.scrollHeight;
    try {
      const res = await api<{ messages: Message[]; nextCursor: string | null }>(
        `/api/conversations/${conversationId}/messages?limit=${PAGE_SIZE}&cursor=${nextCursor}`,
      );
      setMessages((prev) => (prev ? [...[...res.messages].reverse(), ...prev] : prev));
      setNextCursor(res.nextCursor);
      // Restore viewport after DOM has the new nodes.
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (!el) return;
        const delta = el.scrollHeight - beforeHeight;
        el.scrollTop += delta;
      });
    } finally {
      setLoadingOlder(false);
    }
  }, [conversationId, nextCursor, loadingOlder]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop < 80) void loadOlder();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [loadOlder]);

  const handleSend = useCallback(
    async (body: string, replyToId?: string | null) => {
      const tempId          = crypto.randomUUID();
      const clientMessageId = crypto.randomUUID();

      // Optimistic: show the message instantly so there's no gap between
      // Enter and the message appearing. Swapped out for the real row once
      // the server responds.
      const optimistic: Message = {
        messageId:      tempId,
        conversationId,
        senderId:       meId ?? "",
        senderUsername: "you",  // replaced on swap
        type:           "TEXT",
        body,
        replyTo: replyTo
          ? { messageId: replyTo.messageId, preview: replyTo.body?.slice(0, 80) ?? null, type: replyTo.type }
          : null,
        isEdited:   false,
        editedAt:   null,
        isDeleted:  false,
        reactions:  {},
        myReaction: null,
        readBy:     [],
        deliveredAt: null,
        createdAt:  new Date().toISOString(),
      };
      stickToBottomRef.current = true;
      setMessages((prev) => (prev ? [...prev, optimistic] : prev));
      setReplyTo(null);

      try {
        const sent = await api<Message>(
          `/api/conversations/${conversationId}/messages`,
          { method: "POST", body: { body, ...(replyToId ? { replyToId } : {}), clientMessageId } },
        );
        // Swap optimistic placeholder → real message.
        // If the socket delivered the real message first (rare but possible),
        // the real row is already in state — just remove the placeholder.
        setMessages((prev) => {
          if (!prev) return prev;
          const alreadyReal = prev.some((m) => m.messageId === sent.messageId);
          if (alreadyReal) return prev.filter((m) => m.messageId !== tempId);
          return prev.map((m) =>
            m.messageId === tempId
              ? { ...sent, reactions: sent.reactions ?? {}, myReaction: sent.myReaction ?? null }
              : m,
          );
        });
      } catch (err) {
        // Remove the optimistic placeholder on failure so the user isn't
        // left staring at a message that was never sent.
        setMessages((prev) => prev?.filter((m) => m.messageId !== tempId) ?? null);
        setError(err instanceof Error ? err.message : "Failed to send");
      }
    },
    [conversationId, meId, replyTo],
  );

  const handleUpdate = useCallback(async (messageId: string, body: string) => {
    try {
      await api(`/api/messages/${messageId}`, { method: "PATCH", body: { body } });
      // Local optimistic update; the WS event will also confirm.
      setMessages(
        (prev) =>
          prev?.map((m) =>
            m.messageId === messageId
              ? { ...m, body, isEdited: true, editedAt: new Date().toISOString() }
              : m,
          ) ?? null,
      );
      setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to edit");
    }
  }, []);

  const handleReact = useCallback(async (messageId: string, emoji: string) => {
    try {
      // Server response carries the authoritative {reactions, myReaction} for
      // the caller — apply directly so the bubble updates instantly. We skip
      // the WS echo for the actor inside onMessageReaction so this isn't
      // clobbered by a payload that can't tell the actor's emoji from totals.
      const res = await api<{
        messageId: string;
        reactions: Record<string, number>;
        myReaction: string | null;
      }>(`/api/messages/${messageId}/react`, {
        method: "POST",
        body: { emoji },
      });
      setMessages(
        (prev) =>
          prev?.map((m) =>
            m.messageId === res.messageId
              ? { ...m, reactions: res.reactions, myReaction: res.myReaction }
              : m,
          ) ?? null,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to react");
    }
  }, []);

  const handleDelete = useCallback(async (msg: Message) => {
    if (!window.confirm("Delete this message? It can't be undone after 7 days.")) return;
    try {
      await api(`/api/messages/${msg.messageId}`, { method: "DELETE" });
      // Server emits message:deleted which updates state for us.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
  }, []);

  const handleTypingChange = useCallback(
    (isTyping: boolean) => {
      const socket = getSocket();
      socket.emit(isTyping ? "typing:start" : "typing:stop", { conversationId });
    },
    [conversationId],
  );

  const handleSendImages = useCallback(
    async (files: File[], existingUploadIds?: string[]) => {
      if (!files.length) return;
      const batchId         = crypto.randomUUID();
      const clientUploadIds = existingUploadIds ?? files.map(() => crypto.randomUUID());
      const previews        = files.map((f) => ({ localId: crypto.randomUUID(), blobUrl: URL.createObjectURL(f) }));
      const controller      = new AbortController();
      batchControllersRef.current.set(batchId, controller);

      setPendingBatches((prev) => [
        ...prev,
        { batchId, files, previews, status: "uploading", clientUploadIds },
      ]);
      stickToBottomRef.current = true;

      // Persist session before touching the network — survives refresh.
      saveSession({
        sessionId:       batchId,
        conversationId,
        fileCount:       files.length,
        clientUploadIds,
        mediaIds:        [],
        status:          "uploading",
        createdAt:       Date.now(),
      });

      let succeeded = false;
      let aborted   = false;
      try {
        const compressed = await Promise.all(
          files.map((f) =>
            imageCompression(f, { maxSizeMB: 1, maxWidthOrHeight: 1920, useWebWorker: true, initialQuality: 0.84 }),
          ),
        );
        if (controller.signal.aborted) { aborted = true; return; }

        // Upload with concurrency limit + per-file auto-retry on network errors.
        const uploadTasks = compressed.map((f, i) => () =>
          uploadWithRetry(f, clientUploadIds[i]!, controller.signal),
        );
        const mediaIds = await uploadPool(uploadTasks, MAX_CONCURRENT_UPLOADS);

        updateSession(batchId, { mediaIds, status: "sending" });
        setPendingBatches((prev) =>
          prev.map((b) => (b.batchId === batchId ? { ...b, status: "sending" } : b)),
        );

        await api(`/api/conversations/${conversationId}/messages/media`, {
          method: "POST",
          body:   { mediaIds },
        });

        removeSession(batchId);
        // The message:new socket event adds the real message; remove the optimistic batch.
        setPendingBatches((prev) => prev.filter((b) => b.batchId !== batchId));
        succeeded = true;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          aborted = true;
          removeSession(batchId);
          setPendingBatches((prev) => prev.filter((b) => b.batchId !== batchId));
        } else {
          setPendingBatches((prev) =>
            prev.map((b) => (b.batchId === batchId ? { ...b, status: "error" } : b)),
          );
        }
      } finally {
        batchControllersRef.current.delete(batchId);
        if (succeeded || aborted) previews.forEach((p) => URL.revokeObjectURL(p.blobUrl));
      }
    },
    [conversationId],
  );

  const handleCancelBatch = useCallback((batchId: string) => {
    batchControllersRef.current.get(batchId)?.abort();
    setPendingBatches((prev) => {
      const batch = prev.find((b) => b.batchId === batchId);
      if (batch) batch.previews.forEach((p) => URL.revokeObjectURL(p.blobUrl));
      return prev.filter((b) => b.batchId !== batchId);
    });
  }, []);

  const handleRetryBatch = useCallback(
    (batchId: string) => {
      const batch = pendingBatches.find((b) => b.batchId === batchId);
      if (!batch || batch.status !== "error") return;
      const { files, clientUploadIds } = batch;
      setPendingBatches((prev) => {
        const b = prev.find((x) => x.batchId === batchId);
        if (b) b.previews.forEach((p) => URL.revokeObjectURL(p.blobUrl));
        return prev.filter((b) => b.batchId !== batchId);
      });
      // Reuse the same clientUploadIds so the server deduplicates already-uploaded files.
      void handleSendImages(files, clientUploadIds);
    },
    [pendingBatches, handleSendImages],
  );

  // Paste — intercept only when clipboard contains images (screenshots, copied images).
  // Text paste falls through to the textarea normally.
  useEffect(() => {
    const canSend = () => detail?.myAcceptedAt !== null;
    const onPaste = (e: ClipboardEvent) => {
      if (!canSend() || !e.clipboardData) return;
      const files = extractImageFiles(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      void handleSendImages(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [detail, handleSendImages]);

  // Drag handlers — counter pattern eliminates false dragleave fires from child elements.
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!hasDragImages(e)) return;
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) setDragActive(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setDragActive(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragActive(false);
    if (!detail?.myAcceptedAt) return;
    const files = extractImageFiles(e.dataTransfer);
    if (files.length) void handleSendImages(files);
  }, [detail, handleSendImages]);

  type VirtualRow =
    | { kind: "loader" }
    | { kind: "separator"; label: string }
    | { kind: "message"; message: Message }
    | { kind: "pending"; batch: PendingBatch }
    | { kind: "typing" };

  const flatRows = useMemo((): VirtualRow[] => {
    if (!messages) return [];
    const rows: VirtualRow[] = [];
    if (loadingOlder) rows.push({ kind: "loader" });
    let lastLabel = "";
    for (const m of messages) {
      const label = dayLabel(m.createdAt);
      if (label !== lastLabel) { rows.push({ kind: "separator", label }); lastLabel = label; }
      rows.push({ kind: "message", message: m });
    }
    for (const batch of pendingBatches) rows.push({ kind: "pending", batch });
    if (partnerTyping) rows.push({ kind: "typing" });
    return rows;
  }, [messages, loadingOlder, pendingBatches, partnerTyping]);

  const virtualizer = useVirtualizer({
    count:           flatRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize:    (i) => {
      const row = flatRows[i];
      if (!row) return 68;
      switch (row.kind) {
        case "loader":    return 48;
        case "separator": return 48;
        case "typing":    return 68;
        case "pending": {
          const n = row.batch.previews.length;
          return n === 1 ? 188 : n <= 3 ? 220 : 160;
        }
        case "message": {
          const msg = row.message;
          if (msg.isDeleted) return 60;
          if (msg.attachments?.length) {
            const n = msg.attachments.length;
            return n === 1 ? 280 : n <= 3 ? 220 : 160;
          }
          if (msg.embed) return 168;
          const len = msg.body?.length ?? 0;
          return Math.min(76 + Math.ceil(len / 40) * 22, 320);
        }
      }
    },
    overscan:     5,
    paddingStart: 16,
    paddingEnd:   16,
  });

  // Stick to bottom on new rows.
  useEffect(() => {
    if (stickToBottomRef.current && flatRows.length > 0) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [flatRows.length]);

  return (
    <div
      className="relative flex h-dvh flex-col lg:h-[100dvh]"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drop overlay */}
      {dragActive && (
        <div
          className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center gap-3"
          style={{
            background: "color-mix(in srgb, var(--color-signal) 8%, transparent)",
            border: "2px dashed var(--color-signal)",
            borderRadius: 0,
          }}
        >
          <ImagePlus className="h-10 w-10" style={{ color: "var(--color-signal)" }} />
          <span
            className="text-[13px] font-semibold tracking-[0.04em]"
            style={{ color: "var(--color-signal)", fontFamily: mono }}
          >
            Drop images to send
          </span>
        </div>
      )}

      {/* Header */}
      <header
        className="flex items-center gap-3 border-b bg-[var(--color-bg)]/92 px-4 py-2 backdrop-blur-xl"
        style={{ borderColor: "var(--color-hairline)" }}
      >
        <Link
          href="/conversations"
          aria-label="Back"
          className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/5"
        >
          <ArrowLeft className="h-5 w-5 text-[var(--color-text)]" />
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          {detail ? (
            <>
              <Avatar
                username={detail.participant.username}
                size={36}
                isOnline={detail.participant.isOnline}
              />
              <div className="flex min-w-0 flex-col">
                <span
                  className="truncate text-[16px] font-bold tracking-[-0.01em] text-[var(--color-text)]"
                  style={{ fontFamily: display }}
                >
                  @{detail.participant.username}
                </span>
                <span
                  className="text-[10px] tracking-[0.04em]"
                  style={{
                    color: detail.participant.isOnline
                      ? "var(--color-online)"
                      : "var(--color-text-muted)",
                    fontFamily: mono,
                  }}
                >
                  {formatLastSeen(detail.participant.lastSeenAt, detail.participant.isOnline)}
                </span>
              </div>
            </>
          ) : (
            <div className="h-9 w-32 animate-pulse rounded bg-white/5" />
          )}
        </div>
        <button
          type="button"
          aria-label="More"
          className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/5"
        >
          <MoreHorizontal className="h-5 w-5 text-[var(--color-text)]" />
        </button>
      </header>

      {/* Message scroll — virtualized */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto" style={{ touchAction: "pan-y" }}>
        {messages === null ? (
          <div className="flex items-center justify-center py-12">
            <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]" style={{ fontFamily: mono }}>
              loading
            </span>
          </div>
        ) : messages.length === 0 && !pendingBatches.length && !partnerTyping ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]" style={{ fontFamily: mono }}>
              empty thread
            </span>
            <p className="max-w-[260px] text-sm text-[var(--color-text-secondary)]">
              Say hi to <span className="text-[var(--color-text)]">@{detail?.participant.username}</span>. Messages stay between the two of you.
            </p>
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const row = flatRows[vi.index];
              if (!row) return null;
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{ position: "absolute", top: vi.start, left: 0, width: "100%" }}
                  className="px-4 pt-2 lg:px-8 xl:px-12"
                >
                  {row.kind === "loader" && (
                    <div className="flex items-center justify-center py-3">
                      <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]" style={{ fontFamily: mono }}>
                        loading older
                      </span>
                    </div>
                  )}
                  {row.kind === "separator" && <DaySeparator date={row.label} />}
                  {row.kind === "message" && (() => {
                    const m = row.message;
                    const isMine = m.senderId === meId;
                    const partnerRead = isMine && detail
                      ? m.readBy.find((r) => r.userId === detail.participant.userId)
                      : undefined;
                    return (
                      <div className={isMine ? "flex justify-end" : "flex justify-start"}>
                        <MessageBubble
                          message={m}
                          isMine={isMine}
                          showReadReceipt={isMine}
                          readAt={partnerRead?.readAt ?? null}
                          deliveredAt={isMine ? m.deliveredAt : null}
                          onReact={handleReact}
                          onReply={(msg) => { setEditing(null); setReplyTo(msg); }}
                          onEdit={(msg) => { setReplyTo(null); setEditing(msg); }}
                          onDelete={handleDelete}
                          onOpenLightbox={(atts: MessageAttachment[], idx: number) =>
                            setLightbox({ images: atts, index: idx })
                          }
                        />
                      </div>
                    );
                  })()}
                  {row.kind === "pending" && (
                    <div className="flex justify-end">
                      <UploadPreview
                        previews={row.batch.previews}
                        status={row.batch.status}
                        onCancel={() => handleCancelBatch(row.batch.batchId)}
                        onRetry={() => handleRetryBatch(row.batch.batchId)}
                      />
                    </div>
                  )}
                  {row.kind === "typing" && (
                    <div className="flex justify-start">
                      <TypingBubble username={detail?.participant.username} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {error && (
        <div
          className="border-t px-4 py-2 text-xs text-[var(--color-alert)]"
          style={{ borderColor: "var(--color-hairline)" }}
        >
          {error}
        </div>
      )}

      {detail && detail.myAcceptedAt === null ? (
        <AcceptCard
          username={detail.participant.username}
          onAccept={async () => {
            try {
              await api(`/api/conversations/${conversationId}/accept`, { method: "POST" });
              setDetail((prev) =>
                prev ? { ...prev, myAcceptedAt: new Date().toISOString() } : prev,
              );
            } catch (err) {
              setError(err instanceof Error ? err.message : "Accept failed");
            }
          }}
          onDelete={async () => {
            try {
              await api(`/api/conversations/${conversationId}`, { method: "DELETE" });
              router.replace("/conversations");
            } catch (err) {
              setError(err instanceof Error ? err.message : "Delete failed");
            }
          }}
        />
      ) : (
        <ChatComposer
          onSend={handleSend}
          onUpdate={handleUpdate}
          onTypingChange={handleTypingChange}
          onSendImages={handleSendImages}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          editing={editing}
          onCancelEdit={() => setEditing(null)}
        />
      )}

      {lightbox && (
        <ImageLightbox
          state={lightbox}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

function AcceptCard({
  username,
  onAccept,
  onDelete,
}: {
  username: string;
  onAccept: () => Promise<void> | void;
  onDelete: () => Promise<void> | void;
}) {
  return (
    <div
      className="flex flex-col gap-3 border-t bg-[var(--color-bg)]/92 px-4 py-4 backdrop-blur-xl"
      style={{ borderColor: "var(--color-hairline)" }}
    >
      <div className="flex flex-col gap-1">
        <span
          className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-text-muted)]"
          style={{ fontFamily: mono }}
        >
          Message request
        </span>
        <p className="text-[13px] text-[var(--color-text-secondary)]">
          <span className="text-[var(--color-text)]">@{username}</span> wants to message you. Accept to reply, or delete the request.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void onAccept()}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-semibold text-white"
          style={{ background: "var(--color-signal)" }}
        >
          Accept
        </button>
        <button
          type="button"
          onClick={() => void onDelete()}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-full border px-3.5 py-2 text-[13px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          style={{ borderColor: "var(--color-hairline-strong)" }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `Today · ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })}`;
  const y = new Date(now.getTime() - 86_400_000);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

