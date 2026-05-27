"use client";

import { useEffect, useState } from "react";
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Video, Phone } from "lucide-react";
import { api } from "@/frontend-core/api";
import { Avatar } from "@/shared/components/avatar";
import type { CallHistoryItem } from "@relay/contracts";

const mono = "var(--font-mono)";
const display = "var(--font-display)";

const GREEN = "#22C55E";
const RED = "#EF4444";
const AMBER = "#F59E0B";

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMin = Math.round((Date.now() - then) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 7) return `${diffD}d ago`;
  return new Date(iso).toLocaleDateString();
}

// "" for a zero/unstarted call so callers can conditionally render.
function formatCallDuration(sec: number): string {
  if (sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Outcome = the human-readable result of the call, derived from status +
// direction. `missed` (an incoming call you never answered) is the only case
// that gets the row-level red highlight — matching the familiar phone-app
// "missed call" convention. Everything else is just colored text.
type CallOutcome = { label: string; color: string; missed: boolean };

function callOutcome(c: CallHistoryItem): CallOutcome {
  // durationSec > 0 is the only proof media actually flowed: the server writes
  // ENDED for both a hung-up live call AND a call cancelled mid-ring, and only
  // the former has a duration. So an ENDED call with no duration never connected.
  const connected = c.durationSec > 0;
  switch (c.status) {
    case "ANSWERED": // transient/crash artifact — treat as a connected call
    case "ENDED":
      if (connected) return { label: "Answered", color: GREEN, missed: false };
      // Ended before connecting: caller cancelled during the ring.
      return c.direction === "incoming"
        ? { label: "Missed", color: RED, missed: true } // caller gave up before you answered
        : { label: "Cancelled", color: AMBER, missed: false };
    case "MISSED":
      // Incoming + unanswered = a missed call; outgoing = the other side never picked up.
      return c.direction === "incoming"
        ? { label: "Missed", color: RED, missed: true }
        : { label: "No answer", color: AMBER, missed: false };
    case "REJECTED":
      // "Declined" reads correctly both ways: you declined an incoming call, or
      // the other side declined your outgoing one.
      return { label: "Declined", color: AMBER, missed: false };
    case "FAILED":
      return { label: "Failed", color: RED, missed: false };
    case "RINGING":
      return { label: "Ringing", color: "var(--color-text-muted)", missed: false };
    default:
      return { label: "", color: "var(--color-text-muted)", missed: false };
  }
}

export default function CallsPage() {
  const [calls, setCalls] = useState<CallHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ calls: CallHistoryItem[] }>("/api/calls");
        if (!cancelled) setCalls(res.calls);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load calls");
          setCalls([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col">
      <header
        className="flex items-center gap-2 border-b px-4 py-4"
        style={{ borderColor: "var(--color-hairline)" }}
      >
        <Phone className="h-5 w-5 text-[var(--color-text)]" />
        <h1 className="text-[18px] font-bold tracking-[-0.01em] text-[var(--color-text)]" style={{ fontFamily: display }}>
          Calls
        </h1>
      </header>

      {calls === null ? (
        <div className="flex items-center justify-center py-16">
          <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]" style={{ fontFamily: mono }}>
            loading
          </span>
        </div>
      ) : error ? (
        <div className="px-4 py-8 text-center text-[13px] text-[var(--color-text-muted)]">{error}</div>
      ) : calls.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]" style={{ fontFamily: mono }}>
            no calls yet
          </span>
        </div>
      ) : (
        <ul>
          {calls.map((c) => {
            const outcome = callOutcome(c);
            const DirIcon = outcome.missed
              ? PhoneMissed
              : c.direction === "incoming"
                ? PhoneIncoming
                : PhoneOutgoing;
            const dur = formatCallDuration(c.durationSec);
            return (
              <li
                key={c.id}
                className="flex items-center gap-3 border-b px-4 py-3"
                style={{
                  borderColor: "var(--color-hairline)",
                  // Missed calls get a red left border + faint tint so they're
                  // scannable without reading the label.
                  borderLeft: outcome.missed ? `3px solid ${RED}` : "3px solid transparent",
                  backgroundColor: outcome.missed ? "rgba(239,68,68,0.06)" : undefined,
                }}
              >
                <Avatar username={c.otherUser.username} size={40} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span
                    className="truncate text-[15px] font-semibold text-[var(--color-text)]"
                    style={{ color: outcome.missed ? RED : undefined }}
                  >
                    @{c.otherUser.username}
                  </span>
                  <span className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]" style={{ fontFamily: mono }}>
                    <DirIcon className="h-3.5 w-3.5" style={{ color: outcome.color }} />
                    <span style={{ color: outcome.color }}>{outcome.label}</span>
                    {c.type === "VIDEO" && <Video className="h-3.5 w-3.5" />}
                    {dur && <span>· {dur}</span>}
                  </span>
                </div>
                <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]" style={{ fontFamily: mono }}>
                  {relativeTime(c.createdAt)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
