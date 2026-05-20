"use client";

import { Clock, Eye, Image as ImageIcon, MessageSquare, ShieldCheck, ShieldOff } from "lucide-react";
import type { Notification } from "@relay/contracts";

export type { Notification };  // re-export so prior consumers via this path keep working

const mono = "var(--font-mono)";
const display = "var(--font-display)";

// ──────────────────────────────────────────────────────────────────────────
//  Featured capture-alert card — the loudest possible variant. Used only
//  for SYSTEM_ALERT type, typically pinned at the top of the page.
// ──────────────────────────────────────────────────────────────────────────

export function CaptureAlertCard({
  notification,
  onBlock,
  onView,
}: {
  notification: Notification;
  onBlock?: (username: string) => void;
  onView?: () => void;
}) {
  const p = notification.payload;
  const capturedBy = p.capturedBy?.username ?? "someone";
  const isRecord = p.eventType === "RECORD_ATTEMPT";
  const verb = isRecord ? "tried to record" : "tried to screenshot";

  return (
    <article
      className="relative flex flex-col gap-3 overflow-hidden rounded-3xl border p-4 shadow-[0_0_32px_rgba(239,68,68,0.12)]"
      style={{
        background: "linear-gradient(135deg, rgba(239,68,68,0.14) 0%, rgba(239,68,68,0.04) 100%)",
        borderColor: "rgba(239,68,68,0.40)",
        boxShadow:
          "0 0 32px rgba(239,68,68,0.12), inset 0 0 0 1px rgba(239,68,68,0.30)",
      }}
    >
      <header className="flex items-center gap-2.5">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border"
          style={{
            background: "rgba(239,68,68,0.18)",
            borderColor: "rgba(239,68,68,0.40)",
          }}
        >
          <ShieldOff className="h-[18px] w-[18px]" style={{ color: "var(--color-alert)" }} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span
              className="text-[14px] font-extrabold tracking-[-0.005em] text-[var(--color-text)]"
              style={{ fontFamily: display }}
            >
              {isRecord ? "Recording detected" : "Screenshot detected"}
            </span>
            {!notification.isRead && <LiveBadge />}
          </div>
          <span
            className="text-[10px] tracking-[0.04em] text-[var(--color-text-secondary)]"
            style={{ fontFamily: mono }}
          >
            {formatHHMM(notification.createdAt)} · {relativeShort(notification.createdAt)}
            {p.trigger ? ` · ${p.trigger}` : ""}
          </span>
        </div>
      </header>

      <div className="flex items-start gap-3">
        <div
          className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl border"
          style={{
            background: "linear-gradient(135deg, #1E293B 0%, #020617 100%)",
            borderColor: "var(--color-hairline-strong)",
          }}
        >
          <div className="flex h-full w-full items-center justify-center">
            <ImageIcon className="h-5 w-5 text-[var(--color-text-secondary)]" />
          </div>
          <span
            className="absolute bottom-1 left-1 text-[8px] tracking-[0.04em] text-white/70"
            style={{ fontFamily: mono }}
          >
            @{capturedBy}
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <p className="text-[14px] leading-[19px] text-[var(--color-text)]">
            <span className="font-bold">@{capturedBy}</span> {verb}{" "}
            {p.timestamp ? `the photo you sent at ${formatHHMM(p.timestamp)}` : "your media"}.
          </p>
          <span
            className="text-[10px] tracking-[0.04em] text-[#FCA5A5]"
            style={{ fontFamily: mono }}
          >
            forensic watermark{p.platform ? ` · ${p.platform}` : ""}{p.userAgent ? ` · ${userAgentLabel(p.userAgent)}` : ""}
          </span>
        </div>
      </div>

      <footer className="flex gap-2">
        <button
          type="button"
          onClick={() => onBlock?.(capturedBy)}
          className="flex flex-1 items-center justify-center rounded-[10px] border px-4 py-2.5 transition-opacity hover:opacity-90"
          style={{
            background: "rgba(239,68,68,0.20)",
            borderColor: "rgba(239,68,68,0.40)",
          }}
        >
          <span className="text-[13px] font-semibold text-[#FCA5A5]">Block @{capturedBy}</span>
        </button>
        <button
          type="button"
          onClick={onView}
          className="flex flex-1 items-center justify-center rounded-[10px] border bg-white/[0.05] px-4 py-2.5 hover:bg-white/[0.08]"
          style={{ borderColor: "var(--color-hairline-strong)" }}
        >
          <span className="text-[13px] font-medium text-[var(--color-text)]">View thread</span>
        </button>
      </footer>
    </article>
  );
}

