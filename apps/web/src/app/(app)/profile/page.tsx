"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  Ban,
  CheckCheck,
  ChevronRight,
  Eye as EyeIcon,
  Laptop,
  Lock,
  LogOut,
  ShieldOff,
  Trash2,
} from "lucide-react";
import { Avatar } from "@/shared/components/avatar";
import { Toggle } from "@/shared/components/toggle";
import { ApiError, api } from "@/frontend-core/api";

const mono = "var(--font-mono)";
const display = "var(--font-display)";

type Me = { userId: string; username: string; createdAt: string };

const PREF_KEYS = ["showOnline", "readReceipts", "captureReports"] as const;
type PrefKey = (typeof PREF_KEYS)[number];

// Local-only privacy prefs — server persistence ships with Phase 4. We surface
// this honestly in a hairline footnote so the user knows clicking the toggle
// doesn't (yet) propagate beyond this browser.
function loadPrefs(): Record<PrefKey, boolean> {
  if (typeof window === "undefined") return { showOnline: true, readReceipts: true, captureReports: true };
  try {
    const raw = window.localStorage.getItem("relay.prefs");
    if (raw) return { showOnline: true, readReceipts: true, captureReports: true, ...JSON.parse(raw) };
  } catch {}
  return { showOnline: true, readReceipts: true, captureReports: true };
}

function savePrefs(prefs: Record<PrefKey, boolean>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem("relay.prefs", JSON.stringify(prefs));
}

