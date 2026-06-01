"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

// Phase 6E: full-screen one-shot viewer for ephemeral media. Opened with the
// short-lived URL returned by POST /media/:id/view (the view is already counted
// server-side by the time this renders). Handles both image and video so it
// covers view-once photos and videos with one component.
type Props = {
  url:     string;
  type:    "image" | "video";
  onClose: () => void;
};

export function EphemeralViewer({ url, type, onClose }: Props) {
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
      className="fixed inset-0 z-[130] flex items-center justify-center"
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
      {type === "video" ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          src={url}
          controls
          autoPlay
          playsInline
          className="max-h-[90vh] max-w-[92vw] rounded-[12px] object-contain"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <img
          src={url}
          alt=""
          className="max-h-[90vh] max-w-[92vw] rounded-[12px] object-contain"
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>,
    document.body,
  );
}
