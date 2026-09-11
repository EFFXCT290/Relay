"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ChevronDown, ImagePlus, MoreHorizontal, Phone, Search, Video } from "lucide-react";
import imageCompression from "browser-image-compression";
import { ApiError, api } from "@/frontend-core/api";
import { getSocket, getReconnectEpoch } from "@/frontend-core/socket";
import { Avatar } from "@/shared/components/avatar";
import { Skeleton, SkeletonCircle, SkeletonLine } from "@/shared/ui/skeleton";
import {
  DaySeparator,
  MessageBubble,
  TypingBubble,
  type Message,
} from "@/features/messages/components/message-bubble";
import { ChatComposer, MAX_IMAGES_PER_SEND } from "@/features/messages/components/chat-composer";
import { UploadPreview } from "@/features/messages/components/upload-preview";
import { PinnedBanner } from "@/features/messages/components/pinned-banner";
import { PinnedMessagesList } from "@/features/messages/components/pinned-messages-list";
import { MessageSearchBar } from "@/features/messages/components/message-search-bar";
import { mediaApi } from "@/frontend-core/api-client/media";
import { syncApi } from "@/frontend-core/api-client/sync";
import {
  saveSession,
  updateSession,
  removeSession,
  drainSessions,
} from "@/frontend-core/upload-session";
import { ImageLightbox, type LightboxState } from "@/features/messages/components/lightbox/image-lightbox";
import { EphemeralViewer } from "@/features/messages/components/ephemeral-viewer";
import { DisappearModal } from "@/features/messages/components/disappear-modal";
import { useTypingBackstop } from "@/features/messages/hooks/use-typing-backstop";
import { ACK_EVENT, MEDIA_EVENTS, VOICE_EVENTS, PRESENCE_EVENTS, SYNC_EVENTS, TYPING_EVENTS, TYPING_TIMEOUT_MS, TYPING_SWEEP_INTERVAL_MS, USER_EVENTS, USER_NICKNAME_EVENTS, MESSAGE_EVENTS, type MediaReadyEvent, type MediaProcessedEvent, type MediaViewedEvent, type VoiceTranscriptReadyEvent, type ImageAttachment, type VideoAttachment, type MediaViewResponse, type DeliveryMode, type EphemeralSend, type DisappearSend, type MessageOpenResponse, type MessageDisappearProgressEvent, type MessageDisappearStartedEvent, type PinnedMessage, type PresenceSyncResponse, type ReplayResponse, type TypingSyncResponse, type UserProfileUpdatedEvent, type UserNicknameSharedUpdatedEvent } from "@relay/contracts";
import { formatLastSeen } from "@/frontend-core/format-presence";
import { SpotifyBadge } from "@/features/spotify/spotify-badge";
import { ContactInfoModal } from "@/features/conversations/components/contact-info-modal";
import { SharedMediaGrid } from "@/features/conversations/components/shared-media-grid";
import { useCall } from "@/features/calls/call-provider";
import { useMe } from "@/providers/me-provider";

const PAGE_SIZE = 30;

// Typing indicator is purely event-driven off the server's typing:update
// broadcasts (see typing.service.ts) — by design there's no client-side
// expiry, the server sweep is meant to be the sole authority. But that means
// a single dropped typing:update (flaky connection, backgrounded sender tab,
// etc.) leaves the bubble stuck forever with nothing to ever correct it.
// useTypingBackstop (below) is the fix — a backstop, not a replacement: it
// only ever fires when the server's own real signal never arrives at all.
// See that hook for the reset/re-arm mechanics.
//
// This window is derived from the server's own worst-case "sender went
// quiet" detection latency, not a guess: an entry expires after
// TYPING_TIMEOUT_MS with no refresh, and the sweep that broadcasts the
// resulting typing:update(false) runs at most TYPING_SWEEP_INTERVAL_MS
// later. A real stop signal should always reach a healthy client within
// that window, so this stays comfortably (2x) above it.
//
// One caveat, confirmed by reading typing.service.ts, not assumed:
// typingStart()'s `wasActive` check means the server broadcasts
// typing:update(true) only ONCE per continuous session (the absent→present
// transition), never again on the debounced refreshes that follow while
// someone keeps typing — so a single, long, uninterrupted session gets no
// further "still typing" ping to reset this on, and could in principle
// outlast this window and have its bubble cleared a few seconds early.
// Accepted trade-off: this client can't distinguish "still typing, nothing
// new to report" from "stopped, and the stop broadcast got lost" with only
// the signal the server currently sends — and clearing a few seconds early
// is a strict improvement over never clearing at all.
const PARTNER_TYPING_BACKSTOP_MS = (TYPING_TIMEOUT_MS + TYPING_SWEEP_INTERVAL_MS) * 2;

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
  file:         Blob,
  uploadId:     string,
  signal:       AbortSignal,
  deliveryMode: DeliveryMode,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await mediaApi.upload(file, uploadId, signal, deliveryMode);
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

// Tagged union for events buffered by the sync barrier during replay.
// Flushed in causal order (new → edit → delete → delivered → read) so
// receipts never apply before the messages they reference exist in state.
type SyncBufferEvent =
  | { type: "new";       payload: { message: Message } }
  | { type: "read";      payload: { conversationId: string; readBy: string; messageIds: string[]; readAt: string; deliveredAt?: string | null } }
  | { type: "edit";      payload: { messageId: string; body: string; editedAt: string } }
  | { type: "delete";    payload: { messageId: string } }
  | { type: "delivered"; payload: { conversationId: string; messageIds: string[]; deliveredAt: string } };

// Client-only extension — `_failed` is never set by the server and is
// stripped implicitly when a message is replaced by the real server row.
type LocalMessage = Message & { _failed?: true };

type ConversationDetail = {
  conversationId: string;
  participant: {
    userId: string;
    username: string;
    avatarUrl?: string | null;
    isOnline?: boolean;
    lastSeenAt?: string | null;
    // MY private nickname for them — null/absent means show the real username.
    nickname?: string | null;
  };
  createdAt: string;
  myAcceptedAt: string | null;
  // THEIR nickname for ME, only present once they've shared it — drives the
  // "X calls you: Y" badge. Reverse direction from participant.nickname.
  sharedNicknameForMe?: string | null;
};

// participant.nickname isn't a handle, so it's shown plain — never with an
// "@" prefix. Bare name: nickname if set, else the real username. Falls back
// instantly the moment a nickname is cleared. For components that build
// their OWN "@" prefix around the name they're given (Avatar's alt text,
// TypingBubble's aria-label), pass this bare form — never displayNameHandle.
function displayName(p: ConversationDetail["participant"]): string {
  return p.nickname ?? p.username;
}

// For plain text spots that today read "@username": keeps the "@" ONLY when
// falling back to the real username — a nickname is never shown with one
// (it isn't a handle, and doubling up with a component that adds its own
// "@" would produce "@@alice" or a fake-looking "@Bug").
function displayNameHandle(p: ConversationDetail["participant"]): string {
  return p.nickname ? p.nickname : `@${p.username}`;
}

// Conversation/Message ids are always Prisma @default(uuid()) — the backend
// enforces `format: "uuid"` on every route keyed by this param and 422s
// otherwise. A malformed segment here (e.g. the inbox header's not-yet-built
// "Search" link, which routes to /conversations/search with nothing at that
// path — Next's [id] route catches it) would otherwise still fire the
// detail/messages/pins fetches and fail visibly on every one of them.
// Intentionally version-agnostic (any hex in every group, not just v4) —
// this is a client-side pre-check to avoid doomed requests, not the
// authoritative validator; the backend's TypeBox format stays that.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(id: string): boolean {
  return UUID_PATTERN.test(id);
}

