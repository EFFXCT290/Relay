"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { MessageAttachment } from "@relay/contracts";
import { LightboxBackdrop } from "./lightbox-backdrop";
import { LightboxImage } from "./lightbox-image";

export type LightboxState = {
  images: MessageAttachment[];
  index:  number;
};

type Props = {
  state:   LightboxState;
  onClose: () => void;
};

export function ImageLightbox({ state, onClose }: Props) {
  const attachment = state.images[state.index];
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Keyboard: ESC closes, ← → reserved for future gallery nav.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!attachment) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{
        // Safe-area padding for notch/home-indicator on iOS.
        paddingTop:    "env(safe-area-inset-top, 16px)",
        paddingBottom: "env(safe-area-inset-bottom, 16px)",
        paddingLeft:   "env(safe-area-inset-left,  16px)",
        paddingRight:  "env(safe-area-inset-right, 16px)",
        // Allow vertical pan so iOS overscroll doesn't fight the modal.
        touchAction: "pan-y",
        animation: "lbFadeIn 0.18s ease-out both",
      }}
    >
      <style>{`
        @keyframes lbFadeIn {
          from { opacity: 0; transform: scale(0.96); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>

      <LightboxBackdrop onClick={onClose} />

      {/* Close button */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full"
        style={{
          background: "rgba(255,255,255,0.1)",
          color: "#fff",
          backdropFilter: "blur(8px)",
        }}
      >
        <X className="h-5 w-5" />
      </button>

      {/* Image centred over backdrop */}
      <div className="relative z-10 flex items-center justify-center">
        <LightboxImage attachment={attachment} />
      </div>
    </div>,
    document.body,
  );
}