export default function ProfilePage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [threadCount, setThreadCount] = useState<number | null>(null);
  const [captureCount, setCaptureCount] = useState<number | null>(null);
  const [prefs, setPrefs] = useState<Record<PrefKey, boolean>>({
    showOnline: true,
    readReceipts: true,
    captureReports: true,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPrefs(loadPrefs());
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [meRes, convs, notifs] = await Promise.all([
          api<Me>("/api/auth/me"),
          api<{ conversations: unknown[] }>("/api/conversations?limit=50"),
          api<{ notifications: { type: string }[] }>("/api/notifications?limit=100"),
        ]);
        setMe(meRes);
        setThreadCount(convs.conversations.length);
        setCaptureCount(notifs.notifications.filter((n) => n.type === "SYSTEM_ALERT").length);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/sign-in");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load profile");
      }
    })();
  }, [router]);

  const setPref = (key: PrefKey, value: boolean) => {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    savePrefs(next);
  };

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.push("/sign-in");
  };

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col">
      {/* Profile header */}
      <header className="flex flex-col items-center gap-4 px-6 pt-10 pb-7 lg:pt-14">
        {me ? (
          <Avatar username={me.username} size={96} isOnline />
        ) : (
          <div className="h-24 w-24 animate-pulse rounded-full bg-white/5" />
        )}
        <div className="flex flex-col items-center gap-1.5">
          <h1
            className="text-[26px] font-extrabold tracking-[-0.025em] text-[var(--color-text)]"
            style={{ fontFamily: display }}
          >
            @{me?.username ?? "—"}
          </h1>
          <div className="flex items-center gap-2">
            <span
              className="text-[11px] tracking-[0.04em] text-[var(--color-online)]"
              style={{ fontFamily: mono }}
            >
              online now
            </span>
            <span className="h-[3px] w-[3px] rounded-full bg-[var(--color-text-muted)]" />
            <span
              className="text-[11px] tracking-[0.04em] text-[var(--color-text-secondary)]"
              style={{ fontFamily: mono }}
            >
              joined {me ? formatJoined(me.createdAt) : "—"}
            </span>
          </div>
        </div>
      </header>

      {/* Stats */}
      <Section noHeader>
        <div className="flex items-stretch">
          <Stat label="Threads" value={threadCount} />
          <Divider />
          <Stat label="Ephemeral" value={null} note="Phase 2" />
          <Divider />
          <Stat label="Captures" value={captureCount} tone={captureCount && captureCount > 0 ? "alert" : "default"} />
        </div>
      </Section>

      {/* Privacy */}
      <Section title="Privacy">
        <Card>
          <ToggleRow
            icon={<EyeIcon className="h-3.5 w-3.5" style={{ color: "var(--color-online)" }} />}
            tint="rgba(34,197,94,0.10)"
            tintBorder="rgba(34,197,94,0.22)"
            title="Show online status"
            body="Only people you've messaged can see it."
            checked={prefs.showOnline}
            onChange={(v) => setPref("showOnline", v)}
          />
          <Hairline />
          <ToggleRow
            icon={<CheckCheck className="h-3.5 w-3.5" style={{ color: "var(--color-signal)" }} />}
            tint="rgba(59,130,246,0.10)"
            tintBorder="rgba(59,130,246,0.22)"
            title="Send read receipts"
            body="Tell the sender when you've opened their message."
            checked={prefs.readReceipts}
            onChange={(v) => setPref("readReceipts", v)}
          />
          <Hairline />
          <ToggleRow
            icon={<ShieldOff className="h-3.5 w-3.5" style={{ color: "var(--color-alert)" }} />}
            tint="rgba(239,68,68,0.10)"
            tintBorder="rgba(239,68,68,0.22)"
            title="Capture reports"
            body="Alert me if someone tries to screenshot or record what I sent."
            checked={prefs.captureReports}
            onChange={(v) => setPref("captureReports", v)}
          />
        </Card>
        <p
          className="px-1 pt-2 text-[11px] text-[var(--color-text-muted)]"
          style={{ fontFamily: mono }}
        >
          stored locally · server persistence ships with phase 4
        </p>
      </Section>

      {/* Account */}
      <Section title="Account">
        <Card>
          <LinkRow
            icon={<Lock className="h-3.5 w-3.5 text-[var(--color-text-secondary)]" />}
            title="Password"
            metaMono="Last changed when account was created"
          />
          <Hairline />
          <LinkRow
            icon={<Laptop className="h-3.5 w-3.5 text-[var(--color-text-secondary)]" />}
            title="Active sessions"
            badge={
              <span
                className="flex items-center gap-1.5 rounded-full border px-2 py-0.5"
                style={{
                  background: "rgba(34,197,94,0.10)",
                  borderColor: "rgba(34,197,94,0.22)",
                }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: "var(--color-online)" }}
                />
                <span
                  className="text-[10px] text-[var(--color-online)]"
                  style={{ fontFamily: mono }}
                >
                  1 active
                </span>
              </span>
            }
            metaMono="This browser"
          />
          <Hairline />
          <LinkRow
            icon={<Ban className="h-3.5 w-3.5 text-[var(--color-text-secondary)]" />}
            title="Blocked accounts"
            metaMono="0 accounts"
          />
          <Hairline />
          <LinkRow
            icon={<Bell className="h-3.5 w-3.5 text-[var(--color-text-secondary)]" />}
            title="Notification preferences"
            metaMono="Default"
          />
        </Card>
      </Section>

      {/* Danger zone */}
      <Section title="Danger zone">
        <Card>
          <button
            type="button"
            onClick={logout}
            className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left hover:bg-white/[0.02]"
          >
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border"
              style={{
                background: "rgba(255,255,255,0.04)",
                borderColor: "var(--color-hairline)",
              }}
            >
              <LogOut className="h-3.5 w-3.5 text-[var(--color-text-secondary)]" />
            </div>
            <span className="flex-1 text-[14px] font-semibold text-[var(--color-text)]">
              Sign out
            </span>
            <ChevronRight className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
          </button>
          <Hairline />
          <button
            type="button"
            disabled
            title="Account deletion ships with Phase 4"
            className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left opacity-60"
          >
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border"
              style={{
                background: "rgba(239,68,68,0.10)",
                borderColor: "rgba(239,68,68,0.22)",
              }}
            >
              <Trash2 className="h-3.5 w-3.5" style={{ color: "var(--color-alert)" }} />
            </div>
            <div className="flex flex-1 flex-col gap-0.5">
              <span
                className="text-[14px] font-semibold"
                style={{ color: "var(--color-alert)" }}
              >
                Delete account
              </span>
              <span
                className="text-[11px] text-[var(--color-text-muted)]"
                style={{ fontFamily: mono }}
              >
                Coming in Phase 4
              </span>
            </div>
          </button>
        </Card>
      </Section>

      {/* Build meta footer */}
      <footer className="flex items-center justify-between px-6 pt-8 pb-10">
        <span
          className="text-[11px] tracking-[0.04em] text-[var(--color-text-muted)]"
          style={{ fontFamily: mono }}
        >
          relay v0.1.0
        </span>
        <span
          className="text-[11px] tracking-[0.04em] text-[var(--color-text-muted)]"
          style={{ fontFamily: mono }}
        >
          all systems online
        </span>
      </footer>

      {error && (
        <p className="px-6 pb-6 text-xs text-[var(--color-alert)]">{error}</p>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
//  Section + Card + rows
// ──────────────────────────────────────────────────────────────────────────

function Section({
  title,
  noHeader,
  children,
}: {
  title?: string;
  noHeader?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 px-6 pt-7">
      {!noHeader && title && (
        <div className="flex items-center gap-2.5 px-1 pb-0.5">
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]"
            style={{ fontFamily: mono }}
          >
            {title}
          </span>
          <span className="h-px flex-1 bg-[var(--color-hairline)]" />
        </div>
      )}
      {children}
    </section>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex flex-col overflow-hidden rounded-[18px] border bg-[var(--color-panel)]"
      style={{ borderColor: "var(--color-hairline)" }}
    >
      {children}
    </div>
  );
}

function Hairline() {
  return <div className="mx-4 h-px" style={{ background: "var(--color-hairline)" }} />;
}

function Divider() {
  return <div className="w-px self-stretch" style={{ background: "var(--color-hairline)" }} />;
}

function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: number | null;
  note?: string;
  tone?: "default" | "alert";
}) {
  return (
    <div className="flex flex-1 flex-col items-center gap-1 py-4">
      <div className="flex items-baseline gap-1">
        <span
          className="text-[22px] font-extrabold tracking-[-0.02em]"
          style={{
            color: tone === "alert" ? "var(--color-alert)" : "var(--color-text)",
            fontFamily: display,
          }}
        >
          {value === null ? "—" : value}
        </span>
        {note && (
          <span
            className="text-[9px] tracking-[0.04em] text-[var(--color-text-muted)]"
            style={{ fontFamily: mono }}
          >
            {note}
          </span>
        )}
      </div>
      <span
        className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-muted)]"
        style={{ fontFamily: mono }}
      >
        {label}
      </span>
    </div>
  );
}

