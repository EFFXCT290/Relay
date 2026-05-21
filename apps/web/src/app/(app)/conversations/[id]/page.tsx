"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, MoreHorizontal } from "lucide-react";
import { ApiError, api } from "@/frontend-core/api";
import { getSocket } from "@/frontend-core/socket";
import { Avatar } from "@/shared/components/avatar";
import {
  DaySeparator,
  MessageBubble,
  TypingBubble,
  type Message,
} from "@/features/messages/components/message-bubble";
import { ChatComposer } from "@/features/messages/components/chat-composer";

const PAGE_SIZE = 30;

const mono = "var(--font-mono)";
const display = "var(--font-display)";

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

  const [meId, setMeId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  // meId resolves async from /api/auth/me. The WS effect must not re-subscribe
  // when it lands (the join/leave churn dropped events on first mount). Read it
  // through a ref so handlers always see the current value.
  const meIdRef = useRef<string | null>(null);
  useEffect(() => {
    meIdRef.current = meId;
  }, [meId]);

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
        setMessages([...hist.messages].reverse());
        setNextCursor(hist.nextCursor);

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

  // WebSocket subscription — join the conversation room and react to events.
  useEffect(() => {
    const socket = getSocket();
    socket.emit("conversation:join", { conversationId });

    const onMessageNew = (payload: { message: Message }) => {
      if (payload.message.conversationId !== conversationId) return;
      setMessages((prev) => {
        if (!prev) return prev;
        // Idempotency — if the server-sent copy of our own message lands
        // after the optimistic one, dedupe by id.
        if (prev.some((m) => m.messageId === payload.message.messageId)) return prev;
        // Server payloads from message:new may omit reactions/readBy since they
        // weren't populated yet; fill defaults so renderers don't choke.
        return [
          ...prev,
          {
            ...payload.message,
            reactions: payload.message.reactions ?? {},
            myReaction: payload.message.myReaction ?? null,
            readBy: payload.message.readBy ?? [],
          },
        ];
      });
      // Auto-mark-read for any incoming message from the other side, but only
      // while this tab is visible. Hidden tabs keep the unread state honest.
      if (
        payload.message.senderId !== meIdRef.current &&
        typeof document !== "undefined" &&
        document.visibilityState === "visible"
      ) {
        void api(`/api/conversations/${conversationId}/read`, { method: "POST" }).catch(() => {});
      }
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

    // Server is the source of truth for "is the partner typing right now?".
    // It already debounces refreshes and expires stuck entries on its own
    // sweep — receiver just mirrors the latest typing:update.
    const onTypingUpdate = (payload: {
      conversationId: string;
      userId:         string;
      isTyping:       boolean;
    }) => {
      if (payload.conversationId !== conversationId) return;
      if (payload.userId === meIdRef.current) return;
      setPartnerTyping(payload.isTyping);
    };

    socket.on("message:new", onMessageNew);
    socket.on("message:edited", onMessageEdited);
    socket.on("message:deleted", onMessageDeleted);
    socket.on("message:reaction", onMessageReaction);
    socket.on("message:read", onMessageRead);
    socket.on("message:delivered", onMessageDelivered);
    socket.on("typing:update", onTypingUpdate);

    return () => {
      socket.emit("conversation:leave", { conversationId });
      socket.off("message:new", onMessageNew);
      socket.off("message:edited", onMessageEdited);
      socket.off("message:deleted", onMessageDeleted);
      socket.off("message:reaction", onMessageReaction);
      socket.off("message:read", onMessageRead);
      socket.off("message:delivered", onMessageDelivered);
      socket.off("typing:update", onTypingUpdate);
    };
  }, [conversationId]);

  // Real-time presence — update partner's online/offline state as it changes.
  useEffect(() => {
    if (!detail) return;
    const socket = getSocket();
    const partnerId = detail.participant.userId;
    const onOnline = (payload: { userId: string }) => {
      if (payload.userId !== partnerId) return;
      setDetail((prev) =>
        prev ? { ...prev, participant: { ...prev.participant, isOnline: true } } : prev,
      );
    };
    const onOffline = (payload: { userId: string; lastSeen: string }) => {
      if (payload.userId !== partnerId) return;
      setDetail((prev) =>
        prev
          ? { ...prev, participant: { ...prev.participant, isOnline: false, lastSeenAt: payload.lastSeen } }
          : prev,
      );
    };
    socket.on("presence:online", onOnline);
    socket.on("presence:offline", onOffline);
    return () => {
      socket.off("presence:online", onOnline);
      socket.off("presence:offline", onOffline);
    };
  }, [detail?.participant.userId]);

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

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, partnerTyping]);

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
      stickToBottomRef.current = true;
      try {
        const sent = await api<Message>(
          `/api/conversations/${conversationId}/messages`,
          { method: "POST", body: { body, ...(replyToId ? { replyToId } : {}) } },
        );
        setMessages((prev) => {
          if (!prev) return prev;
          if (prev.some((m) => m.messageId === sent.messageId)) return prev;
          return [
            ...prev,
            {
              ...sent,
              senderUsername: sent.senderUsername ?? "you",
              reactions: sent.reactions ?? {},
              myReaction: sent.myReaction ?? null,
            },
          ];
        });
        setReplyTo(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to send");
      }
    },
    [conversationId],
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

  const grouped = useMemo(() => {
    if (!messages) return null;
    const groups: { label: string; items: Message[] }[] = [];
    for (const m of messages) {
      const label = dayLabel(m.createdAt);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(m);
      else groups.push({ label, items: [m] });
    }
    return groups;
  }, [messages]);

  return (
    <div className="flex h-dvh flex-col lg:h-[100dvh]">
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
                  {detail.participant.isOnline
                    ? "Active now"
                    : detail.participant.lastSeenAt
                      ? lastSeenText(detail.participant.lastSeenAt)
                      : "Offline"}
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

      {/* Message scroll */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto" style={{ touchAction: "pan-y" }}>
        <div className="flex w-full flex-col gap-2 px-4 py-4 lg:px-8 xl:px-12">
          {grouped === null ? (
            <div className="flex items-center justify-center py-12">
              <span
                className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]"
                style={{ fontFamily: mono }}
              >
                loading
              </span>
            </div>
          ) : grouped.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <span
                className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]"
                style={{ fontFamily: mono }}
              >
                empty thread
              </span>
              <p className="max-w-[260px] text-sm text-[var(--color-text-secondary)]">
                Say hi to <span className="text-[var(--color-text)]">@{detail?.participant.username}</span>. Messages stay between the two of you.
              </p>
            </div>
          ) : (
            <>
              {loadingOlder && (
                <div className="flex items-center justify-center py-3">
                  <span
                    className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]"
                    style={{ fontFamily: mono }}
                  >
                    loading older
                  </span>
                </div>
              )}
              {grouped.map((group) => (
                <div key={group.label} className="flex flex-col gap-2">
                  <DaySeparator date={group.label} />
                  {group.items.map((m) => {
                    const partnerRead =
                      m.senderId === meId && detail
                        ? m.readBy.find((r) => r.userId === detail.participant.userId)
                        : undefined;
                    return (
                      <MessageBubble
                        key={m.messageId}
                        message={m}
                        isMine={m.senderId === meId}
                        showReadReceipt={m.senderId === meId}
                        readAt={partnerRead?.readAt ?? null}
                        deliveredAt={m.senderId === meId ? m.deliveredAt : null}
                        onReact={handleReact}
                        onReply={(msg) => {
                          setEditing(null);
                          setReplyTo(msg);
                        }}
                        onEdit={(msg) => {
                          setReplyTo(null);
                          setEditing(msg);
                        }}
                        onDelete={handleDelete}
                      />
                    );
                  })}
                </div>
              ))}
            </>
          )}
          {partnerTyping && <TypingBubble username={detail?.participant.username} />}
        </div>
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
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          editing={editing}
          onCancelEdit={() => setEditing(null)}
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

function lastSeenText(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const mins = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (mins < 1) return "last seen just now";
  if (mins < 60) return `last seen ${mins}m ago`;
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return `last seen today at ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `last seen yesterday at ${time}`;
  return `last seen ${d.toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}`;
}
