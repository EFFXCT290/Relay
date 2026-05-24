"use client";

import { cn } from "@/frontend-core/utils";
import { Loader2 } from "lucide-react";

const MAX_W = 280;
const MAX_H = 360;

function clampDimensions(w?: number, h?: number) {
  if (!w || !h) return { width: MAX_W, height: MAX_H };
  const ratio = w / h;
  if (ratio > MAX_W / MAX_H) {
    return { width: MAX_W, height: Math.round(MAX_W / ratio) };
  }
  return { width: Math.round(MAX_H * ratio), height: MAX_H };
}

type Props = {
  blobUrl: string;
  status:  "uploading" | "sending";
  isMine:  boolean;
  width?:  number;
  height?: number;
};

export function UploadPreview({ blobUrl, status, isMine, width, height }: Props) {
  const dims = clampDimensions(width, height);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[18px]",
        isMine ? "rounded-br-[6px]" : "rounded-bl-[6px]",
      )}
      style={{ width: dims.width, height: dims.height }}
    >
      <img
        src={blobUrl}
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
        style={{ opacity: status === "uploading" ? 0.55 : 0.75 }}
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-white drop-shadow-[0_1px_4px_rgba(0,0,0,0.6)]" />
      </div>
    </div>
  );
}
