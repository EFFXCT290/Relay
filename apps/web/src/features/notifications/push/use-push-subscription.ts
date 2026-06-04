"use client";

import { useCallback, useEffect, useState } from "react";
import { getVapidPublicKey } from "@/frontend-core/runtime-env";
import { pushApi } from "@/frontend-core/api-client/push";
import { urlBase64ToUint8Array } from "./vapid";

export type PushSubscriptionState = {
  supported: boolean;                                  // serviceWorker + PushManager + Notification
  permission: NotificationPermission | "unsupported";  // default | granted | denied
  isStandalone: boolean;                               // launched from Home Screen / installed
  isIOS: boolean;
  isSubscribed: boolean;
  busy: boolean;
  error: string | null;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
};

function detectIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ reports as MacIntel with touch points.
  return /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return window.matchMedia("(display-mode: standalone)").matches || iosStandalone;
}

export function usePushSubscription(): PushSubscriptionState {
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [isStandalone, setIsStandalone] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ok =
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;
    setSupported(ok);
    setIsIOS(detectIOS());
    setIsStandalone(detectStandalone());
    if (!ok) return;

    setPermission(Notification.permission);
    // Reflect any existing subscription so the toggle starts in the right state.
    void navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setIsSubscribed(!!sub))
      .catch(() => {});
  }, []);

  const subscribe = useCallback(async () => {
    if (!supported) {
      setError("Notifications aren't supported on this device.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") {
        if (perm === "denied") {
          setError("Notifications are blocked. Enable them in Settings → Relay → Notifications.");
        }
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const key = getVapidPublicKey();
        if (!key) {
          setError("Push isn't configured on the server yet.");
          return;
        }
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key),
        });
      }
      await pushApi.subscribe(sub.toJSON());
      setIsSubscribed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't enable notifications.");
    } finally {
      setBusy(false);
    }
  }, [supported]);

  const unsubscribe = useCallback(async () => {
    if (!supported) return;
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await pushApi.unsubscribe(sub.endpoint).catch(() => {});
        await sub.unsubscribe();
      }
      setIsSubscribed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't disable notifications.");
    } finally {
      setBusy(false);
    }
  }, [supported]);

  return { supported, permission, isStandalone, isIOS, isSubscribed, busy, error, subscribe, unsubscribe };
}
