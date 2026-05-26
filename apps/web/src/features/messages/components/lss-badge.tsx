// LSS badge (Phase 6B / 6B.11). WhatsApp-HD-style overlay shown on thumbnails,
// grid tiles, and the fullscreen header when an attachment was sent as LSS
// ("Lossless Sanitized" — original quality preserved). Driven solely by the
// `isLss` flag on the attachment media, so it stays consistent across image and
// video and is absent for legacy/pre-6B media.
import { cn } from "@/frontend-core/utils";

export function LssBadge({ className, size = "sm" }: { className?: string; size?: "sm" | "md" }) {
  return (
    <span
      className={cn(
        "pointer-events-none inline-flex select-none items-center rounded-[5px] font-semibold uppercase tracking-[0.08em] text-white",
        size === "sm" ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-1 text-[11px]",
        className,
      )}
      style={{
        fontFamily: "var(--font-mono)",
        background: "rgba(0,0,0,0.62)",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.22)",
        backdropFilter: "blur(4px)",
      }}
      aria-label="Original quality (LSS)"
      title="Sent in original quality (LSS)"
    >
      LSS
    </span>
  );
}
