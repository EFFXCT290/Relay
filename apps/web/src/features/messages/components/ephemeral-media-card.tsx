"use client";

import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/frontend-core/utils";
import type { ImageAttachment, VideoAttachment } from "@relay/contracts";

// Phase 6E: ephemeral media renders as a locked card — never a preview (a
// thumbnail would leak the content). Tapping it (recipient only) mints a
// short-lived URL via POST /media/:id/view and opens the full-screen viewer.
// The sender sees a status line and can't re-open. Once consumed it becomes a
// "Viewed"/"Opened" tombstone for both sides.
type Props = {
  attachment: ImageAttachment | VideoAttachment;
  isMine:     boolean;
  onView?:    (attachment: ImageAttachment | VideoAttachment) => void;
};

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

export function EphemeralMediaCard({ attachment, isMine, onView }: Props) {
  const eph = attachment.media.ephemeral;
  if (!eph) return null;

  const consumed   = eph.consumedAt != null || eph.viewCount >= eph.maxViews;
  const remaining  = Math.max(0, eph.maxViews - eph.viewCount);
  const kind       = attachment.type === "video" ? "video" : "photo";
  const limitLabel = eph.maxViews === 1 ? "View once" : `${eph.maxViews} views`;

  // Consumed → tombstone for everyone.
  if (consumed) {
    return (
      <div className={cn(baseClass, isMine ? "rounded-br-[6px]" : "rounded-bl-[6px]")} style={cardStyle()}>
        <EyeOff className="h-4 w-4 opacity-60" />
        <span>{isMine ? "Opened" : "Viewed"}</span>
      </div>
    );
  }

  // Sender can't spend a view on their own media — show a status line only.
  if (isMine) {
    return (
      <div className={cn(baseClass, "rounded-br-[6px]")} style={cardStyle()}>
        <Eye className="h-4 w-4 opacity-60" />
        <span>
          {limitLabel}
          {eph.viewCount > 0 ? ` · Opened ${eph.viewCount}/${eph.maxViews}` : ""}
        </span>
      </div>
    );
  }

  // Recipient: locked, tap to view.
  return (
    <button
      type="button"
      onClick={() => onView?.(attachment)}
      className={cn(baseClass, "rounded-bl-[6px] cursor-pointer transition-colors hover:brightness-125")}
      style={{ ...cardStyle(), color: "var(--color-text)", borderColor: "var(--color-signal)" }}
      aria-label={`View ${kind}`}
    >
      <Eye className="h-4 w-4" style={{ color: "var(--color-signal)" }} />
      <span>Tap to view {kind} · {remaining} left</span>
    </button>
  );
}
