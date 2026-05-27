"use client";

import { useEffect, useState } from "react";
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Video, Phone } from "lucide-react";
import { api } from "@/frontend-core/api";
import { Avatar } from "@/shared/components/avatar";
import type { CallHistoryItem } from "@relay/contracts";

const mono = "var(--font-mono)";
const display = "var(--font-display)";

// A call is "missed" from the user's side when it was incoming and never
// answered (MISSED status, or an unanswered REJECTED/FAILED).
function isMissed(c: CallHistoryItem): boolean {
  return c.direction === "incoming" && (c.status === "MISSED" || c.status === "FAILED");
}

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

function duration(sec: number): string {
  if (sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
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
            const missed = isMissed(c);
            const DirIcon = missed ? PhoneMissed : c.direction === "incoming" ? PhoneIncoming : PhoneOutgoing;
            const dir = missed ? "Missed" : c.direction === "incoming" ? "Incoming" : "Outgoing";
            const dur = duration(c.durationSec);
            return (
              <li
                key={c.id}
                className="flex items-center gap-3 border-b px-4 py-3"
                style={{ borderColor: "var(--color-hairline)" }}
              >
                <Avatar username={c.otherUser.username} size={40} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span
                    className="truncate text-[15px] font-semibold text-[var(--color-text)]"
                    style={{ color: missed ? "#EF4444" : undefined }}
                  >
                    @{c.otherUser.username}
                  </span>
                  <span className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]" style={{ fontFamily: mono }}>
                    <DirIcon className="h-3.5 w-3.5" style={{ color: missed ? "#EF4444" : undefined }} />
                    {dir}
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
