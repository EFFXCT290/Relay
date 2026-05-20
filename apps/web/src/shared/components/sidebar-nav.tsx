"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, Inbox, LogOut, User } from "lucide-react";
import { Wordmark } from "./wordmark";
import { cn } from "@/frontend-core/utils";
import { api } from "@/frontend-core/api";
import { useRouter } from "next/navigation";
import { useNotifications } from "@/providers/notifications-provider";

type NavItem = {
  href: string;
  label: string;
  icon: typeof Inbox;
  badgeRef?: "alerts";
};

const ITEMS: NavItem[] = [
  { href: "/conversations", label: "Inbox", icon: Inbox },
  { href: "/alerts", label: "Alerts", icon: Bell, badgeRef: "alerts" },
  { href: "/profile", label: "Profile", icon: User },
];

type Props = { username: string | null };

export function SidebarNav({ username }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const { unreadCount } = useNotifications();

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.push("/sign-in");
  };

  return (
    <aside
      className="hidden border-r bg-[var(--color-panel)] lg:flex lg:w-[260px] lg:shrink-0 lg:flex-col"
      style={{ borderColor: "var(--color-hairline)" }}
    >
      <div className="px-6 pt-7 pb-6">
        <Link href="/conversations" aria-label="Relay home">
          <Wordmark size={22} />
        </Link>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-3">
        {ITEMS.map(({ href, label, icon: Icon, badgeRef }) => {
          const active = pathname.startsWith(href);
          const badgeCount = badgeRef === "alerts" ? unreadCount : 0;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors",
                active
                  ? "bg-[var(--color-raised)]"
                  : "hover:bg-[var(--color-raised)]/60",
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon
                className="h-5 w-5"
                style={{
                  color: active ? "var(--color-signal)" : "var(--color-text-secondary)",
                  fill: active ? "rgba(59,130,246,0.18)" : "transparent",
                  strokeWidth: active ? 2 : 1.6,
                }}
              />
              <span
                className={cn("flex-1 text-sm", active ? "font-semibold" : "font-medium")}
                style={{ color: active ? "var(--color-text)" : "var(--color-text-secondary)" }}
              >
                {label}
              </span>
              {badgeCount ? (
                <span
                  className="flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5"
                  style={{ background: "var(--color-alert)" }}
                >
                  <span
                    className="text-[10px] font-bold text-white"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {badgeCount}
                  </span>
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div
        className="m-3 flex items-center gap-3 rounded-xl border bg-[var(--color-raised)] p-3"
        style={{ borderColor: "var(--color-hairline)" }}
      >
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          style={{ background: "linear-gradient(135deg, #3B82F6 0%, #1E3A8A 100%)" }}
        >
          <span
            className="text-[14px] font-bold text-white"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {(username?.[0] ?? "?").toUpperCase()}
          </span>
        </div>
        <div className="flex flex-1 flex-col leading-none">
          <span
            className="text-[13px] font-semibold text-[var(--color-text)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            @{username ?? "—"}
          </span>
          <span className="mt-1 text-[10px] text-[var(--color-online)]" style={{ fontFamily: "var(--font-mono)" }}>
            online
          </span>
        </div>
        <button
          onClick={logout}
          aria-label="Sign out"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-white/5 hover:text-[var(--color-text)]"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}
