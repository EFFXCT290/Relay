import Link from "next/link";
import { Video } from "lucide-react";
import { Avatar } from "@/shared/components/avatar";
import { cn } from "@/frontend-core/utils";
import { formatLastSeen } from "@/frontend-core/format-presence";
import type { ConversationListItem } from "@relay/contracts";

export type { ConversationListItem };  // re-export so prior consumers via this path keep working

const mono = "var(--font-mono)";
const display = "var(--font-display)";

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
  }
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diffDays < 7) {
    return d.toLocaleDateString([], { weekday: "short" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function ConversationRow({ conversation }: { conversation: ConversationListItem }) {
  const { participant, lastMessage, unreadCount, isTyping, captureAlert } = conversation;
  const hasUnread = (unreadCount ?? 0) > 0;

  return (
    <Link
      href={`/conversations/${conversation.conversationId}`}
      className={cn(
        "group flex items-center gap-3.5 px-6 py-3 transition-colors hover:bg-white/[0.02]",
        captureAlert &&
          "border-l-2 border-[var(--color-alert)] bg-gradient-to-r from-[rgba(239,68,68,0.06)] to-transparent",
      )}
    >
      <Avatar
        username={participant.username}
        isOnline={participant.isOnline}
        hasAlert={captureAlert}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span
            className="truncate text-[16px] font-bold tracking-[-0.01em] text-[var(--color-text)]"
            style={{ fontFamily: display }}
          >
            @{participant.username}
          </span>
          {captureAlert && (
            <span
              className="shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em]"
              style={{
                color: "#FCA5A5",
                background: "rgba(239,68,68,0.12)",
                borderColor: "rgba(239,68,68,0.30)",
                fontFamily: mono,
              }}
            >
              Capture
            </span>
          )}
          {!captureAlert && participant.isOnline !== undefined && (
            <span
              className="shrink-0 text-[10px]"
              style={{
                color: participant.isOnline ? "var(--color-online)" : "var(--color-text-muted)",
                fontFamily: mono,
              }}
            >
              {formatLastSeen(participant.lastSeenAt, participant.isOnline)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {isTyping ? (
            <TypingPreview />
          ) : lastMessage ? (
            <PreviewLine lastMessage={lastMessage} muted={!hasUnread} alert={captureAlert} />
          ) : (
            <span className="truncate text-sm text-[var(--color-text-muted)]">No messages yet</span>
          )}
        </div>
      </div>

      <div className="flex w-[52px] shrink-0 flex-col items-end gap-1.5">
        <span
          className="text-[11px]"
          style={{
            color: hasUnread || isTyping ? "var(--color-signal)" : "var(--color-text-secondary)",
            fontFamily: mono,
          }}
        >
          {isTyping ? "now" : formatTime(conversation.updatedAt)}
        </span>
        {hasUnread ? (
          <span
            className="flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5"
            style={{ background: "var(--color-signal)" }}
          >
            <span
              className="text-[11px] font-bold text-white"
              style={{ fontFamily: mono }}
            >
              {unreadCount}
            </span>
          </span>
        ) : captureAlert ? (
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{
              background: "var(--color-alert)",
              boxShadow: "0 0 6px rgba(239,68,68,0.7)",
            }}
          />
        ) : null}
      </div>
    </Link>
  );
}

function PreviewLine({
  lastMessage,
  muted,
  alert,
}: {
  lastMessage: NonNullable<ConversationListItem["lastMessage"]>;
  muted: boolean;
  alert?: boolean;
}) {
  if (lastMessage.type !== "TEXT") {
    return (
      <span className="flex items-center gap-1.5 truncate text-sm text-[var(--color-text-secondary)]">
        <Video className="h-3 w-3 shrink-0" />
        {lastMessage.preview ?? `${lastMessage.type.toLowerCase()} message`}
      </span>
    );
  }
  return (
    <span
      className="truncate text-sm"
      style={{
        color: alert
          ? "#FCA5A5"
          : muted
            ? "var(--color-text-secondary)"
            : "var(--color-text)",
      }}
    >
      {lastMessage.preview ?? ""}
    </span>
  );
}

function TypingPreview() {
  return (
    <span className="flex items-center gap-2">
      <span className="flex items-center gap-[3px]">
        <span className="relay-typing-dot h-1 w-1 rounded-full" style={{ background: "rgba(59,130,246,0.45)" }} />
        <span className="relay-typing-dot h-1 w-1 rounded-full" style={{ background: "rgba(59,130,246,0.70)" }} />
        <span className="relay-typing-dot h-1 w-1 rounded-full" style={{ background: "rgba(59,130,246,0.95)" }} />
      </span>
      <span className="text-sm italic text-[var(--color-signal)]">typing…</span>
    </span>
  );
}

