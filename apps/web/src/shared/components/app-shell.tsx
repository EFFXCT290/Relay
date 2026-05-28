"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ApiError, api } from "@/frontend-core/api";
import { SidebarNav } from "./sidebar-nav";
import { BottomTabBar } from "./bottom-tab-bar";
import { NotificationsProvider } from "@/providers/notifications-provider";
import { CallProvider } from "@/features/calls/call-provider";

type UserCtxValue = { userId: string; username: string };
const UserCtx = createContext<UserCtxValue | null>(null);
export function useUser(): UserCtxValue | null { return useContext(UserCtx); }

// Wraps every authenticated route. Fetches /auth/me on mount, redirects to
// /sign-in on 401, otherwise renders the chrome (sidebar on desktop, bottom
// tab bar on mobile) around the page content.
export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<UserCtxValue | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await api<{ userId: string; username: string; createdAt: string }>("/api/auth/me");
        if (!cancelled) {
          setUser({ userId: me.userId, username: me.username });
          setReady(true);
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/sign-in");
          return;
        }
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[var(--color-bg)]">
        <div className="flex items-center gap-2">
          <span
            className="relay-pulse h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--color-signal)" }}
          />
          <span
            className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            connecting
          </span>
        </div>
      </div>
    );
  }

  return (
    <UserCtx.Provider value={user}>
      <NotificationsProvider>
        <CallProvider>
          <div className="flex min-h-dvh flex-col lg:flex-row">
            <SidebarNav username={user?.username ?? null} />
            <ChatAwareMain>{children}</ChatAwareMain>
            <BottomTabBar />
          </div>
        </CallProvider>
      </NotificationsProvider>
    </UserCtx.Provider>
  );
}

// Mobile bottom padding clears the tab bar — except on chat-thread routes,
// where the composer pins the bottom edge and the tab bar is hidden.
function ChatAwareMain({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isChatThread =
    /^\/conversations\/[^/]+(?:\/.*)?$/.test(pathname) && pathname !== "/conversations/new";
  return (
    <main className={`flex flex-1 flex-col lg:pb-0 ${isChatThread ? "pb-0" : "pb-[92px]"}`}>
      {children}
    </main>
  );
}
