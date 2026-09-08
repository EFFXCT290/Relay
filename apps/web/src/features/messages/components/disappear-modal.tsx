"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X, Timer as TimerIcon } from "lucide-react";
import { useCountdownLabel } from "./disappear-card";

// Text-message counterpart to ephemeral-viewer.tsx's EphemeralViewer — same
// full-screen interaction chrome (portal, dark backdrop, X to close, Escape
// closes, backdrop click closes, body-scroll-lock) mirrored deliberately
// rather than building a visually distinct control, per the original
// scoping. The one real difference from EphemeralViewer: this modal shows a
// SNAPSHOT of the open response (`body`, `expiresAt`) passed in at open
// time — it never re-reads the message from the live list afterward. That's
// what makes closing (X) freely reopenable for "time" mode (reopening just
// calls POST /view again and gets a fresh snapshot, never restarting the
// clock server-side) and what stops a live message:deleted broadcast from
// racing ahead of — and hiding — content the recipient's own open response
// already delivered (see page.tsx's handleViewDisappear).
type Props = {
  mode:      "views" | "time";
  body:      string;
  expiresAt?: string | null; // time mode only
  onClose:   () => void;
};

export function DisappearModal({ mode, body, expiresAt, onClose }: Props) {
  const countdown = useCountdownLabel(mode === "time" ? expiresAt : null, 1_000);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center px-6"
      style={{ background: "rgba(6,8,12,0.97)", backdropFilter: "blur(8px)" }}
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-[calc(env(safe-area-inset-top)+12px)] flex h-10 w-10 items-center justify-center rounded-full text-white/80 hover:text-white"
        style={{ background: "rgba(255,255,255,0.08)" }}
      >
        <X className="h-5 w-5" />
      </button>

      <div
        className="flex max-h-[80vh] w-full max-w-[420px] flex-col gap-4 rounded-[16px] p-6"
        style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <p
          className="overflow-y-auto whitespace-pre-wrap break-words text-[17px] leading-6 text-white"
        >
          {body}
        </p>
        {mode === "time" && countdown && (
          <span className="flex items-center gap-1.5 self-start rounded-full px-3 py-1.5 text-[12px] font-medium text-white/80" style={{ background: "rgba(255,255,255,0.08)" }}>
            <TimerIcon className="h-3.5 w-3.5" />
            Disappears in {countdown}
          </span>
        )}
      </div>
    </div>,
    document.body,
  );
}