export default function ChatThreadPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const conversationId = params.id;
  const validId = isValidUuid(conversationId);

  // Redirect to the inbox on a malformed id instead of letting every
  // dependent fetch below fire and 422 — see isValidUuid's comment for why
  // this can happen (e.g. the not-yet-built Search link).
  useEffect(() => {
    if (!validId) router.replace("/conversations");
  }, [validId, router]);
  const { startCall } = useCall();
  const { userId: meId } = useMe();

  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  // Normalized message store: keyed by messageId for O(1) lookup and atomic
  // swaps (optimistic tempId → server realId without re-ordering the array).
  const messagesRef      = useRef<Record<string, LocalMessage>>({});
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  // Increment to force a re-render after ref mutations.
  const [renderTick,     setRenderTick]     = useState(0);
  // Maps clientMessageId → tempId so the WS echo can atomically replace the
  // optimistic placeholder without causing a visible duplicate.
  const clientToTempRef  = useRef<Map<string, string>>(new Map());
  const [partnerTyping, setPartnerTypingWithBackstop, clearPartnerTypingBackstop] =
    useTypingBackstop(PARTNER_TYPING_BACKSTOP_MS);
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Synchronous re-entrancy guard for loadOlder/jumpToMessage. `loadingOlder`
  // (React state) isn't enough on its own: a fast scroll-up fires several
  // native 'scroll' events synchronously, all before React commits the
  // setLoadingOlder(true) update and the listener effect below picks up a
  // fresh loadOlder closure — so the state-only guard let concurrent fetches
  // for the same cursor through. This ref closes that window immediately.
  const loadingOlderRef = useRef(false);

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
  const [ephemeralView, setEphemeralView] = useState<{ url: string; type: "image" | "video" } | null>(null);
  // Disappearing-message modal state — a SNAPSHOT from the POST /view
  // response, deliberately never re-derived from messagesRef afterward. If
  // this instead re-read messagesRef[messageId].body on every render, a
  // live message:deleted broadcast racing in right after the response (the
  // last look on views mode, or just general timing on time mode) could flip
  // isDeleted before the reveal ever painted, silently hiding content the
  // recipient's own open response already delivered. Decoupling avoids that
  // race entirely — see handleViewDisappear below.
  const [openDisappear, setOpenDisappear] = useState<{ messageId: string; mode: "views" | "time"; body: string; expiresAt: string | null } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const dragCounterRef = useRef(0);
  const [pins, setPins] = useState<PinnedMessage[]>([]);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [pinnedListOpen, setPinnedListOpen] = useState(false);
  const [contactInfoOpen, setContactInfoOpen] = useState(false);
  const [sharedMediaOpen, setSharedMediaOpen] = useState(false);
  const [flashMessageId, setFlashMessageId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Set by jumpToMessage while a target isn't yet in the loaded window;
  // consumed by the effect below once more history has been paged in.
  const pendingJumpRef = useRef<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  // meId comes from MeContext (resolved by AppShell before this page mounts).
  // Keep a ref so WS handlers always see the current value without re-subscribing.
  const meIdRef = useRef<string | null>(null);
  useEffect(() => { meIdRef.current = meId; }, [meId]);

  // Sync barrier — buffers live message:new events that arrive while a
  // reconnect replay is in flight, then flushes them after replay completes
  // so messages are always applied oldest-first without duplicates.
  const isSyncingRef    = useRef(false);
  const syncQueueRef    = useRef<SyncBufferEvent[]>([]);
  // Cursor for replay: createdAt of the last message the client has seen.
  // Updated in applyMessageNew so it always reflects in-memory state.
  const replayCursorRef  = useRef<string | null>(null);
  // Safety net: read receipts that arrive before their target message is in
  // local state. Flushed by applyMessageNew when the message lands.
  const pendingReadsRef  = useRef<Map<string, Array<{ readBy: string; readAt: string; deliveredAt?: string | null }>>>(new Map());

  // Same pattern as meIdRef — detail resolves async, but WS handlers must
  // not re-subscribe when it lands (churn drops events). Read through a ref.
  const partnerIdRef = useRef<string | null>(null);
  useEffect(() => { partnerIdRef.current = detail?.participant.userId ?? null; }, [detail]);

  // Returns messages sorted oldest-first. Reads directly from the ref so
  // callers always get the latest snapshot after any ref mutation.
  // messageId tie-breaker gives deterministic order when two messages share
  // the same createdAt timestamp (burst sends, replayed events).
  const getMessagesArray = (): LocalMessage[] =>
    Object.values(messagesRef.current).sort((a, b) => {
      const t = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return t !== 0 ? t : a.messageId.localeCompare(b.messageId);
    });

  // Initial loads — detail and history — fired in parallel. meId comes from MeContext.
  useEffect(() => {
    if (!validId) return; // malformed id — the redirect effect above handles navigation
    let cancelled = false;
    (async () => {
      try {
        const [det, hist] = await Promise.all([
          api<ConversationDetail>(`/api/conversations/${conversationId}`),
          api<{ messages: Message[]; nextCursor: string | null }>(
            `/api/conversations/${conversationId}/messages?limit=${PAGE_SIZE}`,
          ),
        ]);
        if (cancelled) return;
        setDetail(det);
        // API returns newest-first; reverse so DOM order is oldest-first.
        const ordered = [...hist.messages].reverse();
        // Populate normalized store — triggers a single render via setMessagesLoaded.
        messagesRef.current = Object.fromEntries(ordered.map((m) => [m.messageId, m]));
        setNextCursor(hist.nextCursor);
        setMessagesLoaded(true);
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
  }, [conversationId, router, validId]);

  // Pinned messages — loaded independently of the detail/history fetch above
  // so a failure here (or just slower load) never blocks the core thread from
  // rendering; the banner/list simply stay empty until it resolves.
  useEffect(() => {
    if (!validId) return; // malformed id — the redirect effect above handles navigation
    let cancelled = false;
    void api<{ pins: PinnedMessage[] }>(`/api/conversations/${conversationId}/pins`)
      .then((res) => { if (!cancelled) setPins(res.pins); })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId, validId]);

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

    // One rerender() call triggers a render that reads the latest ref snapshot.
    // setRenderTick is stable (like setState), so it's safe to close over here.
    const rerender = () => setRenderTick((x) => x + 1);

    // ── apply* functions ──────────────────────────────────────────────────────
    // All mutations go through these. Both live handlers and the sync-barrier
    // flush use the same path so state is always consistent.

    const applyMessageNew = (payload: { message: Message }) => {
      if (payload.message.conversationId !== conversationId) return;
      const { message } = payload;

      // If this is a WS echo of one of our pending optimistic sends, do an
      // atomic swap: replace the tempId placeholder with the real server ID
      // in a single mutation so the message never flickers out of view.
      const ourTempId = message.clientMessageId
        ? clientToTempRef.current.get(message.clientMessageId)
        : undefined;
      if (ourTempId !== undefined) {
        clientToTempRef.current.delete(message.clientMessageId!);
        messagesRef.current[message.messageId] = {
          ...messagesRef.current[ourTempId],
          ...message,
          // A "views"-mode disappear echo also nulls body — same reasoning
          // as handleSend's HTTP swap: keep what the sender actually typed.
          body:       message.body ?? messagesRef.current[ourTempId]?.body ?? null,
          reactions:  message.reactions  ?? {},
          myReaction: message.myReaction ?? null,
          readBy:     message.readBy     ?? [],
        };
        delete messagesRef.current[ourTempId];
      } else {
        if (messagesRef.current[message.messageId]) return; // dedup
        messagesRef.current[message.messageId] = {
          ...message,
          reactions:  message.reactions  ?? {},
          myReaction: message.myReaction ?? null,
          readBy:     message.readBy     ?? [],
        };
      }

      replayCursorRef.current = message.createdAt;

      // Flush any read receipts buffered while this message was still missing.
      const pending = pendingReadsRef.current.get(message.messageId);
      if (pending?.length) {
        pendingReadsRef.current.delete(message.messageId);
        let m = messagesRef.current[message.messageId];
        if (m) {
          for (const p of pending) {
            if (!m.readBy.some((r) => r.userId === p.readBy)) {
              m = { ...m, readBy: [...m.readBy, { userId: p.readBy, readAt: p.readAt }], deliveredAt: m.deliveredAt ?? p.deliveredAt ?? p.readAt };
            }
          }
          messagesRef.current[message.messageId] = m;
        }
      }

      rerender();

      // Jump-to-bottom badge: count a partner message as "unseen" only while
      // scrolled away from the bottom. stickToBottomRef (not the atBottom
      // state) is read here since this whole socket effect only re-subscribes
      // on conversationId change — a state closure here would go stale for
      // the life of the conversation, same reasoning as meIdRef/partnerIdRef.
      if (message.senderId !== meIdRef.current && !stickToBottomRef.current) {
        setUnseenCount((c) => c + 1);
      }

      if (
        message.senderId !== meIdRef.current &&
        typeof document !== "undefined" &&
        document.visibilityState === "visible"
      ) {
        void api(`/api/conversations/${conversationId}/read`, { method: "POST" }).catch(() => {});
      }
    };

    const applyMessageRead = (payload: { conversationId: string; readBy: string; messageIds: string[]; readAt: string; deliveredAt?: string | null }) => {
      if (payload.conversationId !== conversationId) return;
      let changed = false;
      for (const msgId of payload.messageIds) {
        const m = messagesRef.current[msgId];
        if (!m) {
          // Message not in state yet — buffer for when it lands.
          const bucket = pendingReadsRef.current.get(msgId) ?? [];
          bucket.push({ readBy: payload.readBy, readAt: payload.readAt, deliveredAt: payload.deliveredAt });
          pendingReadsRef.current.set(msgId, bucket);
          continue;
        }
        const alreadyRead = m.readBy.some((r) => r.userId === payload.readBy);
        if (!alreadyRead) {
          messagesRef.current[msgId] = {
            ...m,
            readBy: [...m.readBy, { userId: payload.readBy, readAt: payload.readAt }],
            // Read implies delivered — backfill so sender sees ✓✓ blue.
            deliveredAt: m.deliveredAt ?? payload.deliveredAt ?? payload.readAt,
          };
          changed = true;
        } else if (!m.deliveredAt) {
          const fill = payload.deliveredAt ?? payload.readAt;
          if (fill) { messagesRef.current[msgId] = { ...m, deliveredAt: fill }; changed = true; }
        }
      }
      if (changed) rerender();
    };

    const applyMessageDelivered = (payload: { conversationId: string; messageIds: string[]; deliveredAt: string }) => {
      if (payload.conversationId !== conversationId) return;
      let changed = false;
      for (const msgId of payload.messageIds) {
        const m = messagesRef.current[msgId];
        if (m && !m.deliveredAt) { messagesRef.current[msgId] = { ...m, deliveredAt: payload.deliveredAt }; changed = true; }
      }
      if (changed) rerender();
    };

    const applyMessageEdited = (payload: { messageId: string; body: string; editedAt: string }) => {
      const m = messagesRef.current[payload.messageId];
      if (!m) return;
      // Last-write-wins: ignore stale edits that arrived out of order.
      if (m.editedAt && new Date(m.editedAt) >= new Date(payload.editedAt)) return;
      messagesRef.current[payload.messageId] = { ...m, body: payload.body, isEdited: true, editedAt: payload.editedAt };
      rerender();
    };

    const applyMessageDeleted = (payload: { messageId: string }) => {
      const m = messagesRef.current[payload.messageId];
      if (!m) return;
      messagesRef.current[payload.messageId] = { ...m, isDeleted: true, body: null };
      rerender();
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
      setPartnerTypingWithBackstop(false);
      isSyncingRef.current = true;
      syncQueueRef.current  = [];
      pendingReadsRef.current.clear();

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

      // Applies one replay result (missed events oldest-first), then — only
      // once nextCursor says the server is fully caught up — flushes any live
      // events that buffered while the barrier was up. Shared by both the
      // normal socket-replay path and the HTTP-fallback recovery path below,
      // so a request that failed over to HTTP is applied identically to one
      // that succeeded over the socket.
      const applyReplayResult = (events: ReplayResponse["events"], nextCursor: string | null) => {
        // ACK all envelopes first (idempotent — safe before applying).
        for (const env of events) {
          socket.emit(ACK_EVENT, { eventId: env.eventId, status: "ok" });
        }
        // Apply in causal order: new messages first so that edit/delete/read
        // events referencing them find their targets already in state.
        for (const env of events) {
          if (env.eventName === "message:new")
            applyMessageNew(env.payload as { message: Message });
        }
        for (const env of events) {
          if (env.eventName === "message:edited")
            applyMessageEdited(env.payload as { messageId: string; body: string; editedAt: string });
        }
        for (const env of events) {
          if (env.eventName === "message:deleted")
            applyMessageDeleted(env.payload as { messageId: string });
        }
        for (const env of events) {
          if (env.eventName === "message:delivered")
            applyMessageDelivered(env.payload as { conversationId: string; messageIds: string[]; deliveredAt: string });
        }
        for (const env of events) {
          if (env.eventName === "message:read")
            applyMessageRead(env.payload as { conversationId: string; readBy: string; messageIds: string[]; readAt: string; deliveredAt?: string | null });
        }

        // Advance the replay cursor to the outbox insertion timestamp (not the
        // message's createdAt) so the next replay starts from the right position.
        const lastEnv = events[events.length - 1];
        if (lastEnv) replayCursorRef.current = lastEnv.timestamp;

        // If nextCursor is null the server has fully caught us up — close the
        // barrier and flush any live events that queued during the sync window.
        if (!nextCursor) {
          socket.off(SYNC_EVENTS.REPLAY_RESPONSE, handleReplay);
          currentReplayHandler  = null;
          isSyncingRef.current  = false;
          const queued = syncQueueRef.current.splice(0);
          // Causal flush order: new messages first (so receipts have something
          // to apply to), then mutations, then read receipts last.
          for (const e of queued) { if (e.type === "new")       applyMessageNew(e.payload); }
          for (const e of queued) { if (e.type === "edit")      applyMessageEdited(e.payload); }
          for (const e of queued) { if (e.type === "delete")    applyMessageDeleted(e.payload); }
          for (const e of queued) { if (e.type === "delivered") applyMessageDelivered(e.payload); }
          for (const e of queued) { if (e.type === "read")      applyMessageRead(e.payload); }
        }
      };

      // Unblocks the UI on a total replay failure (socket AND HTTP fallback
      // both failed) without silently pretending sync succeeded. Deliberately
      // does NOT touch replayCursorRef — leaving the cursor where it is means
      // the next genuine reconnect retries this exact missed window instead
      // of skipping past it.
      const abandonReplay = (reason: unknown) => {
        console.error("[sync] replay failed on both the socket and HTTP fallback paths", reason);
        setError("Some messages may be missing — check your connection.");
        socket.off(SYNC_EVENTS.REPLAY_RESPONSE, handleReplay);
        currentReplayHandler  = null;
        isSyncingRef.current  = false;
        const queued = syncQueueRef.current.splice(0);
        for (const e of queued) { if (e.type === "new")       applyMessageNew(e.payload); }
        for (const e of queued) { if (e.type === "edit")      applyMessageEdited(e.payload); }
        for (const e of queued) { if (e.type === "delete")    applyMessageDeleted(e.payload); }
        for (const e of queued) { if (e.type === "delivered") applyMessageDelivered(e.payload); }
        for (const e of queued) { if (e.type === "read")      applyMessageRead(e.payload); }
      };

      const handleReplay = async (res: ReplayResponse) => {
        // Stale check: a newer reconnect fired while this response was in
        // flight. The new reconnect's handler will take over.
        if (epoch !== getReconnectEpoch()) {
          isSyncingRef.current = false;
          syncQueueRef.current  = [];
          return;
        }

        if (res.error) {
          // The socket-side replay failed (see sync.socket.ts's
          // REPLAY_REQUEST catch handler). nextCursor is null on this path
          // too, but that must NOT be read as "fully caught up" — fall back
          // to the HTTP replay endpoint per the documented contract instead
          // of silently discarding the missed-event window.
          try {
            const fallback = await syncApi.replay(cursor, { conversationId });
            if (epoch !== getReconnectEpoch()) {
              isSyncingRef.current = false;
              syncQueueRef.current  = [];
              return;
            }
            applyReplayResult(fallback.events, fallback.nextCursor);
          } catch (fallbackErr) {
            abandonReplay(fallbackErr);
          }
          return;
        }

        applyReplayResult(res.events, res.nextCursor);
      };

      currentReplayHandler = handleReplay;
      socket.on(SYNC_EVENTS.REPLAY_RESPONSE, handleReplay);
    };
    socket.on("connect", onReconnect);

    // All four message event handlers gate on the sync barrier so that events
    // arriving during replay are buffered and flushed in causal order, not
    // applied out of order against an incomplete in-memory message list.

    const onMessageNew = (payload: { message: Message }) => {
      if (isSyncingRef.current) {
        syncQueueRef.current.push({ type: "new", payload });
        return;
      }
      applyMessageNew(payload);
    };

    const onMessageRead = (payload: { conversationId: string; readBy: string; messageIds: string[]; readAt: string; deliveredAt?: string | null }) => {
      if (isSyncingRef.current) {
        syncQueueRef.current.push({ type: "read", payload });
        return;
      }
      applyMessageRead(payload);
    };

    const onMessageDelivered = (payload: { conversationId: string; messageIds: string[]; deliveredAt: string }) => {
      if (isSyncingRef.current) {
        syncQueueRef.current.push({ type: "delivered", payload });
        return;
      }
      applyMessageDelivered(payload);
    };

    const onMessageEdited = (payload: { messageId: string; body: string; editedAt: string }) => {
      if (isSyncingRef.current) {
        syncQueueRef.current.push({ type: "edit", payload });
        return;
      }
      applyMessageEdited(payload);
    };

    const onMessageDeleted = (payload: { messageId: string }) => {
      if (isSyncingRef.current) {
        syncQueueRef.current.push({ type: "delete", payload });
        return;
      }
      applyMessageDeleted(payload);
    };

    const onMessageReaction = (payload: { messageId: string; reactions: Record<string, number>; actorId: string }) => {
      if (payload.actorId === meIdRef.current) return;
      const m = messagesRef.current[payload.messageId];
      if (!m) return;
      const stillMine = m.myReaction && payload.reactions[m.myReaction] ? m.myReaction : null;
      messagesRef.current[payload.messageId] = { ...m, reactions: payload.reactions, myReaction: stillMine };
      rerender();
    };

    const onTypingUpdate = (payload: {
      conversationId: string;
      userId:         string;
      isTyping:       boolean;
    }) => {
      if (payload.conversationId !== conversationId) return;
      if (payload.userId === meIdRef.current) return;
      setPartnerTypingWithBackstop(payload.isTyping);
    };

    const onTypingSyncResponse = (res: TypingSyncResponse) => {
      const typers = res.active[conversationId] ?? [];
      const partnerId = partnerIdRef.current;
      setPartnerTypingWithBackstop(!!partnerId && typers.includes(partnerId));
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

    const onProfileUpdated = (payload: UserProfileUpdatedEvent) => {
      if (payload.userId !== partnerIdRef.current) return;
      setDetail((prev) =>
        prev
          ? { ...prev, participant: { ...prev.participant, avatarUrl: payload.avatarUrl } }
          : prev,
      );
    };

    // The peer shared/unshared/changed their nickname for ME. Must reflect
    // immediately (not just on next load) — this is what makes "disappears
    // immediately if the owner un-shares" actually true.
    const onNicknameSharedUpdate = (payload: UserNicknameSharedUpdatedEvent) => {
      if (payload.ownerId !== partnerIdRef.current) return;
      setDetail((prev) => (prev ? { ...prev, sharedNicknameForMe: payload.nickname } : prev));
    };

    const onMessageEmbedUpdate = (payload: { messageId: string; embed: Message["embed"] }) => {
      const m = messagesRef.current[payload.messageId];
      if (!m) return;
      messagesRef.current[payload.messageId] = { ...m, embed: payload.embed };
      rerender();
    };

    // Pin state updates are plain idempotent set operations (add-if-absent /
    // remove-if-present) — no sync-barrier gating or actor check needed like
    // message:reaction's aggregate payload requires; applying our own action's
    // echo again here is harmless.
    const onMessagePinned = (payload: { pin: PinnedMessage }) => {
      if (payload.pin.conversationId !== conversationId) return;
      setPins((prev) => (prev.some((p) => p.id === payload.pin.id) ? prev : [payload.pin, ...prev]));
    };

    const onMessageUnpinned = (payload: { messageId: string; conversationId?: string }) => {
      if (payload.conversationId && payload.conversationId !== conversationId) return;
      setPins((prev) => prev.filter((p) => p.messageId !== payload.messageId));
    };

    const onMediaReady = (payload: MediaReadyEvent) => {
      for (const m of Object.values(messagesRef.current)) {
        if (!m.attachments?.some((a) => a.media.id === payload.mediaId)) continue;
        messagesRef.current[m.messageId] = {
          ...m,
          attachments: m.attachments.map((a) =>
            a.type !== "image" || a.media.id !== payload.mediaId
              ? a
              : { ...a, media: { ...a.media, blurUrl: payload.blurUrl, thumbUrl: payload.thumbUrl, blurWidth: payload.blurWidth, blurHeight: payload.blurHeight, thumbWidth: payload.thumbWidth, thumbHeight: payload.thumbHeight } },
          ),
        };
        rerender();
        break; // mediaId is unique per upload
      }
    };

    // Phase 6B unified event — currently used for video: swap the poster/
    // processing state for the playable stream once transcoding finishes.
    const onMediaProcessed = (payload: MediaProcessedEvent) => {
      if (payload.kind !== "video") return;
      for (const m of Object.values(messagesRef.current)) {
        if (!m.attachments?.some((a) => a.media.id === payload.mediaId)) continue;
        messagesRef.current[m.messageId] = {
          ...m,
          attachments: m.attachments.map((a) =>
            a.type !== "video" || a.media.id !== payload.mediaId
              ? a
              : { ...a, media: { ...a.media, status: payload.status, streamUrl: payload.streamUrl ?? a.media.streamUrl, posterUrl: payload.posterUrl ?? a.media.posterUrl, thumbUrl: payload.thumbUrl ?? a.media.thumbUrl } },
          ),
        };
        rerender();
        break;
      }
    };

    // Phase 6E: a recipient opened ephemeral media — tick the view count (and
    // flip to consumed once spent) so the sender's "Opened X/N" and this user's
    // other devices reflect it without a refetch.
    const onMediaViewed = (payload: MediaViewedEvent) => {
      for (const m of Object.values(messagesRef.current)) {
        if (!m.attachments?.some((a) => a.media.id === payload.mediaId)) continue;
        messagesRef.current[m.messageId] = {
          ...m,
          attachments: m.attachments.map((a) => {
            if (a.media.id !== payload.mediaId) return a;
            const consumedAt = payload.consumed ? payload.viewedAt : null;
            if (a.type === "image" && a.media.ephemeral) {
              return { ...a, media: { ...a.media, ephemeral: { ...a.media.ephemeral, viewCount: payload.viewCount, consumedAt: consumedAt ?? a.media.ephemeral.consumedAt } } };
            }
            if (a.type === "video" && a.media.ephemeral) {
              return { ...a, media: { ...a.media, ephemeral: { ...a.media.ephemeral, viewCount: payload.viewCount, consumedAt: consumedAt ?? a.media.ephemeral.consumedAt } } };
            }
            return a;
          }),
        };
        rerender();
        break; // mediaId is unique per upload
      }
    };

    // A look was spent on a "views"-mode disappearing message — ticks the
    // sender's (and other devices') viewCount live so a locked/status card
    // reflects "Opened X/N" without a refetch. The eventual soft-delete, once
    // the budget is spent, arrives separately via the existing message:deleted
    // handler above — this event never itself removes the message.
    const onMessageDisappearProgress = (payload: MessageDisappearProgressEvent) => {
      const m = messagesRef.current[payload.messageId];
      if (!m?.disappear) return;
      messagesRef.current[payload.messageId] = {
        ...m,
        disappear: { ...m.disappear, viewCount: payload.viewCount },
      };
      rerender();
    };

    // A "time"-mode message's clock started — fires once, only on the
    // recipient's FIRST explicit open (never on a reopen). Lets the card
    // start ticking live on the sender's screen and the recipient's other
    // devices without a refetch. Purely a list-level update (the card's own
    // countdown badge); it never touches openDisappear — a modal already
    // open elsewhere keeps showing whatever snapshot it opened with.
    const onMessageDisappearStarted = (payload: MessageDisappearStartedEvent) => {
      const m = messagesRef.current[payload.messageId];
      if (!m?.disappear) return;
      messagesRef.current[payload.messageId] = {
        ...m,
        disappear: { ...m.disappear, expiresAt: payload.expiresAt },
      };
      rerender();
    };

    const onVoiceTranscript = (payload: VoiceTranscriptReadyEvent) => {
      const m = messagesRef.current[payload.messageId];
      if (!m?.attachments) return;
      messagesRef.current[payload.messageId] = {
        ...m,
        attachments: m.attachments.map((a) =>
          a.type !== "voice" || a.id !== payload.attachmentId
            ? a
            : { ...a, media: { ...a.media, transcript: payload.transcript, transcriptStatus: payload.transcriptStatus } },
        ),
      };
      rerender();
    };

    socket.on("message:new", onMessageNew);
    socket.on("message:edited", onMessageEdited);
    socket.on("message:deleted", onMessageDeleted);
    socket.on("message:reaction", onMessageReaction);
    socket.on("message:read", onMessageRead);
    socket.on("message:delivered", onMessageDelivered);
    socket.on("message:embed:update", onMessageEmbedUpdate);
    socket.on("message:pinned", onMessagePinned);
    socket.on("message:unpinned", onMessageUnpinned);
    socket.on("typing:update", onTypingUpdate);
    socket.on(TYPING_EVENTS.SYNC_RESPONSE, onTypingSyncResponse);
    socket.on(PRESENCE_EVENTS.SYNC_RESPONSE, onPresenceSyncResponse);
    socket.on("presence:online", onPresenceOnline);
    socket.on("presence:offline", onPresenceOffline);
    socket.on(USER_EVENTS.PROFILE_UPDATED, onProfileUpdated);
    socket.on(USER_NICKNAME_EVENTS.SHARED_UPDATED, onNicknameSharedUpdate);
    socket.on(MEDIA_EVENTS.READY, onMediaReady);
    socket.on(MEDIA_EVENTS.PROCESSED, onMediaProcessed);
    socket.on(MEDIA_EVENTS.VIEWED, onMediaViewed);
    socket.on(MESSAGE_EVENTS.DISAPPEAR_PROGRESS, onMessageDisappearProgress);
    socket.on(MESSAGE_EVENTS.DISAPPEAR_STARTED, onMessageDisappearStarted);
    socket.on(VOICE_EVENTS.TRANSCRIPT_READY, onVoiceTranscript);

    return () => {
      // Leave the room and clear all barriers — prevents stale state from
      // leaking into the next conversation or mount cycle.
      isSyncingRef.current    = false;
      syncQueueRef.current    = [];
      pendingReadsRef.current.clear();
      messagesRef.current     = {};
      clientToTempRef.current.clear();
      replayCursorRef.current = null;
      clearPartnerTypingBackstop();
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
      socket.off("message:pinned", onMessagePinned);
      socket.off("message:unpinned", onMessageUnpinned);
      socket.off("typing:update", onTypingUpdate);
      socket.off(TYPING_EVENTS.SYNC_RESPONSE, onTypingSyncResponse);
      socket.off(PRESENCE_EVENTS.SYNC_RESPONSE, onPresenceSyncResponse);
      socket.off("presence:online", onPresenceOnline);
      socket.off("presence:offline", onPresenceOffline);
      socket.off(USER_EVENTS.PROFILE_UPDATED, onProfileUpdated);
      socket.off(USER_NICKNAME_EVENTS.SHARED_UPDATED, onNicknameSharedUpdate);
      socket.off(MEDIA_EVENTS.READY, onMediaReady);
      socket.off(MEDIA_EVENTS.PROCESSED, onMediaProcessed);
      socket.off(MEDIA_EVENTS.VIEWED, onMediaViewed);
      socket.off(MESSAGE_EVENTS.DISAPPEAR_PROGRESS, onMessageDisappearProgress);
      socket.off(MESSAGE_EVENTS.DISAPPEAR_STARTED, onMessageDisappearStarted);
      socket.off(VOICE_EVENTS.TRANSCRIPT_READY, onVoiceTranscript);
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
  // Jump-to-bottom affordance state — mirrors stickToBottomRef into actual
  // React state (the ref alone can't drive a render), plus a count of
  // partner messages that arrived while scrolled away from the bottom. This
  // is deliberately separate from server-side read receipts (applyMessageNew
  // below already marks a conversation read on arrival whenever the tab is
  // focused, regardless of scroll position) — unseenCount is a purely local,
  // ephemeral "have you scrolled past this yet" signal, not an unread count.
  const [atBottom, setAtBottom] = useState(true);
  const [unseenCount, setUnseenCount] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nearBottom = distFromBottom < 120;
      stickToBottomRef.current = nearBottom;
      setAtBottom(nearBottom);
      if (nearBottom) setUnseenCount(0);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);


  // Infinite scroll up — when scrolled near the top, fetch one more page.
  // Anchor preservation: capture scrollHeight before prepend, then shift
  // scrollTop by the delta so the user's viewport doesn't jump.
  const loadOlder = useCallback(async () => {
    if (!nextCursor || loadingOlderRef.current || !scrollRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const beforeHeight = scrollRef.current.scrollHeight;
    try {
      const res = await api<{ messages: Message[]; nextCursor: string | null }>(
        `/api/conversations/${conversationId}/messages?limit=${PAGE_SIZE}&cursor=${nextCursor}`,
      );
      // Merge older messages into the ref (dedup in case WS delivered some).
      for (const m of res.messages) {
        if (!messagesRef.current[m.messageId]) messagesRef.current[m.messageId] = m;
      }
      setNextCursor(res.nextCursor); // triggers re-render, which reads updated ref
      // Restore viewport after DOM has the new nodes.
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (!el) return;
        const delta = el.scrollHeight - beforeHeight;
        el.scrollTop += delta;
      });
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [conversationId, nextCursor]);

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
    async (body: string, replyToId?: string | null, disappear?: DisappearSend) => {
      const tempId          = crypto.randomUUID();
      const clientMessageId = crypto.randomUUID();

      // Optimistic: show the message instantly so there's no gap between
      // Enter and the message appearing. Swapped out for the real row once
      // the server responds. For a "views"-mode disappear, the sender's own
      // optimistic body is what DisappearCard renders as "revealed" — the
      // server intentionally nulls body even in the sender's own create
      // response (see message.routes.ts), so the swap below must not let
      // that null clobber what the user just typed.
      const optimisticDisappear = disappear
        ? disappear.mode === "views"
          ? { mode: "views" as const, viewLimit: disappear.viewLimit, viewCount: 0, expiresAt: null }
          : { mode: "time" as const, viewLimit: null, viewCount: 0, expiresAt: new Date(Date.now() + disappear.ttlSeconds * 1000).toISOString() }
        : null;
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
        disappear:  optimisticDisappear,
      };
      stickToBottomRef.current = true;
      // Register the clientMessageId → tempId mapping BEFORE inserting the
      // optimistic, so if the WS echo races the HTTP response the atomic swap
      // in applyMessageNew wins and the user never sees a duplicate.
      clientToTempRef.current.set(clientMessageId, tempId);
      messagesRef.current[tempId] = optimistic;
      setRenderTick((x) => x + 1);
      setReplyTo(null);

      try {
        const sent = await api<Message>(
          `/api/conversations/${conversationId}/messages`,
          { method: "POST", body: { body, ...(replyToId ? { replyToId } : {}), clientMessageId, ...(disappear ? { disappear } : {}) } },
        );
        // Swap optimistic placeholder → real message.
        // Case A (common): HTTP response beat the WS echo — tempId is still in
        //   the ref; do the swap now.
        // Case B (rare): WS echo arrived first (via applyMessageNew's atomic
        //   swap) — tempId is already gone; realId is in the ref; nothing to do.
        clientToTempRef.current.delete(clientMessageId);
        if (messagesRef.current[tempId]) {
          messagesRef.current[sent.messageId] = {
            ...messagesRef.current[tempId],
            ...sent,
            // See the comment above: the server nulls body for a "views"-mode
            // send even in the sender's own response — keep the optimistic
            // plaintext rather than let that null hide what was just typed.
            body:       sent.body ?? messagesRef.current[tempId]?.body ?? null,
            reactions:  sent.reactions  ?? {},
            myReaction: sent.myReaction ?? null,
          };
          delete messagesRef.current[tempId];
        } else if (!messagesRef.current[sent.messageId]) {
          // Defensive: neither temp nor real — insert the confirmed message.
          messagesRef.current[sent.messageId] = { ...sent, reactions: {}, myReaction: null };
        }
        setRenderTick((x) => x + 1);
      } catch (err) {
        // Mark the optimistic as failed rather than deleting it — prevents a
        // ghost state where the message just vanishes with no feedback.
        clientToTempRef.current.delete(clientMessageId);
        const m = messagesRef.current[tempId];
        if (m) messagesRef.current[tempId] = { ...m, _failed: true };
        setRenderTick((x) => x + 1);
        setError(err instanceof Error ? err.message : "Failed to send");
      }
    },
    [conversationId, meId, replyTo],
  );

  const handleUpdate = useCallback(async (messageId: string, body: string) => {
    try {
      await api(`/api/messages/${messageId}`, { method: "PATCH", body: { body } });
      const m = messagesRef.current[messageId];
      if (m) {
        messagesRef.current[messageId] = { ...m, body, isEdited: true, editedAt: new Date().toISOString() };
        setRenderTick((x) => x + 1);
      }
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
      const m = messagesRef.current[res.messageId];
      if (m) {
        messagesRef.current[res.messageId] = { ...m, reactions: res.reactions, myReaction: res.myReaction };
        setRenderTick((x) => x + 1);
      }
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

  const handlePin = useCallback(async (msg: Message) => {
    try {
      const pin = await api<PinnedMessage>(`/api/messages/${msg.messageId}/pin`, { method: "POST" });
      setPins((prev) => (prev.some((p) => p.id === pin.id) ? prev : [pin, ...prev]));
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail : "Failed to pin message");
    }
  }, []);

  const handleUnpin = useCallback(async (messageId: string) => {
    try {
      await api(`/api/messages/${messageId}/pin`, { method: "DELETE" });
      setPins((prev) => prev.filter((p) => p.messageId !== messageId));
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail : "Failed to unpin message");
    }
  }, []);

  const handleDismissFailed = useCallback((messageId: string) => {
    delete messagesRef.current[messageId];
    setRenderTick((x) => x + 1);
  }, []);

  const handleTypingChange = useCallback(
    (isTyping: boolean) => {
      const socket = getSocket();
      socket.emit(isTyping ? "typing:start" : "typing:stop", { conversationId });
    },
    [conversationId],
  );

  const handleSendImages = useCallback(
    async (requestedFiles: File[], existingUploadIds?: string[], deliveryMode: DeliveryMode = "optimized", ephemeral?: EphemeralSend) => {
      if (!requestedFiles.length) return;
      // Hard cap per send (the picker already trims + warns; this also guards the
      // paste/drag paths). Slicing here keeps one batch ≤10 uploads, under the
      // server's 20/min /media/upload limit. existingUploadIds (retry) is already ≤10.
      const files           = requestedFiles.slice(0, MAX_IMAGES_PER_SEND);
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
        // Client-side compression only for OPTIMIZED images. Video is never
        // compressed in-browser (the server transcodes), and LSS must preserve
        // the original bytes — both pass through untouched.
        const compressed = await Promise.all(
          files.map((f) =>
            f.type.startsWith("video/") || deliveryMode === "lss"
              ? Promise.resolve(f)
              : imageCompression(f, { maxSizeMB: 1, maxWidthOrHeight: 1920, useWebWorker: true, initialQuality: 0.84 }),
          ),
        );
        if (controller.signal.aborted) { aborted = true; return; }

        // Upload with concurrency limit + per-file auto-retry on network errors.
        const uploadTasks = compressed.map((f, i) => () =>
          uploadWithRetry(f, clientUploadIds[i]!, controller.signal, deliveryMode),
        );
        const mediaIds = await uploadPool(uploadTasks, MAX_CONCURRENT_UPLOADS);

        updateSession(batchId, { mediaIds, status: "sending" });
        setPendingBatches((prev) =>
          prev.map((b) => (b.batchId === batchId ? { ...b, status: "sending" } : b)),
        );

        await api(`/api/conversations/${conversationId}/messages/media`, {
          method: "POST",
          body:   { mediaIds, ...(ephemeral ? { ephemeral } : {}) },
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

  // Voice notes are short and single — skip the batch/optimistic machinery used
  // for images. Upload the Opus blob, then post the message; the message:new
  // echo renders the bubble (transcript fills in later via voice:transcript_ready).
  const handleSendVoice = useCallback(
    async (blob: Blob, durationMs: number) => {
      stickToBottomRef.current = true;
      try {
        const uploadId = crypto.randomUUID();
        const { mediaId } = await mediaApi.uploadVoice(blob, uploadId, durationMs);
        await api(`/api/conversations/${conversationId}/messages/media`, {
          method: "POST",
          body:   { mediaIds: [mediaId] },
        });
      } catch {
        setError("Couldn't send voice message. Try again.");
      }
    },
    [conversationId],
  );

  // Opt-in transcription — fires only when the user taps Transcribe on a voice
  // bubble. The worker emits voice:transcript_ready, which onVoiceTranscript
  // patches in. Rejection propagates so the bubble can reset its pending state.
  // Phase 6E: recipient taps a locked ephemeral card. POST /view counts the view
  // server-side and returns a short-lived URL we show once; the media:viewed
  // socket echo flips the bubble to "Viewed" when the budget is spent.
  const handleViewEphemeral = useCallback(
    async (attachment: ImageAttachment | VideoAttachment) => {
      try {
        const res = await api<MediaViewResponse>(`/api/media/${attachment.media.id}/view`, { method: "POST" });
        if (res.url) {
          setEphemeralView({ url: res.url, type: attachment.type });
        } else {
          setError("This media has already been viewed.");
        }
      } catch (err) {
        // 409 = video not transcoded yet; the server did NOT spend a view, so
        // the card stays tappable and the user can retry in a moment.
        if (err instanceof ApiError && err.status === 409) {
          setError("This video is still processing — try again in a moment.");
        } else {
          setError("Couldn't open this media. Try again.");
        }
      }
    },
    [],
  );

  // Recipient taps a locked disappearing message's card (either mode).
  // POST /view is the single explicit-open action for both. The response's
  // body/expiresAt become a SNAPSHOT handed straight to openDisappear — the
  // modal displays exactly that snapshot and never re-reads messagesRef
  // afterward. This is deliberate, not incidental: for a views-mode message
  // spending its LAST look, the server emits message:deleted essentially
  // concurrently with returning this same HTTP response. If the modal
  // instead re-read messagesRef[messageId].body on every render, a socket
  // event winning that race would flip isDeleted before the reveal ever
  // painted, and the recipient's own successful open would silently show
  // nothing — the message would be gone without ever having been seen. The
  // snapshot sidesteps the race entirely: whatever the server handed back
  // for THIS call is what displays, independent of whatever the list state
  // does next.
  //
  // messagesRef is still patched separately, for the CARD's own live state
  // (views: ticking viewCount; time: the countdown once it can show one) —
  // that update is allowed to race freely, since it only affects the
  // locked/reopenable card, never content already open in the modal.
  const handleViewDisappear = useCallback(async (messageId: string) => {
    try {
      const res = await api<MessageOpenResponse>(`/api/messages/${messageId}/view`, { method: "POST" });
      const m = messagesRef.current[messageId];

      if (res.mode === "views") {
        if (res.body == null) {
          setError("This message has already been viewed.");
          return;
        }
        if (m?.disappear) {
          messagesRef.current[messageId] = { ...m, disappear: { ...m.disappear, viewCount: res.viewCount } };
          setRenderTick((x) => x + 1);
        }
        setOpenDisappear({ messageId, mode: "views", body: res.body, expiresAt: null });
        return;
      }

      // "time" mode — always returns a body; may or may not be the first
      // open (the response doesn't distinguish, and the client doesn't need
      // to: reopening is free either way).
      if (m?.disappear) {
        messagesRef.current[messageId] = { ...m, disappear: { ...m.disappear, expiresAt: res.expiresAt } };
        setRenderTick((x) => x + 1);
      }
      setOpenDisappear({ messageId, mode: "time", body: res.body, expiresAt: res.expiresAt });
    } catch {
      setError("Couldn't open this message. Try again.");
    }
  }, []);

  const handleRequestTranscript = useCallback(
    (messageId: string, attachmentId: string): Promise<void> =>
      api(`/api/messages/${messageId}/attachments/${attachmentId}/transcribe`, { method: "POST" }).then(() => undefined),
    [],
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
    // dateKey (not the display label) is the virtualizer's getItemKey source
    // below — dayLabel() drops the year for anything older than yesterday, so
    // two different days a year+ apart can render the identical label text.
    | { kind: "separator"; label: string; dateKey: string }
    | { kind: "message"; message: LocalMessage }
    | { kind: "pending"; batch: PendingBatch }
    | { kind: "typing" };

  const flatRows = useMemo((): VirtualRow[] => {
    if (!messagesLoaded) return [];
    const rows: VirtualRow[] = [];
    if (loadingOlder) rows.push({ kind: "loader" });
    let lastLabel = "";
    for (const m of getMessagesArray()) {
      const label = dayLabel(m.createdAt);
      if (label !== lastLabel) { rows.push({ kind: "separator", label, dateKey: m.createdAt.slice(0, 10) }); lastLabel = label; }
      rows.push({ kind: "message", message: m });
    }
    for (const batch of pendingBatches) rows.push({ kind: "pending", batch });
    if (partnerTyping) rows.push({ kind: "typing" });
    return rows;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesLoaded, renderTick, loadingOlder, pendingBatches, partnerTyping]);

  const virtualizer = useVirtualizer({
    count:           flatRows.length,
    getScrollElement: () => scrollRef.current,
    // Stable per-row identity, not the default index-based key: loadOlder
    // prepends older messages to the FRONT of flatRows, which shifts every
    // existing row to a new index. Without this, the measurement cache stays
    // keyed by index, so post-prepend it applies each row's OLD (now
    // mismatched) cached height to whatever row now occupies that index,
    // until it happens to scroll into view and gets remeasured — a visible
    // stutter as getTotalSize()/offsets diverge from the real DOM heights.
    getItemKey: (index) => {
      const row = flatRows[index];
      if (!row) return index;
      switch (row.kind) {
        case "loader":    return "loader";
        case "typing":    return "typing";
        case "separator": return `separator:${row.dateKey}`;
        case "pending":   return `pending:${row.batch.batchId}`;
        case "message":   return `message:${row.message.messageId}`;
      }
    },
    estimateSize:    (i) => {
      const row = flatRows[i];
      if (!row) return 68;
      switch (row.kind) {
        case "loader":    return 56; // 2 stacked bubble placeholders, taller than the old single centered text line
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

  // Stick to bottom on new rows. Also clears the unseen badge — covers both
  // "my own send" (handleSend/handleSendImages/handleSendVoice force
  // stickToBottomRef true before this fires) and "a message arrived while
  // already at the bottom" (nothing was ever counted, so this is a no-op).
  useEffect(() => {
    if (stickToBottomRef.current && flatRows.length > 0) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      setUnseenCount(0);
    }
  }, [flatRows.length]);

  // Explicit jump via the floating "jump to bottom" button — smooth-scrolls
  // rather than the instant snap the auto-stick effect above uses, since this
  // one is a deliberate, visible user action rather than a background sync.
  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    stickToBottomRef.current = true;
    setAtBottom(true);
    setUnseenCount(0);
  }, []);

  // "Jump to message" from the pinned banner/list — only works for a message
  // already in the currently loaded window (flatRows). A pin older than the
  // loaded page won't be found; scrolling further back to locate it isn't
  // implemented here.
  const scrollToMessage = useCallback((messageId: string) => {
    const index = flatRows.findIndex((row) => row.kind === "message" && row.message.messageId === messageId);
    if (index === -1) return;
    virtualizer.scrollToIndex(index, { align: "center" });
    setFlashMessageId(messageId);
    window.setTimeout(() => setFlashMessageId((cur) => (cur === messageId ? null : cur)), 1500);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatRows]);

  // Flushes a pending search-result jump once its target has actually
  // reached flatRows — separate from scrollToMessage because the message may
  // still be several pages of history away when jumpToMessage is first
  // called (unlike the pinned-banner jump above, which only ever targets
  // something already loaded). Re-checks on every flatRows change so it
  // fires the instant jumpToMessage's own paging loop below merges in the
  // right page.
  useEffect(() => {
    const targetId = pendingJumpRef.current;
    if (!targetId) return;
    const index = flatRows.findIndex((row) => row.kind === "message" && row.message.messageId === targetId);
    if (index === -1) return;
    pendingJumpRef.current = null;
    virtualizer.scrollToIndex(index, { align: "center" });
    setFlashMessageId(targetId);
    window.setTimeout(() => setFlashMessageId((cur) => (cur === targetId ? null : cur)), 1500);
  }, [flatRows, virtualizer]);

  // Jump to a message found via search — unlike a pinned-message jump, the
  // target can be arbitrarily far back in history, outside the currently
  // loaded window. Pages older history in via the same cursor endpoint
  // loadOlder uses, bounded so a match near the very start of a long thread
  // can't page forever.
  const MAX_JUMP_PAGES = 40;
  const jumpToMessage = useCallback(async (messageId: string) => {
    if (messagesRef.current[messageId]) {
      pendingJumpRef.current = messageId;
      setRenderTick((x) => x + 1);
      return;
    }
    // Shares loadOlder's guard: both loops page the same cursor and mutate
    // the same messagesRef/nextCursor, so letting them run concurrently (e.g.
    // a scroll-up landing mid-jump) lets one clobber the other's cursor.
    if (loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    try {
      let cursor = nextCursor;
      for (let page = 0; cursor && page < MAX_JUMP_PAGES; page++) {
        const res = await api<{ messages: Message[]; nextCursor: string | null }>(
          `/api/conversations/${conversationId}/messages?limit=${PAGE_SIZE}&cursor=${cursor}`,
        );
        let found = false;
        for (const m of res.messages) {
          if (!messagesRef.current[m.messageId]) messagesRef.current[m.messageId] = m;
          if (m.messageId === messageId) found = true;
        }
        cursor = res.nextCursor;
        setNextCursor(cursor);
        if (found) break;
      }
    } finally {
      loadingOlderRef.current = false;
    }
    pendingJumpRef.current = messageId;
    setRenderTick((x) => x + 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, nextCursor]);

  // Malformed id — the redirect effect above is already navigating away.
  // Render nothing rather than the "loading conversation" skeleton below,
  // which would misleadingly imply a real conversation is about to appear.
  if (!validId) return null;

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

      {/* Header — replaced entirely by the search bar while searching. On
          mobile this reads as "the icon opens a search bar overlaying the
          header"; on desktop the same trigger sits right-aligned next to the
          call/video icons it temporarily displaces. */}
      {searchOpen ? (
        <MessageSearchBar
          conversationId={conversationId}
          onClose={() => { setSearchOpen(false); setSearchQuery(""); }}
          onJumpToMessage={jumpToMessage}
          onQueryChange={setSearchQuery}
        />
      ) : (
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
            // Not a <button>: SpotifyBadge (compact) renders a nested <a> when
            // the peer has a track link, and a real <a> inside a <button> is
            // invalid HTML — role="button" on a div sidesteps that while
            // staying keyboard-operable.
            <div
              role="button"
              tabIndex={0}
              aria-label={`Contact info for ${displayNameHandle(detail.participant)}`}
              onClick={() => setContactInfoOpen(true)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setContactInfoOpen(true); } }}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg text-left hover:bg-white/[0.04]"
            >
              <Avatar
                username={displayName(detail.participant)}
                src={detail.participant.avatarUrl}
                size={36}
                isOnline={detail.participant.isOnline}
              />
              <div className="flex min-w-0 flex-col">
                <span
                  className="truncate text-[16px] font-bold tracking-[-0.01em] text-[var(--color-text)]"
                  style={{ fontFamily: display }}
                >
                  {displayNameHandle(detail.participant)}
                </span>
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="shrink-0 text-[10px] tracking-[0.04em]"
                    style={{
                      color: detail.participant.isOnline
                        ? "var(--color-online)"
                        : "var(--color-text-muted)",
                      fontFamily: mono,
                    }}
                  >
                    {formatLastSeen(detail.participant.lastSeenAt, detail.participant.isOnline)}
                  </span>
                  {/* stopPropagation: this may render a nested <a> to the
                      track — must not also trigger the row's own onClick. */}
                  <span onClick={(e) => e.stopPropagation()}>
                    <SpotifyBadge userId={detail.participant.userId} compact />
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <>
              <SkeletonCircle size={36} />
              <div className="flex min-w-0 flex-col gap-1.5">
                <SkeletonLine className="h-3.5 w-28" />
                <SkeletonLine className="h-2.5 w-16" />
              </div>
            </>
          )}
        </div>
        <button
          type="button"
          aria-label="Search in conversation"
          onClick={() => setSearchOpen(true)}
          className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/5"
        >
          <Search className="h-5 w-5 text-[var(--color-text)]" />
        </button>
        <button
          type="button"
          aria-label="Audio call"
          disabled={!detail}
          onClick={() =>
            detail &&
            startCall(
              { id: detail.participant.userId, username: detail.participant.username },
              "AUDIO",
              conversationId,
            )
          }
          className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/5 disabled:opacity-40"
        >
          <Phone className="h-5 w-5 text-[var(--color-text)]" />
        </button>
        <button
          type="button"
          aria-label="Video call"
          disabled={!detail}
          onClick={() =>
            detail &&
            startCall(
              { id: detail.participant.userId, username: detail.participant.username },
              "VIDEO",
              conversationId,
            )
          }
          className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/5 disabled:opacity-40"
        >
          <Video className="h-5 w-5 text-[var(--color-text)]" />
        </button>
        <button
          type="button"
          aria-label="More"
          onClick={() => setHeaderMenuOpen((v) => !v)}
          className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/5"
        >
          <MoreHorizontal className="h-5 w-5 text-[var(--color-text)]" />
        </button>
      </header>
      )}

      {headerMenuOpen && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setHeaderMenuOpen(false)} />
          <div
            className="fixed right-4 top-14 z-50 w-52 overflow-hidden rounded-2xl border bg-[var(--color-raised)] shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
            style={{ borderColor: "var(--color-hairline-strong)" }}
          >
            <button
              type="button"
              onClick={() => { setHeaderMenuOpen(false); setPinnedListOpen(true); }}
              className="flex w-full items-center px-4 py-2.5 text-left text-[13px] font-medium text-[var(--color-text)] hover:bg-white/[0.06]"
            >
              Pinned Messages{pins.length > 0 ? ` (${pins.length})` : ""}
            </button>
            <button
              type="button"
              onClick={() => { setHeaderMenuOpen(false); setContactInfoOpen(true); }}
              className="flex w-full items-center px-4 py-2.5 text-left text-[13px] font-medium text-[var(--color-text)] hover:bg-white/[0.06]"
            >
              Contact info
            </button>
          </div>
        </>,
        document.body,
      )}

      {contactInfoOpen && detail && (
        <ContactInfoModal
          participant={detail.participant}
          conversationId={conversationId}
          conversationCreatedAt={detail.createdAt}
          pinCount={pins.length}
          onClose={() => setContactInfoOpen(false)}
          onNicknameChange={(nickname) =>
            setDetail((prev) => (prev ? { ...prev, participant: { ...prev.participant, nickname } } : prev))
          }
          onOpenMedia={() => { setContactInfoOpen(false); setSharedMediaOpen(true); }}
          onOpenPinned={() => { setContactInfoOpen(false); setPinnedListOpen(true); }}
          onStartVoiceCall={() => {
            setContactInfoOpen(false);
            startCall({ id: detail.participant.userId, username: detail.participant.username }, "AUDIO", conversationId);
          }}
          onStartVideoCall={() => {
            setContactInfoOpen(false);
            startCall({ id: detail.participant.userId, username: detail.participant.username }, "VIDEO", conversationId);
          }}
        />
      )}

      {sharedMediaOpen && (
        <SharedMediaGrid conversationId={conversationId} onClose={() => setSharedMediaOpen(false)} />
      )}

      {/* "X calls you: Y" — separate from the peer's own identity above, never
          merged into that line. Disappears the instant the owner un-shares or
          clears it (sharedNicknameForMe going back to null re-renders this
          away), whether from this tab's own action or the live socket event. */}
      {detail?.sharedNicknameForMe && (
        <div
          className="flex items-center gap-1.5 border-b px-4 py-2 text-[12px]"
          style={{ borderColor: "var(--color-hairline)", background: "rgba(59,130,246,0.06)" }}
        >
          <span className="text-[var(--color-text-secondary)]">
            {displayName(detail.participant)} calls you:
          </span>
          <span className="font-semibold text-[var(--color-text)]">{detail.sharedNicknameForMe}</span>
        </div>
      )}

      {pins.length > 0 && (
        <PinnedBanner
          pins={pins}
          onJump={scrollToMessage}
          onOpenList={() => setPinnedListOpen(true)}
        />
      )}

      {/* Message scroll — virtualized */}
      <div ref={scrollRef} className="relative flex-1 overflow-y-auto" style={{ touchAction: "pan-y" }}>
        {!messagesLoaded ? (
          <div data-testid="messages-loading" className="flex flex-col gap-2 px-4 pt-4 lg:px-8 xl:px-12">
            {[
              { mine: false, w: "w-40", h: "h-9" },
              { mine: true,  w: "w-28", h: "h-7" },
              { mine: false, w: "w-52", h: "h-14" },
              { mine: false, w: "w-24", h: "h-6" },
              { mine: true,  w: "w-36", h: "h-9" },
              { mine: true,  w: "w-20", h: "h-6" },
            ].map((b, i) => (
              <div key={i} className={b.mine ? "flex justify-end" : "flex justify-start"}>
                <Skeleton
                  className={`${b.h} ${b.w} rounded-[22px] ${b.mine ? "rounded-br-[6px]" : "rounded-bl-[6px]"}`}
                />
              </div>
            ))}
          </div>
        ) : Object.keys(messagesRef.current).length === 0 && !pendingBatches.length && !partnerTyping ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]" style={{ fontFamily: mono }}>
              empty thread
            </span>
            <p className="max-w-[260px] text-sm text-[var(--color-text-secondary)]">
              Say hi to <span className="text-[var(--color-text)]">{detail ? displayNameHandle(detail.participant) : ""}</span>. Messages stay between the two of you.
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
                    <div className="flex flex-col gap-1.5 py-2">
                      <div className="flex justify-start">
                        <Skeleton className="h-5 w-32 rounded-[16px_16px_16px_4px]" />
                      </div>
                      <div className="flex justify-end">
                        <Skeleton className="h-5 w-24 rounded-[16px_16px_4px_16px]" />
                      </div>
                    </div>
                  )}
                  {row.kind === "separator" && <DaySeparator date={row.label} />}
                  {row.kind === "message" && (() => {
                    const m = row.message;
                    const isMine = m.senderId === meId;
                    const partnerRead = isMine && detail
                      ? m.readBy.find((r) => r.userId === detail.participant.userId)
                      : undefined;
                    const isPinned = pins.some((p) => p.messageId === m.messageId);
                    return (
                      <div
                        className={isMine ? "flex justify-end" : "flex justify-start"}
                        style={m.messageId === flashMessageId ? { animation: "relay-pin-flash 1.5s ease-out" } : undefined}
                      >
                        <MessageBubble
                          message={m}
                          isMine={isMine}
                          isPinned={isPinned}
                          showReadReceipt={isMine}
                          readAt={partnerRead?.readAt ?? null}
                          deliveredAt={isMine ? m.deliveredAt : null}
                          failed={m._failed}
                          onReact={handleReact}
                          onReply={(msg) => { setEditing(null); setReplyTo(msg); }}
                          onEdit={m._failed ? undefined : (msg) => { setReplyTo(null); setEditing(msg); }}
                          onDelete={m._failed ? undefined : handleDelete}
                          onPin={m._failed ? undefined : handlePin}
                          onUnpin={m._failed ? undefined : (msg) => handleUnpin(msg.messageId)}
                          onDismiss={m._failed ? () => handleDismissFailed(m.messageId) : undefined}
                          onOpenLightbox={(atts: ImageAttachment[], idx: number) =>
                            setLightbox({ images: atts, index: idx })
                          }
                          onViewEphemeral={handleViewEphemeral}
                          onViewDisappear={handleViewDisappear}
                          onRequestTranscript={handleRequestTranscript}
                          highlightQuery={searchOpen ? searchQuery : undefined}
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
                      <TypingBubble username={detail ? displayName(detail.participant) : undefined} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Jump-to-bottom — same circular-signal-button language as the
            composer's send/mic buttons; badge matches conversation-row's
            unread-count pill. Absolute inside this (now relative) scrolling
            container, so it stays put in the viewport instead of scrolling
            away with the content. */}
        {!atBottom && (
          <button
            type="button"
            aria-label={unseenCount > 0 ? `${unseenCount} new message${unseenCount === 1 ? "" : "s"} — jump to latest` : "Jump to latest messages"}
            onClick={jumpToBottom}
            className="absolute bottom-4 right-4 z-20 flex h-10 w-10 items-center justify-center rounded-full text-white shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
            style={{ background: "var(--color-signal)" }}
          >
            <ChevronDown className="h-5 w-5" strokeWidth={2.4} />
            {unseenCount > 0 && (
              <span
                className="absolute -top-1.5 -right-1.5 flex h-5 min-w-[20px] items-center justify-center rounded-full border-2 px-1.5"
                style={{ background: "var(--color-signal)", borderColor: "var(--color-bg)" }}
              >
                <span className="text-[11px] font-bold text-white" style={{ fontFamily: mono }}>
                  {unseenCount > 99 ? "99+" : unseenCount}
                </span>
              </span>
            )}
          </button>
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
          // AcceptCard hardcodes its own "@" prefix around this — a nickname
          // rendered there would look like a fake handle ("@Bug"), so this
          // one spot intentionally stays the real username, not displayName().
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
          onSendImages={(files, mode, ephemeral) => handleSendImages(files, undefined, mode, ephemeral)}
          onSendVoice={handleSendVoice}
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

      {ephemeralView && (
        <EphemeralViewer
          url={ephemeralView.url}
          type={ephemeralView.type}
          onClose={() => setEphemeralView(null)}
        />
      )}

      {openDisappear && (
        <DisappearModal
          mode={openDisappear.mode}
          body={openDisappear.body}
          expiresAt={openDisappear.expiresAt}
          onClose={() => setOpenDisappear(null)}
        />
      )}

      {pinnedListOpen && (
        <PinnedMessagesList
          pins={pins}
          onJump={(messageId) => { setPinnedListOpen(false); scrollToMessage(messageId); }}
          onUnpin={handleUnpin}
          onClose={() => setPinnedListOpen(false)}
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

