"use client";

// Composer control for disappearing text messages. Mirrors the visual
// language of MediaComposerModal's "View limit" section (same bordered panel,
// same pill-button styling, same VIEW_LIMITS-style row) since that's this
// app's established pattern for "pick a disappear budget before sending" —
// just inline in a small popover above the composer instead of a full-screen
// staging modal, since there's no attachment preview step for text.
//
// Controlled: ChatComposer owns the actual value so it can reset it to null
// right after a successful send — this is a ONE-SHOT per-message choice, never
// a sticky per-conversation setting (see chat-composer.tsx's submit()).
import { useEffect, useRef, useState } from "react";
import { Eye, Timer as TimerIcon, X } from "lucide-react";
import type { DisappearSend } from "@relay/contracts";
import { cn } from "@/frontend-core/utils";

const mono = "var(--font-mono)";

const VIEW_LIMITS = [1, 2, 3, 4, 5] as const;

// value/label pairs — seconds must stay within the server's DisappearSendSchema
// bounds (5s..7d, see messages.contract.ts).
const TIME_PRESETS = [
  { seconds: 10, label: "10s" },
  { seconds: 60, label: "1m" },
  { seconds: 300, label: "5m" },
  { seconds: 3600, label: "1h" },
  { seconds: 21600, label: "6h" },
  { seconds: 86400, label: "24h" },
] as const;

type Mode = "off" | "views" | "time";

function modeOf(value: DisappearSend | null): Mode {
  return value === null ? "off" : value.mode;
}

export function DisappearPicker({
  value,
  onChange,
}: {
  value: DisappearSend | null;
  onChange: (next: DisappearSend | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const mode = modeOf(value);
  const armed = mode !== "off";

  const setMode = (next: Mode) => {
    if (next === "off") onChange(null);
    else if (next === "views") onChange({ mode: "views", viewLimit: 1 });
    else onChange({ mode: "time", ttlSeconds: TIME_PRESETS[0].seconds });
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={armed ? "Disappearing message settings (on)" : "Set message to disappear"}
        aria-pressed={armed}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full border transition-colors",
          armed
            ? "border-[var(--color-signal)] bg-[var(--color-signal)]/15 text-[var(--color-signal)]"
            : "border-transparent bg-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
        )}
      >
        {mode === "time" ? <TimerIcon className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
      </button>

      {open && (
        <div
          ref={panelRef}
          className="absolute bottom-[calc(100%+8px)] left-0 z-30 w-[260px] rounded-[14px] border border-white/10 bg-[var(--color-raised)] px-3.5 py-3 shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13px] font-semibold text-[var(--color-text)]">Disappearing message</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="flex h-6 w-6 items-center justify-center rounded-full text-[var(--color-text-secondary)] hover:bg-white/5 hover:text-[var(--color-text)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="flex gap-1.5">
            {(["off", "views", "time"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  "flex h-8 flex-1 items-center justify-center rounded-[10px] border text-[12px] font-semibold capitalize transition-colors",
                  mode === m
                    ? "border-[var(--color-signal)] bg-[var(--color-signal)]/15 text-[var(--color-text)]"
                    : "border-white/10 bg-white/[0.03] text-[var(--color-text-secondary)]",
                )}
              >
                {m === "off" ? "Off" : m === "views" ? "Views" : "Timer"}
              </button>
            ))}
          </div>

          {mode === "views" && (
            <div className="mt-2 flex gap-1.5">
              {VIEW_LIMITS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => onChange({ mode: "views", viewLimit: n })}
                  className={cn(
                    "flex h-8 flex-1 items-center justify-center rounded-[10px] border text-[12px] font-semibold transition-colors",
                    value?.mode === "views" && value.viewLimit === n
                      ? "border-[var(--color-signal)] bg-[var(--color-signal)]/15 text-[var(--color-text)]"
                      : "border-white/10 bg-white/[0.03] text-[var(--color-text-secondary)]",
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          )}

          {mode === "time" && (
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              {TIME_PRESETS.map((p) => (
                <button
                  key={p.seconds}
                  type="button"
                  onClick={() => onChange({ mode: "time", ttlSeconds: p.seconds })}
                  className={cn(
                    "flex h-8 items-center justify-center rounded-[10px] border text-[12px] font-semibold transition-colors",
                    value?.mode === "time" && value.ttlSeconds === p.seconds
                      ? "border-[var(--color-signal)] bg-[var(--color-signal)]/15 text-[var(--color-text)]"
                      : "border-white/10 bg-white/[0.03] text-[var(--color-text-secondary)]",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}

          <p className="mt-2 px-0.5 text-[11px] leading-snug text-[var(--color-text-muted)]" style={{ fontFamily: mono }}>
            {mode === "off"
              ? "Normal message — stays until you delete it."
              : mode === "views"
                ? value?.mode === "views" && value.viewLimit === 1
                  ? "View once — disappears after it's opened."
                  : `Hidden until opened; disappears after ${value?.mode === "views" ? value.viewLimit : 1} views.`
                : "Visible normally, then disappears after the timer runs out."}
          </p>
        </div>
      )}
    </div>
  );
}
