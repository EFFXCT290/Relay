"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, Inbox, User } from "lucide-react";
import { cn } from "@/frontend-core/utils";
import { useNotifications } from "@/providers/notifications-provider";

type Tab = {
  href: string;
  label: string;
  icon: typeof Inbox;
  badgeRef?: "alerts";
};

const TABS: Tab[] = [
  { href: "/conversations", label: "Inbox", icon: Inbox },
  { href: "/alerts", label: "Alerts", icon: Bell, badgeRef: "alerts" },
  { href: "/profile", label: "Profile", icon: User },
];

// Fixed-position bottom bar with safe-area inset for iPhone home indicator.
// Hidden on chat-thread routes — the composer takes the bottom edge instead.
export function BottomTabBar() {
  const pathname = usePathname();
  const { unreadCount } = useNotifications();
  const isChatThread = /^\/conversations\/[^/]+(?:\/.*)?$/.test(pathname) && pathname !== "/conversations/new";
  if (isChatThread) return null;

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-[var(--color-bg)]/85 backdrop-blur-xl lg:hidden"
      style={{ borderColor: "var(--color-hairline)" }}
    >
      <div className="flex items-center justify-around px-6 pt-3 pb-2">
        {TABS.map(({ href, label, icon: Icon, badgeRef }) => {
          const active = pathname.startsWith(href);
          const badgeCount = badgeRef === "alerts" ? unreadCount : 0;
          return (
            <Link
              key={href}
              href={href}
              className="relative flex flex-col items-center gap-1 px-4 py-2"
              aria-current={active ? "page" : undefined}
            >
              <Icon
                className={cn("h-[22px] w-[22px]", active ? "stroke-2" : "stroke-[1.6]")}
                style={{
                  color: active ? "var(--color-signal)" : "var(--color-text-secondary)",
                  fill: active ? "rgba(59,130,246,0.18)" : "transparent",
                }}
              />
              <span
                className={cn("text-[10px] tracking-[0.02em]", active ? "font-semibold" : "font-medium")}
                style={{ color: active ? "var(--color-signal)" : "var(--color-text-secondary)" }}
              >
                {label}
              </span>
              {badgeCount ? (
                <span
                  className="absolute right-3 top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full border-2 border-[var(--color-bg)] px-1.5"
                  style={{ background: "var(--color-alert)" }}
                >
                  <span
                    className="text-[9px] font-bold text-white"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {badgeCount}
                  </span>
                </span>
              ) : null}
            </Link>
          );
        })}
      </div>
      <div className="flex justify-center pb-2">
        <div className="h-[5px] w-[135px] rounded-full bg-white/90" />
      </div>
    </nav>
  );
}