function LiveBadge() {
  return (
    <span
      className="flex items-center gap-1 rounded border px-1.5 py-0.5"
      style={{
        background: "rgba(239,68,68,0.20)",
        borderColor: "rgba(239,68,68,0.40)",
      }}
    >
      <span
        className="relay-pulse h-1 w-1 rounded-full"
        style={{ background: "var(--color-alert)" }}
      />
      <span
        className="text-[9px] font-bold uppercase tracking-[0.08em]"
        style={{ color: "#FCA5A5", fontFamily: mono }}
      >
        Live
      </span>
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────────
//  Compact rows for non-featured types — view counts, media-expired, etc.
// ──────────────────────────────────────────────────────────────────────────

export function NotificationRow({ notification }: { notification: Notification }) {
  const meta = compactMeta(notification);
  return (
    <div className="flex items-start gap-3.5 px-6 py-3.5">
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border"
        style={{ background: meta.tint, borderColor: meta.tintBorder }}
      >
        {meta.icon}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm leading-[19px] text-[var(--color-text)]">{meta.body}</p>
        <span
          className="text-[10px] tracking-[0.04em] text-[var(--color-text-muted)]"
          style={{ fontFamily: mono }}
        >
          {meta.timestamp}
        </span>
      </div>
      {!notification.isRead && (
        <span
          className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
          style={{ background: "var(--color-signal)" }}
        />
      )}
    </div>
  );
}

function compactMeta(n: Notification) {
  const t = formatHHMM(n.createdAt);
  switch (n.type) {
    case "VIEW_COUNT_UPDATE": {
      const viewer = n.payload.viewer?.username;
      return {
        icon: <Eye className="h-4 w-4" style={{ color: "var(--color-signal)" }} />,
        tint: "rgba(59,130,246,0.10)",
        tintBorder: "rgba(59,130,246,0.22)",
        body: (
          <>
            <span className="font-bold">@{viewer ?? "someone"}</span> watched your media —{" "}
            <span style={{ fontFamily: mono, color: "var(--color-signal)" }}>
              {n.payload.viewsUsed} of {n.payload.viewsAllowed} views
            </span>
          </>
        ),
        timestamp: t,
      };
    }
    case "MEDIA_EXPIRED": {
      const recipient = n.payload.recipient?.username;
      return {
        icon: <Clock className="h-4 w-4" style={{ color: "var(--color-warning)" }} />,
        tint: "rgba(245,158,11,0.10)",
        tintBorder: "rgba(245,158,11,0.22)",
        body: (
          <>
            A photo you sent <span className="font-bold">@{recipient ?? "someone"}</span> reached its view limit and was removed.
          </>
        ),
        timestamp: t,
      };
    }
    case "MESSAGE_RECEIVED": {
      const from = n.payload.from?.username;
      return {
        icon: <MessageSquare className="h-4 w-4" style={{ color: "var(--color-text-secondary)" }} />,
        tint: "rgba(255,255,255,0.04)",
        tintBorder: "var(--color-hairline)",
        body: (
          <>
            <span className="font-bold">@{from ?? "someone"}</span>: {n.payload.preview ?? "sent a message"}
          </>
        ),
        timestamp: t,
      };
    }
    default: {
      return {
        icon: <ShieldCheck className="h-4 w-4" style={{ color: "var(--color-online)" }} />,
        tint: "rgba(34,197,94,0.10)",
        tintBorder: "rgba(34,197,94,0.22)",
        body: n.type,
        timestamp: t,
      };
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────

function formatHHMM(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function relativeShort(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function userAgentLabel(ua: string): string {
  if (/iPhone|iPad|iOS/.test(ua)) return ua.match(/OS (\d+)[._](\d+)/)?.[0]?.replace("_", ".").replace("OS ", "iOS ") ?? "iOS";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return ua.split(" ")[0] ?? ua;
}

