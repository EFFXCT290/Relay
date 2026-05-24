"use client";

import { useState } from "react";
import { cn } from "@/frontend-core/utils";
import type { MessageAttachment } from "@relay/contracts";

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
  attachment: MessageAttachment;
  isMine: boolean;
};

export function ImageBubble({ attachment, isMine }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [error,  setError]  = useState(false);

  const { width, height } = clampDimensions(attachment.media.width, attachment.media.height);
  const blurUrl = attachment.media.blurUrl;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[18px]",
        isMine ? "rounded-br-[6px]" : "rounded-bl-[6px]",
      )}
      style={{ width, height: loaded ? undefined : height }}
    >
      {/* Placeholder layer: blur image if we have one, else a pulsing block.
          Always painted underneath; the original fades in on top of it. */}
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
          src={attachment.media.url}
          alt=""
          width={width}
          className={cn(
            "block h-auto w-full object-cover transition-opacity duration-300",
            loaded ? "opacity-100" : "opacity-0",
          )}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
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
}
