"use client";

import { useState } from "react";
import { cn } from "@/frontend-core/utils";
import type { ImageAttachment } from "@relay/contracts";
import { useInViewport } from "@/shared/hooks/use-in-viewport";
import { ImageBubble } from "./image-bubble";

const GAP    = 2;
const W      = 280;
const HALF_W = Math.floor((W - GAP) / 2);            // 139
const BIG_W  = Math.floor((W - GAP) * (2 / 3));      // 185
const SM_W   = W - GAP - BIG_W;                       // 93
const H2     = 160;                                    // 2-col tile height
const H3_BIG = 200;                                    // 3-image tall tile
const H3_SM  = Math.floor((H3_BIG - GAP) / 2);        // 99 — each small
const H4     = HALF_W;                                 // 139 — square-ish

type Props = {
  attachments:     ImageAttachment[];
  isMine:          boolean;
  onOpenLightbox?: (attachments: ImageAttachment[], index: number) => void;
};

export function ImageGrid({ attachments, isMine, onOpenLightbox }: Props) {
  if (attachments.length === 0) return null;

  const open = (idx: number) => onOpenLightbox?.(attachments, idx);

  if (attachments.length === 1) {
    return (
      <ImageBubble
        attachment={attachments[0]!}
        isMine={isMine}
        onOpenLightbox={onOpenLightbox ? () => open(0) : undefined}
      />
    );
  }

  const corner = isMine ? "rounded-br-[6px]" : "rounded-bl-[6px]";

  if (attachments.length === 2) {
    return (
      <div
        className={cn("flex overflow-hidden rounded-[18px]", corner)}
        style={{ gap: GAP, width: W }}
      >
        <GridTile attachment={attachments[0]!} width={HALF_W} height={H2} onClick={() => open(0)} />
        <GridTile attachment={attachments[1]!} width={HALF_W} height={H2} onClick={() => open(1)} />
      </div>
    );
  }

  if (attachments.length === 3) {
    return (
      <div
        className={cn("flex overflow-hidden rounded-[18px]", corner)}
        style={{ gap: GAP, width: W }}
      >
        <GridTile attachment={attachments[0]!} width={BIG_W} height={H3_BIG} onClick={() => open(0)} />
        <div className="flex flex-col" style={{ gap: GAP }}>
          <GridTile attachment={attachments[1]!} width={SM_W} height={H3_SM} onClick={() => open(1)} />
          <GridTile attachment={attachments[2]!} width={SM_W} height={H3_SM} onClick={() => open(2)} />
        </div>
      </div>
    );
  }

  // 4+ images: 2×2 grid, max 4 tiles shown; overflow tile gets "+N" overlay.
  const shown    = attachments.slice(0, 4);
  const overflow = attachments.length - 4;

  return (
    <div
      className={cn("grid overflow-hidden rounded-[18px]", corner)}
      style={{
        gap: GAP,
        width: W,
        gridTemplateColumns: `${HALF_W}px ${HALF_W}px`,
      }}
    >
      {shown.map((att, i) => (
        <GridTile
          key={att.media.id}
          attachment={att}
          width={HALF_W}
          height={H4}
          onClick={() => open(i)}
          overlayCount={i === 3 && overflow > 0 ? overflow : 0}
        />
      ))}
    </div>
  );
}

// ─── GridTile ────────────────────────────────────────────────────────────────

type TileProps = {
  attachment:   ImageAttachment;
  width:        number;
  height:       number;
  onClick:      () => void;
  overlayCount?: number;
};

function GridTile({ attachment, width, height, onClick, overlayCount = 0 }: TileProps) {
  const [loaded, setLoaded] = useState(false);
  const [error,  setError]  = useState(false);
  const { ref, visible } = useInViewport<HTMLButtonElement>();

  const blurUrl = attachment.media.blurUrl;
  const chatSrc = attachment.media.thumbUrl ?? attachment.media.url;

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label="View image"
      className="group/tile relative shrink-0 appearance-none border-0 p-0"
      style={{ width, height, background: "var(--color-raised)" }}
    >
      {/* Blur placeholder — eager, tiny asset */}
      {!loaded && !error && (
        blurUrl ? (
          <img
            src={blurUrl}
            alt=""
            aria-hidden
            className="absolute inset-0 h-full w-full scale-110 object-cover blur-md"
          />
        ) : (
          <div className="absolute inset-0 animate-pulse" style={{ background: "var(--color-raised)" }} />
        )
      )}

      {/* Thumb — lazy, loads when near viewport */}
      {!error && (
        <img
          src={visible ? chatSrc : undefined}
          alt=""
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-300",
            loaded ? "opacity-100" : "opacity-0",
          )}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          draggable={false}
        />
      )}

      {/* Hover overlay */}
      <div
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-150 group-hover/tile:opacity-100"
        style={{ background: "rgba(0,0,0,0.2)" }}
        aria-hidden
      />

      {/* Overflow count — shown only on the 4th tile when there are more */}
      {overlayCount > 0 && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.55)" }}
        >
          <span className="text-xl font-semibold text-white">+{overlayCount}</span>
        </div>
      )}
    </button>
  );
}