function ToggleRow({
  icon,
  tint,
  tintBorder,
  title,
  body,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  tint: string;
  tintBorder: string;
  title: string;
  body: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3.5 px-4 py-3.5">
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border"
        style={{ background: tint, borderColor: tintBorder }}
      >
        {icon}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-[14px] font-semibold text-[var(--color-text)]">{title}</p>
        <p className="text-[12px] leading-4 text-[var(--color-text-secondary)]">{body}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} ariaLabel={title} />
    </div>
  );
}

function LinkRow({
  icon,
  title,
  badge,
  metaMono,
}: {
  icon: React.ReactNode;
  title: string;
  badge?: React.ReactNode;
  metaMono?: string;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left hover:bg-white/[0.02]"
    >
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border"
        style={{
          background: "rgba(255,255,255,0.04)",
          borderColor: "var(--color-hairline)",
        }}
      >
        {icon}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-[14px] font-semibold text-[var(--color-text)]">{title}</p>
        {(badge || metaMono) && (
          <div className="flex items-center gap-2">
            {badge}
            {metaMono && (
              <span
                className="text-[11px] text-[var(--color-text-secondary)]"
                style={{ fontFamily: mono }}
              >
                {metaMono}
              </span>
            )}
          </div>
        )}
      </div>
      <ChevronRight className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
    </button>
  );
}

function formatJoined(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" }).toLowerCase();
}
