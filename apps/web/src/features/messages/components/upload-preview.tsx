"use client";

import { AlertCircle, Loader2, RefreshCw, X } from "lucide-react";
import { cn } from "@/frontend-core/utils";

// Mirrors the layout constants in image-grid.tsx.
const GAP    = 2;
const W      = 280;
const HALF_W = Math.floor((W - GAP) / 2);
const BIG_W  = Math.floor((W - GAP) * (2 / 3));
const SM_W   = W - GAP - BIG_W;
const H2     = 160;
const H3_BIG = 200;
const H3_SM  = Math.floor((H3_BIG - GAP) / 2);
const H4     = HALF_W;

type Preview = { blobUrl: string };

type Props = {
  previews:  Preview[];
  status:    "uploading" | "sending" | "error";
  onCancel?: () => void;
  onRetry?:  () => void;
};

export function UploadPreview({ previews, status, onCancel, onRetry }: Props) {
  const grid = renderGrid(previews);

  return (
    <div className="relative self-end" style={{ width: W }}>
      {/* Image grid preview */}
      {grid}

      {/* Uploading / sending overlay */}
      {status !== "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-[18px]"
          style={{ background: "rgba(0,0,0,0.38)" }}
        >
          <Loader2 className="h-7 w-7 animate-spin text-white drop-shadow-[0_1px_6px_rgba(0,0,0,0.6)]" />
          {status === "sending" && (
            <span className="text-[11px] font-medium text-white/80">Sending…</span>
          )}
        </div>
      )}

      {/* Error overlay */}
      {status === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-[18px]"
          style={{ background: "rgba(0,0,0,0.68)" }}
        >
          <AlertCircle className="h-6 w-6 text-red-400" />
          <span className="text-[12px] font-medium text-white/90">Upload failed</span>
          <div className="flex items-center gap-2">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold text-white"
                style={{ background: "var(--color-signal)" }}
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </button>
            )}
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold text-white/80"
                style={{ background: "rgba(255,255,255,0.12)" }}
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}

      {/* Cancel button — always shown while uploading/sending */}
      {status !== "error" && onCancel && (
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel upload"
          className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full"
          style={{ background: "rgba(0,0,0,0.5)", color: "#fff" }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

// ─── Layout helpers ───────────────────────────────────────────────────────────

function Tile({ blobUrl, width, height, className }: {
  blobUrl: string; width: number; height: number; className?: string;
}) {
  return (
    <div className={cn("relative shrink-0 overflow-hidden bg-[var(--color-raised)]", className)} style={{ width, height }}>
      <img
        src={blobUrl}
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
        draggable={false}
      />
    </div>
  );
}

function renderGrid(previews: Preview[]) {
  const corner = "rounded-br-[6px]"; // always isMine for pending uploads

  if (previews.length === 0) return null;

  if (previews.length === 1) {
    return (
      <div className={cn("overflow-hidden rounded-[18px]", corner)} style={{ width: W, height: H2 }}>
        <img src={previews[0]!.blobUrl} alt="" className="h-full w-full object-cover" draggable={false} />
      </div>
    );
  }

  if (previews.length === 2) {
    return (
      <div className={cn("flex overflow-hidden rounded-[18px]", corner)} style={{ gap: GAP, width: W }}>
        <Tile blobUrl={previews[0]!.blobUrl} width={HALF_W} height={H2} />
        <Tile blobUrl={previews[1]!.blobUrl} width={HALF_W} height={H2} />
      </div>
    );
  }

  if (previews.length === 3) {
    return (
      <div className={cn("flex overflow-hidden rounded-[18px]", corner)} style={{ gap: GAP, width: W }}>
        <Tile blobUrl={previews[0]!.blobUrl} width={BIG_W} height={H3_BIG} />
        <div className="flex flex-col" style={{ gap: GAP }}>
          <Tile blobUrl={previews[1]!.blobUrl} width={SM_W} height={H3_SM} />
          <Tile blobUrl={previews[2]!.blobUrl} width={SM_W} height={H3_SM} />
        </div>
      </div>
    );
  }

  // 4+ — 2×2 grid, show max 4 tiles.
  const shown    = previews.slice(0, 4);
  const overflow = previews.length - 4;

  return (
    <div
      className={cn("grid overflow-hidden rounded-[18px]", corner)}
      style={{ gap: GAP, width: W, gridTemplateColumns: `${HALF_W}px ${HALF_W}px` }}
    >
      {shown.map((p, i) => (
        <div key={i} className="relative shrink-0 overflow-hidden bg-[var(--color-raised)]" style={{ width: HALF_W, height: H4 }}>
          <img src={p.blobUrl} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
          {i === 3 && overflow > 0 && (
            <div className="absolute inset-0 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.55)" }}>
              <span className="text-xl font-semibold text-white">+{overflow}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
