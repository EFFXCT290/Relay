"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
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
  const [index, setIndex] = useState(state.index);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  const total      = state.images.length;
  const attachment = state.images[index];
  const hasPrev    = index > 0;
  const hasNext    = index < total - 1;

  const prev = () => setIndex((i) => Math.max(0, i - 1));
  const next = () => setIndex((i) => Math.min(total - 1, i + 1));

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Keyboard: ESC closes, ← → navigates.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape")     closeRef.current();
      if (e.key === "ArrowLeft")  setIndex((i) => Math.max(0, i - 1));
      if (e.key === "ArrowRight") setIndex((i) => Math.min(total - 1, i + 1));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [total]);

  // Preload adjacent originals in the background so swipes feel instant.
  useEffect(() => {
    const urls = [
      state.images[index - 1]?.media.url,
      state.images[index + 1]?.media.url,
    ].filter((u): u is string => !!u);
    const imgs = urls.map((url) => {
      const img = new window.Image();
      img.src = url;
      return img;
    });
    return () => { imgs.forEach((img) => { img.src = ""; }); };
  }, [index, state.images]);

  if (!attachment) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{
        paddingTop:    "env(safe-area-inset-top, 16px)",
        paddingBottom: "env(safe-area-inset-bottom, 16px)",
        paddingLeft:   "env(safe-area-inset-left,  16px)",
        paddingRight:  "env(safe-area-inset-right, 16px)",
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
        style={{ background: "rgba(255,255,255,0.1)", color: "#fff", backdropFilter: "blur(8px)" }}
      >
        <X className="h-5 w-5" />
      </button>

      {/* Counter — only when multiple images */}
      {total > 1 && (
        <div
          className="absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-full px-3 py-1 text-sm font-medium text-white"
          style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(8px)" }}
        >
          {index + 1} / {total}
        </div>
      )}

      {/* Image centred over backdrop */}
      <div className="relative z-10 flex items-center justify-center">
        <LightboxImage attachment={attachment} />
      </div>

      {/* Prev / next buttons */}
      {total > 1 && (
        <>
          <button
            type="button"
            onClick={prev}
            disabled={!hasPrev}
            aria-label="Previous image"
            className="absolute left-4 top-1/2 z-10 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full transition-opacity disabled:opacity-0"
            style={{ background: "rgba(255,255,255,0.1)", color: "#fff", backdropFilter: "blur(8px)" }}
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            type="button"
            onClick={next}
            disabled={!hasNext}
            aria-label="Next image"
            className="absolute right-4 top-1/2 z-10 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full transition-opacity disabled:opacity-0"
            style={{ background: "rgba(255,255,255,0.1)", color: "#fff", backdropFilter: "blur(8px)" }}
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
