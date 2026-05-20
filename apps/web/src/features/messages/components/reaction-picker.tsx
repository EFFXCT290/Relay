"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Plus } from "lucide-react";
import { cn } from "@/frontend-core/utils";

const QUICK_EMOJI = ["❤️", "😂", "😮", "😢", "🔥", "👍"];

type Props = {
  current: string | null;
  side: "left" | "right";
  onPick: (emoji: string) => void;
  onClose: () => void;
};

// Floats above the bubble with the 6 quick reactions + a ➕ that opens an
// inline input. On mobile the input pops the OS emoji keyboard; on desktop
// users paste or hit the system emoji shortcut (Ctrl-Cmd-Space on macOS).
export function ReactionPicker({ current, side, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"quick" | "any">("quick");
  const [value, setValue] = useState("");

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (mode === "any") setMode("quick");
        else onClose();
      }
    };
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, mode]);

  useEffect(() => {
    if (mode === "any") inputRef.current?.focus();
  }, [mode]);

  const submitAny = () => {
    const v = value.trim();
    if (!v) return;
    onPick(v);
  };

  return (
    <div
      ref={ref}
      role="menu"
      className={cn(
        "absolute -top-12 z-30 flex items-center gap-1 rounded-full border bg-[var(--color-raised)] px-1.5 py-1 shadow-[0_8px_24px_rgba(0,0,0,0.45)]",
        side === "right" ? "right-2" : "left-2",
      )}
      style={{ borderColor: "var(--color-hairline-strong)" }}
    >
      {mode === "quick" ? (
        <>
          {QUICK_EMOJI.map((e) => {
            const active = e === current;
            return (
              <button
                key={e}
                type="button"
                onClick={() => onPick(e)}
                aria-label={`React with ${e}`}
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-[18px] leading-none transition-transform",
                  active && "bg-white/[0.10] scale-110",
                  "hover:scale-110",
                )}
              >
                {e}
              </button>
            );
          })}
          <span
            className="mx-0.5 h-5 w-px self-center"
            style={{ background: "var(--color-hairline-strong)" }}
            aria-hidden
          />
          <button
            type="button"
            onClick={() => setMode("any")}
            aria-label="Pick any emoji"
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-text-secondary)] hover:bg-white/[0.06] hover:text-[var(--color-text)]"
          >
            <Plus className="h-4 w-4" />
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setMode("quick")}
            aria-label="Back to quick reactions"
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-text-secondary)] hover:bg-white/[0.06] hover:text-[var(--color-text)]"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <input
            ref={inputRef}
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={value}
            placeholder="any emoji"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitAny();
              }
            }}
            maxLength={16}
            className="h-8 w-32 bg-transparent px-1 text-[16px] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
            style={{ fontFamily: "var(--font-body)" }}
            aria-label="Any emoji"
          />
          <button
            type="button"
            onClick={submitAny}
            disabled={!value.trim()}
            aria-label="Use this emoji"
            className="flex h-8 min-w-[40px] items-center justify-center rounded-full px-2 text-[12px] font-semibold text-white transition-opacity disabled:opacity-40"
            style={{ background: "var(--color-signal)" }}
          >
            Use
          </button>
        </>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────

export function ReactionChips({
  reactions,
  myReaction,
  onToggle,
  align,
}: {
  reactions: Record<string, number>;
  myReaction: string | null;
  onToggle: (emoji: string) => void;
  align: "left" | "right";
}) {
  const entries = Object.entries(reactions).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1 px-1", align === "right" ? "justify-end" : "justify-start")}>
      {entries.map(([emoji, count]) => {
        const active = emoji === myReaction;
        return (
          <button
            key={emoji}
            type="button"
            onClick={() => onToggle(emoji)}
            className={cn(
              "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] transition-colors",
              active
                ? "border-[var(--color-signal)] bg-[rgba(59,130,246,0.14)]"
                : "border-[var(--color-hairline-strong)] bg-[var(--color-raised)] hover:bg-white/[0.06]",
            )}
            aria-pressed={active}
          >
            <span className="leading-none">{emoji}</span>
            <span
              className="text-[11px] font-medium"
              style={{
                fontFamily: "var(--font-mono)",
                color: active ? "var(--color-signal)" : "var(--color-text-secondary)",
              }}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
