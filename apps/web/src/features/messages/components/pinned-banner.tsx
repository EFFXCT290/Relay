import { useEffect, useRef, useState } from "react";
import { Pin } from "lucide-react";
import { cn } from "@/frontend-core/utils";
import type { PinnedMessage } from "@relay/contracts";

const mono = "var(--font-mono)";

type Props = {
  pins: PinnedMessage[]; // pins[0] = most recently pinned (server orders desc by pinnedAt)
  onJump: (messageId: string) => void;
  onOpenList: () => void;
};

function previewText(pin: PinnedMessage): string {
  if (pin.message.body) return pin.message.body;
  switch (pin.message.type) {
    case "IMAGE": return "Photo";
    case "VIDEO": return "Video";
    case "AUDIO": return "Voice message";
    default:      return "Message";
  }
}

// Shows the most-recently-pinned message by default; tapping the "i/N"
// indicator cycles through the rest. Resets to the newest pin whenever a
// fresh pin lands (identified by pins[0].id changing), so a new pin always
// takes over the banner rather than leaving the viewer stuck mid-cycle.
export function PinnedBanner({ pins, onJump, onOpenList }: Props) {
  const [index, setIndex] = useState(0);
  const topIdRef = useRef(pins[0]?.id);

  useEffect(() => {
    if (pins[0]?.id !== topIdRef.current) {
      topIdRef.current = pins[0]?.id;
      setIndex(0);
    }
  }, [pins]);

  if (pins.length === 0) return null;

  const safeIndex = index % pins.length;
  const current = pins[safeIndex]!;

  return (
    <div
      className="flex items-center gap-2 border-b px-4 py-2"
      style={{ borderColor: "var(--color-hairline)", background: "rgba(255,255,255,0.02)" }}
    >
      <Pin className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--color-signal)" }} />
      <button
        type="button"
        onClick={() => onJump(current.messageId)}
        className="flex min-w-0 flex-1 flex-col items-start text-left"
      >
        <span className="truncate text-[13px] text-[var(--color-text)]">
          {previewText(current)}
        </span>
        <span className="text-[10px] text-[var(--color-text-muted)]" style={{ fontFamily: mono }}>
          @{current.message.senderUsername}
        </span>
      </button>
      {pins.length > 1 && (
        <button
          type="button"
          aria-label="Show next pinned message"
          onClick={(e) => { e.stopPropagation(); setIndex((i) => (i + 1) % pins.length); }}
          className="shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)] hover:bg-white/[0.06]"
          style={{ fontFamily: mono }}
        >
          {safeIndex + 1}/{pins.length}
        </button>
      )}
      <button
        type="button"
        aria-label="View all pinned messages"
        onClick={(e) => { e.stopPropagation(); onOpenList(); }}
        className={cn(
          "shrink-0 rounded-full px-2 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] hover:bg-white/[0.06]",
        )}
      >
        View all
      </button>
    </div>
  );
}
