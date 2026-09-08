import { createPortal } from "react-dom";
import { Pin, X } from "lucide-react";
import { MAX_PINNED_MESSAGES, type PinnedMessage } from "@relay/contracts";

const mono = "var(--font-mono)";

type Props = {
  pins: PinnedMessage[];
  onJump: (messageId: string) => void;
  onUnpin: (messageId: string) => void;
  onClose: () => void;
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

function formatPinnedAt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function PinnedMessagesList({ pins, onJump, onUnpin, onClose }: Props) {
  const atCap = pins.length >= MAX_PINNED_MESSAGES;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <div
        className="relative mt-auto flex max-h-[70vh] flex-col overflow-hidden rounded-t-2xl border bg-[var(--color-bg)] lg:mx-auto lg:mb-auto lg:mt-24 lg:w-[420px] lg:rounded-2xl"
        style={{ borderColor: "var(--color-hairline-strong)" }}
      >
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--color-hairline)" }}>
          <div className="flex items-center gap-2">
            <Pin className="h-4 w-4" style={{ color: "var(--color-signal)" }} />
            <span className="text-[14px] font-semibold text-[var(--color-text)]">Pinned Messages</span>
            <span
              className="text-[11px] text-[var(--color-text-muted)]"
              style={{ fontFamily: mono }}
              data-testid="pin-count"
            >
              {pins.length}/{MAX_PINNED_MESSAGES}
            </span>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/5">
            <X className="h-4 w-4 text-[var(--color-text-secondary)]" />
          </button>
        </div>

        {atCap && (
          <p
            data-testid="pin-cap-reached-hint"
            className="px-4 py-2 text-[11px]"
            style={{ color: "var(--color-text-muted)", background: "rgba(255,255,255,0.03)" }}
          >
            {MAX_PINNED_MESSAGES} of {MAX_PINNED_MESSAGES} pinned — unpin one below to pin another message.
          </p>
        )}

        <div className="flex-1 overflow-y-auto">
          {pins.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-[var(--color-text-muted)]">
              No pinned messages yet.
            </p>
          ) : (
            <ul>
              {pins.map((p) => (
                <li
                  key={p.id}
                  className="flex items-start gap-2 border-b px-4 py-3 last:border-b-0"
                  style={{ borderColor: "var(--color-hairline)" }}
                >
                  {/* items-start on this flex-col button was the actual bug: it
                      sets align-items to "start" instead of the default
                      `stretch`, so children size to their own content width
                      and just get left-positioned, rather than filling the
                      button's already-bounded width. Without stretch,
                      `truncate` on the span below has no bounded box to clip
                      against — min-w-0 correctly shrinks the button itself,
                      but that never reaches the span. Text stays left-aligned
                      regardless (text-align, unaffected by box width), so
                      dropping items-start has no visual effect beyond fixing
                      the truncation. Same fix as pinned-banner.tsx's
                      identical preview. */}
                  <button type="button" onClick={() => onJump(p.messageId)} className="flex min-w-0 flex-1 flex-col text-left">
                    <span className="truncate text-[13px] text-[var(--color-text)]">{previewText(p)}</span>
                    <span className="text-[11px] text-[var(--color-text-muted)]">
                      @{p.message.senderUsername} · pinned by @{p.pinnedByUsername} · {formatPinnedAt(p.pinnedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label="Unpin"
                    onClick={() => onUnpin(p.messageId)}
                    className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium text-[var(--color-alert)] hover:bg-white/[0.06]"
                  >
                    Unpin
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
