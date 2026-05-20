"use client";

import { useMemo } from "react";
import { Check, Bell } from "lucide-react";
import {
  CaptureAlertCard,
  NotificationRow,
  type Notification,
} from "@/features/notifications/components/notification-card";
import { useNotifications } from "@/providers/notifications-provider";

const mono = "var(--font-mono)";
const display = "var(--font-display)";

export default function AlertsPage() {
  const { notifications, unreadCount, loaded, markAllRead } = useNotifications();

  // Featured = unread SYSTEM_ALERTs from today, rendered as loud cards on top.
  const { featured, rest } = useMemo(() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const f = notifications.filter(
      (n) =>
        n.type === "SYSTEM_ALERT" &&
        !n.isRead &&
        new Date(n.createdAt).getTime() >= startOfToday.getTime(),
    );
    const ids = new Set(f.map((n) => n.notificationId));
    return { featured: f, rest: notifications.filter((n) => !ids.has(n.notificationId)) };
  }, [notifications]);

  const grouped = useMemo(() => groupByBucket(rest), [rest]);

  return (
    <div className="flex flex-col">
      {/* Header */}
      <header className="flex items-end justify-between px-6 pt-6 pb-3.5 lg:pt-10">
        <div className="flex flex-col gap-1">
          <span
            className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--color-text-muted)]"
            style={{ fontFamily: mono }}
          >
            {unreadCount > 0 ? `${unreadCount} New` : "All caught up"}
          </span>
          <h1
            className="text-[28px] font-extrabold leading-[30px] tracking-[-0.025em] text-[var(--color-text)] lg:text-[36px] lg:leading-[38px]"
            style={{ fontFamily: display }}
          >
            Alerts
          </h1>
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={() => void markAllRead()}
            className="flex items-center gap-1.5 rounded-full border px-3 py-2 transition-colors hover:bg-white/5"
            style={{ borderColor: "var(--color-hairline)" }}
          >
            <Check className="h-3.5 w-3.5 text-[var(--color-text-secondary)]" />
            <span className="text-xs font-medium text-[var(--color-text-secondary)]">
              Mark all read
            </span>
          </button>
        )}
      </header>

      {/* Featured capture-alert cards */}
      {featured.length > 0 && (
        <section className="flex flex-col gap-3 px-4 pb-4 lg:px-6">
          {featured.map((n) => (
            <CaptureAlertCard key={n.notificationId} notification={n} />
          ))}
        </section>
      )}

      {/* Grouped rest */}
      {!loaded ? (
        <LoadingState />
      ) : notifications.length === 0 ? (
        <EmptyState />
      ) : (
        grouped.map((group) => (
          <section key={group.label} className="flex flex-col">
            <div className="flex items-center gap-2.5 px-6 pt-4 pb-3">
              <span
                className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]"
                style={{ fontFamily: mono }}
              >
                {group.label}
              </span>
              <span className="h-px flex-1 bg-[var(--color-hairline)]" />
            </div>
            <ul className="flex flex-col">
              {group.items.map((n) => (
                <li key={n.notificationId}>
                  <NotificationRow notification={n} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────

function LoadingState() {
  return (
    <ul className="flex flex-col">
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex items-center gap-3.5 px-6 py-3.5">
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-xl bg-white/5" />
          <div className="flex flex-1 flex-col gap-2">
            <div className="h-3 w-4/5 animate-pulse rounded bg-white/5" />
            <div className="h-2.5 w-16 animate-pulse rounded bg-white/5" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-20 text-center">
      <div
        className="flex h-16 w-16 items-center justify-center rounded-2xl border"
        style={{
          background: "rgba(34,197,94,0.08)",
          borderColor: "rgba(34,197,94,0.22)",
        }}
      >
        <Bell className="h-6 w-6" style={{ color: "var(--color-online)" }} />
      </div>
      <div className="flex flex-col gap-2">
        <h2
          className="text-[22px] font-extrabold tracking-[-0.02em] text-[var(--color-text)]"
          style={{ fontFamily: display }}
        >
          You're all caught up
        </h2>
        <p className="max-w-[300px] text-sm leading-5 text-[var(--color-text-secondary)]">
          Capture alerts, view counts, and security events will land here.
        </p>
      </div>
    </div>
  );
}

function groupByBucket(items: Notification[]): { label: string; items: Notification[] }[] {
  const buckets = new Map<string, Notification[]>();
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000);
  const startOfWeek = new Date(startOfToday.getTime() - 7 * 86_400_000);

  for (const n of items) {
    const t = new Date(n.createdAt).getTime();
    let label: string;
    if (t >= startOfToday.getTime()) label = "Earlier today";
    else if (t >= startOfYesterday.getTime()) label = "Yesterday";
    else if (t >= startOfWeek.getTime()) label = "This week";
    else label = "Earlier";

    const list = buckets.get(label) ?? [];
    list.push(n);
    buckets.set(label, list);
  }

  const order = ["Earlier today", "Yesterday", "This week", "Earlier"];
  return order
    .filter((l) => buckets.has(l))
    .map((label) => ({ label, items: buckets.get(label)! }));
}
