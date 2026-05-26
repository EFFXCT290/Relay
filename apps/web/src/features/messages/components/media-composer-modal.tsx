"use client";

// MediaComposerModal (Phase 6B — 6B.1 staging UI, 6B.12 mode selector). Opens
// after the user picks image/video files and BEFORE anything uploads: it previews
// the selection, lets the user choose a delivery mode, and only initiates the
// upload on confirm. This staging layer is the seam for future features
// (crop/filters/captions/ephemeral) — those slots are rendered disabled now so
// the UX never needs another redesign. Multi-attachment selection is supported;
// the queue is shown as a horizontal strip (future-ready).
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Send, Check, Sparkles, Crop, Wand2, PenLine, Timer, Type as TypeIcon } from "lucide-react";
import type { DeliveryMode } from "@relay/contracts";
import { cn } from "@/frontend-core/utils";

const mono = "var(--font-mono)";

type Staged = { file: File; url: string; isVideo: boolean };

const FUTURE = [
  { icon: Timer,    label: "View once" },
  { icon: Timer,    label: "Expire after" },
  { icon: Crop,     label: "Crop" },
  { icon: Wand2,    label: "Filters" },
  { icon: PenLine,  label: "Draw" },
  { icon: TypeIcon, label: "Caption" },
] as const;

export function MediaComposerModal({
  files,
  onCancel,
  onSend,
}: {
  files:    File[];
  onCancel: () => void;
  onSend:   (mode: DeliveryMode) => void;
}) {
  const [staged, setStaged] = useState<Staged[]>([]);
  const [active, setActive] = useState(0);
  const [mode, setMode]     = useState<DeliveryMode>("optimized");

  // Build object URLs once per file set; revoke on cleanup to avoid leaks.
  useEffect(() => {
    const next = files.map((file) => ({ file, url: URL.createObjectURL(file), isVideo: file.type.startsWith("video/") }));
    setStaged(next);
    setActive(0);
    return () => next.forEach((s) => URL.revokeObjectURL(s.url));
  }, [files]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  if (typeof document === "undefined" || staged.length === 0) return null;
  const current = staged[active] ?? staged[0]!;

  return createPortal(
    <div className="fixed inset-0 z-[120] flex flex-col" style={{ background: "rgba(8,10,14,0.96)", backdropFilter: "blur(12px)" }}>
      {/* Header: Cancel · title · Send */}
      <div className="flex items-center justify-between px-4 pt-[calc(env(safe-area-inset-top)+12px)] pb-3">
        <button type="button" onClick={onCancel} className="flex h-9 items-center gap-1.5 rounded-full px-3 text-[14px] text-white/80 hover:text-white" aria-label="Cancel">
          <X className="h-4 w-4" /> Cancel
        </button>
        <span className="text-[12px] uppercase tracking-[0.1em] text-white/55" style={{ fontFamily: mono }}>
          {staged.length > 1 ? `${active + 1} / ${staged.length}` : "Preview"}
        </span>
        <button
          type="button"
          onClick={() => onSend(mode)}
          className="flex h-9 items-center gap-1.5 rounded-full px-4 text-[14px] font-semibold text-white shadow-[0_4px_12px_rgba(59,130,246,0.35)]"
          style={{ background: "var(--color-signal)" }}
          aria-label="Send"
        >
          Send <Send className="h-4 w-4" />
        </button>
      </div>

      {/* Preview area */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-4">
        {current.isVideo ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video src={current.url} controls autoPlay muted loop playsInline className="max-h-full max-w-full rounded-[14px] object-contain" />
        ) : (
          <img src={current.url} alt="" className="max-h-full max-w-full rounded-[14px] object-contain" />
        )}
      </div>

      {/* Multi-attachment queue strip */}
      {staged.length > 1 && (
        <div className="flex gap-2 overflow-x-auto px-4 py-3">
          {staged.map((s, i) => (
            <button
              key={s.url}
              type="button"
              onClick={() => setActive(i)}
              className={cn("relative h-14 w-14 shrink-0 overflow-hidden rounded-[10px]", i === active ? "ring-2 ring-[var(--color-signal)]" : "opacity-70")}
              aria-label={`Attachment ${i + 1}`}
            >
              {s.isVideo
                // eslint-disable-next-line jsx-a11y/media-has-caption
                ? <video src={s.url} muted className="h-full w-full object-cover" />
                : <img src={s.url} alt="" className="h-full w-full object-cover" />}
            </button>
          ))}
        </div>
      )}

      {/* Delivery mode selector */}
      <div className="px-4 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-1">
        <div className="mx-auto flex max-w-md flex-col gap-2">
          <ModeOption
            selected={mode === "optimized"}
            onClick={() => setMode("optimized")}
            title="Optimized"
            subtitle="Smaller size · faster delivery"
          />
          <ModeOption
            selected={mode === "lss"}
            onClick={() => setMode("lss")}
            title="LSS"
            subtitle="Original quality preserved · larger file"
            badge="LSS"
          />
          <p className="px-1 text-[11px] leading-snug text-white/45" style={{ fontFamily: mono }}>
            {mode === "lss"
              ? "No resize or re-encode — only metadata is sanitized. HEVC/DNG always send as LSS."
              : "Images & H.264 video are compressed for fast delivery; originals are kept for fullscreen."}
          </p>

          {/* Coming-soon slots (disabled) — reserve UI so the flow never redesigns */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {FUTURE.map(({ icon: Icon, label }) => (
              <span
                key={label}
                className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2 py-1 text-[10px] text-white/35"
                style={{ fontFamily: mono }}
                title="Coming soon"
              >
                <Icon className="h-3 w-3" /> {label}
              </span>
            ))}
          </div>
          <span className="flex items-center gap-1 px-1 text-[10px] text-white/30"><Sparkles className="h-3 w-3" /> Coming soon</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ModeOption({
  selected, onClick, title, subtitle, badge,
}: { selected: boolean; onClick: () => void; title: string; subtitle: string; badge?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 rounded-[14px] border px-3.5 py-3 text-left transition-colors",
        selected ? "border-[var(--color-signal)] bg-[var(--color-signal)]/10" : "border-white/10 bg-white/[0.03]",
      )}
    >
      <span
        className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full border", selected ? "border-[var(--color-signal)] bg-[var(--color-signal)]" : "border-white/30")}
      >
        {selected && <Check className="h-3 w-3 text-white" />}
      </span>
      <span className="flex flex-1 flex-col">
        <span className="flex items-center gap-2 text-[14px] font-semibold text-white">
          {title}
          {badge && <span className="rounded-[4px] bg-white/15 px-1.5 py-0.5 text-[9px] tracking-[0.08em]" style={{ fontFamily: mono }}>{badge}</span>}
        </span>
        <span className="text-[12px] text-white/55">{subtitle}</span>
      </span>
    </button>
  );
}
