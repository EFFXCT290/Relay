"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "@/frontend-core/api";
import { getSocket } from "@/frontend-core/socket";
import type { Notification } from "@/features/notifications/components/notification-card";
import { PRESENCE_EVENTS, PRESENCE_PING_INTERVAL_MS } from "@relay/contracts";

type State = {
  notifications: Notification[];
  unreadCount: number;
  loaded: boolean;
  refresh: () => Promise<void>;
  markAllRead: () => Promise<void>;
};

const Ctx = createContext<State | null>(null);

// Global notifications store — single source of truth for the live badge in
// the tab bar / sidebar AND the list rendered on /alerts. Subscribes once to
// the WS `notification:new` channel; consumers don't subscribe themselves.
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api<{
        notifications: Notification[];
        unreadCount: number;
        nextCursor: string | null;
      }>("/api/notifications?limit=50");
      if (!mounted.current) return;
      setNotifications(res.notifications);
      setUnreadCount(res.unreadCount);
      setLoaded(true);
    } catch {
      if (mounted.current) setLoaded(true);
    }
  }, []);

  const markAllRead = useCallback(async () => {
    if (unreadCount === 0) return;
    await api("/api/notifications/read-all", { method: "PATCH" });
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);
  }, [unreadCount]);

  useEffect(() => {
    mounted.current = true;
    void refresh();

    const socket = getSocket();
    const onNew = (payload: { notification: Notification }) => {
      setNotifications((prev) => {
        if (prev.some((n) => n.notificationId === payload.notification.notificationId)) return prev;
        return [payload.notification, ...prev];
      });
      if (!payload.notification.isRead) setUnreadCount((c) => c + 1);
    };
    socket.on("notification:new", onNew);

    // Presence heartbeat — keeps the Redis heartbeat key alive so the server
    // doesn't flip the user offline while the socket is connected but idle.
    const ping = () => socket.emit(PRESENCE_EVENTS.PING);
    ping(); // immediate ping so presence is fresh before the first interval fires
    const pingInterval = setInterval(ping, PRESENCE_PING_INTERVAL_MS);

    return () => {
      mounted.current = false;
      socket.off("notification:new", onNew);
      clearInterval(pingInterval);
    };
  }, [refresh]);

  return (
    <Ctx.Provider value={{ notifications, unreadCount, loaded, refresh, markAllRead }}>
      {children}
    </Ctx.Provider>
  );
}

export function useNotifications(): State {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNotifications must be used inside NotificationsProvider");
  return v;
}
