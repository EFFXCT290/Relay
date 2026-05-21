import { useEffect, useRef, useState } from "react";
import { Check, CheckCheck, CornerUpLeft, Smile } from "lucide-react";
import { cn } from "@/frontend-core/utils";
import { Avatar } from "@/shared/components/avatar";
import { ReactionChips, ReactionPicker } from "./reaction-picker";
import type { Message } from "@relay/contracts";

export type { Message };  // re-export so existing consumers still resolve through this module

const mono = "var(--font-mono)";
const SWIPE_THRESHOLD = 60;

// macOS natural scrolling sends negative deltaX for a rightward finger swipe.
// Windows / Linux send positive deltaX for the same gesture.
const isMacOS = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

type Props = {
  message: Message;
  isMine: boolean;
  showReadReceipt?: boolean;
  readAt?: string | null;
  deliveredAt?: string | null;
  onReact?: (messageId: string, emoji: string) => void;
  onReply?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  onDelete?: (message: Message) => void;
};

export function MessageBubble({
  message,
  isMine,
  showReadReceipt,
  readAt,
  deliveredAt,
  onReact,
  onReply,
  onEdit,
  onDelete,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [swipeX, setSwipeX] = useState(0);
  const longPressTimer = useRef<number | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const swipingRef = useRef(false);
  const repliedRef = useRef(false);
  // Trackpad (wheel) swipe state
  const wheelAccumRef = useRef(0);
  const wheelTimerRef = useRef<number | null>(null);
  const wheelRepliedRef = useRef(false);

  useEffect(() => {
    return () => {
      if (wheelTimerRef.current !== null) window.clearTimeout(wheelTimerRef.current);
    };
  }, []);

  if (message.isDeleted) {
    return (
      <div className={cn("flex max-w-[280px]", isMine ? "self-end" : "self-start")}>
        <div
          className={cn(
            "rounded-[22px] px-3.5 py-2.5 text-sm italic",
            isMine ? "rounded-br-[6px]" : "rounded-bl-[6px]",
          )}
          style={{
            color: "var(--color-text-muted)",
            background: "rgba(255,255,255,0.03)",
            border: "1px dashed var(--color-hairline-strong)",
          }}
        >
          Message deleted
        </div>
      </div>
    );
  }

  const side = isMine ? "right" : "left";
  const swipeProgress = Math.min(swipeX / SWIPE_THRESHOLD, 1);

  const handleTouchStart = (e: React.TouchEvent) => {
    const t = e.touches.item(0);
    if (!t) return;
    touchStartRef.current = { x: t.clientX, y: t.clientY };
    swipingRef.current = false;
    repliedRef.current = false;
    longPressTimer.current = window.setTimeout(() => {
      if (!swipingRef.current) setMenuOpen(true);
    }, 500);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartRef.current) return;
    const t = e.touches.item(0);
    if (!t) return;
    const dx = t.clientX - touchStartRef.current.x;
    const dy = t.clientY - touchStartRef.current.y;
    if (dx > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      swipingRef.current = true;
      if (longPressTimer.current !== null) {
        window.clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
      e.preventDefault();
      const clamped = Math.min(dx, SWIPE_THRESHOLD + 14);
      setSwipeX(clamped);
      if (!repliedRef.current && clamped >= SWIPE_THRESHOLD) {
        repliedRef.current = true;
        navigator.vibrate?.(8);
      }
    }
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    if (repliedRef.current) onReply?.(message);
    setSwipeX(0);
    touchStartRef.current = null;
    swipingRef.current = false;
    repliedRef.current = false;
  };

  // Two-finger trackpad swipe (wheel deltaX) — desktop equivalent of touch swipe.
  const handleWheel = (e: React.WheelEvent) => {
    // Ignore mostly-vertical scrolls so normal page scrolling is unaffected.
    if (Math.abs(e.deltaX) < Math.abs(e.deltaY) * 0.6) return;
    // Right-swipe means deltaX < 0 on macOS natural scrolling, > 0 everywhere else.
    const isRightSwipe = isMacOS ? e.deltaX < 0 : e.deltaX > 0;
    if (!isRightSwipe) {
      if (wheelAccumRef.current > 0) {
        wheelAccumRef.current = 0;
        setSwipeX(0);
      }
      return;
    }
    e.stopPropagation();
    wheelAccumRef.current = Math.min(wheelAccumRef.current + Math.abs(e.deltaX), SWIPE_THRESHOLD + 14);
    setSwipeX(wheelAccumRef.current);
    if (!wheelRepliedRef.current && wheelAccumRef.current >= SWIPE_THRESHOLD) {
      wheelRepliedRef.current = true;
    }
    // Commit reply once the finger lifts (no new wheel events for 160 ms).
    if (wheelTimerRef.current !== null) window.clearTimeout(wheelTimerRef.current);
    wheelTimerRef.current = window.setTimeout(() => {
      if (wheelRepliedRef.current) onReply?.(message);
      setSwipeX(0);
      wheelAccumRef.current = 0;
      wheelRepliedRef.current = false;
    }, 160);
  };

  return (
    <div
      className={cn(
        "group relative flex max-w-[280px] flex-col gap-1 lg:max-w-[420px]",
        isMine ? "self-end items-end" : "self-start items-start",
      )}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onWheel={handleWheel}
    >
      {pickerOpen && (
        <ReactionPicker
          current={message.myReaction}
          side={side}
          onPick={(emoji) => {
            onReact?.(message.messageId, emoji);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {menuOpen && (
        <ContextMenu
          isMine={isMine}
          side={side}
          onPickReaction={() => {
            setMenuOpen(false);
            setPickerOpen(true);
          }}
          onReply={() => {
            setMenuOpen(false);
            onReply?.(message);
          }}
          onEdit={() => {
            setMenuOpen(false);
            onEdit?.(message);
          }}
          onDelete={() => {
            setMenuOpen(false);
            onDelete?.(message);
          }}
          onClose={() => setMenuOpen(false)}
        />
      )}

      {/* Swipe-to-reply icon — fades in as user drags right, stays fixed while bubble translates */}
      <div
        className="pointer-events-none absolute inset-y-0 flex items-center"
        style={{
          left: -36,
          opacity: swipeProgress,
          transform: `translateX(${swipeProgress * 8}px)`,
        }}
      >
        <CornerUpLeft className="h-5 w-5" style={{ color: "var(--color-signal)" }} />
      </div>

      {/* Translatable content — slides right during swipe, snaps back on release */}
      <div
        className={cn("flex flex-col gap-1", isMine ? "items-end" : "items-start")}
        style={{
          transform: `translateX(${swipeX}px)`,
          transition: swipeX === 0 ? "transform 0.28s cubic-bezier(0.25,1,0.32,1)" : "none",
        }}
      >
        {message.replyTo && (
          <div
            className="ml-2 mr-2 max-w-[240px] rounded-[8px_8px_8px_4px] border-l-2 px-3 py-1.5"
            style={{
              background: "rgba(255,255,255,0.04)",
              borderColor: "var(--color-signal)",
              marginBottom: -4,
            }}
          >
            <div className="text-[11px] font-semibold" style={{ color: "var(--color-signal)" }}>
              {isMine ? `@${message.senderUsername}` : "Replying"}
            </div>
            <div className="truncate text-xs leading-4 text-[var(--color-text-secondary)]">
              {message.replyTo.preview ?? message.replyTo.type.toLowerCase()}
            </div>
          </div>
        )}

        <div className="relative flex items-end gap-1.5">
          {isMine && (
            <>
              <button
                type="button"
                onClick={() => onReply?.(message)}
                aria-label="Reply"
                className="invisible flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-raised)] text-[var(--color-text-secondary)] opacity-0 transition-opacity hover:text-[var(--color-text)] group-hover:visible group-hover:opacity-100"
              >
                <CornerUpLeft className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                aria-label="React"
                className="invisible flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-raised)] text-[var(--color-text-secondary)] opacity-0 transition-opacity hover:text-[var(--color-text)] group-hover:visible group-hover:opacity-100"
              >
                <Smile className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          <div
            className={cn(
              "rounded-[22px] px-3.5 py-2.5 text-[15px] leading-[21px]",
              isMine ? "rounded-br-[6px]" : "rounded-bl-[6px]",
            )}
            style={{
              background: isMine ? "var(--color-bubble-sent)" : "var(--color-bubble-received)",
              color: isMine ? "var(--color-bubble-sent-text)" : "var(--color-text)",
              border: isMine ? undefined : "1px solid rgba(255,255,255,0.04)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {message.body}
          </div>
          {!isMine && (
            <>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                aria-label="React"
                className="invisible flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-raised)] text-[var(--color-text-secondary)] opacity-0 transition-opacity hover:text-[var(--color-text)] group-hover:visible group-hover:opacity-100"
              >
                <Smile className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onReply?.(message)}
                aria-label="Reply"
                className="invisible flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-raised)] text-[var(--color-text-secondary)] opacity-0 transition-opacity hover:text-[var(--color-text)] group-hover:visible group-hover:opacity-100"
              >
                <CornerUpLeft className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>

        <ReactionChips
          reactions={message.reactions}
          myReaction={message.myReaction}
          align={side}
          onToggle={(e) => onReact?.(message.messageId, e)}
        />

        <div className="flex items-center gap-1.5 px-1">
          {message.isEdited && (
            <span
              className="text-[10px] text-[var(--color-text-muted)]"
              style={{ fontFamily: mono }}
            >
              edited
            </span>
          )}
          {isMine && showReadReceipt && (
            <span
              className="flex items-center gap-1"
              style={{
                color: readAt
                  ? "var(--color-read-receipt)"
                  : "var(--color-text-muted)",
              }}
            >
              {readAt || deliveredAt ? (
                <CheckCheck className="h-3 w-3" />
              ) : (
                <Check className="h-3 w-3" />
              )}
              <span className="text-[10px]" style={{ fontFamily: mono }}>
                {readAt
                  ? `Read ${formatHHMM(readAt)}`
                  : deliveredAt
                    ? "Delivered"
                    : "Sent"}
              </span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
//  Context menu — right-click on desktop, long-press on mobile
// ──────────────────────────────────────────────────────────────────────────

function ContextMenu({
  isMine,
  side,
  onPickReaction,
  onReply,
  onEdit,
  onDelete,
  onClose,
}: {
  isMine: boolean;
  side: "left" | "right";
  onPickReaction: () => void;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useMenuClose(onClose);
  return (
    <div
      ref={ref}
      role="menu"
      className={cn(
        "absolute z-30 mt-2 flex w-[180px] flex-col overflow-hidden rounded-2xl border bg-[var(--color-raised)] shadow-[0_12px_32px_rgba(0,0,0,0.55)]",
        side === "right" ? "right-0 top-full" : "left-0 top-full",
      )}
      style={{ borderColor: "var(--color-hairline-strong)" }}
    >
      <MenuItem label="React" onClick={onPickReaction} />
      <MenuItem label="Reply" onClick={onReply} />
      {isMine && <MenuItem label="Edit" onClick={onEdit} />}
      {isMine && (
        <MenuItem label="Delete" onClick={onDelete} variant="danger" />
      )}
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  variant,
}: {
  label: string;
  onClick: () => void;
  variant?: "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center px-4 py-2.5 text-left text-[13px] font-medium hover:bg-white/[0.06]",
        variant === "danger" ? "text-[var(--color-alert)]" : "text-[var(--color-text)]",
      )}
    >
      {label}
    </button>
  );
}

function useMenuClose(onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Defer one tick so the same click that opened the menu doesn't close it.
    const t = setTimeout(() => {
      document.addEventListener("mousedown", handler);
      document.addEventListener("keydown", esc);
    }, 0);
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  return ref;
}

function formatHHMM(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
}

// ──────────────────────────────────────────────────────────────────────────

export function DaySeparator({ date }: { date: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-2">
      <span className="h-px w-14" style={{ background: "var(--color-hairline)" }} />
      <span
        className="text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]"
        style={{ fontFamily: mono }}
      >
        {date}
      </span>
      <span className="h-px w-14" style={{ background: "var(--color-hairline)" }} />
    </div>
  );
}

// RCS-style typing indicator — small avatar of the typing person, then a
// roomy bubble of pulsing dots. Fades in via animation so the appearance
// itself feels like part of the message rhythm.
export function TypingBubble({ username }: { username?: string }) {
  return (
    <div className="flex items-end gap-2 self-start opacity-90 [animation:relay-typing-in_180ms_ease-out_both]">
      {username && <Avatar username={username} size={28} />}
      <div
        className="flex items-center gap-1.5 rounded-[22px_22px_22px_6px] border bg-[var(--color-bubble-received)] px-4 py-3.5 shadow-[0_4px_12px_rgba(0,0,0,0.18)]"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
        aria-label={username ? `@${username} is typing` : "typing"}
      >
        <span className="relay-typing-dot h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-signal)" }} />
        <span className="relay-typing-dot h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-signal)" }} />
        <span className="relay-typing-dot h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-signal)" }} />
      </div>
    </div>
  );
}
