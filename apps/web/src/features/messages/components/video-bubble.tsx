"use client";

// VideoBubble (Phase 6B — 6B.9 feed rules, 6B.10 fullscreen quality, 6B.19
// progressive loading). In the feed we never stream the original: we show the
// poster (or chat thumbnail) immediately and, on tap, play the bandwidth-safe
// optimized/passthrough `streamUrl`. The high-quality `url` (LSS/original) is
// reserved for an explicit fullscreen/download action. While the worker is
// still transcoding (status === "processing", no streamUrl yet) we show the
// poster with a processing overlay rather than a dead play button.
import { useState } from "react";
import { Play, Loader2 } from "lucide-react";
import { cn } from "@/frontend-core/utils";
import type { VideoAttachment } from "@relay/contracts";
import { LssBadge } from "./lss-badge";

const W     = 280;   // long-edge cap
const MAX_H = 420;   // keep tall portrait clips from dominating the thread

function fmtDuration(ms: number | null): string | null {
  if (ms == null) return null;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function VideoBubble({ attachment, isMine }: { attachment: VideoAttachment; isMine: boolean }) {
  const [playing, setPlaying] = useState(false);
  // The container is sized from the *rendered* media's aspect ratio, not the
  // stored dims — ffprobe can report encoded (pre-rotation) dimensions, so a
  // portrait clip stored as landscape would otherwise pillarbox. We seed from
  // stored dims, then correct from the poster's natural size once it loads.
  const { media } = attachment;
  const [aspect, setAspect] = useState<number | null>(
    media.width && media.height ? media.width / media.height : null,
  );
  const poster   = media.posterUrl ?? media.thumbUrl ?? null;
  const stream   = media.streamUrl ?? null;
  const ready    = media.status !== "processing" && media.status !== "failed" && !!stream;
  const failed   = media.status === "failed";
  const duration = fmtDuration(media.durationMs ?? null);
  const corner   = isMine ? "rounded-br-[6px]" : "rounded-bl-[6px]";

  // Fit within W×MAX_H preserving aspect (width/height). Fallback 16:9.
  const ar = aspect && aspect > 0 ? aspect : 16 / 9;
  let width = W, height = Math.round(W / ar);
  if (height > MAX_H) { height = MAX_H; width = Math.round(MAX_H * ar); }

  return (
    <div
      className={cn("relative overflow-hidden rounded-[18px]", corner)}
      style={{ width, height, background: "var(--color-raised)" }}
    >
      {playing && ready ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          src={stream!}
          poster={poster ?? undefined}
          controls
          autoPlay
          playsInline
          className="absolute inset-0 h-full w-full bg-black object-contain"
        />
      ) : (
        <>
          {poster ? (
            <img
              src={poster}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
              draggable={false}
              onLoad={(e) => {
                const el = e.currentTarget;
                if (el.naturalWidth && el.naturalHeight) setAspect(el.naturalWidth / el.naturalHeight);
              }}
            />
          ) : (
            <div className="absolute inset-0 animate-pulse" style={{ background: "var(--color-raised)" }} />
          )}

          {/* Center control: play when ready, spinner while processing */}
          <div className="absolute inset-0 flex items-center justify-center">
            {ready ? (
              <button
                type="button"
                onClick={() => setPlaying(true)}
                aria-label="Play video"
                className="flex h-14 w-14 items-center justify-center rounded-full transition-transform hover:scale-105"
                style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }}
              >
                <Play className="h-6 w-6 translate-x-0.5 fill-white text-white" />
              </button>
            ) : failed ? (
              <span className="rounded-full bg-black/55 px-3 py-1 text-[11px] text-white">Processing failed</span>
            ) : (
              <div className="flex items-center gap-2 rounded-full bg-black/55 px-3 py-1.5 text-[11px] text-white">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Processing…
              </div>
            )}
          </div>

          {/* Duration chip */}
          {duration && (
            <span
              className="absolute bottom-2 right-2 rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium text-white"
              style={{ background: "rgba(0,0,0,0.6)", fontFamily: "var(--font-mono)" }}
            >
              {duration}
            </span>
          )}

          {media.isLss && <LssBadge className="absolute left-2 top-2" />}
        </>
      )}
    </div>
  );
}
