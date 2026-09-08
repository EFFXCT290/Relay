"use client";

import { useEffect, useState } from "react";
import { Eye, Timer as TimerIcon } from "lucide-react";
import { cn } from "@/frontend-core/utils";
import type { Message } from "@relay/contracts";

// Text-message counterpart to ephemeral-media-card.tsx's EphemeralMediaCard —
// same locked-card visual language (eye icon, "Tap to view", non-interactive
// status line for the sender), reused per the original scoping rather than a
// visually distinct control. The consumed/tombstone state needs no branch
// here: once the message is soft-deleted, MessageBubble's existing
// `if (message.isDeleted)` check already intercepts before this ever renders.
//
// `message.body` is the source of truth for "revealed": the server withholds
// it from every normal read path for a "views"-mode message (see
// messages.contract.ts), so a non-null body here only ever came from this
// session's own POST /messages/:id/view response, or — for the sender's own
// just-sent message — the optimistic echo that was never nulled locally
// (see page.tsx's handleSend). Reload the page and it locks again for
// everyone, sender included — same as the sender being forbidden from
// re-opening their own ephemeral media.
const baseClass =
  "flex items-center gap-2.5 rounded-[18px] px-4 py-3 text-[13px] font-medium select-none";

function cardStyle(): React.CSSProperties {
  return {
    background: "var(--color-raised)",
    color:      "var(--color-text-secondary)",
    border:     "1px solid rgba(255,255,255,0.08)",
    minWidth:   190,
  };
}

export function DisappearCard({
  message,
  isMine,
  onView,
}: {
  message: Message;
  isMine:  boolean;
  onView?: (messageId: string) => void;
}) {
  const d = message.disappear;
  if (!d || d.mode !== "views" || d.viewLimit == null) return null;

  const remaining  = Math.max(0, d.viewLimit - d.viewCount);
  const limitLabel = d.viewLimit === 1 ? "View once" : `${d.viewLimit} views`;

  // Revealed this session — show the real text. Non-interactive: re-spending
  // a look is a deliberate re-tap after it locks again (reload), not a
  // second click on the same reveal.
  if (message.body != null) {
    return (
      <div
        className={cn(
          "flex flex-col gap-1 rounded-[22px] px-3.5 py-2.5 text-[15px] leading-[21px]",
          isMine ? "rounded-br-[6px]" : "rounded-bl-[6px]",
        )}
        style={{
          background: isMine ? "var(--color-bubble-sent)" : "var(--color-bubble-received)",
          color:      isMine ? "var(--color-bubble-sent-text)" : "var(--color-text)",
          border:     isMine ? undefined : "1px solid rgba(255,255,255,0.04)",
          whiteSpace: "pre-wrap",
          wordBreak:  "break-word",
        }}
      >
        {message.body}
        <span
          className="flex items-center gap-1 self-start text-[10px] opacity-70"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <Eye className="h-3 w-3" />
          {d.viewLimit === 1 ? "View once" : `${d.viewCount}/${d.viewLimit} opened`}
        </span>
      </div>
    );
  }

  // Sender can't spend a view on their own message — status line only.
  if (isMine) {
    return (
      <div className={cn(baseClass, "rounded-br-[6px]")} style={cardStyle()}>
        <Eye className="h-4 w-4 opacity-60" />
        <span>
          {limitLabel}
          {d.viewCount > 0 ? ` · Opened ${d.viewCount}/${d.viewLimit}` : ""}
        </span>
      </div>
    );
  }

  // Recipient: locked, tap to view.
  return (
    <button
      type="button"
      onClick={() => onView?.(message.messageId)}
      className={cn(baseClass, "rounded-bl-[6px] cursor-pointer transition-colors hover:brightness-125")}
      style={{ ...cardStyle(), color: "var(--color-text)", borderColor: "var(--color-signal)" }}
      aria-label="Tap to view message"
    >
      <Eye className="h-4 w-4" style={{ color: "var(--color-signal)" }} />
      <span>Tap to view · {remaining} left</span>
    </button>
  );
}

// Small, unobtrusive "time"-mode indicator — an icon + coarse remaining time.
// Body stays visible normally (see DisappearCard above); this just tells both
// sides it's going to disappear and roughly when. Own interval per-bubble
// rather than driving a page-wide re-render — every mounted countdown ticks
// independently and there's no need to be second-accurate (30s cadence).
export function DisappearTimer({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const remainingMs = new Date(expiresAt).getTime() - now;
  // At/past zero it's about to be swept server-side — the live
  // message:deleted broadcast will remove it momentarily; avoid flashing a
  // "0s"/negative label in the meantime.
  if (remainingMs <= 0) return null;

  return (
    <span
      className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]"
      style={{ fontFamily: "var(--font-mono)" }}
      title="This message will disappear"
    >
      <TimerIcon className="h-3 w-3" />
      {formatRemaining(remainingMs)}
    </span>
  );
}

function formatRemaining(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.ceil(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.ceil(h / 24);
  return `${d}d`;
}
