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

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[18px]",
        isMine ? "rounded-br-[6px]" : "rounded-bl-[6px]",
      )}
      style={{ width, height: loaded ? undefined : height }}
    >
      {!loaded && !error && (
        <div
          className="absolute inset-0 animate-pulse"
          style={{ background: "var(--color-raised)", width, height }}
        />
      )}
      {!error ? (
        <img
          src={attachment.media.url}
          alt=""
          width={width}
          className="block h-auto w-full object-cover"
          style={{ display: loaded ? "block" : "none" }}
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
