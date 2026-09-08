"use client";

import { useEffect, useState } from "react";
import { Eye, Timer as TimerIcon } from "lucide-react";
import { cn } from "@/frontend-core/utils";
import type { Message } from "@relay/contracts";

// Text-message counterpart to ephemeral-media-card.tsx's EphemeralMediaCard —
// same locked-card visual language (eye icon, "Tap to view", non-interactive
// status line for the sender) and the same split as ephemeral-media-card.tsx
// / ephemeral-viewer.tsx: this file renders the bubble-level card; opening it
// hands off to DisappearModal (disappear-modal.tsx), which mirrors
// EphemeralViewer's full-screen interaction exactly.
//
// Both modes render as a card here — never inline text. `message.body`
// becoming non-null (views: never via a normal read path; time: only after
// the recipient's first explicit open, per messages.contract.ts) is NOT what
// gates this card's own display; the card only ever reflects `disappear`
// metadata (mode/counts/expiresAt). Actual content is shown exclusively by
// the modal, which holds its own snapshot from the open response — decoupled
// from this card and from the reactive message-list state entirely, so a
// live message:deleted/message:disappear:progress broadcast racing in right
// after an open can never retroactively hide content already being shown
// (see page.tsx's handleViewDisappear for the full story on why that
// decoupling is load-bearing, not just tidy).
//
// The consumed/tombstone state (views mode, budget spent) needs no branch
// here: once the message is soft-deleted, MessageBubble's existing
// `if (message.isDeleted)` check already intercepts before this ever renders.
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

// Shared by the card's own small badge and the modal's more prominent
// display — one ticking source of truth for "how long is left," each
// mounting its own interval so neither depends on a page-wide re-render.
export function useCountdownLabel(expiresAt: string | null | undefined, intervalMs = 30_000): string | null {
  const [now, setNow] = useState(() => Date.now());

  // Refresh `now` the instant a new deadline arrives (mount, or expiresAt
  // going from null to set on the clock's first start), not just on the
  // next interval tick — otherwise `now` stays pinned to whenever this
  // card/modal instance first mounted (often well before the clock ever
  // started), and the resulting stale gap gets fed into the ceil()s below,
  // rounding the displayed minutes up by one until the next 30s tick
  // happens to correct it.
  useEffect(() => {
    if (!expiresAt) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [expiresAt, intervalMs]);

  if (!expiresAt) return null;
  const remainingMs = new Date(expiresAt).getTime() - now;
  // At/past zero it's about to be swept server-side — the live
  // message:deleted broadcast removes it momentarily; avoid flashing a
  // "0s"/negative label in the meantime.
  if (remainingMs <= 0) return null;
  return formatRemaining(remainingMs);
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

export function DisappearCard({
  message,
  isMine,
  onOpen,
}: {
  message: Message;
  isMine:  boolean;
  onOpen?: (messageId: string) => void;
}) {
  const d = message.disappear;
  const countdown = useCountdownLabel(d?.mode === "time" ? d.expiresAt : null);
  if (!d) return null;

  if (d.mode === "views") {
    const remaining  = Math.max(0, (d.viewLimit ?? 0) - d.viewCount);
    const limitLabel = d.viewLimit === 1 ? "View once" : `${d.viewLimit} views`;

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

    // Recipient: locked, tap to open the modal (spends a look).
    return (
      <button
        type="button"
        onClick={() => onOpen?.(message.messageId)}
        className={cn(baseClass, "rounded-bl-[6px] cursor-pointer transition-colors hover:brightness-125")}
        style={{ ...cardStyle(), color: "var(--color-text)", borderColor: "var(--color-signal)" }}
        aria-label="Tap to view message"
      >
        <Eye className="h-4 w-4" style={{ color: "var(--color-signal)" }} />
        <span>Tap to view · {remaining} left</span>
      </button>
    );
  }

  // TIME mode. The clock hasn't started until d.expiresAt is set (the
  // recipient's first explicit open) — before that, no countdown anywhere,
  // per the design: the message just waits.
  const started = d.expiresAt != null;

  // Sender can't start the clock or open their own message either — status
  // line only, same exclusion as views mode.
  if (isMine) {
    return (
      <div className={cn(baseClass, "rounded-br-[6px]")} style={cardStyle()}>
        <TimerIcon className="h-4 w-4 opacity-60" />
        <span>{started && countdown ? `Disappearing in ${countdown}` : "Waiting to be opened"}</span>
      </div>
    );
  }

  // Recipient: always tappable — reopening is free (doesn't restart the
  // clock, doesn't consume anything) — so unlike views mode this card never
  // becomes permanently locked-out while the message is still alive.
  return (
    <button
      type="button"
      onClick={() => onOpen?.(message.messageId)}
      className={cn(baseClass, "rounded-bl-[6px] cursor-pointer transition-colors hover:brightness-125")}
      style={{ ...cardStyle(), color: "var(--color-text)", borderColor: "var(--color-signal)" }}
      aria-label="Tap to open message"
    >
      <TimerIcon className="h-4 w-4" style={{ color: "var(--color-signal)" }} />
      <span>{started && countdown ? `Tap to view · ${countdown} left` : "Tap to open"}</span>
    </button>
  );
}
