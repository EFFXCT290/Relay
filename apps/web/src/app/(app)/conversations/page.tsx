"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Plus, Search, Trash2 } from "lucide-react";
import { api } from "@/frontend-core/api";
import { getSocket } from "@/frontend-core/socket";
import { Button } from "@/shared/ui/button";
import { Avatar } from "@/shared/components/avatar";
import { ConversationRow, type ConversationListItem } from "@/features/conversations/components/conversation-row";

const mono = "var(--font-mono)";
const display = "var(--font-display)";

type Filter = "all" | "unread" | "alerts" | "requests";

export default function ConversationsPage() {
  const router = useRouter();
  const [conversations, setConversations] = useState<ConversationListItem[] | null>(null);
  const [requests, setRequests] = useState<ConversationListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  // Initial load — accepted convos + pending requests in parallel.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [convs, reqs] = await Promise.all([
          api<{ conversations: ConversationListItem[]; nextCursor: string | null }>(
            "/api/conversations",
          ),
          api<{ requests: ConversationListItem[] }>("/api/conversations/requests"),
        ]);
        if (cancelled) return;
        setConversations(convs.conversations);
        setRequests(reqs.requests);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load conversations");
          setConversations([]);
          setRequests([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live: react to incoming requests / accepts / deletes so the inbox stays
  // current without the user reloading.
  useEffect(() => {
    const socket = getSocket();

    const onRequest = (payload: {
      conversationId: string;
      from: { userId: string; username: string };
      createdAt: string;
    }) => {
      setRequests((prev) => {
        const list = prev ?? [];
        if (list.some((c) => c.conversationId === payload.conversationId)) return list;
        const item: ConversationListItem = {
          conversationId: payload.conversationId,
          participant: { userId: payload.from.userId, username: payload.from.username },
          lastMessage: null,
          updatedAt: payload.createdAt,
        };
        return [item, ...list];
      });
    };

    const onAccepted = (payload: { conversationId: string; acceptedBy: string }) => {
      // Either side may receive this. If it's in my requests list, move it
      // into accepted. If it's already in accepted, no-op.
      setRequests((prev) => prev?.filter((c) => c.conversationId !== payload.conversationId) ?? prev);
      void refreshConversations();
    };

    const onDeleted = (payload: { conversationId: string }) => {
      setRequests((prev) => prev?.filter((c) => c.conversationId !== payload.conversationId) ?? prev);
      setConversations((prev) => prev?.filter((c) => c.conversationId !== payload.conversationId) ?? prev);
    };

    // Live: a new message arrived. Bump unread + preview + reorder on the
    // matching row, in whichever list it belongs to. Skip messages I sent
    // myself (those don't add unread).
    const onMessageNew = (payload: {
      message: {
        messageId: string;
        conversationId: string;
        senderId: string;
        body: string | null;
        type: string;
        createdAt: string;
      };
    }) => {
      const m = payload.message;
      const apply = (list: ConversationListItem[]): ConversationListItem[] => {
        const idx = list.findIndex((c) => c.conversationId === m.conversationId);
        if (idx === -1) return list;
        const prev = list[idx]!;
        const fromOther = m.senderId === prev.participant.userId;
        const updated: ConversationListItem = {
          ...prev,
          lastMessage: {
            messageId: m.messageId,
            type: m.type as NonNullable<ConversationListItem["lastMessage"]>["type"],
            preview: m.body ? m.body.slice(0, 80) : null,
            sentAt: m.createdAt,
          },
          unreadCount: fromOther ? (prev.unreadCount ?? 0) + 1 : prev.unreadCount ?? 0,
          updatedAt: m.createdAt,
        };
        // Reorder: bumped conversation goes to the top.
        const rest = list.slice(0, idx).concat(list.slice(idx + 1));
        return [updated, ...rest];
      };
      setConversations((prev) => (prev ? apply(prev) : prev));
      setRequests((prev) => (prev ? apply(prev) : prev));
    };

    // Refresh the accepted list — used after accept events to reflect the
    // new conversation that just moved into it.
    const refreshConversations = async () => {
      try {
        const convs = await api<{ conversations: ConversationListItem[]; nextCursor: string | null }>(
          "/api/conversations",
        );
        setConversations(convs.conversations);
      } catch {
        /* swallow — list will reload on next mount */
      }
    };

    const applyPresence = (
      list: ConversationListItem[],
      userId: string,
      patch: Partial<ConversationListItem["participant"]>,
    ) => list.map((c) =>
      c.participant.userId === userId
        ? { ...c, participant: { ...c.participant, ...patch } }
        : c,
    );

    const onPresenceOnline = (payload: { userId: string }) => {
      setConversations((p) => p ? applyPresence(p, payload.userId, { isOnline: true }) : p);
      setRequests((p) => p ? applyPresence(p, payload.userId, { isOnline: true }) : p);
    };

    const onPresenceOffline = (payload: { userId: string; lastSeen: string }) => {
      setConversations((p) => p ? applyPresence(p, payload.userId, { isOnline: false, lastSeenAt: payload.lastSeen }) : p);
      setRequests((p) => p ? applyPresence(p, payload.userId, { isOnline: false, lastSeenAt: payload.lastSeen }) : p);
    };

    const onTypingUpdate = (payload: { conversationId: string; userId: string; isTyping: boolean }) => {
      setConversations((prev) =>
        prev?.map((c) =>
          c.conversationId === payload.conversationId && c.participant.userId === payload.userId
            ? { ...c, isTyping: payload.isTyping }
            : c,
        ) ?? prev,
      );
    };

    socket.on("conversation:request", onRequest);
    socket.on("conversation:accepted", onAccepted);
    socket.on("conversation:deleted", onDeleted);
    socket.on("message:new", onMessageNew);
    socket.on("presence:online", onPresenceOnline);
    socket.on("presence:offline", onPresenceOffline);
    socket.on("typing:update", onTypingUpdate);

    return () => {
      socket.off("conversation:request", onRequest);
      socket.off("conversation:accepted", onAccepted);
      socket.off("conversation:deleted", onDeleted);
      socket.off("message:new", onMessageNew);
      socket.off("presence:online", onPresenceOnline);
      socket.off("presence:offline", onPresenceOffline);
      socket.off("typing:update", onTypingUpdate);
    };
  }, []);

  // Join every conversation room so typing:update events reach this page.
  // Re-runs only when the number of conversations changes (new accept/delete),
  // not on every reorder from incoming messages.
  useEffect(() => {
    const ids = conversations?.map((c) => c.conversationId) ?? [];
    if (ids.length === 0) return;
    const socket = getSocket();
    ids.forEach((id) => socket.emit("conversation:join", { conversationId: id }));
    return () => {
      ids.forEach((id) => socket.emit("conversation:leave", { conversationId: id }));
    };
  }, [conversations?.length]);

  const handleAccept = async (conversationId: string) => {
    try {
      await api(`/api/conversations/${conversationId}/accept`, { method: "POST" });
      setRequests((prev) => prev?.filter((c) => c.conversationId !== conversationId) ?? prev);
      // After accept, jump into the chat — Instagram-style.
      router.push(`/conversations/${conversationId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Accept failed");
    }
  };

  const handleDelete = async (conversationId: string) => {
    try {
      await api(`/api/conversations/${conversationId}`, { method: "DELETE" });
      setRequests((prev) => prev?.filter((c) => c.conversationId !== conversationId) ?? prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const unreadCount = conversations?.reduce((n, c) => n + (c.unreadCount ?? 0), 0) ?? 0;
  const alertCount = conversations?.filter((c) => c.captureAlert).length ?? 0;
  const requestCount = requests?.length ?? 0;
  const total = conversations?.length ?? 0;

  const visible = (conversations ?? []).filter((c) => {
    if (filter === "unread") return (c.unreadCount ?? 0) > 0;
    if (filter === "alerts") return c.captureAlert === true;
    return true;
  });

  return (
    <div className="flex flex-col">
      {/* Header */}
      <header className="flex items-end justify-between px-6 pt-6 pb-3.5 lg:pt-10">
        <div className="flex flex-col gap-1">
          <span
            className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--color-text-muted)]"
            style={{ fontFamily: mono }}
          >
            Inbox
          </span>
          <h1
            className="text-[28px] font-extrabold leading-[30px] tracking-[-0.025em] text-[var(--color-text)] lg:text-[36px] lg:leading-[38px]"
            style={{ fontFamily: display }}
          >
            Conversations
          </h1>
        </div>
        <div className="flex items-center gap-1">
          <Link
            href="/conversations/search"
            aria-label="Search"
            className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/5"
          >
            <Search className="h-5 w-5 text-[var(--color-text)]" />
          </Link>
          <Link
            href="/conversations/new"
            aria-label="New message"
            className="flex h-10 w-10 items-center justify-center rounded-full shadow-[0_4px_12px_rgba(59,130,246,0.30)]"
            style={{ background: "var(--color-signal)" }}
          >
            <Plus className="h-[18px] w-[18px] text-white" strokeWidth={2.2} />
          </Link>
        </div>
      </header>

      {/* Filter chips */}
      <div className="flex items-center gap-2 overflow-x-auto px-6 pb-4">
        <FilterChip
          label="All"
          count={total}
          active={filter === "all"}
          onClick={() => setFilter("all")}
        />
        <FilterChip
          label="Unread"
          count={unreadCount}
          badge="signal"
          active={filter === "unread"}
          onClick={() => setFilter("unread")}
        />
        <FilterChip
          label="Requests"
          count={requestCount}
          badge="signal"
          active={filter === "requests"}
          onClick={() => setFilter("requests")}
        />
        <FilterChip
          label="Alerts"
          count={alertCount}
          badge="alert"
          active={filter === "alerts"}
          onClick={() => setFilter("alerts")}
        />
      </div>

      {/* Content */}
      {filter === "requests" ? (
        requests === null ? (
          <LoadingState />
        ) : requests.length === 0 ? (
          <RequestsEmpty />
        ) : (
          <ul className="flex flex-col">
            {requests.map((c) => (
              <li key={c.conversationId}>
                <RequestRow
                  conversation={c}
                  onAccept={() => void handleAccept(c.conversationId)}
                  onDelete={() => void handleDelete(c.conversationId)}
                />
              </li>
            ))}
          </ul>
        )
      ) : conversations === null ? (
        <LoadingState />
      ) : visible.length === 0 ? (
        total === 0 ? (
          <EmptyState />
        ) : (
          <FilteredEmptyState filter={filter} onReset={() => setFilter("all")} />
        )
      ) : (
        <ul className="flex flex-col">
          {visible.map((c) => (
            <li key={c.conversationId}>
              <ConversationRow conversation={c} />
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="px-6 pt-2 text-xs text-[var(--color-alert)]">{error}</p>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────

function RequestRow({
  conversation,
  onAccept,
  onDelete,
}: {
  conversation: ConversationListItem;
  onAccept: () => void;
  onDelete: () => void;
}) {
  const { participant, lastMessage } = conversation;
  return (
    <div className="flex flex-col gap-2 border-b px-6 py-3.5" style={{ borderColor: "var(--color-hairline)" }}>
      <div className="flex items-center gap-3.5">
        <Avatar username={participant.username} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className="truncate text-[15px] font-bold tracking-[-0.01em] text-[var(--color-text)]"
            style={{ fontFamily: display }}
          >
            @{participant.username}
          </span>
          <span className="truncate text-sm text-[var(--color-text-secondary)]">
            {lastMessage?.preview ?? "wants to message you"}
          </span>
        </div>
        <span
          className="shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-[var(--color-signal)]"
          style={{
            background: "rgba(59,130,246,0.10)",
            borderColor: "rgba(59,130,246,0.30)",
            fontFamily: mono,
          }}
        >
          Request
        </span>
      </div>
      <div className="flex items-center gap-2 pl-[60px]">
        <button
          type="button"
          onClick={onAccept}
          className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-semibold text-white"
          style={{ background: "var(--color-signal)" }}
        >
          <Check className="h-3.5 w-3.5" />
          Accept
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          style={{ borderColor: "var(--color-hairline-strong)" }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </button>
      </div>
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  badge,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  badge?: "signal" | "alert";
  onClick: () => void;
}) {
  const showBadge = badge && count > 0;
  return (
    <button
      onClick={onClick}
      className="flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-2 transition-colors"
      style={{
        background: active ? "var(--color-raised)" : "transparent",
        borderColor: active
          ? "var(--color-hairline-strong)"
          : badge === "alert" && count > 0
            ? "rgba(239,68,68,0.30)"
            : "var(--color-hairline)",
      }}
      aria-pressed={active}
    >
      {badge === "alert" && count > 0 && (
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: "var(--color-alert)", boxShadow: "0 0 8px rgba(239,68,68,0.6)" }}
        />
      )}
      <span
        className="text-[13px]"
        style={{
          color: active
            ? "var(--color-text)"
            : badge === "alert" && count > 0
              ? "#FCA5A5"
              : "var(--color-text-secondary)",
          fontWeight: active ? 600 : 500,
        }}
      >
        {label}
      </span>
      {showBadge ? (
        <span
          className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5"
          style={{
            background: badge === "alert" ? "transparent" : "var(--color-signal)",
            color: badge === "alert" ? "#FCA5A5" : "#fff",
            fontFamily: mono,
            fontSize: 10,
            fontWeight: 700,
          }}
        >
          {count}
        </span>
      ) : (
        <span
          className="text-[11px] text-[var(--color-text-secondary)]"
          style={{ fontFamily: mono }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function LoadingState() {
  return (
    <ul className="flex flex-col">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="flex items-center gap-3.5 px-6 py-3">
          <div className="h-12 w-12 shrink-0 animate-pulse rounded-full bg-white/5" />
          <div className="flex flex-1 flex-col gap-2">
            <div className="h-3.5 w-24 animate-pulse rounded bg-white/5" />
            <div className="h-3 w-3/5 animate-pulse rounded bg-white/5" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-20 text-center">
      <div
        className="flex h-16 w-16 items-center justify-center rounded-2xl border"
        style={{
          background: "rgba(59,130,246,0.08)",
          borderColor: "rgba(59,130,246,0.20)",
        }}
      >
        <Plus className="h-6 w-6" style={{ color: "var(--color-signal)" }} />
      </div>
      <div className="flex flex-col gap-2">
        <h2
          className="text-[22px] font-extrabold tracking-[-0.02em] text-[var(--color-text)]"
          style={{ fontFamily: display }}
        >
          No conversations yet
        </h2>
        <p className="max-w-[300px] text-sm leading-5 text-[var(--color-text-secondary)]">
          Start a thread with someone by their username. Messages stay between the two of you.
        </p>
      </div>
      <Button asChild size="md">
        <Link href="/conversations/new">
          Start your first conversation
        </Link>
      </Button>
    </div>
  );
}

function RequestsEmpty() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <p className="text-sm text-[var(--color-text-secondary)]">No message requests.</p>
    </div>
  );
}

function FilteredEmptyState({ filter, onReset }: { filter: Filter; onReset: () => void }) {
  const label = filter === "unread" ? "unread messages" : "capture alerts";
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <p className="text-sm text-[var(--color-text-secondary)]">No {label} right now.</p>
      <button
        onClick={onReset}
        className="text-sm font-medium text-[var(--color-signal)] hover:underline"
      >
        Show all
      </button>
    </div>
  );
}
