"use client";

import { useState } from "react";
import { cn } from "@/frontend-core/utils";
import type { ImageAttachment } from "@relay/contracts";
import { useInViewport } from "@/shared/hooks/use-in-viewport";

const MAX_W = 280;
const MAX_H = 360;

function clampDimensions(w?: number | null, h?: number | null) {
  if (!w || !h) return { width: MAX_W, height: MAX_H };
  const ratio = w / h;
  if (ratio > MAX_W / MAX_H) {
    return { width: MAX_W, height: Math.round(MAX_W / ratio) };
  }
  return { width: Math.round(MAX_H * ratio), height: MAX_H };
}

type Props = {
  attachment:      ImageAttachment;
  isMine:          boolean;
  onOpenLightbox?: (attachment: ImageAttachment) => void;
};

export function ImageBubble({ attachment, isMine, onOpenLightbox }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [error,  setError]  = useState(false);
  const { ref: containerRef, visible } = useInViewport<HTMLDivElement>();

  // Use thumb dimensions for clamping when available — they reflect the actual
  // displayed asset size, preventing layout shifts on images that weren't
  // downscaled (e.g. small originals where thumb === original dimensions).
  const { width, height } = clampDimensions(
    attachment.media.thumbWidth  ?? attachment.media.width,
    attachment.media.thumbHeight ?? attachment.media.height,
  );
  const blurUrl = attachment.media.blurUrl;
  // Thumb is the displayed asset in chat; original is reserved for lightbox.
  const chatSrc = attachment.media.thumbUrl ?? attachment.media.url;

  const inner = (
    <div
      ref={containerRef}
      className={cn(
        "relative overflow-hidden rounded-[18px]",
        isMine ? "rounded-br-[6px]" : "rounded-bl-[6px]",
        onOpenLightbox && loaded && !error && "cursor-zoom-in",
      )}
      style={{ width, height: loaded ? undefined : height }}
    >
      {/* Placeholder layer: blur if available, else pulsing block. */}
      {!loaded && !error && (
        blurUrl ? (
          <img
            src={blurUrl}
            alt=""
            aria-hidden
            className="absolute inset-0 h-full w-full scale-110 object-cover blur-md"
            style={{ width, height }}
          />
        ) : (
          <div
            className="absolute inset-0 animate-pulse"
            style={{ background: "var(--color-raised)", width, height }}
          />
        )
      )}
      {!error ? (
        <img
          src={visible ? chatSrc : undefined}
          alt=""
          width={width}
          className={cn(
            "block h-auto w-full object-cover transition-opacity duration-300",
            loaded ? "opacity-100" : "opacity-0",
          )}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          draggable={false}
        />
      ) : (
        <div
          className="flex items-center justify-center p-4 text-xs"
          style={{
            width,
            height,
            color:      "var(--color-text-muted)",
            background: "var(--color-raised)",
          }}
        >
          Image unavailable
        </div>
      )}
    </div>
  );

  if (onOpenLightbox && loaded && !error) {
    return (
      <button
        type="button"
        onClick={() => onOpenLightbox(attachment)}
        aria-label="View image"
        className="block appearance-none border-0 bg-transparent p-0"
      >
        {inner}
      </button>
    );
  }

  return inner;
}
